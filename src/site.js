// Builds the GitHub Pages site (_site/, deployed by the tracker workflow): a landing page with the live API drift index and
// an Atom feed of breaking spec changes. Everything shown is read from data/.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SPECS } from './providers.js';

const REPO_URL = 'https://github.com/mehdiabdu391-gif/driftguard';
const SITE_URL = 'https://mehdiabdu391-gif.github.io/driftguard/';

/** @param {string} s */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const BREAKING = new Set(['endpoint-removed', 'request-field-removed', 'request-field-required', 'request-enum-value-removed']);

/**
 * @param {string} dataDir
 */
async function loadFeed(dataDir) {
  /** @type {any[]} */
  const records = [];
  for (const spec of SPECS) {
    const dir = path.join(dataDir, 'changes', spec.id, 'commits');
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const rec = JSON.parse(await readFile(path.join(dir, n), 'utf8'));
      const changes = rec.changes.filter((/** @type {any} */ c) => c.verification.status !== 'refuted' && (BREAKING.has(c.kind) || c.kind === 'endpoint-deprecated' || c.kind === 'request-field-deprecated'));
      if (changes.length) records.push({ spec, rec, changes });
    }
  }
  records.sort((a, b) => Date.parse(b.rec.revision.date) - Date.parse(a.rec.revision.date));
  return records;
}

/**
 * @param {string} dataDir
 * @param {string} outDir
 */
export async function buildSite(dataDir, outDir) {
  const feed = await loadFeed(dataDir);
  /** @type {any[]} */
  const specs = [];
  for (const spec of SPECS) {
    try {
      const state = JSON.parse(await readFile(path.join(dataDir, 'specs', `${spec.id}.json`), 'utf8'));
      const w90 = JSON.parse(await readFile(path.join(dataDir, 'changes', spec.id, 'window-90d.json'), 'utf8'));
      const verified = w90.changes.filter((/** @type {any} */ c) => c.verification.status === 'verified' && BREAKING.has(c.kind)).length;
      const refuted = w90.changes.filter((/** @type {any} */ c) => c.verification.status === 'refuted').length;
      specs.push({ spec, state, verified, total: w90.changes.length, refuted });
    } catch {
      specs.push({ spec, state: null, verified: 0, total: 0, refuted: 0 });
    }
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'index.html'), page(specs, feed.slice(0, 30)));
  await writeFile(path.join(outDir, 'feed.xml'), atom(feed.slice(0, 100)));
  await writeFile(path.join(outDir, '.nojekyll'), '');
}

/**
 * @param {any[]} specs
 * @param {any[]} feed
 */
function page(specs, feed) {
  const rows = specs
    .map(
      (s) => `<tr><td>${esc(s.spec.name)}</td><td>${s.state ? `<a href="https://github.com/${esc(s.spec.repo)}/commit/${esc(s.state.head.sha)}"><code>${esc(s.state.head.sha.slice(0, 10))}</code></a> · ${esc(s.state.head.date.slice(0, 10))}` : 'not tracked yet'}</td><td>${s.verified}</td><td>${s.refuted}</td></tr>`,
    )
    .join('\n');
  const items = feed
    .map(({ spec, rec, changes }) => {
      const list = changes
        .slice(0, 8)
        .map((/** @type {any} */ c) => `<li><code>${esc(c.method)} ${esc(c.path)}</code> ${esc(c.text)} <span class="tag ${esc(c.verification.status)}">${esc(c.verification.status)}</span></li>`)
        .join('');
      const more = changes.length > 8 ? `<li>…and ${changes.length - 8} more</li>` : '';
      return `<article><h3>${esc(spec.name)} · ${esc(rec.revision.date.slice(0, 10))}</h3><p><a href="${esc(rec.compareUrl)}">${esc(rec.revision.message)}</a></p><ul>${list}${more}</ul></article>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DriftGuard — Dependabot for the APIs you call</title>
<meta name="description" content="Free GitHub Action that finds the exact lines in your code broken by upstream API changes from Stripe, OpenAI, GitHub and Twilio.">
<link rel="alternate" type="application/atom+xml" title="DriftGuard API change feed" href="feed.xml">
<style>
:root{--fg:#111;--muted:#555;--line:#e5e5e5;--accent:#0b5fff;--bg:#fff}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--muted:#aaa;--line:#2a2a2a;--accent:#6ea0ff;--bg:#0d0d0d}}
*{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:860px;margin:0 auto;padding:48px 20px}
h1{font-size:2.2rem;line-height:1.2;margin:0 0 12px}h2{margin-top:48px;font-size:1.3rem}h3{font-size:1rem;margin:0}
p.lead{font-size:1.15rem;color:var(--muted);margin:0 0 24px}
a{color:var(--accent)}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
pre{background:rgba(127,127,127,.1);padding:14px 16px;border-radius:8px;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:.95rem}td,th{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}
article{border-top:1px solid var(--line);padding:14px 0}article ul{margin:6px 0 0;padding-left:18px;font-size:.92rem}
.tag{font-size:.75rem;padding:1px 6px;border-radius:10px;border:1px solid var(--line)}.tag.verified{border-color:#c33;color:#c33}
.cta a{display:inline-block;margin-right:12px}
footer{color:var(--muted);font-size:.85rem;margin-top:48px}
</style>
</head>
<body>
<main>
<h1>Dependabot for the APIs you call</h1>
<p class="lead">DriftGuard watches the official OpenAPI specs of Stripe, OpenAI, GitHub and Twilio, and tells you which lines of <em>your</em> code a breaking change hits: file, line, the exact spec diff, and how sure it is.</p>
<p class="cta"><a href="${REPO_URL}">Source on GitHub</a><a href="feed.xml">Change feed (Atom)</a></p>

<h2>Add it to a repository</h2>
<pre>name: API drift
on:
  pull_request:
  schedule: [{ cron: '0 6 * * 1' }]
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: mehdiabdu391-gif/driftguard@stable</pre>
<p>Or run it locally: <code>npx github:mehdiabdu391-gif/driftguard scan .</code></p>

<h2>What “confirmed” means</h2>
<p>Every finding traces to a real spec diff (linked to the upstream commit and line) and a real call site. A finding is <strong>confirmed</strong> only when DriftGuard has re-checked the change against the spec documents and the call provably sends a removed field, omits a newly required one, sends a removed enum value, or calls a removed endpoint. Anything it cannot prove is labelled <em>possible</em> or <em>unresolved</em>. Only confirmed findings fail the check.</p>

<h2>Tracked specs</h2>
<table><thead><tr><th>Spec</th><th>Latest snapshot</th><th>Verified breaking changes (90 days)</th><th>Diff claims refuted</th></tr></thead>
<tbody>
${rows}
</tbody></table>
<p style="color:var(--muted);font-size:.9rem">“Refuted” counts structural-diff claims that the spec documents contradict (for example an enum moved under <code>anyOf</code>, reported as removed values). DriftGuard never reports those.</p>

<h2>Recent breaking and deprecating changes</h2>
${items || '<p>No breaking changes recorded yet.</p>'}

<footer>Open source under the Apache License 2.0 · © 2026 Mehdi Abdu Mohammed</footer>
</main>
</body>
</html>
`;
}

/** @param {any[]} feed */
function atom(feed) {
  const updated = feed[0]?.rec.revision.date ?? new Date(0).toISOString();
  const entries = feed
    .map(({ spec, rec, changes }) => {
      const body = changes.map((/** @type {any} */ c) => `${c.method} ${c.path}: ${c.text} [${c.verification.status}]`).join('\n');
      return `<entry>
<id>tag:driftguard,${esc(spec.id)}:${esc(rec.revision.sha)}</id>
<title>${esc(spec.name)}: ${changes.length} breaking or deprecating change${changes.length === 1 ? '' : 's'}</title>
<link href="${esc(rec.compareUrl)}"/>
<updated>${esc(rec.revision.date)}</updated>
<content type="text">${esc(`${rec.revision.message}\n\n${body}`)}</content>
</entry>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>DriftGuard: breaking API spec changes</title>
<id>${SITE_URL}</id>
<link href="${SITE_URL}feed.xml" rel="self"/>
<link href="${SITE_URL}"/>
<updated>${esc(updated)}</updated>
${entries}
</feed>
`;
}
