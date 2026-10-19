// Path templates and operation keys.
// Spec paths name their parameters ({customer}); SDKs and call sites name them differently
// or not at all. Matching is therefore done on the path *shape*: literal segments must be
// equal and every parameter segment becomes "{}".

/** @param {string} path */
export function pathShape(path) {
  return path
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/\/+$/, '')
    .replace(/^(?!\/)/, '/');
}

/**
 * @param {string} method
 * @param {string} path
 */
export function opKey(method, path) {
  return `${method.toUpperCase()} ${pathShape(path)}`;
}

/** @param {string} path */
function segments(path) {
  return path.split('/').filter((s) => s.length > 0);
}

/**
 * Match a concrete or partially known request path against spec path templates.
 *
 * `path` segments that came from a runtime value are written as "{}" by the caller.
 * A template parameter accepts any segment; a literal template segment must match exactly.
 * Twilio-style templates such as "{Sid}.json" are matched on their literal suffix.
 * When several templates match, the one with the most literal-segment matches wins; a tie
 * between different templates is returned as ambiguous rather than guessed.
 *
 * @param {string} path
 * @param {string[]} templates
 * @returns {{template: string} | {ambiguous: string[]} | null}
 */
export function matchPath(path, templates) {
  const want = segments(path);
  /** @type {{template: string, score: number}[]} */
  const hits = [];
  for (const template of templates) {
    const have = segments(template);
    if (have.length !== want.length) continue;
    let score = 0;
    let ok = true;
    for (let i = 0; i < have.length; i++) {
      const t = have[i];
      const w = want[i];
      if (!t.includes('{')) {
        if (t !== w) { ok = false; break; }
        score++;
        continue;
      }
      // Template segment contains a parameter, possibly with a literal prefix/suffix.
      const m = /^([^{]*)\{[^}]*\}(.*)$/.exec(t);
      if (!m) { ok = false; break; }
      const [, prefix, suffix] = m;
      if (w === '{}') continue;
      if (w.startsWith('{}')) {
        if (!w.endsWith(suffix)) { ok = false; break; }
        continue;
      }
      if (!w.startsWith(prefix) || !w.endsWith(suffix) || w.length <= prefix.length + suffix.length) { ok = false; break; }
    }
    if (ok) hits.push({ template, score });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.score - a.score);
  const best = hits.filter((h) => h.score === hits[0].score);
  const shapes = new Set(best.map((h) => pathShape(h.template)));
  if (shapes.size > 1) return { ambiguous: best.map((h) => h.template) };
  return { template: best[0].template };
}
