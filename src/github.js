import { apiBaseFor } from "./config.js";

export class GitHubError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.body = body;
  }
}

const USER_AGENT = "pr-review-bot";

/**
 * Minimal GitHub REST client over Node's built-in fetch.
 *
 * Deliberately not the `gh` CLI: this is the only component that holds a
 * credential with write access, and a direct HTTPS call is easier to audit
 * than a subprocess whose argv could be influenced by remote data.
 */
export class GitHub {
  #token;
  #base;

  constructor({ token, host }) {
    this.#token = token;
    this.#base = apiBaseFor(host);
  }

  async #request(path, { method = "GET", body, headers = {} } = {}) {
    const url = path.startsWith("http") ? path : `${this.#base}${path}`;

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": USER_AGENT,
          authorization: `Bearer ${this.#token}`,
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (cause) {
      throw new GitHubError(`Could not reach ${new URL(url).host}: ${cause.message}`);
    }

    if (response.status === 204) {
      return { data: null, response };
    }

    const text = await response.text();
    const data = text ? safeJson(text) : null;

    if (!response.ok) {
      throw new GitHubError(describeFailure(response, data), {
        status: response.status,
        body: data,
      });
    }

    return { data, response };
  }

  get(path) {
    return this.#request(path).then((r) => r.data);
  }

  post(path, body) {
    return this.#request(path, { method: "POST", body }).then((r) => r.data);
  }

  /** Follows RFC 5988 `Link` headers; GitHub caps `per_page` at 100. */
  async paginate(path, { limit = Infinity } = {}) {
    const items = [];
    let next = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;

    while (next && items.length < limit) {
      const { data, response } = await this.#request(next);
      if (!Array.isArray(data)) {
        break;
      }
      items.push(...data);
      next = parseNextLink(response.headers.get("link"));
    }

    return items.slice(0, limit === Infinity ? undefined : limit);
  }

  /** Confirms the token works and reports who the review will be attributed to. */
  async viewer() {
    const user = await this.get("/user");
    return { login: user.login, id: user.id, name: user.name };
  }

  pullRequest({ slug, number }) {
    return this.get(`/repos/${slug}/pulls/${number}`);
  }

  files({ slug, number }, limit) {
    return this.paginate(`/repos/${slug}/pulls/${number}/files`, { limit });
  }

  /** Existing inline threads — read before drafting so findings are not reposted. */
  reviewComments({ slug, number }) {
    return this.paginate(`/repos/${slug}/pulls/${number}/comments`);
  }

  reviews({ slug, number }) {
    return this.paginate(`/repos/${slug}/pulls/${number}/reviews`);
  }

  async checks({ slug }, sha) {
    try {
      const status = await this.get(`/repos/${slug}/commits/${sha}/status`);
      return { state: status.state, contexts: status.statuses ?? [] };
    } catch (error) {
      // A repo with no commit statuses 404s here; that is not a review failure.
      if (error.status === 404) {
        return { state: "unknown", contexts: [] };
      }
      throw error;
    }
  }

  /** The freshest head SHA — checked again immediately before publishing. */
  async headSha(target) {
    const pr = await this.pullRequest(target);
    return pr.head.sha;
  }

  createReview({ slug, number }, payload) {
    return this.post(`/repos/${slug}/pulls/${number}/reviews`, payload);
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function parseNextLink(header) {
  if (!header) {
    return null;
  }
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/** Turns GitHub's status codes into something an operator can act on. */
function describeFailure(response, data) {
  const detail = data?.message ? ` — ${data.message}` : "";

  if (response.status === 401) {
    return `GitHub rejected the token (401)${detail}. Check GITHUB_TOKEN in .env.`;
  }
  if (response.status === 403) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      const minutes = Math.max(1, Math.ceil((reset - Date.now()) / 60_000));
      return `GitHub rate limit exhausted. Resets in about ${minutes} minute(s).`;
    }
    return `GitHub refused the request (403)${detail}. The token likely lacks "Pull requests: write" on this repository.`;
  }
  if (response.status === 404) {
    return `Not found (404)${detail}. Either the pull request does not exist or the token cannot see this repository.`;
  }
  if (response.status === 422) {
    const errors = (data?.errors ?? [])
      .map((e) => e.message ?? `${e.resource}.${e.field}: ${e.code}`)
      .join("; ");
    return `GitHub rejected the payload (422)${detail}${errors ? ` [${errors}]` : ""}`;
  }
  return `GitHub returned ${response.status}${detail}`;
}
