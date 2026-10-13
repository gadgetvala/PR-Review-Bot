import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ROOT } from "./config.js";

export const DEFAULT_LOG = resolve(ROOT, "runs.csv");

const COLUMNS = [
  "timestamp",
  "repo",
  "pr",
  "url",
  "head_sha",
  "event",
  "published",
  "p0",
  "p1",
  "p2",
  "p3",
  "inline",
  "non_inline",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "total_tokens",
  "est_usd",
  "billing",
  "turns",
  "duration_s",
  "model",
];

/** RFC 4180: quote everything, double any embedded quote. Titles contain commas. */
const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;

/**
 * One line per review, appended to a CSV you can open in a spreadsheet.
 *
 * `est_usd` is what the Claude Code CLI reports as `total_cost_usd`. On a
 * subscription token that is an API-equivalent estimate, not money charged —
 * the `billing` column records which it was so a column of numbers is not
 * mistaken for an invoice.
 *
 * Logging is best-effort: a review that succeeded must not be reported as
 * failed because a CSV was locked by a spreadsheet.
 */
export async function appendRun(path, entry) {
  const row = {
    timestamp: entry.timestamp,
    repo: entry.target.slug,
    pr: entry.target.number,
    url: entry.snapshot.url,
    head_sha: entry.snapshot.headSha.slice(0, 12),
    event: entry.event,
    published: entry.published ? "yes" : "no",
    p0: entry.counts.P0,
    p1: entry.counts.P1,
    p2: entry.counts.P2,
    p3: entry.counts.P3,
    inline: entry.inlineCount,
    non_inline: entry.nonInlineCount,
    input_tokens: entry.usage?.inputTokens ?? "",
    output_tokens: entry.usage?.outputTokens ?? "",
    cache_read_tokens: entry.usage?.cacheReadTokens ?? "",
    cache_write_tokens: entry.usage?.cacheWriteTokens ?? "",
    total_tokens: entry.usage?.tokens ?? "",
    est_usd: entry.usage?.costUsd ?? "",
    billing: entry.billing,
    turns: entry.usage?.turns ?? "",
    duration_s: entry.usage?.durationMs
      ? (entry.usage.durationMs / 1000).toFixed(1)
      : "",
    model: entry.model,
  };

  try {
    const header = await hasHeader(path);
    const line = COLUMNS.map((column) => escape(row[column])).join(",");
    await appendFile(path, `${header ? "" : `${COLUMNS.join(",")}\n`}${line}\n`, "utf8");
    return { logged: true };
  } catch (error) {
    return { logged: false, reason: error.message };
  }
}

async function hasHeader(path) {
  try {
    const head = (await readFile(path, "utf8")).slice(0, COLUMNS[0].length);
    return head.startsWith(COLUMNS[0]);
  } catch {
    return false;
  }
}

/** Running totals, so `--stats` answers "what has this cost me so far". */
export async function summarize(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }

  const rows = parse(text);
  if (rows.length === 0) {
    return null;
  }

  const sum = (key) =>
    rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);

  return {
    runs: rows.length,
    published: rows.filter((row) => row.published === "yes").length,
    repos: new Set(rows.map((row) => row.repo)).size,
    tokens: sum("total_tokens"),
    estUsd: sum("est_usd"),
    findings: {
      P0: sum("p0"),
      P1: sum("p1"),
      P2: sum("p2"),
      P3: sum("p3"),
    },
    subscriptionRuns: rows.filter((row) => row.billing === "subscription").length,
    first: rows[0]?.timestamp,
    last: rows.at(-1)?.timestamp,
  };
}

/** Small quoted-CSV reader; the file is written by this module only. */
function parse(text) {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return [];
  }
  const header = splitRow(lines[0]);
  return lines.slice(1).map((line) => {
    const values = splitRow(line);
    return Object.fromEntries(header.map((key, i) => [key, values[i] ?? ""]));
  });
}

function splitRow(line) {
  const values = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

export { writeFile as _writeFileForTests };
