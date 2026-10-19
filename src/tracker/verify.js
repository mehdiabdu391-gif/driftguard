// Independent re-check of oasdiff's claims against the spec documents themselves.
//
// Structural diffs can misreport refactors: moving an enum under `anyOf`, for example, is
// reported as every enum value being removed although each value is still accepted. For
// the change kinds DriftGuard can prove, this module resolves the property in both specs
// (following $ref, allOf, anyOf, oneOf and array items) and marks the change:
//   verified   - the spec documents confirm the claim
//   refuted    - the revision spec still accepts what the change says was removed
//   unverified - DriftGuard has no independent check for this kind; the claim is oasdiff's

import { pathShape } from '../paths.js';

const MAX_DEPTH = 40;

/**
 * @typedef {{status: 'verified'|'refuted'|'unverified', reason: string}} Verification
 */

/**
 * @param {any} doc
 * @param {string} ref
 */
function deref(doc, ref) {
  if (!ref.startsWith('#/')) return undefined;
  let node = doc;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    node = node?.[key];
    if (node === undefined) return undefined;
  }
  return node;
}

/**
 * Expand a schema into the concrete alternatives a value may match.
 * @param {any} doc
 * @param {any} schema
 * @param {number} [depth]
 * @param {Set<any>} [seen]
 * @returns {any[]}
 */
export function alternatives(doc, schema, depth = 0, seen = new Set()) {
  if (!schema || typeof schema !== 'object' || depth > MAX_DEPTH) return [];
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return [];
    const next = new Set(seen);
    next.add(schema.$ref);
    return alternatives(doc, deref(doc, schema.$ref), depth + 1, next);
  }
  const out = [schema];
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(schema[key])) {
      for (const sub of schema[key]) out.push(...alternatives(doc, sub, depth + 1, seen));
    }
  }
  return out;
}

/**
 * The operation object for a method and path template, or undefined.
 * @param {any} doc
 * @param {string} method
 * @param {string} path
 */
function operation(doc, method, path) {
  return doc?.paths?.[path]?.[method.toLowerCase()];
}

/**
 * Root request body schemas of an operation, across media types.
 * @param {any} doc
 * @param {any} op
 */
function bodyRoots(doc, op) {
  let body = op?.requestBody;
  if (body?.$ref) body = deref(doc, body.$ref);
  const content = body?.content ?? {};
  return Object.values(content).map((/** @type {any} */ m) => m?.schema).filter(Boolean);
}

/**
 * Resolve a property path to the parent alternatives that declare the leaf property and
 * the leaf schemas themselves. Array items are traversed transparently, matching the way
 * oasdiff paths drop `items`.
 * @param {any} doc
 * @param {any[]} roots
 * @param {string[]} propPath
 */
export function resolveProperty(doc, roots, propPath) {
  /** @type {any[]} */
  let current = roots;
  /** @type {any[]} */
  let parents = [];
  for (let i = 0; i < propPath.length; i++) {
    const name = propPath[i];
    /** @type {any[]} */
    const next = [];
    parents = [];
    for (const schema of current) {
      for (const alt of expandWithItems(doc, schema)) {
        if (alt?.properties && Object.prototype.hasOwnProperty.call(alt.properties, name)) {
          parents.push(alt);
          next.push(alt.properties[name]);
        }
      }
    }
    current = next;
    if (current.length === 0) return { parents: [], leaves: [] };
  }
  return { parents, leaves: current };
}

/**
 * @param {any} doc
 * @param {any} schema
 */
function expandWithItems(doc, schema) {
  const out = [];
  for (const alt of alternatives(doc, schema)) {
    out.push(alt);
    if (alt?.items) out.push(...alternatives(doc, alt.items));
  }
  return out;
}

/**
 * All enum values a leaf accepts, or null when some alternative is unconstrained.
 * @param {any} doc
 * @param {any[]} leaves
 */
function acceptedEnum(doc, leaves) {
  /** @type {Set<string>} */
  const values = new Set();
  let unconstrained = false;
  for (const leaf of leaves) {
    for (const alt of expandWithItems(doc, leaf)) {
      if (Array.isArray(alt.enum)) for (const v of alt.enum) values.add(String(v));
    }
    const alts = expandWithItems(doc, leaf).filter((a) => !a.allOf && !a.anyOf && !a.oneOf);
    if (alts.some((a) => !Array.isArray(a.enum) && a.type !== 'null' && a.type !== 'object' && a.type !== 'array' && a.const === undefined)) {
      unconstrained = true;
    }
  }
  return { values, unconstrained };
}

/**
 * Parameters of an operation (path-level and operation-level), resolved.
 * @param {any} doc
 * @param {string} method
 * @param {string} path
 */
function parameters(doc, method, path) {
  const item = doc?.paths?.[path];
  const list = [...(item?.parameters ?? []), ...(operation(doc, method, path)?.parameters ?? [])];
  return list.map((p) => (p?.$ref ? deref(doc, p.$ref) : p)).filter(Boolean);
}

/**
 * @param {import('./classify.js').Change} change
 * @param {any} baseDoc
 * @param {any} revDoc
 * @returns {Verification}
 */
export function verifyChange(change, baseDoc, revDoc) {
  const { kind, method, path, target } = change;
  if (kind === 'endpoint-removed') {
    const shape = pathShape(path);
    const survivor = Object.keys(revDoc?.paths ?? {}).find((p) => pathShape(p) === shape && operation(revDoc, method, p));
    return survivor
      ? { status: 'refuted', reason: `${method} ${survivor} still exists in the revision spec` }
      : { status: 'verified', reason: `${method} ${path} is absent from the revision spec` };
  }
  if (kind === 'endpoint-deprecated') {
    return operation(revDoc, method, path)?.deprecated
      ? { status: 'verified', reason: 'operation is marked deprecated in the revision spec' }
      : { status: 'refuted', reason: 'operation is not marked deprecated in the revision spec' };
  }
  if (!target) return { status: 'unverified', reason: 'no field-level target to check' };

  if (target.location !== 'body') {
    const find = (/** @type {any} */ doc) => parameters(doc, method, path).find((p) => p.name === target.path[0] && p.in === target.location);
    const before = find(baseDoc);
    const after = find(revDoc);
    if (kind === 'request-field-removed') {
      return after
        ? { status: 'refuted', reason: `${target.location} parameter "${target.path[0]}" still exists in the revision spec` }
        : { status: 'verified', reason: `${target.location} parameter "${target.path[0]}" is absent from the revision spec` };
    }
    if (kind === 'request-field-required') {
      return after?.required && !before?.required
        ? { status: 'verified', reason: `${target.location} parameter "${target.path[0]}" is required in the revision spec and was not before` }
        : { status: 'refuted', reason: `required flag of ${target.location} parameter "${target.path[0]}" did not change from optional to required` };
    }
    if (kind === 'request-enum-value-removed' && target.value !== undefined) {
      const { values, unconstrained } = acceptedEnum(revDoc, after?.schema ? [after.schema] : []);
      return values.has(target.value) || unconstrained
        ? { status: 'refuted', reason: `value "${target.value}" is still accepted in the revision spec` }
        : { status: 'verified', reason: `value "${target.value}" is no longer accepted in the revision spec` };
    }
    return { status: 'unverified', reason: 'claim taken from oasdiff; no independent check for this change type' };
  }

  const revOp = operation(revDoc, method, path);
  const baseOp = operation(baseDoc, method, path);
  if (!revOp) return { status: 'unverified', reason: 'operation not found in the revision spec under this path' };
  const revRoots = bodyRoots(revDoc, revOp);
  const after = resolveProperty(revDoc, revRoots, target.path);

  if (kind === 'request-field-removed') {
    return after.leaves.length
      ? { status: 'refuted', reason: `property "${target.raw}" is still declared in the revision spec` }
      : { status: 'verified', reason: `property "${target.raw}" is no longer declared in the revision spec` };
  }
  if (kind === 'request-field-required') {
    const leaf = target.path[target.path.length - 1];
    const requiredNow = after.parents.some((p) => Array.isArray(p.required) && p.required.includes(leaf));
    const before = resolveProperty(baseDoc, bodyRoots(baseDoc, baseOp), target.path);
    const requiredBefore = before.parents.some((p) => Array.isArray(p.required) && p.required.includes(leaf));
    if (requiredNow && !requiredBefore) return { status: 'verified', reason: `property "${target.raw}" is required in the revision spec and was optional or absent before` };
    if (requiredNow && requiredBefore) return { status: 'refuted', reason: `property "${target.raw}" was already required in the base spec` };
    return { status: 'refuted', reason: `property "${target.raw}" is not required in the revision spec` };
  }
  if (kind === 'request-enum-value-removed' && target.value !== undefined) {
    if (!after.leaves.length) return { status: 'unverified', reason: `property "${target.raw}" not found in the revision spec` };
    const { values, unconstrained } = acceptedEnum(revDoc, after.leaves);
    if (values.has(target.value)) return { status: 'refuted', reason: `value "${target.value}" is still listed for "${target.raw}" in the revision spec` };
    if (unconstrained) return { status: 'refuted', reason: `"${target.raw}" accepts unconstrained values in the revision spec` };
    return { status: 'verified', reason: `value "${target.value}" is no longer accepted for "${target.raw}" in the revision spec` };
  }
  if (kind === 'request-field-deprecated') {
    const deprecated = after.leaves.some((l) => alternatives(revDoc, l).some((a) => a.deprecated));
    return deprecated
      ? { status: 'verified', reason: `property "${target.raw}" is marked deprecated in the revision spec` }
      : { status: 'unverified', reason: 'deprecation flag not found on the resolved property' };
  }
  return { status: 'unverified', reason: 'claim taken from oasdiff; no independent check for this change type' };
}
