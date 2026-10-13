#!/usr/bin/env node
/**
 * Sandboxed pull request review.
 *
 * The review runs inside Docker with the code and a Claude credential; the
 * publish runs on the host with a GitHub credential. Neither side holds both.
 * A prompt-injected agent can therefore produce a bad suggestion, but it
 * cannot post one — the host re-verifies every finding against the diff GitHub
 * itself returned before anything is written.
 *
 *   node pr-review.js https://github.com/owner/repo/pull/123
 *   node pr-review.js owner/repo#123 --publish
 *   node pr-review.js owner/repo#123 --publish --push   # no confirmation
 *   node pr-review.js 123 --repo owner/name --run-tests
 */

import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { join } from "node:path";

import { ConfigError, loadConfig } from "./src/config.js";
import { buildAnchorIndex } from "./src/diff.js";
import { GitHub } from "./src/github.js";
import { buildContext, buildTask, extractRootCause } from "./src/prompt.js";
import { publishReview, publishSummaryOnly } from "./src/publish.js";
import { assessMergeability, renderReview } from "./src/render.js";
import { appendRun, DEFAULT_LOG, summarize } from "./src/runlog.js";
import { assertDockerReady, ensureImage, runAgent } from "./src/sandbox.js";
import { FINDINGS_SCHEMA } from "./src/schema.js";
import { parseTarget, TargetError } from "./src/target.js";
import { bold, cyan, dim, fail, green, printFindings, say, step, warn, yellow } from "./src/ui.js";
import { fingerprintOf, parseAgentOutput, selectEvent, verifyFindings } from "./src/validate.js";
import { readFile } from "node:fs/promises";
import { ROOT } from "./src/config.js";
import { Workspace } from "./src/workspace.js";

const USAGE = `
${bold("pr-review")} — sandboxed pull request review

  node pr-review.js <pull-request> [options]

${bold("Pull request")}
  https://github.com/owner/repo/pull/123
  owner/repo#123
  123                        with --repo owner/name or DEFAULT_REPO

${bold("Options")}
  --publish                  submit the review to GitHub (default: print only)
  --push                     with --publish: push without asking; if inline
                             anchors are rejected, post the summary alone
  --repo <owner/name>        repository for a bare pull request number
  --run-tests                let the agent run the repo's scripts in the sandbox
  --summary-only             publish the summary without inline comments
  --json <file>              also write the verified result as JSON
  --yes                      skip the confirmation prompt when publishing
  --log <file>               CSV run log (default: runs.csv beside this file)
  --no-log                   do not record this run
  --stats                    print totals from the run log and exit
  --help
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      publish: { type: "boolean", default: false },
      push: { type: "boolean", default: false },
      repo: { type: "string" },
      "run-tests": { type: "boolean", default: false },
      log: { type: "string" },
      "no-log": { type: "boolean", default: false },
      stats: { type: "boolean", default: false },
      "summary-only": { type: "boolean", default: false },
      json: { type: "string" },
      yes: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const logPath = values.log ?? DEFAULT_LOG;

  if (values.push && !values.publish) {
    fail("--push only makes sense with --publish.");
    return 1;
  }
  // --push is the unattended path: no prompt, and nothing left half-done.
  const unattended = values.push || values.yes;

  if (values.stats) {
    return printStats(logPath);
  }

  if (values.help || positionals.length === 0) {
    say(USAGE);
    return positionals.length === 0 && !values.help ? 1 : 0;
  }

  const config = loadConfig();
  const target = parseTarget(positionals[0], {
    defaultRepo: values.repo ?? process.env.DEFAULT_REPO,
    defaultHost: config.githubHost,
  });

  // Which credential the container will use decides whether `total_cost_usd`
  // is money or an API-equivalent estimate.
  const billing = config.claudeToken ? "subscription" : "api";

  const github = new GitHub({ token: config.githubToken, host: target.host });

  const viewer = await step("Checking GitHub access", () => github.viewer());
  say(`  ${dim(`reviewing as ${viewer.login}`)}`);

  const snapshot = await step(`Loading ${target.slug}#${target.number}`, async () => {
    const pr = await github.pullRequest(target);

    if (pr.state !== "open") {
      throw new Error(`Pull request is ${pr.state}. Only open pull requests can be reviewed.`);
    }
    if (pr.changed_files > config.maxChangedFiles) {
      throw new Error(
        `${pr.changed_files} changed files exceeds MAX_CHANGED_FILES (${config.maxChangedFiles}).`
      );
    }

    const [files, reviews, comments, checks] = await Promise.all([
      github.files(target, config.maxChangedFiles),
      github.reviews(target),
      github.reviewComments(target),
      github.checks(target, pr.head.sha),
    ]);

    return { pr, files, reviews, comments, checks };
  });

  const { pr, files, reviews, comments, checks } = snapshot;

  if (files.length === 0) {
    warn("This pull request changes nothing. Nothing to review.");
    return 0;
  }

  say(
    `  ${dim(`${files.length} files, +${pr.additions}/-${pr.deletions}, ${pr.draft ? "draft" : "ready"}`)}`
  );

  await step("Checking Docker", assertDockerReady);
  await ensureImage(config.image, {
    onBuild: (image) => warn(`Building ${image} — first run only, this takes a few minutes.`),
  });

  const workspace = await Workspace.create();
  let exitCode = 0;

  try {
    const mergeBase = await step("Fetching the pull request", () =>
      workspace.checkout({
        host: target.host,
        slug: target.slug,
        headSha: pr.head.sha,
        baseSha: pr.base.sha,
        token: config.githubToken,
      })
    );

    const review = {
      title: pr.title,
      changedFiles: pr.changed_files,
      url: pr.html_url,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      mergeBase,
      isDraft: pr.draft,
      checks,
    };

    const anchorIndex = buildAnchorIndex(files);

    await workspace.writeReviewInputs({
      spec: await readFile(join(ROOT, "agent", "spec.md"), "utf8"),
      task: buildTask({
        target,
        snapshot: review,
        allowExecution: values["run-tests"],
      }),
      context: buildContext({ pr, files, reviews, comments, checks, anchorIndex }),
    });
    await writeFile(
      join(workspace.review, "schema.json"),
      JSON.stringify(FINDINGS_SCHEMA),
      "utf8"
    );

    if (values["run-tests"]) {
      warn("Test execution enabled. The sandbox holds no GitHub or cloud credential.");
    }

    const { stdout } = await step("Reviewing in the sandbox", () =>
      runAgent({
        workspace,
        config,
        allowExecution: values["run-tests"],
        onLog: () => {},
      })
    );

    const parsed = parseAgentOutput(stdout);
    if (!parsed.ok) {
      fail(parsed.reason);
      return 1;
    }

    // Root causes already raised by anyone, so a re-run does not repost them.
    const existingRootCauses = new Set(
      comments
        .map((comment) => extractRootCause(comment.body))
        .filter(Boolean)
        .map((rootCause) => rootCause)
    );

    const verified = verifyFindings(parsed.value, {
      anchorIndex,
      existingRootCauses,
      maxInline: config.maxInlineComments,
    });

    const { event, reason } = selectEvent({
      counts: verified.counts,
      coverageLimited: Boolean(parsed.value.coverage?.limited),
      isDraft: pr.draft,
      isOwnPr: pr.user?.login === viewer.login,
      checks,
    });

    printFindings(verified);

    const body = renderReview({
      result: parsed.value,
      inline: verified.inline,
      nonInline: verified.nonInline,
      event,
      snapshot: review,
      usage: parsed.usage,
      mergeability: assessMergeability({
        pr,
        files,
        checks,
        counts: verified.counts,
      }),
    });

    say(`\n${bold("Event")}: ${event} ${dim(`(${reason})`)}`);
    say(dim(describeUsage(parsed.usage, billing)));

    if (values.json) {
      await writeFile(
        values.json,
        JSON.stringify({ target, snapshot: review, event, ...verified, body }, null, 2),
        "utf8"
      );
      say(dim(`Wrote ${values.json}`));
    }

    const record = async (published) => {
      if (values["no-log"]) {
        return;
      }
      const { logged, reason } = await appendRun(logPath, {
        timestamp: new Date().toISOString(),
        target,
        snapshot: review,
        event,
        published,
        counts: verified.counts,
        inlineCount: verified.inline.length,
        nonInlineCount: verified.nonInline.length,
        usage: parsed.usage,
        billing,
        model: config.model,
      });
      if (!logged) {
        warn(`Could not write the run log: ${reason}`);
      }
    };

    if (!values.publish) {
      await record(false);
      say(
        `\n${cyan("Not published.")} ${dim(`Re-run with --publish to submit as ${viewer.login}.`)}`
      );
      return 0;
    }

    if (!unattended && !(await confirm(event, verified.inline.length, pr.html_url))) {
      await record(false);
      say(dim("Cancelled."));
      return 0;
    }

    let result = values["summary-only"]
      ? await publishSummaryOnly({ github, target, snapshot: review, body, event })
      : await publishReview({
          github,
          target,
          snapshot: review,
          body,
          inline: verified.inline,
          event,
        });

    // Nobody is watching a --push run, so take the fallback ourselves instead
    // of printing "re-run with --summary-only" to an empty terminal.
    if (!result.published && result.recoverable && values.push) {
      warn(`Inline comments rejected by GitHub; posting the summary alone.\n${result.reason.split("\n")[0]}`);
      result = await publishSummaryOnly({ github, target, snapshot: review, body, event });
    }

    await record(result.published);

    if (!result.published) {
      fail(`Not published: ${result.reason}`);
      return 1;
    }

    say(`\n${green("Review published.")}`);
    say(`  ${result.url}`);
    say(dim(`  ${result.state} · ${result.commentCount} inline comment(s)`));
  } finally {
    await workspace.destroy();
  }

  return exitCode;
}

/**
 * On a subscription token the CLI's `total_cost_usd` is an API-equivalent
 * estimate — nothing is charged, the run counts against the plan's usage
 * limits instead. Printing it as "Cost: $1.35" would be simply wrong.
 */
function describeUsage(usage, billing) {
  if (!usage) {
    return "";
  }
  const tokens = usage.tokens ? `${usage.tokens.toLocaleString()} tokens` : "";
  const turns = usage.turns ? `${usage.turns} turns` : "";
  const seconds = usage.durationMs ? `${(usage.durationMs / 1000).toFixed(0)}s` : "";
  const money =
    usage.costUsd == null
      ? ""
      : billing === "subscription"
        ? `~$${usage.costUsd.toFixed(2)} API-equivalent (billed to your plan's usage limits, not charged)`
        : `$${usage.costUsd.toFixed(2)} charged to your API account`;

  return [tokens, turns, seconds, money].filter(Boolean).join(" · ");
}

async function printStats(logPath) {
  const stats = await summarize(logPath);
  if (!stats) {
    say(dim(`No runs recorded yet in ${logPath}`));
    return 0;
  }
  const { findings } = stats;
  say(`${bold("Run log")} ${dim(logPath)}`);
  say(`  Runs           ${stats.runs} (${stats.published} published) across ${stats.repos} repo(s)`);
  say(`  Findings       P0 ${findings.P0} · P1 ${findings.P1} · P2 ${findings.P2} · P3 ${findings.P3}`);
  say(`  Tokens         ${stats.tokens.toLocaleString()}`);
  say(
    `  API-equivalent ~$${stats.estUsd.toFixed(2)} ${dim(
      stats.subscriptionRuns === stats.runs
        ? "(all runs on a subscription — nothing charged)"
        : `(${stats.runs - stats.subscriptionRuns} run(s) on an API key were charged)`
    )}`
  );
  say(`  Period         ${stats.first?.slice(0, 10)} to ${stats.last?.slice(0, 10)}`);
  return 0;
}

async function confirm(event, count, url) {
  if (!process.stdin.isTTY) {
    // Non-interactive without --yes: refuse rather than guess. Publishing is
    // visible to the whole team and cannot be quietly undone.
    fail("Refusing to publish non-interactively without --yes.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `\n${yellow("Publish")} ${event} with ${count} inline comment(s) to ${url}? [y/N] `
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof ConfigError || error instanceof TargetError) {
    fail(error.message);
  } else {
    fail(error.message ?? String(error));
    if (process.env.DEBUG) {
      console.error(error);
    }
  }
  process.exitCode = 1;
}
