/**
 * Imported results: a number another program computed, kept in a run record.
 *
 * A `run.json` says "NodeChem ran this". That claim is only useful if it can be
 * false in a way a reader can see, so a record that came from elsewhere is a
 * different *kind* of record, not a run with fields left blank:
 *
 *   { "schemaVersion": 2, "kind": "imported", "program": "Spartan '26", … }
 *
 * The contract is `schemas/run-record.v2.schema.json`, published beside the
 * untouched v1 file. This module is the one place that builds and checks such a
 * record, and the one place that knows how to label it. It is deliberately free
 * of `node:fs` and of the schema loader: the renderer imports it, and the
 * renderer cannot read a schema file.
 *
 * What the record claims: this number, at this level of theory, came from this
 * program at this version, and the source file hashed to this digest.
 * What it does not claim: that the calculation is correct, or that NodeChem ran
 * anything. The hash proves the file, not the calculation.
 */

/** The one kind value an imported record may carry. */
export const IMPORTED_RECORD_KIND = 'imported';

/** The contract an imported record declares. Runs keep declaring 1. */
export const IMPORTED_SCHEMA_VERSION = 2;

/** The sentence every surface prints. Never reword it in one place only. */
export const IMPORTED_BADGE_TEXT = 'imported, not run here';

/** The unit the `energy` field is in. There is no unit field to disagree with. */
export const IMPORTED_ENERGY_UNIT = 'Eh';

const ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REQUIRED_TEXT_FIELDS = ['id', 'program', 'version', 'method', 'basis'];

export class ImportedRecordError extends Error {
  constructor(message, { field = null } = {}) {
    super(message);
    this.name = 'ImportedRecordError';
    this.code = 'imported-invalid';
    this.field = field;
  }
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** True when a record (or anything shaped like one) declares the imported kind. */
export function isImportedRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && value.kind === IMPORTED_RECORD_KIND;
}

/**
 * Build one imported record. Every field is explicit: the caller has to say
 * which program, which version, which method and which file, so there is no
 * path here that quietly produces a record from a foreign log.
 *
 * Throws `ImportedRecordError` naming the field that is missing or wrong.
 */
export function buildImportedRecord({
  id,
  program,
  version,
  method,
  basis,
  energy,
  sourceSha256,
  sourceName = null,
  title = null,
  notes = null,
  importedAt = new Date().toISOString(),
} = {}) {
  for (const field of REQUIRED_TEXT_FIELDS) {
    const value = { id, program, version, method, basis }[field];
    if (text(value) === null) {
      throw new ImportedRecordError(`an imported record needs a non-empty "${field}".`, { field });
    }
  }
  if (typeof id !== 'string' || !ID_PATTERN.test(id) || id.length > 124) {
    throw new ImportedRecordError(
      `the imported record id ${JSON.stringify(id)} must match ${ID_PATTERN.source} and be at most 124 characters.`,
      { field: 'id' },
    );
  }
  if (typeof energy !== 'number' || !Number.isFinite(energy)) {
    throw new ImportedRecordError(
      'an imported record needs a finite "energy" in Hartree; nothing is defaulted and no unit is converted.',
      { field: 'energy' },
    );
  }
  if (typeof sourceSha256 !== 'string' || !SHA256_PATTERN.test(sourceSha256)) {
    throw new ImportedRecordError(
      'an imported record needs a lowercase hex SHA-256 "sourceSha256" of the file it came from.',
      { field: 'sourceSha256' },
    );
  }
  if (typeof importedAt !== 'string' || Number.isNaN(Date.parse(importedAt))) {
    throw new ImportedRecordError('"importedAt" must be a date-time string.', { field: 'importedAt' });
  }

  const record = {
    schemaVersion: IMPORTED_SCHEMA_VERSION,
    kind: IMPORTED_RECORD_KIND,
    id,
    program,
    version,
    method,
    basis,
    energy,
    sourceSha256,
    importedAt,
  };
  const name = text(sourceName);
  if (name !== null) record.sourceName = name;
  const label = text(title);
  if (label !== null) record.title = label;
  const note = text(notes);
  if (note !== null) record.notes = note;
  return record;
}

/**
 * Check an imported record against the fields the contract requires, without
 * reading the schema file. `validateRecord(record)` from
 * `schemas/record-schema.js` is the published check; this one exists so the
 * renderer and the report can refuse a half-built record without pulling
 * `node:fs` into the bundle. The two must agree — a test asserts it.
 */
export function validateImportedRecord(record) {
  const errors = [];
  const add = (field, message) => errors.push({ path: `/${field}`, message });
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, errors: [{ path: '/', message: 'must be an object' }] };
  }
  if (record.kind !== IMPORTED_RECORD_KIND) add('kind', `must be ${JSON.stringify(IMPORTED_RECORD_KIND)}`);
  for (const field of REQUIRED_TEXT_FIELDS) {
    if (text(record[field]) === null) add(field, 'must be a non-empty string');
  }
  if (typeof record.id === 'string' && (record.id.length > 124 || !ID_PATTERN.test(record.id))) {
    add('id', `must match ${ID_PATTERN.source}`);
  }
  if (typeof record.energy !== 'number' || !Number.isFinite(record.energy)) {
    add('energy', 'must be a finite number (Hartree)');
  }
  if (typeof record.sourceSha256 !== 'string' || !SHA256_PATTERN.test(record.sourceSha256)) {
    add('sourceSha256', 'must match ^[a-f0-9]{64}$');
  }
  if (typeof record.importedAt !== 'string' || Number.isNaN(Date.parse(record.importedAt))) {
    add('importedAt', 'must be a date-time string');
  }
  const allowed = new Set([
    'schemaVersion', 'kind', 'id', 'program', 'version', 'method', 'basis',
    'energy', 'sourceSha256', 'sourceName', 'title', 'notes', 'importedAt',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) add(key, 'is not part of an imported record');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * The label every surface prints: the sentence plus who computed the number.
 * A record that lost its version still names its program rather than claiming
 * an anonymous number.
 */
export function importedBadgeLabel(record) {
  const program = text(record?.program) || 'an unknown program';
  const version = text(record?.version);
  return `${IMPORTED_BADGE_TEXT} — ${program}${version ? ` ${version}` : ''}`;
}

/** The same label as renderer markup, so no caller invents its own wording. */
export function importedBadgeHtml(record) {
  const label = importedBadgeLabel(record);
  return `<span class="results-badge is-imported" data-role="imported-badge" title="This number was computed by another program, not by NodeChem Studio.">${escapeHtml(label)}</span>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

/**
 * The fields a consumer may use without touching the record again. Returns
 * `null` for a run record, so "is this imported" and "what does it say" are
 * one check rather than a shape test repeated in every consumer.
 */
export function importedSummary(record) {
  if (!isImportedRecord(record)) return null;
  return {
    id: text(record.id),
    program: text(record.program),
    version: text(record.version),
    method: text(record.method),
    basis: text(record.basis),
    energyHartree: Number.isFinite(record.energy) ? record.energy : null,
    sourceSha256: typeof record.sourceSha256 === 'string' ? record.sourceSha256 : null,
    sourceName: text(record.sourceName),
    title: text(record.title),
    importedAt: text(record.importedAt),
    badge: importedBadgeLabel(record),
  };
}
