# Changelog

All notable changes to Loadbearing are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-11-21

First public release. The gate parses a diff, reverts one hunk cluster at a time
in a throwaway worktree, runs only the probes mapped to that cluster's files, and
reports whether removing the cluster changed any probe outcome.

### m1 — Parse diff hunks and emit one-hunk clusters

- Added `loadbearing diff --base <rev> [--json]`, which reads
  `git -c core.quotePath=false diff <base>...HEAD` without a diff library and
  keeps each hunk block verbatim for `git apply`.
- Hunk ids use the normalised path (`file#n`); normalisation strips one trailing
  TAB, C-un-quotes quoted tokens, then strips the `a/`/`b/` prefix, in that
  order. Whole-file deletions take the path from the `---` header.
- A missing `,count` in a hunk header means one line for that side only, so
  `@@ -0,0 +1 @@` is `oldLines: 0`, `newLines: 1`.
- Every hunk starts in its own cluster. Output is deterministic across runs.

### m2 — Revert clusters and run mapped probes

- Added `loadbearing check --base <rev>`, which runs a baseline on pristine
  `HEAD`, creates a detached `git worktree` per cluster, reverse-applies only
  that cluster's blocks, and reruns the probes whose globs match its files.
- Added `src/verdict.ts` classification: a mapped probe that passed at baseline
  and fails when reverted makes the cluster `necessary`; all mapped probes
  passing makes it `droppable`; no mapped probe, a red baseline, a failed
  reverse apply, or a harness error makes it `unverifiable` with a reason.
- Added same-file merging when a reverse apply fails, `--keep-worktrees`,
  `--timeout`, and `--max-clusters`. The bundled fixture yields 3 necessary,
  2 droppable, and 1 unverifiable cluster.
- The report states `scope: mapped-probes-only` and carries baseline and
  reverted exit codes for every mapped probe.
- Submodule pointer changes, binary files, pure renames, and mode-only changes are
  reported `unverifiable:unsupported-diff` instead of being dropped, and a merge
  commit yields one `unsupported-diff` marker for the whole diff. An unjudgeable
  diff never reads as clean.

### m3 — Expose the MCP tool

- Added `loadbearing mcp`, a stdio MCP server serving the `loadbearing_check`
  tool with `{base, config?, timeout?}` input.
- `tools/call` returns a `CallToolResult` envelope: the
  `loadbearing/report@1` JSON in `content[0].text` and the same report in
  `structuredContent`, backed by a declared `outputSchema`.
- A bad base returns `isError: true` with a readable message instead of
  crashing the server.

### m4 — Package, document, and demo

- Packaged as `loadbearing-gate` (npm publish pending); 0.1.0 is installed from
  the GitHub Release tarball or built from source.
- Added `init`, which writes `loadbearing.yml` from existing `test`,
  `typecheck`, and `lint` scripts, plus `--help` on every command and a
  top-level `--version`.
- Added `docs/report-schema.md` and a recorded asciinema demo at
  `docs/assets/demo.cast`.
- Added CI and a tag-driven release workflow that attaches the packed tarball
  and its SHA-256 checksum to the GitHub Release.

[0.1.0]: https://github.com/SuperMarioYL/loadbearing/releases/tag/v0.1.0
