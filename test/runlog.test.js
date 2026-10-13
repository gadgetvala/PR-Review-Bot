import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { appendRun, summarize } from "../src/runlog.js";

const entry = (over = {}) => ({
  timestamp: "2026-08-20T10:00:00.000Z",
  target: { slug: "acme/web", number: 7 },
  snapshot: { url: "https://github.com/acme/web/pull/7", headSha: "abcdef1234567890" },
  event: "COMMENT",
  published: false,
  counts: { P0: 0, P1: 1, P2: 2, P3: 0 },
  inlineCount: 3,
  nonInlineCount: 0,
  usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, tokens: 100, costUsd: 0.5, turns: 4, durationMs: 1500 },
  billing: "subscription",
  model: "claude-opus-4-6",
  ...over,
});

const tmpLog = async () => join(await mkdtemp(join(tmpdir(), "runlog-")), "runs.csv");

describe("run log", () => {
  it("writes a header once, then one row per run", async () => {
    const path = await tmpLog();
    await appendRun(path, entry());
    await appendRun(path, entry({ published: true }));

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 3, "header + two rows");
    assert.ok(lines[0].startsWith("timestamp,repo,pr,"));
    assert.equal(lines.filter((l) => l.startsWith("timestamp,")).length, 1);
  });

  it("survives a title or URL containing a comma or a quote", async () => {
    const path = await tmpLog();
    await appendRun(path, entry({ snapshot: { url: 'https://x/y?a=1,2&q="hi"', headSha: "abc123def456" } }));
    const stats = await summarize(path);
    // Round-trips: a naive split(",") reader would report the wrong column count.
    assert.equal(stats.runs, 1);
    assert.equal(stats.tokens, 100);
  });

  it("totals tokens and separates subscription runs from charged ones", async () => {
    const path = await tmpLog();
    await appendRun(path, entry());
    await appendRun(path, entry({ billing: "api" }));

    const stats = await summarize(path);
    assert.equal(stats.runs, 2);
    assert.equal(stats.tokens, 200);
    assert.equal(stats.estUsd, 1);
    assert.equal(stats.subscriptionRuns, 1, "one run was charged, one was not");
    assert.deepEqual(stats.findings, { P0: 0, P1: 2, P2: 4, P3: 0 });
  });

  it("reports nothing rather than throwing when there is no log yet", async () => {
    assert.equal(await summarize(join(tmpdir(), "does-not-exist-runs.csv")), null);
  });

  it("never fails the run when the log cannot be written", async () => {
    // A spreadsheet holding the file open must not turn a good review into a
    // failed one.
    const result = await appendRun("/proc/nonexistent/runs.csv", entry());
    assert.equal(result.logged, false);
    assert.ok(result.reason);
  });
});
