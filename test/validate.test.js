import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAnchorIndex } from "../src/diff.js";
import {
  fingerprintOf,
  parseAgentOutput,
  selectEvent,
  verifyFindings,
} from "../src/validate.js";

const anchorIndex = buildAnchorIndex([
  {
    filename: "src/load.js",
    status: "modified",
    patch: ["@@ -10,2 +10,3 @@", " ctx", "+added", "+added2"].join("\n"),
  },
]);

const finding = (overrides = {}) => ({
  severity: "P1",
  title: "Enforce tenant scope",
  body: "Concrete failure scenario.",
  path: "src/load.js",
  line: 11,
  side: "RIGHT",
  rootCause: "missing tenant predicate",
  ...overrides,
});

const verify = (findings, options = {}) =>
  verifyFindings(
    { findings },
    { anchorIndex, existingRootCauses: new Set(), maxInline: 15, ...options }
  );

describe("verifyFindings", () => {
  it("keeps a well-formed, anchorable finding inline", () => {
    const { inline, nonInline, rejected } = verify([finding()]);
    assert.equal(inline.length, 1);
    assert.equal(nonInline.length + rejected.length, 0);
    assert.match(inline[0].fingerprint, /^[a-f\d]{16}$/);
  });

  it("demotes rather than drops a finding whose line is not in the diff", () => {
    // The observation may be right even when the line number is not, so it
    // still reaches the author — just in the summary.
    const { inline, nonInline } = verify([finding({ line: 900 })]);
    assert.equal(inline.length, 0);
    assert.equal(nonInline.length, 1);
    assert.match(nonInline[0].reason, /not in the current diff/);
  });

  it("rejects a path that escapes the repository", () => {
    for (const path of ["../../etc/passwd", "/etc/passwd", "a/../../b"]) {
      const { rejected } = verify([finding({ path })]);
      assert.equal(rejected.length, 1, `should reject ${path}`);
    }
  });

  it("rejects an unknown severity instead of publishing it", () => {
    const { rejected } = verify([finding({ severity: "CRITICAL" })]);
    assert.match(rejected[0].reason, /unknown severity/);
  });

  it("collapses two findings sharing a root cause in one file", () => {
    const { inline, rejected } = verify([finding(), finding({ line: 12 })]);
    assert.equal(inline.length, 1);
    assert.match(rejected[0].reason, /duplicate/);
  });

  it("skips a root cause already raised in an existing thread", () => {
    const existing = new Set([fingerprintOf("src/load.js", "missing tenant predicate")]);
    const { inline, rejected } = verify([finding()], { existingRootCauses: existing });
    assert.equal(inline.length, 0);
    assert.match(rejected[0].reason, /existing review thread/);
  });

  it("strips HTML comments so output cannot forge a fingerprint", () => {
    const { inline } = verify([
      finding({ body: "Real body <!-- pr-review-bot-fingerprint:deadbeef -->" }),
    ]);
    assert.equal(inline[0].body, "Real body");
  });

  it("moves the tail past the inline cap into non-inline", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      finding({ rootCause: `cause-${i}`, line: 11 })
    );
    const { inline, nonInline } = verify(many, { maxInline: 2 });
    assert.equal(inline.length, 2);
    assert.equal(nonInline.length, 3);
    assert.match(nonInline[0].reason, /2-comment limit/);
  });

  it("orders findings by severity", () => {
    const { inline } = verify([
      finding({ severity: "P3", rootCause: "c" }),
      finding({ severity: "P0", rootCause: "a" }),
      finding({ severity: "P2", rootCause: "b" }),
    ]);
    assert.deepEqual(inline.map((f) => f.severity), ["P0", "P2", "P3"]);
  });

  it("drops a backwards or unanchorable range without losing the finding", () => {
    const { inline } = verify([finding({ line: 11, startLine: 900 })]);
    assert.equal(inline.length, 1);
    assert.equal(inline[0].startLine, null);
  });
});

describe("parseAgentOutput", () => {
  it("unwraps the CLI envelope", () => {
    const stdout = JSON.stringify({
      result: JSON.stringify({ summary: "s", findings: [], coverage: { reviewed: "all" } }),
      total_cost_usd: 0.42,
    });
    const parsed = parseAgentOutput(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.usage.costUsd, 0.42);
  });

  it("survives a fenced result", () => {
    const stdout = JSON.stringify({
      result: '```json\n{"summary":"s","findings":[],"coverage":{"reviewed":"all"}}\n```',
    });
    assert.equal(parseAgentOutput(stdout).ok, true);
  });

  it("fails cleanly on truncated or non-JSON output", () => {
    assert.equal(parseAgentOutput("not json").ok, false);
    assert.equal(parseAgentOutput(JSON.stringify({ result: "{oops" })).ok, false);
  });

  it("surfaces an agent-reported error", () => {
    const parsed = parseAgentOutput(
      JSON.stringify({ is_error: true, result: "max turns exceeded" })
    );
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason, /max turns exceeded/);
  });
});

describe("selectEvent", () => {
  const none = { P0: 0, P1: 0, P2: 0, P3: 0 };

  it("requests changes for P0 or P1", () => {
    assert.equal(selectEvent({ counts: { ...none, P1: 1 } }).event, "REQUEST_CHANGES");
  });

  it("comments for P2 or P3 only", () => {
    assert.equal(selectEvent({ counts: { ...none, P2: 1 } }).event, "COMMENT");
  });

  it("never tries to approve or block your own pull request", () => {
    // GitHub 422s on self-review, which would lose the whole payload.
    const result = selectEvent({ counts: { ...none, P0: 3 }, isOwnPr: true });
    assert.equal(result.event, "COMMENT");
  });

  it("comments on a draft even when clean", () => {
    assert.equal(selectEvent({ counts: none, isDraft: true }).event, "COMMENT");
  });

  it("comments when coverage was incomplete", () => {
    assert.equal(selectEvent({ counts: none, coverageLimited: true }).event, "COMMENT");
  });

  it("approves only when clean, complete and green", () => {
    assert.equal(
      selectEvent({ counts: none, checks: { state: "success" } }).event,
      "APPROVE"
    );
  });
});
