// Runs the oasdiff CLI (https://github.com/oasdiff/oasdiff) and returns its JSON changelog.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export function oasdiffBinary() {
  return process.env.OASDIFF || 'oasdiff';
}

/**
 * Full changelog (breaking, warning and info entries) between two local spec files.
 * @param {string} basePath
 * @param {string} revisionPath
 * @returns {Promise<import('./classify.js').OasdiffEntry[]>}
 */
export async function changelog(basePath, revisionPath) {
  const { stdout } = await run(
    oasdiffBinary(),
    ['changelog', basePath, revisionPath, '--format', 'json', '--allow-external-refs=false'],
    { maxBuffer: 1024 * 1024 * 1024 },
  );
  const text = stdout.trim();
  if (text === '' || text === 'null') return [];
  return JSON.parse(text);
}

export async function oasdiffVersion() {
  const { stdout } = await run(oasdiffBinary(), ['--version']);
  return stdout.trim();
}
