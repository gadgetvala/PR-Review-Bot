/**
 * Which (path, line, side) pairs GitHub will accept as an inline comment.
 *
 * The review API rejects the whole payload if a single anchor is outside the
 * diff, so one hallucinated line number loses every real finding with it.
 * Rather than trust the agent, the host rebuilds the commentable set from the
 * patches GitHub itself returned and drops anything that does not land in it.
 */

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * @returns {{ right: Set<number>, left: Set<number> }} 1-based line numbers
 *   commentable on the new and old side of one file.
 */
export function commentableLines(patch) {
  const right = new Set();
  const left = new Set();
  if (typeof patch !== "string" || patch.length === 0) {
    // Binary files and patches GitHub truncated for size have no hunks, so
    // nothing in them can be commented on inline.
    return { right, left };
  }

  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    const hunk = raw.match(HUNK);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1], 10);
      newLine = Number.parseInt(hunk[3], 10);
      continue;
    }
    if (oldLine === 0 && newLine === 0) {
      continue; // Preamble before the first hunk header.
    }

    switch (raw[0]) {
      case "+":
        right.add(newLine++);
        break;
      case "-":
        left.add(oldLine++);
        break;
      case " ":
        // Context lines are commentable on both sides.
        right.add(newLine++);
        left.add(oldLine++);
        break;
      case "\\":
        break; // "\ No newline at end of file"
      default:
        // An empty string is a context line whose single space was trimmed by
        // a transport somewhere. Advance both counters or every subsequent
        // line in the hunk is off by one.
        if (raw === "") {
          right.add(newLine++);
          left.add(oldLine++);
        }
    }
  }

  return { right, left };
}

/** Path → commentable sides, for every file in the pull request. */
export function buildAnchorIndex(files) {
  const index = new Map();
  for (const file of files) {
    index.set(file.filename, {
      ...commentableLines(file.patch),
      status: file.status,
      // A rename carries the old path; a finding written against it should
      // still resolve rather than silently fail validation.
      previousFilename: file.previous_filename ?? null,
    });
  }
  return index;
}

export function isAnchorable(index, path, line, side = "RIGHT") {
  const entry = index.get(path);
  if (!entry) {
    return false;
  }
  const lines = side === "LEFT" ? entry.left : entry.right;
  return lines.has(line);
}

/** A compact map of what is commentable, small enough to hand to the agent. */
export function describeAnchors(index) {
  const out = {};
  for (const [path, entry] of index) {
    out[path] = {
      status: entry.status,
      right: compress([...entry.right]),
      left: compress([...entry.left]),
    };
  }
  return out;
}

/** [1,2,3,7,8] → ["1-3","7-8"], so a 4,000-line diff stays a short prompt. */
function compress(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const ranges = [];
  let start = null;
  let previous = null;

  for (const n of sorted) {
    if (start === null) {
      start = previous = n;
      continue;
    }
    if (n === previous + 1) {
      previous = n;
      continue;
    }
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = previous = n;
  }
  if (start !== null) {
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  }
  return ranges;
}
