// Report rendering: terminal text, Markdown (PR comments and job summaries), JSON, and
// GitHub workflow annotations.

import { specById } from './providers.js';

/**
 * @typedef {import('./match.js').Finding} Finding
 * @typedef {import('./scan/resolve.js').CallSite} CallSite
 *
 * @typedef {object} Report
 * @property {string} repo           scanned path
 * @property {number} windowDays
 * @property {Record<string, {base: any, revision: any, compareUrl: string}>} windows
 * @property {Finding[]} findings
 * @property {CallSite[]} callSites
 * @property {{specId: string, method: string, path: string, count: number, calls: number}[]} untracedResponse
 * @property {{filesSeen: number, filesParsed: number, parseErrors: {file: string, error: string}[]}} stats
 * @property {Record<string, {sdk: string, repo: string, sha: string}>} sdkMaps
 * @property {Record<string, string | null>} [specVersions]  spec id -> info.version of the latest snapshot
 */

/** @param {Report} r */
export function counts(r) {
  const c = { confirmed: 0, possible: 0, deprecated: 0, resolved: 0, unresolved: 0 };
  for (const f of r.findings) c[f.level]++;
  for (const s of r.callSites) c[s.status]++;
  return c;
}

/** @param {Finding} f */
function changeLink(f) {
  return f.change.sourceUrl ?? f.change.introducedIn?.compareUrl ?? f.change.compareUrl;
}

/** @param {Finding} f */
function opText(f) {
  return `${f.change.method} ${f.change.path}`;
}

/** @param {string} s */
function md(s) {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * Collapse identical (call site, change) duplicates that differ only in oasdiff wording
 * across media types, keeping the first.
 * @param {Finding[]} findings
 */
function unique(findings) {
  const seen = new Set();
  return findings.filter((f) => {
    const k = `${f.call.file}:${f.call.line}:${f.change.kind}:${f.change.target?.raw ?? ''}:${f.change.target?.value ?? ''}:${opText(f)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** @param {Report} r */
export function renderText(r) {
  const c = counts(r);
  const lines = [];
  lines.push(`DriftGuard scan of ${r.repo}`);
  lines.push(`Provider spec changes over the last ${r.windowDays} days, matched to ${c.resolved} resolved call sites (${c.unresolved} unresolved).`);
  lines.push('');
  const groups = /** @type {const} */ (['confirmed', 'possible', 'deprecated']);
  const findings = unique(r.findings);
  for (const level of groups) {
    const list = findings.filter((f) => f.level === level);
    if (!list.length) continue;
    lines.push(`${level.toUpperCase()} (${list.length})`);
    for (const f of list) {
      lines.push(`  ${f.call.file}:${f.call.line}  ${f.call.snippet}`);
      lines.push(f.related
        ? `    ${specById(f.change.specId).name}: ${opText(f)} — ${f.related.length} request changes`
        : `    ${specById(f.change.specId).name}: ${opText(f)} — ${f.change.text}`);
      lines.push(`    why: ${f.evidence}`);
      if (!f.related) lines.push(`    spec check: ${f.change.verification.status} (${f.change.verification.reason})`);
      const when = f.change.introducedIn ? `introduced ${f.change.introducedIn.date.slice(0, 10)} in ${f.change.introducedIn.sha.slice(0, 10)}` : `between ${r.windows[f.change.specId]?.base?.sha?.slice(0, 10)} and ${r.windows[f.change.specId]?.revision?.sha?.slice(0, 10)}`;
      lines.push(`    source: ${changeLink(f)} (${when})`);
      if (f.call.apiVersion) lines.push(`    pinned: this client pins API version ${f.call.apiVersion}; the change applies once that pin moves to the current spec version${r.specVersions?.[f.change.specId] ? ` (${r.specVersions[f.change.specId]})` : ''}`);
      const note = specById(f.change.specId).note;
      if (note && level === 'confirmed' && !f.call.apiVersion) lines.push(`    note: ${note}`);
    }
    lines.push('');
  }
  if (!findings.length) lines.push('No breaking or deprecated spec changes hit the resolved call sites.', '');
  const unresolved = r.callSites.filter((s) => s.status === 'unresolved');
  if (unresolved.length) {
    lines.push(`UNRESOLVED CALLS (${unresolved.length}) — detected provider calls DriftGuard could not pin to one operation, so they were not checked:`);
    for (const s of unresolved) lines.push(`  ${s.file}:${s.line}  ${s.client}${s.sdkMethod ? ` ${s.sdkMethod}` : ''} — ${s.reason}`);
    lines.push('');
  }
  if (r.untracedResponse.length) {
    const total = r.untracedResponse.reduce((n, u) => n + u.count, 0);
    lines.push(`Not checked: ${total} response-schema changes on ${r.untracedResponse.length} operations you call. DriftGuard does not yet trace which response fields your code reads.`);
    lines.push('');
  }
  lines.push(`Summary: ${c.confirmed} confirmed, ${c.possible} possible, ${c.deprecated} deprecated.`);
  return lines.join('\n');
}

/** @param {Report} r */
export function renderMarkdown(r) {
  const c = counts(r);
  const findings = unique(r.findings);
  const out = [];
  out.push('## DriftGuard: upstream API changes vs. your code');
  out.push('');
  out.push(`Spec changes from the last **${r.windowDays} days** matched against **${c.resolved}** resolved provider call sites (${c.unresolved} unresolved).`);
  out.push('');
  out.push(`**${c.confirmed} confirmed** · ${c.possible} possible · ${c.deprecated} deprecated`);
  out.push('');
  const titles = { confirmed: 'Confirmed breaks', possible: 'Possible breaks (not provable statically)', deprecated: 'Deprecated usage' };
  for (const level of /** @type {const} */ (['confirmed', 'possible', 'deprecated'])) {
    const list = findings.filter((f) => f.level === level);
    if (!list.length) continue;
    const open = level === 'confirmed' ? ' open' : '';
    out.push(`<details${open}><summary><strong>${titles[level]} (${list.length})</strong></summary>`);
    out.push('');
    out.push('| Location | Change | Why this call | Spec check | Source |');
    out.push('|---|---|---|---|---|');
    for (const f of list.slice(0, 200)) {
      const pin = f.call.apiVersion ? ` (client pins API version ${f.call.apiVersion})` : '';
      const what = (f.related ? `${f.related.length} request changes` : f.change.text) + pin;
      const check = f.related ? 'mixed' : f.change.verification.status;
      out.push(`| \`${md(f.call.file)}:${f.call.line}\` | ${md(specById(f.change.specId).name)}: \`${md(opText(f))}\` ${md(what)} | ${md(f.evidence)} | ${check} | [diff](${f.related ? f.change.compareUrl : changeLink(f)}) |`);
    }
    if (list.length > 200) out.push(`| … | ${list.length - 200} more in the JSON report | | | |`);
    out.push('');
    out.push('</details>');
    out.push('');
  }
  if (!findings.length) out.push('No breaking or deprecated spec changes hit the resolved call sites.', '');
  const unresolved = r.callSites.filter((s) => s.status === 'unresolved');
  if (unresolved.length) {
    out.push(`<details><summary>Unresolved calls (${unresolved.length}) — not checked</summary>`, '');
    for (const s of unresolved.slice(0, 100)) out.push(`- \`${md(s.file)}:${s.line}\` ${md(s.client)}${s.sdkMethod ? ` \`${md(s.sdkMethod)}\`` : ''}: ${md(s.reason ?? '')}`);
    out.push('', '</details>', '');
  }
  if (r.untracedResponse.length) {
    const total = r.untracedResponse.reduce((n, u) => n + u.count, 0);
    out.push(`_Not checked: ${total} response-schema changes on ${r.untracedResponse.length} operations you call (response field reads are not traced yet)._`, '');
  }
  const notes = new Set(findings.filter((f) => f.level === 'confirmed').map((f) => specById(f.change.specId).note).filter(Boolean));
  for (const n of notes) out.push(`> ${n}`, '');
  out.push('<sub>Confirmed means the spec change was verified against the spec documents and the call provably sends, omits or targets what changed. Only confirmed findings fail the check.</sub>');
  return out.join('\n');
}

/** @param {Report} r */
export function renderJson(r) {
  return JSON.stringify(
    {
      repo: r.repo,
      windowDays: r.windowDays,
      windows: r.windows,
      summary: counts(r),
      findings: unique(r.findings).map((f) => ({
        level: f.level,
        evidence: f.evidence,
        location: { file: f.call.file, line: f.call.line, column: f.call.column, snippet: f.call.snippet },
        pinnedApiVersion: f.call.apiVersion ?? null,
        call: { via: f.call.via, client: f.call.client, sdkMethod: f.call.sdkMethod, operation: f.call.operation, mapSource: f.call.mapSource },
        change: {
          specId: f.change.specId,
          kind: f.change.kind,
          rule: f.change.rule,
          text: f.change.text,
          method: f.change.method,
          path: f.change.path,
          target: f.change.target,
          verification: f.change.verification,
          sourceUrl: f.change.sourceUrl,
          compareUrl: f.change.compareUrl,
          introducedIn: f.change.introducedIn,
        },
        ...(f.related ? { relatedChanges: f.related.map((c) => ({ kind: c.kind, text: c.text, target: c.target, verification: c.verification.status, sourceUrl: c.sourceUrl })) } : {}),
      })),
      unresolved: r.callSites.filter((s) => s.status === 'unresolved').map((s) => ({ file: s.file, line: s.line, client: s.client, sdkMethod: s.sdkMethod, reason: s.reason })),
      callSites: r.callSites.map((s) => ({ file: s.file, line: s.line, status: s.status, via: s.via, client: s.client, sdkMethod: s.sdkMethod, operation: s.operation })),
      untracedResponseChanges: r.untracedResponse,
      stats: r.stats,
      sdkMaps: r.sdkMaps,
    },
    null,
    2,
  );
}

/**
 * GitHub workflow commands that annotate the lines in the PR diff view.
 * @param {Report} r
 */
export function renderAnnotations(r) {
  const esc = (/** @type {string} */ s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const escProp = (/** @type {string} */ s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  return unique(r.findings)
    .map((f) => {
      const cmd = f.level === 'confirmed' ? 'error' : f.level === 'possible' ? 'warning' : 'notice';
      const title = `DriftGuard ${f.level}: ${opText(f)}`;
      return `::${cmd} file=${escProp(f.call.file)},line=${f.call.line},title=${escProp(title)}::${esc(`${f.change.text}. ${f.evidence}. Source: ${changeLink(f)}`)}`;
    })
    .join('\n');
}
