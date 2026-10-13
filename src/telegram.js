/**
 * Optional Telegram notifications: review started, finished, failed, and pull
 * request merged (watch mode). Enabled only when TELEGRAM_BOT_TOKEN and
 * TELEGRAM_CHAT_ID are both set.
 *
 * A notification never decides whether a review succeeds: send failures are
 * reported to the caller as a reason string, not thrown.
 */

const LIMIT = 4000; // Telegram caps a message at 4096 characters.

export const escapeHtml = (value = "") =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * Error text can carry credentials (a failed `git remote add` prints the
 * authenticated URL), and this message is about to leave the machine.
 */
export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      out = out.replaceAll(secret, "***");
    }
  }
  return out.replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@");
}

export async function sendTelegram({ token, chatId }, text) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, LIMIT),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      // The body names the problem ("chat not found"); the URL holds the token.
      const { description } = await response.json().catch(() => ({}));
      return { sent: false, reason: `Telegram ${response.status}: ${description ?? "request failed"}` };
    }
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: `Telegram unreachable: ${error.message}` };
  }
}

// "feat(api): add x" → tag "feat(api)" + "add x". The `//` guard keeps a bare
// URL title from being read as an "https:" prefix.
const COMMIT_PREFIX = /^([a-z]+(?:\([^)]*\))?)!?:[ \t]+(?!\/\/)(.+)$/is;

function header(emoji, label, { slug, number, title }) {
  const match = COMMIT_PREFIX.exec(String(title ?? "").trim());
  const [tag, text] = match ? [match[1], match[2].trim()] : [null, String(title ?? "").trim()];
  return [
    `${emoji} <b>${label}</b>`,
    "",
    `<b>${escapeHtml(slug)}</b>`,
    `🔢 <b>#${number}</b>${tag ? ` · <code>${escapeHtml(tag)}</code>` : ""}`,
    ...(text ? [`<b>${escapeHtml(text)}</b>`] : []),
    "",
  ];
}

const link = (url, label) => `🔗 <a href="${escapeHtml(url)}">${label}</a>`;

/** `pr` is GitHub's pull request object. */
const subject = (pr) => ({
  slug: pr.base.repo.full_name,
  number: pr.number,
  title: pr.title,
  url: pr.html_url,
});

export function startedMessage(pr) {
  return [
    ...header("🔍", "Review Started", subject(pr)),
    `👤 ${escapeHtml(pr.user?.login ?? "unknown")}`,
    `📄 ${pr.changed_files} files · +${pr.additions}/-${pr.deletions}`,
    link(pr.html_url, "View Pull Request"),
  ].join("\n");
}

const VERDICT = {
  REQUEST_CHANGES: "🔴 Changes requested",
  COMMENT: "💬 Commented",
  APPROVE: "✅ Approved",
};

export function finishedMessage({ pr, counts, event, published, reviewUrl, inline, seconds }) {
  const critical = counts.P0 + counts.P1;
  const total = critical + counts.P2 + counts.P3;
  const rows = [
    ["Critical", critical],
    ["Medium", counts.P2],
    ["Minor", counts.P3],
  ];
  // No emoji inside <pre>: their width varies by client and breaks alignment.
  const table = [
    "Severity  Count",
    "────────  ─────",
    ...rows.map(([label, count]) => `${label.padEnd(8)}  ${String(count).padStart(5)}`),
    "────────  ─────",
    `${"Total".padEnd(8)}  ${String(total).padStart(5)}`,
  ].join("\n");

  return [
    ...header("✅", "Review Complete", subject(pr)),
    `<pre>${escapeHtml(table)}</pre>`,
    "",
    `📝 ${published ? VERDICT[event] ?? event : "Not published"}` +
      (published ? ` · ${inline} inline comment${inline === 1 ? "" : "s"}` : ""),
    `⏱ ${formatDuration(seconds)}`,
    link(published ? reviewUrl : pr.html_url, published ? "View Review" : "View Pull Request"),
  ].join("\n");
}

/** `pr` may be missing when the run failed before the pull request loaded. */
export function failedMessage({ target, pr, error }) {
  const subjectOf = pr
    ? subject(pr)
    : { slug: target.slug, number: target.number, title: "", url: "" };
  const url = pr?.html_url ?? `https://${target.host}/${target.slug}/pull/${target.number}`;
  return [
    ...header("❌", "Review Failed", subjectOf),
    `<pre>${escapeHtml(String(error).slice(0, 1500))}</pre>`,
    "",
    link(url, "View Pull Request"),
  ].join("\n");
}

export function mergedMessage(pr) {
  return [
    ...header("🎉", "Pull Request Merged", subject(pr)),
    `👤 ${escapeHtml(pr.user?.login ?? "unknown")}` +
      (pr.merged_by ? ` · merged by ${escapeHtml(pr.merged_by.login)}` : ""),
    `🌿 ${escapeHtml(pr.head.ref)} → ${escapeHtml(pr.base.ref)}`,
    link(pr.html_url, "View Pull Request"),
  ].join("\n");
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * `notify(message)` for a loaded config: a no-op when Telegram is not
 * configured, credential-redacted when it is. `onError` gets the reason a
 * message was not delivered.
 */
export function notifierFor(config, onError) {
  if (!config.telegram) {
    return async () => {};
  }
  const secrets = [config.githubToken, config.claudeToken, config.anthropicKey, config.telegram.token];
  return async (message) => {
    const { sent, reason } = await sendTelegram(config.telegram, redact(message, secrets));
    if (!sent) {
      onError(reason);
    }
  };
}
