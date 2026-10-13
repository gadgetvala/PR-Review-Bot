const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (tty ? `[${code}m${text}[0m` : text);

export const dim = paint("2");
export const bold = paint("1");
export const red = paint("31");
export const green = paint("32");
export const yellow = paint("33");
export const cyan = paint("36");

export const say = (message = "") => process.stdout.write(`${message}\n`);
export const warn = (message) => process.stderr.write(`${yellow("!")} ${message}\n`);
export const fail = (message) => process.stderr.write(`${red("x")} ${message}\n`);

/**
 * A step that reports its own duration. Progress goes to stderr so stdout can
 * be piped somewhere useful without the spinner in it.
 */
export async function step(label, work) {
  const started = Date.now();
  if (tty) {
    process.stderr.write(`${dim("·")} ${label}…`);
  }
  try {
    const value = await work();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    process.stderr.write(
      `${tty ? "\r[K" : ""}${green("✓")} ${label} ${dim(`${seconds}s`)}\n`
    );
    return value;
  } catch (error) {
    process.stderr.write(`${tty ? "\r[K" : ""}${red("✗")} ${label}\n`);
    throw error;
  }
}

const SEVERITY_COLOR = { P0: red, P1: red, P2: yellow, P3: dim };

export function printFindings({ inline, nonInline, rejected }) {
  if (inline.length === 0 && nonInline.length === 0) {
    say(`\n${green("No defects survived verification.")}`);
  }

  for (const finding of inline) {
    const tag = SEVERITY_COLOR[finding.severity](`[${finding.severity}]`);
    say(`\n${tag} ${bold(finding.title)}`);
    say(dim(`  ${finding.path}:${finding.line} (${finding.side})`));
    say(indent(finding.body));
    if (finding.suggestion) {
      say(dim("  suggestion:"));
      say(indent(finding.suggestion, "    "));
    }
  }

  if (nonInline.length > 0) {
    say(`\n${bold("Non-inline")} ${dim("(could not be anchored to the diff)")}`);
    for (const finding of nonInline) {
      say(
        `  ${SEVERITY_COLOR[finding.severity](finding.severity)} ${finding.path}:${finding.line} ${finding.title} ${dim(`— ${finding.reason}`)}`
      );
    }
  }

  // Surfaced rather than swallowed: a run that discards ten findings for the
  // same reason is telling you the prompt or the diff is off.
  if (rejected.length > 0) {
    say(`\n${dim(`${rejected.length} finding(s) discarded during verification:`)}`);
    for (const { finding, reason } of rejected) {
      say(dim(`  - ${finding?.title ?? "(untitled)"} — ${reason}`));
    }
  }
}

const indent = (text, pad = "  ") =>
  String(text)
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
