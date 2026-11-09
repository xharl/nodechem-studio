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

import { cbsExtrapolate } from './cbs.js';
import { boltzmannWeightedObservables, formatPopulation } from './conformers.js';
import { IMPORTED_BADGE_TEXT, importedSummary } from './importedRecord.js';
import { contentHash } from './figures/primitives.js';
import { flowGraphFigure } from './figures/dag.js';
import { taskFigures } from './figures/report.js';

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

function taskRow(task, record, { includeImported = false } = {}) {
  const parsed = record?.parsed && typeof record.parsed === 'object' ? record.parsed : {};
  const method = record?.provenance?.method && typeof record.provenance.method === 'object'
    ? record.provenance.method : {};
  // Issue #131: a number another program computed is a different kind of
  // record. It is carried as its own labelled row; its energy only enters the
  // energy columns when the caller asked for it, and never unlabelled.
  const imported = importedSummary(record);
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
    // An imported result keeps its own summary instead of being flattened into
    // the run fields: program, version, method, basis, energy and source hash.
    imported: imported ? { ...imported, included: includeImported } : null,
    engine: imported ? imported.program : text(record?.engine || parsed.engine),
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
    method: imported ? imported.method : text(method.functional || method.hamiltonian),
    basis: imported ? imported.basis : text(method.basis),
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
    finalEnergyHartree: imported
      ? (includeImported && Number.isFinite(imported.energyHartree) ? imported.energyHartree : null)
      : num(parsed.finalEnergy?.hartree),
    gibbsHartree: num(parsed.thermochemistry?.freeEnergyHartree),
    // Issue #96: a per-conformer scalar the parser already produced, so the
    // ensemble table can weight it instead of inventing a second observable.
    gapEv: num(parsed?.orbitals?.alpha?.gapEv),
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
/**
 * Builds the report's figures from the records.
 *
 * Budget: the whole figure set is capped, and the cap is enforced here rather
 * than hoped for. Figures are added in priority order (graph, then the spectra a
 * run printed, then levels, then a slice), and whatever does not fit is named in
 * `dropped` so the document can say so.
 */
const FIGURE_BUDGET_BYTES = 5 * 1024 * 1024;

function buildFigures({
  queue = {}, tasks = [], rows = [], recordMap = {}, figureLevel = 'basic', volumes = null,
  surfaces = null, budgetBytes = FIGURE_BUDGET_BYTES,
}) {
  const level = figureLevel === 'none' ? 'none' : (figureLevel === 'surfaces' ? 'surfaces' : 'basic');
  const result = { level, dag: null, byTask: {}, dropped: [], bytes: 0 };
  if (level === 'none') return result;

  const nodeRows = rows.map((row) => ({
    id: row.nodeId,
    label: row.title || row.nodeId,
    status: row.status || null,
  }));
  const edges = (Array.isArray(queue.edges) ? queue.edges : [])
    .map((edge) => ({ from: edge?.from ?? edge?.source, to: edge?.to ?? edge?.target }))
    .filter((edge) => edge.from && edge.to);
  const dag = flowGraphFigure({ nodes: nodeRows, edges });
  if (dag) {
    result.dag = {
      svg: dag.svg, caption: dag.caption, hash: contentHash(dag.svg), bytes: dag.svg.length,
    };
    result.bytes += dag.svg.length;
  }

  for (const task of tasks) {
    const nodeId = task?.nodeId;
    if (!nodeId) continue;
    const record = (task.runId ? recordMap[task.runId] : null) || recordMap[nodeId] || null;
    if (!record) continue;
    let entries;
    try {
      entries = taskFigures(record, {
        level,
        volume: volumes ? volumes[nodeId] || null : null,
        surfaces: surfaces ? surfaces[nodeId] || null : null,
      });
    } catch (error) {
      entries = [{ key: 'figures', figure: null, reason: `figure build failed: ${error.message}` }];
    }
    const rendered = [];
    for (const entry of entries) {
      if (!entry.figure) {
        if (entry.reason) rendered.push({ key: entry.key, svg: null, caption: null, reason: entry.reason });
        continue;
      }
      if (result.bytes + entry.figure.svg.length > budgetBytes) {
        result.dropped.push({ nodeId, key: entry.key, reason: 'figure budget exhausted' });
        continue;
      }
      result.bytes += entry.figure.svg.length;
      rendered.push({
        key: entry.key,
        svg: entry.figure.svg,
        caption: entry.figure.caption,
        hash: contentHash(entry.figure.svg),
        bytes: entry.figure.svg.length,
      });
    }
    if (rendered.length > 0) result.byTask[nodeId] = rendered;
  }
  return result;
}

/**
 * Renders the figure set: the graph once, then each block's figures.
 *
 * A figure that could not be built is printed with its reason, in the same
 * register the rest of the report uses for a missing value. The caption always
 * carries the parameters and the content fingerprint, so a reader can tell two
 * pictures of the same spectrum apart.
 */
function figuresHtml(figures, rows, headingTag = 'h2') {
  if (!figures || figures.level === 'none') return '';
  const parts = [];
  if (figures.dag && figures.dag.svg) {
    parts.push(`<${headingTag}>Flow graph</${headingTag}>`
      + figureBlockHtml({ svg: figures.dag.svg, caption: figures.dag.caption, hash: figures.dag.hash, key: 'graph' }));
  }
  const titles = new Map(rows.map((row) => [row.nodeId, row.title || row.nodeId]));
  const blocks = Object.entries(figures.byTask || {}).map(([nodeId, entries]) => {
    const body = entries.map((entry) => (entry.svg
      ? figureBlockHtml({ ...entry, key: entry.key })
      : `<p class="fig-missing">${escapeHtml(entry.key)} figure not available: ${escapeHtml(entry.reason || 'no data')}</p>`)).join('');
    return `<${headingTag === 'h2' ? 'h3' : 'h4'}>${escapeHtml(titles.get(nodeId) || nodeId)}</${headingTag === 'h2' ? 'h3' : 'h4'}>` + body;
  }).join('');
  if (blocks) parts.push(`<${headingTag}>Figures</${headingTag}>` + blocks);
  if (Array.isArray(figures.dropped) && figures.dropped.length > 0) {
    const named = figures.dropped
      .map((entry) => `${entry.key} on ${titles.get(entry.nodeId) || entry.nodeId} (${entry.reason})`)
      .join('; ');
    parts.push(`<p class="warn">Figures omitted to keep the document within its size budget: ${escapeHtml(named)}.</p>`);
  }
  return parts.join('');
}

function figureBlockHtml({ svg, caption, hash, key }) {
  return `<figure class="fig" data-figure="${escapeHtml(key)}" data-hash="${escapeHtml(hash || '')}">`
    + svg
    + `<figcaption>${escapeHtml(caption || '')}${hash ? ` · figure ${escapeHtml(hash)}` : ''}</figcaption>`
    + '</figure>';
}

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
  // An imported result never supersedes one: it did not run here.
  let finalEnergyHartree = null;
  for (const row of rows) {
    if (!row.imported && Number.isFinite(row.finalEnergyHartree)) finalEnergyHartree = row.finalEnergyHartree;
  }
  const importedRows = rows.filter((row) => row.imported);

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
    // Why a ΔE is absent, when it is: an imported result in the record is the
    // one reason a reader could otherwise read the two numbers as one series.
    relativeKcalReason: importedRows.length > 0
      ? `${IMPORTED_BADGE_TEXT}: this record includes a result computed by another program, so it is not compared with a ΔE`
      : null,
    imported: importedRows.length > 0
      ? {
        ...importedRows[0].imported,
        nodes: importedRows.map((row) => row.nodeId),
      }
      : null,
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
 * Issue 175: one compute task, as the report needs it.
 *
 * The paragraph is the methods text for a derived record: it states the
 * expression, every upstream value the expression read, and the fact that the
 * result is arithmetic over recorded results rather than a calculated quantity.
 * A refusal is carried verbatim so the field and record it names survive.
 */
function derivedModel(task) {
  const compute = task.compute;
  const inputs = (Array.isArray(compute.inputs) ? compute.inputs : []).map((input) => ({
    recordId: text(input?.recordId),
    field: text(input?.field),
    value: num(input?.value),
    unit: text(input?.unit),
  }));
  const model = {
    nodeId: text(task.nodeId),
    title: text(task.title) || text(task.nodeId),
    recordId: text(task.recordId),
    status: text(compute.status) || (task.status === 'completed' ? 'computed' : 'refused'),
    expression: text(compute.expression),
    value: num(compute.value),
    unit: text(compute.unit),
    inputs,
    sources: Array.isArray(compute.sources) ? compute.sources.map(String) : [],
    notes: (Array.isArray(compute.notes) ? compute.notes : []).map((note) => text(note)).filter(Boolean),
    notComputed: text(compute.notComputed),
    paragraph: '',
  };
  model.paragraph = derivedParagraph(model);
  return model;
}

/** The one sentence a computed record's methods text is: what, from what. */
function derivedParagraph(model) {
  if (model.value === null) {
    return `Derived quantity not computed: ${model.notComputed || 'no reason was recorded'}`
      + `${model.expression ? ` (expression: ${model.expression})` : ''}.`;
  }
  const reads = model.inputs.length
    ? model.inputs.map((input) => `${input.field} of ${input.recordId}`
      + ` (${value(input.value, 9)}${input.unit ? ` ${input.unit}` : ''})`).join(', ')
    : 'no upstream value recorded';
  return `The value ${value(model.value, 9)}${model.unit ? ` ${model.unit}` : ''} is a derived quantity,`
    + ` not a computed QM result: it was evaluated as ${model.expression ? `"${model.expression}"` : 'an expression'}`
    + ` from ${reads}.`
    + (model.notes.length ? ` ${model.notes.join(' ')}` : '');
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
 * @param {boolean} [options.includeImported]
 *   include an imported result in the energy columns (labelled). Default
 *   `false`: the result is still listed and named, but its number is not put in
 *   a column that otherwise holds numbers this app computed.
 * @returns {object} a serialisable report model
 */
export function buildWorkflowReport(queue, records = {}, {
  generatedAt = null,
  appVersion = null,
  recordInfo = null,
  includeImported = false,
  figureLevel = 'basic',
  volumes = null,
  surfaces = null,
  figureBudgetBytes = FIGURE_BUDGET_BYTES,
} = {}) {
  const source = queue && typeof queue === 'object' ? queue : {};
  const tasks = Array.isArray(source.tasks) ? source.tasks : [];
  const recordMap = records && typeof records === 'object' ? records : {};
  const rows = tasks.slice(0, 500).map((task) => {
    const byRun = task?.runId ? recordMap[task.runId] : null;
    const byNode = task?.nodeId ? recordMap[task.nodeId] : null;
    return taskRow(task || {}, byRun || byNode || null, { includeImported });
  });
  // Issue #96: the ladder verdict carries only energies, so the report looks
  // up the row and the run record by node id to recover the level of theory
  // and the SCF energy the correlation extrapolation needs.
  const rowByNodeId = new Map(rows.map((row) => [row.nodeId, row]));
  const recordByNodeId = new Map();
  for (const task of tasks) {
    const record = (task?.runId ? recordMap[task.runId] : null) || (task?.nodeId ? recordMap[task.nodeId] : null);
    if (task?.nodeId && record) recordByNodeId.set(task.nodeId, record);
  }
  const conformerTaskByNodeId = new Map(
    tasks.filter((task) => task?.type === 'conformers' && task?.nodeId).map((task) => [task.nodeId, task]),
  );

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
        imported: row.imported ? row.imported.badge : null,
        energyHartree: row.finalEnergyHartree,
        relativeKcalSearch: row.conformer.relativeKcal,
        // The Boltzmann weight the conformer search assigned. It is shown in
        // the report because a weighted value without its population table is
        // a number with the evidence removed.
        population: row.conformer.population,
        gapEv: row.gapEv,
        gibbsHartree: row.gibbsHartree,
        relativeKcalTarget: lowest !== null && Number.isFinite(row.finalEnergyHartree)
          ? (row.finalEnergyHartree - lowest) * HARTREE_KCAL
          : null,
      }));
      const temperatureK = num(conformerTaskByNodeId.get(id)?.conformers?.temperature);
      let ensemble;
      if (!comparable) {
        ensemble = {
          available: false,
          reason: 'this block fed more than one task per member (or several levels), so its rows are not one retained ensemble',
        };
      } else if (members.some((member) => member.imported)) {
        // Issue #131: a Boltzmann average over a member this app did not
        // compute would be a number built from two different provenances.
        ensemble = {
          available: false,
          reason: `a member of this group is an imported result (${IMPORTED_BADGE_TEXT}), so the rows are not one retained ensemble and are not weighted`,
        };
      } else if (members.some((member) => !Number.isFinite(member.population))) {
        ensemble = {
          available: false,
          reason: 'a member has no Boltzmann population, so the rows were not one retained ensemble',
        };
      } else if (members.some((member) => !Number.isFinite(member.energyHartree))) {
        ensemble = {
          available: false,
          reason: 'a member has no final energy at the target level, so the retained ensemble is incomplete and is not weighted',
        };
      } else if (temperatureK === null) {
        ensemble = {
          available: false,
          reason: 'the conformer search temperature is not in the queue record, so the populations cannot be labelled',
        };
      } else {
        ensemble = boltzmannWeightedObservables(
          members.map((member) => ({
            id: member.memberId || member.nodeId,
            population: member.population,
            values: { energyHartree: member.energyHartree, gibbsHartree: member.gibbsHartree, gapEv: member.gapEv },
          })),
          { temperature: temperatureK, observables: ['energyHartree', 'gibbsHartree', 'gapEv'] },
        );
        if (ensemble.available) {
          const energySpread = ensemble.observables.find((entry) => entry.key === 'energyHartree')?.spread;
          ensemble = {
            ...ensemble,
            spreadKcal: Number.isFinite(energySpread) ? energySpread * HARTREE_KCAL : null,
          };
        }
      }
      return {
        id,
        title: group[0].conformer.title || id,
        comparable,
        members,
        ensemble,
        spreadKcalTarget: lowest !== null ? (Math.max(...energies) - lowest) * HARTREE_KCAL : null,
        // Issue #132: the study id the block carries, if the user set one. It
        // groups headings in the report and never changes a number: each
        // ensemble keeps its own table, its own ΔE and its own members.
        group: text(conformerTaskByNodeId.get(id)?.conformers?.group) || null,
        // What a reader needs to read one ensemble on its own terms: the
        // protomer labels its members carry and the level the target-level
        // energies were run at. Absent values stay absent, never invented.
        protomerLabels: [...new Set(group.map((row) => text(row.conformer.protomer)).filter(Boolean))],
        levels: [...new Set(group
          .map((row) => (row.method ? (row.basis ? `${row.method}/${row.basis}` : row.method) : row.basis))
          .filter(Boolean))],
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
    // A record that holds an imported result is never given a ΔE: the reader
    // would be invited to subtract a number this app did not compute.
    if (baseline && !record.imported && Number.isFinite(record.finalEnergyHartree)) {
      record.relativeKcal = (record.finalEnergyHartree - baseline.finalEnergyHartree) * HARTREE_KCAL;
    }
  }

  const flowId = text(source.flowId) || text(tasks.find((task) => task?.flowId)?.flowId) || 'main';
  const flowTitle = text(source.flowTitle) || text(source.flow?.title) || text(source.projectName) || flowId;

  // Figures are built here, from the records, so the document is regenerable:
  // nothing is screenshotted and nothing is read from live state.
  const figures = buildFigures({
    queue: source,
    tasks,
    rows,
    recordMap,
    figureLevel,
    volumes,
    surfaces,
    budgetBytes: figureBudgetBytes,
  });

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
    figures,
    // One entry per dataset record (empty for a v1 single-run queue), with the
    // comparison numbers a reader needs between records.
    records: recordModels,
    // Issue #131: one entry per result another program computed, kept out of
    // the computed series and labelled with the program and version that made
    // it. `included` says whether its number was allowed into the energy
    // columns; the entry is listed either way so it cannot go missing.
    imported: rows.filter((row) => row.imported).map((row) => ({
      nodeId: row.nodeId,
      title: row.title,
      ...row.imported,
    })),
    // Issue 175: one entry per compute block, with the expression it evaluated,
    // the upstream values it read and — when a field was missing — the refusal
    // that names the field. A derived value is not a calculation result, so it
    // is never put in an energy column; it is reported in its own section.
    derived: tasks
      .filter((task) => task?.compute && typeof task.compute === 'object')
      .map((task) => derivedModel(task)),
    // One entry per conformer block whose branches were fanned out, with the
    // target-level ΔE the run energies actually support.
    conformers,
    // One entry per method ladder, with the per-rung energies that produced the
    // verdict. Absent ladders are omitted rather than reported as passed.
    // Issue #96: each entry also carries the level of theory and SCF energy, so
    // a basis-set pair can be extrapolated; a ladder that is not such a pair
    // keeps `cbs.available === false` with the missing input named.
    ladders: Object.entries(source.ladders && typeof source.ladders === 'object' ? source.ladders : {})
      .map(([id, ladder]) => {
        const entries = (Array.isArray(ladder?.entries) ? ladder.entries : []).map((entry) => {
          const row = rowByNodeId.get(entry?.id);
          const record = recordByNodeId.get(entry?.id);
          return {
            id: text(entry?.id),
            label: text(entry?.label),
            energyHartree: Number.isFinite(entry?.energyHartree) ? entry.energyHartree : null,
            relativeKcalPerMol: Number.isFinite(entry?.relativeKcalPerMol) ? entry.relativeKcalPerMol : null,
            method: row?.method ?? null,
            basis: row?.basis ?? null,
            scfEnergyHartree: num(record?.parsed?.scf?.energyHartree),
          };
        });
        return {
          id,
          status: text(ladder?.status) || 'unknown',
          toleranceKcal: Number.isFinite(ladder?.toleranceKcal) ? ladder.toleranceKcal : null,
          spreadKcal: Number.isFinite(ladder?.spreadKcal) ? ladder.spreadKcal : null,
          reason: text(ladder?.reason),
          entries,
          cbs: cbsExtrapolate(entries),
        };
      }),
    // Issue 186: one entry per spin-state sweep, with each state's own queue
    // status so a state that failed is reported by name instead of vanishing.
    // `expected` is the number of member tasks the plan queued for this block.
    spins: Object.entries(source.spins && typeof source.spins === 'object' ? source.spins : {})
      .map(([id, sweep]) => {
        const members = tasks.filter((task) => task?.spin?.id === id);
        const rows = (Array.isArray(sweep?.rows) ? sweep.rows : []).map((row) => {
          const nodeId = text(row?.nodeId);
          const taskRow = nodeId ? rowByNodeId.get(nodeId) : null;
          return {
            nodeId,
            multiplicity: Number.isInteger(row?.multiplicity) ? row.multiplicity : null,
            energyHartree: Number.isFinite(row?.energyHartree) ? row.energyHartree : null,
            relativeKcalPerMol: Number.isFinite(row?.relativeKcalPerMol) ? row.relativeKcalPerMol : null,
            spinSquared: Number.isFinite(row?.spinSquared) ? row.spinSquared : null,
            status: taskRow?.status || null,
            error: taskRow?.error || null,
            method: taskRow?.method || null,
            basis: taskRow?.basis || null,
          };
        });
        const levelRow = rows.find((row) => row.method || row.basis) || null;
        return {
          id,
          available: sweep?.available === true,
          groundMultiplicity: Number.isInteger(sweep?.groundMultiplicity) ? sweep.groundMultiplicity : null,
          degenerate: sweep?.degenerate === true,
          expected: members.length > 0 ? members.length : null,
          level: levelRow ? { method: levelRow.method, basis: levelRow.basis } : null,
          rows,
        };
      }),
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
    return '<tr data-node="' + escapeHtml(row.nodeId || '') + '" data-status="' + escapeHtml(row.status) + '"'
      + (row.imported ? ' data-kind="imported"' : '') + '>'
      + `<td><strong>${escapeHtml(row.title)}</strong>${member}${fixture}`
      + `${row.imported ? ` <span class="imported" data-field="imported-badge">${escapeHtml(row.imported.badge)}</span>` : ''}`
      + `<div class="sub">`
      + `${escapeHtml(level)}${escapeHtml(kindSuffix)}</div></td>`
      + `<td>${escapeHtml(row.status)}</td>`
      + `<td class="gates-${gateClass}">${escapeHtml(gates)}</td>`
      + `<td>${escapeHtml(row.validity === null ? MISSING : row.validity)}</td>`
      + `<td>${escapeHtml(row.engine === null ? MISSING : row.engine)}</td>`
      + `<td>${escapeHtml(row.method === null ? MISSING : row.method)} / ${escapeHtml(row.basis === null ? MISSING : row.basis)}</td>`
      + `<td class="num">${row.imported
        ? (row.finalEnergyHartree === null
          ? escapeHtml(`${MISSING} (imported)`)
          : `${escapeHtml(value(row.finalEnergyHartree, 8))} <span class="imported">${escapeHtml(row.imported.badge)}</span>`)
        : escapeHtml(value(row.finalEnergyHartree, 8))}</td>`
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
    return '<tr data-record="' + escapeHtml(record.id) + '"'
      + (record.imported ? ' data-kind="imported"' : '') + '>'
      + `<td><a href="#record-${escapeHtml(flowAnchor)}-${escapeHtml(anchorId(record.id))}"><strong>${escapeHtml(record.label || record.id)}</strong></a>`
      + `${record.imported ? ` <span class="imported">${escapeHtml(record.imported.badge)}</span>` : ''}`
      + `<div class="sub mono">${escapeHtml(record.id)}`
      + `${record.charge === null ? '' : ` · charge ${escapeHtml(String(record.charge))}`}`
      + `${record.multiplicity === null ? '' : ` · multiplicity ${escapeHtml(String(record.multiplicity))}`}</div></td>`
      + `<td class="${statusClass}">${escapeHtml(record.status)}</td>`
      + `<td class="gates-${gateClass}">${escapeHtml(record.gates)}</td>`
      + `<td class="num">${escapeHtml(value(record.finalEnergyHartree, 8))}</td>`
      + `<td class="num">${record.imported && record.relativeKcal === null
        ? 'not compared'
        : escapeHtml(value(record.relativeKcal, 2))}</td>`
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
    + (record.imported
      ? `<p class="warn" data-field="record-imported"><span class="imported">${escapeHtml(record.imported.badge)}</span>`
        + ` This record includes a result computed by another program. ${escapeHtml(record.relativeKcalReason || '')}</p>`
      : '')
    + failed
    + taskTableHtml(rows);
}

const REPORT_STYLE = 'body{font:13px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:32px auto;max-width:1100px;padding:0 20px;color:#16181d;background:#fff}'
  + 'h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px;border-bottom:1px solid #e3e6eb;padding-bottom:4px}'
  + 'h3{font-size:14px;margin:26px 0 8px;border-bottom:1px solid #e3e6eb;padding-bottom:4px}'
  + 'h4{font-size:13px;margin:20px 0 6px;color:#2b3038}'
  + '.meta{color:#5b6472;font-size:12px}.sub{color:#6b7480;font-size:11px;font-weight:400}'
  + '.fig{margin:14px 0 20px}.fig svg{width:100%;max-width:560px;height:auto;display:block}'
  + '.fig figcaption{font-size:10.5px;color:#5b6373;margin-top:3px;max-width:560px}'
  + '.fig-missing{font-size:11px;color:#7a5b00}'
  + 'table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:6px 8px;border-bottom:1px solid #eceef2;text-align:left;vertical-align:top}'
  + 'th{background:#f7f8fa;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#5b6472}'
  + '.num{text-align:right;font-variant-numeric:tabular-nums}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}'
  + '.gates-pass{color:#137a3a;font-weight:600}.gates-fail{color:#b42318;font-weight:600}.warn-text{color:#7a5b00;font-weight:600}'
  + '.spin-lowest td{font-weight:600}'
  + '.fixture{background:#fff3cd;color:#7a5b00;border-radius:3px;padding:0 4px;font-size:10px;font-weight:600}'
  + '.imported{background:#e8eefc;color:#243b6b;border:1px solid #c3d2f0;border-radius:3px;padding:0 4px;font-size:10px;font-weight:600;white-space:nowrap}'
  + '.warn{background:#fff8e6;border-left:3px solid #e0a800;padding:8px 10px}'
  + '.ok{color:#137a3a}.failures{color:#b42318}'
  + 'pre{white-space:pre-wrap;font-size:11px;background:#f7f8fa;padding:10px;border-radius:4px}'
  + 'details{margin:6px 0}summary{cursor:pointer;font-size:12px}'
  + '.flow-section{margin-top:36px;border-top:2px solid #e3e6eb;padding-top:8px}'
  + 'footer{margin-top:32px;color:#6b7480;font-size:11px;border-top:1px solid #e3e6eb;padding-top:8px}';

const REPORT_FOOTER = 'Generated by NodeChem Studio from the queue record and the per-run run.json files. '
  + 'A value a run did not report is shown as “not reported”; nothing is inferred. '
  + 'This document contains no scripts and makes no network requests.';

/** One ensemble subsection: heading, its own terms, its own table (#80/#96/#132). */
function conformerEnsembleHtml(ensemble, headingTag) {
  const body = ensemble.members.map((member) => '<tr'
    + (member.imported ? ' data-kind="imported"' : '') + '>'
    + `<td>${escapeHtml(member.memberId || MISSING)}${member.protomer ? ` · ${escapeHtml(member.protomer)}` : ''}`
    + `${member.imported ? ` <span class="imported">${escapeHtml(member.imported)}</span>` : ''}</td>`
    + `<td>${escapeHtml(member.status || MISSING)}</td>`
    + `<td class="num">${escapeHtml(Number.isFinite(member.population) ? formatPopulation(member.population) : MISSING)}</td>`
    + `<td class="num">${escapeHtml(value(member.energyHartree, 8))}</td>`
    + `<td class="num">${escapeHtml(value(member.relativeKcalSearch, 2))}</td>`
    + `<td class="num">${escapeHtml(value(member.relativeKcalTarget, 2))}</td>`
    + '</tr>').join('');
  const averaged = ensemble.ensemble;
  let averagedHtml;
  if (averaged?.available) {
    const rows = averaged.observables.map((observable) => '<tr>'
      + `<td>${escapeHtml(observable.label)}</td>`
      + `<td class="num" data-field="ensemble-value">${escapeHtml(observable.formattedWeightedMean)} ${escapeHtml(observable.unit)}</td>`
      + `<td class="num" data-field="ensemble-spread">spread ${escapeHtml(observable.formattedSpread)} ${escapeHtml(observable.unit)} over ${escapeHtml(observable.over)} `
      + `(weighted SD ${escapeHtml(value(observable.weightedStdDev, observable.unit === 'eV' ? 3 : 8))} ${escapeHtml(observable.unit)})</td>`
      + `<td class="num" data-field="ensemble-unweighted">${escapeHtml(observable.formattedUnweightedMean)} ${escapeHtml(observable.unit)}</td>`
      + '</tr>').join('');
    averagedHtml = '<p class="ensemble" data-field="ensemble-label">'
      + `<strong>${escapeHtml(averaged.label)}</strong> at ${escapeHtml(String(averaged.temperatureK))} K over `
      + `${escapeHtml(String(averaged.memberCount))} retained conformers. ${escapeHtml(averaged.convergence)}</p>`
      + '<table class="ensemble-averages" data-field="ensemble-observables"><thead><tr>'
      + '<th>Observable</th><th class="num">Ensemble-averaged</th><th class="num">Spread</th>'
      + `<th class="num">Unweighted${averaged.unweightedFallback ? ' (not converged)' : ''}</th></tr></thead>`
      + `<tbody>${rows}</tbody></table>`;
  } else {
    averagedHtml = `<p class="warn" data-field="ensemble-label">not ensemble-averaged: ${escapeHtml(averaged?.reason || 'the ensemble summary is missing')}</p>`;
  }
  // Issue #132: one ensemble on its own terms — its protomer label(s), the unit
  // of the target-level column and the level those runs were made at. This line
  // exists so a grouped ensemble is never read through its neighbour's numbers.
  const labels = Array.isArray(ensemble.protomerLabels) ? ensemble.protomerLabels.filter(Boolean) : [];
  const protomerText = labels.length === 0
    ? 'Protomer label: not recorded'
    : `${labels.length === 1 ? 'Protomer label' : 'Protomer labels'}: ${labels.join(', ')}`;
  const levels = Array.isArray(ensemble.levels) ? ensemble.levels.filter(Boolean) : [];
  const levelText = levels.length === 0 ? 'level not reported' : `level ${levels.join(' / ')}`;
  return `<${headingTag}>Conformer ensemble at the target level — ${escapeHtml(ensemble.title || ensemble.id)}</${headingTag}>`
    + `<p class="meta" data-field="conformer-terms">${escapeHtml(protomerText)}`
    + ' · target E in Hartree · search ΔE in kcal/mol'
    + ` · ${escapeHtml(levelText)}</p>`
    + (ensemble.comparable
      ? `<p>Spread at the target level: <strong>${escapeHtml(value(ensemble.spreadKcalTarget, 2))} kcal/mol</strong>.`
        + ' ΔE is recomputed from the runs\' final energies; the search-level ΔE is shown for comparison only.</p>'
      : '<p class="warn">Not compared: this block fed more than one task per member (or several levels), so a single target-level ΔE would mix different calculations. The rows are listed without one.</p>')
    + averagedHtml
    + '<table><thead><tr><th>Member</th><th>Status</th><th class="num">Population</th><th class="num">E / Eh</th>'
    + '<th class="num">ΔE search / kcal mol⁻¹</th><th class="num">ΔE target / kcal mol⁻¹</th></tr></thead>'
    + `<tbody>${body}</tbody></table>`;
}

/**
 * Issue #132: ensembles that share a group id get one heading that names the
 * study, and each ensemble stays its own subsection underneath it. The heading
 * says what the group is and what it is not, because a shared id would
 * otherwise read as a chemical claim or an invitation to compare.
 */
function conformerGroupHtml(groupId, entries, headingTag) {
  const inner = headingTag === 'h2' ? 'h3' : 'h4';
  const count = entries.length;
  return `<${headingTag} data-field="conformer-group">Conformer ensembles — group “${escapeHtml(groupId)}”</${headingTag}>`
    + `<p class="meta">${escapeHtml(String(count))} block${count === 1 ? '' : 's'} in this flow share the group id `
    + `“${escapeHtml(groupId)}”, set by hand: they belong to the same study. A group is not a protomer or tautomer `
    + 'judgement, and energies across protonation states are not comparable without a proton reference. '
    + 'Each ensemble below is reported separately; nothing is averaged across the group.</p>'
    + entries.map((ensemble) => conformerEnsembleHtml(ensemble, inner)).join('');
}

/**
 * The conformer part of the report body: an ungrouped ensemble keeps its own
 * section, and a group is rendered once at the position of its first block.
 */
function conformerBlocksHtml(entries, headingTag) {
  const done = new Set();
  return entries.map((ensemble) => {
    if (!ensemble.group) return conformerEnsembleHtml(ensemble, headingTag);
    if (done.has(ensemble.group)) return '';
    done.add(ensemble.group);
    return conformerGroupHtml(
      ensemble.group,
      entries.filter((entry) => entry.group === ensemble.group),
      headingTag,
    );
  }).join('');
}

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
  // including rungs that ran without a parsed energy (shown, not omitted). A
  // CBS estimate is printed only when the ladder was a usable basis pair; a
  // refusal names the input that was missing.
  const ladderBlocks = (Array.isArray(model.ladders) ? model.ladders : []).map((ladder) => {
    const showLevel = ladder.entries.some((entry) => entry.method || entry.basis);
    const rowsHtml = ladder.entries.map((entry) => '<tr>'
      + `<td>${escapeHtml(entry.label || entry.id || MISSING)}</td>`
      + (showLevel ? `<td>${escapeHtml(entry.method || MISSING)}</td><td>${escapeHtml(entry.basis || MISSING)}</td>` : '')
      + `<td class="num">${escapeHtml(value(entry.energyHartree, 8))}</td>`
      + `<td class="num">${escapeHtml(value(entry.relativeKcalPerMol, 2))}</td>`
      + '</tr>').join('');
    const statusClass = ladder.status === 'pass' ? 'gates-pass' : ladder.status === 'fail' ? 'gates-fail' : '';
    const cbs = ladder.cbs;
    let cbsHtml;
    if (cbs?.available) {
      const spreadText = cbs.spread
        ? `Ladder spread ${value(cbs.spread.kcal, 2)} kcal/mol over ${cbs.spread.over}.`
        : '';
      cbsHtml = '<p class="cbs" data-field="ladder-cbs">'
        + `<strong>CBS estimate: ${escapeHtml(value(cbs.energyHartree, 8))} Eh</strong> — ${escapeHtml(cbs.form)}. `
        + `Pair ${escapeHtml(cbs.pair.lower.basis)} → ${escapeHtml(cbs.pair.upper.basis)} `
        + `(X = ${escapeHtml(String(cbs.pair.lower.x))} → ${escapeHtml(String(cbs.pair.upper.x))}); `
        + `SCF ${escapeHtml(cbs.scfSource)}. `
        + `<span class="warn-text">${escapeHtml(spreadText)}</span></p>`;
    } else {
      cbsHtml = `<p class="warn" data-field="ladder-cbs">CBS not reported: ${escapeHtml(cbs?.reason || 'the ladder record carries no extrapolation input')}</p>`;
    }
    return `<${sectionHeading}>Method ladder — ${escapeHtml(ladder.id)}</${sectionHeading}>`
      + `<p class="${statusClass}">${escapeHtml(ladder.status)} · spread `
      + `${escapeHtml(value(ladder.spreadKcal, 2))} kcal/mol against a tolerance of `
      + `${escapeHtml(value(ladder.toleranceKcal, 2))} kcal/mol. ${escapeHtml(ladder.reason || '')}</p>`
      + cbsHtml
      + '<table><thead><tr><th>Rung</th>'
      + (showLevel ? '<th>Method</th><th>Basis</th>' : '')
      + '<th class="num">E / Eh</th><th class="num">ΔE / kcal mol⁻¹</th></tr></thead>'
      + `<tbody>${rowsHtml}</tbody></table>`;
  }).join('');

  // Spin-state sweeps (issue 186): one table per swept block. The lowest row is
  // the lowest energy that was actually computed — never called a molecular
  // ground state, because the sweep is a set of runs on one geometry. A state
  // that failed keeps its row, with its queue status and no invented energy.
  const spinBlocks = (Array.isArray(model.spins) ? model.spins : []).map((sweep) => {
    const lowest = sweep.groundMultiplicity;
    const rows = Array.isArray(sweep.rows) ? sweep.rows : [];
    const labels = rows.map((row) => (row.multiplicity === null ? MISSING : `m${row.multiplicity}`));
    const missing = rows.filter((row) => row.energyHartree === null);
    // `available` is the queue's flag, but a record written before it existed
    // still has a ground multiplicity only when an energy was actually ranked.
    const ranked = lowest !== null && missing.length < rows.length;
    const level = [sweep.level?.method, sweep.level?.basis].filter(Boolean).join('/');
    const summary = `<p>${escapeHtml(String(rows.length))} state${rows.length === 1 ? '' : 's'} compared`
      + `${labels.length ? ` (${escapeHtml(labels.join(', '))})` : ''}, all on the <strong>same starting geometry</strong>`
      + `${level ? ` at ${escapeHtml(level)}` : ''}. `
      + (ranked
        ? `<strong>Lowest computed: m${escapeHtml(String(lowest))}.</strong> `
        : '<strong>No state reported a final energy, so nothing is ranked.</strong> ')
      + 'This is a single-geometry comparison: the states were not separately relaxed, and a multiplicity that '
      + 'did not run, a different geometry or a different level of theory is outside what was computed.</p>'
      + (sweep.degenerate
        ? '<p class="warn">Two or more states reported the same energy: the order is a tie and no state was picked as the lowest.</p>'
        : '');
    const body = rows.map((row) => {
      const isLowest = lowest !== null && row.energyHartree !== null && row.multiplicity === lowest;
      const state = row.energyHartree === null
        ? (row.status || 'no energy')
        : (isLowest ? 'lowest computed' : (row.status || 'reported'));
      return '<tr' + (isLowest ? ' class="spin-lowest"' : '') + '>'
        + `<td>${escapeHtml(row.multiplicity === null ? MISSING : `m${row.multiplicity}`)}</td>`
        + `<td>${escapeHtml(state)}</td>`
        + `<td class="num">${escapeHtml(value(row.energyHartree, 8))}</td>`
        + `<td class="num">${escapeHtml(value(row.relativeKcalPerMol, 2))}</td>`
        + `<td class="num">${row.spinSquared === null ? 'not reported' : escapeHtml(row.spinSquared.toFixed(4))}</td>`
        + '</tr>';
    }).join('');
    const missingHtml = missing.length
      ? `<p class="warn" data-field="spin-missing">Not ranked: ${escapeHtml(missing
        .map((row) => {
          const label = row.multiplicity === null ? 'a state' : `m${row.multiplicity}`;
          const status = row.status || 'no energy reported';
          return `${label} ${status}${row.error ? ` — ${row.error}` : ''}`;
        })
        .join('; '))}. The state is a row of this sweep; no energy is inferred for it.</p>`
      : '';
    const shortfall = sweep.expected !== null && sweep.expected !== undefined && rows.length < sweep.expected
      ? `<p class="warn" data-field="spin-count">${rows.length} of ${sweep.expected} planned states reached the comparison; `
        + 'the lowest is the lowest of those.</p>'
      : '';
    return `<${sectionHeading}>Spin-state sweep — ${escapeHtml(sweep.id)}</${sectionHeading}>`
      + summary
      + shortfall
      + '<table><thead><tr><th>Multiplicity</th><th>State</th><th class="num">E / Eh</th>'
      + '<th class="num">ΔE / kcal mol⁻¹</th><th class="num">⟨S²⟩</th></tr></thead>'
      + `<tbody>${body}</tbody></table>`
      + missingHtml;
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
  // Issue #96: the retained Boltzmann populations are shown, and the
  // population-weighted observables appear beside their spread. A group that
  // was not one retained ensemble is never weighted.
  // Issue #132: blocks sharing a group id are rendered under one heading that
  // names the study; each ensemble keeps its own subsection and its own numbers.
  const conformerBlocks = conformerBlocksHtml(
    Array.isArray(model.conformers) ? model.conformers : [],
    sectionHeading,
  );

  const fixtureNote = model.fixtures > 0
    ? `<p class="warn">${model.fixtures} task${model.fixtures === 1 ? '' : 's'} ran as a labelled fixture (dry run). Fixture numbers are test data, not calculations.</p>`
    : '';

  // Issue 175: derived quantities have their own section — never an energy
  // column. Each block names its expression, the upstream values it read, and
  // the methods sentence that says what kind of number this is.
  const derivedBlocks = (Array.isArray(model.derived) ? model.derived : []).map((entry) => {
    const heading = `<${sectionHeading}>Derived quantity — ${escapeHtml(entry.title || entry.nodeId || MISSING)}</${sectionHeading}>`;
    const headline = entry.value === null
      ? `<p class="warn" data-field="derived-refusal">${escapeHtml(entry.notComputed || 'not computed')}</p>`
      : `<p class="cbs" data-field="derived-value"><strong>${escapeHtml(entry.expression || MISSING)} = `
        + `${escapeHtml(value(entry.value, 9))}${entry.unit ? ` ${escapeHtml(entry.unit)}` : ''}</strong>`
        + ' — derived quantity, not a computed QM result.</p>';
    const rows = entry.inputs.map((input) => '<tr data-field="derived-input">'
      + `<td>${escapeHtml(input.recordId ?? MISSING)}</td>`
      + `<td class="mono">${escapeHtml(input.field ?? MISSING)}</td>`
      + `<td class="num">${escapeHtml(value(input.value, 9))}</td>`
      + `<td>${escapeHtml(input.unit ?? '—')}</td></tr>`).join('');
    const table = entry.inputs.length
      ? '<table><thead><tr><th>Record</th><th>Field</th><th class="num">Value</th><th>Unit</th></tr></thead>'
        + `<tbody>${rows}</tbody></table>`
      : '';
    return heading + headline + table
      + `<p class="meta" data-field="derived-methods">${escapeHtml(entry.paragraph || MISSING)}</p>`;
  }).join('');

  // Issue #131: results another program computed. They are named here whether
  // or not their number was allowed into an energy column, with the program,
  // version and source hash, so a reader can see what is imported and what is
  // not. The hash identifies the file; it does not certify the calculation.
  const importedResults = Array.isArray(model.imported) ? model.imported : [];
  const importedBlocks = importedResults.length === 0 ? '' : (
    `<${sectionHeading}>Imported results</${sectionHeading}>`
    + '<p>These numbers were computed by another program, not by this app. '
    + `${escapeHtml(IMPORTED_BADGE_TEXT)}. An imported number is never part of a computed series`
    + `${importedResults.some((entry) => entry.included) ? '; where its value is shown below, it is labelled.' : ', and none of them is shown in an energy column here.'}</p>`
    + '<table><thead><tr><th>Block</th><th>Program</th><th>Level</th><th class="num">E / Eh</th>'
    + '<th>Source file</th><th>Source SHA-256</th><th class="num">Energy column</th></tr></thead><tbody>'
    + importedResults.map((entry) => '<tr data-field="imported-result" data-node="' + escapeHtml(entry.nodeId || '') + '">'
      + `<td><strong>${escapeHtml(entry.title || entry.nodeId || MISSING)}</strong>`
      + ` <span class="imported" data-field="imported-badge">${escapeHtml(entry.badge)}</span></td>`
      + `<td>${escapeHtml(entry.program || MISSING)}</td>`
      + `<td>${escapeHtml(entry.method || MISSING)} / ${escapeHtml(entry.basis || MISSING)}</td>`
      + `<td class="num">${escapeHtml(value(entry.energyHartree, 8))}</td>`
      + `<td class="mono">${escapeHtml(entry.sourceName ?? MISSING)}</td>`
      + `<td class="mono">${escapeHtml(shortHash(entry.sourceSha256) ?? MISSING)}</td>`
      + `<td class="num">${entry.included ? 'shown, labelled' : 'not included'}</td>`
      + '</tr>').join('')
    + '</tbody></table>'
    + '<p class="meta">The source hash proves which file the number was read from; it does not prove the calculation. '
    + `To show an imported energy in the energy columns, rebuild the report with <code>includeImported: true</code>; it still carries the label.</p>`
  );
  const importedNote = importedResults.length === 0 ? '' : (
    `<p class="warn" data-field="imported-note">${importedResults.length} result${importedResults.length === 1 ? '' : 's'} `
    + `in this report ${importedResults.length === 1 ? 'was' : 'were'} imported from another program `
    + `(${escapeHtml([...new Set(importedResults.map((entry) => `${entry.program ?? MISSING} ${entry.version ?? ''}`.trim()))].join(', '))}). `
    + `${escapeHtml(IMPORTED_BADGE_TEXT)}: those numbers were not computed by NodeChem Studio.</p>`
  );

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

  // A combined report stacks several flow sections under one project heading,
  // so each section has to name its flow; a single-flow report keeps the
  // project name it always had.
  const headingTitle = text(model.headingTitle)
    || `Workflow report — ${q.projectName || q.id || 'queue'}`;
  return `<${topHeading}>${escapeHtml(headingTitle)}</${topHeading}>`
    + `<p class="meta">Queue ${escapeHtml(q.id || MISSING)} · status ${escapeHtml(q.status || MISSING)}`
    + ` · created ${escapeHtml(q.createdAt || MISSING)} · finished ${escapeHtml(q.finishedAt || MISSING)}`
    + ` · generated ${escapeHtml(model.generatedAt || MISSING)}`
    + ` · NodeChem Studio ${escapeHtml(model.appVersion || MISSING)}</p>`
    + fixtureNote
    + importedNote
    + figuresHtml(model.figures, rows, sectionHeading)
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
    + derivedBlocks
    + importedBlocks
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
    const flowTitle = text(model.flow?.title);
    const titled = flowTitle
      ? { ...model, headingTitle: `${flowTitle} — workflow report` }
      : model;
    return `<section class="flow-section" id="flow-${escapeHtml(flowId)}">`
      + reportContentHtml(titled, { level: 2 })
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
