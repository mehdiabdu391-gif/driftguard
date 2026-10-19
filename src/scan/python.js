// Python extraction: SDK clients (stripe, openai, twilio) and HTTP clients (requests,
// httpx), bound by name within a file and through imports between the repository's modules.

import { walk, stringValue } from '../tree.js';
import { emptyTree, mergeTrees } from './args.js';

/**
 * @typedef {import('web-tree-sitter').Node} Node
 * @typedef {import('./args.js').ArgTree} ArgTree
 *
 * @typedef {{kind: 'ctor', sdk: string, variant?: string}
 *   | {kind: 'client', sdk: string, variant?: string}
 *   | {kind: 'factory', sdk: string, variant?: string}
 *   | {kind: 'module', sdk: string}
 *   | {kind: 'http-module', name: string}
 *   | {kind: 'http-ctor', name: string}
 *   | {kind: 'http-client', name: string, baseURL: string | null}} Entity
 *
 * @typedef {{type: 'object', tree: ArgTree} | {type: 'string', value: string} | {type: 'other'}} PyArgValue
 *
 * @typedef {object} PyArgs
 * @property {PyArgValue[]} positional
 * @property {Record<string, PyArgValue>} keywords
 * @property {boolean} kwSplat  true when **kwargs or *args is passed
 */

/** module -> imported name -> entity. '' is `import module`. */
const MODULES = {
  stripe: { '': { kind: 'module', sdk: 'stripe-python' }, StripeClient: { kind: 'ctor', sdk: 'stripe-python' } },
  openai: {
    '': { kind: 'module', sdk: 'openai-python' },
    OpenAI: { kind: 'ctor', sdk: 'openai-python' },
    AsyncOpenAI: { kind: 'ctor', sdk: 'openai-python' },
    AzureOpenAI: { kind: 'ctor', sdk: 'openai-python', variant: 'azure' },
    AsyncAzureOpenAI: { kind: 'ctor', sdk: 'openai-python', variant: 'azure' },
  },
  'twilio.rest': { Client: { kind: 'ctor', sdk: 'twilio-python' } },
  requests: { '': { kind: 'http-module', name: 'requests' }, Session: { kind: 'http-ctor', name: 'requests' } },
  httpx: {
    '': { kind: 'http-module', name: 'httpx' },
    Client: { kind: 'http-ctor', name: 'httpx' },
    AsyncClient: { kind: 'http-ctor', name: 'httpx' },
  },
  aiohttp: { ClientSession: { kind: 'http-ctor', name: 'aiohttp' } },
};

/** Constructors reachable as attributes of an imported module: stripe.StripeClient(...) */
const MODULE_ATTR_CTORS = {
  'stripe-python': { StripeClient: { kind: 'ctor', sdk: 'stripe-python' } },
  'openai-python': {
    OpenAI: { kind: 'ctor', sdk: 'openai-python' },
    AsyncOpenAI: { kind: 'ctor', sdk: 'openai-python' },
    AzureOpenAI: { kind: 'ctor', sdk: 'openai-python', variant: 'azure' },
    AsyncAzureOpenAI: { kind: 'ctor', sdk: 'openai-python', variant: 'azure' },
  },
};

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/**
 * @param {string} module
 * @param {string} name
 * @returns {Entity | null}
 */
function moduleEntity(module, name) {
  const m = /** @type {Record<string, any>} */ (MODULES)[module];
  return m?.[name] ?? null;
}

/** @param {Node} n */
function unwrap(n) {
  let cur = n;
  while (cur && (cur.type === 'parenthesized_expression' || cur.type === 'await')) {
    const inner = cur.namedChild(0);
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

/** @param {Node} n */
function rootKey(n) {
  const u = unwrap(n);
  if (u.type === 'identifier') return u.text;
  if (u.type === 'attribute') {
    const obj = u.childForFieldName('object');
    const attr = u.childForFieldName('attribute');
    if (obj?.type === 'identifier' && (obj.text === 'self' || obj.text === 'cls') && attr) return `self.${attr.text}`;
  }
  if (u.type === 'call') {
    const fn = u.childForFieldName('function');
    if (fn?.type === 'identifier') return `call:${fn.text}`;
  }
  return null;
}

/**
 * @param {Node} n
 * @returns {{root: Node, props: string[]} | null}
 */
function flattenAttr(n) {
  /** @type {string[]} */
  const props = [];
  let cur = unwrap(n);
  while (cur.type === 'attribute') {
    const attr = cur.childForFieldName('attribute');
    const obj = cur.childForFieldName('object');
    if (!attr || !obj) return null;
    props.unshift(attr.text);
    const u = unwrap(obj);
    if (u.type === 'identifier' && (u.text === 'self' || u.text === 'cls')) {
      const first = props.shift();
      return first ? { root: cur, props } : null;
    }
    cur = u;
  }
  return { root: cur, props };
}

export class PyFile {
  /**
   * @param {string} file
   * @param {Node} root
   * @param {string} source
   * @param {(file: string, module: string, name: string, level: number) => Entity | null} resolveImport
   */
  constructor(file, root, source, resolveImport) {
    this.file = file;
    this.root = root;
    this.lines = source.split('\n');
    this.resolveImport = resolveImport;
    /** @type {Map<string, Entity>} */
    this.entities = new Map();
    /** @type {Map<string, Node>} */
    this.consts = new Map();
    /** @type {Map<string, {module: string, name: string, level: number}>} */
    this.localImports = new Map();
  }

  bind() {
    this.collectImports();
    for (let pass = 0; pass < 4; pass++) {
      const before = this.entities.size;
      this.collectBindings();
      if (this.entities.size === before) break;
    }
  }

  collectImports() {
    /** @type {Map<string, number>} */
    const assigned = new Map();
    /** @type {Set<string>} */
    const mutated = new Set();
    walk(this.root, (n) => {
      if (n.type === 'import_statement') {
        for (const c of n.namedChildren) {
          if (!c) continue;
          const name = c.type === 'aliased_import' ? c.childForFieldName('name')?.text : c.type === 'dotted_name' ? c.text : null;
          const alias = c.type === 'aliased_import' ? c.childForFieldName('alias')?.text : name?.split('.')[0];
          if (!name || !alias) continue;
          const e = moduleEntity(name, '');
          if (e && (c.type === 'aliased_import' || !name.includes('.'))) this.entities.set(alias, e);
        }
        return false;
      }
      if (n.type === 'import_from_statement') {
        const modNode = n.childForFieldName('module_name');
        if (!modNode) return false;
        let level = 0;
        let mod = modNode.text;
        if (modNode.type === 'relative_import') {
          const prefix = modNode.namedChildren.find((c) => c?.type === 'import_prefix');
          level = prefix ? prefix.text.length : 0;
          mod = modNode.namedChildren.find((c) => c?.type === 'dotted_name')?.text ?? '';
        }
        for (const c of n.namedChildren) {
          if (!c || c === modNode) continue;
          const name = c.type === 'aliased_import' ? c.childForFieldName('name')?.text : c.type === 'dotted_name' ? c.text : null;
          const alias = c.type === 'aliased_import' ? c.childForFieldName('alias')?.text : name;
          if (!name || !alias) continue;
          const e = level === 0 ? moduleEntity(mod, name) : null;
          if (e) this.entities.set(alias, e);
          else if (level > 0 || !Object.prototype.hasOwnProperty.call(MODULES, mod.split('.')[0])) this.localImports.set(alias, { module: mod, name, level });
        }
        return false;
      }
      if (n.type === 'assignment') {
        const left = n.childForFieldName('left');
        const right = n.childForFieldName('right');
        if (left?.type === 'identifier') assigned.set(left.text, (assigned.get(left.text) ?? 0) + 1);
        if (left?.type === 'identifier' && right) this.consts.set(left.text, right);
        // x["k"] = v / x.k = v mutate x
        if (left && (left.type === 'subscript' || left.type === 'attribute')) {
          const root = pyBase(left);
          if (root) mutated.add(root);
        }
      }
      if (n.type === 'augmented_assignment') {
        const root = pyBase(n.childForFieldName('left'));
        if (root) mutated.add(root);
      }
      if (n.type === 'call') {
        // d.update(...), d.setdefault(...), d.pop(...), d.__setitem__(...)
        const fn = n.childForFieldName('function');
        const attr = fn?.type === 'attribute' ? fn.childForFieldName('attribute')?.text : null;
        if (attr && ['update', 'setdefault', 'pop', 'popitem', 'clear', '__setitem__', 'append', 'extend'].includes(attr)) {
          const root = pyBase(fn?.childForFieldName('object') ?? null);
          if (root) mutated.add(root);
        }
      }
      if (n.type === 'delete_statement') {
        const root = pyBase(n.namedChild(0));
        if (root) mutated.add(root);
      }
      return true;
    });
    // Only names bound once and never mutated count as static values.
    for (const name of mutated) this.consts.delete(name);
    for (const [name, count] of assigned) if (count > 1) this.consts.delete(name);
  }

  /**
   * @param {string} name
   * @returns {Entity | null}
   */
  entityOf(name) {
    const e = this.entities.get(name);
    if (e) return e;
    const imp = this.localImports.get(name);
    if (imp) return this.resolveImport(this.file, imp.module, imp.name, imp.level);
    return null;
  }

  /**
   * Entity bound to a module-level name, for other modules importing it.
   * @param {string} name
   */
  exportedEntity(name) {
    return this.entityOf(name);
  }

  collectBindings() {
    walk(this.root, (n) => {
      if (n.type === 'assignment') {
        const left = n.childForFieldName('left');
        const right = n.childForFieldName('right');
        const type = n.childForFieldName('type');
        if (left) {
          const key = rootKey(left);
          if (key && !key.startsWith('call:')) {
            if (right) this.bindValue(key, right);
            if (type) this.bindType(key, type);
          }
        }
      }
      if (n.type === 'with_item') {
        // with httpx.Client(base_url=...) as client:
        const value = n.childForFieldName('value');
        if (value?.type === 'as_pattern') {
          const expr = value.namedChild(0);
          const target = value.childForFieldName('alias') ?? value.namedChildren.find((c) => c?.type === 'as_pattern_target');
          const id = target?.type === 'identifier' ? target : target?.namedChild(0);
          if (expr && id?.type === 'identifier') this.bindValue(id.text, expr);
        }
      }
      if (n.type === 'typed_parameter' || n.type === 'typed_default_parameter') {
        const id = n.namedChildren.find((c) => c?.type === 'identifier');
        const type = n.childForFieldName('type');
        if (id && type) this.bindType(id.text, type);
      }
      if (n.type === 'function_definition') {
        const name = n.childForFieldName('name');
        const body = n.childForFieldName('body');
        if (name && body) this.bindFactory(name.text, body);
      }
      return true;
    });
  }

  /**
   * @param {string} key
   * @param {Node} value
   */
  bindValue(key, value) {
    if (this.entities.has(key)) return;
    const e = this.exprEntity(value);
    if (e && (e.kind === 'client' || e.kind === 'http-client')) this.entities.set(key, e);
  }

  /**
   * @param {string} key
   * @param {Node} type
   */
  bindType(key, type) {
    if (this.entities.has(key)) return;
    const t = type.namedChild(0) ?? type;
    if (t.type !== 'identifier') return;
    const e = this.entityOf(t.text);
    if (e?.kind === 'ctor') this.entities.set(key, { kind: 'client', sdk: e.sdk, ...(e.variant ? { variant: e.variant } : {}) });
  }

  /**
   * @param {string} name
   * @param {Node} body
   */
  bindFactory(name, body) {
    if (this.entities.has(name)) return;
    /** @type {any} */
    let found = null;
    walk(body, (n) => {
      if (found) return false;
      if (n.type === 'function_definition' || n.type === 'lambda') return false;
      if (n.type === 'return_statement') {
        const v = n.namedChild(0);
        if (v) found = this.exprEntity(v);
        return false;
      }
      return true;
    });
    if (found && found.kind === 'client') this.entities.set(name, { kind: 'factory', sdk: found.sdk, ...(found.variant ? { variant: found.variant } : {}) });
  }

  /**
   * @param {Node} node
   * @returns {Entity | null}
   */
  exprEntity(node) {
    const n = unwrap(node);
    if (n.type === 'identifier') {
      const e = this.entityOf(n.text);
      return e && (e.kind === 'client' || e.kind === 'http-client') ? e : null;
    }
    if (n.type === 'attribute') {
      const key = rootKey(n);
      const e = key ? this.entities.get(key) : null;
      return e && (e.kind === 'client' || e.kind === 'http-client') ? e : null;
    }
    if (n.type !== 'call') return null;
    const fn = n.childForFieldName('function');
    if (!fn) return null;
    /** @type {Entity | null} */
    let ctor = null;
    if (fn.type === 'identifier') ctor = this.entityOf(fn.text);
    if (fn.type === 'attribute') {
      const obj = fn.childForFieldName('object');
      const attr = fn.childForFieldName('attribute')?.text;
      const oe = obj?.type === 'identifier' ? this.entityOf(obj.text) : null;
      if (oe?.kind === 'module' && attr) ctor = /** @type {Record<string, any>} */ (MODULE_ATTR_CTORS)[oe.sdk]?.[attr] ?? null;
      if (oe?.kind === 'http-module' && (attr === 'Client' || attr === 'AsyncClient' || attr === 'Session')) ctor = { kind: 'http-ctor', name: oe.name };
      // twilio.rest.Client(...)
      if (fn.text === 'twilio.rest.Client') ctor = { kind: 'ctor', sdk: 'twilio-python' };
    }
    if (!ctor) return null;
    if (ctor.kind === 'ctor' || ctor.kind === 'factory') return { kind: 'client', sdk: ctor.sdk, ...(ctor.variant ? { variant: ctor.variant } : {}) };
    if (ctor.kind === 'http-ctor') {
      let baseURL = null;
      for (const a of n.childForFieldName('arguments')?.namedChildren ?? []) {
        if (a?.type === 'keyword_argument' && a.childForFieldName('name')?.text === 'base_url') baseURL = this.staticUrl(a.childForFieldName('value'));
      }
      return { kind: 'http-client', name: ctor.name, baseURL };
    }
    return null;
  }

  /**
   * @param {Node | null} node
   * @param {number} [depth]
   * @returns {string | null}
   */
  staticUrl(node, depth = 0) {
    if (!node || depth > 5) return null;
    const n = unwrap(node);
    const s = stringValue(n);
    if (s !== null) return s;
    if (n.type === 'identifier') {
      const v = this.consts.get(n.text);
      return v ? this.staticUrl(v, depth + 1) : null;
    }
    if (n.type === 'string') {
      // f-string: interpolations become "{}" unless they name a static constant.
      let out = '';
      for (const c of n.namedChildren) {
        if (!c || c.type === 'string_start' || c.type === 'string_end') continue;
        if (c.type === 'interpolation') {
          const inner = c.namedChild(0);
          const v = inner?.type === 'identifier' ? this.staticUrl(inner, depth + 1) : null;
          out += v ?? '{}';
        } else {
          out += c.text;
        }
      }
      return out;
    }
    if (n.type === 'binary_operator' && n.childForFieldName('operator')?.text === '+') {
      const l = this.staticUrl(n.childForFieldName('left'), depth + 1);
      const r = this.staticUrl(n.childForFieldName('right'), depth + 1);
      return (l ?? '{}') + (r ?? '{}');
    }
    if (n.type === 'call') {
      const fn = n.childForFieldName('function');
      if (fn?.type === 'attribute' && fn.childForFieldName('attribute')?.text === 'format') {
        const base = stringValue(fn.childForFieldName('object'));
        return base ? base.replace(/\{[^}]*\}/g, '{}') : null;
      }
    }
    return null;
  }

  /**
   * @param {Node} node
   * @param {number} [depth]
   * @returns {PyArgValue}
   */
  argValue(node, depth = 0) {
    const n = unwrap(node);
    if (n.type === 'dictionary') return { type: 'object', tree: this.dictTree(n, depth) };
    if (n.type === 'call' && n.childForFieldName('function')?.text === 'dict') {
      return { type: 'object', tree: this.kwTree(n.childForFieldName('arguments'), depth) };
    }
    const s = stringValue(n);
    if (s !== null) return { type: 'string', value: s };
    if (n.type === 'identifier' && depth < 3) {
      const v = this.consts.get(n.text);
      if (v && (unwrap(v).type === 'dictionary' || unwrap(v).type === 'string')) return this.argValue(v, depth + 1);
    }
    return { type: 'other' };
  }

  /**
   * @param {Node} dict
   * @param {number} depth
   * @returns {ArgTree}
   */
  dictTree(dict, depth) {
    const tree = emptyTree();
    for (const c of dict.namedChildren) {
      if (!c || c.type === 'comment') continue;
      if (c.type !== 'pair') { tree.complete = false; continue; }
      const key = stringValue(c.childForFieldName('key'));
      if (key === null) { tree.complete = false; continue; }
      tree.fields[key] = { line: c.startPosition.row + 1, ...this.fieldValue(c.childForFieldName('value'), depth) };
    }
    return tree;
  }

  /**
   * Keyword arguments of dict(...) or a call, as a tree.
   * @param {Node | null} args
   * @param {number} depth
   */
  kwTree(args, depth) {
    const tree = emptyTree();
    for (const a of args?.namedChildren ?? []) {
      if (!a || a.type === 'comment') continue;
      if (a.type === 'keyword_argument') {
        const name = a.childForFieldName('name')?.text;
        if (name) tree.fields[name] = { line: a.startPosition.row + 1, ...this.fieldValue(a.childForFieldName('value'), depth) };
      } else {
        tree.complete = false;
      }
    }
    return tree;
  }

  /**
   * @param {Node | null} value
   * @param {number} depth
   * @returns {{value: string | null, child: ArgTree | null}}
   */
  fieldValue(value, depth) {
    if (!value || depth > 12) return { value: null, child: null };
    const v = unwrap(value);
    const s = stringValue(v);
    if (s !== null) return { value: s, child: null };
    if (v.type === 'dictionary') return { value: null, child: this.dictTree(v, depth + 1) };
    if (v.type === 'call' && v.childForFieldName('function')?.text === 'dict') return { value: null, child: this.kwTree(v.childForFieldName('arguments'), depth + 1) };
    if (v.type === 'list' || v.type === 'tuple') {
      /** @type {ArgTree | null} */
      let merged = emptyTree();
      let anyDict = false;
      for (const el of v.namedChildren) {
        if (!el || el.type === 'comment') continue;
        const u = unwrap(el);
        if (u.type === 'dictionary') { merged = mergeTrees(merged, this.dictTree(u, depth + 1)); anyDict = true; }
        else if (stringValue(u) === null) merged = null;
      }
      const strings = v.namedChildren.map((el) => (el ? stringValue(unwrap(el)) : null));
      if (!anyDict) return { value: strings.length === 1 ? strings[0] : null, child: null };
      return { value: null, child: merged };
    }
    if (v.type === 'identifier' && depth < 6) {
      const c = this.consts.get(v.text);
      if (c && ['dictionary', 'list', 'string'].includes(unwrap(c).type)) return this.fieldValue(c, depth + 1);
    }
    return { value: null, child: null };
  }

  /**
   * @param {Node | null} argsNode
   * @returns {PyArgs}
   */
  args(argsNode) {
    /** @type {PyArgs} */
    const out = { positional: [], keywords: {}, kwSplat: false };
    for (const a of argsNode?.namedChildren ?? []) {
      if (!a || a.type === 'comment') continue;
      if (a.type === 'keyword_argument') {
        const name = a.childForFieldName('name')?.text;
        const value = a.childForFieldName('value');
        if (name && value) out.keywords[name] = this.argValue(value);
      } else if (a.type === 'dictionary_splat' || a.type === 'list_splat') {
        out.kwSplat = true;
      } else {
        out.positional.push(this.argValue(a));
      }
    }
    return out;
  }

  /**
   * Keyword arguments of a call as an ArgTree (for SDK methods that take **params).
   * @param {Node | null} argsNode
   */
  keywordTree(argsNode) {
    // Positional arguments (ids) are not request fields; only **kwargs makes the set open.
    const tree = emptyTree();
    for (const a of argsNode?.namedChildren ?? []) {
      if (!a || a.type === 'comment') continue;
      if (a.type === 'keyword_argument') {
        const name = a.childForFieldName('name')?.text;
        if (name) tree.fields[name] = { line: a.startPosition.row + 1, ...this.fieldValue(a.childForFieldName('value'), 0) };
      } else if (a.type === 'dictionary_splat') {
        tree.complete = false;
      }
    }
    return tree;
  }

  /**
   * `stripe.api_version = "2023-10-16"` anywhere in the file pins the module-level version.
   * @param {string} moduleName
   */
  moduleApiVersion(moduleName) {
    /** @type {string | null} */
    let pin = null;
    walk(this.root, (n) => {
      if (pin) return false;
      if (n.type === 'assignment' && n.childForFieldName('left')?.text === `${moduleName}.api_version`) pin = stringValue(n.childForFieldName('right'));
      return true;
    });
    return pin;
  }

  /** @param {Node} n */
  snippet(n) {
    return (this.lines[n.startPosition.row] ?? '').trim().slice(0, 200);
  }

  calls() {
    /** @type {any[]} */
    const out = [];
    walk(this.root, (n) => {
      if (n.type !== 'call') return true;
      const fn = n.childForFieldName('function');
      const argsNode = n.childForFieldName('arguments');
      if (!fn || argsNode?.type !== 'argument_list') return true;
      if (fn.type !== 'attribute') return true;
      const flat = flattenAttr(fn);
      if (!flat || flat.props.length === 0) return true;
      const key = rootKey(flat.root);
      if (!key) return true;
      const entity = key.startsWith('call:') ? this.entityOf(key.slice(5)) : (this.entities.get(key) ?? this.entityOf(key));
      if (!entity) return true;
      const pos = { line: n.startPosition.row + 1, column: n.startPosition.column + 1, snippet: this.snippet(n) };

      if (entity.kind === 'http-module' || entity.kind === 'http-client') {
        if (flat.props.length !== 1) return true;
        const call = this.httpCall(flat.props[0], argsNode, pos, entity);
        if (call) out.push(call);
        return true;
      }
      if (entity.kind === 'module') {
        // stripe.Customer.create(...), openai.chat.completions.create(...); skip constructors.
        if (flat.props.length < 2) return true;
        const pin = entity.sdk === 'stripe-python' ? this.moduleApiVersion(key) : null;
        out.push({ kind: 'sdk', sdk: entity.sdk, style: 'module', chain: flat.props, pyArgs: this.args(argsNode), kwargs: this.keywordTree(argsNode), ...(pin ? { apiVersion: pin } : {}), ...pos });
        return true;
      }
      const isClient = entity.kind === 'client' || (entity.kind === 'factory' && key.startsWith('call:'));
      if (!isClient || !('sdk' in entity)) return true;
      out.push({
        kind: 'sdk',
        sdk: entity.sdk,
        ...(entity.variant ? { variant: entity.variant } : {}),
        style: 'client',
        chain: flat.props,
        pyArgs: this.args(argsNode),
        kwargs: this.keywordTree(argsNode),
        ...pos,
      });
      return true;
    });
    return out;
  }

  /**
   * requests.post(url, json=..., data=..., params=...) / httpx / client.get(...)
   * @param {string} prop
   * @param {Node} argsNode
   * @param {{line: number, column: number, snippet: string}} pos
   * @param {Extract<Entity, {name: string}>} entity
   */
  httpCall(prop, argsNode, pos, entity) {
    const args = argsNode.namedChildren.filter((a) => a && a.type !== 'comment');
    const kw = (/** @type {string} */ name) => args.find((a) => a?.type === 'keyword_argument' && a.childForFieldName('name')?.text === name)?.childForFieldName('value') ?? null;
    const positional = args.filter((a) => a && a.type !== 'keyword_argument' && a.type !== 'dictionary_splat');
    let method = null;
    let urlNode = null;
    if (HTTP_METHODS.has(prop)) {
      method = prop.toUpperCase();
      urlNode = positional[0] ?? kw('url');
    } else if (prop === 'request') {
      const m = positional[0] ? stringValue(positional[0]) : stringValue(kw('method'));
      method = m ? m.toUpperCase() : null;
      urlNode = positional[1] ?? kw('url');
    } else {
      return null;
    }
    let url = urlNode ? this.staticUrl(urlNode) : null;
    if (url !== null && !/^https?:\/\//.test(url)) {
      const base = entity.kind === 'http-client' ? entity.baseURL : null;
      url = base ? base.replace(/\/+$/, '') + '/' + url.replace(/^\/+/, '') : null;
    }
    const splat = args.some((a) => a?.type === 'dictionary_splat');
    const parts = ['json', 'data', 'params'].map((k) => kw(k)).filter(Boolean);
    let hasBody = Boolean(kw('json') || kw('data'));
    /** @type {ArgTree | null} */
    let body = splat ? null : emptyTree();
    for (const p of parts) {
      const v = this.argValue(/** @type {Node} */ (p));
      body = v.type === 'object' ? mergeTrees(body, v.tree) : null;
    }
    // requests.post(url, payload): second positional is data for post/put/patch
    if (positional[1] && (method === 'POST' || method === 'PUT' || method === 'PATCH') && prop !== 'request') {
      hasBody = true;
      const v = this.argValue(positional[1]);
      body = v.type === 'object' ? mergeTrees(body, v.tree) : null;
    }
    return { kind: 'http', client: entity.kind === 'http-module' ? entity.name : `${entity.name}.client`, method, url, body, hasBody, ...pos };
  }
}

/**
 * Root identifier of an attribute/subscript chain.
 * @param {Node | null} n
 */
function pyBase(n) {
  let cur = n;
  while (cur && (cur.type === 'attribute' || cur.type === 'subscript')) cur = cur.childForFieldName(cur.type === 'attribute' ? 'object' : 'value');
  return cur?.type === 'identifier' ? cur.text : null;
}
