import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionRuns, findVersion, updateVersionIndex, fetchVersion } from '../src/tracker/versions.js';
import { operationChanges, upgradeChanges, bodyFields, loadSnapshot } from '../src/upgrade.js';
import { upgrade, main } from '../src/cli.js';
import { specById } from '../src/providers.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @param {string} sha @param {string} date */
const commit = (sha, date) => ({ sha, date, message: 'Update OpenAPI specification' });

// ---------------------------------------------------------------------------------------
// Version index

test('versionRuns groups consecutive snapshots and keeps re-published versions as separate runs', async () => {
  // Shape taken from Stripe's real history: 2024-11-20.acacia was re-published on
  // 2024-12-13 between two 2024-12-18.acacia snapshots.
  const chain = ['a', 'b', 'c', 'd', 'e', 'f'].map((s, i) => commit(s, `2024-12-0${i + 1}T00:00:00Z`));
  const labels = { a: '2024-11-20.acacia', b: '2024-11-20.acacia', c: '2024-12-18.acacia', d: '2024-11-20.acacia', e: '2024-12-18.acacia', f: '2025-01-27.acacia' };
  const runs = await versionRuns(chain, async (c) => labels[/** @type {keyof typeof labels} */ (c.sha)], 3);
  assert.deepEqual(runs.map((r) => `${r.version}:${r.first.sha}-${r.last.sha}`), [
    '2024-11-20.acacia:a-b',
    '2024-12-18.acacia:c-c',
    '2024-11-20.acacia:d-d',
    '2024-12-18.acacia:e-e',
    '2025-01-27.acacia:f-f',
  ]);
  const index = /** @type {any} */ ({ versions: runs });
  assert.equal(findVersion(index, '2024-11-20.acacia')?.last.sha, 'd', 'the last published snapshot of a version wins');
  assert.equal(findVersion(index, '2024-12-18')?.last.sha, 'e', 'a bare date matches the one named version of that date');
  assert.equal(findVersion(index, '2023-10-16'), null, 'unknown versions are not guessed');
});

test('findVersion refuses a date shared by two differently named versions', () => {
  const index = /** @type {any} */ ({ versions: [
    { version: '2025-01-01.a', first: commit('x', ''), last: commit('x', '') },
    { version: '2025-01-01.b', first: commit('y', ''), last: commit('y', '') },
  ] });
  assert.equal(findVersion(index, '2025-01-01'), null);
  assert.equal(findVersion(index, '2025-01-01.b')?.last.sha, 'y');
});

test('updateVersionIndex builds once, then reads only new snapshots', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'drift-ver-'));
  const spec = specById('stripe');
  /** @type {Record<string, string>} */
  const labels = { c1: '2023-08-16', c2: '2023-10-16', c3: '2023-10-16', c4: '2024-04-10', c5: '2024-04-10' };
  let history = ['c3', 'c2', 'c1'].map((s) => commit(s, '2024-01-01T00:00:00Z'));
  /** @type {string[]} */
  let read = [];
  const opts = {
    log: () => {},
    versionOf: async (/** @type {any} */ c) => { read.push(c.sha); return labels[c.sha]; },
    commits: async (/** @type {string | undefined} */ stopAt) => {
      const i = stopAt ? history.findIndex((c) => c.sha === stopAt) : -1;
      return i >= 0 ? history.slice(0, i + 1) : history;
    },
  };
  const first = await updateVersionIndex(spec, dataDir, opts);
  assert.deepEqual(first?.versions.map((v) => `${v.version}:${v.last.sha}`), ['2023-08-16:c1', '2023-10-16:c3']);
  assert.deepEqual(read.sort(), ['c1', 'c2', 'c3']);

  read = [];
  assert.equal((await updateVersionIndex(spec, dataDir, opts))?.head.sha, 'c3');
  assert.deepEqual(read, [], 'nothing is read when the head has not moved');

  history = [commit('c5', ''), commit('c4', ''), ...history];
  const extended = await updateVersionIndex(spec, dataDir, opts);
  assert.deepEqual(read.sort(), ['c3', 'c4', 'c5'], 'only the old head and newer snapshots are read');
  assert.deepEqual(extended?.versions.map((v) => `${v.version}:${v.first.sha}-${v.last.sha}`), ['2023-08-16:c1-c1', '2023-10-16:c2-c3', '2024-04-10:c4-c5']);
  const onDisk = JSON.parse(await readFile(path.join(dataDir, 'versions', 'stripe.json'), 'utf8'));
  assert.equal(onDisk.file, 'openapi/spec3.json');
  assert.equal(onDisk.head.sha, 'c5');
});

test('fetchVersion reads the top-level info.version, not a nested "version" key', async () => {
  const doc = {
    components: { schemas: { thing: { properties: { version: { type: 'string' }, info: { type: 'object' } } } } },
    info: { contact: { name: 'x', version: 'not-this' }, title: 'Stripe API', version: '2023-10-16' },
    openapi: '3.0.0',
    paths: {},
  };
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async () => new Response(JSON.stringify(doc, null, 2)));
  try {
    assert.equal(await fetchVersion('stripe/openapi', 'openapi/spec3.json', commit('s', '')), '2023-10-16');
    // Not pretty-printed: falls back to a full parse.
    globalThis.fetch = /** @type {any} */ (async () => new Response(JSON.stringify(doc)));
    assert.equal(await fetchVersion('stripe/openapi', 'openapi/spec3.json', commit('s', '')), '2023-10-16');
  } finally {
    globalThis.fetch = real;
  }
});

// ---------------------------------------------------------------------------------------
// Per-operation comparison

/** @param {any} schema @param {any[]} [params] */
const docWith = (schema, params = []) => ({
  paths: {
    '/v1/checkout/sessions': {
      post: { operationId: 'PostCheckoutSessions', requestBody: { content: { 'application/x-www-form-urlencoded': { schema } } } },
      get: { operationId: 'GetCheckoutSessions', parameters: params },
    },
    '/v1/sources/{source}': { post: { operationId: 'PostSourcesSource' } },
  },
});

const baseDoc = docWith(
  {
    type: 'object',
    required: ['mode'],
    properties: {
      mode: { type: 'string', enum: ['payment', 'setup', 'subscription'] },
      payment_method_types: { type: 'array', items: { type: 'string', enum: ['card', 'giropay', 'sofort'] } },
      customer: { type: 'string' },
      shipping: { type: 'object', properties: { carrier: { type: 'string' }, legacy: { type: 'object', properties: { code: { type: 'string' } } } } },
    },
  },
  [{ in: 'query', name: 'customer', schema: { type: 'string' } }, { in: 'query', name: 'status', schema: { type: 'string', enum: ['open', 'expired'] } }],
);
const targetDoc = docWith(
  {
    type: 'object',
    required: ['mode', 'ui_mode'],
    properties: {
      mode: { anyOf: [{ type: 'string', enum: ['payment', 'subscription'] }] },
      customer: { type: 'string', deprecated: true },
      ui_mode: { type: 'string' },
      shipping: { type: 'object', properties: { carrier: { type: 'string' } } },
    },
  },
  [{ in: 'query', name: 'status', required: true, schema: { type: 'string', enum: ['open'] } }],
);
delete targetDoc.paths['/v1/sources/{source}'];

test('bodyFields follows combinators and array items and marks requirement', () => {
  const f = bodyFields(baseDoc, baseDoc.paths['/v1/checkout/sessions'].post);
  assert.deepEqual([...f.keys()].sort(), ['customer', 'mode', 'payment_method_types', 'shipping', 'shipping/carrier', 'shipping/legacy', 'shipping/legacy/code']);
  assert.equal(f.get('mode')?.required, true);
  assert.equal(f.get('customer')?.required, false);
});

test('operationChanges: body, parameters and operations', () => {
  const brief = (/** @type {any[]} */ cs) => cs.map((c) => `${c.kind} ${c.target ? `${c.target.location}:${c.target.raw}${c.target.value ? `=${c.target.value}` : ''}` : ''}`.trim()).sort();
  assert.deepEqual(brief(operationChanges(baseDoc, targetDoc, 'POST', '/v1/checkout/sessions')), [
    'request-enum-value-removed body:mode=setup',
    'request-field-deprecated body:customer',
    'request-field-removed body:payment_method_types',
    'request-field-removed body:shipping/legacy', // children of a removed property are not repeated
    'request-field-required body:ui_mode',
  ]);
  assert.deepEqual(brief(operationChanges(baseDoc, targetDoc, 'GET', '/v1/checkout/sessions')), [
    'request-enum-value-removed query:status=expired',
    'request-field-removed query:customer',
    'request-field-required query:status',
  ]);
  assert.deepEqual(brief(operationChanges(baseDoc, targetDoc, 'POST', '/v1/sources/{id}')), ['endpoint-removed'], 'matched by path shape');
  assert.deepEqual(operationChanges(targetDoc, baseDoc, 'POST', '/v1/sources/{id}'), [], 'an operation newer than the pinned version is not a break');
});

test('upgradeChanges verifies every change and tags the upgrade it belongs to', () => {
  const side = { specId: 'stripe', repo: 'stripe/openapi', file: 'openapi/spec3.json', from: { version: '2023-10-16', sha: 'aaa' }, to: { version: '2026-09-30.endive', sha: 'bbb' } };
  const ops = [{ method: 'POST', path: '/v1/checkout/sessions' }, { method: 'POST', path: '/v1/checkout/sessions' }];
  const changes = upgradeChanges(baseDoc, targetDoc, ops, side);
  assert.equal(changes.length, 5, 'an operation called twice is compared once');
  for (const c of changes) {
    assert.equal(c.compareUrl, 'https://github.com/stripe/openapi/compare/aaa...bbb');
    assert.deepEqual(c.upgrade, { from: '2023-10-16', to: '2026-09-30.endive' });
    assert.notEqual(c.verification.status, 'refuted');
  }
  assert.equal(changes.find((c) => c.kind === 'request-field-removed')?.verification.status, 'verified');
});

test('loadSnapshot downloads a SHA once', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'drift-snap-'));
  let calls = 0;
  const fake = /** @type {any} */ (async () => { calls++; return new Response('{"info":{"version":"x"}}'); });
  assert.equal((await loadSnapshot('stripe/openapi', 'openapi/spec3.json', 'abc', cacheDir, fake)).info.version, 'x');
  await loadSnapshot('stripe/openapi', 'openapi/spec3.json', 'abc', cacheDir, fake);
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------------------
// End to end: `drift upgrade` on a small app

let dataDir = '';
let appDir = '';
/** @type {Record<string, any>} */
const snapshots = { oldsha: baseDoc, newsha: targetDoc, midsha: targetDoc };
const fakeFetch = /** @type {any} */ (async (/** @type {string} */ url) => {
  const sha = url.split('/')[5];
  return snapshots[sha] ? new Response(JSON.stringify(snapshots[sha])) : new Response('missing', { status: 404 });
});

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'drift-updata-'));
  for (const d of ['sdk-maps', 'operations']) await cp(path.join(here, 'fixtures', d), path.join(dataDir, d), { recursive: true });
  await mkdir(path.join(dataDir, 'versions'));
  await writeFile(path.join(dataDir, 'versions', 'stripe.json'), JSON.stringify({
    specId: 'stripe', repo: 'stripe/openapi', branch: 'master', file: 'openapi/spec3.json', head: commit('newsha', '2026-09-29T00:00:00Z'),
    versions: [
      { version: '2023-10-16', first: commit('oldsha', ''), last: commit('oldsha', '') },
      { version: '2025-03-31.basil', first: commit('midsha', ''), last: commit('midsha', '') },
      { version: '2026-09-30.endive', first: commit('newsha', ''), last: commit('newsha', '') },
    ],
  }));
  appDir = await mkdtemp(path.join(tmpdir(), 'drift-app-'));
  await writeFile(path.join(appDir, 'pay.js'), [
    "import Stripe from 'stripe';",
    "const pinned = new Stripe(process.env.STRIPE_KEY, { apiVersion: '2023-10-16' });",
    'export async function pay() {',
    '  return pinned.checkout.sessions.create({',
    "    mode: 'payment',",
    "    ui_mode: 'hosted',",
    "    payment_method_types: ['card'],",
    '  });',
    '}',
    'const loose = new Stripe(process.env.STRIPE_KEY);',
    'export async function list() {',
    "  return loose.checkout.sessions.list({ status: 'open' });",
    '}',
    "const odd = new Stripe(process.env.STRIPE_KEY, { apiVersion: '2019-01-01' });",
    'export async function other() {',
    "  return odd.checkout.sessions.create({ mode: 'setup', ui_mode: 'hosted' });",
    '}',
    '',
  ].join('\n'));
});

const brief = (/** @type {any} */ r) => r.findings.map((/** @type {any} */ f) => `${f.level} ${f.call.file}:${f.call.line} ${f.change.kind}${f.change.target ? ` ${f.change.target.raw}` : ''}`).sort();

test('drift upgrade uses each client pin and lists calls it cannot place', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'drift-cache-'));
  const r = await upgrade(appDir, { dataDir, cacheDir, fetch: fakeFetch });
  assert.deepEqual(brief(r), ['confirmed pay.js:4 request-field-removed payment_method_types']);
  assert.deepEqual(r.upgrade?.compared.map((g) => `${g.from}:${g.calls}`), ['2023-10-16:1']);
  assert.deepEqual(r.upgrade?.skipped.map((s) => `${s.file}:${s.line}`), ['pay.js:12', 'pay.js:16']);
  assert.match(r.upgrade?.skipped[0].reason ?? '', /--from/);
  assert.match(r.upgrade?.skipped[1].reason ?? '', /2019-01-01/);
});

test('drift upgrade --from overrides pins; --to picks the target', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'drift-cache-'));
  const r = await upgrade(appDir, { dataDir, cacheDir, fetch: fakeFetch, from: '2023-10-16', to: '2025-03-31' });
  assert.equal(r.upgrade?.to.version, '2025-03-31.basil');
  // pay.js:12 sends `status: 'open'`, which became required and is still accepted: no finding.
  assert.deepEqual(brief(r), [
    'confirmed pay.js:16 request-enum-value-removed mode',
    'confirmed pay.js:4 request-field-removed payment_method_types',
  ]);
  assert.deepEqual(r.upgrade?.skipped, []);
});

test('drift upgrade rejects versions Stripe never published', async () => {
  await assert.rejects(upgrade(appDir, { dataDir, from: '2020-02-02', fetch: fakeFetch }), /--from 2020-02-02 is not an API version/);
  await assert.rejects(upgrade(appDir, { dataDir, to: '2099-01-01', fetch: fakeFetch }), /--to 2099-01-01 is not an API version/);
});

test('drift upgrade CLI writes markdown and fails on confirmed', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'drift-out-'));
  // Seed the default cache location through XDG_CACHE_HOME so the CLI never downloads.
  const cacheHome = await mkdtemp(path.join(tmpdir(), 'drift-xdg-'));
  for (const sha of ['oldsha', 'newsha']) {
    await mkdir(path.join(cacheHome, 'driftguard', 'specs', 'stripe__openapi'), { recursive: true });
    await writeFile(path.join(cacheHome, 'driftguard', 'specs', 'stripe__openapi', `${sha}.json`), JSON.stringify(snapshots[sha]));
  }
  const prev = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cacheHome;
  try {
    const md = path.join(out, 'r.md');
    const json = path.join(out, 'r.json');
    const code = await main(['upgrade', appDir, '--data', dataDir, '--format', 'markdown', '--output', md, '--json-output', json]);
    assert.equal(code, 1);
    const text = await readFile(md, 'utf8');
    assert.match(text, /Stripe API upgrade check/);
    assert.match(text, /upgrade from 2023-10-16 to 2026-09-30\.endive/);
    assert.match(text, /Not checked \(2\)/);
    assert.match(text, /response schemas/);
    const report = JSON.parse(await readFile(json, 'utf8'));
    assert.equal(report.upgrade.to.sha, 'newsha');
    assert.deepEqual(report.findings[0].change.upgrade, { from: '2023-10-16', to: '2026-09-30.endive' });
  } finally {
    if (prev === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prev;
  }
});

test('a client from a dynamic import is detected (const { default: Stripe } = await import("stripe"))', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'drift-dyn-'));
  await writeFile(path.join(dir, 'route.ts'), [
    'export async function POST() {',
    "  const { default: Stripe } = await import('stripe');",
    "  const stripe = new Stripe(process.env.KEY!, { apiVersion: '2023-10-16' });",
    "  return stripe.checkout.sessions.create({ mode: 'payment', ui_mode: 'hosted', payment_method_types: ['card'] });",
    '}',
    '',
  ].join('\n'));
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'drift-cache-'));
  const r = await upgrade(dir, { dataDir, cacheDir, fetch: fakeFetch });
  assert.deepEqual(brief(r), ['confirmed route.ts:4 request-field-removed payment_method_types']);
});

test('an unknown --fail-on value is an error, not a silent default', async () => {
  await assert.rejects(main(['upgrade', appDir, '--data', dataDir, '--fail-on', 'none']), /--fail-on must be/);
});

/**
 * @param {string} name
 * @param {string[]} lines
 */
async function appWith(name, lines) {
  const dir = await mkdtemp(path.join(tmpdir(), `drift-${name}-`));
  await writeFile(path.join(dir, 'stripe.ts'), [...lines, ''].join('\n'));
  return dir;
}

const LAZY = [
  "import Stripe from 'stripe'",
  'let stripeInstance: Stripe | null = null',
  'function getStripe(): Stripe {',
  '  if (!stripeInstance) {',
  "    stripeInstance = new Stripe(process.env.KEY!, { apiVersion: '2023-10-16' })",
  '  }',
  '  return stripeInstance',
  '}',
  'export function getStripeInstance(): Stripe {',
  '  return getStripe()',
  '}',
];

test('a pin set inside a lazy getter reaches calls through nested factories', async () => {
  const dir = await appWith('lazy', [
    ...LAZY,
    'export async function pay() {',
    '  const client = getStripeInstance()',
    "  return client.checkout.sessions.create({ mode: 'payment', ui_mode: 'hosted', payment_method_types: ['card'] })",
    '}',
  ]);
  const r = await upgrade(dir, { dataDir, cacheDir: await mkdtemp(path.join(tmpdir(), 'drift-cache-')), fetch: fakeFetch });
  assert.deepEqual(brief(r), ['confirmed stripe.ts:14 request-field-removed payment_method_types']);
  assert.deepEqual(r.upgrade?.skipped, []);
});

test('a client wrapped in a Proxy is detected and takes the pin of the client its handler obtains', async () => {
  const dir = await appWith('proxy', [
    ...LAZY,
    'export const stripe = new Proxy({} as Stripe, {',
    '  get(_target, prop) {',
    '    const instance = getStripe()',
    '    const value = instance[prop as keyof Stripe]',
    "    return typeof value === 'function' ? value.bind(instance) : value",
    '  },',
    '})',
    'export async function pay() {',
    "  return stripe.checkout.sessions.create({ mode: 'payment', ui_mode: 'hosted', payment_method_types: ['card'] })",
    '}',
  ]);
  const r = await upgrade(dir, { dataDir, cacheDir: await mkdtemp(path.join(tmpdir(), 'drift-cache-')), fetch: fakeFetch });
  assert.deepEqual(brief(r), ['confirmed stripe.ts:20 request-field-removed payment_method_types']);
});

test('a Proxy typed as a client but with no visible client keeps the SDK and no pin', async () => {
  const dir = await appWith('proxy-nopin', [
    "import Stripe from 'stripe'",
    'export const stripe = new Proxy({} as Stripe, { get: (_t, p) => (globalThis as any).real[p] })',
    "export const pay = () => stripe.checkout.sessions.create({ mode: 'payment' })",
  ]);
  const r = await upgrade(dir, { dataDir, cacheDir: await mkdtemp(path.join(tmpdir(), 'drift-cache-')), fetch: fakeFetch });
  assert.equal(r.callSites.filter((c) => c.status === 'resolved').length, 1);
  assert.deepEqual(r.upgrade?.skipped.map((s) => s.line), [3]);
});

test('one name assigned clients with two different pins has an unknown pin, never the first one', async () => {
  const dir = await appWith('conflict', [
    "import Stripe from 'stripe'",
    'let stripe: Stripe',
    "if (process.env.LEGACY) stripe = new Stripe('k', { apiVersion: '2023-10-16' })",
    "else stripe = new Stripe('k', { apiVersion: '2026-09-30.endive' })",
    "export const pay = () => stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card'] })",
  ]);
  const r = await upgrade(dir, { dataDir, cacheDir: await mkdtemp(path.join(tmpdir(), 'drift-cache-')), fetch: fakeFetch });
  assert.deepEqual(brief(r), []);
  assert.deepEqual(r.upgrade?.skipped.map((s) => s.line), [5]);
});

test('drift upgrade on a path that does not exist is an error, not a clean report', async () => {
  await assert.rejects(main(['upgrade', path.join(tmpdir(), 'drift-does-not-exist'), '--data', dataDir]), /is not a directory/);
});
