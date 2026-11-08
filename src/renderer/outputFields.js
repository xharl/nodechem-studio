/**
 * Output-block field rules (RFC 0001).
 *
 * Pure: the inspector renders from these helpers and the schema enforces the
 * same rules on save. Keeping the default path, extension and validation here
 * means the UI cannot drift from the format it writes.
 */

export const OUTPUT_KIND_LABELS = Object.freeze({
  html: 'HTML report',
  csv: 'CSV table',
  json: 'JSON dataset',
  zip: 'ZIP bundle',
});

/** Mirrors `DEFAULT_OUTPUT_PATHS` in src/shared/projectSchema.js. */
export const DEFAULT_OUTPUT_PATHS = Object.freeze({
  html: 'reports/report.html',
  csv: 'reports/dataset.csv',
  json: 'reports/dataset.json',
  zip: 'project.zip',
});

/** Mirrors `OUTPUT_EXTENSIONS` in src/shared/projectSchema.js. */
export const OUTPUT_EXTENSIONS = Object.freeze({
  html: '.html',
  csv: '.csv',
  json: '.json',
  zip: '.zip',
});

const ARTIFACT_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export function isOutputKind(kind) {
  return Object.prototype.hasOwnProperty.call(DEFAULT_OUTPUT_PATHS, String(kind));
}

export function defaultOutputPath(kind) {
  return DEFAULT_OUTPUT_PATHS[isOutputKind(kind) ? kind : 'zip'];
}

/**
 * The same message the schema would report, or '' when the path is valid.
 * `path` is project-relative, has no traversal, and ends in the kind's ext.
 */
export function outputPathError(path, kind) {
  const value = String(path ?? '');
  const resolvedKind = isOutputKind(kind) ? kind : 'zip';
  if (!value.trim()) return 'Enter a path for the artifact.';
  if (value.length > 160) return 'Keep the path at 160 characters or fewer.';
  if (!ARTIFACT_PATH.test(value) || value.split('/').includes('..')) {
    return 'Use a relative path inside the output folder (letters, digits, dot, underscore, dash and "/"), without "..".';
  }
  if (!value.toLowerCase().endsWith(OUTPUT_EXTENSIONS[resolvedKind])) {
    return `A ${resolvedKind} output must end in ${OUTPUT_EXTENSIONS[resolvedKind]}.`;
  }
  return '';
}

/**
 * The effective output settings of a node. A v1 output block carries only
 * `bundle`, so it keeps meaning "the zip named by bundle" until edited.
 */
export function outputOf(node) {
  const raw = node && typeof node.output === 'object' && node.output ? node.output : {};
  const kind = isOutputKind(raw.kind) ? raw.kind : 'zip';
  const bundle = String(raw.bundle || 'project.zip');
  const path = String(raw.path || (kind === 'zip' ? bundle : DEFAULT_OUTPUT_PATHS[kind]));
  return {
    kind,
    path,
    include: raw.include === 'record' ? 'record' : 'records',
    bundle,
    manifest: raw.manifest !== false,
    notes: String(raw.notes || ''),
  };
}
