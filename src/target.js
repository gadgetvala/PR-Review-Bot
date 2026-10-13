export class TargetError extends Error {}

// GitHub's own rules: 1–39 chars, alphanumeric or hyphen, no leading/trailing
// hyphen. Repo names are laxer but must not contain a slash or whitespace.
const OWNER = /^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/;
const REPO = /^[\w.-]{1,100}$/;

function validate(owner, repo, number, host) {
  if (!OWNER.test(owner)) {
    throw new TargetError(`"${owner}" is not a valid GitHub owner`);
  }
  if (!REPO.test(repo) || repo === "." || repo === "..") {
    throw new TargetError(`"${repo}" is not a valid repository name`);
  }
  if (!Number.isInteger(number) || number < 1) {
    throw new TargetError(`"${number}" is not a valid pull request number`);
  }
  return { host, owner, repo, number, slug: `${owner}/${repo}` };
}

/**
 * Accepts the three shapes a human actually types:
 *
 *   https://github.com/owner/repo/pull/123     (any /files, /commits suffix ok)
 *   owner/repo#123      or      owner/repo/123
 *   123                                         (needs --repo or DEFAULT_REPO)
 *
 * Everything is validated rather than interpolated blind — these values end up
 * in URLs and in `git clone`, so a crafted "owner" is a command-injection and
 * SSRF surface.
 */
export function parseTarget(input, { defaultRepo, defaultHost = "github.com" } = {}) {
  const raw = String(input ?? "").trim();
  if (!raw) {
    throw new TargetError("No pull request given");
  }

  if (/^https?:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new TargetError(`Could not parse "${raw}" as a URL`);
    }
    // /owner/repo/pull/123 — reject /pulls, /issues and other lookalikes so a
    // typo fails loudly instead of reviewing the wrong thing.
    const parts = url.pathname.split("/").filter(Boolean);
    const [owner, repo, kind, number] = parts;
    if (kind !== "pull" || !owner || !repo || !number) {
      throw new TargetError(
        `"${raw}" is not a pull request URL. Expected https://<host>/<owner>/<repo>/pull/<number>`
      );
    }
    return validate(owner, repo, Number.parseInt(number, 10), url.hostname);
  }

  const qualified = raw.match(/^([^/\s]+)\/([^/#\s]+)(?:#|\/)(\d+)$/);
  if (qualified) {
    const [, owner, repo, number] = qualified;
    return validate(owner, repo, Number.parseInt(number, 10), defaultHost);
  }

  if (/^\d+$/.test(raw)) {
    if (!defaultRepo) {
      throw new TargetError(
        `"${raw}" is only a number. Pass --repo owner/name, set DEFAULT_REPO in .env, or use the full pull request URL.`
      );
    }
    const [owner, repo, ...extra] = defaultRepo.split("/");
    if (!owner || !repo || extra.length > 0) {
      throw new TargetError(`DEFAULT_REPO must be "owner/name", got "${defaultRepo}"`);
    }
    return validate(owner, repo, Number.parseInt(raw, 10), defaultHost);
  }

  throw new TargetError(
    `Could not read "${raw}" as a pull request. Use a URL, owner/repo#123, or a bare number with --repo.`
  );
}
