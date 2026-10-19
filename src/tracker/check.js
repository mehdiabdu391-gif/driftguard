// Sanity check for a tracker data directory, run before it is published.
//
// The data branch is replaced wholesale on every run, so a run that produced partial
// output (a provider fetch that returned nothing, a diff that failed silently) would
// overwrite good data. This refuses to let that through. It checks that every tracked
// spec has a parseable state file, a non-empty operation index and every change window
// with the expected shape, and that every mapped SDK has a method map. An empty
// `changes` list is valid (a quiet spec). So is a window the tracker recorded as `null`
// in the spec's state because no snapshot goes back that far; every other window must
// have its file, and at least one window must exist.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPECS, SDKS, WINDOWS } from '../providers.js';

/**
 * @param {string} file
 * @returns {Promise<any>}
 */
async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * @param {string} dataDir
 * @returns {Promise<string[]>} problems found; empty when the data is complete
 */
export async function checkData(dataDir) {
  /** @type {string[]} */
  const problems = [];
  /**
   * @param {string} rel
   * @param {(json: any) => string | null} validate  returns a problem description or null
   */
  const check = async (rel, validate) => {
    try {
      const msg = validate(await readJson(path.join(dataDir, rel)));
      if (msg) problems.push(`${rel}: ${msg}`);
    } catch (err) {
      problems.push(`${rel}: ${/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT' ? 'missing' : 'unreadable or invalid JSON'}`);
    }
  };

  for (const spec of SPECS) {
    /** @type {Record<string, unknown> | undefined} */
    let windows;
    await check(`specs/${spec.id}.json`, (j) => {
      windows = j?.windows;
      return j?.id === spec.id && j.head && windows && typeof windows === 'object' ? null : 'no snapshot state';
    });
    await check(`operations/${spec.id}.json`, (j) => (Array.isArray(j?.operations) && j.operations.length > 0 ? null : 'empty operation index'));
    if (!windows) continue; // already reported above
    const expected = WINDOWS.filter((days) => windows?.[`${days}d`] !== null);
    if (expected.length === 0) problems.push(`specs/${spec.id}.json: no change window was produced`);
    for (const days of expected) {
      await check(`changes/${spec.id}/window-${days}d.json`, (j) => (Array.isArray(j?.changes) && j.days === days ? null : 'malformed window'));
    }
  }
  for (const sdk of SDKS.filter((s) => s.mapped)) {
    await check(`sdk-maps/${sdk.id}.json`, (j) => (j && typeof j === 'object' && Object.keys(j).length > 0 ? null : 'empty SDK map'));
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write('usage: node src/tracker/check.js <data-dir>\n');
    process.exit(2);
  }
  const problems = await checkData(dir);
  if (problems.length) {
    for (const p of problems) process.stderr.write(`::error::${p}\n`);
    process.stderr.write(`Refusing to publish: ${problems.length} problem(s) in ${dir}.\n`);
    process.exit(1);
  }
  process.stdout.write(`Data in ${dir} is complete.\n`);
}
