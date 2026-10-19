// Where scans read tracker data from.
//
// The tracker publishes its output (spec state, change windows, operation indexes, SDK
// maps) to the `data` branch of the DriftGuard repository as a single commit that is
// replaced on every run, so the code branch never grows with data. A scan uses, in order:
//   1. an explicit directory (`--data`),
//   2. the DRIFTGUARD_DATA environment variable,
//   3. a `data/` directory next to the code (a maintainer checkout),
//   4. a cached download of the `data` branch, refreshed when older than MAX_AGE_MS.
// A failed download with no cache is an error, never an empty data set: scanning against
// no spec changes would silently report a clean result. With an older cache, the scan
// goes ahead on it and says how old it is.

import { mkdir, rm, rename, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_REPO = 'mehdiabdu391-gif/driftguard';
export const DATA_BRANCH = 'data';
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} p */
async function isDir(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} p @returns {Promise<number | null>} */
async function mtimeMs(p) {
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Extract a .tar.gz buffer into a directory, dropping the archive's top-level folder.
 * @param {Uint8Array} archive
 * @param {string} dest
 */
function untar(archive, dest) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', '-', '--strip-components=1', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`tar exited with ${code}: ${stderr.trim()}`))));
    child.stdin.end(archive);
  });
}

/**
 * Download the published data branch into `dir`, replacing what was there.
 * @param {string} dir
 * @param {{fetch?: typeof fetch, repo?: string, branch?: string}} [opts]
 */
export async function downloadData(dir, opts = {}) {
  const repo = opts.repo ?? DATA_REPO;
  const branch = opts.branch ?? DATA_BRANCH;
  const url = `https://codeload.github.com/${repo}/tar.gz/refs/heads/${branch}`;
  /** @type {Uint8Array} */
  let archive;
  try {
    const res = await (opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    archive = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    const why = err instanceof Error && err.name === 'TimeoutError' ? `timed out after ${FETCH_TIMEOUT_MS / 1000} s` : /** @type {Error} */ (err).message;
    throw new Error(`Could not download DriftGuard data from ${url} (${why}). Pass --data <dir> to use a local copy.`);
  }
  const tmp = `${dir}.tmp-${process.pid}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  await untar(archive, tmp);
  if (!(await isDir(path.join(tmp, 'changes')))) throw new Error(`Downloaded data from ${url} has no changes/ directory.`);
  await writeFile(path.join(tmp, '.fetched'), `${new Date().toISOString()}\n`);
  // Swap in the new data without a moment where `dir` is missing: move the old copy
  // aside, rename the new one into place, then delete the old copy.
  await mkdir(path.dirname(dir), { recursive: true });
  const old = `${dir}.old-${process.pid}`;
  await rm(old, { recursive: true, force: true });
  const hadOld = await isDir(dir);
  if (hadOld) await rename(dir, old);
  await rename(tmp, dir);
  if (hadOld) await rm(old, { recursive: true, force: true });
}

/**
 * @param {{explicit?: string, env?: NodeJS.ProcessEnv, packageRoot?: string, cacheDir?: string, now?: number, fetch?: typeof fetch}} [opts]
 * @returns {Promise<string>}
 */
export async function resolveDataDir(opts = {}) {
  if (opts.explicit) return path.resolve(opts.explicit);
  const env = opts.env ?? process.env;
  if (env.DRIFTGUARD_DATA) return path.resolve(env.DRIFTGUARD_DATA);
  const local = path.join(opts.packageRoot ?? PACKAGE_ROOT, 'data');
  if (await isDir(path.join(local, 'changes'))) return local;
  const cacheRoot = opts.cacheDir ?? path.join(env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'driftguard');
  const dir = path.join(cacheRoot, 'data');
  const fetched = await mtimeMs(path.join(dir, '.fetched'));
  const now = opts.now ?? Date.now();
  if (fetched !== null && now - fetched <= MAX_AGE_MS) return dir;
  try {
    await downloadData(dir, { fetch: opts.fetch });
  } catch (err) {
    if (fetched === null) throw err;
    const hours = Math.round((now - fetched) / 3_600_000);
    process.stderr.write(`warning: ${/** @type {Error} */ (err).message}\nwarning: using cached DriftGuard data fetched ${hours} h ago.\n`);
  }
  return dir;
}
