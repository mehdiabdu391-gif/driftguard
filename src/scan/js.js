// JavaScript / TypeScript extraction.
//
// Finds (1) which local names hold official SDK clients or HTTP clients, and (2) every call
// made through them, with the arguments it passes. Binding is by name within a file, plus
// imports between files of the scanned repository. Nothing here decides which endpoint a
// call hits; that is resolve.js, using maps built from the SDKs' own source.

import { walk, stringValue } from '../tree.js';
import { emptyTree, mergeTrees } from './args.js';

/**
 * @typedef {import('web-tree-sitter').Node} Node
 * @typedef {import('./args.js').ArgTree} ArgTree
 *
 * @typedef {{kind: 'ctor', sdk: string, variant?: string}
 *   | {kind: 'client', sdk: string, variant?: string, apiVersion?: string}
 *   | {kind: 'factory', sdk: string, variant?: string, apiVersion?: string}
 *   | {kind: 'axios'} | {kind: 'axios-instance', baseURL: string | null}
 *   | {kind: 'actions-github'} | {kind: 'get-octokit'}} Entity
 *
 * @typedef {{type: 'object', tree: ArgTree} | {type: 'string', value: string}
 *   | {type: 'url', value: string} | {type: 'other', node?: Node}} ArgValue
 *
 * @typedef {object} RawSdkCall
 * @property {'sdk'} kind
 * @property {string} sdk
 * @property {string} [variant]
 * @property {string} [apiVersion]  API version pinned in the client constructor
 * @property {'client'} style
 * @property {string[]} chain
 * @property {ArgValue[]} args
 * @property {number} line
 * @property {number} column
 * @property {string} snippet
 *
 * @typedef {object} RawHttpCall
 * @property {'http'} kind
 * @property {string} client
 * @property {string | null} method   null when not statically known
 * @property {string | null} url      static URL with dynamic segments as "{}", null when unknown
 * @property {ArgTree | null} body    null when unknown
 * @property {boolean} hasBody
 * @property {number} line
 * @property {number} column
 * @property {string} snippet
 */

/** Module specifier -> how its exports map to entities. */
const MODULES = {
  stripe: { default: { kind: 'ctor', sdk: 'stripe-node' }, Stripe: { kind: 'ctor', sdk: 'stripe-node' } },
  openai: {
    default: { kind: 'ctor', sdk: 'openai-node' },
    OpenAI: { kind: 'ctor', sdk: 'openai-node' },
    AzureOpenAI: { kind: 'ctor', sdk: 'openai-node', variant: 'azure' },
  },
  '@octokit/rest': { Octokit: { kind: 'ctor', sdk: 'octokit' } },
  octokit: { Octokit: { kind: 'ctor', sdk: 'octokit' }, App: null },
  '@octokit/core': { Octokit: { kind: 'ctor', sdk: 'octokit', variant: 'core' } },
  '@octokit/action': { Octokit: { kind: 'ctor', sdk: 'octokit' } },
  '@actions/github': { '*': { kind: 'actions-github' }, default: { kind: 'actions-github' }, getOctokit: { kind: 'get-octokit' } },
  twilio: { default: { kind: 'ctor', sdk: 'twilio-node' }, Twilio: { kind: 'ctor', sdk: 'twilio-node' }, '*': { kind: 'ctor', sdk: 'twilio-node' } },
  axios: { default: { kind: 'axios' }, '*': { kind: 'axios' } },
};

const AXIOS_METHODS = new Set(['get', 'delete', 'head', 'options', 'post', 'put', 'patch']);
const AXIOS_DATA_METHODS = new Set(['post', 'put', 'patch']);

/**
 * @param {string} module
 * @param {string} imported  'default', '*' or a named export
 * @returns {Entity | null}
 */
export function moduleEntity(module, imported) {
  const m = /** @type {Record<string, any>} */ (MODULES)[module];
  if (!m) return null;
  return m[imported] ?? null;
}

/** @param {Node} n */
function unwrap(n) {
  let cur = n;
  while (cur && ['parenthesized_expression', 'as_expression', 'non_null_expression', 'satisfies_expression', 'await_expression', 'type_assertion'].includes(cur.type)) {
    const inner = cur.namedChild(cur.type === 'type_assertion' ? 1 : 0);
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

/**
 * Key for a call receiver root: identifier name, "this.x", or "call:<fn>".
 * @param {Node} n
 */
function rootKey(n) {
  const u = unwrap(n);
  if (u.type === 'identifier') return u.text;
  if (u.type === 'member_expression') {
    const obj = u.childForFieldName('object');
    const prop = u.childForFieldName('property');
    if (obj?.type === 'this' && prop) return `this.${prop.text}`;
    // StripeService.stripe: a static member of a class (only ever bound for class names).
    if (obj?.type === 'identifier' && prop?.type === 'property_identifier') return `${obj.text}.${prop.text}`;
  }
  if (u.type === 'call_expression') {
    const fn = u.childForFieldName('function');
    if (fn && unwrap(fn).type === 'identifier') return `call:${unwrap(fn).text}`;
  }
  return null;
}

/**
 * Flatten a member chain a.b.c.d into root node and property names.
 * @param {Node} n
 * @returns {{root: Node, props: string[]} | null}
 */
function flattenMember(n) {
  /** @type {string[]} */
  const props = [];
  let cur = unwrap(n);
  while (cur.type === 'member_expression') {
    const prop = cur.childForFieldName('property');
    if (!prop || prop.type !== 'property_identifier') return null;
    props.unshift(prop.text);
    const obj = cur.childForFieldName('object');
    if (!obj) return null;
    const u = unwrap(obj);
    if (u.type === 'this') {
      // this.client.x.y: keep "this.client" as the root.
      const first = props.shift();
      return first ? { root: cur, props } : null;
    }
    cur = u;
  }
  return { root: cur, props };
}

/**
 * Per-file analysis state.
 */
export class JsFile {
  /**
   * @param {string} file  repository-relative path
   * @param {Node} root
   * @param {string} source
   * @param {(file: string, spec: string, imported: string) => Entity | null} resolveImport
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
    /** @type {Map<string, {spec: string, imported: string}>} */
    this.localImports = new Map();
    /** @type {Map<string, string>} exported name -> local name */
    this.exportNames = new Map();
    /** @type {{spec: string, imported: string, as: string}[]} */
    this.reexports = [];
    /** Bumped whenever a binding is added or gains a pin, so bind() runs to a fixed point. */
    this.bindingChanges = 0;
    /** Names bound to clients with different API version pins: their pin is unknown. */
    this.pinConflicts = new Set();
  }

  /**
   * Record a client binding. A later binding of the same SDK can add the API version pin an
   * earlier one lacked (a lazily initialised `let stripe: Stripe | null`); two different pins
   * for one name make the pin unknown rather than whichever came first.
   * @param {string} key
   * @param {Entity} e
   */
  setEntity(key, e) {
    const prev = this.entities.get(key);
    if (!prev) {
      this.entities.set(key, this.pinConflicts.has(key) && 'apiVersion' in e ? withoutPin(e) : e);
      this.bindingChanges++;
      return;
    }
    if (!('sdk' in prev) || !('sdk' in e) || prev.sdk !== e.sdk || prev.kind !== e.kind) return;
    const a = 'apiVersion' in prev ? prev.apiVersion : undefined;
    const b = 'apiVersion' in e ? e.apiVersion : undefined;
    if (!b || a === b || this.pinConflicts.has(key)) return;
    if (a) {
      this.pinConflicts.add(key);
      this.entities.set(key, withoutPin(prev));
    } else {
      this.entities.set(key, /** @type {Entity} */ ({ ...prev, apiVersion: b }));
    }
    this.bindingChanges++;
  }

  /** Collect imports, constants and entity bindings. Runs to a fixed point within the file. */
  bind() {
    this.collectImportsAndConsts();
    for (let pass = 0; pass < 6; pass++) {
      const before = this.bindingChanges;
      this.collectBindings();
      if (this.bindingChanges === before) break;
    }
  }

  collectImportsAndConsts() {
    /** @type {Map<string, number>} */
    const declared = new Map();
    for (const stmt of this.root.namedChildren) {
      if (!stmt) continue;
      if (stmt.type === 'import_statement') this.handleImport(stmt);
      if (stmt.type === 'export_statement') this.handleExportClause(stmt);
    }
    walk(this.root, (n) => {
      if (n.type === 'variable_declarator') {
        const name = n.childForFieldName('name');
        const value = n.childForFieldName('value');
        if (name?.type === 'identifier') declared.set(name.text, (declared.get(name.text) ?? 0) + 1);
        if (name?.type === 'identifier' && value) this.consts.set(name.text, value);
        // const X = require('m') / const { A, B: C } = require('m')
        // const { default: X } = await import('m') / const X = await import('m') (namespace)
        const dyn = value ? dynamicImportSpec(unwrap(value)) : null;
        const req = value ? requireSpec(unwrap(value)) ?? dyn : null;
        // const X = (await import('m')).default / .Named
        const uv = value ? unwrap(value) : null;
        if (!req && name?.type === 'identifier' && uv?.type === 'member_expression') {
          const obj = uv.childForFieldName('object');
          const spec = obj ? dynamicImportSpec(unwrap(obj)) : null;
          const prop = uv.childForFieldName('property')?.text;
          if (spec && prop) this.addImport(name.text, spec, prop);
        }
        if (req && name) {
          if (name.type === 'identifier') this.addImport(name.text, req, dyn ? '*' : 'default');
          if (name.type === 'object_pattern') {
            for (const p of name.namedChildren) {
              if (!p) continue;
              if (p.type === 'shorthand_property_identifier_pattern') this.addImport(p.text, req, p.text);
              if (p.type === 'pair_pattern') {
                const k = p.childForFieldName('key')?.text;
                const v = p.childForFieldName('value');
                if (k && v?.type === 'identifier') this.addImport(v.text, req, k);
              }
            }
          }
        }
      }
      return true;
    });
    // A literal is only a faithful record of what is sent if the name is bound once and
    // never reassigned or mutated afterwards.
    for (const name of mutatedNames(this.root)) this.consts.delete(name);
    for (const [name, count] of declared) if (count > 1) this.consts.delete(name);
  }

  /**
   * @param {string} local
   * @param {string} spec
   * @param {string} imported
   */
  addImport(local, spec, imported) {
    const direct = moduleEntity(spec, imported);
    if (direct) this.entities.set(local, direct);
    else if (spec.startsWith('.') || spec.startsWith('/') || !MODULES_SET.has(spec)) this.localImports.set(local, { spec, imported });
  }

  /** @param {Node} stmt */
  handleImport(stmt) {
    const spec = stringValue(stmt.childForFieldName('source'));
    if (!spec) return;
    const clause = stmt.namedChildren.find((c) => c?.type === 'import_clause');
    if (!clause) return;
    for (const part of clause.namedChildren) {
      if (!part) continue;
      if (part.type === 'identifier') this.addImport(part.text, spec, 'default');
      if (part.type === 'namespace_import') {
        const id = part.namedChildren.find((c) => c?.type === 'identifier');
        if (id) this.addImport(id.text, spec, '*');
      }
      if (part.type === 'named_imports') {
        for (const s of part.namedChildren) {
          if (s?.type !== 'import_specifier') continue;
          const name = s.childForFieldName('name')?.text;
          const alias = s.childForFieldName('alias')?.text ?? name;
          if (name && alias) this.addImport(alias, spec, name);
        }
      }
    }
  }

  /** @param {Node} stmt */
  handleExportClause(stmt) {
    const source = stringValue(stmt.childForFieldName('source'));
    const clause = stmt.namedChildren.find((c) => c?.type === 'export_clause');
    if (clause) {
      for (const s of clause.namedChildren) {
        if (s?.type !== 'export_specifier') continue;
        const name = s.childForFieldName('name')?.text;
        const alias = s.childForFieldName('alias')?.text ?? name;
        if (!name || !alias) continue;
        if (source) this.reexports.push({ spec: source, imported: name, as: alias });
        else this.exportNames.set(alias, name);
      }
      return;
    }
    const decl = stmt.childForFieldName('declaration');
    if (decl) {
      walk(decl, (n) => {
        if (n.type === 'variable_declarator' || n.type === 'function_declaration' || n.type === 'class_declaration') {
          const name = n.childForFieldName('name');
          if (name?.type === 'identifier' || name?.type === 'type_identifier') this.exportNames.set(name.text, name.text);
          if (n.type === 'class_declaration' && name && stmt.text.startsWith('export default')) this.exportNames.set('default', name.text);
          return false;
        }
        return n === decl || n.type === 'lexical_declaration' || n.type === 'variable_declaration';
      });
      return;
    }
    // export default <expr>
    const value = stmt.childForFieldName('value') ?? stmt.namedChildren.find((c) => c && c.type !== 'comment');
    if (value && stmt.text.startsWith('export default')) {
      if (value.type === 'identifier') this.exportNames.set('default', value.text);
      else this.consts.set('__default__', value), this.exportNames.set('default', '__default__');
    }
  }

  /**
   * Entity for a local name, following imports into other files.
   * @param {string} name
   * @returns {Entity | null}
   */
  entityOf(name) {
    const e = this.entities.get(name);
    if (e) return e;
    const imp = this.localImports.get(name);
    if (imp) return this.resolveImport(this.file, imp.spec, imp.imported);
    // Imported class static member: StripeService.getInstance
    const dot = name.indexOf('.');
    if (dot > 0) {
      const head = this.localImports.get(name.slice(0, dot));
      if (head && head.imported !== '*') return this.resolveImport(this.file, head.spec, `${head.imported}.${name.slice(dot + 1)}`);
    }
    return null;
  }

  /**
   * Entity an exported name refers to (used by other files importing this one).
   * @param {string} exported
   * @param {(file: string, spec: string, imported: string) => Entity | null} resolveImport
   * @returns {Entity | null}
   */
  exportedEntity(exported, resolveImport) {
    const dot = exported.indexOf('.');
    if (dot > 0) {
      const head = this.exportNames.get(exported.slice(0, dot));
      if (!head || head === '__default__') return null;
      return this.entities.get(`${head}.${exported.slice(dot + 1)}`) ?? null;
    }
    const local = this.exportNames.get(exported);
    if (local) {
      if (local === '__default__') {
        const v = this.consts.get('__default__');
        return v ? this.exprEntity(v) : null;
      }
      return this.entityOf(local);
    }
    const re = this.reexports.find((r) => r.as === exported);
    if (re) return resolveImport(this.file, re.spec, re.imported);
    return null;
  }

  collectBindings() {
    walk(this.root, (n) => {
      switch (n.type) {
        case 'variable_declarator': {
          const name = n.childForFieldName('name');
          const value = n.childForFieldName('value');
          if (name?.type === 'identifier' && value) this.bindValue(name.text, value);
          break;
        }
        case 'assignment_expression': {
          const left = n.childForFieldName('left');
          const right = n.childForFieldName('right');
          if (left && right) {
            const key = rootKey(left);
            if (key && !key.startsWith('call:')) this.bindValue(key, right);
          }
          break;
        }
        case 'public_field_definition':
        case 'field_definition': {
          const name = n.childForFieldName('name') ?? n.childForFieldName('property');
          const value = n.childForFieldName('value');
          if (name && value) this.bindValue(`this.${name.text}`, value);
          const type = typeName(n);
          if (name && type) this.bindType(`this.${name.text}`, type);
          break;
        }
        case 'required_parameter':
        case 'optional_parameter': {
          const pattern = n.childForFieldName('pattern');
          const type = typeName(n);
          if (pattern && type) {
            const key = pattern.type === 'identifier' ? pattern.text : null;
            if (key) this.bindType(key, type);
            // constructor(private stripe: Stripe)
            if (key && n.namedChildren.some((c) => c?.type === 'accessibility_modifier')) this.bindType(`this.${key}`, type);
          }
          break;
        }
        case 'function_declaration': {
          const name = n.childForFieldName('name');
          const body = n.childForFieldName('body');
          if (name && body) this.bindFactory(name.text, body);
          break;
        }
        case 'class_declaration':
        case 'class': {
          // static getInstance() { return ... } / static stripe = new Stripe(...)
          const cls = n.childForFieldName('name')?.text;
          const body = n.childForFieldName('body');
          if (!cls || !body) break;
          for (const m of body.namedChildren) {
            if (!m || !m.children.some((c) => c?.type === 'static')) continue;
            const mname = (m.childForFieldName('name') ?? m.childForFieldName('property'))?.text;
            if (!mname) continue;
            if (m.type === 'method_definition') {
              const mbody = m.childForFieldName('body');
              if (mbody) this.bindFactory(`${cls}.${mname}`, mbody);
            } else {
              const value = m.childForFieldName('value');
              if (value) this.bindValue(`${cls}.${mname}`, value);
              const type = typeName(m);
              if (type) this.bindType(`${cls}.${mname}`, type);
            }
          }
          break;
        }
        default:
          break;
      }
      return true;
    });
    // const getStripe = () => new Stripe(...)
    for (const [name, value] of this.consts) {
      const u = unwrap(value);
      if (u.type === 'arrow_function' || u.type === 'function_expression' || u.type === 'function') {
        const body = u.childForFieldName('body');
        if (body) this.bindFactory(name, body);
      }
    }
  }

  /**
   * @param {string} key
   * @param {Node} value
   */
  bindValue(key, value) {
    const e = this.exprEntity(value);
    if (!e || (e.kind !== 'client' && e.kind !== 'axios-instance')) return;
    if (this.entities.has(key) && e.kind !== 'client') return;
    this.setEntity(key, e);
  }

  /**
   * TypeScript annotation naming an SDK class: `stripe: Stripe`, `client: OpenAI`.
   * @param {string} key
   * @param {string} type
   */
  bindType(key, type) {
    if (this.entities.has(key)) return;
    const e = this.entityOf(type);
    if (e?.kind === 'ctor') {
      this.entities.set(key, { kind: 'client', sdk: e.sdk, ...(e.variant ? { variant: e.variant } : {}) });
      this.bindingChanges++;
    }
  }

  /**
   * A function whose return value is an SDK client.
   * @param {string} name
   * @param {Node} body
   */
  bindFactory(name, body) {
    const existing = this.entities.get(name);
    if (existing && (existing.kind !== 'factory' || existing.apiVersion)) return;
    /** @type {Entity | null} */
    let found = null;
    if (body.type !== 'statement_block') {
      found = this.exprEntity(body);
    } else {
      walk(body, (n) => {
        if (found) return false;
        if (n.type === 'arrow_function' || n.type === 'function_declaration' || n.type === 'function_expression') return n === body;
        if (n.type === 'return_statement') {
          const v = n.namedChild(0);
          if (v) found = this.exprEntity(v);
          return false;
        }
        return true;
      });
    }
    if (found && found.kind === 'client') this.setEntity(name, { kind: 'factory', sdk: found.sdk, ...(found.variant ? { variant: found.variant } : {}), ...(found.apiVersion ? { apiVersion: found.apiVersion } : {}) });
  }

  /**
   * A Proxy standing in for an SDK client. The SDK comes from the target's type assertion
   * (`{} as Stripe`) or from the clients the handler obtains; the pin only when every client
   * the handler obtains agrees on one.
   * @param {Node} n  new_expression
   * @returns {Entity | null}
   */
  proxyEntity(n) {
    const args = n.childForFieldName('arguments');
    const target = args?.namedChild(0);
    const handler = args?.namedChild(1);
    /** @type {string | null} */
    let sdk = null;
    /** @type {string | undefined} */
    let variant;
    const asType = target?.type === 'as_expression' ? target.namedChild(target.namedChildCount - 1) : null;
    if (asType?.type === 'type_identifier') {
      const t = this.entityOf(asType.text);
      if (t?.kind === 'ctor') ({ sdk, variant } = t);
    }
    /** @type {Set<string | null>} */
    const pins = new Set();
    /** @type {Set<string>} */
    const sdks = new Set();
    if (handler) {
      walk(handler, (m) => {
        if (m.type !== 'call_expression' && m.type !== 'new_expression') return true;
        const e = this.exprEntity(m);
        if (e?.kind === 'client') {
          sdks.add(e.sdk);
          pins.add(e.apiVersion ?? null);
        }
        return true;
      });
    }
    if (!sdk && sdks.size === 1) sdk = [...sdks][0];
    if (!sdk || (sdks.size > 0 && (sdks.size > 1 || !sdks.has(sdk)))) return null;
    const pin = pins.size === 1 ? [...pins][0] : null;
    return { kind: 'client', sdk, ...(variant ? { variant } : {}), ...(pin ? { apiVersion: pin } : {}) };
  }

  /**
   * @param {Node} node
   * @returns {Entity | null}
   */
  exprEntity(node) {
    const n = unwrap(node);
    // key ? new Stripe(key, ...) : null. Branches that are null/undefined are ignored; the
    // rest must agree on the client (and its pin) or the expression is not a known client.
    if (n.type === 'ternary_expression') {
      const branches = ['consequence', 'alternative'].map((f) => n.childForFieldName(f)).filter((b) => b && !['null', 'undefined'].includes(unwrap(b).type) && unwrap(b).text !== 'undefined');
      const es = branches.map((b) => (b ? this.exprEntity(b) : null));
      if (es.length === 0 || es.some((e) => !e)) return null;
      const keys = new Set(es.map((e) => JSON.stringify(e)));
      return keys.size === 1 ? es[0] : null;
    }
    if (n.type === 'identifier') {
      const e = this.entityOf(n.text);
      return e && (e.kind === 'client' || e.kind === 'axios-instance') ? e : null;
    }
    if (n.type === 'member_expression') {
      const key = rootKey(n);
      if (key) {
        const e = key.startsWith('this.') ? this.entities.get(key) : this.entityOf(key);
        if (e && (e.kind === 'client' || e.kind === 'axios-instance')) return e;
      }
      return null;
    }
    if (n.type === 'new_expression' || n.type === 'call_expression') {
      const callee = n.childForFieldName(n.type === 'new_expression' ? 'constructor' : 'function');
      if (!callee) return null;
      const c = unwrap(callee);
      // require('stripe')(key)
      if (c.type === 'call_expression') {
        const spec = requireSpec(c);
        const e = spec ? moduleEntity(spec, 'default') : null;
        if (e?.kind === 'ctor') return { kind: 'client', sdk: e.sdk };
      }
      if (c.type === 'identifier') {
        const e = this.entityOf(c.text);
        if (e?.kind === 'ctor' && e.sdk === 'stripe-node') {
          // new Stripe(key, { apiVersion: '2023-10-16' }) pins the API version for this client.
          const cfg = n.childForFieldName('arguments')?.namedChild(1);
          const v = cfg ? this.argValue(cfg) : null;
          const pin = v?.type === 'object' ? v.tree.fields.apiVersion?.value ?? null : null;
          return { kind: 'client', sdk: e.sdk, ...(pin ? { apiVersion: pin } : {}) };
        }
        // A factory's client carries the pin its constructor set.
        if (e?.kind === 'factory') return { kind: 'client', sdk: e.sdk, ...(e.variant ? { variant: e.variant } : {}), ...(e.apiVersion ? { apiVersion: e.apiVersion } : {}) };
        if (e?.kind === 'ctor') return { kind: 'client', sdk: e.sdk, ...(e.variant ? { variant: e.variant } : {}) };
        // new Proxy({} as Stripe, { get() { return getStripe()[prop] } })
        if (n.type === 'new_expression' && c.text === 'Proxy' && !this.entityOf('Proxy')) return this.proxyEntity(n);
        if (e?.kind === 'get-octokit') return { kind: 'client', sdk: 'octokit' };
      }
      if (c.type === 'member_expression') {
        const obj = c.childForFieldName('object');
        const prop = c.childForFieldName('property')?.text;
        // StripeService.getInstance(): a static factory, in this file or an imported class.
        const sk = rootKey(c);
        const se = sk && !sk.startsWith('this.') ? this.entityOf(sk) : null;
        if (se?.kind === 'factory') return { kind: 'client', sdk: se.sdk, ...(se.variant ? { variant: se.variant } : {}), ...(se.apiVersion ? { apiVersion: se.apiVersion } : {}) };
        const oe = obj && unwrap(obj).type === 'identifier' ? this.entityOf(unwrap(obj).text) : null;
        if (oe?.kind === 'actions-github' && prop === 'getOctokit') return { kind: 'client', sdk: 'octokit' };
        if (oe?.kind === 'ctor' && oe.sdk === 'twilio-node' && prop === 'Twilio') return { kind: 'client', sdk: 'twilio-node' };
        if (oe?.kind === 'axios' && prop === 'create') {
          const cfg = n.childForFieldName('arguments')?.namedChild(0);
          let baseURL = null;
          if (cfg && unwrap(cfg).type === 'object') {
            for (const pair of unwrap(cfg).namedChildren) {
              if (pair?.type === 'pair' && propKey(pair.childForFieldName('key')) === 'baseURL') {
                baseURL = this.staticUrl(pair.childForFieldName('value'));
              }
            }
          }
          return { kind: 'axios-instance', baseURL };
        }
      }
    }
    return null;
  }

  /**
   * Static URL text with dynamic parts written as "{}". Same-file string constants are
   * inlined. Returns null when the leading part (scheme and host) is not static.
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
    if (n.type === 'template_string') {
      let out = '';
      for (const c of n.namedChildren) {
        if (!c) continue;
        if (c.type === 'template_substitution') {
          const inner = c.namedChild(0);
          const v = inner ? this.staticUrl(inner, depth + 1) : null;
          out += v ?? '{}';
        } else {
          out += c.text;
        }
      }
      return out;
    }
    if (n.type === 'binary_expression' && n.childForFieldName('operator')?.text === '+') {
      const l = this.staticUrl(n.childForFieldName('left'), depth + 1);
      const r = this.staticUrl(n.childForFieldName('right'), depth + 1);
      return (l ?? '{}') + (r ?? '{}');
    }
    return null;
  }

  /**
   * Argument value: object literal tree, string, URL-ish, or opaque.
   * @param {Node} node
   * @param {number} [depth]
   * @returns {ArgValue}
   */
  argValue(node, depth = 0) {
    const n = unwrap(node);
    if (n.type === 'object') return { type: 'object', tree: this.objectTree(n, depth) };
    const s = stringValue(n);
    if (s !== null) return { type: 'string', value: s };
    if (n.type === 'identifier' && depth < 3) {
      const v = this.consts.get(n.text);
      if (v && ['object', 'string', 'template_string'].includes(unwrap(v).type)) return this.argValue(v, depth + 1);
    }
    return { type: 'other', node: n };
  }

  /**
   * @param {Node} obj  object literal
   * @param {number} depth
   * @returns {ArgTree}
   */
  objectTree(obj, depth) {
    /** @type {ArgTree} */
    const tree = emptyTree();
    for (const c of obj.namedChildren) {
      if (!c || c.type === 'comment') continue;
      if (c.type === 'pair') {
        const key = propKey(c.childForFieldName('key'));
        const value = c.childForFieldName('value');
        if (key === null) { tree.complete = false; continue; }
        tree.fields[key] = { line: c.startPosition.row + 1, ...this.fieldValue(value, depth) };
      } else if (c.type === 'shorthand_property_identifier') {
        const v = this.consts.get(c.text);
        tree.fields[c.text] = { line: c.startPosition.row + 1, ...(v ? this.fieldValue(v, depth) : { value: null, child: null }) };
      } else if (c.type === 'method_definition') {
        const key = propKey(c.childForFieldName('name'));
        if (key) tree.fields[key] = { line: c.startPosition.row + 1, value: null, child: null };
      } else {
        tree.complete = false; // spread_element or anything else
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
    if (v.type === 'object') return { value: null, child: this.objectTree(v, depth + 1) };
    if (v.type === 'array') {
      /** @type {ArgTree | null} */
      let merged = emptyTree();
      let anyObject = false;
      for (const el of v.namedChildren) {
        if (!el || el.type === 'comment') continue;
        const u = unwrap(el);
        if (u.type === 'object') { merged = mergeTrees(merged, this.objectTree(u, depth + 1)); anyObject = true; }
        else if (stringValue(u) === null) merged = null;
      }
      // Arrays of strings carry their values for enum checks only when there is one.
      const strings = v.namedChildren.map((el) => (el ? stringValue(unwrap(el)) : null));
      if (!anyObject) return { value: strings.length === 1 ? strings[0] : null, child: null };
      return { value: null, child: merged };
    }
    if (v.type === 'identifier' && depth < 6) {
      const c = this.consts.get(v.text);
      if (c && ['object', 'array', 'string', 'template_string'].includes(unwrap(c).type)) return this.fieldValue(c, depth + 1);
    }
    return { value: null, child: null };
  }

  /** @param {Node} n */
  snippet(n) {
    const line = this.lines[n.startPosition.row] ?? '';
    return line.trim().slice(0, 200);
  }

  /**
   * Every SDK and HTTP call in the file.
   * @returns {(RawSdkCall | RawHttpCall)[]}
   */
  calls() {
    /** @type {(RawSdkCall | RawHttpCall)[]} */
    const out = [];
    walk(this.root, (n) => {
      if (n.type !== 'call_expression') return true;
      const fn = n.childForFieldName('function');
      const argsNode = n.childForFieldName('arguments');
      if (!fn || !argsNode || argsNode.type !== 'arguments') return true;
      const args = /** @type {Node[]} */ (argsNode.namedChildren.filter((a) => a && a.type !== 'comment'));
      const pos = { line: n.startPosition.row + 1, column: n.startPosition.column + 1, snippet: this.snippet(n) };
      const f = unwrap(fn);

      if (f.type === 'identifier' && f.text === 'fetch' && !this.entityOf('fetch')) {
        out.push(this.fetchCall(args, pos));
        return true;
      }
      if (f.type === 'identifier') {
        const e = this.entityOf(f.text);
        if (e?.kind === 'axios' || e?.kind === 'axios-instance') {
          const call = this.axiosConfigCall(args, pos, e);
          if (call) out.push(call);
        }
        return true;
      }
      if (f.type !== 'member_expression') return true;
      const flat = flattenMember(f);
      if (!flat || flat.props.length === 0) return true;
      const key = rootKey(flat.root);
      if (!key) return true;
      const entity = key.startsWith('call:') ? this.entityOf(key.slice(5)) : (this.entities.get(key) ?? this.entityOf(key));
      if (!entity) return true;
      if (entity.kind === 'axios' || entity.kind === 'axios-instance') {
        if (flat.props.length === 1) {
          const call = this.axiosMethodCall(flat.props[0], args, pos, entity);
          if (call) out.push(call);
        }
        return true;
      }
      const isClient = entity.kind === 'client' || (entity.kind === 'factory' && key.startsWith('call:'));
      if (!isClient || !('sdk' in entity)) return true;
      out.push({
        kind: 'sdk',
        sdk: entity.sdk,
        ...(entity.variant ? { variant: entity.variant } : {}),
        ...('apiVersion' in entity && entity.apiVersion ? { apiVersion: entity.apiVersion } : {}),
        style: 'client',
        chain: flat.props,
        args: args.map((a) => (a.type === 'spread_element' ? { type: 'other' } : this.argValue(a))),
        ...pos,
      });
      return true;
    });
    return out;
  }

  /**
   * @param {Node[]} args
   * @param {{line: number, column: number, snippet: string}} pos
   * @returns {RawHttpCall}
   */
  fetchCall(args, pos) {
    const url = args[0] ? this.staticUrl(args[0]) : null;
    let method = /** @type {string | null} */ ('GET');
    /** @type {ArgTree | null} */
    let body = emptyTree();
    let hasBody = false;
    const init = args[1] ? this.argValue(args[1]) : null;
    if (init && init.type !== 'object') {
      method = null;
      body = null;
    } else if (init && init.type === 'object') {
      const m = init.tree.fields.method;
      if (m) method = m.value ? m.value.toUpperCase() : null;
      else if (!init.tree.complete) method = null;
      if (Object.prototype.hasOwnProperty.call(init.tree.fields, 'body')) {
        hasBody = true;
        body = this.bodyTree(args[1], 'body');
      } else if (!init.tree.complete) {
        body = null;
      }
    }
    return { kind: 'http', client: 'fetch', method, url, body, hasBody, ...pos };
  }

  /**
   * Body field of a fetch init or axios config: JSON.stringify({...}), new URLSearchParams({...}), or {...}.
   * @param {Node} initNode
   * @param {string} field
   * @returns {ArgTree | null}
   */
  bodyTree(initNode, field) {
    const init = unwrap(initNode);
    const obj = init.type === 'object' ? init : (init.type === 'identifier' ? this.consts.get(init.text) : null);
    if (!obj || unwrap(obj).type !== 'object') return null;
    for (const pair of unwrap(obj).namedChildren) {
      if (pair?.type !== 'pair' || propKey(pair.childForFieldName('key')) !== field) continue;
      const v = pair.childForFieldName('value');
      return v ? this.payloadTree(v) : null;
    }
    return null;
  }

  /**
   * @param {Node} node
   * @returns {ArgTree | null}
   */
  payloadTree(node) {
    const v = unwrap(node);
    if (v.type === 'call_expression' || v.type === 'new_expression') {
      const callee = v.childForFieldName(v.type === 'call_expression' ? 'function' : 'constructor')?.text;
      if (callee === 'JSON.stringify' || callee === 'URLSearchParams' || callee === 'qs.stringify' || callee === 'querystring.stringify') {
        const a = v.childForFieldName('arguments')?.namedChild(0);
        const av = a ? this.argValue(a) : null;
        return av?.type === 'object' ? av.tree : null;
      }
    }
    const av = this.argValue(v);
    return av.type === 'object' ? av.tree : null;
  }

  /**
   * axios.get(url, config) / axios.post(url, data, config)
   * @param {string} prop
   * @param {Node[]} args
   * @param {{line: number, column: number, snippet: string}} pos
   * @param {Entity} entity
   * @returns {RawHttpCall | null}
   */
  axiosMethodCall(prop, args, pos, entity) {
    if (!AXIOS_METHODS.has(prop) && prop !== 'request') return null;
    if (prop === 'request') return this.axiosConfigCall(args, pos, entity);
    const url = joinBase(entity, args[0] ? this.staticUrl(args[0]) : null);
    const hasData = AXIOS_DATA_METHODS.has(prop);
    const body = hasData ? (args[1] ? this.payloadTree(args[1]) : emptyTree()) : emptyTree();
    return { kind: 'http', client: 'axios', method: prop.toUpperCase(), url, body, hasBody: hasData && Boolean(args[1]), ...pos };
  }

  /**
   * axios({method, url, data})
   * @param {Node[]} args
   * @param {{line: number, column: number, snippet: string}} pos
   * @param {Entity} entity
   * @returns {RawHttpCall | null}
   */
  axiosConfigCall(args, pos, entity) {
    const first = args[0] ? unwrap(args[0]) : null;
    if (!first) return null;
    if (first.type !== 'object') {
      // axios(url, config)
      const url = joinBase(entity, this.staticUrl(first));
      if (!url) return null;
      return { kind: 'http', client: 'axios', method: null, url, body: null, hasBody: false, ...pos };
    }
    const cfg = this.objectTree(first, 0);
    let urlNode = null;
    for (const pair of first.namedChildren) {
      if (pair?.type === 'pair' && propKey(pair.childForFieldName('key')) === 'url') urlNode = pair.childForFieldName('value');
    }
    const url = joinBase(entity, urlNode ? this.staticUrl(urlNode) : null);
    const m = cfg.fields.method;
    const method = m ? (m.value ? m.value.toUpperCase() : null) : cfg.complete ? 'GET' : null;
    const hasBody = Boolean(cfg.fields.data);
    const body = hasBody ? this.bodyTree(first, 'data') : cfg.complete ? emptyTree() : null;
    return { kind: 'http', client: 'axios', method, url, body, hasBody, ...pos };
  }
}

const MODULES_SET = new Set(Object.keys(MODULES));

/**
 * @param {Entity} entity
 * @param {string | null} url
 */
function joinBase(entity, url) {
  if (url === null) return null;
  if (/^https?:\/\//.test(url)) return url;
  if (entity.kind === 'axios-instance' && entity.baseURL) return entity.baseURL.replace(/\/+$/, '') + '/' + url.replace(/^\/+/, '');
  return null;
}

/** @param {Node | null} key */
function propKey(key) {
  if (!key) return null;
  if (key.type === 'property_identifier' || key.type === 'identifier' || key.type === 'shorthand_property_identifier') return key.text;
  if (key.type === 'number') return key.text;
  return stringValue(key);
}

/**
 * @param {Entity} e
 * @returns {Entity}
 */
function withoutPin(e) {
  const { apiVersion: _drop, ...rest } = /** @type {any} */ (e);
  return rest;
}

/**
 * `require('x')` -> 'x'
 * @param {Node} n
 */
function requireSpec(n) {
  if (n.type !== 'call_expression') return null;
  if (n.childForFieldName('function')?.text !== 'require') return null;
  return stringValue(n.childForFieldName('arguments')?.namedChild(0) ?? null);
}

/**
 * `import('x')` (dynamic import) -> 'x'
 * @param {Node} n
 */
function dynamicImportSpec(n) {
  if (n.type !== 'call_expression') return null;
  if (n.childForFieldName('function')?.type !== 'import') return null;
  return stringValue(n.childForFieldName('arguments')?.namedChild(0) ?? null);
}

/**
 * Simple type annotation name (`: Stripe`, `: OpenAI`), else null.
 * @param {Node} n
 */
function typeName(n) {
  const ann = n.namedChildren.find((c) => c?.type === 'type_annotation');
  const t = ann?.namedChild(0);
  if (!t) return null;
  if (t.type === 'type_identifier') return t.text;
  return null;
}

/**
 * Names whose value may change after declaration: assigned, compound-assigned, member- or
 * index-assigned, deleted from, or passed as the target of Object.assign.
 * @param {Node} root
 */
function mutatedNames(root) {
  /** @type {Set<string>} */
  const out = new Set();
  /** @param {Node | null} n */
  const base = (n) => {
    let cur = n;
    while (cur && (cur.type === 'member_expression' || cur.type === 'subscript_expression' || cur.type === 'parenthesized_expression' || cur.type === 'non_null_expression')) {
      cur = cur.childForFieldName('object') ?? cur.namedChild(0);
    }
    return cur?.type === 'identifier' ? cur.text : null;
  };
  walk(root, (n) => {
    if (n.type === 'assignment_expression' || n.type === 'augmented_assignment_expression') {
      const name = base(n.childForFieldName('left'));
      if (name) out.add(name);
    }
    if (n.type === 'unary_expression' && n.text.startsWith('delete')) {
      const name = base(n.namedChild(0));
      if (name) out.add(name);
    }
    if (n.type === 'call_expression' && n.childForFieldName('function')?.text === 'Object.assign') {
      const name = base(n.childForFieldName('arguments')?.namedChild(0) ?? null);
      if (name) out.add(name);
    }
    if (n.type === 'update_expression') {
      const name = base(n.namedChild(0));
      if (name) out.add(name);
    }
    return true;
  });
  return out;
}
