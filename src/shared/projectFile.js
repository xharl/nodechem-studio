/**
 * Project document identity: the one place that knows what a NodeChem Studio
 * project file is called.
 *
 * The document is canonical JSON, but the container is `.ncs` — the extension
 * names the product, not the encoding. There is exactly one accepted
 * extension; this product has no released format to stay compatible with.
 *
 * Pure module: no DOM, no filesystem, no Electron.
 */

/** The only extension a project is written or opened with. */
export const PROJECT_EXTENSION = '.ncs';

/** Extension list for the native open/save dialogs (no leading dot). */
export const PROJECT_EXTENSIONS = Object.freeze(['ncs']);

/** MIME type registered with the OS via electron-builder fileAssociations. */
export const PROJECT_MIME = 'application/x-nodechem-studio-project';

const MAX_STEM = 60;

/** Strip a path down to its basename for extension checks. */
function baseName(value) {
  return String(value || '').split(/[\\/]/).pop();
}

/** True when the path ends in `.ncs` (case-insensitive). */
export function isProjectPath(filePath) {
  return /\.ncs$/i.test(baseName(filePath));
}

/**
 * Slug for a suggested filename: ASCII, lowercase, single dashes, bounded
 * length. A project called "Diels–Alder TS / run 2" becomes
 * "diels-alder-ts-run-2.ncs".
 */
export function projectStem(project) {
  const raw = String(project?.name || '').trim();
  const slug = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // Typographic dashes separate words; without this an en dash would be
    // deleted and "Diels–Alder" would collapse to "dielsalder".
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[^A-Za-z0-9._ -]+/g, '')
    .trim()
    .slice(0, MAX_STEM)
    .replace(/\s+/g, '-')
    .toLowerCase();
  return slug || 'untitled';
}

/** Suggested filename for the save dialog. */
export function projectFileName(project) {
  return `${projectStem(project)}${PROJECT_EXTENSION}`;
}

/**
 * Normalise a chosen save path to exactly one `.ncs`.
 *
 * Issue 315: the save dialog's filter and this helper each tried to own the
 * suffix, and the result was `foo.ncs.ncs` — a file that opens here but reads
 * as a different type to every other tool. A path that already ends in exactly
 * one suffix is returned byte-for-byte (the user's case included); a run of
 * suffixes collapses to one.
 */
export function withProjectExtension(filePath) {
  const value = String(filePath || '').trim();
  if (!value) return value;
  // Strip every trailing `.ncs` so a doubly-suffixed name cannot keep growing.
  const stem = value.replace(/(?:\.ncs)+$/i, '');
  if (!stem) return PROJECT_EXTENSION;
  const suffix = value.slice(stem.length);
  // Exactly one suffix already: leave it alone, case and all.
  if (suffix.length === PROJECT_EXTENSION.length) return value;
  return `${stem}${PROJECT_EXTENSION}`;
}

/**
 * How a save path should be treated.
 *   { kind: 'ok' }        — write as-is
 *   { kind: 'invalid', message } — refuse
 * An empty path means "ask the user", which is always acceptable.
 */
export function classifySavePath(filePath) {
  const value = String(filePath || '').trim();
  if (!value) return { kind: 'ok' };
  if (isProjectPath(value)) return { kind: 'ok' };
  return { kind: 'invalid', message: `A project file must end in ${PROJECT_EXTENSION}.` };
}
