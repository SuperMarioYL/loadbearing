import type { Hunk } from "./diff.js";

export type Cluster = {
  id: string;
  hunkIds: string[];
  files: string[];
};

/** One cluster per hunk; v0.1 never clusters across files. */
export function buildClusters(hunks: readonly Hunk[]): Cluster[] {
  return hunks.map((hunk, index) => ({
    id: `cluster-${index + 1}`,
    hunkIds: [hunk.id],
    files: [hunk.file],
  }));
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
  };

  return clusters.flatMap((cluster, position) => {
    if (position === index) return [merged];
    if (position === next) return [];
    return [cluster];
  });
}
