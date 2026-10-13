/**
 * The contract between the container and the host.
 *
 * The agent returns structured findings and section content, never a rendered
 * review. The host assembles the markdown, so every anchor can be re-checked
 * against the real diff and the sections the host already knows the answer to
 * (CI state, tests in diff, description present) are filled from GitHub rather
 * than from the model.
 */
const stringList = (max, maxLength = 400) => ({
  type: "array",
  maxItems: max,
  items: { type: "string", maxLength },
});

export const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings", "coverage"],
  properties: {
    // ── Section 1 ────────────────────────────────────────────────────────
    summary: {
      type: "string",
      description:
        "One or two sentences: what this pull request adds or changes, in plain terms.",
      maxLength: 1000,
    },

    // ── Section 2 ────────────────────────────────────────────────────────
    changes: {
      type: "array",
      maxItems: 40,
      description: "One entry per changed file, in the order they matter.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "summary"],
        properties: {
          path: { type: "string" },
          summary: {
            type: "string",
            description:
              "What this file now does differently. Lead with the line delta, e.g. '+54 — adds the Group By checkbox'.",
            maxLength: 300,
          },
        },
      },
    },
    approach: {
      type: ["string", "null"],
      description:
        "Two to four sentences on how the change is implemented — the data structures, the control flow, the state.",
      maxLength: 1200,
    },

    // ── Section 3 ────────────────────────────────────────────────────────
    intention: {
      type: ["string", "null"],
      description:
        "What the change is for, in the author's terms. Read the description and the code. If the description is empty, say so and infer from the diff.",
      maxLength: 800,
    },

    // ── Section 4 ────────────────────────────────────────────────────────
    problemsSolved: {
      ...stringList(10),
      description: "What the change genuinely achieves. Credit, not defects.",
    },

    // ── Section 5 ────────────────────────────────────────────────────────
    findings: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "body", "path", "line", "side", "rootCause"],
        properties: {
          severity: {
            type: "string",
            enum: ["P0", "P1", "P2", "P3"],
            description:
              "P0/P1 render as Critical, P2 as Medium, P3 as Minor. P0/P1 block the merge.",
          },
          title: {
            type: "string",
            description:
              "Short noun phrase naming the defect, e.g. 'Column name vs. column key mismatch'.",
            maxLength: 120,
          },
          body: {
            type: "string",
            description:
              "Trigger, execution path, incorrect result, then the required behavior. No emojis — the renderer adds them.",
            maxLength: 4000,
          },
          snippet: {
            type: ["string", "null"],
            description:
              "The few offending lines, verbatim from the diff, to render as a fenced block above the explanation.",
            maxLength: 1200,
          },
          snippetLang: {
            type: ["string", "null"],
            description: "Fence language, e.g. tsx, ts, js, sql.",
            maxLength: 20,
          },
          path: { type: "string", description: "Repository-relative, exactly as in the diff." },
          line: { type: "integer", minimum: 1, description: "Final line of the anchored range." },
          startLine: { type: ["integer", "null"], minimum: 1 },
          side: { type: "string", enum: ["RIGHT", "LEFT"] },
          rootCause: {
            type: "string",
            description: "Stable short identifier, used to deduplicate across runs.",
            maxLength: 200,
          },
          suggestion: {
            type: ["string", "null"],
            description:
              "Exact replacement for the anchored lines, only when the fix is local, mechanical and complete.",
            maxLength: 2000,
          },
        },
      },
    },

    // ── Section 6 ────────────────────────────────────────────────────────
    mergeVerdict: {
      type: ["string", "null"],
      description:
        "One or two sentences on whether this should merge and why. The checks table itself is filled by the host from GitHub.",
      maxLength: 600,
    },

    // ── Section 7 ────────────────────────────────────────────────────────
    alignment: {
      type: "array",
      maxItems: 10,
      description:
        "How the change sits against existing repository conventions. Observations, not defects.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ok", "note"],
        properties: {
          ok: {
            type: "boolean",
            description: "true renders a tick, false renders a warning sign.",
          },
          note: { type: "string", maxLength: 400 },
        },
      },
    },

    // ── Section 8 ────────────────────────────────────────────────────────
    postmortem: {
      type: "object",
      additionalProperties: false,
      properties: {
        wentWell: stringList(8),
        toImprove: stringList(8),
        followUps: stringList(8),
      },
    },

    // ── Verification metadata ────────────────────────────────────────────
    coverage: {
      type: "object",
      additionalProperties: false,
      required: ["reviewed"],
      properties: {
        reviewed: { type: "string", maxLength: 800 },
        limited: { type: ["string", "null"], maxLength: 800 },
        openQuestions: stringList(5),
      },
    },
    validation: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "result"],
        properties: {
          command: { type: "string", maxLength: 300 },
          result: {
            type: "string",
            enum: ["passed", "failed", "timed out", "not run"],
          },
          detail: { type: ["string", "null"], maxLength: 300 },
        },
      },
    },
  },
};
