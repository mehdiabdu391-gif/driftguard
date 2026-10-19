// API version index: maps each API version a provider has published to the spec snapshots
// that describe it.
//
// Stripe's spec repository records every spec update as a commit, and each snapshot names
// the API version it describes in `info.version`. The index reads the version of every
// snapshot (no sampling: Stripe has re-published an older version after a newer one, for
// example 2024-11-20.acacia on 2024-12-13 between two 2024-12-18.acacia snapshots, so the
// history is not strictly ordered) and stores the runs of consecutive snapshots that share
// a version. `drift upgrade` diffs from the last snapshot published for a version.

import path from 'node:path';
import { allCommitsTouching, rawUrl } from './github.js';
import { readJson, writeJson } from './track.js';

/**
 * @typedef {import('./github.js').Commit} Commit
 * @typedef {{version: string, first: Commit, last: Commit}} VersionRun
 * @typedef {{specId: string, repo: string, branch: string, file: string, head: Commit, versions: VersionRun[]}} VersionIndex
 *   `versions` holds runs in history order; a version can have more than one run.
 */

/**
 * Group an oldest-first chain into runs of consecutive snapshots with the same version.
 * @param {Commit[]} chain   oldest first
 * @param {(c: Commit) => Promise<string>} versionOf
 * @param {number} [concurrency]
 * @returns {Promise<VersionRun[]>}
 */
export async function versionRuns(chain, versionOf, concurrency = 8) {
  /** @type {string[]} */
  const versions = new Array(chain.length);
  let next = 0;
  const worker = async () => {
    while (next < chain.length) {
      const i = next++;
      versions[i] = await versionOf(chain[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, chain.length) }, worker));
  /** @type {VersionRun[]} */
  const runs = [];
  for (let i = 0; i < chain.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.version === versions[i]) last.last = chain[i];
    else runs.push({ version: versions[i], first: chain[i], last: chain[i] });
  }
  return runs;
}

/**
 * The top-level `info` object of a pretty-printed spec, found while the download streams so
 * the rest of the multi-megabyte document is not read. Falls back to a full parse when the
 * document is not laid out that way.
 */
const INFO_START = '\n  "info": {';
const INFO_VERSION = /^\n {2}"info": \{(?:[^{}]|\{[^{}]*\})*?\n {4}"version": "([^"]+)"/;

/**
 * Read `info.version` from a spec snapshot without keeping the document.
 * @param {string} repo
 * @param {string} file
 * @param {Commit} c
 */
export async function fetchVersion(repo, file, c) {
  const url = rawUrl(repo, c.sha, file);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let searched = 0;
  let infoAt = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (infoAt < 0) {
      infoAt = text.indexOf(INFO_START, Math.max(0, searched - INFO_START.length));
      searched = text.length;
    }
    if (infoAt >= 0) {
      const m = INFO_VERSION.exec(text.slice(infoAt));
      if (m) {
        await reader.cancel().catch(() => {});
        return m[1];
      }
    }
  }
  text += decoder.decode();
  const version = JSON.parse(text)?.info?.version;
  if (typeof version !== 'string' || !version) throw new Error(`No info.version in ${url}`);
  return version;
}

/**
 * Build or extend the version index for a spec and write it to data/versions/<id>.json.
 * @param {import('../providers.js').SpecSource} spec
 * @param {string} dataDir
 * @param {{log?: (s: string) => void, versionOf?: (c: Commit) => Promise<string>, commits?: (stopAt?: string) => Promise<Commit[]>}} [opts]
 * @returns {Promise<VersionIndex | null>}
 */
export async function updateVersionIndex(spec, dataDir, opts = {}) {
  if (!spec.versionHistory) return null;
  const file = spec.versionHistory.file;
  const log = opts.log ?? ((s) => process.stderr.write(`${s}\n`));
  const indexPath = path.join(dataDir, 'versions', `${spec.id}.json`);
  /** @type {VersionIndex | null} */
  const existing = await readJson(indexPath);
  const listCommits = opts.commits ?? ((stopAt) => allCommitsTouching(spec.repo, spec.branch, file, { stopAt }));
  let probes = 0;
  const versionOf = async (/** @type {Commit} */ c) => {
    probes++;
    return (opts.versionOf ?? ((x) => fetchVersion(spec.repo, file, x)))(c);
  };

  const newestFirst = await listCommits(existing?.head.sha);
  if (newestFirst.length === 0) throw new Error(`[${spec.id}] no commits touch ${file}`);
  const head = newestFirst[0];
  if (existing && head.sha === existing.head.sha) return existing;

  /** @type {VersionRun[]} */
  let versions;
  if (existing && newestFirst[newestFirst.length - 1].sha === existing.head.sha) {
    // Extend: the old head starts the new chain, so its run continues if the version is unchanged.
    const runs = await versionRuns(newestFirst.slice().reverse(), versionOf);
    const prior = existing.versions.slice();
    const last = prior[prior.length - 1];
    if (runs[0].version !== last.version) throw new Error(`[${spec.id}] indexed head ${existing.head.sha} is ${last.version}, upstream now says ${runs[0].version}`);
    prior[prior.length - 1] = { ...last, last: runs[0].last };
    versions = [...prior, ...runs.slice(1)];
  } else {
    // First build, or the old head is no longer in the history (rewritten): index everything.
    const all = existing ? await listCommits(undefined) : newestFirst;
    versions = await versionRuns(all.slice().reverse(), versionOf);
  }
  /** @type {VersionIndex} */
  const index = { specId: spec.id, repo: spec.repo, branch: spec.branch, file, head, versions };
  await writeJson(indexPath, index);
  log(`[${spec.id}] version index: ${versions.length} runs, ${probes} snapshots read`);
  return index;
}

/**
 * The indexed version a pinned label refers to: an exact match, or the only indexed
 * version with the same release date ("2024-09-30" for "2024-09-30.acacia").
 * @param {VersionIndex} index
 * @param {string} label
 * @returns {VersionRun | null}
 */
export function findVersion(index, label) {
  // The last run wins: it is the most recent snapshot Stripe published for that version.
  const lastRun = (/** @type {string} */ v) => index.versions.filter((r) => r.version === v).pop() ?? null;
  const exact = lastRun(label);
  if (exact) return exact;
  const sameDate = [...new Set(index.versions.map((r) => r.version))].filter((v) => v.slice(0, 10) === label.slice(0, 10));
  return sameDate.length === 1 ? lastRun(sameDate[0]) : null;
}
