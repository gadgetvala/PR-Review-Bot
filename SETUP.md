# Setup guide

Everything you need before the first review. Roughly 10 minutes, most of it
waiting for the Docker image to build.

Two credentials are involved and they never meet:

| Credential | Lives on | Used for |
| --- | --- | --- |
| `GITHUB_TOKEN` | your machine only | reading the PR, publishing the review |
| `CLAUDE_CODE_OAUTH_TOKEN` | inside the container only | running the review |

---

## Step 1 — Create the GitHub token

Use a **fine-grained** personal access token. It is scoped to specific
repositories and specific permissions, so a leaked token cannot touch anything
else you have access to.

### 1.1 Open the form

<https://github.com/settings/personal-access-tokens/new>

Or navigate: your avatar → **Settings** → **Developer settings** (very bottom of
the left sidebar) → **Personal access tokens** → **Fine-grained tokens** →
**Generate new token**.

### 1.2 Name and expiry

| Field | Value |
| --- | --- |
| **Token name** | `pr-review-bot` |
| **Expiration** | 90 days is a reasonable default |
| **Description** | `Local PR review agent` |

GitHub emails you before a fine-grained token expires. When it does, repeat
this step and replace the value in `.env` — nothing else changes.

### 1.3 Resource owner — the step people get wrong

**Resource owner** decides which account's repositories the token can reach.

- Reviewing **your own** repos → leave it as your username.
- Reviewing **organisation** repos → pick the organisation.

If you pick your username but the repository belongs to the org, the token will
authenticate fine and then return **404 on every pull request** — GitHub does
not distinguish "does not exist" from "you cannot see it". That is the single
most common failure here.

> **Org tokens usually need approval.** When the resource owner is an
> organisation, the token is created in a *pending* state and an org owner must
> approve it under **Organisation settings → Personal access tokens → Pending
> requests**. Until then every call returns 403. If the org has fine-grained
> tokens disabled entirely, skip to [Step 1.6](#16-fallback-classic-token).

### 1.4 Repository access

Choose **Only select repositories**, then pick the repos you will review.

Avoid "All repositories" — the point of a fine-grained token is that this one
can only do one job.

### 1.5 Permissions

Expand **Repository permissions** and set exactly these four. Everything else
stays **No access**.

| Permission | Access | Why the bot needs it |
| --- | --- | --- |
| **Metadata** | Read-only | Mandatory. GitHub selects it automatically once you set any other repo permission. |
| **Contents** | Read-only | `git clone` of the PR branch into the sandbox. |
| **Pull requests** | **Read and write** | Read the diff, files, existing reviews and inline threads — and submit the review. This is the only write in the whole tool. |
| **Commit statuses** | Read-only | Reads CI state so the review can mention failing checks instead of guessing. |

The bot never pushes, never merges, never edits labels or issues. It does not
ask for `Administration`, `Actions`, `Workflows`, `Secrets` or any account
permission, and it will not work any better if you grant them.

Click **Generate token** and copy the value — it starts with `github_pat_` and
**GitHub shows it once**. If you lose it, regenerate.

### 1.6 Fallback: classic token

Only if your org has fine-grained tokens disabled.

<https://github.com/settings/tokens/new> → tick the single scope **`repo`**,
generate, copy.

A classic `repo` token grants read *and write* to every repository you can
reach, which is much broader than this tool needs. Prefer fine-grained.

> **SAML SSO:** if your org enforces it, a classic token additionally needs
> authorising. On the token list page, click **Configure SSO** next to the
> token and **Authorize** for the org. Skip this and every call returns 403
> with a message about SAML.

---

## Step 2 — Create the Claude token

This is what lets the review bill against your **Claude Max/Pro subscription**
instead of API credits.

```bash
claude setup-token
```

It opens a browser, you approve, and it prints a long-lived token. Copy it.

No Claude subscription? Use an API key from
<https://console.anthropic.com/settings/keys> instead and set
`ANTHROPIC_API_KEY`. Only one of the two is needed.

---

## Step 3 — Fill in `.env`

```bash
cd PR-Review-Bot
cp .env.example .env
```

Open `.env` and set three values:

```ini
GITHUB_TOKEN=github_pat_11ABC...
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
DEFAULT_REPO=your-org/your-repo
```

`DEFAULT_REPO` is optional — it lets you type `node pr-review.js 123` instead
of the full URL.

`.env` is already in `.gitignore` and `.dockerignore`. Never commit it.

---

## Step 4 — Check it works

```bash
node pr-review.js https://github.com/your-org/your-repo/pull/1
```

The first two lines tell you whether the token is good:

```
✓ Checking GitHub access 0.4s
  reviewing as your-username
```

That confirms the token authenticates and shows **whose name the review will
be posted under**. Nothing has been published — publishing needs `--publish`
and a confirmation (or `--publish --push` to skip it, e.g. from CI).

The first run also builds the Docker image, which takes a few minutes. Later
runs skip it.

---

## Troubleshooting

| What you see | What it means |
| --- | --- |
| `GitHub rejected the token (401)` | Wrong or truncated value in `.env`. Copy it again — it is shown only once. |
| `Not found (404)` on a PR you can open in the browser | Resource owner is wrong (Step 1.3), or the repo was not selected in Step 1.4. |
| `GitHub refused the request (403)` | Org approval still pending, or SAML SSO not authorised, or `Pull requests` is Read-only instead of Read and write. |
| `Docker is not running` | Start Docker Desktop. |
| `No Claude credential` | `CLAUDE_CODE_OAUTH_TOKEN` is empty. Re-run `claude setup-token`. |
| `OAuth access token is invalid` | The Claude token expired or was pasted wrong. Re-run `claude setup-token`. |
| `head moved ... during the review` | Someone pushed while the review ran. Re-run — this guard exists so comments never land on the wrong lines. |

### Confirm the token's permissions directly

```bash
curl -sS -I -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/your-org/your-repo/pulls/1 | head -1
```

`HTTP/2 200` means read access is fine. `404` means the token cannot see the
repo (Step 1.3). `401` means the token itself is wrong.

---

## Rotating or revoking

Revoke at any time at
<https://github.com/settings/personal-access-tokens> — click the token,
then **Delete**. The bot stops working immediately; nothing else is affected.

Same for the Claude token: `claude setup-token` again replaces it, and old
tokens can be revoked from your Anthropic account settings.
