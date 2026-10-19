// Command line entry point: `drift scan`, plus the maintenance commands that refresh the
// published data (`drift track`, `drift sdk-maps`, `drift site`).

import { readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPECS, WINDOWS } from './providers.js';
import { scanRepository } from './scan/index.js';
import { match } from './match.js';
import { resolveDataDir } from './data.js';
import { upgradeChanges, loadSnapshot } from './upgrade.js';
import { findVersion } from './tracker/versions.js';
import { homedir } from 'node:os';
import { renderText, renderMarkdown, renderJson, renderAnnotations, counts } from './report.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `drift — catch upstream API breaking changes in the code that calls them

Usage:
  drift scan [path]        Scan a repository (default: current directory)
    --window <days>        Spec-change window: ${WINDOWS.join(', ')} (default 90)
    --format <fmt>         text | markdown | json (default text)
    --output <file>        Write the report to a file instead of stdout
    --json-output <file>   Also write the JSON report to a file (one scan, two outputs)
    --fail-on <level>      confirmed | possible | never (default confirmed)
    --exclude <prefix>     Skip a repository path prefix (repeatable)
    --data <dir>           Data directory (default: the published data branch, cached)
    --annotations          Also print GitHub workflow annotations

  drift upgrade [path]     What breaks when your pinned Stripe API version moves forward
    --from <version>       Version to upgrade from (default: each client's literal pin)
    --to <version>         Version to upgrade to (default: the newest published)
    --format, --output, --json-output, --fail-on, --exclude, --data, --annotations as for scan

  drift track              Refresh spec snapshots and diffs into the data directory
    --spec <id>            Only this spec (repeatable)
  drift sdk-maps           Rebuild SDK method maps from the SDKs' source
  drift site               Build the GitHub Pages site and changelog feed
    --out <dir>            Output directory (default _site)
`;

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{_: string[], [k: string]: any}} */
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const boolean = ['annotations', 'help'].includes(key);
    const value = boolean ? true : argv[++i];
    if (value === undefined) throw new Error(`Missing value for --${key}`);
    if (key === 'exclude' || key === 'spec') (out[key] ??= []).push(value);
    else out[key] = value;
  }
  return out;
}

/** @param {string} dataDir */
export async function loadData(dataDir) {
  /** @type {Record<string, any>} */
  const sdkMaps = {};
  for (const f of await readdir(path.join(dataDir, 'sdk-maps'))) {
    if (f.endsWith('.json')) sdkMaps[f.slice(0, -5)] = JSON.parse(await readFile(path.join(dataDir, 'sdk-maps', f), 'utf8'));
  }
  /** @type {Record<string, any[]>} */
  const operations = {};
  for (const spec of SPECS) {
    try {
      operations[spec.id] = JSON.parse(await readFile(path.join(dataDir, 'operations', `${spec.id}.json`), 'utf8')).operations;
    } catch {
      operations[spec.id] = [];
    }
  }
  return { sdkMaps, operations };
}

/**
 * @param {string} dataDir
 * @param {number} days
 */
async function loadWindows(dataDir, days) {
  /** @type {Record<string, any>} */
  const windows = {};
  for (const spec of SPECS) {
    try {
      windows[spec.id] = JSON.parse(await readFile(path.join(dataDir, 'changes', spec.id, `window-${days}d.json`), 'utf8'));
    } catch {
      // No window data for this spec (not tracked yet, or the spec is younger than the window).
    }
  }
  return windows;
}

/**
 * Programmatic scan.
 * @param {string} repo
 * @param {{dataDir: string, windowDays?: number, exclude?: string[]}} opts
 * @returns {Promise<import('./report.js').Report>}
 */
export async function scan(repo, opts) {
  const dataDir = opts.dataDir;
  const windowDays = opts.windowDays ?? 90;
  if (!WINDOWS.includes(windowDays)) throw new Error(`--window must be one of ${WINDOWS.join(', ')}`);
  const { sdkMaps, operations } = await loadData(dataDir);
  const windows = await loadWindows(dataDir, windowDays);
  const result = await scanRepository(repo, { sdkMaps, operations, exclude: opts.exclude });
  const { findings, untracedResponse } = match(result.callSites, windows);
  /** @type {Record<string, string | null>} */
  const specVersions = {};
  for (const spec of SPECS) {
    try {
      specVersions[spec.id] = JSON.parse(await readFile(path.join(dataDir, 'specs', `${spec.id}.json`), 'utf8')).head?.specVersion ?? null;
    } catch {
      specVersions[spec.id] = null;
    }
  }
  return {
    repo,
    windowDays,
    windows: Object.fromEntries(Object.entries(windows).map(([id, w]) => [id, { base: w.base, revision: w.revision, compareUrl: w.compareUrl }])),
    findings,
    callSites: result.callSites,
    untracedResponse,
    stats: { filesSeen: result.filesSeen, filesParsed: result.filesParsed, parseErrors: result.parseErrors },
    sdkMaps: Object.fromEntries(Object.entries(sdkMaps).map(([id, m]) => [id, { sdk: id, repo: m.repo, sha: m.sha }])),
    specVersions,
  };
}

/**
 * Upgrade check for Stripe: for every Stripe call site, compare the operation it calls in
 * the snapshot of the version it pins (or --from) with the snapshot of the target version.
 * @param {string} repo
 * @param {{dataDir: string, from?: string, to?: string, exclude?: string[], cacheDir?: string, fetch?: typeof fetch}} opts
 * @returns {Promise<import('./report.js').Report>}
 */
export async function upgrade(repo, opts) {
  const specId = 'stripe';
  const index = JSON.parse(await readFile(path.join(opts.dataDir, 'versions', `${specId}.json`), 'utf8').catch(() => {
    throw new Error(`No Stripe version index in ${opts.dataDir} (versions/${specId}.json).`);
  }));
  const cacheDir = opts.cacheDir ?? path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'driftguard', 'specs');
  const latest = index.versions[index.versions.length - 1];
  const to = opts.to ? findVersion(index, opts.to) : latest;
  if (!to) throw new Error(`--to ${opts.to} is not an API version in Stripe's published spec history.`);
  if (opts.from && !findVersion(index, opts.from)) throw new Error(`--from ${opts.from} is not an API version in Stripe's published spec history.`);

  const { sdkMaps, operations } = await loadData(opts.dataDir);
  const result = await scanRepository(repo, { sdkMaps, operations, exclude: opts.exclude });
  const stripeCalls = result.callSites.filter((s) => s.provider === specId || s.specId === specId);

  /** @type {Map<string, typeof stripeCalls>} */
  const groups = new Map();
  /** @type {{file: string, line: number, reason: string}[]} */
  const skipped = [];
  for (const call of stripeCalls) {
    if (call.status !== 'resolved') continue;
    const label = opts.from ?? call.apiVersion;
    if (!label) {
      skipped.push({ file: call.file, line: call.line, reason: 'no API version pinned in code; it uses the account default. Pass --from <version> to check it.' });
      continue;
    }
    const run = findVersion(index, label);
    if (!run) {
      skipped.push({ file: call.file, line: call.line, reason: `pins ${label}, which is not an API version in Stripe's published spec history` });
      continue;
    }
    const key = run.version;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(call);
  }

  const targetDoc = groups.size ? await loadSnapshot(index.repo, index.file, to.last.sha, cacheDir, opts.fetch) : null;
  /** @type {import('./match.js').Finding[]} */
  const findings = [];
  /** @type {{from: string, fromSha: string, calls: number, changes: number}[]} */
  const compared = [];
  for (const [version, calls] of groups) {
    const from = /** @type {NonNullable<ReturnType<typeof findVersion>>} */ (findVersion(index, version));
    if (from.last.sha === to.last.sha) {
      compared.push({ from: version, fromSha: from.last.sha, calls: calls.length, changes: 0 });
      continue;
    }
    const baseDoc = await loadSnapshot(index.repo, index.file, from.last.sha, cacheDir, opts.fetch);
    const ops = calls.flatMap((c) => (c.operation ? [c.operation] : []));
    const changes = upgradeChanges(baseDoc, targetDoc, ops, { specId, repo: index.repo, file: index.file, from: { version, sha: from.last.sha }, to: { version: to.version, sha: to.last.sha } });
    compared.push({ from: version, fromSha: from.last.sha, calls: calls.length, changes: changes.length });
    findings.push(...match(calls, { [specId]: { changes, responseSummary: {} } }).findings);
  }
  const order = { confirmed: 0, possible: 1, deprecated: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level] || a.call.file.localeCompare(b.call.file) || a.call.line - b.call.line);
  return {
    repo,
    windowDays: 0,
    windows: {},
    findings,
    callSites: stripeCalls,
    untracedResponse: [],
    stats: { filesSeen: result.filesSeen, filesParsed: result.filesParsed, parseErrors: result.parseErrors },
    sdkMaps: Object.fromEntries(Object.entries(sdkMaps).map(([id, m]) => [id, { sdk: id, repo: m.repo, sha: m.sha }])),
    upgrade: { specId, to: { version: to.version, sha: to.last.sha }, compared, skipped },
  };
}

/** @param {string[]} argv */
export async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || args.help || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === 'scan' || cmd === 'upgrade') {
    const failOn = args['fail-on'] ?? 'confirmed';
    if (!['confirmed', 'possible', 'never'].includes(failOn)) throw new Error(`--fail-on must be confirmed, possible or never (got "${failOn}").`);
    const dataDir = await resolveDataDir({ explicit: args.data });
    const repo = path.resolve(args._[1] ?? '.');
    const report = cmd === 'upgrade'
      ? await upgrade(repo, { dataDir, from: args.from, to: args.to, exclude: args.exclude })
      : await scan(repo, { dataDir, windowDays: Number(args.window ?? 90), exclude: args.exclude });
    report.repo = args._[1] ?? '.';
    const format = args.format ?? 'text';
    const body = format === 'json' ? renderJson(report) : format === 'markdown' ? renderMarkdown(report) : renderText(report);
    if (args.output) await writeFile(args.output, `${body}\n`);
    if (args['json-output']) await writeFile(args['json-output'], `${format === 'json' ? body : renderJson(report)}\n`);
    else process.stdout.write(`${body}\n`);
    if (args.annotations) {
      const ann = renderAnnotations(report);
      if (ann) process.stdout.write(`${ann}\n`);
    }
    if (process.env.GITHUB_STEP_SUMMARY && format !== 'markdown') {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `${renderMarkdown(report)}\n`);
    }
    const c = counts(report);
    if (failOn === 'never') return 0;
    if (failOn === 'possible') return c.confirmed + c.possible > 0 ? 1 : 0;
    return c.confirmed > 0 ? 1 : 0;
  }
  const dataDir = path.resolve(args.data ?? path.join(PACKAGE_ROOT, 'data'));
  if (cmd === 'track') {
    const { track } = await import('./tracker/track.js');
    const summary = await track(dataDir, { specIds: args.spec });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }
  if (cmd === 'sdk-maps') {
    const { buildSdkMaps } = await import('./sdkmaps/build.js');
    const summary = await buildSdkMaps(dataDir);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }
  if (cmd === 'site') {
    const { buildSite } = await import('./site.js');
    await buildSite(dataDir, path.resolve(args.out ?? '_site'));
    return 0;
  }
  process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
  return 2;
}
