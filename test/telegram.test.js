import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  failedMessage,
  finishedMessage,
  mergedMessage,
  redact,
  startedMessage,
} from "../src/telegram.js";

const pr = {
  number: 12,
  title: "feat(api): add <script> & things",
  html_url: "https://github.com/acme/web/pull/12",
  user: { login: "dev" },
  base: { ref: "main", repo: { full_name: "acme/web" } },
  head: { ref: "feature" },
  changed_files: 3,
  additions: 10,
  deletions: 2,
};

describe("telegram messages", () => {
  it("escapes HTML and splits the conventional-commit tag", () => {
    const text = startedMessage(pr);
    assert.match(text, /<code>feat\(api\)<\/code>/);
    assert.match(text, /add &lt;script&gt; &amp; things/);
    assert.doesNotMatch(text, /<script>/);
  });

  it("counts P0 and P1 together as critical, and totals every severity", () => {
    const text = finishedMessage({
      pr,
      counts: { P0: 1, P1: 1, P2: 2, P3: 1 },
      event: "REQUEST_CHANGES",
      published: true,
      reviewUrl: "https://github.com/acme/web/pull/12#pullrequestreview-1",
      inline: 4,
      seconds: 125,
    });
    assert.match(text, /Critical\s+2/);
    assert.match(text, /Medium\s+2/);
    assert.match(text, /Minor\s+1/);
    assert.match(text, /Total\s+5/);
    assert.match(text, /Changes requested · 4 inline comments/);
    assert.match(text, /2m 5s/);
    assert.match(text, /View Review/);
  });

  it("links the pull request when the review was not published", () => {
    const text = finishedMessage({
      pr,
      counts: { P0: 0, P1: 0, P2: 0, P3: 0 },
      event: "APPROVE",
      published: false,
      inline: 0,
      seconds: 5,
    });
    assert.match(text, /Not published/);
    assert.match(text, /href="https:\/\/github\.com\/acme\/web\/pull\/12"/);
  });

  it("reports a failure that happened before the pull request loaded", () => {
    const text = failedMessage({
      target: { host: "github.com", slug: "acme/web", number: 7 },
      pr: null,
      error: "Not found (404)",
    });
    assert.match(text, /Review Failed/);
    assert.match(text, /#7/);
    assert.match(text, /https:\/\/github\.com\/acme\/web\/pull\/7/);
  });

  it("names who merged the pull request", () => {
    const text = mergedMessage({ ...pr, merged_by: { login: "lead" } });
    assert.match(text, /Pull Request Merged/);
    assert.match(text, /merged by lead/);
    assert.match(text, /feature → main/);
  });
});

describe("redact", () => {
  it("removes known secrets and any token embedded in a git URL", () => {
    const out = redact(
      "fatal: https://x-access-token:ghp_unknownvalue@github.com/a/b.git and sk-ant-oat01-secretvalue",
      ["sk-ant-oat01-secretvalue", undefined, "short"]
    );
    assert.doesNotMatch(out, /ghp_unknownvalue|secretvalue/);
    assert.match(out, /x-access-token:\*\*\*@github\.com/);
  });
});
