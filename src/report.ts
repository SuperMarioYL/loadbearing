import type { Probe } from "./probes.js";

export const REPORT_SCHEMA = "loadbearing/report@1";
export const REPORT_SCOPE = "mapped-probes-only";

export type Verdict = "necessary" | "droppable" | "unverifiable";

export type Reason =
  | "probe-failed"
  | "probes-unaffected"
  | "no-probe"
  | "baseline-failed"
  | "revert-apply-failed"
  | "probe-error"
  | "unsupported-diff"
  | "skipped";

/** Evidence for one probe against one cluster: baseline status vs reverted status. */
export type ProbeEvidence = {
  name: string;
  run: string;
  baselineExitCode: number | null;
  revertedExitCode: number | null;
  timedOut?: boolean;
  /** Tail of the failing run (reverted, or baseline when the baseline was red). */
  tail?: string[];
};

export type BaselineProbe = {
  name: string;
  run: string;
  exitCode: number | null;
  timedOut: boolean;
  tail?: string[];
  error?: string;
};

export type ClusterReport = {
  id: string;
  hunkIds: string[];
  files: string[];
  verdict: Verdict;
  reason: Reason;
  detail?: string;
  probes: ProbeEvidence[];
};

export type Summary = {
  total: number;
  necessary: number;
  droppable: number;
  unverifiable: number;
};

export type Report = {
  schema: typeof REPORT_SCHEMA;
  repo: string;
  base: string;
  head: string;
  scope: typeof REPORT_SCOPE;
  generatedAt: string;
  probes: Probe[];
  baseline: { ok: boolean; probes: BaselineProbe[] };
  clusters: ClusterReport[];
  summary: Summary;
};

export function summarise(clusters: readonly ClusterReport[]): Summary {
  const summary: Summary = { total: clusters.length, necessary: 0, droppable: 0, unverifiable: 0 };
  for (const cluster of clusters) summary[cluster.verdict] += 1;
  return summary;
}

export function reportJson(report: Report): string {
  return JSON.stringify(report, null, 2);
}

const COLORS = {
  necessary: "\u001b[32m",
  droppable: "\u001b[31m",
  unverifiable: "\u001b[90m",
  reset: "\u001b[0m",
} as const;

/** Human-readable table for `loadbearing check`; `color` is left to the caller's TTY check. */
export function formatReport(report: Report, options: { color?: boolean } = {}): string {
  const color = options.color === true;
  const paint = (verdict: Verdict, text: string): string =>
    color ? `${COLORS[verdict]}${text}${COLORS.reset}` : text;

  const lines: string[] = [];
  lines.push(`base ${report.base}  head ${report.head.slice(0, 7)}  ${report.clusters.length} clusters`);
  lines.push(`scope ${report.scope}: a verdict covers only the probes mapped to that cluster's files`);
  lines.push(
    report.baseline.ok
      ? `baseline green (${report.baseline.probes.length} probes on HEAD)`
      : `baseline RED: ${report.baseline.probes
          .filter((probe) => probe.exitCode !== 0)
          .map((probe) => `${probe.name} exit ${describeExit(probe.exitCode)}`)
          .join(", ")}`,
  );
  lines.push("");

  if (report.clusters.length === 0) {
    lines.push("No hunks to judge.");
    return lines.join("\n");
  }

  const idWidth = Math.max(...report.clusters.map((cluster) => cluster.id.length));
  const verdictWidth = "unverifiable".length;
  const reasonWidth = Math.max(...report.clusters.map((cluster) => cluster.reason.length));
  const nameWidth = probeWidth(report);

  for (const cluster of report.clusters) {
    const verdictLabel = paint(cluster.verdict, cluster.verdict.padEnd(verdictWidth));
    lines.push(
      `${cluster.id.padEnd(idWidth)}  ${verdictLabel}  ${cluster.reason.padEnd(reasonWidth)}  ` +
        `${cluster.hunkIds.join(", ")}`,
    );

    if (cluster.detail !== undefined) lines.push(`    ${cluster.detail}`);
    if (cluster.probes.length === 0) {
      lines.push(`    no probe matches ${cluster.files.join(", ")}`);
    }
    for (const evidence of cluster.probes) {
      lines.push(
        `    ${evidence.name.padEnd(nameWidth)}  ${evidence.run}\n` +
          `      baseline ${describeExit(evidence.baselineExitCode)} -> reverted ${describeExit(
            evidence.revertedExitCode,
          )}${evidence.timedOut === true ? " (timed out)" : ""}`,
      );
    }
  }

  const { summary } = report;
  lines.push("");
  lines.push(
    `${summary.total} clusters: ${summary.necessary} necessary, ${summary.droppable} droppable, ` +
      `${summary.unverifiable} unverifiable`,
  );
  return lines.join("\n");
}

function probeWidth(report: Report): number {
  const names = report.clusters.flatMap((cluster) => cluster.probes.map((evidence) => evidence.name));
  return names.length === 0 ? 0 : Math.max(...names.map((name) => name.length));
}

function describeExit(exitCode: number | null): string {
  return exitCode === null ? "no-exit" : String(exitCode);
}
