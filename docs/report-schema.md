# `loadbearing/report@1`

This is the machine-readable result of `loadbearing check --base <rev> --json`
and of the `loadbearing_check` MCP tool. Both surfaces emit the same document;
the MCP server puts the JSON string in `content[0].text` and the same object in
`structuredContent`.

Every timestamp-bearing field is regenerated per run. The remaining fields are
derived from the diff, the config, the probe exit statuses, and the repository
path.

## Scope is part of the schema

`scope` is always `"mapped-probes-only"`, and it is a limit, not a guarantee.

A `droppable` verdict means **no probe whose globs match this cluster's files
regressed when the cluster was reverted**. It does not mean the code is dead. A
hunk whose only consumer lives in a file with no mapped probe — a caller in
another package, a config, an external contract — can be droppable while its
removal still breaks that consumer. v0.1 clusters within one file only and never
traces symbol references, so cross-file coupling is reported as a stated
limitation, never guessed at and never claimed as covered.

## Top level

```json
{
  "schema": "loadbearing/report@1",
  "repo": "/Users/you/project",
  "base": "origin/main",
  "head": "29bb4947341d808f104c76c3b4c44650fc5b82c9",
  "scope": "mapped-probes-only",
  "generatedAt": "2026-11-20T22:25:25.708Z",
  "probes": [],
  "baseline": { "ok": true, "probes": [] },
  "clusters": [],
  "summary": { "total": 0, "necessary": 0, "droppable": 0, "unverifiable": 0 }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | `"loadbearing/report@1"` | Literal schema id. |
| `repo` | string | Absolute path of the repository root. |
| `base` | string | The revision passed to `--base`, verbatim. |
| `head` | string | Full SHA of `HEAD`, abbreviated only by consumers. |
| `scope` | `"mapped-probes-only"` | Constant. Read the limitation above. |
| `generatedAt` | string | ISO 8601 timestamp for this run. |
| `probes` | `Probe[]` | The probes loaded from `loadbearing.yml`. |
| `baseline` | `Baseline` | Result of running every probe once on pristine `HEAD`. |
| `clusters` | `ClusterReport[]` | One entry per judged cluster, in diff order. |
| `summary` | `Summary` | Verdict counts over `clusters`. |

## `Probe`

The config entry, echoed so a report can be audited without the YAML file.

```json
{
  "name": "core",
  "run": "node test/core.js",
  "paths": ["src/util.js"]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string | Unique probe name; used to match baseline and reverted runs. |
| `run` | string | Shell command; executed through the platform shell. |
| `paths` | string[] | Glob patterns; a probe maps to a cluster when any glob matches any file. |

## `Baseline`

Every probe runs once on pristine `HEAD` before any revert. If any probe fails,
the run exits 3 and every cluster with a mapped probe becomes
`unverifiable:baseline-failed`; clusters with no mapped probe stay
`unverifiable:no-probe`.

```json
{
  "ok": false,
  "probes": [
    {
      "name": "core",
      "run": "node test/core.js",
      "exitCode": 1,
      "timedOut": false,
      "tail": ["AssertionError: ...", "  actual: 'hi ada',", "  expected: 'hello ada'"]
    }
  ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | boolean | `true` only when every probe passed. |
| `probes[].name` | string | Probe name. |
| `probes[].run` | string | Command that ran. |
| `probes[].exitCode` | number \| null | `null` when no status was obtained (timeout, signal, spawn failure). |
| `probes[].timedOut` | boolean | `true` when the per-probe timeout fired. |
| `probes[].tail` | string[]? | Last 20 lines of combined stdout/stderr, present only for a failing probe. |
| `probes[].error` | string? | Harness-level message, e.g. `timed out after 120000 ms`. |

## `ClusterReport`

One hunk cluster and the evidence for its badge.

```json
{
  "id": "cluster-2",
  "hunkIds": ["src/app.js#2"],
  "files": ["src/app.js"],
  "verdict": "necessary",
  "reason": "probe-failed",
  "detail": "app exited 1 while reverted",
  "probes": [
    {
      "name": "app",
      "run": "node test/app.js",
      "baselineExitCode": 0,
      "revertedExitCode": 1,
      "tail": ["AssertionError: scaled rounds", "..."]
    }
  ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Stable cluster id, `cluster-<n>` in first-seen diff order. When a revert forces a same-file merge, the merged cluster keeps the first cluster's id. |
| `hunkIds` | string[] | Hunk ids such as `src/app.js#2`. More than one after a merge. |
| `files` | string[] | Normalised paths the cluster touches. One file in v0.1. |
| `verdict` | `"necessary"` \| `"droppable"` \| `"unverifiable"` | The badge. |
| `reason` | `Reason` | Why the verdict was chosen; see the enum below. |
| `detail` | string? | Human-readable cause, present for failures and skips. |
| `probes` | `ProbeEvidence[]` | Evidence for every probe mapped to `files`. Empty for `no-probe`, `unsupported-diff`, and `skipped`, because no probe ran. |

### `Verdict` and `Reason`

| Verdict | Reason | Condition |
| --- | --- | --- |
| `necessary` | `probe-failed` | At least one mapped probe passed at baseline and exited non-zero when the cluster was reverted. |
| `droppable` | `probes-unaffected` | The reverse apply succeeded and every mapped probe still passed. |
| `unverifiable` | `no-probe` | No configured probe glob matches the cluster's files. |
| `unverifiable` | `baseline-failed` | At least one baseline probe failed, so no badge is possible. |
| `unverifiable` | `revert-apply-failed` | `git apply -R` failed even after merging the next hunk in the same file. |
| `unverifiable` | `probe-error` | A timeout, signal, spawn failure, or failed `sandbox.setup`. |
| `unverifiable` | `skipped` | `--max-clusters` was reached before this cluster was judged. |
| `unverifiable` | `unsupported-diff` | The diff can be listed but not judged. v0.1 emits this for submodule pointer changes, whose only content is `Subproject commit <sha>`. Binary files and pure renames are skipped during parsing. |

`droppable` is only emitted after a clean reverse apply and a green baseline. A
red baseline never yields a badge.

### `ProbeEvidence`

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string | Probe name. |
| `run` | string | Command that ran. |
| `baselineExitCode` | number \| null | Status on pristine `HEAD`. |
| `revertedExitCode` | number \| null | Status after the revert; `null` when the probe was not run (for example, no baseline). |
| `timedOut` | boolean? | Present and `true` when a timeout produced the failure. |
| `tail` | string[]? | Last 20 lines of the failing run: the reverted run when it failed, otherwise the baseline run. |

## `Summary`

```json
{ "total": 6, "necessary": 3, "droppable": 2, "unverifiable": 1 }
```

`total` equals `clusters.length`; the other counts sum to it.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | A report was emitted (verdicts may still be unverifiable). |
| `1` | Config error: missing or invalid `loadbearing.yml`, bad flag value. |
| `2` | Precondition failure: not a git repository, unknown base, no shared history, or a dirty working tree. |
| `3` | Baseline failed. The report is still emitted, with mapped clusters marked `unverifiable:baseline-failed`. |

`--json` changes only the output format; the exit code is identical.

## What this document does not cover

- `loadbearing diff --json` emits `{ "base", "files", "clusters" }`, a hunk
  inventory rather than a verdict report. It has no `schema` field.
- The MCP `structuredContent` is the same object as this report; the
  `content[0].text` copy is `JSON.stringify(report, null, 2)`.
- File names, hunk offsets, and probe tails are strings copied from git and the
  probes; the report does not normalise line endings inside `tail`.
