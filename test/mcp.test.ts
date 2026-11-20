import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
const FIXTURE = join(here, "..", "fixtures", "seed-agent-pr.sh");

const repos: string[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe("mcp tool: loadbearing_check", () => {
  it(
    "returns the report as a CallToolResult content block and structured content",
    async () => {
      const repo = seedFixture();
      const client = await connect(repo);

      try {
        const { tools } = await client.listTools();
        const tool = tools.find((candidate) => candidate.name === "loadbearing_check");
        expect(tool).toBeDefined();
        expect(tool!.outputSchema).toBeDefined();
        expect(tool!.inputSchema).toMatchObject({ type: "object" });

        const result = await client.callTool({ name: "loadbearing_check", arguments: { base: "HEAD~1" } });

        expect(Array.isArray(result.content)).toBe(true);
        expect(result.isError ?? false).toBe(false);

        const blocks = result.content as Array<{ type: string; text?: string }>;
        expect(blocks[0]?.type).toBe("text");
        const report = JSON.parse(blocks[0]!.text!) as {
          schema: string;
          scope: string;
          summary: Record<string, number>;
          clusters: Array<{ id: string; verdict: string; reason: string }>;
        };
        expect(report.schema).toBe("loadbearing/report@1");
        expect(report.scope).toBe("mapped-probes-only");
        expect(report.summary).toEqual({ total: 6, necessary: 3, droppable: 2, unverifiable: 1 });

        expect(result.structuredContent).toMatchObject({
          schema: "loadbearing/report@1",
          scope: "mapped-probes-only",
          summary: { total: 6, necessary: 3, droppable: 2, unverifiable: 1 },
        });

        // Same report as `check --json` (timestamps aside).
        const cliReport = JSON.parse(
          execFileSync(process.execPath, [CLI, "check", "--base", "HEAD~1", "--json"], {
            cwd: repo,
            encoding: "utf8",
          }),
        ) as typeof report;
        expect(cliReport.schema).toBe(report.schema);
        expect(cliReport.summary).toEqual(report.summary);
        expect(cliReport.clusters.map((cluster) => [cluster.id, cluster.verdict, cluster.reason])).toEqual(
          report.clusters.map((cluster) => [cluster.id, cluster.verdict, cluster.reason]),
        );
      } finally {
        await client.close();
      }
    },
    60_000,
  );

  it(
    "returns isError for a base that does not resolve",
    async () => {
      const repo = seedFixture();
      const client = await connect(repo);

      try {
        const result = await client.callTool({
          name: "loadbearing_check",
          arguments: { base: "definitely-not-a-revision" },
        });

        expect(result.isError).toBe(true);
        const blocks = result.content as Array<{ type: string; text?: string }>;
        expect(blocks[0]?.type).toBe("text");
        expect(blocks[0]!.text).toMatch(/unknown base revision/i);
      } finally {
        await client.close();
      }
    },
    30_000,
  );
});

async function connect(repo: string): Promise<Client> {
  const client = new Client({ name: "loadbearing-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp"],
    cwd: repo,
  });
  await client.connect(transport);
  return client;
}

function seedFixture(): string {
  const repo = mkdtempSync(join(tmpdir(), "loadbearing-mcp-"));
  repos.push(repo);
  execFileSync("bash", [FIXTURE, repo], { stdio: "pipe" });
  return repo;
}
