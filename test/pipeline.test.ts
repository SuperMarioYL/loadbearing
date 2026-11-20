import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import picomatch from "picomatch";
import { afterEach, describe, expect, it } from "vitest";
import { buildClusters, mergeWithNextInFile } from "../src/cluster";
import { normaliseDiffPath, parseDiff, readDiff } from "../src/diff";
import { runCheck } from "../src/verdict";

const repos: string[] = [];
const FIXTURE = join(process.cwd(), "fixtures", "seed-agent-pr.sh");

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe("parseDiff", () => {
  it("splits hunks on their own headers and ignores section context after @@", () => {
    const diff = [
      "diff --git a/src/alpha.js b/src/alpha.js",
      "index 1111111..2222222 100644",
      "--- a/src/alpha.js",
      "+++ b/src/alpha.js",
      "@@ -3,2 +3,3 @@ export function add(a, b) {",
      " context",
      "-old",
      "+new",
      "+extra",
      "@@ -20 +21 @@",
      "-tail",
      "+TAIL",
      "",
    ].join("\n");

    const files = parseDiff(diff);

    expect(files).toHaveLength(1);
    expect(files[0]!.file).toBe("src/alpha.js");
    expect(files[0]!.oldHeader).toBe("a/src/alpha.js");
    expect(files[0]!.newHeader).toBe("b/src/alpha.js");
    expect(files[0]!.hunks.map((hunk) => hunk.id)).toEqual(["src/alpha.js#1", "src/alpha.js#2"]);

    const [first, second] = files[0]!.hunks;
    expect(first).toMatchObject({ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3 });
    // A missing `,count` is one line for that side only.
    expect(second).toMatchObject({ oldStart: 20, oldLines: 1, newStart: 21, newLines: 1 });

    expect(first!.patch.startsWith("@@ -3,2 +3,3 @@ export function add(a, b) {\n")).toBe(true);
    expect(first!.patch).toContain("-old\n+new\n+extra\n");
    expect(first!.patch).not.toContain("TAIL");
    expect(second!.patch).toBe("@@ -20 +21 @@\n-tail\n+TAIL\n");
  });

  it("skips binary sections and keeps parsing after them", () => {
    const diff = [
      "diff --git a/logo.png b/logo.png",
      "new file mode 100644",
      "index 0000000..1111111",
      "Binary files /dev/null and b/logo.png differ",
      "diff --git a/src/keep.js b/src/keep.js",
      "index 3333333..4444444 100644",
      "--- a/src/keep.js",
      "+++ b/src/keep.js",
      "@@ -1 +1 @@",
      "-keep",
      "+kept",
      "",
    ].join("\n");

    const files = parseDiff(diff);

    expect(files.map((file) => file.file)).toEqual(["src/keep.js"]);
    expect(files[0]!.hunks[0]).toMatchObject({ oldLines: 1, newLines: 1 });
  });

  it("takes the file from --- when +++ is /dev/null", () => {
    const diff = [
      "diff --git a/src/gone.js b/src/gone.js",
      "deleted file mode 100644",
      "index 5555555..0000000",
      "--- a/src/gone.js",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-gone one",
      "-gone two",
      "",
    ].join("\n");

    const files = parseDiff(diff);

    expect(files[0]!.file).toBe("src/gone.js");
    expect(files[0]!.hunks[0]!.id).toBe("src/gone.js#1");
    expect(files[0]!.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 });
  });
});

describe("normaliseDiffPath", () => {
  it("strips the TAB, then un-quotes, then the a/ or b/ prefix", () => {
    expect(normaliseDiffPath('"b/src/back\\\\slash file.js"\t')).toBe("src/back\\slash file.js");
    expect(normaliseDiffPath('"b/src/qu\\"ote file.js"\t')).toBe('src/qu"ote file.js');
    expect(normaliseDiffPath("b/src/héllo wörld.js\t")).toBe("src/héllo wörld.js");
    expect(normaliseDiffPath("a/src/plain.js")).toBe("src/plain.js");
    expect(normaliseDiffPath("/dev/null")).toBe("/dev/null");
  });
});

describe("readDiff", () => {
  it("parses the three-file, six-hunk fixture deterministically", () => {
    const repo = makeRepo({
      "src/alpha.js": numbered("alpha"),
      "src/beta.js": numbered("beta"),
      "src/gamma.js": numbered("gamma"),
    });
    commit(repo, {
      "src/alpha.js": edited("alpha"),
      "src/beta.js": edited("beta"),
      "src/gamma.js": edited("gamma"),
    });

    const first = JSON.stringify(readDiff("HEAD~1", repo));
    const second = JSON.stringify(readDiff("HEAD~1", repo));
    expect(first).toBe(second);

    const files = readDiff("HEAD~1", repo);
    expect(files.map((file) => file.file)).toEqual(["src/alpha.js", "src/beta.js", "src/gamma.js"]);

    const hunks = files.flatMap((file) => file.hunks);
    expect(hunks).toHaveLength(6);
    expect(hunks.map((hunk) => hunk.id)).toEqual([
      "src/alpha.js#1",
      "src/alpha.js#2",
      "src/beta.js#1",
      "src/beta.js#2",
      "src/gamma.js#1",
      "src/gamma.js#2",
    ]);

    const clusters = buildClusters(hunks);
    expect(clusters).toHaveLength(6);
    expect(clusters.every((cluster) => cluster.hunkIds.length === 1)).toBe(true);
  });

  it("handles new files, deletions and paths with spaces, quotes, backslashes or non-ASCII", () => {
    const repo = makeRepo({
      "src/back\\slash file.js": "one\ntwo\nthree\n",
      'src/qu"ote file.js': "one\ntwo\nthree\n",
      "src/héllo wörld.js": "one\ntwo\nthree\n",
      "src/gone.js": "gone one\ngone two\n",
    });
    commit(
      repo,
      {
        "src/back\\slash file.js": "one\ntwo\nTHREE\n",
        'src/qu"ote file.js': "one\ntwo\nTHREE\n",
        "src/héllo wörld.js": "one\ntwo\nTHREE\n",
        "src/new.js": "new single line\n",
      },
      ["src/gone.js"],
    );

    const files = readDiff("HEAD~1", repo);
    expect(files.map((file) => file.file).sort()).toEqual(
      ["src/back\\slash file.js", "src/gone.js", "src/héllo wörld.js", "src/new.js", 'src/qu"ote file.js'].sort(),
    );

    const awkward = files.find((file) => file.file === "src/back\\slash file.js")!;
    expect(awkward.hunks[0]!.id).toBe("src/back\\slash file.js#1");
    // Probe globs match the normalised path, and the raw header stays quoted so a
    // reassembled patch still applies.
    expect(picomatch("src/**")(awkward.file)).toBe(true);
    expect(awkward.newHeader.endsWith('"\t')).toBe(true);

    const nonAscii = files.find((file) => file.file === "src/héllo wörld.js")!;
    expect(picomatch("src/**")(nonAscii.file)).toBe(true);

    const added = files.find((file) => file.file === "src/new.js")!;
    expect(added.hunks).toHaveLength(1);
    expect(added.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 });
    expect(added.hunks[0]!.patch.startsWith("@@ -0,0 +1 @@\n")).toBe(true);

    const deleted = files.find((file) => file.file === "src/gone.js")!;
    expect(deleted.newHeader).toBe("/dev/null");
    expect(deleted.oldHeader).toBe("a/src/gone.js");
    expect(deleted.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 });
  });
});

describe("check", () => {
  it(
    "reverts each cluster and reports 3 necessary / 2 droppable / 1 no-probe",
    async () => {
      const repo = seedFixture();
      const result = await runCheck({ cwd: repo, base: "HEAD~1" });

      expect(result.exitCode).toBe(0);
      const report = result.report!;
      expect(report.schema).toBe("loadbearing/report@1");
      expect(report.scope).toBe("mapped-probes-only");
      expect(report.baseline.ok).toBe(true);
      expect(report.summary).toEqual({ total: 6, necessary: 3, droppable: 2, unverifiable: 1 });

      expect(report.clusters.map((cluster) => [cluster.id, cluster.verdict, cluster.reason])).toEqual([
        ["cluster-1", "droppable", "probes-unaffected"],
        ["cluster-2", "necessary", "probe-failed"],
        ["cluster-3", "unverifiable", "no-probe"],
        ["cluster-4", "necessary", "probe-failed"],
        ["cluster-5", "necessary", "probe-failed"],
        ["cluster-6", "droppable", "probes-unaffected"],
      ]);

      const noProbe = report.clusters.find((cluster) => cluster.id === "cluster-3")!;
      expect(noProbe.files).toEqual(["src/extra.js"]);
      expect(noProbe.probes).toEqual([]);

      const necessary = report.clusters.find((cluster) => cluster.id === "cluster-2")!;
      expect(necessary.hunkIds).toEqual(["src/app.js#2"]);
      expect(necessary.probes).toHaveLength(1);
      expect(necessary.probes[0]).toMatchObject({ name: "app", baselineExitCode: 0, revertedExitCode: 1 });
      expect(necessary.probes[0]!.tail?.length).toBeGreaterThan(0);

      // No sandbox worktree survives the run.
      const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" })
        .split("\n")
        .filter((line) => line.startsWith("worktree "));
      expect(worktrees).toHaveLength(1);
      expect(result.keptWorktrees).toEqual([]);
    },
    30_000,
  );

  it(
    "marks clusters beyond --max-clusters unverifiable instead of judging them",
    async () => {
      const repo = seedFixture();
      const result = await runCheck({ cwd: repo, base: "HEAD~1", maxClusters: 2 });

      expect(result.exitCode).toBe(0);
      expect(result.report!.summary).toEqual({ total: 6, necessary: 1, droppable: 1, unverifiable: 4 });
      expect(result.report!.clusters.filter((cluster) => cluster.reason === "skipped")).toHaveLength(3);
      expect(result.report!.clusters.find((cluster) => cluster.id === "cluster-3")).toMatchObject({
        reason: "no-probe",
      });
    },
    30_000,
  );

  it(
    "refuses a dirty tree with exit code 2",
    async () => {
      const repo = seedFixture();
      writeFileSync(join(repo, "src/app.js"), "// uncommitted\n", { flag: "a" });

      const result = await runCheck({ cwd: repo, base: "HEAD~1" });

      expect(result.exitCode).toBe(2);
      expect(result.report).toBeUndefined();
      expect(result.error).toMatch(/dirty/i);
    },
    30_000,
  );

  it(
    "exits 3 and marks mapped clusters baseline-failed when the baseline is red",
    async () => {
      const repo = seedFixture();
      writeFileSync(join(repo, "test/core.js"), "'use strict';\nconsole.error('red baseline');\nprocess.exit(1);\n");
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "--amend", "--no-edit"]);

      const result = await runCheck({ cwd: repo, base: "HEAD~1" });

      expect(result.exitCode).toBe(3);
      const report = result.report!;
      expect(report.baseline.ok).toBe(false);
      expect(report.baseline.probes.find((probe) => probe.name === "core")).toMatchObject({ exitCode: 1 });

      const mapped = report.clusters.filter((cluster) => cluster.files[0] !== "src/extra.js" && cluster.files[0] !== "test/core.js");
      expect(mapped).toHaveLength(5);
      for (const cluster of mapped) {
        expect(cluster).toMatchObject({ verdict: "unverifiable", reason: "baseline-failed" });
        expect(cluster.probes.length).toBeGreaterThan(0);
      }
      expect(report.clusters.find((cluster) => cluster.files[0] === "src/extra.js")).toMatchObject({
        verdict: "unverifiable",
        reason: "no-probe",
      });
    },
    30_000,
  );
});

function seedFixture(): string {
  const repo = mkdtempSync(join(tmpdir(), "loadbearing-fixture-"));
  repos.push(repo);
  execFileSync("bash", [FIXTURE, repo], { stdio: "pipe" });
  return repo;
}

describe("clusters", () => {
  it("merges a cluster with the next hunk in the same file", () => {
    const diff = [
      "diff --git a/src/alpha.js b/src/alpha.js",
      "--- a/src/alpha.js",
      "+++ b/src/alpha.js",
      "@@ -1 +1 @@",
      "-one",
      "+ONE",
      "@@ -9 +9 @@",
      "-nine",
      "+NINE",
      "",
    ].join("\n");

    const clusters = buildClusters(parseDiff(diff)[0]!.hunks);
    expect(clusters).toEqual([
      { id: "cluster-1", hunkIds: ["src/alpha.js#1"], files: ["src/alpha.js"] },
      { id: "cluster-2", hunkIds: ["src/alpha.js#2"], files: ["src/alpha.js"] },
    ]);

    const merged = mergeWithNextInFile(clusters, 0);
    expect(merged).toEqual([{ id: "cluster-1", hunkIds: ["src/alpha.js#1", "src/alpha.js#2"], files: ["src/alpha.js"] }]);
    expect(mergeWithNextInFile(merged!, 0)).toBeNull();
  });
});

function makeRepo(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "loadbearing-test-"));
  repos.push(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@loadbearing.local"]);
  git(repo, ["config", "user.name", "Loadbearing Test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  writeFiles(repo, files);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return repo;
}

function commit(repo: string, files: Record<string, string>, removed: string[] = []): void {
  writeFiles(repo, files);
  for (const path of removed) rmSync(join(repo, path));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "change"]);
}

function writeFiles(repo: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(repo, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function git(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

function numbered(prefix: string): string {
  return Array.from({ length: 24 }, (_, index) => `${prefix} line ${index + 1}`).join("\n") + "\n";
}

function edited(prefix: string): string {
  const lines = Array.from({ length: 24 }, (_, index) => `${prefix} line ${index + 1}`);
  lines[1] = `${prefix} line 2 changed`;
  lines[21] = `${prefix} line 22 changed`;
  return lines.join("\n") + "\n";
}
