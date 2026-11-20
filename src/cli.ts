#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { stringify } from "yaml";
import { buildDiffClusters } from "./cluster.js";
import { readDiff, type DiffFile } from "./diff.js";
import { CONFIG_SCHEMA, type Probe } from "./probes.js";
import { formatReport, reportJson } from "./report.js";
import { isMergeCommit } from "./sandbox.js";
import { runCheck } from "./verdict.js";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

const DEFAULT_PATHS = ["src/**", "lib/**", "test/**", "tests/**"];
const SCRIPT_PROBES = ["test", "typecheck", "lint"] as const;

const CHECK_EXIT_CODES = [
  "",
  "Exit codes:",
  "  0  a report was emitted (verdicts may still be unverifiable)",
  "  1  config or flag error",
  "  2  precondition failure: dirty tree, unknown base, no shared history, or not a git repository",
  "  3  baseline failed; the report is still emitted",
].join("\n");

const program = new Command();

program
  .name("loadbearing")
  .description("Revert-probe necessity gate for agent-authored pull requests")
  .version(VERSION);

program
  .command("diff")
  .description("list hunks and one-hunk clusters for <base>...HEAD")
  .requiredOption("--base <rev>", "base revision, e.g. origin/main or HEAD~1")
  .option("--json", "emit machine-readable JSON")
  .action((options: { base: string; json?: boolean }) => {
    process.exitCode = runDiff(options.base, options.json === true);
  });

program
  .command("check")
  .description("revert each hunk cluster in a worktree and badge it necessary, droppable or unverifiable")
  .requiredOption("--base <rev>", "base revision, e.g. origin/main or HEAD~1")
  .option("--json", "emit the loadbearing/report@1 JSON instead of a table")
  .option("--config <path>", "config file (default: loadbearing.yml at the repo root)")
  .option("--keep-worktrees", "retain each sandbox worktree for inspection")
  .option("--timeout <seconds>", "per-probe timeout in seconds")
  .option("--max-clusters <n>", "judge at most n clusters; the rest stay unverifiable")
  .action(async (options: CheckCliOptions) => {
    process.exitCode = await runCheckCommand(options);
  })
  .addHelpText("after", CHECK_EXIT_CODES);

program
  .command("init")
  .description("write a starter loadbearing.yml from package.json scripts")
  .action(() => {
    process.exitCode = runInit();
  });

program
  .command("mcp")
  .description("serve the loadbearing_check tool over stdio")
  .action(async () => {
    const { serveMcp } = await import("./mcp.js");
    await serveMcp();
  });

program.addHelpText(
  "after",
  "\nExit codes (check): 0 report emitted, 1 config or flag error, 2 precondition failure (dirty tree, unknown base), 3 baseline failed.",
);

await program.parseAsync();

type CheckCliOptions = {
  base: string;
  json?: boolean;
  config?: string;
  keepWorktrees?: boolean;
  timeout?: string;
  maxClusters?: string;
};

async function runCheckCommand(options: CheckCliOptions): Promise<number> {
  const timeoutSeconds = options.timeout === undefined ? undefined : Number(options.timeout);
  if (timeoutSeconds !== undefined && (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0)) {
    console.error(`loadbearing check: --timeout must be a positive integer, got "${options.timeout}"`);
    return 1;
  }

  const maxClusters = options.maxClusters === undefined ? undefined : Number(options.maxClusters);
  if (maxClusters !== undefined && (!Number.isInteger(maxClusters) || maxClusters <= 0)) {
    console.error(`loadbearing check: --max-clusters must be a positive integer, got "${options.maxClusters}"`);
    return 1;
  }

  const result = await runCheck({
    base: options.base,
    configPath: options.config,
    keepWorktrees: options.keepWorktrees === true,
    ...(timeoutSeconds === undefined ? {} : { timeoutMs: timeoutSeconds * 1000 }),
    ...(maxClusters === undefined ? {} : { maxClusters }),
  });

  if (result.report !== undefined) {
    process.stdout.write(
      options.json === true
        ? `${reportJson(result.report)}\n`
        : `${formatReport(result.report, { color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined })}\n`,
    );
  }

  if (result.error !== undefined) console.error(`loadbearing check: ${result.error}`);

  if (result.keptWorktrees !== undefined && result.keptWorktrees.length > 0) {
    console.error(`kept ${result.keptWorktrees.length} worktree(s):`);
    for (const path of result.keptWorktrees) console.error(`  ${path}`);
  }

  return result.exitCode;
}

function runInit(): number {
  const cwd = process.cwd();
  const configPath = resolve(cwd, "loadbearing.yml");
  if (existsSync(configPath)) {
    console.error(`loadbearing init: ${configPath} already exists`);
    return 1;
  }

  const manifestPath = resolve(cwd, "package.json");
  if (!existsSync(manifestPath)) {
    console.error("loadbearing init: no package.json in the current directory");
    return 1;
  }

  let scripts: Record<string, string> | undefined;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { scripts?: Record<string, string> };
    scripts = manifest.scripts;
  } catch (error) {
    console.error(`loadbearing init: cannot read package.json: ${describeError(error)}`);
    return 1;
  }

  const probes: Probe[] = [];
  for (const name of SCRIPT_PROBES) {
    if (scripts?.[name] === undefined) continue;
    probes.push({
      name,
      run: name === "test" ? "npm test" : `npm run ${name}`,
      paths: [...DEFAULT_PATHS],
    });
  }

  const header = [
    "# Loadbearing probes: each command is an oracle for the file globs below.",
    "# A cluster is droppable only when every probe mapped to its files still passes.",
    "",
  ].join("\n");
  const footer = [
    "",
    "# Run once per sandbox worktree before probes (uncomment when you have a lockfile):",
    "# sandbox:",
    "#   setup: npm ci",
    "",
  ].join("\n");

  writeFileSync(configPath, `${header}${stringify({ schema: CONFIG_SCHEMA, probes })}${footer}`);

  const names = probes.map((probe) => probe.name).join(", ") || "none";
  console.log(`wrote ${configPath} (probes: ${names})`);
  if (probes.length === 0) {
    console.log("No test, typecheck or lint script found in package.json; add probes before running check.");
  }
  return 0;
}

function runDiff(base: string, json: boolean): number {
  let files: DiffFile[];
  try {
    files = readDiff(base);
  } catch (error) {
    console.error(`loadbearing diff: ${describeError(error)}`);
    return 2;
  }

  const mergeCommit = isMergeCommit(process.cwd(), "HEAD");
  const hunks = files.flatMap((file) => file.hunks);
  const unsupported = files.filter((file) => file.unsupported !== undefined);
  const clusters = buildDiffClusters(files, { mergeCommit });

  if (json) {
    process.stdout.write(`${JSON.stringify({ base, files, clusters }, null, 2)}\n`);
    return 0;
  }

  if (mergeCommit) {
    console.log(`HEAD is a merge commit; v0.1 does not judge merge diffs (${files.length} files listed).`);
    return 0;
  }

  if (hunks.length === 0 && unsupported.length === 0) {
    console.log(`No hunks against ${base}.`);
    return 0;
  }

  console.log(
    `${files.length} ${plural(files.length, "file")}, ${hunks.length} ${plural(hunks.length, "hunk")}, ` +
      `${clusters.length} ${plural(clusters.length, "cluster")} against ${base}`,
  );
  console.log();
  for (const hunk of hunks) {
    console.log(`${hunk.id}  -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines}`);
  }
  for (const file of unsupported) {
    console.log(`${file.file}  unsupported (${file.unsupported})`);
  }
  return 0;
}

function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "");
    if (text.trim() !== "") return text.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
