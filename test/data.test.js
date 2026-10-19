import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { resolveDataDir } from '../src/data.js';

/** A real .tar.gz shaped like GitHub's codeload archive of the data branch. */
async function archive() {
  const src = await mkdtemp(path.join(tmpdir(), 'drift-arch-'));
  await mkdir(path.join(src, 'driftguard-data', 'changes', 'stripe'), { recursive: true });
  await writeFile(path.join(src, 'driftguard-data', 'changes', 'stripe', 'window-90d.json'), '{"changes":[]}');
  return new Uint8Array(execFileSync('tar', ['-czf', '-', '-C', src, 'driftguard-data']));
}

/** @param {Uint8Array | null} body @param {string[]} calls */
function fakeFetch(body, calls) {
  return /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {string} */ url) => {
    calls.push(url);
    return body ? new Response(body) : new Response('nope', { status: 404 });
  }));
}

const empty = async () => mkdtemp(path.join(tmpdir(), 'drift-pkg-'));

test('explicit --data and DRIFTGUARD_DATA win over everything else', async () => {
  assert.equal(await resolveDataDir({ explicit: '/x/data', env: { DRIFTGUARD_DATA: '/y' } }), path.resolve('/x/data'));
  assert.equal(await resolveDataDir({ env: { DRIFTGUARD_DATA: '/y' } }), path.resolve('/y'));
});

test('a maintainer checkout with data/changes uses it without downloading', async () => {
  const pkg = await empty();
  await mkdir(path.join(pkg, 'data', 'changes'), { recursive: true });
  const calls = [];
  assert.equal(await resolveDataDir({ env: {}, packageRoot: pkg, fetch: fakeFetch(null, calls) }), path.join(pkg, 'data'));
  assert.equal(calls.length, 0);
});

test('downloads the data branch, caches it, and refreshes it when stale', async () => {
  const cacheDir = await empty();
  const calls = [];
  const opts = { env: {}, packageRoot: await empty(), cacheDir, fetch: fakeFetch(await archive(), calls) };
  const dir = await resolveDataDir(opts);
  assert.equal(calls[0], 'https://codeload.github.com/mehdiabdu391-gif/driftguard/tar.gz/refs/heads/data');
  assert.equal(await readFile(path.join(dir, 'changes', 'stripe', 'window-90d.json'), 'utf8'), '{"changes":[]}');
  await resolveDataDir(opts);
  assert.equal(calls.length, 1, 'fresh cache is reused');
  await resolveDataDir({ ...opts, now: Date.now() + 7 * 3_600_000 });
  assert.equal(calls.length, 2, 'stale cache is refreshed');
});

test('a failed download with no cache is an error, never an empty data set', async () => {
  await assert.rejects(
    resolveDataDir({ env: {}, packageRoot: await empty(), cacheDir: await empty(), fetch: fakeFetch(null, []) }),
    /Could not download DriftGuard data .*HTTP 404/,
  );
});

test('a failed refresh falls back to the existing cache', async () => {
  const cacheDir = await empty();
  const base = { env: {}, packageRoot: await empty(), cacheDir };
  const dir = await resolveDataDir({ ...base, fetch: fakeFetch(await archive(), []) });
  const old = new Date(Date.now() - 8 * 3_600_000);
  await utimes(path.join(dir, '.fetched'), old, old);
  assert.equal(await resolveDataDir({ ...base, fetch: fakeFetch(null, []) }), dir);
});
