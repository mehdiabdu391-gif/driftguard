import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/cli.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let dataDir = '';

// SDK maps and operation indexes are frozen copies of ones generated from the real SDKs
// and specs. Change windows are frozen copies of real tracker records so the expected
// findings do not move as upstream specs change:
//   - Stripe removed `payment_method_types` from POST /v1/checkout/sessions (verified)
//   - OpenAI made `model` required on POST /images/generations (verified)
//   - oasdiff reported OpenAI's `quality: "high"` as removed; the verifier refuted it
before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'drift-data-'));
  for (const d of ['sdk-maps', 'operations', 'changes']) {
    await cp(path.join(here, 'fixtures', d), path.join(dataDir, d), { recursive: true });
  }
});

/** @param {any} report */
const brief = (report) => report.findings.map((f) => `${f.level} ${f.call.file}:${f.call.line} ${f.change.kind}${f.change.target ? ` ${f.change.target.raw}` : ''}`).sort();

test('TypeScript app: cross-file clients, aliases, factories, fetch and axios', async () => {
  const r = await scan(path.join(here, 'fixtures', 'js-app'), { dataDir, windowDays: 90 });
  assert.deepEqual(brief(r), [
    'confirmed src/checkout.ts:17 request-field-required model',
    'confirmed src/checkout.ts:19 request-field-required model',
    'confirmed src/checkout.ts:8 request-field-removed payment_method_types',
  ]);
  const sites = Object.fromEntries(r.callSites.map((s) => [`${s.line}`, s]));
  assert.equal(sites['8'].operation?.path, '/v1/checkout/sessions');
  assert.equal(sites['8'].apiVersion, '2025-01-27.acacia');
  assert.equal(sites['14'].sdkMethod, 'customers.update'); // via getStripe() factory
  assert.equal(sites['14'].params?.complete, false); // spread: never claims absence
  assert.equal(sites['15'].status, 'unresolved'); // accounts.retrieve hits one of two endpoints
  assert.equal(sites['18'].operation?.path, '/chat/completions');
  assert.equal(sites['20'].operation?.path, '/v1/customers/{customer}'); // raw fetch, concatenated id
  assert.equal(sites['21'].operation?.path, '/repos/{owner}/{repo}/issues'); // axios to GitHub
  assert.ok(!r.callSites.some((s) => s.snippet.includes('example.com'))); // non-provider hosts ignored
  assert.ok(!r.callSites.some((s) => s.snippet.includes('constructEvent'))); // local SDK helpers are not API calls
});

test('Python app: module style, StripeClient, imported client, requests', async () => {
  const r = await scan(path.join(here, 'fixtures', 'py-app'), { dataDir, windowDays: 90 });
  assert.deepEqual(brief(r), [
    'confirmed app/billing.py:12 request-field-removed payment_method_types',
    'confirmed app/billing.py:16 request-field-required model',
  ]);
  const ops = r.callSites.map((s) => `${s.line} ${s.status} ${s.operation?.method ?? ''} ${s.operation?.path ?? ''}`);
  assert.deepEqual(ops, [
    '11 resolved POST /v1/customers',
    '12 resolved POST /v1/checkout/sessions',
    '13 resolved GET /v1/customers/{customer}',
    '14 resolved POST /v1/customers',
    '16 resolved POST /images/generations',
    '17 resolved POST /chat/completions',
    '18 resolved POST /images/generations',
    '19 resolved GET /repos/{owner}/{repo}/pulls',
  ]);
});

test('refuted spec claims never produce findings', async () => {
  const r = await scan(path.join(here, 'fixtures', 'js-app'), { dataDir, windowDays: 90 });
  assert.ok(!r.findings.some((f) => f.change.verification.status === 'refuted'));
});

test('one CLI run writes the markdown report and the JSON report', async () => {
  const { main } = await import('../src/cli.js');
  const out = await mkdtemp(path.join(tmpdir(), 'drift-out-'));
  const md = path.join(out, 'drift.md');
  const json = path.join(out, 'drift.json');
  const code = await main(['scan', path.join(here, 'fixtures', 'js-app'), '--data', dataDir, '--format', 'markdown', '--output', md, '--json-output', json]);
  assert.equal(code, 1, 'confirmed findings fail by default');
  const report = JSON.parse(await readFile(json, 'utf8'));
  assert.equal(report.summary.confirmed, 3);
  assert.match(await readFile(md, 'utf8'), /payment_method_types/);
});
