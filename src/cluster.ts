import type { DiffFile, UnsupportedKind } from "./diff.js";

export type Cluster = {
  id: string;
  hunkIds: string[];
  files: string[];
  /** Set when v0.1 can list the diff but not judge it. */
  unsupported?: UnsupportedKind;
};

/**
 * Build clusters in diff order. A hunk-bearing section yields one cluster per
 * hunk; an unsupported section yields a single marker cluster so the report
 * never reads as clean when nothing could be judged. A merge commit makes the
 * whole diff unjudgeable, so it yields one marker covering every listed file.
 */
export function buildDiffClusters(
  files: readonly DiffFile[],
  options: { mergeCommit?: boolean } = {},
): Cluster[] {
  if (options.mergeCommit === true) {
    return [{ id: "cluster-1", hunkIds: [], files: files.map((file) => file.file), unsupported: "merge" }];
  }

  const clusters: Cluster[] = [];
  for (const file of files) {
    if (file.unsupported !== undefined) {
      clusters.push({
        id: `cluster-${clusters.length + 1}`,
        hunkIds: [],
        files: [file.file],
        unsupported: file.unsupported,
      });
      continue;
    }
    for (const hunk of file.hunks) {
      clusters.push({ id: `cluster-${clusters.length + 1}`, hunkIds: [hunk.id], files: [hunk.file] });
    }
  }
  return clusters;
}

/**
 * Merge the cluster at `index` with the next cluster in the same file. This is
 * the retry hook for a revert that fails to apply: the merged cluster holds the
 * original id and both hunk ids. Returns null when the file has no later hunk.
 */
export function mergeWithNextInFile(clusters: readonly Cluster[], index: number): Cluster[] | null {
  const target = clusters[index];
  if (target === undefined) return null;

  const file = target.files[0];
  const next = clusters.findIndex((cluster, position) => position > index && cluster.files[0] === file);
  if (next === -1) return null;

  const merged: Cluster = {
    id: target.id,
    hunkIds: [...target.hunkIds, ...clusters[next]!.hunkIds],
    files: [...target.files],
    ...(target.unsupported === undefined ? {} : { unsupported: target.unsupported }),
  };

  return clusters.flatMap((cluster, position) => {
    if (position === index) return [merged];
    if (position === next) return [];
    return [cluster];
  });
}
