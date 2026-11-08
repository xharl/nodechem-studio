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

/** Hartree → kcal/mol, the same constant the conformer module uses. */
const HARTREE_KCAL = 627.5094740631;

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
    // RFC 0001: the dataset record a task was expanded for. A v1 task has no
    // record id and every grouping below is skipped, leaving the old report.
    recordId: text(task.recordId),
    recordLabel: text(task.record?.label),
    recordCharge: Number.isInteger(task.record?.charge) ? task.record.charge : null,
    recordMultiplicity: Number.isInteger(task.record?.multiplicity) ? task.record.multiplicity : null,
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
    // A geometry that crossed an engine boundary: where it came from, so the
    // report shows the hand-off rather than implying the block ran on its own.
    geometryHandoff: (task.geometryHandoff || record?.geometryHandoff)
      ? {
        from: text(task.geometryHandoff?.from ?? record?.geometryHandoff?.from),
        fromEngine: text(task.geometryHandoff?.fromEngine ?? record?.geometryHandoff?.fromEngine),
        toEngine: text(task.geometryHandoff?.toEngine ?? record?.geometryHandoff?.toEngine),
        atoms: Number.isFinite(task.geometryHandoff?.atoms ?? record?.geometryHandoff?.atoms)
          ? (task.geometryHandoff?.atoms ?? record?.geometryHandoff?.atoms) : null,
      }
      : null,
    jobType: text(record?.provenance?.jobType || method.jobType),
    method: text(method.functional || method.hamiltonian),
    basis: text(method.basis),
    // Issue #80: a fanned-out run names its member, and the report keeps that
    // label so N rows from one block can be grouped and compared at the level
    // they were actually run at.
    conformer: (() => {
      const source = (task.conformer && typeof task.conformer === 'object' ? task.conformer : null)
        || (record?.conformer && typeof record.conformer === 'object' ? record.conformer : null);
      if (!source) return null;
      return {
        nodeId: text(source.nodeId),
        title: text(source.title),
        memberId: text(source.id),
        relativeKcal: num(source.relativeKcal),
        population: num(source.population),
        protomer: text(source.protomer),
      };
    })(),
    fanOut: task.fanOut && typeof task.fanOut === 'object'
      ? { conformerId: text(task.fanOut.conformerId), memberId: text(task.fanOut.memberId) }
      : null,
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
 * RFC 0001: one row per dataset record, for the comparison table.
 *
 * The status is the record's own outcome, not the queue's: a record whose
 * optimisation completed but whose frequency failed is `failed` (nothing
 * usable) while a record with one failed block beside completed ones is
 * `partial`. `needs-review` counts as a failure here because the run exists but
 * its gates do not hold — the same reading the queue's `partial` verdict uses.
 */
function recordGroup(recordId, rows, info = null) {
  const statuses = rows.map((row) => row.status);
  const passed = statuses.filter((status) => status === 'completed' || status === 'passed').length;
  const failedRows = rows.filter((row) => row.status === 'failed' || row.status === 'needs-review');
  const notRun = statuses.filter((status) => (
    status === 'pending' || status === 'queued' || status === 'blocked'
    || status === 'cancelled' || status === 'interrupted' || status === 'skipped'
  )).length;
  const status = failedRows.length > 0
    ? (passed > 0 ? 'partial' : 'failed')
    : notRun > 0 ? (passed > 0 ? 'partial' : 'incomplete') : 'completed';

  const gated = rows.filter((row) => row.gates === 'pass' || row.gates === 'fail');
  const gates = gated.some((row) => row.gates === 'fail') ? 'fail'
    : gated.length === 0 ? 'unknown'
      : gated.length < rows.length ? 'partial' : 'pass';

  // The last block that reported an energy is the record's final level: the
  // plan order is the workflow order, so a later block supersedes an earlier one.
  let finalEnergyHartree = null;
  for (const row of rows) {
    if (Number.isFinite(row.finalEnergyHartree)) finalEnergyHartree = row.finalEnergyHartree;
  }

  const methods = [];
  for (const row of rows) {
    const level = row.method
      ? (row.basis ? `${row.method}/${row.basis}` : row.method)
      : row.basis;
    if (level && !methods.includes(level)) methods.push(level);
  }

  const first = rows.find((row) => row.recordLabel) || null;
  return {
    id: recordId,
    label: text(info?.label) || first?.recordLabel || recordId,
    charge: Number.isInteger(info?.charge) ? info.charge : (first?.recordCharge ?? null),
    multiplicity: Number.isInteger(info?.multiplicity) ? info.multiplicity : (first?.recordMultiplicity ?? null),
    status,
    gates,
    finalEnergyHartree,
    // Filled once the first completed record establishes the baseline.
    relativeKcal: null,
    methods,
    tasks: rows.map((row) => row.nodeId),
    counts: {
      total: rows.length,
      passed,
      failed: failedRows.length,
      notRun,
    },
    failedTasks: failedRows.map((row) => ({
      nodeId: row.nodeId,
      title: row.title,
      status: row.status,
      gates: row.gates,
      error: row.error,
    })),
  };
}

/**
 * @param {object} queue the queue record written by the queue manager
 * @param {Object<string, object>} records run records keyed by run id (or by node id)
 * @param {object} [options]
 * @param {string|null} [options.generatedAt]
 * @param {string|null} [options.appVersion]
 * @param {Array<object>|Object<string, object>|null} [options.recordInfo]
 *   dataset record metadata (`id`, `label`, `charge`, `multiplicity`) used to
 *   label a group whose tasks carry no `record` object
 * @returns {object} a serialisable report model
 */
export function buildWorkflowReport(queue, records = {}, {
  generatedAt = null,
  appVersion = null,
  recordInfo = null,
} = {}) {
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
    // Legacy report fixtures call a finished task `passed`; the queue calls it
    // `completed`. Both mean the same thing to a reader.
    passed: rows.filter((row) => row.status === 'passed' || row.status === 'completed').length,
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

  // Issue #80: fanned-out branches are one row per member. Group them by the
  // conformer block and compare final energies at the level they were run at —
  // the search-level ΔE is kept beside it, never substituted for it.
  const conformerGroups = new Map();
  for (const row of rows) {
    if (!row.conformer?.nodeId) continue;
    if (!conformerGroups.has(row.conformer.nodeId)) conformerGroups.set(row.conformer.nodeId, []);
    conformerGroups.get(row.conformer.nodeId).push(row);
  }
  const conformers = [...conformerGroups.entries()]
    .filter(([, group]) => group.length > 1 && group.some((row) => row.fanOut))
    .map(([id, group]) => {
      // Only a one-run-per-member group is comparable: a second fanned block
      // (say Opt and Freq on every member) puts two different levels in one
      // table, and silently picking one would invent an ordering.
      const memberIds = group.map((row) => row.conformer.memberId);
      const uniqueMembers = new Set(memberIds);
      const comparable = uniqueMembers.size === memberIds.length && uniqueMembers.size > 1
        && group.every((row) => row.fanOut);
      const energies = comparable
        ? group.map((row) => row.finalEnergyHartree).filter((value) => Number.isFinite(value))
        : [];
      const lowest = energies.length === group.length && energies.length > 0 ? Math.min(...energies) : null;
      const members = group.map((row) => ({
        nodeId: row.nodeId,
        memberId: row.conformer.memberId,
        protomer: row.conformer.protomer,
        status: row.status,
        energyHartree: row.finalEnergyHartree,
        relativeKcalSearch: row.conformer.relativeKcal,
        relativeKcalTarget: lowest !== null && Number.isFinite(row.finalEnergyHartree)
          ? (row.finalEnergyHartree - lowest) * HARTREE_KCAL
          : null,
      }));
      return {
        id,
        title: group[0].conformer.title || id,
        comparable,
        members,
        spreadKcalTarget: lowest !== null ? (Math.max(...energies) - lowest) * HARTREE_KCAL : null,
      };
    });

  // RFC 0001: one comparison row per dataset record, in plan order. Conformer
  // groups stay separate: they are branches inside a record, not records.
  const infoById = new Map();
  if (Array.isArray(recordInfo)) {
    for (const info of recordInfo) if (info?.id) infoById.set(String(info.id), info);
  } else if (recordInfo && typeof recordInfo === 'object') {
    for (const [id, info] of Object.entries(recordInfo)) infoById.set(String(id), info);
  }
  const grouped = new Map();
  for (const row of rows) {
    if (!row.recordId) continue;
    if (!grouped.has(row.recordId)) grouped.set(row.recordId, []);
    grouped.get(row.recordId).push(row);
  }
  const recordModels = [...grouped.entries()]
    .map(([id, groupRows]) => recordGroup(id, groupRows, infoById.get(id) || null));
  // ΔE is reported against the first *completed* record with an energy — the
  // baseline the reader would pick — and only where both numbers exist.
  const baseline = recordModels.find((record) => record.status === 'completed'
    && Number.isFinite(record.finalEnergyHartree))
    || recordModels.find((record) => Number.isFinite(record.finalEnergyHartree))
    || null;
  for (const record of recordModels) {
    if (baseline && Number.isFinite(record.finalEnergyHartree)) {
      record.relativeKcal = (record.finalEnergyHartree - baseline.finalEnergyHartree) * HARTREE_KCAL;
    }
  }

  const flowId = text(source.flowId) || text(tasks.find((task) => task?.flowId)?.flowId) || 'main';
  const flowTitle = text(source.flowTitle) || text(source.flow?.title) || text(source.projectName) || flowId;

  return {
    schemaVersion: WORKFLOW_REPORT_SCHEMA_VERSION,
    kind: 'nodechem-studio.workflow-report',
    generatedAt: text(generatedAt),
    appVersion: text(appVersion),
    flow: {
      id: flowId,
      title: flowTitle,
    },
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
    // One entry per dataset record (empty for a v1 single-run queue), with the
    // comparison numbers a reader needs between records.
    records: recordModels,
    // One entry per conformer block whose branches were fanned out, with the
    // target-level ΔE the run energies actually support.
    conformers,
    // One entry per method ladder, with the per-rung energies that produced the
    // verdict. Absent ladders are omitted rather than reported as passed.
    ladders: Object.entries(source.ladders && typeof source.ladders === 'object' ? source.ladders : {})
      .map(([id, ladder]) => ({
        id,
        status: text(ladder?.status) || 'unknown',
        toleranceKcal: Number.isFinite(ladder?.toleranceKcal) ? ladder.toleranceKcal : null,
        spreadKcal: Number.isFinite(ladder?.spreadKcal) ? ladder.spreadKcal : null,
        reason: text(ladder?.reason),
        entries: (Array.isArray(ladder?.entries) ? ladder.entries : []).map((entry) => ({
          id: text(entry?.id),
          label: text(entry?.label),
          energyHartree: Number.isFinite(entry?.energyHartree) ? entry.energyHartree : null,
          relativeKcalPerMol: Number.isFinite(entry?.relativeKcalPerMol) ? entry.relativeKcalPerMol : null,
        })),
      })),
    spins: Object.entries(source.spins && typeof source.spins === 'object' ? source.spins : {})
      .map(([id, sweep]) => ({
        id,
        groundMultiplicity: Number.isInteger(sweep?.groundMultiplicity) ? sweep.groundMultiplicity : null,
        reason: text(sweep?.reason),
        rows: (Array.isArray(sweep?.rows) ? sweep.rows : []).map((row) => ({
          multiplicity: Number.isInteger(row?.multiplicity) ? row.multiplicity : null,
          energyHartree: Number.isFinite(row?.energyHartree) ? row.energyHartree : null,
          relativeKcalPerMol: Number.isFinite(row?.relativeKcalPerMol) ? row.relativeKcalPerMol : null,
          spinSquared: Number.isFinite(row?.spinSquared) ? row.spinSquared : null,
        })),
      })),
    // ΔG‡ for a reaction path, only where the queue computed one and only with
    // the correction scheme attached.
    reactions: Object.entries(source.reactions && typeof source.reactions === 'object' ? source.reactions : {})
      .map(([nodeId, reaction]) => ({
        nodeId,
        available: reaction?.available === true,
        kcalPerMol: Number.isFinite(reaction?.kcalPerMol) ? reaction.kcalPerMol : null,
        scheme: text(reaction?.scheme),
        reason: text(reaction?.reason),
        transitionStateNodeId: text(reaction?.transitionStateNodeId),
        reactantNodeId: text(reaction?.reactantNodeId),
        temperatureK: Number.isFinite(reaction?.temperatureK) ? reaction.temperatureK : null,
        endpointCheck: reaction?.endpointCheck
          ? {
            status: ['pass', 'fail', 'unknown'].includes(reaction.endpointCheck.status) ? reaction.endpointCheck.status : 'unknown',
            detail: text(reaction.endpointCheck.detail),
            end: text(reaction.endpointCheck.end) || null,
            deltaKcal: Number.isFinite(reaction.endpointCheck.deltaKcal) ? reaction.endpointCheck.deltaKcal : null,
          }
          : null,
      })),
    fixtures: rows.filter((row) => row.dryRun).length,
  };
}

function value(value, digits = null, unit = '') {
  if (value === null || value === undefined) return MISSING;
  if (typeof value === 'number' && digits !== null) return value.toFixed(digits) + unit;
  return String(value);
}

/** Anchor ids are built from user text, so keep only characters HTML accepts in an id. */
function anchorId(value) {
  return String(value || 'flow').replace(/[^A-Za-z0-9._:-]+/g, '-');
}

/** The per-task table, used once for a v1 queue and once per record in a family. */
function taskTableHtml(rows) {
  const tableRows = rows.map((row) => {
    const fixture = row.dryRun ? ' <span class="fixture">FIXTURE</span>' : '';
    const gates = row.gates === null ? MISSING : row.gates;
    const gateClass = gates === 'pass' || gates === 'fail' ? gates : 'unknown';
    const level = row.jobType || row.type || '';
    const kindSuffix = row.kind && row.kind !== level ? ` · ${row.kind}` : '';
    const member = row.conformer?.memberId
      ? ` <span class="mono">· member ${escapeHtml(row.conformer.memberId)}${row.conformer.protomer ? ` (${escapeHtml(row.conformer.protomer)})` : ''}</span>`
      : '';
    return '<tr data-node="' + escapeHtml(row.nodeId || '') + '" data-status="' + escapeHtml(row.status) + '">'
      + `<td><strong>${escapeHtml(row.title)}</strong>${member}${fixture}<div class="sub">`
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
  return '<table><thead><tr><th>Block</th><th>Status</th><th>Gates</th><th>Validity</th><th>Engine</th>'
    + '<th>Level</th><th class="num">E / Eh</th><th class="num">G / Eh</th><th class="num">Imag.</th>'
    + '<th class="num">Elapsed</th></tr></thead><tbody>' + tableRows + '</tbody></table>';
}

/**
 * The record comparison table (RFC 0001, phase 5). ΔE is against the first
 * completed record, recomputed from the run energies, never copied from a
 * previous report.
 */
function recordComparisonHtml(records, flowAnchor, headingTag = 'h2') {
  const body = records.map((record) => {
    const statusClass = record.status === 'failed' ? 'gates-fail'
      : record.status === 'completed' ? 'gates-pass' : 'warn-text';
    const gateClass = record.gates === 'pass' || record.gates === 'fail' ? record.gates : 'unknown';
    return '<tr data-record="' + escapeHtml(record.id) + '">'
      + `<td><a href="#record-${escapeHtml(flowAnchor)}-${escapeHtml(anchorId(record.id))}"><strong>${escapeHtml(record.label || record.id)}</strong></a>`
      + `<div class="sub mono">${escapeHtml(record.id)}`
      + `${record.charge === null ? '' : ` · charge ${escapeHtml(String(record.charge))}`}`
      + `${record.multiplicity === null ? '' : ` · multiplicity ${escapeHtml(String(record.multiplicity))}`}</div></td>`
      + `<td class="${statusClass}">${escapeHtml(record.status)}</td>`
      + `<td class="gates-${gateClass}">${escapeHtml(record.gates)}</td>`
      + `<td class="num">${escapeHtml(value(record.finalEnergyHartree, 8))}</td>`
      + `<td class="num">${escapeHtml(value(record.relativeKcal, 2))}</td>`
      + `<td>${record.methods.length > 0 ? record.methods.map((entry) => escapeHtml(entry)).join('<br>') : MISSING}</td>`
      + '</tr>';
  }).join('');
  return `<${headingTag}>Records</${headingTag}>`
    + '<p>One row per dataset record. ΔE is the final energy against the first completed record.</p>'
    + '<table><thead><tr><th>Record</th><th>Status</th><th>Gates</th><th class="num">E / Eh</th>'
    + '<th class="num">ΔE / kcal mol⁻¹</th><th>Methods</th></tr></thead><tbody>' + body + '</tbody></table>';
}

/** One section per record, with the failed block named instead of hidden. */
function recordSectionHtml(record, rows, flowAnchor, headingTag) {
  const failed = record.failedTasks.length > 0
    ? '<ul class="failures">' + record.failedTasks.map((task) => (
      `<li><strong>${escapeHtml(task.title)}</strong> — status ${escapeHtml(task.status)}`
      + `${task.gates ? `, gates ${escapeHtml(task.gates)}` : ''}`
      + `${task.error ? `; ${escapeHtml(task.error)}` : ''}</li>`
    )).join('') + '</ul>'
    : '';
  return `<${headingTag} id="record-${escapeHtml(flowAnchor)}-${escapeHtml(anchorId(record.id))}">Record — ${escapeHtml(record.label || record.id)}</${headingTag}>`
    + `<p class="meta">Record ${escapeHtml(record.id)} · status ${escapeHtml(record.status)}`
    + ` · gates ${escapeHtml(record.gates)}`
    + `${record.charge === null ? '' : ` · charge ${escapeHtml(String(record.charge))}`}`
    + `${record.multiplicity === null ? '' : ` · multiplicity ${escapeHtml(String(record.multiplicity))}`}</p>`
    + failed
    + taskTableHtml(rows);
}

const REPORT_STYLE = 'body{font:13px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:32px auto;max-width:1100px;padding:0 20px;color:#16181d;background:#fff}'
  + 'h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px;border-bottom:1px solid #e3e6eb;padding-bottom:4px}'
  + 'h3{font-size:14px;margin:26px 0 8px;border-bottom:1px solid #e3e6eb;padding-bottom:4px}'
  + '.meta{color:#5b6472;font-size:12px}.sub{color:#6b7480;font-size:11px;font-weight:400}'
  + 'table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:6px 8px;border-bottom:1px solid #eceef2;text-align:left;vertical-align:top}'
  + 'th{background:#f7f8fa;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#5b6472}'
  + '.num{text-align:right;font-variant-numeric:tabular-nums}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}'
  + '.gates-pass{color:#137a3a;font-weight:600}.gates-fail{color:#b42318;font-weight:600}.warn-text{color:#7a5b00;font-weight:600}'
  + '.fixture{background:#fff3cd;color:#7a5b00;border-radius:3px;padding:0 4px;font-size:10px;font-weight:600}'
  + '.warn{background:#fff8e6;border-left:3px solid #e0a800;padding:8px 10px}'
  + '.ok{color:#137a3a}.failures{color:#b42318}'
  + 'pre{white-space:pre-wrap;font-size:11px;background:#f7f8fa;padding:10px;border-radius:4px}'
  + 'details{margin:6px 0}summary{cursor:pointer;font-size:12px}'
  + '.flow-section{margin-top:36px;border-top:2px solid #e3e6eb;padding-top:8px}'
  + 'footer{margin-top:32px;color:#6b7480;font-size:11px;border-top:1px solid #e3e6eb;padding-top:8px}';

const REPORT_FOOTER = 'Generated by NodeChem Studio from the queue record and the per-run run.json files. '
  + 'A value a run did not report is shown as “not reported”; nothing is inferred. '
  + 'This document contains no scripts and makes no network requests.';

/**
 * The body of one report. `level` is 1 for a stand-alone document and 2 for a
 * flow section inside the combined report, so heading depth stays correct.
 */
function reportContentHtml(model, { methodsFor = null, level = 1 } = {}) {
  if (!model || typeof model !== 'object') return '';
  const q = model.queue || {};
  const counts = model.counts || {};
  const rows = Array.isArray(model.tasks) ? model.tasks : [];
  const records = Array.isArray(model.records) ? model.records : [];
  const flowAnchor = anchorId(model.flow?.id || q.id || 'flow');
  const topHeading = level === 1 ? 'h1' : 'h2';
  const sectionHeading = level === 1 ? 'h2' : 'h3';

  const failures = rows.filter((row) => row.status === 'failed' || row.gates === 'fail');
  const failureList = failures.length === 0
    ? '<p class="ok">No task failed and no executed task failed its gates.</p>'
    : '<ul class="failures">' + failures.map((row) => (
      `<li><strong>${escapeHtml(row.title)}</strong> — status ${escapeHtml(row.status)}, gates `
      + `${escapeHtml(row.gates === null ? MISSING : row.gates)}`
      + (row.error ? `; ${escapeHtml(row.error)}` : '') + '</li>'
    )).join('') + '</ul>';

  const failedRecords = records.filter((record) => record.status === 'failed' || record.status === 'partial');
  const failedRecordNote = failedRecords.length === 0
    ? ''
    : `<p class="warn">Records needing attention: <strong>${failedRecords
      .map((record) => escapeHtml(record.label || record.id)).join(', ')}</strong>.</p>`;

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
    + `<td>${escapeHtml(row.title)}${row.geometryHandoff
      ? ` <span class="mono">(geometry from ${escapeHtml(row.geometryHandoff.from)} · `
        + `${escapeHtml(row.geometryHandoff.fromEngine)} → ${escapeHtml(row.geometryHandoff.toEngine)}, `
        + `${escapeHtml(String(row.geometryHandoff.atoms ?? MISSING))} atoms)</span>`
      : ''}</td>`
    + `<td class="mono">${escapeHtml(row.runId === null ? MISSING : row.runId)}</td>`
    + `<td class="mono">${escapeHtml(shortHash(row.inputSha256) ?? MISSING)}</td>`
    + `<td class="mono">${escapeHtml(shortHash(row.outputSha256) ?? MISSING)}</td>`
    + '</tr>'
  )).join('');

  // The spread table for each method ladder: the numbers behind the verdict,
  // including rungs that ran without a parsed energy (shown, not omitted).
  const ladderBlocks = (Array.isArray(model.ladders) ? model.ladders : []).map((ladder) => {
    const rowsHtml = ladder.entries.map((entry) => '<tr>'
      + `<td>${escapeHtml(entry.label || entry.id || MISSING)}</td>`
      + `<td class="num">${escapeHtml(value(entry.energyHartree, 8))}</td>`
      + `<td class="num">${escapeHtml(value(entry.relativeKcalPerMol, 2))}</td>`
      + '</tr>').join('');
    const statusClass = ladder.status === 'pass' ? 'gates-pass' : ladder.status === 'fail' ? 'gates-fail' : '';
    return `<${sectionHeading}>Method ladder — ${escapeHtml(ladder.id)}</${sectionHeading}>`
      + `<p class="${statusClass}">${escapeHtml(ladder.status)} · spread `
      + `${escapeHtml(value(ladder.spreadKcal, 2))} kcal/mol against a tolerance of `
      + `${escapeHtml(value(ladder.toleranceKcal, 2))} kcal/mol. ${escapeHtml(ladder.reason || '')}</p>`
      + '<table><thead><tr><th>Rung</th><th class="num">E / Eh</th><th class="num">ΔE / kcal mol⁻¹</th></tr></thead>'
      + `<tbody>${rowsHtml}</tbody></table>`;
  }).join('');

  // Spin-state sweeps: one table per swept block, ground state marked.
  const spinBlocks = (Array.isArray(model.spins) ? model.spins : []).map((sweep) => {
    const body = sweep.rows.map((row) => {
      const ground = sweep.groundMultiplicity !== null && row.multiplicity === sweep.groundMultiplicity;
      const label = row.multiplicity === null ? MISSING : String(row.multiplicity);
      return '<tr' + (ground ? ' class="ground-state"' : '') + '>'
        + `<td>${escapeHtml(label)}${ground ? ' <span class="tag">ground</span>' : ''}</td>`
        + `<td class="num">${escapeHtml(value(row.energyHartree, 8))}</td>`
        + `<td class="num">${escapeHtml(value(row.relativeKcalPerMol, 2))}</td>`
        + `<td class="num">${row.spinSquared === null ? 'not reported' : escapeHtml(row.spinSquared.toFixed(4))}</td>`
        + '</tr>';
    }).join('');
    return `<${sectionHeading}>Spin-state sweep — ${escapeHtml(sweep.id)}</${sectionHeading}>`
      + `<p>${escapeHtml(sweep.reason || '')}</p>`
      + '<table><thead><tr><th>Multiplicity</th><th class="num">E / Eh</th>'
      + '<th class="num">ΔE / kcal mol⁻¹</th><th class="num">⟨S²⟩</th></tr></thead>'
      + `<tbody>${body}</tbody></table>`;
  }).join('');

  // Reaction energetics: ΔG‡ only where both runs carried a free energy, with
  // the correction scheme printed next to the number.
  const reactionBlocks = (Array.isArray(model.reactions) ? model.reactions : []).map((reaction) => (
    `<${sectionHeading}>Reaction energetics — ${escapeHtml(reaction.nodeId)}</${sectionHeading}>`
    + (reaction.available
      ? `<p><strong>ΔG‡ = ${escapeHtml(value(reaction.kcalPerMol, 2))} kcal mol⁻¹</strong>`
        + `${reaction.temperatureK ? ` at ${escapeHtml(String(reaction.temperatureK))} K` : ''}. `
        + `${escapeHtml(reaction.scheme || '')} `
        + `(TS block ${escapeHtml(reaction.transitionStateNodeId || MISSING)}, reactant block ${escapeHtml(reaction.reactantNodeId || MISSING)}.)</p>`
      : `<p class="warn">ΔG‡ not computed: ${escapeHtml(reaction.reason || 'the reaction path has no declared reactant block.')}</p>`)
    + (reaction.endpointCheck
      ? `<p class="warn">Path endpoints: <strong>${escapeHtml(reaction.endpointCheck.status)}</strong> — ${escapeHtml(reaction.endpointCheck.detail || '')}</p>`
      : '')
  )).join('');

  // Conformer ensembles at the target level (#80): one table per fanned-out
  // block. The search ΔE is shown beside the target ΔE so the two levels are
  // never confused, and a member that did not report an energy stays blank.
  const conformerBlocks = (Array.isArray(model.conformers) ? model.conformers : []).map((ensemble) => {
    const body = ensemble.members.map((member) => '<tr>'
      + `<td>${escapeHtml(member.memberId || MISSING)}${member.protomer ? ` · ${escapeHtml(member.protomer)}` : ''}</td>`
      + `<td>${escapeHtml(member.status || MISSING)}</td>`
      + `<td class="num">${escapeHtml(value(member.energyHartree, 8))}</td>`
      + `<td class="num">${escapeHtml(value(member.relativeKcalSearch, 2))}</td>`
      + `<td class="num">${escapeHtml(value(member.relativeKcalTarget, 2))}</td>`
      + '</tr>').join('');
    return `<${sectionHeading}>Conformer ensemble at the target level — ${escapeHtml(ensemble.title || ensemble.id)}</${sectionHeading}>`
      + (ensemble.comparable
        ? `<p>Spread at the target level: <strong>${escapeHtml(value(ensemble.spreadKcalTarget, 2))} kcal/mol</strong>.`
          + ' ΔE is recomputed from the runs\' final energies; the search-level ΔE is shown for comparison only.</p>'
        : '<p class="warn">Not compared: this block fed more than one task per member (or several levels), so a single target-level ΔE would mix different calculations. The rows are listed without one.</p>')
      + '<table><thead><tr><th>Member</th><th>Status</th><th class="num">E / Eh</th>'
      + '<th class="num">ΔE search / kcal mol⁻¹</th><th class="num">ΔE target / kcal mol⁻¹</th></tr></thead>'
      + `<tbody>${body}</tbody></table>`;
  }).join('');

  const fixtureNote = model.fixtures > 0
    ? `<p class="warn">${model.fixtures} task${model.fixtures === 1 ? '' : 's'} ran as a labelled fixture (dry run). Fixture numbers are test data, not calculations.</p>`
    : '';

  // A v1 queue keeps its single table; a record-scoped queue gets the
  // comparison table plus one section per record, in plan order.
  const whatRan = records.length > 0
    ? recordComparisonHtml(records, flowAnchor, sectionHeading)
      + records.map((record) => recordSectionHtml(
        record,
        rows.filter((row) => row.recordId === record.id),
        flowAnchor,
        sectionHeading,
      )).join('')
    : `<${sectionHeading}>What ran</${sectionHeading}>` + taskTableHtml(rows);

  return `<${topHeading}>Workflow report — ${escapeHtml(q.projectName || q.id || 'queue')}</${topHeading}>`
    + `<p class="meta">Queue ${escapeHtml(q.id || MISSING)} · status ${escapeHtml(q.status || MISSING)}`
    + ` · created ${escapeHtml(q.createdAt || MISSING)} · finished ${escapeHtml(q.finishedAt || MISSING)}`
    + ` · generated ${escapeHtml(model.generatedAt || MISSING)}`
    + ` · NodeChem Studio ${escapeHtml(model.appVersion || MISSING)}</p>`
    + fixtureNote
    + `<${sectionHeading}>Outcome</${sectionHeading}>`
    + `<p>${counts.total || 0} task(s): ${counts.passed || 0} passed, ${counts.failed || 0} failed, `
    + `${counts.skipped || 0} skipped, ${counts.cancelled || 0} cancelled, ${counts.notRun || 0} not run. `
    + `Gate verdict: <strong>${escapeHtml(model.verdict || 'unknown')}</strong>.</p>`
    + failureList
    + failedRecordNote
    + whatRan
    + ladderBlocks
    + conformerBlocks
    + spinBlocks
    + reactionBlocks
    + (methodsBlocks ? `<${sectionHeading}>Methods</${sectionHeading}>` + methodsBlocks : '')
    + `<${sectionHeading}>Provenance</${sectionHeading}>`
    + '<table><thead><tr><th>Block</th><th>Run</th><th>Input SHA-256</th><th>Output SHA-256</th></tr></thead>'
    + '<tbody>' + provenanceRows + '</tbody></table>';
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
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
    + `<title>Workflow report — ${escapeHtml(q.projectName || q.id || 'queue')}</title>`
    + `<style>${REPORT_STYLE}</style></head><body>`
    + reportContentHtml(model, { methodsFor })
    + `<footer>${REPORT_FOOTER}</footer>`
    + '</body></html>\n';
}

/**
 * Combine per-flow models into one self-contained document (RFC 0001, §8).
 *
 * The index is not a table of contents only: a flow with failed or partial
 * records names them in its row, so a reader cannot mistake a green flow
 * verdict for a batch that lost molecules. Each flow is anchored at
 * `#flow-<id>`; the sections are the same bodies the per-flow report uses.
 */
export function buildCombinedReportHtml(models, { title = 'Project report', generatedAt = null } = {}) {
  const list = (Array.isArray(models) ? models : []).filter((model) => model && typeof model === 'object');
  const docTitle = String(title || 'Project report');
  const generated = text(generatedAt) || text(list[0]?.generatedAt) || MISSING;

  const indexRows = list.map((model) => {
    const flow = model.flow || {};
    const flowId = anchorId(flow.id || 'flow');
    const records = Array.isArray(model.records) ? model.records : [];
    const failed = records.filter((record) => record.status === 'failed' || record.status === 'partial');
    const recordCounts = records.length > 0
      ? `${records.length} record(s): ${records.filter((record) => record.status === 'completed').length} completed, ${failed.length} needing attention`
      : `${model.counts?.total || 0} task(s)`;
    const verdictClass = model.verdict === 'pass' ? 'pass' : model.verdict === 'fail' ? 'fail' : 'unknown';
    return '<tr>'
      + `<td><a href="#flow-${escapeHtml(flowId)}"><strong>${escapeHtml(flow.title || flow.id || model.queue?.projectName || 'flow')}</strong></a>`
      + `<div class="sub mono">${escapeHtml(flow.id || '')}</div></td>`
      + `<td>${escapeHtml(model.queue?.status || MISSING)}</td>`
      + `<td class="gates-${verdictClass}">${escapeHtml(model.verdict || 'unknown')}</td>`
      + `<td>${escapeHtml(recordCounts)}</td>`
      + `<td>${failed.length > 0
        ? failed.map((record) => `<strong>${escapeHtml(record.label || record.id)}</strong> <span class="sub">(${escapeHtml(record.status)})</span>`).join('<br>')
        : '<span class="ok">none</span>'}</td>`
      + '</tr>';
  }).join('');

  const sections = list.map((model) => {
    const flowId = anchorId(model.flow?.id || 'flow');
    return `<section class="flow-section" id="flow-${escapeHtml(flowId)}">`
      + reportContentHtml(model, { level: 2 })
      + '</section>';
  }).join('');

  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
    + `<title>${escapeHtml(docTitle)}</title>`
    + `<style>${REPORT_STYLE}</style></head><body>`
    + `<h1>${escapeHtml(docTitle)}</h1>`
    + `<p class="meta">Generated ${escapeHtml(generated)} · ${list.length} flow${list.length === 1 ? '' : 's'}`
    + ' · NodeChem Studio</p>'
    + '<h2>Index</h2>'
    + '<table><thead><tr><th>Flow</th><th>Queue status</th><th>Verdict</th><th>Records</th>'
    + '<th>Failed or partial records</th></tr></thead><tbody>'
    + indexRows
    + '</tbody></table>'
    + sections
    + `<footer>${REPORT_FOOTER}</footer>`
    + '</body></html>\n';
}
