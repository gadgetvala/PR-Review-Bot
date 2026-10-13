import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export class WorkspaceError extends Error {}

/** Read from the base revision by the review spec, so they must be local. */
const POLICY_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"];

/**
 * A throwaway checkout of the pull request, plus everything the agent needs to
 * review it, laid out for mounting into the container:
 *
 *   <root>/repo/          the code at the head SHA, with base fetched too
 *   <root>/review/spec.md      the review instructions
 *   <root>/review/task.md      target, SHAs and mode
 *   <root>/review/context.json PR metadata, prior reviews, anchor index
 *   <root>/out/                where the agent writes findings.json
 *
 * `out` is the only path the host reads back, and it is validated before use.
 */
export class Workspace {
  constructor(root) {
    this.root = root;
    this.repo = join(root, "repo");
    this.review = join(root, "review");
    this.out = join(root, "out");
  }

  static async create() {
    const root = await mkdtemp(join(tmpdir(), "pr-review-"));
    const workspace = new Workspace(root);
    await mkdir(workspace.review, { recursive: true });
    await mkdir(workspace.out, { recursive: true });
    return workspace;
  }

  /**
   * Clones at the head SHA and fetches the base so merge-base is resolvable.
   *
   * The token is used for the fetch and then scrubbed from the remote URL:
   * this directory is about to be mounted into a container running untrusted
   * code, and a credential in .git/config would be trivially readable there.
   */
  async checkout({ host, slug, headSha, baseSha, token }) {
    const remote = `https://${host}/${slug}.git`;
    const authenticated = `https://x-access-token:${token}@${host}/${slug}.git`;

    await this.#git(["init", "--quiet", this.repo], { cwd: this.root });
    await this.#git(["remote", "add", "origin", authenticated]);

    // Blobless partial clone: full history for merge-base, file contents only
    // when actually read. On a large monorepo this is the difference between
    // seconds and minutes.
    try {
      await this.#git([
        "fetch",
        "--quiet",
        "--filter=blob:none",
        "--no-tags",
        "origin",
        headSha,
        baseSha,
      ]);
    } catch (cause) {
      throw new WorkspaceError(
        `Could not fetch ${slug} at ${headSha.slice(0, 7)}: ${cause.stderr || cause.message}`
      );
    }

    await this.#git(["checkout", "--quiet", "--detach", headSha]);

    const mergeBase = (
      await this.#git(["merge-base", baseSha, headSha])
    ).stdout.trim();

    if (!mergeBase) {
      throw new WorkspaceError(
        `No merge base between ${baseSha.slice(0, 7)} and ${headSha.slice(0, 7)}. Unrelated histories?`
      );
    }

    await this.#materializeBlobs(mergeBase, headSha);

    // Credential scrub, only now that every blob the review needs is local.
    await this.#git(["remote", "set-url", "origin", remote]);

    return mergeBase;
  }

  /**
   * Pulls down the blobs the review will read, while the token still works.
   *
   * `--filter=blob:none` defers blob downloads until something reads them, and
   * the container has neither a credential nor a network path to GitHub. So
   * anything not materialized here fails inside the sandbox with "could not
   * fetch ... from promisor remote". The agent then reviews the head revision
   * with no base to compare against and reports it as a coverage limitation —
   * which is worse than a hard failure, because a quietly degraded review
   * looks exactly like a good one.
   *
   * `--stat` rather than a plain diff: it has to read both sides of every
   * changed file to count lines, so it materializes the same blobs while
   * producing a few KB of output instead of megabytes. `--quiet` would not
   * work at all — it short-circuits on the first difference it finds.
   */
  async #materializeBlobs(mergeBase, headSha) {
    await this.#git([
      "diff",
      "--stat",
      "--find-renames",
      mergeBase,
      headSha,
    ]).catch(() => {});

    // The review spec reads repository policy from the base revision, never
    // from the head. These are small and usually absent; failure is fine.
    await Promise.all(
      POLICY_FILES.map((file) =>
        this.#git(["show", `${mergeBase}:${file}`]).catch(() => {})
      )
    );
  }

  async writeReviewInputs({ spec, task, context }) {
    await Promise.all([
      writeFile(join(this.review, "spec.md"), spec, "utf8"),
      writeFile(join(this.review, "task.md"), task, "utf8"),
      writeFile(
        join(this.review, "context.json"),
        JSON.stringify(context, null, 2),
        "utf8"
      ),
    ]);
  }

  /** The agent's only output channel. Absent or malformed means "no result". */
  async readFindings() {
    const path = join(this.out, "findings.json");
    let raw;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return { ok: false, reason: "The agent did not write out/findings.json" };
    }
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch (cause) {
      return {
        ok: false,
        reason: `out/findings.json is not valid JSON: ${cause.message}`,
        raw: raw.slice(0, 2000),
      };
    }
  }

  async destroy() {
    await rm(this.root, { recursive: true, force: true, maxRetries: 3 });
  }

  #git(args, { cwd = this.repo } = {}) {
    return run("git", args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        // Never let a stuck credential helper turn a fetch into a hung prompt.
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "echo",
        GCM_INTERACTIVE: "never",
      },
    });
  }
}
