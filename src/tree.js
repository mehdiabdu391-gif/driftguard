// Shared tree-sitter setup. Grammars are the WebAssembly builds shipped by the official
// grammar packages, so no native compilation is needed on CI runners.

import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';

const require = createRequire(import.meta.url);

const GRAMMARS = {
  javascript: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-typescript/tree-sitter-tsx.wasm',
  python: 'tree-sitter-python/tree-sitter-python.wasm',
};

/** @type {Promise<void> | null} */
let initPromise = null;
/** @type {Map<string, Promise<Language>>} */
const languages = new Map();

/** @param {keyof typeof GRAMMARS} name */
async function loadLanguage(name) {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
  let lang = languages.get(name);
  if (!lang) {
    lang = Language.load(require.resolve(GRAMMARS[name]));
    languages.set(name, lang);
  }
  return lang;
}

/**
 * Parse source text with the named grammar.
 * @param {keyof typeof GRAMMARS} grammar
 * @param {string} source
 */
export async function parse(grammar, source) {
  const language = await loadLanguage(grammar);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  parser.delete();
  if (!tree) throw new Error(`tree-sitter returned no tree for ${grammar} source`);
  return tree;
}

/** @param {string} file */
export function grammarFor(file) {
  if (/\.(mjs|cjs|js|jsx)$/.test(file)) return 'javascript';
  if (/\.(mts|cts|ts)$/.test(file) && !file.endsWith('.d.ts')) return 'typescript';
  if (file.endsWith('.tsx')) return 'tsx';
  if (file.endsWith('.py')) return 'python';
  return null;
}

/**
 * Depth-first walk over named descendants.
 * @param {import('web-tree-sitter').Node} node
 * @param {(n: import('web-tree-sitter').Node) => void | boolean} visit  return false to skip children
 */
export function walk(node, visit) {
  const stack = [node];
  while (stack.length) {
    const n = /** @type {import('web-tree-sitter').Node} */ (stack.pop());
    if (visit(n) === false) continue;
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
}

/**
 * Value of a plain string literal node, or null if the node is not a static string.
 * Handles JS/TS `string`, template strings without substitutions, and Python strings
 * without interpolation or implicit concatenation.
 * @param {import('web-tree-sitter').Node | null} node
 */
export function stringValue(node) {
  if (!node) return null;
  if (node.type === 'string') {
    const parts = node.namedChildren.filter((c) => c && c.type !== 'string_start' && c.type !== 'string_end');
    if (parts.some((p) => p && p.type === 'interpolation')) return null;
    if (parts.length === 0) return '';
    if (parts.every((p) => p && (p.type === 'string_fragment' || p.type === 'string_content' || p.type === 'escape_sequence'))) {
      return parts.map((p) => unescape(p ? p.text : '')).join('');
    }
    return null;
  }
  if (node.type === 'template_string') {
    if (node.namedChildren.some((c) => c && c.type === 'template_substitution')) return null;
    return node.text.slice(1, -1);
  }
  return null;
}

/** @param {string} s */
function unescape(s) {
  return s.replace(/\\(["'\\/])/g, '$1');
}
