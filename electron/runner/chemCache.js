import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * ADR 0003 §2.4 — the run-local chemistry cache.
 *
 * It lives in the queue folder (`chem-cache.json`), so it dies with the run and
 * can be audited beside the records that used it. The fingerprint is computed
 * before a spawn, which is what lets a repeated 2D set avoid a second process;
 * the entry stores the program version and the descriptor-set id that produced
 * it, so a reader can always tell what answered. A run uses one interpreter and
 * one script (the queue options are frozen at start), so the version cannot
 * change under a live cache — the record still states it.
 */

export const CHEM_CACHE_FILE = 'chem-cache.json';
export const CHEM_CACHE_VERSION = 1;

/** Round coordinates so a re-read of the same geometry hits the same key. */
function stableAtoms(atoms) {
  return (Array.isArray(atoms) ? atoms : []).map((atom) => [
    String(atom.element || ''),
    Number(Number(atom.x).toFixed(4)),
    Number(Number(atom.y).toFixed(4)),
    Number(Number(atom.z).toFixed(4)),
  ]);
}

/**
 * The pre-spawn key: op, set id, charge, multiplicity, options and the geometry
 * (rounded). No version, because knowing it would require the spawn the cache
 * exists to avoid; the stored entry names the version it actually used.
 */
export function cacheFingerprint({
  op,
  descriptorSet = '',
  charge = 0,
  multiplicity = 1,
  options = null,
  atoms = [],
} = {}) {
  const payload = JSON.stringify({
    op: String(op || ''),
    descriptorSet: String(descriptorSet || ''),
    charge: Number(charge),
    multiplicity: Number(multiplicity),
    options: options && typeof options === 'object' ? options : {},
    atoms: stableAtoms(atoms),
  });
  return createHash('sha256').update(payload).digest('hex');
}

export async function readChemCache(queueDir) {
  try {
    const text = await fsp.readFile(path.join(queueDir, CHEM_CACHE_FILE), 'utf8');
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      return { version: CHEM_CACHE_VERSION, entries: parsed.entries };
    }
  } catch {
    // A missing or unreadable cache is an empty cache, never a failed task.
  }
  return { version: CHEM_CACHE_VERSION, entries: {} };
}

export async function writeChemCache(queueDir, cache) {
  const target = path.join(queueDir, CHEM_CACHE_FILE);
  const body = `${JSON.stringify({ version: CHEM_CACHE_VERSION, entries: cache?.entries || {} }, null, 2)}\n`;
  const temp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(temp, body, 'utf8');
  await fsp.rename(temp, target);
}

export function cacheGet(cache, fingerprint) {
  const entry = cache?.entries?.[fingerprint];
  return entry && typeof entry === 'object' ? entry : null;
}

export function cachePut(cache, fingerprint, entry) {
  if (!cache.entries || typeof cache.entries !== 'object') cache.entries = {};
  cache.entries[fingerprint] = { ...entry, at: new Date().toISOString() };
  return cache;
}
