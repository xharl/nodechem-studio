/**
 * Workflow report: one self-contained document per finished queue.
 *
 * The question the report answers is the one a reader who never saw the app
 * asks: **what ran, what came out, and does it hold?** It is built only from
 * the queue record and the per-task `run.json` files, never from live state, so
 * a report can be regenerated later and will say the same thing.
 *
 * Rules:
 *   - a value no run reported is printed as `not reported`, never as zero;
 *   - a fixture (dry-run) task keeps a FIXTURE label wherever its numbers appear;
 *   - the HTML is self-contained: no scripts, no external CSS, no network.
 */

export const WORKFLOW_REPORT_SCHEMA_VERSION = 1;

const MISSING = 'not reported';

function text(value) {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `1234567ab…` — a hash is verified in full elsewhere; the report shows a prefix. */
function shortHash(value) {
  const raw = text(value);
  return raw === null ? null : raw.slice(0, 16) + (raw.length > 16 ? '…' : '');
}

function taskRow(task, record) {
  const parsed = record?.parsed && typeof record.parsed === 'object' ? record.parsed : {};
  const method = record?.provenance?.method && typeof record.provenance.method === 'object'
    ? record.provenance.method : {};
  return {
    nodeId: text(task.nodeId),
    title: text(task.title) || text(task.nodeId) || 'Untitled block',
    type: text(task.type),
    kind: text(task.kind),
    status: text(task.status) || 'unknown',
    attempts: Number.isInteger(task.attempts) ? task.attempts : null,
    gates: text(task.gateVerdict ?? record?.gates?.overall),
    validity: text(record?.gates?.validity?.overall ?? record?.validity?.overall),
    runId: text(task.runId),
    runDir: text(task.runDir),
    startedAt: text(task.startedAt),
    finishedAt: text(task.finishedAt),
    error: text(task.error),
    dryRun: record?.dryRun === true,
    engine: text(record?.engine || parsed.engine),
    jobType: text(record?.provenance?.jobType || method.jobType),
    method: text(method.functional || method.hamiltonian),
    basis: text(method.basis),
    finalEnergyHartree: num(parsed.finalEnergy?.hartree),
    gibbsHartree: num(parsed.thermochemistry?.freeEnergyHartree),
    imaginaryCount: Number.isInteger(parsed.frequencies?.imaginaryCount)
      ? parsed.frequencies.imaginaryCount : null,
    elapsedSeconds: num(record?.elapsedSeconds ?? parsed.resources?.elapsedSeconds),
    inputSha256: text(record?.inputSha256),
    outputSha256: text(record?.outputSha256),
  };
}

/**
 * @param {object} queue the queue record written by the queue manager
 * @param {Object<string, object>} records run records keyed by run id (or by node id)
 * @returns {object} a serialisable report model
 */
export function buildWorkflowReport(queue, records = {}, { generatedAt = null, appVersion = null } = {}) {
  const source = queue && typeof queue === 'object' ? queue : {};
  const tasks = Array.isArray(source.tasks) ? source.tasks : [];
  const recordMap = records && typeof records === 'object' ? records : {};
  const rows = tasks.slice(0, 500).map((task) => {
    const byRun = task?.runId ? recordMap[task.runId] : null;
    const byNode = task?.nodeId ? recordMap[task.nodeId] : null;
    return taskRow(task || {}, byRun || byNode || null);
  });

  const counts = {
    total: rows.length,
    passed: rows.filter((row) => row.status === 'passed').length,
    failed: rows.filter((row) => row.status === 'failed').length,
    skipped: rows.filter((row) => row.status === 'skipped').length,
    cancelled: rows.filter((row) => row.status === 'cancelled').length,
    notRun: rows.filter((row) => row.status === 'pending' || row.status === 'queued').length,
  };
  const gated = rows.filter((row) => row.gates === 'pass' || row.gates === 'fail');
  const verdict = gated.length === 0
    ? 'unknown'
    : gated.some((row) => row.gates === 'fail') ? 'fail'
      : gated.length < rows.length ? 'partial' : 'pass';

  return {
    schemaVersion: WORKFLOW_REPORT_SCHEMA_VERSION,
    kind: 'nodechem-studio.workflow-report',
    generatedAt: text(generatedAt),
    appVersion: text(appVersion),
    queue: {
      id: text(source.id),
      projectName: text(source.projectName),
      status: text(source.status),
      createdAt: text(source.createdAt),
      finishedAt: text(source.finishedAt),
      reason: text(source.reason),
    },
    counts,
    verdict,
    tasks: rows,
    fixtures: rows.filter((row) => row.dryRun).length,
  };
}

function value(value, digits = null, unit = '') {
  if (value === null || value === undefined) return MISSING;
  if (typeof value === 'number' && digits !== null) return value.toFixed(digits) + unit;
  return String(value);
}

/**
 * Render the report as a self-contained HTML document.
 *
 * `methodsFor(task)` is optional: when supplied it returns the methods
 * paragraph for that task's run record, which is embedded in a collapsed
 * block. Passing nothing simply omits those blocks.
 */
export function workflowReportHtml(model, { methodsFor = null } = {}) {
  if (!model || typeof model !== 'object') return '';
  const q = model.queue || {};
  const counts = model.counts || {};
  const rows = Array.isArray(model.tasks) ? model.tasks : [];

  const tableRows = rows.map((row) => {
    const fixture = row.dryRun ? ' <span class="fixture">FIXTURE</span>' : '';
    const gates = row.gates === null ? MISSING : row.gates;
    const gateClass = gates === 'pass' || gates === 'fail' ? gates : 'unknown';
    const level = row.jobType || row.type || '';
    const kindSuffix = row.kind && row.kind !== level ? ` · ${row.kind}` : '';
    return '<tr data-node="' + escapeHtml(row.nodeId || '') + '" data-status="' + escapeHtml(row.status) + '">'
      + `<td><strong>${escapeHtml(row.title)}</strong>${fixture}<div class="sub">`
      + `${escapeHtml(level)}${escapeHtml(kindSuffix)}</div></td>`
      + `<td>${escapeHtml(row.status)}</td>`
      + `<td class="gates-${gateClass}">${escapeHtml(gates)}</td>`
      + `<td>${escapeHtml(row.validity === null ? MISSING : row.validity)}</td>`
      + `<td>${escapeHtml(row.engine === null ? MISSING : row.engine)}</td>`
      + `<td>${escapeHtml(row.method === null ? MISSING : row.method)} / ${escapeHtml(row.basis === null ? MISSING : row.basis)}</td>`
      + `<td class="num">${escapeHtml(value(row.finalEnergyHartree, 8))}</td>`
      + `<td class="num">${escapeHtml(value(row.gibbsHartree, 8))}</td>`
      + `<td class="num">${escapeHtml(value(row.imaginaryCount))}</td>`
      + `<td class="num">${escapeHtml(value(row.elapsedSeconds, 1, ' s'))}</td>`
      + '</tr>';
  }).join('');

  const failures = rows.filter((row) => row.status === 'failed' || row.gates === 'fail');
  const failureList = failures.length === 0
    ? '<p class="ok">No task failed and no executed task failed its gates.</p>'
    : '<ul class="failures">' + failures.map((row) => (
      `<li><strong>${escapeHtml(row.title)}</strong> — status ${escapeHtml(row.status)}, gates `
      + `${escapeHtml(row.gates === null ? MISSING : row.gates)}`
      + (row.error ? `; ${escapeHtml(row.error)}` : '') + '</li>'
    )).join('') + '</ul>';

  const methodsBlocks = typeof methodsFor === 'function'
    ? rows.map((row) => {
      let paragraph = null;
      try {
        paragraph = methodsFor(row);
      } catch {
        paragraph = null;
      }
      if (!paragraph) return '';
      return `<details><summary>${escapeHtml(row.title)} — methods</summary>`
        + `<pre>${escapeHtml(paragraph)}</pre></details>`;
    }).join('')
    : '';

  const provenanceRows = rows.map((row) => (
    '<tr>'
    + `<td>${escapeHtml(row.title)}</td>`
    + `<td class="mono">${escapeHtml(row.runId === null ? MISSING : row.runId)}</td>`
    + `<td class="mono">${escapeHtml(shortHash(row.inputSha256) ?? MISSING)}</td>`
    + `<td class="mono">${escapeHtml(shortHash(row.outputSha256) ?? MISSING)}</td>`
    + '</tr>'
  )).join('');

  const fixtureNote = model.fixtures > 0
    ? `<p class="warn">${model.fixtures} task${model.fixtures === 1 ? '' : 's'} ran as a labelled fixture (dry run). Fixture numbers are test data, not calculations.</p>`
    : '';

  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
    + `<title>Workflow report — ${escapeHtml(q.projectName || q.id || 'queue')}</title>`
    + '<style>'
    + 'body{font:13px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:32px auto;max-width:1100px;padding:0 20px;color:#16181d;background:#fff}'
    + 'h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px;border-bottom:1px solid #e3e6eb;padding-bottom:4px}'
    + '.meta{color:#5b6472;font-size:12px}.sub{color:#6b7480;font-size:11px;font-weight:400}'
    + 'table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:6px 8px;border-bottom:1px solid #eceef2;text-align:left;vertical-align:top}'
    + 'th{background:#f7f8fa;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#5b6472}'
    + '.num{text-align:right;font-variant-numeric:tabular-nums}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}'
    + '.gates-pass{color:#137a3a;font-weight:600}.gates-fail{color:#b42318;font-weight:600}'
    + '.fixture{background:#fff3cd;color:#7a5b00;border-radius:3px;padding:0 4px;font-size:10px;font-weight:600}'
    + '.warn{background:#fff8e6;border-left:3px solid #e0a800;padding:8px 10px}'
    + '.ok{color:#137a3a}.failures{color:#b42318}'
    + 'pre{white-space:pre-wrap;font-size:11px;background:#f7f8fa;padding:10px;border-radius:4px}'
    + 'details{margin:6px 0}summary{cursor:pointer;font-size:12px}'
    + 'footer{margin-top:32px;color:#6b7480;font-size:11px;border-top:1px solid #e3e6eb;padding-top:8px}'
    + '</style></head><body>'
    + `<h1>Workflow report — ${escapeHtml(q.projectName || q.id || 'queue')}</h1>`
    + `<p class="meta">Queue ${escapeHtml(q.id || MISSING)} · status ${escapeHtml(q.status || MISSING)}`
    + ` · created ${escapeHtml(q.createdAt || MISSING)} · finished ${escapeHtml(q.finishedAt || MISSING)}`
    + ` · generated ${escapeHtml(model.generatedAt || MISSING)}`
    + ` · NodeChem Studio ${escapeHtml(model.appVersion || MISSING)}</p>`
    + fixtureNote
    + '<h2>Outcome</h2>'
    + `<p>${counts.total || 0} task(s): ${counts.passed || 0} passed, ${counts.failed || 0} failed, `
    + `${counts.skipped || 0} skipped, ${counts.cancelled || 0} cancelled, ${counts.notRun || 0} not run. `
    + `Gate verdict: <strong>${escapeHtml(model.verdict || 'unknown')}</strong>.</p>`
    + failureList
    + '<h2>What ran</h2>'
    + '<table><thead><tr><th>Block</th><th>Status</th><th>Gates</th><th>Validity</th><th>Engine</th>'
    + '<th>Level</th><th class="num">E / Eh</th><th class="num">G / Eh</th><th class="num">Imag.</th>'
    + '<th class="num">Elapsed</th></tr></thead><tbody>' + tableRows + '</tbody></table>'
    + (methodsBlocks ? '<h2>Methods</h2>' + methodsBlocks : '')
    + '<h2>Provenance</h2>'
    + '<table><thead><tr><th>Block</th><th>Run</th><th>Input SHA-256</th><th>Output SHA-256</th></tr></thead>'
    + '<tbody>' + provenanceRows + '</tbody></table>'
    + '<footer>Generated by NodeChem Studio from the queue record and the per-run run.json files. '
    + 'A value a run did not report is shown as “not reported”; nothing is inferred. '
    + 'This document contains no scripts and makes no network requests.</footer>'
    + '</body></html>\n';
}
