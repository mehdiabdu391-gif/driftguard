// Turns raw oasdiff changelog entries into DriftGuard change records.
//
// oasdiff reports each change with a rule id and an English message whose arguments are
// wrapped in backticks. The message templates are fixed per rule id (see oasdiff's
// checker/localizations_src/en/messages.yaml), so the argument positions below are exact.
// When a message does not have the expected number of arguments, the target is left
// null and the change is matched at operation level only, never guessed.

/**
 * @typedef {'endpoint-removed'|'endpoint-deprecated'|'request-field-removed'|'request-field-required'
 *   |'request-enum-value-removed'|'request-field-type-changed'|'request-field-constrained'
 *   |'request-field-deprecated'|'request-body-required'|'request-body-removed'|'request-other'
 *   |'response-changed'} ChangeKind
 */

/**
 * @typedef {object} Target
 * @property {'body'|'query'|'path'|'header'|'cookie'} location
 * @property {string[]} path     Property path with schema combinators and array markers removed.
 * @property {boolean} viaArray  True when the path passes through an array's items.
 * @property {string} raw        The property path exactly as oasdiff printed it.
 * @property {string} [value]    Enum value, for enum removals.
 */

/** Rule ids that remove an operation entirely. */
const ENDPOINT_REMOVED = /^api-(path-)?removed-(without-deprecation|with-deprecation|before-sunset)$/;

/**
 * Per rule id: change kind, where the target lives, and which backticked argument holds
 * the property (or parameter) name and, for enums, the value.
 * @type {Record<string, {kind: ChangeKind, location?: 'body'|'param', prop?: number, inArg?: number, value?: number}>}
 */
const RULES = {
  'endpoint-deprecated': { kind: 'endpoint-deprecated' },
  'endpoint-deprecated-with-sunset': { kind: 'endpoint-deprecated' },
  'request-body-became-required': { kind: 'request-body-required' },
  'request-body-removed': { kind: 'request-body-removed' },
  'request-body-media-type-removed': { kind: 'request-other' },

  'request-property-removed': { kind: 'request-field-removed', location: 'body', prop: 0 },
  'new-required-request-property': { kind: 'request-field-required', location: 'body', prop: 0 },
  'request-property-became-required': { kind: 'request-field-required', location: 'body', prop: 0 },
  'new-required-request-property-with-default': { kind: 'request-field-required', location: 'body', prop: 0 },
  'request-property-became-required-with-default': { kind: 'request-field-required', location: 'body', prop: 0 },
  'request-property-enum-value-removed': { kind: 'request-enum-value-removed', location: 'body', value: 0, prop: 1 },
  'request-property-type-changed': { kind: 'request-field-type-changed', location: 'body', prop: 0 },
  'request-property-became-enum': { kind: 'request-field-constrained', location: 'body', prop: 0 },
  'request-property-max-length-decreased': { kind: 'request-field-constrained', location: 'body', prop: 0 },
  'request-property-max-decreased': { kind: 'request-field-constrained', location: 'body', prop: 0 },
  'request-property-min-increased': { kind: 'request-field-constrained', location: 'body', prop: 0 },
  'request-property-min-length-increased': { kind: 'request-field-constrained', location: 'body', prop: 0 },
  'request-property-pattern-added': { kind: 'request-field-constrained', location: 'body', prop: 1 },
  'request-property-pattern-changed': { kind: 'request-field-constrained', location: 'body', prop: 0 },
  'request-property-any-of-removed': { kind: 'request-field-constrained', location: 'body', prop: 1 },
  'request-property-one-of-removed': { kind: 'request-field-constrained', location: 'body', prop: 1 },
  'request-property-deprecated': { kind: 'request-field-deprecated', location: 'body', prop: 0 },
  'request-property-deprecated-with-sunset': { kind: 'request-field-deprecated', location: 'body', prop: 0 },
  'request-property-deprecated-sunset-missing': { kind: 'request-field-deprecated', location: 'body', prop: 0 },

  'request-parameter-removed': { kind: 'request-field-removed', location: 'param', inArg: 0, prop: 1 },
  'request-parameter-removed-with-deprecation': { kind: 'request-field-removed', location: 'param', inArg: 0, prop: 1 },
  'request-parameter-removed-before-sunset': { kind: 'request-field-removed', location: 'param', inArg: 0, prop: 1 },
  'new-required-request-parameter': { kind: 'request-field-required', location: 'param', inArg: 0, prop: 1 },
  'request-parameter-became-required': { kind: 'request-field-required', location: 'param', inArg: 0, prop: 1 },
  'request-parameter-became-enum': { kind: 'request-field-constrained', location: 'param', inArg: 0, prop: 1 },
  'request-parameter-enum-value-removed': { kind: 'request-enum-value-removed', location: 'param', value: 0, inArg: 1, prop: 2 },
  'request-parameter-type-changed': { kind: 'request-field-type-changed', location: 'param', inArg: 0, prop: 1 },
  'request-parameter-deprecated': { kind: 'request-field-deprecated', location: 'param', inArg: 0, prop: 1 },
  'request-parameter-deprecated-sunset-missing': { kind: 'request-field-deprecated', location: 'param', inArg: 0, prop: 1 },
};

const PARAM_LOCATIONS = new Set(['query', 'path', 'header', 'cookie']);

/** @param {string} text */
export function backticked(text) {
  return [...text.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}

/**
 * Normalize an oasdiff property path such as
 * "payment_settings/payment_method_types/anyOf[subschema #1]/items/".
 * @param {string} raw
 */
export function normalizePropertyPath(raw) {
  let viaArray = false;
  const path = [];
  for (const seg of raw.split('/')) {
    if (seg === '') continue;
    if (seg === 'items') { viaArray = true; continue; }
    if (/^(anyOf|oneOf|allOf)\[/.test(seg)) continue;
    path.push(seg);
  }
  return { path, viaArray };
}

/**
 * Whether a rule id is breaking or deprecating enough to keep. Purely additive changes
 * (new optional fields, new endpoints) are dropped.
 * @param {string} id
 */
export function ruleKind(id) {
  if (ENDPOINT_REMOVED.test(id)) return /** @type {ChangeKind} */ ('endpoint-removed');
  const rule = RULES[id];
  if (rule) return rule.kind;
  return null;
}

/**
 * @typedef {object} OasdiffEntry
 * @property {string} id
 * @property {string} text
 * @property {number} level
 * @property {string|null} operation
 * @property {string|null} operationId
 * @property {string|null} path
 * @property {string} section
 * @property {{file: string, line: number}} [baseSource]
 * @property {{file: string, line: number}} [revisionSource]
 */

/**
 * @typedef {object} Change
 * @property {ChangeKind} kind
 * @property {string} rule        oasdiff rule id
 * @property {number} level       oasdiff level (3 error, 2 warning, 1 info)
 * @property {string} text        oasdiff message
 * @property {string} method
 * @property {string} path        spec path template as of the base or revision spec
 * @property {string|null} operationId
 * @property {Target|null} target
 * @property {{side: 'base'|'revision', line: number} | null} source  line in the spec file
 */

/**
 * Classify one oasdiff entry. Returns null for entries DriftGuard does not track
 * (additive changes, component-only changes without an operation).
 * Response-side entries are returned with kind "response-changed".
 * @param {OasdiffEntry} e
 * @returns {Change | null}
 */
export function classify(e) {
  if (!e.operation || !e.path) return null;
  const source = e.baseSource?.line
    ? { side: /** @type {const} */ ('base'), line: e.baseSource.line }
    : e.revisionSource?.line
      ? { side: /** @type {const} */ ('revision'), line: e.revisionSource.line }
      : null;
  const base = {
    rule: e.id,
    level: e.level,
    text: e.text,
    method: e.operation.toUpperCase(),
    path: e.path,
    operationId: e.operationId ?? null,
    source,
  };
  if (e.id.startsWith('response-')) {
    // Only keep response changes oasdiff itself rates as breaking or warning.
    if (e.level < 2) return null;
    return { ...base, kind: 'response-changed', target: null };
  }
  const kind = ruleKind(e.id);
  if (!kind) {
    // Request-side rules without a dedicated entry are kept whenever oasdiff rates them as
    // a warning or error, so nothing breaking is silently dropped. The field they concern
    // is read from the message's fixed wording when possible.
    if (e.level < 2 || !/^(request-|new-required-)/.test(e.id)) return null;
    const target = genericTarget(e.id, e.text);
    return { ...base, kind: target ? 'request-field-constrained' : 'request-other', target };
  }
  return { ...base, kind, target: extractTarget(e.id, e.text) };
}

/**
 * Field named by an unlisted request rule. oasdiff words parameter rules as
 * "... the `<in>` request parameter `<name>` ..." and property rules as
 * "... request property `<path>` ..." or "the `<path>` request property ...".
 * @param {string} id
 * @param {string} text
 * @returns {Target | null}
 */
export function genericTarget(id, text) {
  if (id.startsWith('request-parameter-')) {
    const m = /`(query|path|header|cookie)` request parameter `([^`]+)`/.exec(text);
    if (!m) return null;
    return { location: /** @type {Target['location']} */ (m[1]), path: [m[2]], viaArray: false, raw: m[2] };
  }
  if (id.startsWith('request-property-')) {
    const m = /request property `([^`]+)`/.exec(text) ?? /`([^`]+)` request property/.exec(text);
    if (!m) return null;
    const { path, viaArray } = normalizePropertyPath(m[1]);
    if (path.length === 0) return null;
    return { location: 'body', path, viaArray, raw: m[1] };
  }
  return null;
}

/**
 * @param {string} id
 * @param {string} text
 * @returns {Target | null}
 */
export function extractTarget(id, text) {
  const rule = RULES[id];
  if (!rule || rule.prop === undefined) return null;
  const args = backticked(text);
  const needed = Math.max(rule.prop, rule.value ?? -1, rule.inArg ?? -1) + 1;
  if (args.length < needed) return null;
  const raw = args[rule.prop];
  /** @type {Target['location']} */
  let location = 'body';
  if (rule.location === 'param') {
    const where = args[/** @type {number} */ (rule.inArg)];
    if (!PARAM_LOCATIONS.has(where)) return null;
    location = /** @type {Target['location']} */ (where);
  }
  const { path, viaArray } = rule.location === 'param' ? { path: [raw], viaArray: false } : normalizePropertyPath(raw);
  if (path.length === 0) return null;
  /** @type {Target} */
  const target = { location, path, viaArray, raw };
  if (rule.value !== undefined) target.value = args[rule.value];
  return target;
}
