// Command line entry point: `drift scan`, plus the maintenance commands that refresh the
// published data (`drift track`, `drift sdk-maps`, `drift site`).

import { readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPECS, WINDOWS } from './providers.js';
import { scanRepository } from './scan/index.js';
import { match } from './match.js';
import { resolveDataDir } from './data.js';
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

/** @param {string[]} argv */
export async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || args.help || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === 'scan') {
    const dataDir = await resolveDataDir({ explicit: args.data });
    const repo = path.resolve(args._[1] ?? '.');
    const report = await scan(repo, { dataDir, windowDays: Number(args.window ?? 90), exclude: args.exclude });
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
    const failOn = args['fail-on'] ?? 'confirmed';
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
