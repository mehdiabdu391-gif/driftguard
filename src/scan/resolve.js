// Maps raw calls to spec operations.
//
// SDK calls are looked up in maps generated from the SDKs' own source (data/sdk-maps).
// Raw HTTP calls are matched by host and path template against the tracked spec's
// operation index (data/operations). A call that cannot be pinned to exactly one
// operation is reported as unresolved, with the reason.

import { specForHost, specById, SDKS } from '../providers.js';
import { matchPath, pathShape, opKey } from '../paths.js';
import { emptyTree, mergeTrees } from './args.js';

/**
 * @typedef {import('./args.js').ArgTree} ArgTree
 * @typedef {{method: string, path: string, operationId: string | null, deprecated: boolean, inHead: boolean}} Operation
 *
 * @typedef {object} CallSite
 * @property {string} file
 * @property {number} line
 * @property {number} column
 * @property {string} snippet
 * @property {'sdk' | 'http'} via
 * @property {string} client         SDK id (stripe-node) or HTTP client (fetch, requests)
 * @property {string | null} sdkMethod  e.g. customers.create
 * @property {string} provider
 * @property {string | null} specId
 * @property {'resolved' | 'unresolved'} status
 * @property {string | null} reason  why a call is unresolved
 * @property {{method: string, path: string, operationId: string | null, inSpec: boolean} | null} operation
 * @property {ArgTree | null} params what the call sends (null when not statically known)
 * @property {string | null} mapSource  provenance of the SDK mapping (repo@sha:file)
 * @property {string | null} [apiVersion] API version the code pins for this client, when stated literally
 */

/**
 * @typedef {object} Context
 * @property {Record<string, any>} sdkMaps   sdk id -> map JSON
 * @property {Record<string, Operation[]>} operations  spec id -> operations
 */

/** openai-python < 1.0 module-level classes, removed in the 1.0 SDK. */
const OPENAI_LEGACY = new Set(['ChatCompletion', 'Completion', 'Embedding', 'Image', 'Moderation', 'Audio', 'File', 'FineTune', 'FineTuningJob', 'Model', 'Edit', 'Customer', 'Deployment']);

/** openai-python call options that are not API fields. */
const OPENAI_PY_OPTIONS = new Set(['extra_headers', 'extra_query', 'extra_body', 'timeout']);
/** stripe-python per-request options that are not API fields. */
const STRIPE_PY_OPTIONS = new Set(['api_key', 'stripe_account', 'stripe_version', 'idempotency_key', 'stripe_context', 'options']);

/**
 * @param {any} raw
 * @param {string} file
 * @param {Context} ctx
 * @returns {CallSite | null}  null for SDK calls that are not API calls (helpers, webhooks)
 */
export function resolveCall(raw, file, ctx) {
  const base = { file, line: raw.line, column: raw.column, snippet: raw.snippet };
  if (raw.kind === 'http') return resolveHttp(raw, base, ctx);
  return resolveSdk(raw, base, ctx);
}

/**
 * @param {string} reason
 * @param {any} base
 * @param {Partial<CallSite>} extra
 * @returns {CallSite}
 */
function unresolved(reason, base, extra) {
  return {
    ...base,
    via: 'sdk',
    client: '',
    sdkMethod: null,
    provider: '',
    specId: null,
    status: 'unresolved',
    reason,
    operation: null,
    params: null,
    mapSource: null,
    ...extra,
  };
}

/**
 * @param {any} raw
 * @param {any} base
 * @param {Context} ctx
 * @returns {CallSite | null}
 */
function resolveSdk(raw, base, ctx) {
  const sdk = SDKS.find((s) => s.id === raw.sdk);
  if (!sdk) return null;
  /** @type {string[]} */
  let chain = raw.chain;
  const common = { via: /** @type {const} */ ('sdk'), client: sdk.id, provider: sdk.provider, specId: sdk.specId };

  if (!sdk.mapped) {
    return unresolved(`${sdk.id} calls are detected but DriftGuard has no method-to-endpoint map for this SDK yet`, base, { ...common, sdkMethod: chain.join('.') });
  }
  if (raw.variant === 'azure') {
    return unresolved('Azure OpenAI client: Azure serves deployment-scoped paths that the OpenAI spec does not describe', base, { ...common, sdkMethod: chain.join('.') });
  }

  // Octokit: octokit.rest.x.y, legacy octokit.x.y, octokit.request(route), octokit.paginate(...)
  let routeArgIndex = -1;
  if (sdk.id === 'octokit') {
    if (chain[0] === 'rest') chain = chain.slice(1);
    if (chain.length === 1 && (chain[0] === 'request' || chain[0] === 'paginate')) {
      const first = raw.args[0];
      if (first?.type === 'string') {
        routeArgIndex = 0;
        const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\S+)$/i.exec(first.value.trim());
        const route = m ? { method: m[1].toUpperCase(), path: m[2] } : first.value.startsWith('/') ? { method: 'GET', path: first.value } : null;
        if (!route) return unresolved(`route string "${first.value}" is not of the form "VERB /path"`, base, { ...common, sdkMethod: chain[0] });
        return finishSdk(route, `${chain[0]}("${first.value}")`, argTreeAt(raw.args, 1), base, common, ctx, 'octokit route string');
      }
      if (chain[0] === 'paginate' && first?.type === 'other' && first.node) {
        const text = String(first.node.text).replace(/\s+/g, '');
        const parts = text.split('.');
        const restIdx = parts.indexOf('rest');
        chain = restIdx >= 0 ? parts.slice(restIdx + 1) : parts.slice(1);
        routeArgIndex = 0;
      } else if (chain[0] === 'request' || chain[0] === 'paginate') {
        return unresolved(`${chain[0]}() route is not a string literal`, base, { ...common, sdkMethod: chain[0] });
      }
    }
    if (chain[0] === 'graphql' || chain[0] === 'hook' || chain[0] === 'log' || chain[0] === 'auth') return null;
  }

  const map = ctx.sdkMaps[sdk.id];
  if (!map) return unresolved(`SDK map for ${sdk.id} is missing from the data directory`, base, { ...common, sdkMethod: chain.join('.') });
  const styleMap = map.styles[raw.style] ?? {};
  let key = chain.join('.');

  if (sdk.id === 'openai-python' && raw.style === 'module' && OPENAI_LEGACY.has(chain[0])) {
    return unresolved(`openai.${chain.join('.')} is the openai-python < 1.0 interface, which the 1.0 SDK removed; it is not mapped to the current API`, base, { ...common, sdkMethod: key });
  }

  const entry = styleMap[key];
  if (!entry) {
    const prefix = chain.slice(0, -1).join('.');
    const knownResource = prefix && Object.keys(styleMap).some((k) => k.startsWith(`${prefix}.`));
    if (!knownResource) return null; // not an API resource method (webhooks, errors, helpers)
    return unresolved(`${key} is not in the ${sdk.id} method map (${map.repo}@${map.sha.slice(0, 10)}); it may be a helper or a newer/older SDK method`, base, { ...common, sdkMethod: key });
  }
  if (entry.alternatives) {
    const alts = entry.alternatives.map((/** @type {any} */ a) => `${a.method} ${a.path}`).join(' or ');
    return unresolved(`${key} calls one of several endpoints depending on its arguments (${alts})`, base, { ...common, sdkMethod: key, mapSource: `${map.repo}@${map.sha.slice(0, 10)}:${entry.source}` });
  }

  const params = sdkParams(sdk.id, raw, entry.path, routeArgIndex);
  if (raw.apiVersion) base = { ...base, apiVersion: raw.apiVersion };
  return finishSdk({ method: entry.method, path: entry.path }, key, params, base, common, ctx, `${map.repo}@${map.sha.slice(0, 10)}:${entry.source}`);
}

/**
 * @param {{method: string, path: string}} route
 * @param {string} sdkMethod
 * @param {ArgTree | null} params
 * @param {any} base
 * @param {any} common
 * @param {Context} ctx
 * @param {string} mapSource
 * @returns {CallSite}
 */
function finishSdk(route, sdkMethod, params, base, common, ctx, mapSource) {
  const ops = ctx.operations[common.specId] ?? [];
  const key = opKey(route.method, route.path);
  const op = ops.find((o) => opKey(o.method, o.path) === key);
  return {
    ...base,
    ...common,
    sdkMethod,
    status: 'resolved',
    reason: null,
    operation: op
      ? { method: op.method, path: op.path, operationId: op.operationId, inSpec: true }
      : { method: route.method, path: route.path, operationId: null, inSpec: false },
    params,
    mapSource,
  };
}

/**
 * @param {any[]} args
 * @param {number} i
 * @returns {ArgTree | null}
 */
function argTreeAt(args, i) {
  const a = args[i];
  if (a === undefined) return emptyTree();
  if (a.type === 'object') return a.tree;
  return null;
}

/**
 * What an SDK call sends, from its arguments.
 * @param {string} sdk
 * @param {any} raw
 * @param {string} path
 * @param {number} routeArgIndex
 * @returns {ArgTree | null}
 */
function sdkParams(sdk, raw, path, routeArgIndex) {
  const placeholders = (path.match(/\{[^}]*\}/g) ?? []).length;
  if (sdk === 'stripe-node') {
    // stripe-node methods take each path id positionally, then params, then options.
    return argTreeAt(raw.args, placeholders);
  }
  if (sdk === 'octokit') return argTreeAt(raw.args, routeArgIndex + 1);
  if (sdk === 'openai-node') {
    // Stainless methods take some path ids positionally and the rest inside params, so the
    // params object is the first object literal. Without one, the call sends no params
    // only if every argument is a static string (an id).
    const obj = raw.args.find((/** @type {any} */ a) => a.type === 'object');
    if (obj) return obj.tree;
    return raw.args.every((/** @type {any} */ a) => a.type === 'string') ? emptyTree() : null;
  }
  if (sdk === 'openai-python') return pyKwargs(raw, OPENAI_PY_OPTIONS, ['extra_body', 'extra_query']);
  if (sdk === 'stripe-python') {
    if (raw.style === 'client') {
      // StripeClient services: method(<ids...>, params=None, options=None)
      const kw = raw.pyArgs.keywords.params;
      if (kw) return kw.type === 'object' ? kw.tree : null;
      const pos = raw.pyArgs.positional[placeholders];
      if (pos === undefined) return raw.pyArgs.kwSplat ? null : emptyTree();
      return pos.type === 'object' ? pos.tree : null;
    }
    return pyKwargs(raw, STRIPE_PY_OPTIONS, []);
  }
  return null;
}

/**
 * Keyword arguments as the request fields, minus SDK options, plus merged extra dicts.
 * @param {any} raw
 * @param {Set<string>} options
 * @param {string[]} extras
 * @returns {ArgTree | null}
 */
function pyKwargs(raw, options, extras) {
  /** @type {ArgTree | null} */
  let tree = { complete: raw.kwargs.complete, fields: {} };
  for (const [k, f] of Object.entries(raw.kwargs.fields)) if (!options.has(k)) tree.fields[k] = /** @type {any} */ (f);
  for (const ex of extras) {
    const v = raw.pyArgs.keywords[ex];
    if (!v) continue;
    tree = v.type === 'object' ? mergeTrees(tree, v.tree) : null;
  }
  return tree;
}

/**
 * @param {any} raw
 * @param {any} base
 * @param {Context} ctx
 * @returns {CallSite | null}
 */
function resolveHttp(raw, base, ctx) {
  if (!raw.url) return null;
  const m = /^https?:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/.exec(raw.url);
  if (!m || m[1].includes('{}')) return null;
  const hit = specForHost(m[1]);
  if (!hit) return null;
  const spec = hit.spec;
  const common = { via: /** @type {const} */ ('http'), client: raw.client, sdkMethod: null, provider: spec.provider, specId: spec.id, mapSource: null };
  let p = m[2] || '/';
  if (hit.pathPrefix) {
    if (!(p === hit.pathPrefix || p.startsWith(`${hit.pathPrefix}/`))) {
      return unresolved(`URL path "${p}" does not start with ${spec.name}'s base path ${hit.pathPrefix}`, base, common);
    }
    p = p.slice(hit.pathPrefix.length) || '/';
  }
  // Any segment containing a runtime value is a parameter segment.
  const concrete = `/${p.split('/').filter(Boolean).map((s) => (s.includes('{}') ? '{}' : s)).join('/')}`;
  const ops = ctx.operations[spec.id] ?? [];

  // Query string keys are request fields too.
  /** @type {ArgTree | null} */
  let params = raw.body;
  if (m[3]) {
    const q = emptyTree();
    for (const part of m[3].slice(1).split('&')) {
      const [k, v] = part.split('=');
      if (!k || k.includes('{}')) { q.complete = false; continue; }
      q.fields[decodeURIComponent(k)] = { line: raw.line, value: v && !v.includes('{}') ? decodeURIComponent(v) : null, child: null };
    }
    params = mergeTrees(params, q);
  }

  if (!raw.method) {
    return unresolved(`HTTP method is not statically known for ${concrete}`, base, { ...common, params });
  }
  const candidates = ops.filter((o) => o.method === raw.method).map((o) => o.path);
  const match = matchPath(concrete, candidates);
  if (!match) {
    const anyMethod = matchPath(concrete, ops.map((o) => o.path));
    const why = anyMethod ? `no ${raw.method} operation on this path in ${spec.name}` : `no operation in ${spec.name} matches this path`;
    return unresolved(`${raw.method} ${concrete}: ${why}`, base, { ...common, params });
  }
  if ('ambiguous' in match) {
    return unresolved(`${raw.method} ${concrete} matches several spec paths (${match.ambiguous.join(', ')})`, base, { ...common, params });
  }
  const op = ops.find((o) => o.method === raw.method && pathShape(o.path) === pathShape(match.template));
  return {
    ...base,
    ...common,
    status: 'resolved',
    reason: null,
    operation: { method: raw.method, path: match.template, operationId: op?.operationId ?? null, inSpec: true },
    params,
  };
}

export { specById };
