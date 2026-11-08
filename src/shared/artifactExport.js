/**
 * Output-block artifacts (RFC 0001, phase 4).
 *
 * Pure module: it takes the block's declared output, the queue-shaped task
 * list and the run records the caller already read, and returns one file as
 * `{ path, bytes }`. It never touches the filesystem — the queue owns the
 * directory checks, the manifest and the SHA-256 — so the same function can be
 * unit-tested with plain objects and reused by a preview that writes nothing.
 *
 * Formats:
 *   csv  — `datasetCsv()` over one row per finished run (byte-identical to the
 *          app's "Export run dataset");
 *   json — `datasetJson()`, the same versioned envelope;
 *   html — the record-grouped workflow report;
 *   zip  — a store-only bundle of the files the caller passes in `files`.
 */

import { datasetCsv, datasetJson, runRows } from './datasetExport.js';
import { buildWorkflowReport, workflowReportHtml } from './workflowReport.js';
import { zipStore } from './zipStore.js';

export const ARTIFACT_KINDS = Object.freeze(['csv', 'json', 'html', 'zip']);

const DEFAULT_PATHS = Object.freeze({
  csv: 'reports/report.csv',
  json: 'reports/report.json',
  html: 'reports/report.html',
  zip: 'reports/project.zip',
});

/** A record id becomes a file-name segment; it uses the same grammar as task ids. */
const SAFE_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function normalizeOutput(output) {
  const raw = output && typeof output === 'object' ? output : {};
  const kind = ARTIFACT_KINDS.includes(raw.kind) ? raw.kind : 'zip';
  const requested = typeof raw.path === 'string' && raw.path.trim()
    ? raw.path.trim().replace(/\\/g, '/')
    : DEFAULT_PATHS[kind];
  const segments = requested.split('/');
  if (requested.startsWith('/') || /^[A-Za-z]:/.test(requested)
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Artifact path "${requested}" must be relative and stay inside the output root.`);
  }
  return {
    kind,
    path: requested,
    include: raw.include === 'record' ? 'record' : 'records',
  };
}

/** One run per finished task: keyed by run id, falling back to the node id. */
function runsFor(entries, records) {
  const seen = new Set();
  const runs = [];
  for (const entry of entries) {
    const record = (entry?.runId && records?.[entry.runId])
      || (entry?.nodeId && records?.[entry.nodeId])
      || null;
    if (!record || typeof record !== 'object') continue;
    const id = String(record.id || entry.runId || entry.nodeId || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    runs.push(record);
  }
  return runs;
}

/** The single record an `include: 'record'` artifact covers, if there is one. */
function recordIdOf(entries) {
  const ids = new Set();
  for (const entry of entries) {
    if (entry?.recordId) ids.add(String(entry.recordId));
  }
  if (ids.size === 0) return null;
  if (ids.size > 1) {
    throw new Error(`An output with include "record" got tasks from ${ids.size} records; pass one record at a time.`);
  }
  return [...ids][0];
}

/** `reports/barrier.html` + `m1` → `reports/barrier-m1.html`. */
function withRecordSuffix(artifactPath, recordId) {
  if (!SAFE_RECORD_ID.test(String(recordId))) {
    throw new Error(`Record id "${recordId}" cannot be used in an artifact name.`);
  }
  const slash = artifactPath.lastIndexOf('/');
  const dot = artifactPath.lastIndexOf('.');
  const end = dot > slash ? dot : artifactPath.length;
  return `${artifactPath.slice(0, end)}-${recordId}${artifactPath.slice(end)}`;
}

function htmlBytes(output, entries, context, flow) {
  const queue = {
    ...(context.queue && typeof context.queue === 'object' ? context.queue : {}),
    // A report built from one flow's tasks must not inherit another flow's
    // queue-level identity, and the section anchor needs the flow id.
    flowId: flow.id,
    flowTitle: flow.title,
    tasks: entries,
  };
  const model = buildWorkflowReport(queue, context.records || {}, {
    generatedAt: context.generatedAt ?? null,
    appVersion: context.appVersion ?? null,
    recordInfo: context.recordInfo ?? null,
  });
  return Buffer.from(workflowReportHtml(model), 'utf8');
}

/**
 * Build the bytes one output block writes.
 *
 * @param {{kind?: string, path?: string, include?: string}} output the block's
 *   normalized `output` object (`include: 'record'` writes one file per record)
 * @param {object} context
 * @param {object} [context.queue] the queue record, for report identity
 * @param {Object<string, object>} [context.records] run records keyed by run id
 * @param {Array<object>} [context.entries] the tasks this artifact covers;
 *   defaults to every task on `queue`
 * @param {string} [context.recordId] set by the caller when `entries` is empty
 * @param {Array<{name: string, bytes: Buffer|Uint8Array|string}>} [context.files]
 *   bundle contents for `kind: 'zip'`, already read by the caller
 * @param {string|null} [context.generatedAt]
 * @param {string|null} [context.appVersion]
 * @param {Array<object>|object|null} [context.recordInfo] dataset record
 *   metadata (`id`, `label`, `charge`, `multiplicity`) for the report
 * @returns {{path: string, bytes: Buffer}}
 */
export function artifactFor(output, context = {}) {
  const spec = normalizeOutput(output);
  const source = context && typeof context === 'object' ? context : {};
  const queue = source.queue && typeof source.queue === 'object' ? source.queue : {};
  const records = source.records && typeof source.records === 'object' ? source.records : {};
  const entries = Array.isArray(source.entries)
    ? source.entries
    : (Array.isArray(queue.tasks) ? queue.tasks : []);

  const flowId = String(source.flowId || entries.find((entry) => entry?.flowId)?.flowId
    || queue.flowId || 'main');
  const flowTitle = source.flowTitle || queue.flowTitle || null;
  const flow = { id: flowId, title: flowTitle };

  const recordId = spec.include === 'record'
    ? (source.recordId ? String(source.recordId) : recordIdOf(entries))
    : null;
  const artifactPath = recordId ? withRecordSuffix(spec.path, recordId) : spec.path;

  let bytes;
  if (spec.kind === 'csv') {
    bytes = Buffer.from(datasetCsv(runRows(runsFor(entries, records))), 'utf8');
  } else if (spec.kind === 'json') {
    bytes = Buffer.from(JSON.stringify(datasetJson(runRows(runsFor(entries, records)), {
      generatedAt: source.generatedAt ?? null,
      appVersion: source.appVersion ?? null,
    }), null, 2), 'utf8');
  } else if (spec.kind === 'html') {
    bytes = htmlBytes(spec, entries, source, flow);
  } else {
    const files = Array.isArray(source.files) ? source.files
      : Array.isArray(source.bundleFiles) ? source.bundleFiles : [];
    bytes = zipStore(files);
  }

  return { path: artifactPath, bytes };
}
