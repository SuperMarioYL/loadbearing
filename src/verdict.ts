import { buildClusters, mergeWithNextInFile, type Cluster } from "./cluster.js";
import { readDiff, type DiffFile } from "./diff.js";
import {
  failed,
  harnessError,
  loadConfig,
  passed,
  probesForFiles,
  runProbe,
  type CommandRun,
  type LoadedConfig,
  type Probe,
} from "./probes.js";
import {
  REPORT_SCHEMA,
  REPORT_SCOPE,
  summarise,
  type BaselineProbe,
  type ClusterReport,
  type ProbeEvidence,
  type Reason,
  type Report,
  type Verdict,
} from "./report.js";
import {
  applyReverse,
  buildClusterPatch,
  createWorktree,
  dirtyEntries,
  gitText,
  removeWorktree,
  repoRoot,
  resolveCommit,
  type Worktree,
} from "./sandbox.js";

export type CheckOptions = {
  cwd?: string;
  base: string;
  configPath?: string;
  /** Per-probe timeout override in milliseconds (CLI takes seconds). */
  timeoutMs?: number;
  keepWorktrees?: boolean;
  maxClusters?: number;
};

export type CheckResult = {
  /** 0 report emitted, 1 config error, 2 precondition failure, 3 baseline failed. */
  exitCode: 0 | 1 | 2 | 3;
  report?: Report;
  error?: string;
  /** Paths retained because `keepWorktrees` was set. */
  keptWorktrees?: string[];
};

class PreconditionError extends Error {}

/**
 * Baseline once on pristine HEAD, then revert each cluster in its own worktree
 * and run only the probes mapped to its files. Never edits the user's branch.
 */
export async function runCheck(options: CheckOptions): Promise<CheckResult> {
  const cwd = options.cwd ?? process.cwd();

  let root: string;
  try {
    root = repoRoot(cwd);
  } catch {
    return { exitCode: 2, error: `${cwd} is not inside a git repository` };
  }

  let config: LoadedConfig;
  try {
    config = loadConfig(root, options.configPath);
  } catch (error) {
    return { exitCode: 1, error: messageOf(error) };
  }

  const timeoutMs = options.timeoutMs ?? config.timeoutMs;

  let head: string;
  let files: DiffFile[];
  try {
    head = await precondition(root, options.base);
    files = readDiff(options.base, root);
  } catch (error) {
    if (error instanceof PreconditionError) return { exitCode: 2, error: error.message };
    return { exitCode: 2, error: `cannot read ${options.base}...HEAD: ${messageOf(error)}` };
  }

  const clusters = buildClusters(files.flatMap((file) => file.hunks));

  const baselineRuns: CommandRun[] = [];
  for (const probe of config.probes) baselineRuns.push(await runProbe(probe, root, timeoutMs));
  const baselineOk = baselineRuns.every(passed);

  const reported: ClusterReport[] = [];
  const keptWorktrees: string[] = [];
  let exitCode: 0 | 3 = 0;

  if (!baselineOk) {
    exitCode = 3;
    for (const cluster of clusters) {
      reported.push(classifyWithoutBaseline(cluster, config.probes, baselineRuns));
    }
  } else {
    await judgeClusters({
      root,
      files,
      config,
      clusters,
      baselineRuns,
      timeoutMs,
      keepWorktrees: options.keepWorktrees === true,
      maxClusters: options.maxClusters,
      reported,
      keptWorktrees,
    });
  }

  const report: Report = {
    schema: REPORT_SCHEMA,
    repo: root,
    base: options.base,
    head,
    scope: REPORT_SCOPE,
    generatedAt: new Date().toISOString(),
    probes: config.probes,
    baseline: { ok: baselineOk, probes: baselineRuns.map(baselineEvidence) },
    clusters: reported,
    summary: summarise(reported),
  };

  return { exitCode, report, keptWorktrees };
}

type JudgeInput = {
  root: string;
  files: readonly DiffFile[];
  config: LoadedConfig;
  clusters: Cluster[];
  baselineRuns: readonly CommandRun[];
  timeoutMs: number;
  keepWorktrees: boolean;
  maxClusters?: number;
  reported: ClusterReport[];
  keptWorktrees: string[];
};

async function judgeClusters(input: JudgeInput): Promise<void> {
  const { root, files, config, baselineRuns, timeoutMs, maxClusters, reported, keptWorktrees } = input;
  const baselineByName = new Map(baselineRuns.map((run) => [run.name, run]));

  // The effective cluster list shrinks when a revert fails to apply and the
  // next hunk in the same file is merged in.
  let clusters = input.clusters;
  let index = 0;
  let judged = 0;

  while (index < clusters.length) {
    const cluster = clusters[index]!;
    const mapped = probesForFiles(config.probes, cluster.files);

    if (mapped.length === 0) {
      reported.push({
        id: cluster.id,
        hunkIds: [...cluster.hunkIds],
        files: [...cluster.files],
        verdict: "unverifiable",
        reason: "no-probe",
        probes: [],
      });
      index += 1;
      continue;
    }

    if (maxClusters !== undefined && judged >= maxClusters) {
      reported.push({
        id: cluster.id,
        hunkIds: [...cluster.hunkIds],
        files: [...cluster.files],
        verdict: "unverifiable",
        reason: "skipped",
        detail: `--max-clusters ${maxClusters} reached`,
        probes: [],
      });
      index += 1;
      continue;
    }
    judged += 1;

    let current = cluster;
    let worktree: Worktree;
    try {
      worktree = createWorktree(root);
    } catch (error) {
      reported.push({
        id: cluster.id,
        hunkIds: [...cluster.hunkIds],
        files: [...cluster.files],
        verdict: "unverifiable",
        reason: "probe-error",
        detail: `cannot create worktree: ${messageOf(error)}`,
        probes: evidenceFor(mapped, baselineByName, []),
      });
      index += 1;
      continue;
    }

    let verdict: Verdict = "unverifiable";
    let reason: Reason = "probe-error";
    let detail: string | undefined;
    let runs: CommandRun[] = [];

    try {
      const setup =
        config.setup === undefined
          ? undefined
          : await runProbe({ name: "sandbox.setup", run: config.setup, paths: [] }, worktree.path, timeoutMs);

      if (setup !== undefined && !passed(setup)) {
        reason = "probe-error";
        detail = `sandbox setup failed (${describeRun(setup)})`;
      } else {
        let applied = applyReverse(worktree.path, buildClusterPatch(files, current.hunkIds));

        while (!applied.ok) {
          const merged = mergeWithNextInFile(clusters, index);
          if (merged === null) break;
          clusters = merged;
          current = clusters[index]!;
          applied = applyReverse(worktree.path, buildClusterPatch(files, current.hunkIds));
        }

        if (!applied.ok) {
          reason = "revert-apply-failed";
          detail = `git apply -R failed: ${firstLine(applied.stderr)}`;
        } else {
          const mappedNow = probesForFiles(config.probes, current.files);
          for (const probe of mappedNow) runs.push(await runProbe(probe, worktree.path, timeoutMs));

          const regression = runs.find(failed);
          const broken = runs.find(harnessError);

          if (regression !== undefined) {
            verdict = "necessary";
            reason = "probe-failed";
            detail = `${regression.name} exited ${regression.exitCode} while reverted`;
          } else if (broken !== undefined) {
            verdict = "unverifiable";
            reason = "probe-error";
            detail = `${broken.name}: ${broken.error ?? "no exit status"}`;
          } else {
            verdict = "droppable";
            reason = "probes-unaffected";
          }
        }
      }
    } finally {
      removeWorktree(root, worktree, input.keepWorktrees);
      if (input.keepWorktrees) keptWorktrees.push(worktree.path);
    }

    reported.push({
      id: current.id,
      hunkIds: [...current.hunkIds],
      files: [...current.files],
      verdict,
      reason,
      ...(detail === undefined ? {} : { detail }),
      probes: evidenceFor(probesForFiles(config.probes, current.files), baselineByName, runs),
    });
    index += 1;
  }
}

/** Preconditions: a real HEAD, a resolvable base, and a clean tree. */
async function precondition(root: string, base: string): Promise<string> {
  const head = resolveCommit(root, "HEAD");
  if (head === null) throw new PreconditionError("repository has no commits");

  if (resolveCommit(root, base) === null) {
    throw new PreconditionError(`unknown base revision: ${base}`);
  }

  let dirty: string[];
  try {
    dirty = dirtyEntries(root);
  } catch (error) {
    throw new PreconditionError(messageOf(error));
  }
  if (dirty.length > 0) {
    const sample = dirty.slice(0, 5).join(", ");
    const more = dirty.length > 5 ? ` (+${dirty.length - 5} more)` : "";
    throw new PreconditionError(
      `working tree is dirty: ${sample}${more}. Commit or stash before running check; ` +
        `verdicts only mean something when HEAD matches the tree.`,
    );
  }

  try {
    gitText(["merge-base", base, "HEAD"], root);
  } catch {
    throw new PreconditionError(`${base} and HEAD share no history`);
  }

  return head;
}

function classifyWithoutBaseline(
  cluster: Cluster,
  probes: readonly Probe[],
  baselineRuns: readonly CommandRun[],
): ClusterReport {
  const mapped = probesForFiles(probes, cluster.files);
  if (mapped.length === 0) {
    return {
      id: cluster.id,
      hunkIds: [...cluster.hunkIds],
      files: [...cluster.files],
      verdict: "unverifiable",
      reason: "no-probe",
      probes: [],
    };
  }

  const baselineByName = new Map(baselineRuns.map((run) => [run.name, run]));
  return {
    id: cluster.id,
    hunkIds: [...cluster.hunkIds],
    files: [...cluster.files],
    verdict: "unverifiable",
    reason: "baseline-failed",
    detail: "the baseline probes are red, so no badge is possible",
    probes: evidenceFor(mapped, baselineByName, []),
  };
}

function baselineEvidence(run: CommandRun): BaselineProbe {
  return {
    name: run.name,
    run: run.run,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    ...(passed(run) ? {} : { tail: run.tail }),
    ...(run.error === undefined ? {} : { error: run.error }),
  };
}

function evidenceFor(
  probes: readonly Probe[],
  baselineByName: ReadonlyMap<string, CommandRun>,
  revertedRuns: readonly CommandRun[],
): ProbeEvidence[] {
  const revertedByName = new Map(revertedRuns.map((run) => [run.name, run]));

  return probes.map((probe) => {
    const reverted = revertedByName.get(probe.name);
    const baseline = baselineByName.get(probe.name);
    const evidence: ProbeEvidence = {
      name: probe.name,
      run: probe.run,
      baselineExitCode: baseline?.exitCode ?? null,
      revertedExitCode: reverted?.exitCode ?? null,
    };

    if (reverted !== undefined && !passed(reverted)) {
      evidence.tail = reverted.tail;
      if (reverted.timedOut) evidence.timedOut = true;
    } else if (reverted === undefined && baseline !== undefined && !passed(baseline)) {
      evidence.tail = baseline.tail;
      if (baseline.timedOut) evidence.timedOut = true;
    }

    return evidence;
  });
}

function describeRun(run: CommandRun): string {
  if (run.error !== undefined) return run.error;
  return `exit ${run.exitCode === null ? "none" : run.exitCode}`;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "");
  return line === undefined ? "unknown error" : line.trim();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
