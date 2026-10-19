// Joins published spec changes to resolved call sites.
//
// A finding is only produced when a change and a call site name the same operation
// (method and path shape). Its level says how much is proven:
//   confirmed   - the spec change is verified against the spec documents AND the call site
//                 provably does the thing the change breaks (sends the removed field, omits
//                 the newly required one, sends the removed enum value, calls the removed
//                 endpoint). Only confirmed findings fail CI.
//   possible    - the operation matches but DriftGuard cannot prove the call is affected
//                 (arguments not statically known, or a change kind with no independent check).
//   deprecated  - the call uses an endpoint or field the spec now marks deprecated.
// Changes refuted by verification are never matched.

import { lookup } from './scan/args.js';
import { opKey } from './paths.js';

/**
 * @typedef {import('./tracker/track.js').PublishedChange} PublishedChange
 * @typedef {import('./scan/resolve.js').CallSite} CallSite
 * @typedef {{level: 'confirmed' | 'possible' | 'deprecated', evidence: string, call: CallSite, change: PublishedChange, related?: PublishedChange[]}} Finding
 */

/**
 * @param {CallSite} call
 * @param {PublishedChange} change
 * @returns {{level: Finding['level'], evidence: string} | null}
 */
export function assess(call, change) {
  const verified = change.verification?.status === 'verified';
  if (change.verification?.status === 'refuted') return null;
  const t = change.target;
  const fieldPath = t ? t.path.join('.') : '';

  switch (change.kind) {
    case 'endpoint-removed':
      return verified
        ? { level: 'confirmed', evidence: 'this call targets an operation the spec removed' }
        : { level: 'possible', evidence: 'the spec diff reports this operation removed, but the removal could not be verified' };
    case 'endpoint-deprecated':
      return { level: 'deprecated', evidence: 'this call targets an operation the spec now marks deprecated' };
    case 'response-changed':
      return null; // reported separately as untraced response changes
    default:
      break;
  }

  if (!t) {
    return { level: 'possible', evidence: 'operation-level request change; DriftGuard cannot tell from the code whether this call is affected' };
  }
  if (t.location === 'header' || t.location === 'cookie') {
    return { level: 'possible', evidence: `${t.location} parameter changes are not visible in call arguments` };
  }
  if (t.location === 'path') {
    // Path parameters are always supplied by a call to the operation.
    if (change.kind === 'request-field-removed') return { level: verified ? 'confirmed' : 'possible', evidence: `path parameter "${fieldPath}" was removed` };
    return { level: 'possible', evidence: `path parameter "${fieldPath}" changed` };
  }

  const found = lookup(call.params, t.path);
  const sends = found.state === 'present';
  const unknown = found.state === 'unknown';
  const where = sends ? ` (line ${found.field.line})` : '';

  switch (change.kind) {
    case 'request-field-removed':
      if (sends) return verified
        ? { level: 'confirmed', evidence: `this call sends "${fieldPath}"${where}, which the spec no longer accepts` }
        : { level: 'possible', evidence: `this call sends "${fieldPath}"${where}; the removal is unverified` };
      return unknown ? { level: 'possible', evidence: `could not determine statically whether this call sends "${fieldPath}"` } : null;

    case 'request-field-required': {
      if (sends) return null;
      if (unknown) return { level: 'possible', evidence: `could not determine statically whether this call sends "${fieldPath}", which is now required` };
      // Absent. A nested field is only required when its parent object is sent.
      if (found.state === 'absent' && found.depth < t.path.length - 1) return null;
      return verified
        ? { level: 'confirmed', evidence: `this call does not send "${fieldPath}", which the spec now requires` }
        : { level: 'possible', evidence: `this call does not send "${fieldPath}"; the new requirement is unverified` };
    }

    case 'request-enum-value-removed': {
      if (!sends) return unknown ? { level: 'possible', evidence: `could not determine statically whether this call sends "${fieldPath}"` } : null;
      const value = found.field.value;
      if (value === null) return { level: 'possible', evidence: `this call sends "${fieldPath}"${where} with a value DriftGuard cannot read statically; "${t.value}" is no longer accepted` };
      if (value !== t.value) return null;
      return verified
        ? { level: 'confirmed', evidence: `this call sends "${fieldPath}": "${value}"${where}, a value the spec no longer accepts` }
        : { level: 'possible', evidence: `this call sends "${fieldPath}": "${value}"${where}; the enum removal is unverified` };
    }

    case 'request-field-deprecated':
      return sends ? { level: 'deprecated', evidence: `this call sends "${fieldPath}"${where}, which the spec now marks deprecated` } : null;

    default:
      // Sending a static string can never violate "became not nullable".
      if (sends && /became-not-nullable$/.test(change.rule) && found.field.value !== null) return null;
      // Type changes, new constraints and other request changes: only relevant when the
      // field is sent, and DriftGuard does not evaluate the value against the new schema.
      if (sends) return { level: 'possible', evidence: `this call sends "${fieldPath}"${where}; the spec changed its rules (${change.rule}) and the value is not checked` };
      return unknown ? { level: 'possible', evidence: `could not determine statically whether this call sends "${fieldPath}" (${change.rule})` } : null;
  }
}

/**
 * @param {CallSite[]} callSites
 * @param {Record<string, {changes: PublishedChange[], responseSummary: Record<string, any>}>} windows  spec id -> window data
 */
export function match(callSites, windows) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {Map<string, {specId: string, method: string, path: string, count: number, calls: number}>} */
  const untracedResponse = new Map();
  /** @type {Map<string, Map<string, PublishedChange[]>>} */
  const index = new Map();
  for (const [specId, w] of Object.entries(windows)) {
    const byOp = new Map();
    for (const c of w.changes) {
      const k = opKey(c.method, c.path);
      if (!byOp.has(k)) byOp.set(k, []);
      byOp.get(k).push(c);
    }
    index.set(specId, byOp);
  }
  for (const call of callSites) {
    if (call.status !== 'resolved' || !call.operation || !call.specId) continue;
    const k = opKey(call.operation.method, call.operation.path);
    /** @type {PublishedChange[]} */
    const unknownArgs = [];
    for (const change of index.get(call.specId)?.get(k) ?? []) {
      const a = assess(call, change);
      if (!a) continue;
      if (a.level === 'possible' && a.evidence.startsWith('could not determine statically')) unknownArgs.push(change);
      else findings.push({ ...a, call, change });
    }
    // One finding per call for field changes that cannot be checked because the call's
    // arguments are not statically known, instead of one per field.
    if (unknownArgs.length === 1) {
      const a = /** @type {{level: Finding['level'], evidence: string}} */ (assess(call, unknownArgs[0]));
      findings.push({ ...a, call, change: unknownArgs[0] });
    } else if (unknownArgs.length > 1) {
      const fields = [...new Set(unknownArgs.map((c) => c.target?.path.join('.') ?? c.rule))];
      const shown = fields.slice(0, 6).map((f) => `"${f}"`).join(', ');
      findings.push({
        level: 'possible',
        evidence: `could not determine statically which fields this call sends; ${unknownArgs.length} request changes on this operation may apply (${shown}${fields.length > 6 ? `, and ${fields.length - 6} more` : ''})`,
        call,
        change: unknownArgs[0],
        related: unknownArgs,
      });
    }
    const resp = windows[call.specId]?.responseSummary?.[k];
    if (resp) {
      const key = `${call.specId} ${k}`;
      const entry = untracedResponse.get(key) ?? { specId: call.specId, method: resp.method, path: resp.path, count: resp.count, calls: 0 };
      entry.calls++;
      untracedResponse.set(key, entry);
    }
  }
  const order = { confirmed: 0, possible: 1, deprecated: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level] || a.call.file.localeCompare(b.call.file) || a.call.line - b.call.line);
  return { findings, untracedResponse: [...untracedResponse.values()] };
}
