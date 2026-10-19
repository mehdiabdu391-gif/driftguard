import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, extractTarget, genericTarget, normalizePropertyPath, ruleKind } from '../src/tracker/classify.js';
import { verifyChange } from '../src/tracker/verify.js';

// Messages below are copied verbatim from oasdiff 1.34.0 output on real provider specs.

test('request-property-removed names the property', () => {
  const t = extractTarget('request-property-removed', 'removed the request property `spend_control`');
  assert.deepEqual(t, { location: 'body', path: ['spend_control'], viaArray: false, raw: 'spend_control' });
});

test('enum removal: value first, property second, combinators and items stripped', () => {
  const t = extractTarget(
    'request-property-enum-value-removed',
    'removed the enum value `paypay` of the request property `payment_settings/payment_method_types/anyOf[subschema #1]/items/`',
  );
  assert.equal(t?.value, 'paypay');
  assert.deepEqual(t?.path, ['payment_settings', 'payment_method_types']);
  assert.equal(t?.viaArray, true);
});

test('nested new required property', () => {
  const t = extractTarget('new-required-request-property', 'added the new required request property `subscription_details/billing_cycle_anchor/type`');
  assert.deepEqual(t?.path, ['subscription_details', 'billing_cycle_anchor', 'type']);
});

test('type change takes the property from the first argument', () => {
  const t = extractTarget('request-property-type-changed', 'the `subscription_details/billing_cycle_anchor` request property `type` changed from `any` to `object`');
  assert.deepEqual(t?.path, ['subscription_details', 'billing_cycle_anchor']);
});

test('parameter rules carry their location', () => {
  const t = extractTarget('request-parameter-removed', 'deleted the `query` request parameter `limit`');
  assert.deepEqual(t, { location: 'query', path: ['limit'], viaArray: false, raw: 'limit' });
});

test('too few arguments gives no target instead of a guess', () => {
  assert.equal(extractTarget('request-property-enum-value-removed', 'removed the enum value `x`'), null);
});

test('generic fallback reads unlisted rules from their fixed wording', () => {
  assert.deepEqual(genericTarget('request-property-became-not-nullable', 'the request property `best_of` became not nullable')?.path, ['best_of']);
  assert.deepEqual(genericTarget('request-parameter-max-set', 'for the `query` request parameter `limit`, the max was set to `100.00`'), {
    location: 'query', path: ['limit'], viaArray: false, raw: 'limit',
  });
  assert.equal(genericTarget('request-body-wrapped-in-one-of', 'the request body was restructured into a oneOf'), null);
});

test('all endpoint removal variants are endpoint-removed, including "with deprecation"', () => {
  for (const id of ['api-removed-without-deprecation', 'api-removed-with-deprecation', 'api-path-removed-before-sunset', 'api-path-removed-without-deprecation']) {
    assert.equal(ruleKind(id), 'endpoint-removed', id);
  }
});

test('classify drops additive and component-only entries, keeps response breaks summarized', () => {
  assert.equal(classify({ id: 'endpoint-added', text: '', level: 1, operation: 'GET', operationId: null, path: '/x', section: 'paths' }), null);
  assert.equal(classify({ id: 'api-schema-removed', text: '', level: 1, operation: null, operationId: null, path: null, section: 'components' }), null);
  const r = classify({ id: 'response-required-property-removed', text: 'removed the required property `a` from the response with the `200` status', level: 3, operation: 'POST', operationId: null, path: '/v2/core/account_links', section: 'paths' });
  assert.equal(r?.kind, 'response-changed');
});

test('normalizePropertyPath', () => {
  assert.deepEqual(normalizePropertyPath('session/delegation/anyOf[subschema #1]/'), { path: ['session', 'delegation'], viaArray: false });
});

// Verification -----------------------------------------------------------------------

/** Minimal OpenAPI documents for verification tests. */
function doc(schema, extra = {}) {
  return {
    openapi: '3.0.0',
    paths: { '/images/generations': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Req' } } } } } }, ...extra },
    components: { schemas: { Req: schema } },
  };
}

const enumChange = (value) => ({
  kind: /** @type {const} */ ('request-enum-value-removed'),
  rule: 'request-property-enum-value-removed',
  level: 3,
  text: `removed the enum value \`${value}\` of the request property \`quality\``,
  method: 'POST',
  path: '/images/generations',
  operationId: null,
  source: null,
  target: { location: /** @type {const} */ ('body'), path: ['quality'], viaArray: false, raw: 'quality', value },
});

test('enum moved under anyOf is refuted (the oasdiff false positive seen on the OpenAI spec)', () => {
  const base = doc({ type: 'object', properties: { quality: { type: 'string', enum: ['low', 'high', 'auto'], nullable: true } } });
  const rev = doc({ type: 'object', properties: { quality: { anyOf: [{ type: 'string', enum: ['low', 'high', 'auto'] }, { type: 'null' }] } } });
  assert.equal(verifyChange(enumChange('high'), base, rev).status, 'refuted');
});

test('enum value really removed is verified', () => {
  const base = doc({ type: 'object', properties: { quality: { type: 'string', enum: ['low', 'hd'] } } });
  const rev = doc({ type: 'object', properties: { quality: { type: 'string', enum: ['low'] } } });
  assert.equal(verifyChange(enumChange('hd'), base, rev).status, 'verified');
});

test('newly required property is verified; already-required is refuted', () => {
  const change = {
    kind: /** @type {const} */ ('request-field-required'), rule: 'request-property-became-required', level: 3,
    text: 'the request property `model` became required', method: 'POST', path: '/images/generations', operationId: null, source: null,
    target: { location: /** @type {const} */ ('body'), path: ['model'], viaArray: false, raw: 'model' },
  };
  const optional = doc({ type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, model: { type: 'string' } } });
  const required = doc({ type: 'object', required: ['model', 'prompt'], properties: { prompt: { type: 'string' }, model: { type: 'string' } } });
  assert.equal(verifyChange(change, optional, required).status, 'verified');
  assert.equal(verifyChange(change, required, required).status, 'refuted');
});

test('property removal verified only when gone from every branch', () => {
  const change = {
    kind: /** @type {const} */ ('request-field-removed'), rule: 'request-property-removed', level: 2, text: '', method: 'POST',
    path: '/images/generations', operationId: null, source: null,
    target: { location: /** @type {const} */ ('body'), path: ['user'], viaArray: false, raw: 'user' },
  };
  const base = doc({ type: 'object', properties: { user: { type: 'string' } } });
  const stillInAllOf = doc({ allOf: [{ type: 'object', properties: { prompt: { type: 'string' } } }, { type: 'object', properties: { user: { type: 'string' } } }] });
  const gone = doc({ type: 'object', properties: { prompt: { type: 'string' } } });
  assert.equal(verifyChange(change, base, stillInAllOf).status, 'refuted');
  assert.equal(verifyChange(change, base, gone).status, 'verified');
});

test('endpoint removal is refuted when only the path parameter was renamed', () => {
  const change = {
    kind: /** @type {const} */ ('endpoint-removed'), rule: 'api-removed-without-deprecation', level: 3, text: 'api removed without deprecation',
    method: 'GET', path: '/v1/items/{id}', operationId: null, source: null, target: null,
  };
  const rev = { paths: { '/v1/items/{item}': { get: {} } } };
  assert.equal(verifyChange(change, { paths: { '/v1/items/{id}': { get: {} } } }, rev).status, 'refuted');
  assert.equal(verifyChange(change, { paths: { '/v1/items/{id}': { get: {} } } }, { paths: {} }).status, 'verified');
});
