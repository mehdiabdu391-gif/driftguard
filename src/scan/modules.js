// Resolving import specifiers to files inside the scanned repository.

import path from 'node:path';

const JS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Strip comments and trailing commas from tsconfig-style JSON.
 * @param {string} text
 */
export function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') { out += text[++i] ?? ''; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export class ModuleResolver {
  /**
   * @param {Set<string>} files       repository-relative POSIX paths
   * @param {Map<string, string>} sources  path -> text (used to read tsconfig/jsconfig)
   */
  constructor(files, sources) {
    this.files = files;
    /** @type {{dir: string, baseUrl: string, paths: Record<string, string[]>}[]} */
    this.configs = [];
    for (const f of files) {
      const base = path.posix.basename(f);
      if (base !== 'tsconfig.json' && base !== 'jsconfig.json') continue;
      try {
        const cfg = parseJsonc(sources.get(f) ?? '{}');
        const opts = cfg.compilerOptions ?? {};
        const dir = path.posix.dirname(f);
        this.configs.push({
          dir: dir === '.' ? '' : dir,
          baseUrl: path.posix.join(dir, opts.baseUrl ?? '.'),
          paths: opts.paths ?? {},
        });
      } catch {
        // An unparseable tsconfig only means aliases from it are not resolved.
      }
    }
    // Nearest config first.
    this.configs.sort((a, b) => b.dir.length - a.dir.length);
  }

  /**
   * @param {string} from  importing file
   * @param {string} spec
   * @returns {string | null}
   */
  resolveJs(from, spec) {
    if (spec.startsWith('.')) return this.tryJs(path.posix.join(path.posix.dirname(from), spec));
    for (const cfg of this.configs) {
      if (cfg.dir && !from.startsWith(`${cfg.dir}/`)) continue;
      for (const [pattern, targets] of Object.entries(cfg.paths)) {
        const star = pattern.indexOf('*');
        const prefix = star >= 0 ? pattern.slice(0, star) : pattern;
        const suffix = star >= 0 ? pattern.slice(star + 1) : '';
        if (star < 0 ? spec !== pattern : !(spec.startsWith(prefix) && spec.endsWith(suffix))) continue;
        const middle = star >= 0 ? spec.slice(prefix.length, spec.length - suffix.length) : '';
        for (const t of targets) {
          const hit = this.tryJs(path.posix.join(cfg.baseUrl, t.replace('*', middle)));
          if (hit) return hit;
        }
      }
    }
    return null;
  }

  /** @param {string} p */
  tryJs(p) {
    const clean = path.posix.normalize(p).replace(/^\.\//, '');
    if (this.files.has(clean) && JS_EXTS.some((e) => clean.endsWith(e))) return clean;
    const noExt = clean.replace(/\.(js|jsx|mjs|cjs)$/, '');
    for (const e of JS_EXTS) if (this.files.has(noExt + e)) return noExt + e;
    for (const e of JS_EXTS) if (this.files.has(`${clean}/index${e}`)) return `${clean}/index${e}`;
    return null;
  }

  /**
   * @param {string} from
   * @param {string} module  dotted module path without leading dots
   * @param {number} level   number of leading dots (0 for absolute)
   * @returns {string | null}
   */
  resolvePy(from, module, level) {
    const rel = module ? module.split('.').join('/') : '';
    /** @type {string[]} */
    const bases = [];
    if (level > 0) {
      let dir = path.posix.dirname(from);
      for (let i = 1; i < level; i++) dir = path.posix.dirname(dir);
      bases.push(dir === '.' ? '' : dir);
    } else {
      bases.push('', 'src');
      // Also resolve relative to each ancestor directory, for repos whose Python root is a subfolder.
      let dir = path.posix.dirname(from);
      while (dir && dir !== '.') { bases.push(dir); dir = path.posix.dirname(dir); }
    }
    for (const b of bases) {
      const p = path.posix.join(b, rel);
      if (rel && this.files.has(`${p}.py`)) return `${p}.py`;
      if (this.files.has(path.posix.join(p, '__init__.py'))) return path.posix.join(p, '__init__.py');
    }
    return null;
  }
}
