import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { reportJson } from "./report.js";
import { runCheck } from "./verdict.js";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

// Declared so tools/call can carry the report as structuredContent; the full
// report (including cluster evidence) is also in the text content block.
// The report object is the exact shape documented in docs/report-schema.md.
const EXIT_CODE = z.number().int().nullable();

const PROBE_OUTPUT = z.object({
  name: z.string(),
  run: z.string(),
  paths: z.array(z.string()),
});

const BASELINE_PROBE_OUTPUT = z.object({
  name: z.string(),
  run: z.string(),
  exitCode: EXIT_CODE,
  timedOut: z.boolean(),
  tail: z.array(z.string()).optional(),
  error: z.string().optional(),
});

const EVIDENCE_OUTPUT = z.object({
  name: z.string(),
  run: z.string(),
  baselineExitCode: EXIT_CODE,
  revertedExitCode: EXIT_CODE,
  timedOut: z.boolean().optional(),
  tail: z.array(z.string()).optional(),
});

const REASON_OUTPUT = z.enum([
  "probe-failed",
  "probes-unaffected",
  "no-probe",
  "baseline-failed",
  "revert-apply-failed",
  "probe-error",
  "unsupported-diff",
  "skipped",
]);

const REPORT_OUTPUT = {
  schema: z.literal("loadbearing/report@1"),
  repo: z.string(),
  base: z.string(),
  head: z.string(),
  scope: z.literal("mapped-probes-only"),
  generatedAt: z.string(),
  probes: z.array(PROBE_OUTPUT),
  baseline: z.object({ ok: z.boolean(), probes: z.array(BASELINE_PROBE_OUTPUT) }),
  clusters: z.array(
    z.object({
      id: z.string(),
      hunkIds: z.array(z.string()),
      files: z.array(z.string()),
      verdict: z.enum(["necessary", "droppable", "unverifiable"]),
      reason: REASON_OUTPUT,
      detail: z.string().optional(),
      probes: z.array(EVIDENCE_OUTPUT),
    }),
  ),
  summary: z.object({
    total: z.number(),
    necessary: z.number(),
    droppable: z.number(),
    unverifiable: z.number(),
  }),
};

const TOOL_INPUT = {
  base: z.string().min(1).describe("Base revision to diff against, e.g. origin/main or HEAD~1"),
  config: z.string().min(1).optional().describe("Config path relative to the repository root"),
  timeout: z.number().int().positive().optional().describe("Per-probe timeout in seconds"),
};

/** Serve `loadbearing_check` over stdio. Stdout carries only protocol frames. */
export async function serveMcp(cwd: string = process.cwd()): Promise<void> {
  const server = new McpServer({ name: "loadbearing", version: VERSION });

  server.registerTool(
    "loadbearing_check",
    {
      title: "Loadbearing check",
      description:
        "Revert each hunk cluster of <base>...HEAD in a sandbox worktree and run only the probes mapped " +
        "to its files. Returns a loadbearing/report@1 verdicts report. Never edits the branch. Verdicts are " +
        "scoped to mapped probes: droppable means no mapped probe regressed, not that the code is dead.",
      inputSchema: TOOL_INPUT,
      outputSchema: REPORT_OUTPUT,
    },
    async (args) => {
      const result = await runCheck({
        cwd,
        base: args.base,
        configPath: args.config,
        ...(args.timeout === undefined ? {} : { timeoutMs: args.timeout * 1000 }),
      });

      if (result.report === undefined) {
        throw new Error(result.error ?? `loadbearing check failed with exit code ${result.exitCode}`);
      }

      return {
        content: [{ type: "text", text: reportJson(result.report) }],
        structuredContent: result.report,
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
