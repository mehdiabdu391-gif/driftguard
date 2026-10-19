// Repository scan: find every call to a tracked provider and resolve it to an operation.

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse, grammarFor } from '../tree.js';
import { JsFile } from './js.js';
import { PyFile } from './python.js';
import { ModuleResolver } from './modules.js';
import { resolveCall } from './resolve.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', 'coverage', 'vendor',
  '__pycache__', '.venv', 'venv', 'env', '.tox', 'site-packages', '.mypy_cache', '.pytest_cache', '.turbo', '.cache',
]);
const MAX_FILE_BYTES = 1024 * 1024;

/** Text that suggests a file talks to a tracked provider or uses an HTTP client. */
const SEED_RE = /stripe|openai|octokit|@actions\/github|twilio|axios|fetch\s*\(|requests|httpx|aiohttp|api\.github\.com/i;

/**
 * @param {string} root
 * @param {string[]} [exclude]  path prefixes (repository-relative) to skip
 */
async function listFiles(root, exclude = []) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  const visit = async (rel) => {
    const abs = path.join(root, rel);
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (exclude.some((x) => childRel === x || childRel.startsWith(`${x}/`))) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await visit(childRel);
      } else if (e.isFile()) {
        if (grammarFor(e.name) || e.name === 'tsconfig.json' || e.name === 'jsconfig.json') out.push(childRel);
      }
    }
  };
  await visit('');
  return out;
}

/**
 * @param {string} text
 * @returns {{js: string[], py: {module: string, level: number}[]}}
 */
function importSpecs(text) {
  const js = [...text.matchAll(/(?:from\s+|require\(\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const py = [...text.matchAll(/^\s*from\s+(\.*)([\w.]*)\s+import\s/gm)].map((m) => ({ level: m[1].length, module: m[2] }));
  return { js, py };
}

/**
 * @param {string} root
 * @param {import('./resolve.js').Context & {exclude?: string[]}} ctx
 */
export async function scanRepository(root, ctx) {
  const all = await listFiles(root, ctx.exclude);
  /** @type {Map<string, string>} */
  const sources = new Map();
  for (const f of all) {
    const abs = path.join(root, f);
    if ((await stat(abs)).size > MAX_FILE_BYTES) continue;
    if (/\.min\.js$/.test(f)) continue;
    sources.set(f, await readFile(abs, 'utf8'));
  }
  const fileSet = new Set(sources.keys());
  const resolver = new ModuleResolver(fileSet, sources);

  // Seed files mention a provider or HTTP client; files importing them (transitively) are
  // included so clients created in one module and used in another are followed.
  const code = [...sources.keys()].filter((f) => grammarFor(f));
  /** @type {Map<string, Set<string>>} */
  const importers = new Map();
  for (const f of code) {
    const text = /** @type {string} */ (sources.get(f));
    const { js, py } = importSpecs(text);
    const targets = grammarFor(f) === 'python' ? py.map((s) => resolver.resolvePy(f, s.module, s.level)) : js.map((s) => resolver.resolveJs(f, s));
    for (const t of targets) {
      if (!t) continue;
      if (!importers.has(t)) importers.set(t, new Set());
      importers.get(t)?.add(f);
    }
  }
  const included = new Set(code.filter((f) => SEED_RE.test(/** @type {string} */ (sources.get(f)))));
  let frontier = [...included];
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    /** @type {string[]} */
    const next = [];
    for (const f of frontier) for (const imp of importers.get(f) ?? []) if (!included.has(imp)) { included.add(imp); next.push(imp); }
    frontier = next;
  }

  /** @type {Map<string, JsFile | PyFile>} */
  const files = new Map();
  /** @type {any[]} */
  const trees = [];
  /** @type {Set<string>} */
  const resolving = new Set();

  /** @type {(file: string, spec: string, imported: string) => any} */
  const resolveJsImport = (from, spec, imported) => {
    const target = resolver.resolveJs(from, spec);
    const f = target ? files.get(target) : null;
    if (!f || !(f instanceof JsFile)) return null;
    const guard = `${target}#${imported}`;
    if (resolving.has(guard)) return null;
    resolving.add(guard);
    try {
      return f.exportedEntity(imported, resolveJsImport);
    } finally {
      resolving.delete(guard);
    }
  };
  /** @type {(file: string, module: string, name: string, level: number) => any} */
  const resolvePyImport = (from, module, name, level) => {
    const target = resolver.resolvePy(from, module, level);
    const f = target ? files.get(target) : null;
    if (!f || !(f instanceof PyFile)) return null;
    const guard = `${target}#${name}`;
    if (resolving.has(guard)) return null;
    resolving.add(guard);
    try {
      return f.exportedEntity(name);
    } finally {
      resolving.delete(guard);
    }
  };

  /** @type {{file: string, error: string}[]} */
  const parseErrors = [];
  for (const f of included) {
    const grammar = grammarFor(f);
    if (!grammar) continue;
    const source = /** @type {string} */ (sources.get(f));
    try {
      const tree = await parse(grammar, source);
      trees.push(tree);
      const file = grammar === 'python' ? new PyFile(f, tree.rootNode, source, resolvePyImport) : new JsFile(f, tree.rootNode, source, resolveJsImport);
      files.set(f, file);
    } catch (err) {
      parseErrors.push({ file: f, error: String(/** @type {any} */ (err).message ?? err) });
    }
  }

  // Bind across files until no new bindings appear.
  for (const f of files.values()) f instanceof JsFile ? f.collectImportsAndConsts() : f.collectImports();
  for (let round = 0; round < 5; round++) {
    let before = 0;
    let after = 0;
    for (const f of files.values()) before += f.entities.size;
    for (const f of files.values()) f.collectBindings();
    for (const f of files.values()) after += f.entities.size;
    if (after === before) break;
  }

  /** @type {import('./resolve.js').CallSite[]} */
  const callSites = [];
  let candidateCalls = 0;
  for (const [name, f] of files) {
    for (const raw of f.calls()) {
      candidateCalls++;
      const site = resolveCall(raw, name, ctx);
      if (site) callSites.push(site);
    }
  }
  for (const t of trees) t.delete();
  callSites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  return {
    filesSeen: code.length,
    filesParsed: files.size,
    candidateCalls,
    callSites,
    parseErrors,
  };
}
