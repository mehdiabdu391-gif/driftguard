// What a call site is known to send, as far as static analysis can prove it.
//
// An ArgTree lists the fields a request literally contains. `complete` is true only when
// every key at that level is a static name (no spreads, **kwargs, or computed keys), which
// is what allows DriftGuard to say a field is *absent* rather than merely unseen.

/**
 * @typedef {object} ArgField
 * @property {number} line          1-based line of the key
 * @property {string | null} value  the static string value, when the value is a string literal
 * @property {ArgTree | null} child nested object literal (or merged array-of-object literals), null when not statically known
 */

/**
 * @typedef {object} ArgTree
 * @property {boolean} complete
 * @property {Record<string, ArgField>} fields
 */

/** @returns {ArgTree} */
export function emptyTree() {
  return { complete: true, fields: {} };
}

/**
 * Merge b into a (used for arrays of objects and for body+query on raw HTTP calls).
 * @param {ArgTree | null} a
 * @param {ArgTree | null} b
 * @returns {ArgTree | null}
 */
export function mergeTrees(a, b) {
  if (!a || !b) return null;
  /** @type {ArgTree} */
  const out = { complete: a.complete && b.complete, fields: { ...a.fields } };
  for (const [k, f] of Object.entries(b.fields)) {
    const prev = out.fields[k];
    if (!prev) out.fields[k] = f;
    else out.fields[k] = { line: prev.line, value: prev.value === f.value ? prev.value : null, child: mergeTrees(prev.child, f.child) };
  }
  return out;
}

/**
 * @typedef {{state: 'present', field: ArgField}
 *   | {state: 'absent', depth: number}
 *   | {state: 'unknown', depth: number}} Lookup
 */

/**
 * Look up a property path. `depth` says how many leading segments were present before
 * the lookup became absent or unknown.
 * @param {ArgTree | null} tree
 * @param {string[]} path
 * @returns {Lookup}
 */
export function lookup(tree, path) {
  let node = tree;
  for (let i = 0; i < path.length; i++) {
    if (!node) return { state: 'unknown', depth: i };
    const f = Object.prototype.hasOwnProperty.call(node.fields, path[i]) ? node.fields[path[i]] : undefined;
    if (!f) return node.complete ? { state: 'absent', depth: i } : { state: 'unknown', depth: i };
    if (i === path.length - 1) return { state: 'present', field: f };
    node = f.child;
  }
  return { state: 'unknown', depth: 0 };
}

/**
 * Compact form for reports: top-level keys, or null when unknown.
 * @param {ArgTree | null} tree
 */
export function describeTree(tree) {
  if (!tree) return null;
  return { complete: tree.complete, keys: Object.keys(tree.fields) };
}
