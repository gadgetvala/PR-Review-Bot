import { GitHubError } from "./github.js";


function renderComment(finding) {
  const parts = [`[${finding.severity}] ${finding.title}`, "", finding.body];

  if (finding.suggestion) {
    parts.push("", "```suggestion", finding.suggestion.replace(/\n$/, ""), "```");
  }
  parts.push("", `<!-- pr-review-bot-fingerprint:${finding.fingerprint} -->`);
  return parts.join("\n");
}

/**
 * Submits one review carrying every inline comment.
 *
 * One request rather than one per comment: it produces a single notification
 * for the author, and it is atomic — a partial failure cannot leave half a
 * review on the pull request for someone to reconcile by hand.
 */
export async function publishReview({ github, target, snapshot, body, inline, event }) {
  // The spec's central publishing rule: never post against a SHA that moved
  // while the review was running. The anchors would land on the wrong lines.
  const currentHead = await github.headSha(target);
  if (currentHead !== snapshot.headSha) {
    return {
      published: false,
      reason: `head moved from ${snapshot.headSha.slice(0, 7)} to ${currentHead.slice(0, 7)} during the review; re-run to review the new commits`,
    };
  }

  const payload = {
    commit_id: snapshot.headSha,
    event,
    body,
    comments: inline.map((finding) => {
      const comment = {
        path: finding.path,
        line: finding.line,
        side: finding.side,
        body: renderComment(finding),
      };
      if (finding.startLine !== null && finding.startLine < finding.line) {
        comment.start_line = finding.startLine;
        comment.start_side = finding.side;
      }
      return comment;
    }),
  };

  try {
    const review = await github.createReview(target, payload);
    return {
      published: true,
      url: review.html_url,
      id: review.id,
      state: review.state,
      commentCount: payload.comments.length,
    };
  } catch (error) {
    if (error instanceof GitHubError && error.status === 422) {
      // Almost always an anchor GitHub disagrees with. Do not retry comment by
      // comment — that is how a PR ends up with duplicates and ten
      // notifications. Fall back to the summary alone.
      return {
        published: false,
        reason: `${error.message}\nThe summary alone can still be posted with --summary-only.`,
        recoverable: true,
      };
    }
    throw error;
  }
}

/** Summary with no inline comments — the fallback when anchoring is rejected. */
export async function publishSummaryOnly({ github, target, snapshot, body, event }) {
  const currentHead = await github.headSha(target);
  if (currentHead !== snapshot.headSha) {
    return { published: false, reason: "head moved during the review" };
  }
  const review = await github.createReview(target, {
    commit_id: snapshot.headSha,
    event,
    body,
  });
  return {
    published: true,
    url: review.html_url,
    id: review.id,
    state: review.state,
    commentCount: 0,
  };
}
