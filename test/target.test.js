import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseRepo, parseTarget, TargetError } from "../src/target.js";

describe("parseTarget", () => {
  it("reads a pull request URL, including a sub-page", () => {
    for (const url of [
      "https://github.com/acme/web/pull/123",
      "https://github.com/acme/web/pull/123/files",
      "https://github.com/acme/web/pull/123#discussion_r1",
    ]) {
      assert.deepEqual(parseTarget(url), {
        host: "github.com",
        owner: "acme",
        repo: "web",
        number: 123,
        slug: "acme/web",
      });
    }
  });

  it("keeps the host from an enterprise URL", () => {
    assert.equal(parseTarget("https://git.corp.io/acme/web/pull/9").host, "git.corp.io");
  });

  it("reads owner/repo#123 and owner/repo/123", () => {
    for (const input of ["acme/web#123", "acme/web/123"]) {
      assert.equal(parseTarget(input).slug, "acme/web");
      assert.equal(parseTarget(input).number, 123);
    }
  });

  it("resolves a bare number against a default repo", () => {
    assert.equal(parseTarget("7", { defaultRepo: "acme/web" }).slug, "acme/web");
  });

  it("refuses a bare number with nowhere to resolve it", () => {
    assert.throws(() => parseTarget("7"), TargetError);
  });

  it("rejects lookalike URLs rather than reviewing the wrong thing", () => {
    // /issues and /pulls are the two most common paste mistakes.
    assert.throws(() => parseTarget("https://github.com/acme/web/issues/1"), TargetError);
    assert.throws(() => parseTarget("https://github.com/acme/web/pulls"), TargetError);
    assert.throws(() => parseTarget("https://github.com/acme/web"), TargetError);
  });

  it("rejects owner and repo values that could escape a URL or a git command", () => {
    for (const bad of [
      "https://github.com/../../etc/pull/1",
      "https://github.com/acme/../pull/1",
      "-oProxyCommand/web#1",
      "acme/we b#1",
    ]) {
      assert.throws(() => parseTarget(bad), TargetError, `should reject ${bad}`);
    }
  });

  it("rejects zero, negative and non-numeric pull request numbers", () => {
    assert.throws(() => parseTarget("acme/web#0"), TargetError);
    assert.throws(() => parseTarget("acme/web#-1"), TargetError);
    assert.throws(() => parseTarget(""), TargetError);
  });
});

describe("parseRepo", () => {
  it("reads owner/repo and repository URLs", () => {
    assert.equal(parseRepo("acme/web").slug, "acme/web");
    assert.equal(parseRepo("https://github.com/acme/web.git").slug, "acme/web");
    assert.equal(parseRepo("https://git.corp.io/acme/web/").host, "git.corp.io");
  });

  it("rejects pull request URLs and malformed input", () => {
    for (const bad of ["acme", "acme/web/pull/1", "https://github.com/acme/web/pull/1", "a b/web", ""]) {
      assert.throws(() => parseRepo(bad), TargetError, `should reject ${bad}`);
    }
  });
});
