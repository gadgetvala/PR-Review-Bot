#!/usr/bin/env node
/**
 * Watch mode: polls WATCH_REPOS every minute and reviews each open pull request
 * whose head commit has no review from this account yet, several at a time.
 *
 * Each review is a child `pr-review.js --publish --push`, so watch mode gets
 * the exact sandbox, verification and publish path of a manual run. GitHub is
 * the state store: "reviewed" means a review by this account on the current
 * head SHA, which survives restarts without a local database.
 *
 *   WATCH_REPOS=owner/repo,owner/other node watch.js
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

import { ConfigError, loadConfig, ROOT } from "./src/config.js";
import { GitHub } from "./src/github.js";
import { assertDockerReady, ensureImage } from "./src/sandbox.js";
import { parseRepo } from "./src/target.js";
import { dim, fail, say, warn } from "./src/ui.js";

// ponytail: fixed interval; 60 list calls/hour/repo is well inside GitHub's 5000.
const INTERVAL_MS = 60_000;

const running = new Set(); // "owner/repo#12"
// Head SHA last attempted per PR. A failed review is not retried until the
// PR gets a new commit or the watcher restarts, so a broken token or an
// oversized PR cannot burn usage every minute.
const attempted = new Map();

const log = (key, message) => say(`${new Date().toISOString()} ${key} ${message}`);

async function main() {
  const config = loadConfig();
  const repos = (process.env.WATCH_REPOS ?? "")
    .split(",")
    .filter((entry) => entry.trim())
    .map((entry) => parseRepo(entry, { defaultHost: config.githubHost }));
  if (repos.length === 0) {
    throw new ConfigError("WATCH_REPOS is empty. Set it to owner/repo[,owner/repo...] in .env");
  }
  // Each review holds a container with CONTAINER_MEMORY and CONTAINER_CPUS.
  const concurrency = Math.max(1, Number.parseInt(process.env.WATCH_CONCURRENCY, 10) || 2);

  await assertDockerReady();
  // Built once up front, so concurrent first reviews do not race to build it.
  await ensureImage(config.image, {
    onBuild: (image) => warn(`Building ${image}, first run only.`),
  });

  const clients = new Map();
  const clientFor = (host) => {
    if (!clients.has(host)) {
      clients.set(host, new GitHub({ token: config.githubToken, host }));
    }
    return clients.get(host);
  };
  const { login } = await clientFor(repos[0].host).viewer();

  say(
    `Watching ${repos.map((r) => r.slug).join(", ")} as ${login}, ` +
      `${concurrency} at a time, every ${INTERVAL_MS / 1000}s. ${dim("Ctrl+C to stop.")}`
  );

  for (;;) {
    for (const repo of repos) {
      await poll(repo, clientFor(repo.host), login, concurrency).catch((error) =>
        fail(`${repo.slug}: ${error.message}`)
      );
    }
    await sleep(INTERVAL_MS);
  }
}

async function poll(repo, github, login, concurrency) {
  const open = await github.paginate(`/repos/${repo.slug}/pulls?state=open`);

  for (const pr of open) {
    if (running.size >= concurrency) {
      return; // the rest are picked up on a later poll
    }
    const key = `${repo.slug}#${pr.number}`;
    if (pr.draft || running.has(key) || attempted.get(key) === pr.head.sha) {
      continue;
    }

    const reviews = await github.reviews({ slug: repo.slug, number: pr.number });
    attempted.set(key, pr.head.sha);
    if (!reviews.some((r) => r.user?.login === login && r.commit_id === pr.head.sha)) {
      review(key, pr);
    }
  }
}

function review(key, pr) {
  running.add(key);
  log(key, `reviewing ${pr.head.sha.slice(0, 7)} "${pr.title}"`);

  const child = spawn(
    process.execPath,
    [join(ROOT, "pr-review.js"), pr.html_url, "--publish", "--push"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  // Prefixed so concurrent reviews stay readable in one stream.
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => log(key, dim(line)));
  }

  child.on("close", (code) => {
    running.delete(key);
    log(key, code === 0 ? "done" : `failed (exit ${code}), retried on the next commit`);
  });
}

try {
  await main();
} catch (error) {
  fail(error.message ?? String(error));
  process.exitCode = 1;
}
