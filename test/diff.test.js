import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAnchorIndex, commentableLines, isAnchorable } from "../src/diff.js";

const PATCH = [
  "@@ -10,6 +10,7 @@ function load(id) {",
  " const row = db.find(id);",
  "-if (!row) return null;",
  "+if (!row) {",
  "+  throw new NotFound(id);",
  "+}",
  " return row;",
  "@@ -40,2 +41,2 @@",
  "-const a = 1;",
  "+const a = 2;",
].join("\n");

describe("commentableLines", () => {
  it("tracks both sides through a hunk", () => {
    const { right, left } = commentableLines(PATCH);

    // Hunk starts at new line 10: context 10, added 11-13, context 14.
    assert.deepEqual([...right].sort((a, b) => a - b), [10, 11, 12, 13, 14, 41]);
    // Old side: context 10, removed 11, context 12; second hunk removes 40.
    assert.deepEqual([...left].sort((a, b) => a - b), [10, 11, 12, 40]);
  });

  it("returns nothing for a binary or truncated file", () => {
    // GitHub omits `patch` for binaries and oversized diffs. Anchoring into one
    // would make the whole review payload 422.
    for (const patch of [undefined, null, ""]) {
      const { right, left } = commentableLines(patch);
      assert.equal(right.size, 0);
      assert.equal(left.size, 0);
    }
  });

  it("keeps counters aligned when a context line lost its leading space", () => {
    const { right } = commentableLines(
      ["@@ -1,3 +1,3 @@", " keep", "", "+added"].join("\n")
    );
    // Without the empty-line case the added line would be reported as 3.
    assert.ok(right.has(3), "added line should land on 3");
  });

  it("ignores the no-newline marker", () => {
    const { right } = commentableLines(
      ["@@ -1,1 +1,1 @@", "+only", "\\ No newline at end of file"].join("\n")
    );
    assert.deepEqual([...right], [1]);
  });
});

describe("isAnchorable", () => {
  const index = buildAnchorIndex([
    { filename: "src/load.js", patch: PATCH, status: "modified" },
    { filename: "logo.png", patch: undefined, status: "added" },
  ]);

  it("accepts a line the diff actually contains", () => {
    assert.equal(isAnchorable(index, "src/load.js", 12, "RIGHT"), true);
    assert.equal(isAnchorable(index, "src/load.js", 11, "LEFT"), true);
  });

  it("rejects a hallucinated line, file, or side", () => {
    assert.equal(isAnchorable(index, "src/load.js", 999, "RIGHT"), false);
    assert.equal(isAnchorable(index, "src/nope.js", 12, "RIGHT"), false);
    // 13 is an added line: it exists on RIGHT only.
    assert.equal(isAnchorable(index, "src/load.js", 13, "LEFT"), false);
    assert.equal(isAnchorable(index, "logo.png", 1, "RIGHT"), false);
  });
});
