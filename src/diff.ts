import { execFileSync } from "node:child_process";

/** One hunk of a unified diff. `patch` is the verbatim block, newline-terminated. */
export type Hunk = {
  id: string;
  file: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  patch: string;
  /** Set for diffs v0.1 can list but not judge, e.g. a submodule pointer change. */
  unsupported?: string;
};

/** One `diff --git` section of a text diff. */
export type DiffFile = {
  file: string;
  /** Raw `---` token, kept verbatim so a patch can be reassembled for `git apply`. */
  oldHeader: string;
  /** Raw `+++` token. */
  newHeader: string;
  hunks: Hunk[];
};

const DEV_NULL = "/dev/null";

// `@@ -a[,b] +c[,d] @@<anything>`. A missing `,count` means one line for that
// side only, so `-0,0 +1` is oldLines=0, newLines=1.
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Turn a raw `---`/`+++` token into the path used for ids and probe globs.
 *
 * Git emits space-containing paths with a trailing TAB, and C-quotes paths
 * containing a backslash, double quote, newline or TAB (`core.quotePath=false`
 * only un-quotes non-ASCII). A quoted token still wraps the `a/`/`b/` prefix
 * and can also end in a TAB, so the order is fixed: strip one TAB, un-quote,
 * then strip one prefix.
 */
export function normaliseDiffPath(rawToken: string): string {
  let token = rawToken;
  if (token.endsWith("\t")) token = token.slice(0, -1);
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    token = cUnquote(token);
  }
  if (token.startsWith("a/") || token.startsWith("b/")) token = token.slice(2);
  return token;
}

/**
 * Parse `git -c core.quotePath=false diff` output into file sections.
 *
 * Sections without a `---`/`+++` pair (binary files, pure renames, mode-only
 * changes) and sections without hunks are skipped.
 */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");

  let section: { oldHeader?: string; newHeader?: string; submodule?: boolean; hunks: PendingHunk[] } | null = null;
  let hunk: PendingHunk | null = null;

  const finishHunk = (): void => {
    if (hunk !== null && section !== null) section.hunks.push(hunk);
    hunk = null;
  };

  const finishSection = (): void => {
    finishHunk();
    const current = section;
    section = null;
    if (current === null || current.oldHeader === undefined || current.newHeader === undefined) return;
    if (current.hunks.length === 0) return;

    // `+++ /dev/null` is a whole-file deletion: the real path is on `---`.
    const newPath = normaliseDiffPath(current.newHeader);
    const file = newPath === DEV_NULL ? normaliseDiffPath(current.oldHeader) : newPath;
    if (file === "") return;

    files.push({
      file,
      oldHeader: current.oldHeader,
      newHeader: current.newHeader,
      hunks: current.hunks.map((parsed, index) => ({
        id: `${file}#${index + 1}`,
        file,
        oldStart: parsed.oldStart,
        oldLines: parsed.oldLines,
        newStart: parsed.newStart,
        newLines: parsed.newLines,
        patch: `${parsed.lines.join("\n")}\n`,
        ...(current.submodule === true ? { unsupported: "submodule" } : {}),
      })),
    });
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      finishSection();
      section = { hunks: [] };
      continue;
    }
    if (section === null) continue;
    if (isSubmoduleLine(line)) section.submodule = true;

    if (hunk !== null) {
      // A hunk body only ends at the next hunk header or the next file section.
      if (!line.startsWith("@@ ")) {
        hunk.lines.push(line);
        continue;
      }
      finishHunk();
    }

    if (line.startsWith("@@ ")) {
      const match = HUNK_HEADER.exec(line);
      if (match === null) continue;
      hunk = {
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        lines: [line],
      };
      continue;
    }

    if (section.oldHeader === undefined && line.startsWith("--- ")) {
      section.oldHeader = line.slice(4);
      continue;
    }
    if (section.oldHeader !== undefined && section.newHeader === undefined && line.startsWith("+++ ")) {
      section.newHeader = line.slice(4);
    }
  }

  finishSection();
  return files;
}

/** Read `git -c core.quotePath=false diff <base>...HEAD` in `cwd` and parse it. */
export function readDiff(base: string, cwd: string = process.cwd()): DiffFile[] {
  const output = execFileSync("git", ["-c", "core.quotePath=false", "diff", `${base}...HEAD`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return parseDiff(output);
}

type PendingHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

/**
 * A gitlink change is a submodule pointer bump, not file content. Its `+`/`-`
 * lines say `Subproject commit <sha>`, so reversing it would only move the
 * pointer; no probe in the parent repository can observe that.
 */
function isSubmoduleLine(line: string): boolean {
  return (
    /^(?:new file mode|deleted file mode|old mode|new mode) 160000$/.test(line) ||
    /^index [0-9a-f]+\.\.[0-9a-f]+ 160000$/.test(line) ||
    /^Subproject commit [0-9a-f]+$/.test(line)
  );
}

/**
 * Decode git's C-style quoted token (`"b/src/x\\y file.js"`). Octal escapes are
 * decoded as bytes so multi-byte UTF-8 survives.
 */
function cUnquote(token: string): string {
  const inner = token.slice(1, -1);
  const bytes: number[] = [];

  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i]!;
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }

    const escaped = inner[i + 1];
    if (escaped === undefined) {
      bytes.push(0x5c);
      break;
    }
    i += 1;

    switch (escaped) {
      case "a":
        bytes.push(0x07);
        break;
      case "b":
        bytes.push(0x08);
        break;
      case "f":
        bytes.push(0x0c);
        break;
      case "n":
        bytes.push(0x0a);
        break;
      case "r":
        bytes.push(0x0d);
        break;
      case "t":
        bytes.push(0x09);
        break;
      case "v":
        bytes.push(0x0b);
        break;
      case "\\":
        bytes.push(0x5c);
        break;
      case '"':
        bytes.push(0x22);
        break;
      default: {
        if (escaped >= "0" && escaped <= "7") {
          let octal = escaped;
          while (octal.length < 3) {
            const next = inner[i + 1];
            if (next === undefined || next < "0" || next > "7") break;
            octal += next;
            i += 1;
          }
          bytes.push(Number.parseInt(octal, 8) & 0xff);
        } else {
          bytes.push(...Buffer.from(escaped, "utf8"));
        }
      }
    }
  }

  return Buffer.from(bytes).toString("utf8");
}
