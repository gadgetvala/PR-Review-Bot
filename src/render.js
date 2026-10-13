/**
 * The eight-section review body.
 *
 * Assembled on the host, never taken as markdown from the agent. Two reasons:
 * the sections the host can answer from GitHub — CI state, tests in the diff,
 * whether a description exists — are filled from GitHub rather than from the
 * model, and rendering here means agent output cannot inject structure it was
 * not asked for.
 */

/** P0/P1 both read as Critical: either one blocks the merge. */
const SEVERITY_LABEL = {
  P0: { emoji: "🔴", label: "Critical" },
  P1: { emoji: "🔴", label: "Critical" },
  P2: { emoji: "🟠", label: "Medium" },
  P3: { emoji: "🟡", label: "Minor" },
};

/** A cell containing a pipe or a newline would break the markdown table. */
const cell = (text) =>
  String(text ?? "")
    .replaceAll("|", "\\|")
    .replaceAll(/\s*\n\s*/g, " ")
    .trim();

const section = (lines, heading, body) => {
  if (!body || (Array.isArray(body) && body.length === 0)) {
    return;
  }
  lines.push(`### ${heading}`, "");
  lines.push(...(Array.isArray(body) ? body : [body]));
  lines.push("", "---", "");
};

export function renderReview({
  result,
  inline,
  nonInline,
  event,
  snapshot,
  usage,
  mergeability,
}) {
  const lines = [`## PR Review — ${cell(snapshot.title)}`, "", "---", ""];

  section(lines, "1. Summary", result.summary?.trim());
  section(lines, "2. Details", renderDetails(result, snapshot));
  section(lines, "3. Intention", result.intention?.trim());
  section(lines, "4. Problems Solved", bullets(result.problemsSolved));
  section(lines, "5. Mistakes & Issues", renderFindings(inline, nonInline));
  section(lines, "6. Mergeability", renderMergeability(result, mergeability));
  section(lines, "7. Alignment", renderAlignment(result));
  section(lines, "8. Postmortem", renderPostmortem(result));
  section(lines, "9. Coverage & Validation", renderCoverage(result, snapshot));

  lines.push(renderFooter({ event, snapshot, usage }));
  return lines.join("\n");
}

const bullets = (items) => (items ?? []).map((item) => `- ${item}`);

function renderDetails(result, snapshot) {
  const changes = result.changes ?? [];
  if (changes.length === 0 && !result.approach) {
    return null;
  }

  const out = [];
  if (changes.length > 0) {
    out.push(
      `**Files changed (${snapshot.changedFiles}):**`,
      "",
      "| File | Change |",
      "|---|---|",
      ...changes.map((c) => `| \`${cell(c.path)}\` | ${cell(c.summary)} |`),
      ""
    );
  }
  if (result.approach) {
    out.push(`**Implementation approach:** ${result.approach.trim()}`);
  }
  return out;
}

/**
 * Section 5. Inline findings and non-inline findings render identically —
 * whether a defect could be anchored to a diff line is a publishing detail,
 * not something a reader of the summary should have to reason about. The
 * anchor is shown so they can still find it.
 */
function renderFindings(inline, nonInline) {
  const all = [...inline, ...nonInline].sort(
    (a, b) => a.severity.localeCompare(b.severity) || a.path.localeCompare(b.path)
  );

  if (all.length === 0) {
    // Said explicitly rather than omitted: a missing section reads as "the
    // reviewer forgot", not "the reviewer found nothing".
    return "No defects survived verification. Nothing in this change looks incorrect, unsafe, or inconsistent with the surrounding code.";
  }

  const out = [];
  for (const finding of all) {
    const { emoji, label } = SEVERITY_LABEL[finding.severity];
    out.push(`#### ${emoji} ${label} — ${finding.title}`, "");

    if (finding.snippet) {
      out.push(`\`\`\`${finding.snippetLang ?? ""}`, finding.snippet.trimEnd(), "```", "");
    }

    out.push(finding.body.trim(), "");
    out.push(`_${finding.path}:${finding.line}_`, "");
  }
  out.pop();
  return out;
}

/**
 * Section 6. Every row here is a fact the host already holds, so none of it
 * is asked of the agent — only the verdict sentence is.
 */
function renderMergeability(result, mergeability) {
  const rows = [
    ["CI — format, lint, types", mergeability.ci],
    ["Tests in this change", mergeability.tests],
    ["PR description", mergeability.description],
    ["`mergeable_state`", mergeability.state],
  ];

  const out = [
    "| Check | Status |",
    "|---|---|",
    ...rows.map(([name, status]) => `| ${name} | ${status} |`),
    "",
  ];

  if (result.mergeVerdict) {
    out.push(
      `**${mergeability.blocking ? "Not ready to merge." : "No blocking defects."}** ${result.mergeVerdict.trim()}`
    );
  }
  return out;
}

function renderAlignment(result) {
  const notes = result.alignment ?? [];
  return notes.length === 0
    ? null
    : notes.map((n) => `- ${n.ok ? "✅" : "⚠️"} ${n.note}`);
}

function renderPostmortem(result) {
  const pm = result.postmortem ?? {};
  const out = [];
  const block = (title, items) => {
    if (items?.length > 0) {
      out.push(`**${title}:**`, "", ...bullets(items), "");
    }
  };
  block("What went well", pm.wentWell);
  block("What to improve", pm.toImprove);
  block("Follow-up work", pm.followUps);
  return out.length === 0 ? null : out;
}

/**
 * Kept as its own section rather than folded into Mergeability: what the
 * reviewer could not check is as load-bearing as what it found, and burying it
 * is how a partial review gets read as a complete one.
 */
function renderCoverage(result, snapshot) {
  const out = [];
  const coverage = result.coverage ?? {};
  const validation = result.validation ?? [];

  if (validation.length > 0) {
    out.push(
      ...validation.map(
        (v) => `- \`${cell(v.command)}\`: ${v.result}${v.detail ? ` — ${v.detail}` : ""}`
      )
    );
  }
  if (snapshot.checks && snapshot.checks.state !== "unknown") {
    out.push(`- CI: ${snapshot.checks.state}`);
  }
  if (coverage.reviewed) {
    out.push(`- Reviewed: ${coverage.reviewed}`);
  }
  if (coverage.limited) {
    out.push(`- Limited or not reviewed: ${coverage.limited}`);
  }
  for (const question of coverage.openQuestions ?? []) {
    out.push(`- Open question: ${question}`);
  }
  return out.length === 0 ? null : out;
}

/**
 * The dollar figure is an API-equivalent estimate, not money charged, when the
 * run authenticates with a subscription token. Labelling it "Cost: $1.35" on a
 * Max plan is simply wrong, so the label follows the auth mode.
 */
function renderFooter({ event, snapshot, usage }) {
  const parts = [
    `Reviewed ${snapshot.mergeBase.slice(0, 7)}..${snapshot.headSha.slice(0, 7)}`,
    `event ${event}`,
  ];
  if (usage?.tokens) {
    parts.push(`${usage.tokens.toLocaleString()} tokens`);
  }
  return [
    `<sub>${parts.join(" · ")}</sub>`,
    "",
    `<!-- pr-review-bot-head:${snapshot.headSha} -->`,
  ].join("\n");
}

/** Facts for section 6, derived from GitHub rather than asked of the agent. */
export function assessMergeability({ pr, files, checks, counts }) {
  const TEST_FILE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[jt]sx?$/i;
  const hasTests = files.some((f) => TEST_FILE.test(f.filename));
  const blocking = counts.P0 > 0 || counts.P1 > 0;

  const CI = {
    success: "✅ Passing",
    failure: "❌ Failing",
    pending: "⏳ In progress",
    unknown: "➖ No checks reported",
  };

  return {
    blocking,
    ci: CI[checks?.state] ?? `➖ ${checks?.state ?? "unknown"}`,
    tests: hasTests ? "✅ Included" : "❌ None in diff",
    description: pr.body?.trim() ? "✅ Present" : "❌ Missing (no body)",
    state:
      pr.mergeable_state === "clean"
        ? "✅ Clean"
        : `⚠️ ${pr.mergeable_state ?? "unknown"}`,
  };
}
