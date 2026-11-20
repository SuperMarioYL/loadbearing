import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiffFile } from "./diff.js";

export class GitError extends Error {}

export type Worktree = {
  /** The checked-out tree. */
  path: string;
  /** Temp directory that holds it; removed with the worktree. */
  parent: string;
};

export type ApplyResult = {
  ok: boolean;
  stderr: string;
};

/** Run git and return stdout, throwing GitError with stderr on failure. */
export function gitText(args: readonly string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new GitError(gitErrorMessage(args, error));
  }
}

/** Run git without throwing; callers inspect `ok`. */
export function gitTry(
  args: readonly string[],
  cwd: string,
  input?: string,
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: (result.stderr ?? "").trim() || result.error?.message || "",
  };
}

export function repoRoot(cwd: string): string {
  return gitText(["rev-parse", "--show-toplevel"], cwd).trim();
}

/** Full SHA for a revision, or null when it does not resolve to a commit. */
export function resolveCommit(root: string, rev: string): string | null {
  const result = gitTry(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], root);
  return result.ok ? result.stdout.trim() : null;
}

/** Porcelain status entries; empty means the tree matches HEAD. */
export function dirtyEntries(root: string): string[] {
  const result = gitTry(["status", "--porcelain", "--untracked-files=normal"], root);
  if (!result.ok) throw new GitError(`git status failed in ${root}: ${result.stderr}`);
  return result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
}

/**
 * Assemble the reverse patch for one cluster: the verbatim `---`/`+++` headers
 * plus only the selected hunk blocks. Headers are kept as git emitted them so
 * quoted paths still apply.
 */
export function buildClusterPatch(files: readonly DiffFile[], hunkIds: readonly string[]): string {
  const wanted = new Set(hunkIds);
  const blocks: string[] = [];

  for (const file of files) {
    const hunks = file.hunks.filter((hunk) => wanted.has(hunk.id));
    if (hunks.length === 0) continue;
    blocks.push(`--- ${file.oldHeader}\n+++ ${file.newHeader}\n`);
    for (const hunk of hunks) blocks.push(hunk.patch);
  }

  return blocks.join("");
}

/** Create a detached worktree of HEAD in a fresh temp directory. */
export function createWorktree(root: string): Worktree {
  const parent = mkdtempSync(join(tmpdir(), "loadbearing-wt-"));
  const path = join(parent, "tree");
  const result = gitTry(["worktree", "add", "--detach", path, "HEAD"], root);
  if (!result.ok) {
    rmSync(parent, { recursive: true, force: true });
    throw new GitError(`git worktree add failed: ${result.stderr}`);
  }
  return { path, parent };
}

/** Remove a worktree and its temp parent, pruning git's bookkeeping. */
export function removeWorktree(root: string, worktree: Worktree, keep: boolean): void {
  if (keep) return;
  gitTry(["worktree", "remove", "--force", worktree.path], root);
  rmSync(worktree.parent, { recursive: true, force: true });
  gitTry(["worktree", "prune"], root);
}

/** Reverse-apply a patch inside the worktree. git apply is atomic: nothing lands on failure. */
export function applyReverse(worktreePath: string, patch: string): ApplyResult {
  const result = spawnSync("git", ["apply", "-R", "--whitespace=nowarn", "-"], {
    cwd: worktreePath,
    input: patch,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    ok: result.status === 0,
    stderr: (result.stderr ?? "").trim() || result.error?.message || "",
  };
}

function gitErrorMessage(args: readonly string[], error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  if (stderr !== undefined) {
    const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr);
    if (text.trim() !== "") return text.trim();
  }
  return `git ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`;
}
