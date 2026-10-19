import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assess } from '../src/match.js';
import { matchPath, pathShape } from '../src/paths.js';
import { parseJsonc } from '../src/scan/modules.js';

/** @param {any} fields @param {boolean} [complete] */
const tree = (fields, complete = true) => ({ complete, fields });
const field = (value = null, child = null) => ({ line: 1, value, child });

/** @param {any} params */
const call = (params) => /** @type {any} */ ({
  file: 'a.ts', line: 3, column: 1, snippet: '', via: 'sdk', client: 'openai-node', sdkMethod: 'images.generate', provider: 'openai', specId: 'openai',
  status: 'resolved', reason: null, operation: { method: 'POST', path: '/images/generations', operationId: null, inSpec: true }, params, mapSource: null,
});

/** @param {any} over */
const change = (over) => /** @type {any} */ ({
  rule: 'x', level: 3, text: '', method: 'POST', path: '/images/generations', operationId: null, source: null, specId: 'openai', key: 'k',
  sourceUrl: null, compareUrl: '', introducedIn: null, verification: { status: 'verified', reason: '' }, target: null, ...over,
});

const required = (status = 'verified') => change({ kind: 'request-field-required', verification: { status, reason: '' }, target: { location: 'body', path: ['model'], viaArray: false, raw: 'model' } });

test('new required field: missing from a complete literal is confirmed', () => {
  assert.equal(assess(call(tree({ prompt: field('a cat') })), required())?.level, 'confirmed');
});

test('new required field: present means no finding', () => {
  assert.equal(assess(call(tree({ prompt: field('x'), model: field('gpt-image-1') })), required()), null);
});

test('new required field: spread or unknown params is only possible', () => {
  assert.equal(assess(call(tree({ prompt: field('x') }, false)), required())?.level, 'possible');
  assert.equal(assess(call(null), required())?.level, 'possible');
});

test('unverified change never becomes confirmed', () => {
  assert.equal(assess(call(tree({ prompt: field('x') })), required('unverified'))?.level, 'possible');
});

test('refuted change is never matched', () => {
  assert.equal(assess(call(tree({})), required('refuted')), null);
});

test('nested required field only applies when its parent is sent', () => {
  const c = change({ kind: 'request-field-required', target: { location: 'body', path: ['subscription_details', 'billing_cycle_anchor', 'type'], viaArray: false, raw: '' } });
  assert.equal(assess(call(tree({ customer: field('c') })), c), null);
  const withParent = tree({ subscription_details: field(null, tree({ billing_cycle_anchor: field(null, tree({ unit: field('month') })) })) });
  assert.equal(assess(call(withParent), c)?.level, 'confirmed');
});

test('enum value removed: confirmed only for the same literal', () => {
  const c = change({ kind: 'request-enum-value-removed', target: { location: 'body', path: ['quality'], viaArray: false, raw: 'quality', value: 'hd' } });
  assert.equal(assess(call(tree({ quality: field('hd') })), c)?.level, 'confirmed');
  assert.equal(assess(call(tree({ quality: field('low') })), c), null);
  assert.equal(assess(call(tree({ quality: field(null) })), c)?.level, 'possible');
});

test('removed field: confirmed when sent, nothing when provably absent', () => {
  const c = change({ kind: 'request-field-removed', target: { location: 'body', path: ['user'], viaArray: false, raw: 'user' } });
  assert.equal(assess(call(tree({ user: field('u1') })), c)?.level, 'confirmed');
  assert.equal(assess(call(tree({ prompt: field('p') })), c), null);
});

test('removed endpoint is confirmed for any resolved call', () => {
  assert.equal(assess(call(null), change({ kind: 'endpoint-removed' }))?.level, 'confirmed');
});

test('deprecated field only reported when sent', () => {
  const c = change({ kind: 'request-field-deprecated', target: { location: 'body', path: ['user'], viaArray: false, raw: 'user' } });
  assert.equal(assess(call(tree({ user: field('u') })), c)?.level, 'deprecated');
  assert.equal(assess(call(null), c), null);
});

test('matchPath prefers literal segments and reports ties as ambiguous', () => {
  const templates = ['/v1/customers/{customer}', '/v1/customers/search', '/2010-04-01/Accounts/{AccountSid}/Messages/{Sid}.json'];
  assert.deepEqual(matchPath('/v1/customers/search', templates), { template: '/v1/customers/search' });
  assert.deepEqual(matchPath('/v1/customers/{}', templates), { template: '/v1/customers/{customer}' });
  assert.deepEqual(matchPath('/2010-04-01/Accounts/{}/Messages/{}.json', templates), { template: '/2010-04-01/Accounts/{AccountSid}/Messages/{Sid}.json' });
  assert.equal(matchPath('/v1/nothing', templates), null);
  // A runtime value never matches a literal template segment.
  assert.equal(matchPath('/{}/{}', ['/x/{a}']), null);
  assert.ok('ambiguous' in /** @type {any} */ (matchPath('/a/b', ['/a/{x}', '/{y}/b'])));
});

test('pathShape ignores parameter names', () => {
  assert.equal(pathShape('/v1/customers/{customer}/sources/{id}'), pathShape('/v1/customers/{}/sources/{}'));
});

test('parseJsonc handles comments and trailing commas without touching strings', () => {
  assert.deepEqual(parseJsonc('{ // c\n "a": "http://x", /* b */ "b": [1,], }'), { a: 'http://x', b: [1] });
});
