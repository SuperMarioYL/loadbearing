import { describe, it } from "vitest";

// TODO(m1): parse the seeded fixture and assert normalised paths, `file#n` ids
// and one-hunk clusters: new-file (`@@ -0,0 +1 @@`), count-less sides, trailing
// section context, quoted/TAB-terminated paths and a `+++ /dev/null` deletion.
describe.skip("diff parsing and hunk clustering", () => {
  it("assigns file#n ids from normalised paths", () => {
    // Filled in when src/diff.ts and src/cluster.ts land.
  });
});
