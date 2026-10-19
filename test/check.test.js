import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkData } from '../src/tracker/check.js';
import { SPECS, SDKS, WINDOWS } from '../src/providers.js';

/** @param {string} file @param {unknown} json */
async function put(file, json) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(json));
}

/** A complete data directory. `noWindow` maps spec id -> window days the tracker recorded as null. */
async function complete(noWindow = /** @type {Record<string, number[]>} */ ({})) {
  const dir = await mkdtemp(path.join(tmpdir(), 'drift-check-'));
  for (const spec of SPECS) {
    const skipped = noWindow[spec.id] ?? [];
    const windows = Object.fromEntries(WINDOWS.map((d) => [`${d}d`, skipped.includes(d) ? null : { tracked: 0 }]));
    await put(path.join(dir, 'specs', `${spec.id}.json`), { id: spec.id, head: { sha: 'abc' }, windows });
    await put(path.join(dir, 'operations', `${spec.id}.json`), { specId: spec.id, operations: [{ method: 'GET', path: '/x' }] });
    for (const d of WINDOWS.filter((x) => !skipped.includes(x))) {
      await put(path.join(dir, 'changes', spec.id, `window-${d}d.json`), { specId: spec.id, days: d, changes: [] });
    }
    if (spec.versionHistory) {
      await put(path.join(dir, 'versions', `${spec.id}.json`), { specId: spec.id, head: { sha: 'abc' }, versions: [{ version: '2023-10-16', first: { sha: 'abc' }, last: { sha: 'abc' } }] });
    }
  }
  for (const sdk of SDKS.filter((s) => s.mapped)) await put(path.join(dir, 'sdk-maps', `${sdk.id}.json`), { methods: { a: 1 } });
  return dir;
}

test('complete data passes, including quiet specs with no changes', async () => {
  assert.deepEqual(await checkData(await complete()), []);
});

test('a window the tracker recorded as null is not required', async () => {
  assert.deepEqual(await checkData(await complete({ openai: [180] })), []);
});

test('a missing window file the tracker did not skip is reported', async () => {
  const dir = await complete();
  await rm(path.join(dir, 'changes', 'stripe', 'window-30d.json'));
  assert.deepEqual(await checkData(dir), ['changes/stripe/window-30d.json: missing']);
});

test('an empty operation index is reported', async () => {
  const dir = await complete();
  await put(path.join(dir, 'operations', 'openai.json'), { specId: 'openai', operations: [] });
  assert.deepEqual(await checkData(dir), ['operations/openai.json: empty operation index']);
});

test('a spec with every window null is reported', async () => {
  const dir = await complete({ github: [...WINDOWS] });
  assert.deepEqual(await checkData(dir), ['specs/github.json: no change window was produced']);
});

test('a malformed or missing file is reported without throwing', async () => {
  const dir = await complete();
  await writeFile(path.join(dir, 'specs', 'stripe.json'), '{not json');
  await rm(path.join(dir, 'sdk-maps', 'octokit.json'));
  const problems = await checkData(dir);
  assert.ok(problems.includes('specs/stripe.json: unreadable or invalid JSON'));
  assert.ok(problems.includes('sdk-maps/octokit.json: missing'));
});

test('a missing or empty version index is reported', async () => {
  const dir = await complete();
  await put(path.join(dir, 'versions', 'stripe.json'), { specId: 'stripe', head: { sha: 'abc' }, versions: [] });
  assert.deepEqual(await checkData(dir), ['versions/stripe.json: malformed version index']);
  await rm(path.join(dir, 'versions', 'stripe.json'));
  assert.deepEqual(await checkData(dir), ['versions/stripe.json: missing']);
});
