# PR Review Bot

Sandboxed pull request reviews powered by Claude Code.

The review runs inside a disposable Docker container. Publishing happens on
your machine. The container holds the code and a Claude credential; the host
holds the GitHub credential. **Neither side ever holds both.**

- **Zero dependencies.** Node builtins only: no `npm install`, no `gh`.
- **Injection-resistant.** A malicious PR can at worst produce a bad suggestion
  in your terminal. It cannot post one.
- **Verified output.** Every finding is re-checked on the host against the diff
  GitHub returned before anything is published.
- **Idempotent.** Re-running on new commits never reposts existing findings.

```bash
node pr-review.js https://github.com/owner/repo/pull/123      # print only
node pr-review.js owner/repo#123 --publish                    # submit, asks first
node pr-review.js owner/repo#123 --publish --push             # submit, no prompts
node pr-review.js 123 --repo owner/name --run-tests           # also run its tests
```

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Options](#options)
- [How it works](#how-it-works)
- [Security model](#security-model)
- [Cost tracking](#cost-tracking)
- [Project layout](#project-layout)
- [Development](#development)

## Requirements

- Node.js **20.12+**
- A running Docker daemon
- A GitHub fine-grained token, and either a Claude Pro/Max subscription or an
  Anthropic API key

## Quick start

```bash
git clone https://github.com/gadgetvala/PR-Review-Bot.git
cd PR-Review-Bot
cp .env.example .env
claude setup-token        # bills your Claude Pro/Max plan, not API credits
```

Fill in `.env`:

| Variable | Lives on | How to get it |
| --- | --- | --- |
| `GITHUB_TOKEN` | host only | Fine-grained PAT, see [SETUP.md](SETUP.md) |
| `CLAUDE_CODE_OAUTH_TOKEN` | container only | `claude setup-token` |
| `ANTHROPIC_API_KEY` | container only | Alternative to the token above, billed to the API |
| `DEFAULT_REPO` | host | Optional; allows `node pr-review.js 123` |

Then run a print-only review:

```bash
node pr-review.js https://github.com/owner/repo/pull/1
```

The image builds itself on the first run (a few minutes), or ahead of time
with `npm run image`.

**[SETUP.md](SETUP.md)** covers token creation step by step, including the
organisation resource-owner trap, the approval flow, and troubleshooting.

<details>
<summary>Tuning variables</summary>

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_HOST` | `github.com` | GitHub Enterprise hostname |
| `REVIEW_IMAGE` | `pr-review-agent:latest` | Docker image tag |
| `REVIEW_MODEL` | `claude-opus-4-6` | Model used for the review |
| `MAX_TURNS` | `40` | Agent turn limit |
| `CONTAINER_TIMEOUT_MS` | `900000` | Hard stop for the container |
| `CONTAINER_MEMORY` | `4g` | Container memory limit |
| `CONTAINER_CPUS` | `2` | Container CPU limit |
| `MAX_INLINE_COMMENTS` | `15` | Beyond this, findings are summarized |
| `MAX_CHANGED_FILES` | `300` | Larger PRs are refused |

</details>

## Options

| Flag | Effect |
| --- | --- |
| `--publish` | Submit the review to GitHub. Default is print-only. |
| `--push` | With `--publish`: skip confirmation. If GitHub rejects inline anchors, post the summary alone instead of stopping. |
| `--yes` | Skip the confirmation only. An anchor rejection still stops the run. |
| `--repo owner/name` | Repository for a bare pull request number. |
| `--run-tests` | Let the agent run the repo's npm/pnpm/yarn/bun scripts in the sandbox. |
| `--summary-only` | Publish the summary without inline comments. |
| `--json <file>` | Also write the verified result as JSON. |
| `--log <file>` | CSV run log (default: `runs.csv` beside the script). |
| `--no-log` | Do not record this run. |
| `--stats` | Print totals from the run log and exit. |

## How it works

```
HOST                                  CONTAINER
GITHUB_TOKEN, your identity           CLAUDE_CODE_OAUTH_TOKEN, the code
never executes PR code                cannot reach GitHub, cannot publish

  fetch PR + clone ──── mount /work ────►  claude reviews
  publish review  ◄──── stdout JSON ────  findings
       │
       └── re-verifies every anchor against the diff GitHub returned
```

1. **Resolve** the target, check the token, and report which account the
   review will be posted as.
2. **Fetch** the PR, its files, existing reviews, inline threads and CI status.
3. **Clone** blobless at the head SHA, with the base fetched so merge-base
   resolves. The token is scrubbed from `.git/config` before mounting.
4. **Index** commentable lines from GitHub's own patches.
5. **Review** in Docker against `/work/repo`, with [`agent/spec.md`](agent/spec.md)
   as the system prompt and a JSON schema for the output.
6. **Verify** each finding on the host: the anchor exists in the diff, the path
   stays inside the repo, the severity is known, and the root cause is not
   already raised. Unanchorable findings become summary notes; none are dropped.
7. **Publish** with `--publish`: re-check the head SHA, then submit one review
   carrying all inline comments.

Findings are graded P0 to P3. Any surviving P0 or P1 requests changes.

## Security model

**Credential separation.** The container gets one credential (Claude) and one
mount (a throwaway workspace). It runs as a non-root user with all capabilities
dropped, `no-new-privileges`, and memory, CPU and PID limits. That is what makes
`--run-tests` safe: the review spec forbids executing PR code unless the
environment is disposable and credential-free, and this one is.

**Network access is not isolated.** The model API is remote, so the container
can reach the internet. The protection is the absence of credentials. For
arbitrary third-party code, add an egress allowlist for `api.anthropic.com`.

**PR content cannot set review policy.** Claude Code discovers `CLAUDE.md`
upward from its working directory, so the agent runs in `/work/review` and
reaches the code through `--add-dir`. Repository policy files are read from
the merge base with `git show`, never from the head.

**Reviews post as you.** GitHub forbids approving your own PR, so on your own
PRs the event downgrades to `COMMENT` instead of failing. A separate bot
identity needs a GitHub App token instead of a PAT.

**Moving machines.** Copy the folder, never `.env`. Recreate it on the target.

## Cost tracking

Every run appends a row to `runs.csv`: findings by severity, token usage,
duration and an estimated cost. `node pr-review.js --stats` prints the totals.
On a subscription token the cost is an API-equivalent estimate, not a charge.

## Project layout

```
pr-review.js        CLI: orchestration, confirmation, exit codes
agent/spec.md       review doctrine, sent as the system prompt
Dockerfile          the review sandbox
src/
  config.js         .env loading and validation
  target.js         URL / owner/repo#123 / bare number → target
  github.js         REST client over fetch; the only writer
  workspace.js      throwaway clone, credential scrub
  sandbox.js        docker run, limits, timeout
  diff.js           patch → commentable (path, line, side) set
  schema.js         container → host output contract
  prompt.js         task message and context.json
  validate.js       verification, dedupe, event selection
  render.js         review body
  publish.js        single-payload submit, head-SHA recheck
  runlog.js         runs.csv accounting
  ui.js             terminal output
```

## Development

```bash
npm test          # no network, no Docker
npm run image     # rebuild the sandbox image
```

The tests cover the parts that fail silently: hunk-offset arithmetic, path
traversal, anchor rejection, fingerprint dedupe, self-review downgrade, run-log
accounting and malformed agent output.

**Limitations.** `--run-tests` supports the Node ecosystem only. Other
languages are still reviewed, statically.
