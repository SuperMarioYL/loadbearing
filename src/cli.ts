#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { buildClusters } from "./cluster.js";
import { readDiff, type DiffFile } from "./diff.js";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

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

// TODO(m2): worktree sandbox, reverse apply, probe mapping, verdicts.
stubCommand("check", "badge each hunk cluster necessary, droppable or unverifiable");
// TODO(m3): stdio MCP server exposing the loadbearing_check tool.
stubCommand("mcp", "serve the loadbearing_check tool over stdio");
// TODO(m4): derive a starter config from package.json scripts.
stubCommand("init", "write a starter loadbearing.yml");

program.parse();

function runDiff(base: string, json: boolean): number {
  let files: DiffFile[];
  try {
    files = readDiff(base);
  } catch (error) {
    console.error(`loadbearing diff: ${describeError(error)}`);
    return 2;
  }

  const hunks = files.flatMap((file) => file.hunks);
  const clusters = buildClusters(hunks);

  if (json) {
    process.stdout.write(`${JSON.stringify({ base, files, clusters }, null, 2)}\n`);
    return 0;
  }

  if (hunks.length === 0) {
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
  return 0;
}

function stubCommand(name: string, description: string): void {
  program
    .command(name)
    .description(`${description} (not implemented in this build)`)
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      console.error(`loadbearing ${name}: not implemented in this build`);
      process.exitCode = 1;
    });
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
