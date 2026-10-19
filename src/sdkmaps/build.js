// Builds method-to-endpoint maps for official SDKs from each SDK's own source code at a
// pinned commit. Nothing is hand-written: if the SDK source does not state the HTTP method
// and path for a method, that method is left out of the map and calls to it are reported
// as unresolved.

import path from 'node:path';
import { parse, walk, stringValue } from '../tree.js';
import { headCommit } from '../tracker/github.js';
import { writeJson } from '../tracker/track.js';

/**
 * @typedef {{method: string, path: string, source: string, alternatives?: {method: string, path: string}[]}} Endpoint
 * @typedef {{sdk: string, specId: string, repo: string, sha: string, commitDate: string,
 *   styles: Record<string, Record<string, Endpoint>>, skipped: {key: string, reason: string}[]}} SdkMap
 */

const API = 'https://api.github.com';

/**
 * @param {string} repo
 * @param {string} sha
 * @param {string} file
 */
async function raw(repo, sha, file) {
  const url = `https://raw.githubusercontent.com/${repo}/${sha}/${file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  return res.text();
}

/**
 * @param {string} repo
 * @param {string} sha
 * @returns {Promise<string[]>}
 */
async function listFiles(repo, sha) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'driftguard' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API}/repos/${repo}/git/trees/${sha}?recursive=1`, { headers });
  if (!res.ok) throw new Error(`GitHub tree listing failed (${res.status}) for ${repo}`);
  const body = await res.json();
  if (body.truncated) throw new Error(`GitHub tree listing truncated for ${repo}; cannot build a complete map`);
  return body.tree.filter((/** @type {any} */ t) => t.type === 'blob').map((/** @type {any} */ t) => t.path);
}

/**
 * Run async work over items with bounded concurrency.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 */
async function pool(items, limit, fn) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * Stainless-generated SDKs (openai-node, openai-python) publish an api.md that lists every
 * client method with its HTTP method and path, e.g.
 * <code title="post /chat/completions">client.chat.completions.<a ...>create</a>(...)
 * @param {string} md
 * @param {string} file
 */
export function parseStainlessApiMd(md, file) {
  /** @type {Record<string, Endpoint>} */
  const methods = {};
  const re = /<code title="(get|post|put|patch|delete) ([^"]+)">client\.([\w.]+?)\.?<a [^>]*>(\w+)<\/a>/g;
  for (const m of md.matchAll(re)) {
    const [, verb, p, chain, name] = m;
    methods[`${chain}.${name}`] = { method: verb.toUpperCase(), path: p, source: file };
  }
  return methods;
}

/**
 * @param {string} repo
 * @param {string} sdk
 * @param {string} specId
 * @param {string} ref
 * @param {string[]} styles  style names that share the same method keys
 * @returns {Promise<SdkMap>}
 */
async function buildStainless(repo, sdk, specId, ref, styles) {
  const head = await headCommit(repo, ref);
  const methods = parseStainlessApiMd(await raw(repo, head.sha, 'api.md'), 'api.md');
  if (Object.keys(methods).length < 50) throw new Error(`${sdk}: api.md yielded only ${Object.keys(methods).length} methods; format changed?`);
  return { sdk, specId, repo, sha: head.sha, commitDate: head.date, styles: Object.fromEntries(styles.map((s) => [s, methods])), skipped: [] };
}

/**
 * Octokit's generated endpoint table: { scope: { method: ["VERB /path", ...] } }.
 * @param {string} source
 * @param {string} file
 */
export async function parseOctokitEndpoints(source, file) {
  const tree = await parse('typescript', source);
  /** @type {Record<string, Endpoint>} */
  const methods = {};
  walk(tree.rootNode, (n) => {
    if (n.type !== 'variable_declarator' || n.childForFieldName('name')?.text !== 'Endpoints') return true;
    const root = n.childForFieldName('value');
    if (!root || root.type !== 'object') return false;
    for (const scopePair of root.namedChildren) {
      if (!scopePair || scopePair.type !== 'pair') continue;
      const scope = keyText(scopePair.childForFieldName('key'));
      const inner = scopePair.childForFieldName('value');
      if (!scope || inner?.type !== 'object') continue;
      for (const pair of inner.namedChildren) {
        if (!pair || pair.type !== 'pair') continue;
        const name = keyText(pair.childForFieldName('key'));
        const arr = pair.childForFieldName('value');
        const route = arr?.type === 'array' ? stringValue(arr.namedChild(0)) : null;
        const m = route ? /^(GET|POST|PUT|PATCH|DELETE|HEAD) (\S+)$/.exec(route) : null;
        if (name && m) methods[`${scope}.${name}`] = { method: m[1], path: m[2], source: file };
      }
    }
    return false;
  });
  return methods;
}

/** @param {import('web-tree-sitter').Node | null} node */
function keyText(node) {
  if (!node) return null;
  if (node.type === 'property_identifier' || node.type === 'identifier') return node.text;
  return stringValue(node);
}

async function buildOctokit() {
  const repo = 'octokit/plugin-rest-endpoint-methods.js';
  const head = await headCommit(repo, 'HEAD');
  const file = 'src/generated/endpoints.ts';
  const methods = await parseOctokitEndpoints(await raw(repo, head.sha, file), file);
  if (Object.keys(methods).length < 500) throw new Error(`octokit: endpoints.ts yielded only ${Object.keys(methods).length} methods`);
  /** @type {SdkMap} */
  return { sdk: 'octokit', specId: 'github', repo, sha: head.sha, commitDate: head.date, styles: { client: methods }, skipped: [] };
}

/**
 * stripe-node resource class: methods whose body calls
 * this._makeRequest('VERB', '/v1/...' | `/v1/.../${id}`).
 * @param {string} source
 */
export async function parseStripeNodeResource(source) {
  const tree = await parse('typescript', source);
  /** @type {Record<string, {method: string, path: string, alternatives?: {method: string, path: string}[]}>} */
  const methods = {};
  walk(tree.rootNode, (n) => {
    if (n.type !== 'method_definition') return true;
    const name = n.childForFieldName('name')?.text;
    if (!name) return false;
    /** @type {{method: string, path: string}[]} */
    const found = [];
    walk(n, (c) => {
      if (c.type !== 'call_expression') return true;
      const fn = c.childForFieldName('function');
      if (fn?.type !== 'member_expression' || fn.childForFieldName('property')?.text !== '_makeRequest') return true;
      const args = c.childForFieldName('arguments')?.namedChildren ?? [];
      const verb = stringValue(args[0] ?? null);
      const p = templatePath(args[1] ?? null);
      if (verb && p) found.push({ method: verb.toUpperCase(), path: p });
      return false;
    });
    const entry = withAlternatives(found);
    if (entry && !methods[name]) methods[name] = entry;
    return false;
  });
  return methods;
}

/**
 * Collapse the requests a method can make. A method that can call more than one endpoint
 * (for example stripe-node's accounts.retrieve with and without an id) keeps every
 * alternative so the scanner reports it as ambiguous instead of picking one.
 * @param {{method: string, path: string}[]} found
 */
function withAlternatives(found) {
  const unique = [...new Map(found.map((f) => [`${f.method} ${f.path}`, f])).values()];
  if (unique.length === 0) return null;
  if (unique.length === 1) return unique[0];
  return { ...unique[0], alternatives: unique };
}

/**
 * A string or template literal path with substitutions replaced by "{}".
 * @param {import('web-tree-sitter').Node | null} node
 */
function templatePath(node) {
  if (!node) return null;
  const s = stringValue(node);
  if (s !== null) return s;
  if (node.type !== 'template_string') return null;
  let out = '';
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === 'template_substitution') out += '{}';
    else out += c.text;
  }
  return out;
}

/**
 * stripe-node's resources.ts wires resource classes onto the client:
 *   export {CustomerResource as Customers} from './resources/Customers.js';
 *   export const Billing = resourceNamespace('billing', {Alerts: BillingAlerts, ...});
 * The client exposes each export under pascalToCamelCase(name) (src/utils.ts), and
 * ResourceNamespace lower-cases the first letter of each nested key.
 * @param {string} source
 * @returns {Promise<{prefix: string, file: string}[]>}
 */
export async function parseStripeNodeIndex(source) {
  const tree = await parse('typescript', source);
  /** @type {Map<string, string>} */
  const imports = new Map();
  /** @type {{prefix: string, file: string}[]} */
  const out = [];
  const camel = (/** @type {string} */ s) => (s === 'OAuth' ? 'oauth' : s[0].toLowerCase() + s.slice(1));
  for (const stmt of tree.rootNode.namedChildren) {
    if (!stmt) continue;
    if (stmt.type === 'import_statement') {
      const src = stringValue(stmt.childForFieldName('source'));
      walk(stmt, (n) => {
        if (n.type !== 'import_specifier') return true;
        const alias = n.childForFieldName('alias')?.text ?? n.childForFieldName('name')?.text;
        if (alias && src) imports.set(alias, src);
        return false;
      });
    }
    if (stmt.type === 'export_statement') {
      const src = stringValue(stmt.childForFieldName('source'));
      if (src) {
        walk(stmt, (n) => {
          if (n.type !== 'export_specifier') return true;
          const name = n.childForFieldName('name')?.text ?? '';
          const alias = n.childForFieldName('alias')?.text ?? name.replace(/Resource$/, '');
          out.push({ prefix: camel(alias), file: src });
          return false;
        });
        continue;
      }
      walk(stmt, (n) => {
        if (n.type !== 'variable_declarator') return true;
        const name = n.childForFieldName('name')?.text;
        const value = n.childForFieldName('value');
        if (name && value) collectNamespace(value, camel(name), imports, out);
        return false;
      });
    }
  }
  return out;
}

/**
 * @param {import('web-tree-sitter').Node} call
 * @param {string} prefix
 * @param {Map<string, string>} imports
 * @param {{prefix: string, file: string}[]} out
 */
function collectNamespace(call, prefix, imports, out) {
  if (call.type !== 'call_expression' || call.childForFieldName('function')?.text !== 'resourceNamespace') return;
  const obj = call.childForFieldName('arguments')?.namedChild(1);
  if (obj?.type !== 'object') return;
  for (const pair of obj.namedChildren) {
    if (!pair) continue;
    if (pair.type === 'shorthand_property_identifier') {
      const src = imports.get(pair.text);
      if (src) out.push({ prefix: `${prefix}.${pair.text[0].toLowerCase()}${pair.text.slice(1)}`, file: src });
      continue;
    }
    if (pair.type !== 'pair') continue;
    const key = keyText(pair.childForFieldName('key'));
    const value = pair.childForFieldName('value');
    if (!key || !value) continue;
    const childPrefix = `${prefix}.${key[0].toLowerCase()}${key.slice(1)}`;
    if (value.type === 'identifier') {
      const src = imports.get(value.text);
      if (src) out.push({ prefix: childPrefix, file: src });
    } else {
      collectNamespace(value, childPrefix, imports, out);
    }
  }
}

async function buildStripeNode() {
  const repo = 'stripe/stripe-node';
  const head = await headCommit(repo, 'HEAD');
  const index = await parseStripeNodeIndex(await raw(repo, head.sha, 'src/resources.ts'));
  if (index.length < 50) throw new Error(`stripe-node: resources.ts yielded only ${index.length} resources`);
  /** @type {Record<string, Endpoint>} */
  const methods = {};
  const files = [...new Set(index.map((e) => e.file))];
  /** @type {Map<string, Record<string, {method: string, path: string, alternatives?: {method: string, path: string}[]}>>} */
  const parsed = new Map();
  await pool(files, 12, async (rel) => {
    const file = path.posix.join('src', rel.replace(/\.js$/, '.ts'));
    parsed.set(rel, await parseStripeNodeResource(await raw(repo, head.sha, file)));
  });
  for (const { prefix, file } of index) {
    const res = parsed.get(file) ?? {};
    for (const [name, ep] of Object.entries(res)) {
      methods[`${prefix}.${name}`] = { ...ep, source: path.posix.join('src', file.replace(/\.js$/, '.ts')) };
    }
  }
  /** @type {SdkMap} */
  return { sdk: 'stripe-node', specId: 'stripe', repo, sha: head.sha, commitDate: head.date, styles: { client: methods }, skipped: [] };
}

/**
 * Python helpers -----------------------------------------------------------------------
 */

/**
 * Module-level dicts of the form {"attr": ["stripe._x_service", "XService"], ...}.
 * @param {import('web-tree-sitter').Node} root
 * @param {string} varName
 */
function pyServiceDict(root, varName) {
  /** @type {Record<string, {module: string, cls: string}>} */
  const out = {};
  for (const stmt of root.namedChildren) {
    const assign = stmt?.type === 'expression_statement' ? stmt.namedChild(0) : null;
    if (assign?.type !== 'assignment' || assign.childForFieldName('left')?.text !== varName) continue;
    const dict = assign.childForFieldName('right');
    if (dict?.type !== 'dictionary') continue;
    for (const pair of dict.namedChildren) {
      if (pair?.type !== 'pair') continue;
      const key = stringValue(pair.childForFieldName('key'));
      const val = pair.childForFieldName('value');
      if (!key || val?.type !== 'list') continue;
      const [mod, cls] = val.namedChildren.map((c) => stringValue(c));
      if (mod && cls) out[key] = { module: mod, cls };
    }
  }
  return out;
}

const PY_REQUEST_FNS = new Set(['_request', '_static_request', '_request_stream', '_static_request_stream', '_request_async', '_static_request_async', '_request_stream_async', '_static_request_stream_async']);

/**
 * Static path from a Python argument: "..." , "...".format(...), cls.class_url(),
 * "%s/%s" % (cls.class_url(), id), or a local variable assigned one of these.
 * Python format fields like {customer} are kept; class_url-based ids become "{}".
 * @param {import('web-tree-sitter').Node | null} node
 * @param {string | null} classUrl
 * @param {Map<string, import('web-tree-sitter').Node>} locals
 * @returns {string | null}
 */
function pyPath(node, classUrl, locals) {
  if (!node) return null;
  const s = stringValue(node);
  if (s !== null) return s;
  if (node.type === 'identifier' && locals.has(node.text)) return pyPath(locals.get(node.text) ?? null, classUrl, new Map());
  if (node.type === 'call') {
    const fn = node.childForFieldName('function');
    if (fn?.type === 'attribute') {
      const attr = fn.childForFieldName('attribute')?.text;
      const obj = fn.childForFieldName('object');
      if (attr === 'format' && obj) return stringValue(obj);
      if (attr === 'class_url' && obj?.text === 'cls') return classUrl;
    }
  }
  if (node.type === 'binary_operator' && node.childForFieldName('operator')?.text === '%') {
    const fmt = stringValue(node.childForFieldName('left'));
    const right = node.childForFieldName('right');
    if (fmt === '%s/%s' && right?.type === 'tuple') {
      const first = right.namedChild(0);
      const base = first ? pyPath(first, classUrl, locals) : null;
      if (base) return `${base}/{}`;
    }
  }
  return null;
}

/**
 * Find the HTTP request a Python method body makes.
 * @param {import('web-tree-sitter').Node} fn  function_definition
 * @param {string | null} classUrl
 * @param {boolean} instanceUrlIsDefault
 */
function pyMethodEndpoint(fn, classUrl, instanceUrlIsDefault) {
  /** @type {Map<string, import('web-tree-sitter').Node>} */
  const locals = new Map();
  /** @type {{method: string, path: string}[]} */
  const found = [];
  let refresh = false;
  walk(fn, (n) => {
    if (n.type === 'assignment') {
      const left = n.childForFieldName('left');
      const right = n.childForFieldName('right');
      if (left?.type === 'identifier' && right) locals.set(left.text, right);
    }
    if (n.type !== 'call') return true;
    const f = n.childForFieldName('function');
    const attr = f?.type === 'attribute' ? f.childForFieldName('attribute')?.text : null;
    const args = n.childForFieldName('arguments')?.namedChildren.filter((a) => a && a.type !== 'comment') ?? [];
    if (attr && PY_REQUEST_FNS.has(attr)) {
      const verb = stringValue(args[0] ?? null);
      const p = pyPath(args[1] ?? null, classUrl, locals);
      if (verb && p) found.push({ method: verb.toUpperCase(), path: p });
      return false;
    }
    if (attr === '_search' || attr === '_search_async') {
      for (const a of args) {
        if (a?.type === 'keyword_argument' && a.childForFieldName('name')?.text === 'search_url') {
          const p = stringValue(a.childForFieldName('value'));
          if (p) found.push({ method: 'GET', path: p });
        }
      }
      return false;
    }
    if ((attr === 'refresh' || attr === 'refresh_async') && f?.childForFieldName('object')?.text === 'instance') refresh = true;
    return true;
  });
  // APIResource.retrieve builds an instance and calls refresh(), which requests
  // GET instance_url() = class_url() + "/" + id (stripe/_api_resource.py).
  if (found.length === 0 && refresh && classUrl && instanceUrlIsDefault) found.push({ method: 'GET', path: `${classUrl}/{}` });
  return withAlternatives(found);
}

/**
 * Methods of every class in a Python source file.
 * @param {string} source
 */
export async function parsePythonClasses(source) {
  const tree = await parse('python', source);
  /** @type {{name: string, objectName: string | null, methods: Record<string, {method: string, path: string, alternatives?: {method: string, path: string}[]}>}[]} */
  const classes = [];
  for (const stmt of tree.rootNode.namedChildren) {
    const cls = stmt?.type === 'decorated_definition' ? stmt.childForFieldName('definition') : stmt;
    if (cls?.type !== 'class_definition') continue;
    const name = cls.childForFieldName('name')?.text ?? '';
    const body = cls.childForFieldName('body');
    let objectName = null;
    /** @type {import('web-tree-sitter').Node[]} */
    const fns = [];
    for (const item of body?.namedChildren ?? []) {
      if (!item) continue;
      const def = item.type === 'decorated_definition' ? item.childForFieldName('definition') : item;
      if (def?.type === 'function_definition') fns.push(def);
      if (item.type === 'expression_statement') {
        const a = item.namedChild(0);
        const left = a?.type === 'assignment' ? a.childForFieldName('left')?.text : null;
        if (left === 'OBJECT_NAME') objectName = stringValue(a?.childForFieldName('right') ?? null);
      }
    }
    // class_url() as defined in stripe/_api_resource.py: "/v1/%ss" % OBJECT_NAME.replace(".", "/").
    // Classes that override class_url or instance_url compute URLs differently, so the
    // derived URL is not used for them.
    const fnNames = new Set(fns.map((f) => f.childForFieldName('name')?.text));
    const classUrl = objectName && !fnNames.has('class_url') ? `/v1/${objectName.replace(/\./g, '/')}s` : null;
    const instanceUrlIsDefault = !fnNames.has('instance_url');
    /** @type {Record<string, {method: string, path: string, alternatives?: {method: string, path: string}[]}>} */
    const methods = {};
    for (const fn of fns) {
      const fname = fn.childForFieldName('name')?.text;
      if (!fname || methods[fname]) continue;
      const ep = pyMethodEndpoint(fn, classUrl, instanceUrlIsDefault);
      if (ep) methods[fname] = ep;
    }
    // Public instance/class dual methods delegate to _cls_<name>.
    for (const [fname, ep] of Object.entries(methods)) {
      if (fname.startsWith('_cls_') && !methods[fname.slice(5)]) methods[fname.slice(5)] = ep;
    }
    classes.push({ name, objectName, methods });
  }
  return classes;
}

async function buildStripePython() {
  const repo = 'stripe/stripe-python';
  const head = await headCommit(repo, 'HEAD');
  const all = (await listFiles(repo, head.sha)).filter((f) => f.startsWith('stripe/') && f.endsWith('.py') && !f.includes('/params/') && !f.includes('/_test'));
  /** @type {Map<string, string>} */
  const sources = new Map();
  await pool(all, 16, async (f) => {
    sources.set(f, await raw(repo, head.sha, f));
  });
  const moduleFile = (/** @type {string} */ mod) => `${mod.replace(/\./g, '/')}.py`;

  /** @type {Record<string, Endpoint>} */
  const client = {};
  /** @type {Record<string, Endpoint>} */
  const moduleStyle = {};
  /** @type {{key: string, reason: string}[]} */
  const skipped = [];

  // StripeClient services: client.v1.<svc>..., client.v2.<svc>..., and the deprecated
  // client.<svc> aliases for v1 (stripe/_stripe_client.py).
  /**
   * @param {string} prefix
   * @param {{module: string, cls: string}} svc
   * @param {number} depth
   */
  const visitService = async (prefix, svc, depth) => {
    const file = moduleFile(svc.module);
    const src = sources.get(file);
    if (!src || depth > 6) {
      skipped.push({ key: prefix, reason: `service source ${file} not found` });
      return;
    }
    const tree = await parse('python', src);
    const classes = await parsePythonClasses(src);
    const cls = classes.find((c) => c.name === svc.cls);
    for (const [m, ep] of Object.entries(cls?.methods ?? {})) {
      if (m.startsWith('_')) continue;
      client[`${prefix}.${m}`] = { ...ep, source: file };
    }
    const subs = pyServiceDict(tree.rootNode, '_subservices');
    for (const [attr, sub] of Object.entries(subs)) await visitService(`${prefix}.${attr}`, sub, depth + 1);
  };
  for (const [ver, file] of [['v1', 'stripe/_v1_services.py'], ['v2', 'stripe/_v2_services.py']]) {
    const src = sources.get(file);
    if (!src) throw new Error(`stripe-python: ${file} not found`);
    const tree = await parse('python', src);
    const dict = { ...pyServiceDict(tree.rootNode, '_services'), ...pyServiceDict(tree.rootNode, '_subservices') };
    if (Object.keys(dict).length === 0) throw new Error(`stripe-python: no services found in ${file}`);
    for (const [attr, svc] of Object.entries(dict)) await visitService(`${ver}.${attr}`, svc, 0);
  }
  for (const [key, ep] of Object.entries(client)) {
    if (key.startsWith('v1.')) client[key.slice(3)] = { ...ep };
  }

  // Legacy module style: stripe.Customer.create(...), stripe.billing.Alert.list(...).
  for (const [file, src] of sources) {
    const base = path.posix.basename(file);
    if (!base.startsWith('_') || base.endsWith('_service.py') || base === '__init__.py') continue;
    if (!src.includes('OBJECT_NAME')) continue;
    const pkg = path.posix.dirname(file).split('/').slice(1); // drop leading "stripe"
    for (const cls of await parsePythonClasses(src)) {
      if (!cls.objectName) continue;
      const prefix = [...pkg, cls.name].join('.');
      for (const [m, ep] of Object.entries(cls.methods)) {
        if (m.startsWith('_')) continue;
        moduleStyle[`${prefix}.${m}`] = { ...ep, source: file };
      }
    }
  }
  if (Object.keys(client).length < 200 || Object.keys(moduleStyle).length < 200) {
    throw new Error(`stripe-python: map too small (client ${Object.keys(client).length}, module ${Object.keys(moduleStyle).length})`);
  }
  /** @type {SdkMap} */
  return { sdk: 'stripe-python', specId: 'stripe', repo, sha: head.sha, commitDate: head.date, styles: { client, module: moduleStyle }, skipped };
}

export const BUILDERS = {
  'openai-node': () => buildStainless('openai/openai-node', 'openai-node', 'openai', 'HEAD', ['client']),
  'openai-python': () => buildStainless('openai/openai-python', 'openai-python', 'openai', 'HEAD', ['client', 'module']),
  octokit: buildOctokit,
  'stripe-node': buildStripeNode,
  'stripe-python': buildStripePython,
};

/**
 * @param {string} dataDir
 * @param {{only?: string[], log?: (s: string) => void}} [opts]
 */
export async function buildSdkMaps(dataDir, opts = {}) {
  const log = opts.log ?? ((s) => process.stderr.write(`${s}\n`));
  /** @type {Record<string, number>} */
  const counts = {};
  for (const [id, build] of Object.entries(BUILDERS)) {
    if (opts.only && !opts.only.includes(id)) continue;
    log(`[sdk-map] building ${id}`);
    const map = await build();
    counts[id] = Object.values(map.styles).reduce((n, s) => n + Object.keys(s).length, 0);
    await writeJson(path.join(dataDir, 'sdk-maps', `${id}.json`), map);
    log(`[sdk-map] ${id}: ${counts[id]} method entries from ${map.repo}@${map.sha.slice(0, 10)}`);
  }
  return counts;
}
