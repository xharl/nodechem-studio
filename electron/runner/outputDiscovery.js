import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_TAIL_BYTES = 8192;
const OUTPUT_NAME = /^[A-Za-z0-9._-]+\.(out|log)$/i;
const TERMINATION = /\b(?:Normal termination|Error termination)\b/i;

/**
 * Candidate output files for one job, in preference order.
 * Gaussian's console build writes `<input>.out`; G16W and some link setups
 * write `<input>.log`. Never assume only one of them exists.
 */
export function outputCandidates({ inputName, outputName } = {}) {
  const base = String(inputName || 'task').replace(/\.(gjf|com)$/i, '');
  const requested = String(outputName || `${base}.out`);
  const extension = path.extname(requested).toLowerCase();
  const alternate = extension === '.log' ? '.out' : extension === '.out' ? '.log' : '.out';
  const names = [
    requested,
    `${base}.out`,
    `${base}.log`,
    requested.replace(/\.(out|log)$/i, alternate),
  ];
  return [...new Set(names)].filter((name) => OUTPUT_NAME.test(name));
}

async function tailText(filePath, bytes = MAX_TAIL_BYTES) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Pick the file Gaussian actually wrote. A file that contains a termination
 * record wins over a newer partial file; otherwise the newest non-empty file
 * wins. Returns null when the process wrote nothing (stdout-only failure).
 */
export async function discoverOutput({ cwd, inputName, outputName, settleMs = 150 } = {}) {
  if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
  const found = [];
  for (const name of outputCandidates({ inputName, outputName })) {
    const file = path.join(cwd, name);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile() || stat.size === 0) continue;
    const terminated = TERMINATION.test(await tailText(file));
    found.push({ name, file, size: stat.size, mtimeMs: stat.mtimeMs, terminated });
  }
  if (found.length === 0) return null;
  found.sort((a, b) => (
    Number(b.terminated) - Number(a.terminated)
    || b.mtimeMs - a.mtimeMs
    || b.size - a.size
  ));
  return found[0];
}
