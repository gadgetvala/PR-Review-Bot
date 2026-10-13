import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Node 20.12+ loads .env natively, so this app has zero runtime dependencies.
 * Real environment variables win over the file, which is what you want when
 * running one-off with `GITHUB_TOKEN=... node pr-review.js`.
 */
export function loadEnv() {
  const envPath = resolve(ROOT, ".env");
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export class ConfigError extends Error {}

/**
 * Resolved configuration, with the two credentials kept deliberately apart:
 * `githubToken` never leaves the host, `claudeToken` never leaves the
 * container. That split is the whole point of the sandbox — see README.
 */
export function loadConfig() {
  loadEnv();

  const githubToken = process.env.GITHUB_TOKEN?.trim();
  if (!githubToken) {
    throw new ConfigError(
      "GITHUB_TOKEN is not set. Create a token with `Pull requests: write` and put it in pr-review-bot/.env"
    );
  }

  // Subscription auth (Claude Max/Pro) via `claude setup-token`, or a plain
  // API key. Exactly one is needed; the token is preferred because it bills
  // against the subscription rather than API credits.
  const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!claudeToken && !anthropicKey) {
    throw new ConfigError(
      "No Claude credential. Run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN in .env (uses your Max plan), or set ANTHROPIC_API_KEY."
    );
  }

  // Optional. Half-configured is an error rather than silently no messages.
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const telegramChatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (Boolean(telegramToken) !== Boolean(telegramChatId)) {
    throw new ConfigError(
      "Telegram is half-configured. Set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or neither."
    );
  }

  return {
    githubToken,
    telegram: telegramToken ? { token: telegramToken, chatId: telegramChatId } : null,
    claudeToken,
    anthropicKey,
    // github.com or a GitHub Enterprise hostname. The API base differs between
    // the two, so it is derived rather than configured twice.
    githubHost: process.env.GITHUB_HOST?.trim() || "github.com",
    image: process.env.REVIEW_IMAGE?.trim() || "pr-review-agent:latest",
    model: process.env.REVIEW_MODEL?.trim() || "claude-opus-4-6",
    maxTurns: int(process.env.MAX_TURNS, 40),
    timeoutMs: int(process.env.CONTAINER_TIMEOUT_MS, 15 * 60 * 1000),
    memory: process.env.CONTAINER_MEMORY?.trim() || "4g",
    cpus: process.env.CONTAINER_CPUS?.trim() || "2",
    // §"Publishing inline comments": more than this floods the PR, so the rest
    // are summarized instead.
    maxInlineComments: int(process.env.MAX_INLINE_COMMENTS, 15),
    // Reviewing a big PR is expensive and rarely useful past a point.
    maxChangedFiles: int(process.env.MAX_CHANGED_FILES, 300),
  };
}

export const apiBaseFor = (host) =>
  host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
