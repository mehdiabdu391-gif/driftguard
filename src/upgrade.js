// Upgrade check: what breaks in your code when a pinned API version moves to a newer one.
//
// Instead of diffing two whole specs (Stripe's are ~8 MB each, and a whole-spec diff
// across years of history does not fit in a CI runner's memory), this compares only the
// operations your code calls, directly in the two spec snapshots: the last snapshot of the
// version you pin, and the last snapshot of the target version. Each change it derives is
// then re-checked by the same verifier the tracker uses, and matched to call sites by the
// same matcher, so "confirmed" means exactly what it means in a regular scan.
//
// What it compares per called operation:
//   - the operation itself (removed, newly deprecated)
//   - request body properties, to a fixed depth: removed, newly required, enum values
//     dropped, newly deprecated
//   - query and path parameters: removed, newly required, enum values dropped
// Response schemas are not compared; the report says so.

import { pathShape, opKey } from './paths.js';
import { alternatives, operation, bodyRoots, acceptedEnum, parameters, expandWithItems, verifyChange } from './tracker/verify.js';
import { compareUrl } from './tracker/github.js';

const MAX_PROPERTY_DEPTH = 6;

/**
 * @typedef {import('./tracker/track.js').PublishedChange} PublishedChange
 * @typedef {{path: string[], required: boolean, deprecated: boolean, leaves: any[]}} FieldInfo
 * @typedef {{specId: string, repo: string, file: string, from: {version: string, sha: string}, to: {version: string, sha: string}}} UpgradeSide
 */

/**
 * The path template a spec uses for an operation, matched by shape.
 * @param {any} doc
 * @param {string} method
 * @param {string} path
 * @returns {string | null}
 */
export function findTemplate(doc, method, path) {
  if (operation(doc, method, path)) return path;
  const shape = pathShape(path);
  return Object.keys(doc?.paths ?? {}).find((p) => pathShape(p) === shape && operation(doc, method, p)) ?? null;
}

/**
 * Every request body property of an operation, to MAX_PROPERTY_DEPTH, keyed by its path.
 * A property is required when any schema alternative that declares it lists it as required
 * (the same reading the verifier uses).
 * @param {any} doc
 * @param {any} op
 * @returns {Map<string, FieldInfo>}
 */
export function bodyFields(doc, op) {
  /** @type {Map<string, FieldInfo>} */
  const out = new Map();
  /**
   * @param {any[]} schemas
   * @param {string[]} prefix
   */
  const walk = (schemas, prefix) => {
    if (prefix.length >= MAX_PROPERTY_DEPTH) return;
    /** @type {Map<string, FieldInfo>} */
    const level = new Map();
    for (const schema of schemas) {
      for (const alt of expandWithItems(doc, schema)) {
        if (!alt?.properties || typeof alt.properties !== 'object') continue;
        for (const [name, sub] of Object.entries(alt.properties)) {
          const key = [...prefix, name].join('/');
          const info = level.get(key) ?? out.get(key) ?? { path: [...prefix, name], required: false, deprecated: false, leaves: [] };
          if (Array.isArray(alt.required) && alt.required.includes(name)) info.required = true;
          info.leaves.push(sub);
          if (alternatives(doc, sub).some((a) => a?.deprecated)) info.deprecated = true;
          level.set(key, info);
        }
      }
    }
    for (const [key, info] of level) {
      out.set(key, info);
      walk(info.leaves, info.path);
    }
  };
  walk(bodyRoots(doc, op), []);
  return out;
}

/**
 * @param {string} kind
 * @param {string} rule
 * @param {string} text
 * @param {{method: string, path: string, operationId: string | null}} op
 * @param {import('./tracker/classify.js').Target | null} target
 * @returns {import('./tracker/classify.js').Change}
 */
function change(kind, rule, text, op, target) {
  return /** @type {any} */ ({ rule, level: 3, text, method: op.method, path: op.path, operationId: op.operationId, source: null, kind, target });
}

/**
 * @param {string[]} path
 * @param {'body'|'query'|'path'|'header'|'cookie'} [location]
 * @param {string} [value]
 * @returns {import('./tracker/classify.js').Target}
 */
function target(path, location = 'body', value) {
  return { location, path, viaArray: false, raw: path.join('/'), ...(value !== undefined ? { value } : {}) };
}

/**
 * Request-side changes to one operation between two spec snapshots.
 * @param {any} baseDoc
 * @param {any} targetDoc
 * @param {string} method
 * @param {string} path   path template as the call site resolved it
 * @returns {import('./tracker/classify.js').Change[]}
 */
export function operationChanges(baseDoc, targetDoc, method, path) {
  const baseTpl = findTemplate(baseDoc, method, path);
  // The operation did not exist at the pinned version: nothing to compare against.
  if (!baseTpl) return [];
  const baseOp = operation(baseDoc, method, baseTpl);
  const targetTpl = findTemplate(targetDoc, method, path);
  const info = { method: method.toUpperCase(), path: targetTpl ?? baseTpl, operationId: baseOp?.operationId ?? null };
  if (!targetTpl) return [change('endpoint-removed', 'upgrade-endpoint-removed', `removed the operation ${info.method} ${baseTpl}`, info, null)];
  const targetOp = operation(targetDoc, method, targetTpl);
  /** @type {import('./tracker/classify.js').Change[]} */
  const out = [];
  if (targetOp?.deprecated && !baseOp?.deprecated) out.push(change('endpoint-deprecated', 'upgrade-endpoint-deprecated', 'deprecated the operation', info, null));

  const before = bodyFields(baseDoc, baseOp);
  const after = bodyFields(targetDoc, targetOp);
  for (const [key, b] of before) {
    const a = after.get(key);
    if (!a) {
      // Report only the outermost removed property; its children go with it.
      const parent = b.path.slice(0, -1).join('/');
      if (b.path.length === 1 || after.has(parent)) out.push(change('request-field-removed', 'upgrade-request-property-removed', `removed the request property \`${key}\``, info, target(b.path)));
      continue;
    }
    const eb = acceptedEnum(baseDoc, b.leaves);
    const ea = acceptedEnum(targetDoc, a.leaves);
    if (!ea.unconstrained) {
      for (const v of eb.values) {
        if (!ea.values.has(v)) out.push(change('request-enum-value-removed', 'upgrade-request-property-enum-value-removed', `removed the enum value \`${v}\` of the request property \`${key}\``, info, target(a.path, 'body', v)));
      }
    }
    if (a.deprecated && !b.deprecated) out.push(change('request-field-deprecated', 'upgrade-request-property-deprecated', `deprecated the request property \`${key}\``, info, target(a.path)));
  }
  for (const [key, a] of after) {
    if (!a.required) continue;
    const b = before.get(key);
    if (b?.required) continue;
    out.push(change('request-field-required', b ? 'upgrade-request-property-became-required' : 'upgrade-new-required-request-property', b ? `made the request property \`${key}\` required` : `added the new required request property \`${key}\``, info, target(a.path)));
  }

  const pBefore = parameters(baseDoc, method, baseTpl);
  const pAfter = parameters(targetDoc, method, targetTpl);
  for (const p of pBefore) {
    if (p.in !== 'query' && p.in !== 'path') continue;
    const q = pAfter.find((x) => x.in === p.in && x.name === p.name);
    // A renamed path parameter is the same slot in the template; only query removals count.
    if (!q) {
      if (p.in === 'query') out.push(change('request-field-removed', 'upgrade-request-parameter-removed', `removed the \`query\` request parameter \`${p.name}\``, info, target([p.name], 'query')));
      continue;
    }
    const eb = acceptedEnum(baseDoc, p.schema ? [p.schema] : []);
    const ea = acceptedEnum(targetDoc, q.schema ? [q.schema] : []);
    if (!ea.unconstrained) {
      for (const v of eb.values) {
        if (!ea.values.has(v)) out.push(change('request-enum-value-removed', 'upgrade-request-parameter-enum-value-removed', `removed the enum value \`${v}\` of the \`${p.in}\` request parameter \`${p.name}\``, info, target([p.name], p.in, v)));
      }
    }
  }
  for (const q of pAfter) {
    if (q.in !== 'query' || !q.required) continue;
    const p = pBefore.find((x) => x.in === q.in && x.name === q.name);
    if (p?.required) continue;
    out.push(change('request-field-required', 'upgrade-request-parameter-became-required', `made the \`query\` request parameter \`${q.name}\` required`, info, target([q.name], 'query')));
  }
  return out;
}

/**
 * Changes for every operation in `ops`, verified and shaped like tracker output so the
 * regular matcher can use them.
 * @param {any} baseDoc
 * @param {any} targetDoc
 * @param {{method: string, path: string}[]} ops
 * @param {UpgradeSide} side
 * @returns {PublishedChange[]}
 */
export function upgradeChanges(baseDoc, targetDoc, ops, side) {
  /** @type {PublishedChange[]} */
  const out = [];
  const done = new Set();
  const link = compareUrl(side.repo, side.from.sha, side.to.sha);
  for (const op of ops) {
    const k = opKey(op.method, op.path);
    if (done.has(k)) continue;
    done.add(k);
    for (const c of operationChanges(baseDoc, targetDoc, op.method, op.path)) {
      const verification = verifyChange(c, baseDoc, targetDoc);
      // The verifier and this comparison read the specs the same way; a refutation means
      // the two disagree, and the change is dropped rather than reported.
      if (verification.status === 'refuted') continue;
      out.push({
        ...c,
        verification,
        specId: side.specId,
        key: `${c.rule}|${k}|${c.text}`,
        sourceUrl: null,
        compareUrl: link,
        introducedIn: null,
        upgrade: { from: side.from.version, to: side.to.version },
      });
    }
  }
  return out;
}

/**
 * A spec snapshot, downloaded once into a content-addressed cache (a SHA never changes).
 * @param {string} repo
 * @param {string} file
 * @param {string} sha
 * @param {string} cacheDir
 * @param {typeof fetch} [fetchImpl]
 */
export async function loadSnapshot(repo, file, sha, cacheDir, fetchImpl = fetch) {
  const { mkdir, readFile, writeFile, rename } = await import('node:fs/promises');
  const pathMod = await import('node:path');
  const cached = pathMod.join(cacheDir, repo.replace('/', '__'), `${sha}.json`);
  try {
    return JSON.parse(await readFile(cached, 'utf8'));
  } catch {
    // not cached, or a partial file from an interrupted run: download again
  }
  const { rawUrl } = await import('./tracker/github.js');
  const url = rawUrl(repo, sha, file);
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Could not download the spec snapshot ${url} (HTTP ${res.status}).`);
  const text = await res.text();
  const doc = JSON.parse(text);
  await mkdir(pathMod.dirname(cached), { recursive: true });
  await writeFile(`${cached}.tmp`, text);
  await rename(`${cached}.tmp`, cached);
  return doc;
}
