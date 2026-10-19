// Minimal GitHub REST client for reading public spec history.
// Uses GITHUB_TOKEN when present (GitHub Actions provides one); works unauthenticated
// within GitHub's public rate limit otherwise.

const API = 'https://api.github.com';

/** @param {string} url */
async function get(url) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'driftguard' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} for ${url}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * @typedef {{sha: string, date: string, message: string}} Commit
 */

/** @param {any} c @returns {Commit} */
function toCommit(c) {
  return { sha: c.sha, date: c.commit.committer.date, message: String(c.commit.message).split('\n')[0] };
}

/**
 * Commits that touched `file`, newest first, stopping once one commit older than `since`
 * has been collected (that commit is the diff base for the oldest newer commit).
 * @param {string} repo
 * @param {string} branch
 * @param {string} file
 * @param {{since: string, limit: number}} opts
 * @returns {Promise<Commit[]>}
 */
export async function commitsTouching(repo, branch, file, { since, limit }) {
  /** @type {Commit[]} */
  const out = [];
  const sinceMs = Date.parse(since);
  for (let page = 1; page <= 10; page++) {
    const url = `${API}/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(file)}&per_page=100&page=${page}`;
    /** @type {any[]} */
    const batch = await get(url);
    for (const c of batch) {
      const commit = toCommit(c);
      out.push(commit);
      if (Date.parse(commit.date) <= sinceMs || out.length >= limit + 1) return out;
    }
    if (batch.length < 100) return out;
  }
  return out;
}

/**
 * Every commit that touched `file`, newest first.
 * @param {string} repo
 * @param {string} branch
 * @param {string} file
 * @param {{stopAt?: string}} [opts]  stop after collecting the commit with this SHA
 * @returns {Promise<Commit[]>}
 */
export async function allCommitsTouching(repo, branch, file, opts = {}) {
  /** @type {Commit[]} */
  const out = [];
  for (let page = 1; page <= 100; page++) {
    const url = `${API}/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(file)}&per_page=100&page=${page}`;
    /** @type {any[]} */
    const batch = await get(url);
    for (const c of batch) {
      out.push(toCommit(c));
      if (opts.stopAt && c.sha === opts.stopAt) return out;
    }
    if (batch.length < 100) return out;
  }
  throw new Error(`More than 10000 commits touch ${repo}/${file}; refusing to page further.`);
}

/**
 * The last commit touching `file` at or before `until`, or null if the file did not exist.
 * @param {string} repo
 * @param {string} branch
 * @param {string} file
 * @param {string} until ISO timestamp
 * @returns {Promise<Commit|null>}
 */
export async function commitAtOrBefore(repo, branch, file, until) {
  const url = `${API}/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(file)}&until=${encodeURIComponent(until)}&per_page=1`;
  /** @type {any[]} */
  const batch = await get(url);
  return batch.length ? toCommit(batch[0]) : null;
}

/**
 * Latest commit of a repository's default branch (used for SDK map provenance).
 * @param {string} repo
 * @param {string} ref
 */
export async function headCommit(repo, ref) {
  return toCommit(await get(`${API}/repos/${repo}/commits/${encodeURIComponent(ref)}`));
}

/**
 * @param {string} repo
 * @param {string} sha
 * @param {string} file
 */
export function rawUrl(repo, sha, file) {
  return `https://raw.githubusercontent.com/${repo}/${sha}/${file}`;
}

/**
 * @param {string} repo
 * @param {string} sha
 * @param {string} file
 * @param {number} [line]
 */
export function blobUrl(repo, sha, file, line) {
  return `https://github.com/${repo}/blob/${sha}/${file}${line ? `#L${line}` : ''}`;
}

/**
 * @param {string} repo
 * @param {string} base
 * @param {string} head
 */
export function compareUrl(repo, base, head) {
  return `https://github.com/${repo}/compare/${base}...${head}`;
}
