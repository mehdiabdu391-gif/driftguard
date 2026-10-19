// Spec tracker: snapshots each provider's published OpenAPI document by upstream commit,
// diffs consecutive snapshots and fixed time windows with oasdiff, and writes normalized
// change records into data/.
//
// A snapshot is the immutable upstream commit SHA of the spec file, so every record links
// back to the exact bytes it was computed from.

import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { SPECS, WINDOWS } from '../providers.js';
import { classify } from './classify.js';
import { verifyChange } from './verify.js';
import { changelog, oasdiffVersion } from './oasdiff.js';
import { commitsTouching, commitAtOrBefore, rawUrl, blobUrl, compareUrl } from './github.js';
import { opKey } from '../paths.js';
import { updateVersionIndex } from './versions.js';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

/**
 * @typedef {import('./github.js').Commit} Commit
 * @typedef {import('./classify.js').Change} Change
 * @typedef {import('../providers.js').SpecSource} SpecSource
 */

/**
 * A change as published in data/: a classified oasdiff entry plus provenance.
 * @typedef {Change & {
 *   verification: import('./verify.js').Verification,
 *   specId: string,
 *   key: string,
 *   sourceUrl: string | null,
 *   compareUrl: string,
 *   introducedIn: {sha: string, date: string, message: string, compareUrl: string} | null,
 *   upgrade?: {from: string, to: string}
 * }} PublishedChange
 */

/**
 * @param {string} dataDir
 * @param {{specIds?: string[], feedDays?: number, feedLimit?: number, cacheDir?: string, now?: Date, log?: (s: string) => void}} [opts]
 */
export async function track(dataDir, opts = {}) {
  const now = opts.now ?? new Date();
  const log = opts.log ?? ((s) => process.stderr.write(`${s}\n`));
  const cacheDir = opts.cacheDir ?? path.join(process.cwd(), '.cache', 'specs');
  const version = await oasdiffVersion();
  const specs = opts.specIds ? SPECS.filter((s) => opts.specIds?.includes(s.id)) : SPECS;
  /** @type {Record<string, any>} */
  const summary = {};
  for (const spec of specs) {
    log(`[${spec.id}] tracking ${spec.repo}/${spec.file}`);
    summary[spec.id] = await trackSpec(spec, dataDir, {
      now,
      log,
      cacheDir,
      feedDays: opts.feedDays ?? 30,
      feedLimit: opts.feedLimit ?? 40,
      oasdiff: version,
    });
    if (spec.versionHistory) {
      const index = await updateVersionIndex(spec, dataDir, { log });
      summary[spec.id].versions = index?.versions.length ?? 0;
    }
  }
  return summary;
}

/**
 * @param {SpecSource} spec
 * @param {string} dataDir
 * @param {{now: Date, log: (s: string) => void, cacheDir: string, feedDays: number, feedLimit: number, oasdiff: string}} ctx
 */
async function trackSpec(spec, dataDir, ctx) {
  const statePath = path.join(dataDir, 'specs', `${spec.id}.json`);
  const state = (await readJson(statePath)) ?? { id: spec.id, repo: spec.repo, file: spec.file, history: [] };
  const lastSha = state.head?.sha ?? null;

  // 1. Per-commit feed: every upstream commit since the last run (or since feedDays ago).
  const since = state.head?.date ?? new Date(ctx.now.getTime() - ctx.feedDays * 86400e3).toISOString();
  const commits = await commitsTouching(spec.repo, spec.branch, spec.file, { since, limit: ctx.feedLimit });
  if (commits.length === 0) throw new Error(`[${spec.id}] no commits found for ${spec.file}`);
  const head = commits[0];
  // Oldest first, each paired with its predecessor.
  const chain = commits.slice().reverse();
  let start = 0;
  if (lastSha) {
    const idx = chain.findIndex((c) => c.sha === lastSha);
    if (idx >= 0) start = idx;
  }
  const commitDir = path.join(dataDir, 'changes', spec.id, 'commits');
  for (let i = start + 1; i < chain.length; i++) {
    const base = chain[i - 1];
    const rev = chain[i];
    if (state.history.some((/** @type {any} */ h) => h.sha === rev.sha)) continue;
    ctx.log(`[${spec.id}] diff ${base.sha.slice(0, 10)} -> ${rev.sha.slice(0, 10)} (${rev.date})`);
    const changes = await diffPair(spec, base, rev, ctx);
    const record = {
      specId: spec.id,
      base: base,
      revision: rev,
      compareUrl: compareUrl(spec.repo, base.sha, rev.sha),
      oasdiff: ctx.oasdiff,
      changes: changes.tracked,
      responseSummary: changes.responseSummary,
    };
    state.history.push({ ...rev, base: base.sha, tracked: changes.tracked.length, responseChanges: changes.responseCount });
    if (changes.tracked.length || changes.responseCount) {
      await writeJson(path.join(commitDir, `${rev.date.slice(0, 10)}-${rev.sha.slice(0, 10)}.json`), record);
    }
  }
  state.history.sort((/** @type {any} */ a, /** @type {any} */ b) => Date.parse(b.date) - Date.parse(a.date));

  // 2. Net change over fixed windows: the diff between the spec as it was N days ago and now.
  //    Net diffs exclude changes that were later reverted.
  const feed = await loadCommitRecords(commitDir);
  state.windows = {};
  /** @type {Set<string>} */
  const opSnapshots = new Set([head.sha]);
  for (const days of WINDOWS) {
    const until = new Date(ctx.now.getTime() - days * 86400e3).toISOString();
    const base = await commitAtOrBefore(spec.repo, spec.branch, spec.file, until);
    const windowPath = path.join(dataDir, 'changes', spec.id, `window-${days}d.json`);
    if (!base) {
      ctx.log(`[${spec.id}] no snapshot ${days} days back; window skipped`);
      state.windows[`${days}d`] = null;
      continue;
    }
    opSnapshots.add(base.sha);
    const net = base.sha === head.sha ? { tracked: [], responseSummary: {}, responseCount: 0 } : await diffPair(spec, base, head, ctx);
    for (const change of net.tracked) change.introducedIn = attribute(change, feed);
    await writeJson(windowPath, {
      specId: spec.id,
      days,
      base,
      revision: head,
      compareUrl: compareUrl(spec.repo, base.sha, head.sha),
      oasdiff: ctx.oasdiff,
      generatedAt: ctx.now.toISOString(),
      changes: net.tracked,
      responseSummary: net.responseSummary,
    });
    state.windows[`${days}d`] = { base, tracked: net.tracked.length, responseChanges: net.responseCount };
  }

  // 3. Operation index: every operation present in the head snapshot or any window base,
  //    so raw HTTP calls to removed endpoints can still be resolved.
  /** @type {Map<string, {method: string, path: string, operationId: string|null, deprecated: boolean, inHead: boolean}>} */
  const ops = new Map();
  for (const sha of opSnapshots) {
    const doc = JSON.parse(await readFile(await fetchSpec(spec, sha, ctx.cacheDir), 'utf8'));
    for (const [p, item] of Object.entries(doc.paths ?? {})) {
      for (const m of HTTP_METHODS) {
        const op = /** @type {any} */ (item)?.[m];
        if (!op) continue;
        const key = opKey(m, p);
        const existing = ops.get(key);
        const inHead = sha === head.sha;
        if (existing) {
          if (inHead) Object.assign(existing, { path: p, operationId: op.operationId ?? null, deprecated: Boolean(op.deprecated), inHead: true });
          continue;
        }
        ops.set(key, { method: m.toUpperCase(), path: p, operationId: op.operationId ?? null, deprecated: Boolean(op.deprecated), inHead });
      }
    }
    if (sha === head.sha) state.head = { ...head, specVersion: doc.info?.version ?? null };
  }
  await writeJson(path.join(dataDir, 'operations', `${spec.id}.json`), {
    specId: spec.id,
    snapshots: [...opSnapshots],
    operations: [...ops.values()].sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method)),
  });

  state.repo = spec.repo;
  state.file = spec.file;
  state.updatedAt = ctx.now.toISOString();
  await writeJson(statePath, state);
  return { head: head.sha, newCommits: chain.length - 1 - start, windows: state.windows };
}

/**
 * @param {SpecSource} spec
 * @param {Commit} base
 * @param {Commit} rev
 * @param {{cacheDir: string}} ctx
 */
async function diffPair(spec, base, rev, ctx) {
  const [a, b] = await Promise.all([fetchSpec(spec, base.sha, ctx.cacheDir), fetchSpec(spec, rev.sha, ctx.cacheDir)]);
  const entries = await changelog(a, b);
  const baseDoc = JSON.parse(await readFile(a, 'utf8'));
  const revDoc = JSON.parse(await readFile(b, 'utf8'));
  /** @type {PublishedChange[]} */
  const tracked = [];
  /** @type {Record<string, {method: string, path: string, count: number, rules: Record<string, number>}>} */
  const responseSummary = {};
  let responseCount = 0;
  /** @type {Set<string>} */
  const seen = new Set();
  for (const e of entries) {
    const c = classify(e);
    if (!c) continue;
    if (c.kind === 'response-changed') {
      responseCount++;
      const k = opKey(c.method, c.path);
      const s = (responseSummary[k] ??= { method: c.method, path: c.path, count: 0, rules: {} });
      s.count++;
      s.rules[c.rule] = (s.rules[c.rule] ?? 0) + 1;
      continue;
    }
    const key = `${c.rule}|${opKey(c.method, c.path)}|${c.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sha = c.source?.side === 'revision' ? rev.sha : base.sha;
    tracked.push({
      ...c,
      verification: verifyChange(c, baseDoc, revDoc),
      specId: spec.id,
      key,
      sourceUrl: c.source ? blobUrl(spec.repo, sha, spec.file, c.source.line) : null,
      compareUrl: compareUrl(spec.repo, base.sha, rev.sha),
      introducedIn: { sha: rev.sha, date: rev.date, message: rev.message, compareUrl: compareUrl(spec.repo, base.sha, rev.sha) },
    });
  }
  return { tracked, responseSummary, responseCount };
}

/**
 * Find the upstream commit that introduced a net change, from the per-commit feed.
 * Returns null when the change predates the feed history; the window's compare link
 * still covers it.
 * @param {PublishedChange} change
 * @param {any[]} feed
 */
function attribute(change, feed) {
  for (const record of feed) {
    if (record.changes.some((/** @type {PublishedChange} */ c) => c.key === change.key)) {
      return { sha: record.revision.sha, date: record.revision.date, message: record.revision.message, compareUrl: record.compareUrl };
    }
  }
  return null;
}

/** @param {string} dir */
async function loadCommitRecords(dir) {
  /** @type {any[]} */
  const out = [];
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const n of names.sort()) if (n.endsWith('.json')) out.push(await readJson(path.join(dir, n)));
  return out;
}

/**
 * Download a spec file at a commit into the cache (content-addressed by SHA, so cache
 * entries never go stale).
 * @param {SpecSource} spec
 * @param {string} sha
 * @param {string} cacheDir
 */
async function fetchSpec(spec, sha, cacheDir) {
  const file = path.join(cacheDir, spec.id, `${sha}.json`);
  try {
    if ((await stat(file)).size > 0) return file;
  } catch {
    // not cached yet
  }
  const url = rawUrl(spec.repo, sha, spec.file);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const text = await res.text();
  JSON.parse(text); // fail loudly on a truncated or non-JSON download
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

/** @param {string} file */
export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * @param {string} file
 * @param {unknown} value
 */
export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 1)}\n`);
}
