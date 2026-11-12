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
import { tautomerSpread } from './tautomers.js';
import { dp4Verdict } from './dp4.js';
import { IMPORTED_BADGE_TEXT, importedSummary } from './importedRecord.js';
import { contentHash } from './figures/primitives.js';
import { flowGraphFigure } from './figures/dag.js';
import { taskFigures } from './figures/report.js';
import { nciFigure } from './figures/nci.js';
import { DESCRIPTORS, DESCRIPTOR_SET_ID } from './chemDescriptors.js';
import { depictFigureBlock } from './chemDepict.js';
import { nciAnalysis } from './nci.js';
import { bcpTable, bcpTableHtml, qtaimAnalysis } from './qtaim.js';
import { shiftFor } from './nmrReferences.js';
import { STANDARD_STATE_TEMPERATURE_K } from './thermochemistry.js';
import {
  NOT_MEASURED,
  UNCERTAINTY_NOTE,
  conformerUncertainty,
  eyringFactorPerKcal,
  methodSpread,
  rateUncertainty,
  whatWouldChange,
} from './uncertainty.js';

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
        // Issue #226: a tautomer branch names the candidate molecule it ran.
        ...(['tautomers', 'stereoisomers'].includes(source.produces) ? { produces: source.produces } : {}),
        ...(source.tautomer ? { tautomer: text(source.tautomer) } : {}),
        ...(source.stereoisomer ? { stereoisomer: text(source.stereoisomer) } : {}),
        ...(source.smiles ? { smiles: text(source.smiles) } : {}),
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
    // ADR 0003 §3.7: a similarity matrix, when the record carries one.
    similarity: record?.similarity && typeof record.similarity === 'object'
      ? {
        molecules: Array.isArray(record.similarity.molecules) ? record.similarity.molecules : [],
        matrix: Array.isArray(record.similarity.matrix) ? record.similarity.matrix : [],
        clusters: Array.isArray(record.similarity.clusters) ? record.similarity.clusters : [],
        mcs: record.similarity.mcs && typeof record.similarity.mcs === 'object' ? record.similarity.mcs : null,
        options: record.analyse?.options && typeof record.analyse.options === 'object' ? record.analyse.options : {},
      }
      : null,
    // ADR 0003 §3.6: what the final geometry is. Absent on every record that
    // carried no integrity gate, so no other row grows a column.
    structureIntegrity: record?.structureIntegrity && typeof record.structureIntegrity === 'object'
      ? {
        status: text(record.structureIntegrity.status),
        reason: text(record.structureIntegrity.reason),
        reasonText: text(record.structureIntegrity.reasonText),
        policy: text(record.structureIntegrity.policy) || 'warn',
        beforeFormula: text(record.structureIntegrity.before?.formula),
        afterFormula: text(record.structureIntegrity.after?.formula),
      }
      : null,
    // ADR 0003 §3.1: the versioned descriptor set a chem analyse block wrote.
    // Absent on every other record, so no other row grows a column.
    descriptors: record?.descriptors && typeof record.descriptors === 'object'
      ? {
        ...record.descriptors,
        descriptorSet: text(record.analyse?.descriptorSet) || DESCRIPTOR_SET_ID,
        identity: record.identity && typeof record.identity === 'object' ? record.identity : null,
        cache: record.analyse?.cache && typeof record.analyse.cache === 'object' ? record.analyse.cache : null,
      }
      : null,
  };
}

/**
 * ADR 0003 §3.6 — what each calculated geometry turned out to be.
 *
 * `inconclusive` prints its reason: a reader must not see a blank cell and
 * assume the structure matched.
 */
function integritySectionHtml(rows, headingTag = 'h2') {
  const entries = (Array.isArray(rows) ? rows : []).filter((row) => row.structureIntegrity);
  if (entries.length === 0) return '';
  const body = entries.map((row) => {
    const integrity = row.structureIntegrity;
    return `<tr><td>${escapeHtml(row.label || row.id)}</td>`
      + `<td>${escapeHtml(integrity.status || MISSING)}</td>`
      + `<td>${escapeHtml(integrity.beforeFormula || MISSING)}</td>`
      + `<td>${escapeHtml(integrity.afterFormula || MISSING)}</td>`
      + `<td>${escapeHtml(integrity.reasonText || integrity.reason || '')}</td></tr>`;
  }).join('');
  return `<${headingTag}>Structure integrity</${headingTag}>`
    + '<p class="sub">Perceived from the final coordinates, not measured: composition, connectivity, '
    + 'tautomer and configuration are compared separately. `inconclusive` is not a pass.</p>'
    + '<table class="integrity"><thead><tr><th>Record</th><th>Status</th><th>Before</th><th>After</th><th>Reason</th></tr></thead>'
    + `<tbody>${body}</tbody></table>`;
}

/**
 * ADR 0003 §3.7 — the similarity matrix and its clusters.
 *
 * A matrix is printed in full; a cluster list alone would hide the numbers the
 * verdict came from.
 */
function similaritySectionHtml(rows, headingTag = 'h2') {
  const entries = (Array.isArray(rows) ? rows : []).filter((row) => row.similarity);
  if (entries.length === 0) return '';
  return entries.map((row) => {
    const similarity = row.similarity;
    const molecules = similarity.molecules;
    const matrix = similarity.matrix;
    if (molecules.length < 2 || matrix.length !== molecules.length) return '';
    const head = '<tr><th>Molecule</th>'
      + molecules.map((molecule) => `<th class="num">${escapeHtml(molecule.label || molecule.id)}</th>`).join('') + '</tr>';
    const body = matrix.map((line, i) => '<tr>'
      + `<td>${escapeHtml(molecules[i]?.label || molecules[i]?.id || '')}</td>`
      + line.map((value) => `<td class="num">${escapeHtml(value, 2)}</td>`).join('')
      + '</tr>').join('');
    const clusters = similarity.clusters.map((cluster) => {
      const names = (cluster.members || []).map((index) => molecules[index]?.label || molecules[index]?.id).filter(Boolean);
      return `${cluster.id} (${names.length}): ${names.join(', ')}`;
    }).join('; ') || 'no clusters at this cutoff';
    const mcs = similarity.mcs;
    return `<${headingTag}>Similarity — ${escapeHtml(row.label || row.id)}</${headingTag}>`
      + '<p class="sub">'
      + `${escapeHtml(similarity.options?.fingerprint || 'morgan')} fingerprint`
      + `${similarity.options?.nBits ? ` · ${escapeHtml(String(similarity.options.nBits))} bits` : ''}`
      + ` · Tanimoto · clusters at ${escapeHtml(String(similarity.options?.clusterCutoff ?? '?'))}.`
      + '</p>'
      + `<table class="similarity"><thead>${head}</thead><tbody>${body}</tbody></table>`
      + `<p class="sub">Clusters: ${escapeHtml(clusters)}</p>`
      + (mcs ? `<p class="sub">Maximum common substructure: <code>${escapeHtml(mcs.smarts || 'not reported')}</code>`
        + `${mcs.timedOut ? ' (the search timed out)' : ''}</p>` : '');
  }).join('');
}

/**
 * ADR 0003 §3.4 — the 2D structure figures, when the caller supplied them.
 *
 * The SVG has already been validated where it was produced. A figure level of
 * `none` drops the section entirely, exactly as it drops every other figure.
 */
function structureFiguresHtml(structures, figureLevel = 'basic', headingTag = 'h2') {
  const entries = (Array.isArray(structures) ? structures : []).filter((entry) => entry && entry.svg);
  if (entries.length === 0 || figureLevel === 'none') return '';
  const figures = entries.map((entry) => {
    let block = '';
    try {
      block = depictFigureBlock(entry.svg, entry.caption);
    } catch {
      // A figure that cannot be validated is omitted, not embedded raw.
      block = '';
    }
    return block;
  }).filter(Boolean).join('');
  if (!figures) return '';
  return `<${headingTag}>Structures</${headingTag}>`
    + '<p class="sub">2D depictions generated by RDKit/CoordGen from the record geometry or SMILES.</p>'
    + `<div class="structures">${figures}</div>`;
}

/**
 * ADR 0003 §3.1 — one table of the curated descriptor set.
 *
 * Numbers are formatted, never re-derived: the record already carries them. A
 * missing value prints the report's `not reported` marker, so a gap cannot be
 * read as zero. The set id is printed once per row group, because a report that
 * mixes two sets must say which table produced each row.
 */
function descriptorsSectionHtml(rows, headingTag = 'h2') {
  const entries = (Array.isArray(rows) ? rows : []).filter((row) => row.descriptors);
  if (entries.length === 0) return '';
  const header = '<tr><th>Record</th><th>Set</th>'
    + DESCRIPTORS.map((definition) => `<th${definition.kind === 'text' ? '' : ' class="num"'}>${escapeHtml(definition.label)}${definition.unit ? ` / ${escapeHtml(definition.unit)}` : ''}</th>`).join('')
    + '</tr>';
  const body = entries.map((row) => {
    const values = row.descriptors;
    const cells = DESCRIPTORS.map((definition) => {
      const raw = values[definition.key];
      if (raw === null || raw === undefined || raw === '') return `<td>${escapeHtml(MISSING)}</td>`;
      const shown = definition.kind === 'text' ? String(raw) : value(raw, definition.kind === 'count' ? 0 : 3);
      return `<td${definition.kind === 'text' ? '' : ' class="num"'}>${escapeHtml(shown)}</td>`;
    }).join('');
    return `<tr><td>${escapeHtml(row.recordLabel || row.title)}</td>`
      + `<td class="mono">${escapeHtml(values.descriptorSet || DESCRIPTOR_SET_ID)}</td>${cells}</tr>`;
  }).join('');
  return `<${headingTag}>Descriptors</${headingTag}>`
    + '<p class="sub">Cheminformatics descriptors, not calculated properties: 2D/topological unless stated. '
    + `The set id is versioned, so a later addition cannot silently re-label this table.</p>`
    + `<table class="descriptors"><thead>${header}</thead><tbody>${body}</tbody></table>`;
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
 * Issue 175: one analyse task, as the report needs it.
 *
 * The paragraph is the methods text for a derived record: it states the
 * expression, every upstream value the expression read, and the fact that the
 * result is arithmetic over recorded results rather than a calculated quantity.
 * A refusal is carried verbatim so the field and record it names survive.
 */
function derivedModel(task) {
  const analyse = task.analyse;
  const inputs = (Array.isArray(analyse.inputs) ? analyse.inputs : []).map((input) => ({
    recordId: text(input?.recordId),
    field: text(input?.field),
    value: num(input?.value),
    unit: text(input?.unit),
  }));
  const model = {
    nodeId: text(task.nodeId),
    title: text(task.title) || text(task.nodeId),
    recordId: text(task.recordId),
    status: text(analyse.status) || (task.status === 'completed' ? 'computed' : 'refused'),
    expression: text(analyse.expression),
    value: num(analyse.value),
    unit: text(analyse.unit),
    inputs,
    sources: Array.isArray(analyse.sources) ? analyse.sources.map(String) : [],
    notes: (Array.isArray(analyse.notes) ? analyse.notes : []).map((note) => text(note)).filter(Boolean),
    notComputed: text(analyse.notComputed),
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
 * Issue #229: the measured uncertainty section.
 *
 * One row per method ladder, retained conformer ensemble and reaction path.
 * Every row is built by `uncertainty.js` from numbers the queue recorded: a
 * ladder's rungs, an ensemble's members, a reaction's barrier and the error
 * recorded with it. A quantity with nothing measured is a row too, carrying
 * `not measured` and its reason, so the section cannot look complete by
 * omission and never borrows a literature error bar.
 */
function buildUncertaintySection({ ladders = [], conformers = [], reactions = [] } = {}) {
  const rows = [];
  for (const ladder of Array.isArray(ladders) ? ladders : []) {
    rows.push(methodSpread(ladder.entries, {
      title: `Method ladder — ${ladder.id}`,
      toleranceKcal: ladder.toleranceKcal,
    }));
  }
  for (const conformer of Array.isArray(conformers) ? conformers : []) {
    const title = `Conformer ensemble — ${conformer.title || conformer.id}`;
    const ensemble = conformer.ensemble;
    const members = (Array.isArray(conformer.members) ? conformer.members : []).map((member) => ({
      id: member.memberId || member.nodeId,
      relativeKcal: member.relativeKcalTarget,
      population: member.population,
    }));
    if (!ensemble?.available) {
      rows.push(conformerUncertainty(members, {
        title,
        temperatureK: ensemble?.temperatureK ?? null,
        refusalReason: ensemble?.reason || 'the ensemble was not retained, so it is not weighted',
      }));
      continue;
    }
    rows.push(conformerUncertainty(members, { title, temperatureK: ensemble.temperatureK }));
  }
  for (const reaction of Array.isArray(reactions) ? reactions : []) {
    if (reaction.available !== true) continue;
    rows.push(rateUncertainty({
      barrierKcal: reaction.kcalPerMol,
      barrierErrorKcal: reaction.barrierErrorKcal,
      temperatureK: reaction.temperatureK,
      title: `Reaction path — ${reaction.nodeId}`,
      errorSource: reaction.barrierErrorSource
        || (Number.isFinite(reaction.barrierErrorKcal) ? 'recorded with the reaction path' : null),
    }));
  }
  const rateRow = rows.find((row) => row.kind === 'rate');
  const temperatureK = Number.isFinite(rateRow?.temperatureK)
    ? rateRow.temperatureK : STANDARD_STATE_TEMPERATURE_K;
  return {
    note: UNCERTAINTY_NOTE,
    temperatureK,
    perKcalFactor: eyringFactorPerKcal(temperatureK),
    rows,
    statements: whatWouldChange(rows, { temperatureK }),
    measuredCount: rows.filter((row) => row.measured).length,
    notMeasuredCount: rows.filter((row) => !row.measured).length,
  };
}

/**
 * The wavefunction half of the report (issue 59): QTAIM bond critical points and
 * the NCI figure, from a parsed checkpoint the caller supplies.
 *
 * A `run.json` carries no density, so this is the caller's data, exactly like the
 * ESP-coloured surface: `ncs report` does not attach a checkpoint yet and the
 * section is simply absent then. When it is supplied, a file without a density
 * block becomes an explicit `no density in this file` line rather than a section
 * that silently vanishes.
 */
function wavefunctionAnalysis({ wavefunction = null, figureBudgetBytes = Infinity } = {}) {
  if (!wavefunction) return null;
  const qtaim = qtaimAnalysis({ fchk: wavefunction });
  if (qtaim.ok === false) {
    return { qtaim, table: bcpTable(qtaim), nci: null, figure: null };
  }
  const table = bcpTable(qtaim);
  const nci = nciAnalysis({ fchk: wavefunction });
  const diagram = nci.ok ? nciFigure(nci) : null;
  const figure = diagram && diagram.svg.length <= figureBudgetBytes
    ? { key: 'nci', svg: diagram.svg, caption: diagram.caption, hash: contentHash(diagram.svg) }
    : null;
  return {
    qtaim,
    table,
    nci: nci.ok ? { grid: nci.grid, counts: nci.counts, parameters: nci.parameters, note: nci.note } : nci,
    figure,
    figureDropped: Boolean(diagram) && !figure,
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
  wavefunction = null,
  // ADR 0003 §3.4: SVGs already validated by the caller (main or the CLI). The
  // report never draws chemistry; it only embeds what was validated.
  structures = null,
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
    tasks.filter((task) => task?.type === 'generate' && task?.nodeId).map((task) => [task.nodeId, task]),
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
      // Issue #226: a tautomer block's rows are distinct molecules, and the
      // spread across them is the answer. It is computed from the target-level
      // energies exactly like a conformer ΔE, but it is never averaged.
      // ADR 0003 §3.5: a stereoisomer set is a candidate set too — distinct
      // molecules, never averaged across.
      const tautomers = group.some((row) => ['tautomers', 'stereoisomers'].includes(row.conformer.produces));
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
        ...(row.conformer.tautomer ? { tautomer: row.conformer.tautomer } : {}),
        ...(row.conformer.stereoisomer ? { stereoisomer: row.conformer.stereoisomer } : {}),
        ...(row.conformer.smiles ? { smiles: row.conformer.smiles } : {}),
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
      const temperatureK = num(conformerTaskByNodeId.get(id)?.generate?.temperature);
      let ensemble;
      if (tautomers) {
        // Issue #226: never averaged across tautomers. Each one is a distinct
        // molecule and a population would be an equilibrium claim this app does
        // not model; the spread at the target level is the reported number.
        ensemble = {
          available: false,
          reason: 'these rows are tautomer candidates — distinct molecules, not conformers — so they are not '
            + 'ensemble-averaged and no Boltzmann population is reported',
        };
      } else if (!comparable) {
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
        produces: group.find((row) => ['tautomers', 'stereoisomers'].includes(row.conformer.produces))?.conformer.produces || 'conformers',
        members,
        ensemble,
        spreadKcalTarget: lowest !== null ? (Math.max(...energies) - lowest) * HARTREE_KCAL : null,
        // Issue #226: the same number, named as what it is — the spread across
        // the candidate set — and refused when a candidate did not finish.
        tautomerSpread: tautomers ? tautomerSpread(members) : null,
        // Issue #132: the study id the block carries, if the user set one. It
        // groups headings in the report and never changes a number: each
        // ensemble keeps its own table, its own ΔE and its own members.
        group: text(conformerTaskByNodeId.get(id)?.generate?.group) || null,
        // What a reader needs to read one ensemble on its own terms: the
        // protomer labels its members carry and the level the target-level
        // energies were run at. Absent values stay absent, never invented.
        protomerLabels: [...new Set(group.map((row) => text(row.conformer.protomer)).filter(Boolean))],
        tautomerLabels: [...new Set(group.map((row) => text(row.conformer.tautomer)).filter(Boolean))],
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
  // Issue 59: the QTAIM table and the NCI figure, when a checkpoint is supplied.
  const analysis = wavefunctionAnalysis({ wavefunction, figureBudgetBytes });
  const structureFigures = structures && typeof structures === 'object'
    ? Object.entries(structures).slice(0, 60).flatMap(([id, entry]) => {
      if (!entry || typeof entry.svg !== 'string') return [];
      const row = rowByNodeId.get(id);
      return [{
        id,
        caption: String(entry.caption || row?.label || id).slice(0, 200),
        svg: entry.svg,
      }];
    })
    : [];

  // Issue #229: the ladder and reaction models are built before the return so
  // the uncertainty section reads exactly the numbers the sections below print.
  const ladders = Object.entries(source.ladders && typeof source.ladders === 'object' ? source.ladders : {})
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
    });
  const reactionModels = Object.entries(source.reactions && typeof source.reactions === 'object' ? source.reactions : {})
    .map(([nodeId, reaction]) => ({
      nodeId,
      available: reaction?.available === true,
      kcalPerMol: Number.isFinite(reaction?.kcalPerMol) ? reaction.kcalPerMol : null,
      scheme: text(reaction?.scheme),
      reason: text(reaction?.reason),
      transitionStateNodeId: text(reaction?.transitionStateNodeId),
      reactantNodeId: text(reaction?.reactantNodeId),
      temperatureK: Number.isFinite(reaction?.temperatureK) ? reaction.temperatureK : null,
      // Issue #229: the error recorded with the barrier, when a producer wrote
      // one. Absent stays null: the report says `not measured` rather than
      // borrowing a textbook spread.
      barrierErrorKcal: num(reaction?.barrierErrorKcal),
      barrierErrorSource: text(reaction?.barrierErrorSource),
      endpointCheck: reaction?.endpointCheck
        ? {
          status: ['pass', 'fail', 'unknown'].includes(reaction.endpointCheck.status) ? reaction.endpointCheck.status : 'unknown',
          detail: text(reaction.endpointCheck.detail),
          end: text(reaction.endpointCheck.end) || null,
          deltaKcal: Number.isFinite(reaction.endpointCheck.deltaKcal) ? reaction.endpointCheck.deltaKcal : null,
        }
        : null,
    }));
  const uncertainty = buildUncertaintySection({ ladders, conformers, reactions: reactionModels });

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
    // ADR 0003 §3.4: validated 2D depictions, already bound to a block id.
    structures: structureFigures,
    figureLevel,
    // Issue 59: the wavefunction analysis, present only when the caller supplied
    // a parsed checkpoint. `null` means "no checkpoint was attached", which is
    // the normal case — a run.json carries no density.
    analysis,
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
    // Issue 168: one entry per run that recorded an EPR block — spin
    // populations, Fermi-contact couplings, and the g-tensor refusal. Read from
    // `run.json`'s `parsed.epr`, so the report prints the numbers the run
    // recorded rather than recomputing them from a log that does not carry them.
    epr: tasks.map((task) => {
      const record = (task?.runId ? recordMap[task.runId] : null) || (task?.nodeId ? recordMap[task.nodeId] : null);
      const block = record && record.parsed && typeof record.parsed.epr === 'object' ? record.parsed.epr : null;
      if (!block) return null;
      return {
        nodeId: text(task?.nodeId),
        title: text(record.title) || text(task?.title) || text(task?.nodeId),
        epr: block,
      };
    }).filter(Boolean),
    // Issue 147: one entry per run that recorded an NMR block — the GIAO
    // shieldings and, for NMR=(GIAO,SpinSpin), the printed coupling tables. Read
    // from `run.json`'s `parsed.nmr` so the report prints what the run recorded
    // rather than recomputing a log it does not carry. `nmr.reference` is the
    // reference the run recorded, if any: no shift is printed without one.
    nmr: tasks.map((task) => {
      const record = (task?.runId ? recordMap[task.runId] : null) || (task?.nodeId ? recordMap[task.nodeId] : null);
      const block = record && record.parsed && typeof record.parsed.nmr === 'object'
        && record.parsed.nmr !== null ? record.parsed.nmr : null;
      if (!block) return null;
      return {
        nodeId: text(task?.nodeId),
        title: text(record.title) || text(task?.title) || text(task?.nodeId),
        level: record?.provenance?.method ?? null,
        program: record?.parsed?.program ?? null,
        nmr: block,
      };
    }).filter(Boolean),
    // Issue 165: one entry per DP4+ analysis a run record (or a task) carries.
    // The probabilities were computed by `dp4.js`; the report only prints them
    // with the level, the variant and the bank they came from.
    dp4: tasks.map((task) => {
      const record = (task?.runId ? recordMap[task.runId] : null) || (task?.nodeId ? recordMap[task.nodeId] : null);
      const block = (record && typeof record.dp4 === 'object' ? record.dp4 : null)
        || (task && typeof task.dp4 === 'object' ? task.dp4 : null);
      if (!block) return null;
      return {
        nodeId: text(task?.nodeId),
        title: text(record?.title) || text(task?.title) || text(task?.nodeId),
        result: block,
      };
    }).filter(Boolean),
    // Issue 175: one entry per analyse block, with the expression it evaluated,
    // the upstream values it read and — when a field was missing — the refusal
    // that names the field. A derived value is not a calculation result, so it
    // is never put in an energy column; it is reported in its own section.
    derived: tasks
      // Issue 165: a DP4+ block is an analyse block, but its result is a
      // probability table with no single value, and it is reported in its own
      // section below. Listing it here would print "derived quantity not
      // computed" over a comparison that did compute.
      // Issue #270: Multiwfn is an external sidecar result with its own section,
      // not arithmetic over fields.
      .filter((task) => task?.analyse && typeof task.analyse === 'object'
        && task.analyse.mode !== 'dp4' && task.analyse.mode !== 'multiwfn')
      .map((task) => derivedModel(task)),
    // Issue #270: one entry per Multiwfn analyse task, with the normalised
    // result and the exact provenance the run recorded.
    multiwfn: tasks.map((task) => {
      if (task?.analyse?.mode !== 'multiwfn') return null;
      const record = (task?.runId ? recordMap[task.runId] : null) || (task?.nodeId ? recordMap[task.nodeId] : null);
      return {
        nodeId: text(task.nodeId),
        title: text(record?.title) || text(task.title) || text(task.nodeId),
        status: text(task.analyse.status) || (task.status === 'completed' ? 'computed' : 'refused'),
        summary: text(task.analyse.summary),
        notComputed: text(task.analyse.notComputed),
        result: (record && typeof record.multiwfn === 'object' ? record.multiwfn : null)
          || (typeof task.analyse.multiwfn === 'object' ? task.analyse.multiwfn : null),
        provenance: (record && typeof record.provenance === 'object' ? record.provenance : null)
          || (typeof task.analyse.provenance === 'object' ? task.analyse.provenance : null),
      };
    }).filter(Boolean),
    // One entry per conformer block whose branches were fanned out, with the
    // target-level ΔE the run energies actually support.
    conformers,
    // One entry per method ladder, with the per-rung energies that produced the
    // verdict. Absent ladders are omitted rather than reported as passed.
    // Issue #96: each entry also carries the level of theory and SCF energy, so
    // a basis-set pair can be extrapolated; a ladder that is not such a pair
    // keeps `cbs.available === false` with the missing input named.
    ladders,
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
    // the correction scheme attached. Issue #229: `barrierErrorKcal` is the
    // error recorded with the path, when one was.
    reactions: reactionModels,
    // Issue #229: the measured error bar, assembled from the ladders,
    // conformer ensembles and reaction paths above. A quantity that was not
    // measured keeps a row with the reason; nothing is averaged or borrowed.
    uncertainty,
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
      + `<td>${escapeHtml(row.structureIntegrity?.status || '—')}</td>`
      + `<td class="num">${escapeHtml(value(row.elapsedSeconds, 1, ' s'))}</td>`
      + '</tr>';
  }).join('');
  return '<table><thead><tr><th>Block</th><th>Status</th><th>Gates</th><th>Validity</th><th>Engine</th>'
    + '<th>Level</th><th class="num">E / Eh</th><th class="num">G / Eh</th><th class="num">Imag.</th>'
    + '<th>Structure</th><th class="num">Elapsed</th></tr></thead><tbody>' + tableRows + '</tbody></table>';
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
  const tautomer = ensemble.produces === 'tautomers';
  const body = ensemble.members.map((member) => '<tr'
    + (member.imported ? ' data-kind="imported"' : '') + '>'
    + `<td>${escapeHtml(member.memberId || MISSING)}`
    + (member.tautomer ? ` · <span class="mono">${escapeHtml(member.tautomer)}</span>` : '')
    + (member.stereoisomer ? ` · <span class="mono">${escapeHtml(member.stereoisomer)}</span>` : '')
    + (member.protomer ? ` · ${escapeHtml(member.protomer)}` : '')
    + (member.smiles ? ` <span class="mono">${escapeHtml(member.smiles)}</span>` : '')
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
  const tautomerLabels = Array.isArray(ensemble.tautomerLabels) ? ensemble.tautomerLabels.filter(Boolean) : [];
  const protomerText = tautomer
    ? (tautomerLabels.length === 0
      ? 'Tautomer candidates: not labelled'
      : `Tautomer candidates (${tautomerLabels.length}): ${tautomerLabels.join(', ')}`)
    : (labels.length === 0
      ? 'Protomer label: not recorded'
      : `${labels.length === 1 ? 'Protomer label' : 'Protomer labels'}: ${labels.join(', ')}`);
  const levels = Array.isArray(ensemble.levels) ? ensemble.levels.filter(Boolean) : [];
  const levelText = levels.length === 0 ? 'level not reported' : `level ${levels.join(' / ')}`;
  // Issue #226: the spread across the candidate set, named as such. It is
  // computed from the runs' final energies — never from a force field and never
  // averaged — and refused, with its reason, when a candidate did not finish.
  const spread = ensemble.tautomerSpread;
  let spreadHtml;
  if (tautomer) {
    spreadHtml = spread?.available
      ? `<p data-field="tautomer-spread">Energy spread across the candidate set: `
        + `<strong>${escapeHtml(value(spread.kcal, 2))} kcal/mol</strong> over ${escapeHtml(String(spread.count))} `
        + `candidate${spread.count === 1 ? '' : 's'}, from ${escapeHtml(spread.lowestMemberId || MISSING)} `
        + `to ${escapeHtml(spread.highestMemberId || MISSING)} at the target level. Delta E is recomputed from the `
        + 'runs\' final energies; the candidates are distinct molecules and are not Boltzmann-averaged.</p>'
      : `<p class="warn" data-field="tautomer-spread">Spread across the candidate set: not reported — `
        + `${escapeHtml(spread?.reason || 'the run records are incomplete')}.</p>`;
  } else {
    spreadHtml = ensemble.comparable
      ? `<p>Spread at the target level: <strong>${escapeHtml(value(ensemble.spreadKcalTarget, 2))} kcal/mol</strong>.`
        + ' ΔE is recomputed from the runs\' final energies; the search-level ΔE is shown for comparison only.</p>'
      : '<p class="warn">Not compared: this block fed more than one task per member (or several levels), so a single target-level ΔE would mix different calculations. The rows are listed without one.</p>';
  }
  return `<${headingTag}>${tautomer ? 'Tautomer candidates at the target level' : 'Conformer ensemble at the target level'} — ${escapeHtml(ensemble.title || ensemble.id)}</${headingTag}>`
    + `<p class="meta" data-field="conformer-terms">${escapeHtml(protomerText)}`
    + (tautomer
      ? ' · target E in Hartree · search ΔE not applicable (no energy at generation)'
      : ' · target E in Hartree · search ΔE in kcal/mol')
    + ` · ${escapeHtml(levelText)}</p>`
    + spreadHtml
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
 * Issue #229: the measured uncertainty section.
 *
 * The table is one row per method ladder, retained conformer ensemble and
 * reaction path; the list below it is the explicit "what would change the
 * conclusion" sentence for each. A row that was not measured prints
 * `not measured` and the reason instead of a number, so the section cannot be
 * read as a complete error budget when part of it never ran.
 */
function uncertaintySectionHtml(section, headingTag = 'h2') {
  if (!section || !Array.isArray(section.rows) || section.rows.length === 0) return '';
  const subHeading = headingTag === 'h2' ? 'h3' : 'h4';
  const body = section.rows.map((row) => {
    const status = row.measured ? 'measured' : NOT_MEASURED;
    const statusClass = row.measured ? 'gates-pass' : 'warn-text';
    let spreadText = NOT_MEASURED;
    let valueText = '';
    let overText = '';
    if (row.kind === 'method') {
      spreadText = row.measured ? `${value(row.spreadKcal, 2)} kcal/mol` : NOT_MEASURED;
      valueText = Number.isFinite(row.toleranceKcal)
        ? `tolerance ${value(row.toleranceKcal, 2)} kcal/mol`
        : 'no tolerance declared';
      overText = row.measured ? row.over : `${row.rungs} of ${row.declaredRungs} rungs carried an energy`;
    } else if (row.kind === 'conformer') {
      spreadText = row.measured ? `${value(row.spreadKcal, 2)} kcal/mol` : NOT_MEASURED;
      valueText = Number.isFinite(row.boltzmann?.relativeKcal)
        ? `lowest ${row.lowest?.id ?? MISSING} ${value(row.lowest?.relativeKcal, 2)} · `
          + `Boltzmann ${value(row.boltzmann.relativeKcal, 2)} kcal/mol`
        : '';
      overText = `${row.count} retained conformer${row.count === 1 ? '' : 's'} at ${value(row.temperatureK, 2)} K`;
    } else if (row.kind === 'rate') {
      spreadText = row.measured ? `± ${value(row.errorKcal, 2)} kcal/mol` : NOT_MEASURED;
      valueText = row.measured
        ? `factor ${value(row.factor, 2)}×${row.units && row.kText ? ` · k = ${row.kText} ${row.units}` : ''}`
        : '';
      overText = Number.isFinite(row.barrierKcal)
        ? `ΔG‡ ${value(row.barrierKcal, 2)} kcal/mol at ${value(row.temperatureK, 2)} K`
        : '';
    }
    return '<tr data-field="uncertainty-row" data-kind="' + escapeHtml(row.kind) + '"'
      + ` data-measured="${row.measured ? 'true' : 'false'}">`
      + `<td><strong>${escapeHtml(row.title)}</strong><div class="sub">${escapeHtml(row.text)}</div></td>`
      + `<td class="${statusClass}">${escapeHtml(status)}</td>`
      + `<td class="num">${escapeHtml(spreadText)}</td>`
      + `<td>${escapeHtml(valueText)}</td>`
      + `<td>${escapeHtml(overText)}</td>`
      + '</tr>';
  }).join('');
  const statements = (Array.isArray(section.statements) ? section.statements : []).map((statement) => (
    `<li data-field="uncertainty-statement" data-kind="${escapeHtml(statement.kind)}">${escapeHtml(statement.text)}</li>`
  )).join('');
  const factor = Number.isFinite(section.perKcalFactor)
    ? ` At ${value(section.temperatureK, 2)} K one kcal/mol is a factor ${value(section.perKcalFactor, 2)} in k `
      + "(Eyring, from this app's constants)."
    : '';
  return `<${headingTag} data-field="uncertainty-heading">Uncertainty — measured</${headingTag}>`
    + `<p class="note" data-field="uncertainty-note">${escapeHtml(section.note)}${factor}</p>`
    + `<p class="meta" data-field="uncertainty-counts">${section.measuredCount} of ${section.rows.length} `
    + `quantities measured; ${section.notMeasuredCount} not measured.</p>`
    + '<table data-field="uncertainty"><thead><tr><th>Quantity</th><th>Status</th>'
    + '<th class="num">Spread / error</th><th>Value</th><th>Measured over</th></tr></thead>'
    + `<tbody>${body}</tbody></table>`
    + (statements
      ? `<${subHeading}>What would change the conclusion</${subHeading}>`
        + `<ul data-field="uncertainty-conclusion">${statements}</ul>`
      : '');
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
    + analysisHtml(model.analysis, sectionHeading)
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
    + dp4SectionHtml(model.dp4, sectionHeading)
    + eprSectionHtml(model.epr, sectionHeading)
    + nmrSectionHtml(model.nmr, sectionHeading)
    + reactionBlocks
    + uncertaintySectionHtml(model.uncertainty, sectionHeading)
    + derivedBlocks
    + integritySectionHtml(rows, sectionHeading)
    + descriptorsSectionHtml(rows, sectionHeading)
    + structureFiguresHtml(model.structures, model.figureLevel, sectionHeading)
    + similaritySectionHtml(rows, sectionHeading)
    + multiwfnSectionHtml(model.multiwfn, sectionHeading)
    + importedBlocks
    + (methodsBlocks ? `<${sectionHeading}>Methods</${sectionHeading}>` + methodsBlocks : '')
    + `<${sectionHeading}>Provenance</${sectionHeading}>`
    + '<table><thead><tr><th>Block</th><th>Run</th><th>Input SHA-256</th><th>Output SHA-256</th></tr></thead>'
    + '<tbody>' + provenanceRows + '</tbody></table>';
}

/**
 * The Multiwfn section (issue #270). One subsection per analyse block: the
 * normalised numbers, then the program's version, citation, exact menu script
 * and input SHA-256. A refusal is printed in full, because a missing binary or
 * density matrix is the outcome the reader needs to see.
 */
export function multiwfnSectionHtml(entries, headingTag = 'h2') {
   if (!Array.isArray(entries) || entries.length === 0) return '';
   const sections = entries.map((entry) => {
     const result = entry.result && typeof entry.result === 'object' ? entry.result : null;
     const provenance = entry.provenance && typeof entry.provenance === 'object' ? entry.provenance : {};
     const heading = `<${headingTag}>Multiwfn analysis — ${escapeHtml(entry.title || entry.nodeId || MISSING)}</${headingTag}>`;
     if (!result || result.ok === false || entry.status !== 'computed') {
       return heading
         + `<p class="warn" data-field="multiwfn-refusal">${escapeHtml(entry.notComputed || result?.reason || 'not computed')}</p>`
         + `<p class="meta" data-field="multiwfn-provenance">Multiwfn ${escapeHtml(text(provenance.version) || MISSING)} · `
         + `${escapeHtml(text(provenance.citation) || 'citation not recorded')} · input `
         + `<code>${escapeHtml(text(provenance.input?.sha256) || MISSING)}</code></p>`;
     }
     let body = '';
     if (result.analysis === 'qtaim') {
       body += '<table data-field="multiwfn-basins"><thead><tr><th class="num">Basin</th><th class="num">Electrons</th>'
         + '<th class="num">Volume / bohr³</th><th class="num">Vol(ρ&gt;0.001) / bohr³</th></tr></thead><tbody>'
         + (result.basins?.rows || []).map((row) => '<tr data-field="multiwfn-basin">'
           + `<td class="num">${escapeHtml(String(row.basin))}</td>`
           + `<td class="num">${escapeHtml(value(row.electrons, 7))}</td>`
           + `<td class="num">${escapeHtml(value(row.volumeBohr3, 3))}</td>`
           + `<td class="num">${escapeHtml(value(row.volumeRhoCutoffBohr3, 3))}</td></tr>`).join('')
         + '</tbody></table>';
       body += '<table data-field="multiwfn-charges"><thead><tr><th>Atom</th><th class="num">Charge / e</th>'
         + '<th class="num">Volume / bohr³</th></tr></thead><tbody>'
         + (result.atomicCharges || []).map((row) => '<tr data-field="multiwfn-charge">'
           + `<td>${escapeHtml(`${row.element}${row.basin}`)}</td>`
           + `<td class="num">${escapeHtml(value(row.charge, 6))}</td>`
           + `<td class="num">${escapeHtml(value(row.volumeBohr3, 3))}</td></tr>`).join('')
         + '</tbody></table>';
       body += '<table data-field="multiwfn-critical-points"><thead><tr><th class="num">CP</th><th>Type</th><th>Atoms</th>'
         + '<th class="num">ρ / e·bohr⁻³</th><th class="num">∇²ρ / e·bohr⁻⁵</th><th class="num">ε</th></tr></thead><tbody>'
         + (result.criticalPoints || []).map((row) => '<tr data-field="multiwfn-critical-point">'
           + `<td class="num">${escapeHtml(String(row.index))}</td><td>${escapeHtml(row.type)}</td>`
           + `<td>${escapeHtml(row.connectedAtoms || '—')}</td>`
           + `<td class="num">${escapeHtml(value(row.density, 7))}</td>`
           + `<td class="num">${escapeHtml(value(row.laplacian, 5))}</td>`
           + `<td class="num">${escapeHtml(value(row.ellipticity, 5))}</td></tr>`).join('')
         + '</tbody></table>';
       const comparison = result.comparison;
       if (comparison && typeof comparison === 'object') {
         body += `<p class="meta" data-field="multiwfn-comparison-summary">Comparison with in-app qtaim.js: `
           + `${escapeHtml(comparison.withinTolerance ? 'within the stated tolerances' : 'outside the stated tolerances')}`
           + ` (${escapeHtml(String(comparison.matched ?? 0))} matching BCPs)`
           + `${comparison.reason ? ` — ${escapeHtml(comparison.reason)}` : ''}. `
           + 'Only critical-point properties are compared: the in-app code integrates no basins.</p>';
         if (Array.isArray(comparison.differences) && comparison.differences.length) {
           body += '<table data-field="multiwfn-comparison"><thead><tr><th>Bond</th><th>Property</th>'
             + '<th class="num">Multiwfn</th><th class="num">in-app</th><th class="num">|Δ|</th></tr></thead><tbody>'
             + comparison.differences.map((entry) => `<tr data-field="multiwfn-comparison-row">`
               + `<td>${escapeHtml(entry.bond || '—')}</td><td>${escapeHtml(entry.property || '')}</td>`
               + `<td class="num">${escapeHtml(value(entry.multiwfn, 6))}</td>`
               + `<td class="num">${escapeHtml(value(entry.inApp, 6))}</td>`
               + `<td class="num">${escapeHtml(value(entry.absolute, 6))}</td></tr>`).join('')
             + '</tbody></table>';
         }
       }
     } else if (result.analysis === 'esp') {
       body += '<table data-field="multiwfn-esp"><tbody>'
         + `<tr><th>Surface area</th><td class="num">${escapeHtml(value(result.surfaceArea?.overall?.angstrom, 4))} Å²</td></tr>`
         + `<tr><th>Enclosed volume</th><td class="num">${escapeHtml(value(result.volume?.angstrom, 4))} Å³</td></tr>`
         + `<tr><th>Overall ESP</th><td class="num">${escapeHtml(value(result.potential?.overall?.kcalMol, 4))} kcal/mol</td></tr>`
         + `<tr><th>ESP range</th><td class="num">${escapeHtml(value(result.potential?.minimalKcalMol, 4))} to `
         + `${escapeHtml(value(result.potential?.maximalKcalMol, 4))} kcal/mol</td></tr></tbody></table>`;
     } else if (result.analysis === 'elf' || result.analysis === 'lol') {
       body += '<table data-field="multiwfn-cube"><tbody>'
         + `<tr><th>Cube</th><td>${escapeHtml(result.cube?.name || MISSING)}</td></tr>`
         + `<tr><th>Grid</th><td>${escapeHtml((result.cube?.dims || []).join(' × '))}</td></tr>`
         + `<tr><th>Range</th><td>${escapeHtml(value(result.summary?.min, 6))} to ${escapeHtml(value(result.summary?.max, 6))}</td></tr>`
         + `<tr><th>Mean</th><td>${escapeHtml(value(result.summary?.mean, 6))}</td></tr></tbody></table>`;
     } else if (result.analysis === 'rdg') {
       body += '<table data-field="multiwfn-nci"><tbody>'
         + `<tr><th>Points</th><td>${escapeHtml(String(result.points?.count ?? 0))}</td></tr>`
         + `<tr><th>Attractive / repulsive</th><td>${escapeHtml(String(result.counts?.attractive ?? 0))} / `
         + `${escapeHtml(String(result.counts?.repulsive ?? 0))}</td></tr>`
         + `<tr><th>sign(λ₂)ρ range</th><td>${escapeHtml(value(result.range?.xMin, 5))} to ${escapeHtml(value(result.range?.xMax, 5))}</td></tr>`
         + `<tr><th>RDG range</th><td>${escapeHtml(value(result.range?.sMin, 5))} to ${escapeHtml(value(result.range?.sMax, 5))}</td></tr></tbody></table>`;
     }
     return heading + body
       + `<p class="meta" data-field="multiwfn-provenance">Multiwfn ${escapeHtml(text(provenance.version) || MISSING)}`
       + ` · menu ${escapeHtml(text(provenance.menuVersion) || MISSING)} · input `
       + `<code>${escapeHtml(text(provenance.input?.name) || MISSING)}</code> SHA-256 `
       + `<code>${escapeHtml(text(provenance.input?.sha256) || MISSING)}</code>. `
       + `${escapeHtml(text(provenance.citation) || 'citation not recorded')}. `
       + 'User-installed; not bundled with NodeChem Studio.</p>'
       + (text(provenance.menuScript)
         ? `<details data-field="multiwfn-script"><summary>Exact menu script</summary>`
           + `<pre>${escapeHtml(provenance.menuScript)}</pre></details>` : '');
   }).join('');
   return `<${headingTag}>Multiwfn analyses</${headingTag}>`
     + '<p class="meta">These numbers were produced by a user-installed Multiwfn binary in batch mode '
     + 'and normalised by NodeChem Studio. They are an external reference, not an in-app calculation.</p>'
     + sections;
 }

 /** The NMR section (issue 147). Absolute isotropic shieldings, the reference the
 * run recorded with its provenance, and — for `NMR=(GIAO,SpinSpin)` — every
 * coupling pair the log printed. Units are in the headers, the nuclei are named
 * element + Gaussian's 1-based index, and a value the run did not record is
 * `not reported`: δ without a reference, J for a pair that was never printed.
 */
function nmrSectionHtml(entries, headingTag = 'h2') {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const blocks = entries.map((entry) => {
    const nmr = entry.nmr || {};
    const atoms = Array.isArray(nmr.atoms) ? nmr.atoms : [];
    const level = entry.level && text(entry.level.functional) && text(entry.level.basis)
      ? { method: text(entry.level.functional), basis: text(entry.level.basis) }
      : null;
    const program = entry.program && typeof entry.program === 'object' ? entry.program : {};
    const programText = [text(program.name), text(program.version), text(program.revision)]
      .filter(Boolean).join(' ');
    const reference = nmr.reference && typeof nmr.reference === 'object' ? nmr.reference : null;
    const title = `<h4 data-field="nmr-entry">${escapeHtml(entry.title || entry.nodeId || MISSING)}</h4>`;
    const thisRun = `this run${programText ? ` · ${programText}` : ''} · ${text(nmr.gauge) || 'GIAO'}`;

    const shieldingRows = atoms.map((atom) => {
      const result = shiftFor({ level, nucleus: atom.element, sigma: atom.isotropic, reference });
      return '<tr>'
        + `<td>${escapeHtml(String(atom.index ?? MISSING))}</td>`
        + `<td>${escapeHtml(atom.element ?? MISSING)}</td>`
        + `<td class="num">${escapeHtml(value(atom.isotropic, 4))}</td>`
        + `<td class="num">${result.delta === null ? MISSING : escapeHtml(value(result.delta, 4))}</td>`
        + `<td>${escapeHtml(result.delta === null ? `${thisRun}; no shift — ${result.reason}` : result.source)}</td>`
        + '</tr>';
    }).join('');
    const shieldingTable = atoms.length === 0 ? ''
      : '<table data-field="nmr-shieldings"><thead><tr><th>Atom</th><th>Element</th>'
        + '<th class="num">σ<sub>iso</sub> / ppm</th><th class="num">δ / ppm</th><th>Source</th>'
        + `</tr></thead><tbody>${shieldingRows}</tbody></table>`;

    const referenceLine = atoms.length === 0 ? '' : reference
      ? `<p class="note" data-field="nmr-reference">Reference: σ_ref = ${escapeHtml(String(reference.ppm))} ppm`
        + `${text(reference.provenance) ? ` — ${escapeHtml(text(reference.provenance))}` : ' — provenance not reported'}.`
        + ` δ = σ_ref − σ<sub>iso</sub>.</p>`
      : `<p class="warn" data-field="nmr-reference">No reference was recorded with this run, so the `
        + 'shieldings stay absolute and δ is not reported.</p>';

    const hasCouplings = Object.prototype.hasOwnProperty.call(nmr, 'couplings');
    const couplings = nmr.couplings && typeof nmr.couplings === 'object' ? nmr.couplings : null;
    let couplingHtml = '';
    if (!hasCouplings) {
      couplingHtml = '<p class="meta" data-field="nmr-couplings-absent">This record carries no coupling '
        + 'block, so couplings are not reported.</p>';
    } else if (!couplings) {
      couplingHtml = text(nmr.couplingsError)
        ? '<p class="meta" data-field="nmr-couplings-absent">The spin–spin coupling block could not be '
          + `read: ${escapeHtml(text(nmr.couplingsError))}. Couplings are not reported — an absence, `
          + 'not a zero matrix.</p>'
        : '<p class="meta" data-field="nmr-couplings-absent">No spin–spin coupling table was '
          + 'printed: the route did not ask for NMR=(GIAO,SpinSpin). Couplings are not reported — an '
          + 'absence, not a zero matrix.</p>';
    } else {
      const elements = Array.isArray(couplings.elements) ? couplings.elements : null;
      const elementOf = (index) => (elements ? elements[index] ?? '#' : null)
        ?? atoms.find((atom) => atom.index === index)?.element ?? '#';
      const pairs = Array.isArray(couplings.pairs) ? couplings.pairs : [];
      const possible = (Number(couplings.atoms) * (Number(couplings.atoms) - 1)) / 2;
      const coverage = couplings.complete === true
        ? `All ${possible} pairs printed for ${escapeHtml(String(couplings.atoms))} nuclei.`
        : `${pairs.length} of ${possible} pairs printed; an unprinted pair is absent, not 0.`;
      const problems = Array.isArray(couplings.problems) ? couplings.problems.filter(Boolean) : [];
      const verification = couplings.verified === true
        ? 'The printed rows matched their column headers and every printed diagonal was 0.'
        : `The table did not verify: ${escapeHtml(problems.join('; ') || 'reason not recorded')}.`;
      const pairRows = pairs.map((pair) => '<tr>'
        + `<td>${escapeHtml(elementOf(pair.i))}${escapeHtml(String(pair.i))}–`
        + `${escapeHtml(elementOf(pair.j))}${escapeHtml(String(pair.j))}</td>`
        + `<td class="num">${Number.isFinite(pair.hz) ? escapeHtml(value(pair.hz, 6)) : MISSING}</td>`
        + `<td class="num">${Number.isFinite(pair.k) ? escapeHtml(value(pair.k, 6)) : MISSING}</td>`
        + '</tr>').join('');
      const unitsNote = couplings.note
        || 'J in Hz, sign as Gaussian prints it (FC + SD + PSO + DSO totals, never normalised).';
      const kNote = couplings.kUnits
        ? ` K: ${couplings.kUnits}.`
        : ' K is the reduced constant exactly as printed; no K→J conversion is made.';
      couplingHtml = `<p class="note" data-field="nmr-couplings-note">${escapeHtml(unitsNote)}${escapeHtml(kNote)}</p>`
        + `<p class="meta" data-field="nmr-couplings-coverage">${coverage} ${verification}</p>`
        + `<p class="meta" data-field="nmr-couplings-indexing">${escapeHtml(couplings.indexing || MISSING)}</p>`
        + '<table data-field="nmr-couplings"><thead><tr><th>Pair</th><th class="num">J / Hz</th>'
        + `<th class="num">K (reduced)</th></tr></thead><tbody>${pairRows}</tbody></table>`;
    }

    const nucleiCount = atoms.length || (couplings && Number.isFinite(Number(couplings.atoms))
      ? Number(couplings.atoms)
      : 0);
    const head = `<p class="meta" data-field="nmr-level">${escapeHtml(text(nmr.gauge) || 'gauge not reported')}`
      + ` · ${escapeHtml(level ? `${level.method}/${level.basis}` : MISSING)}`
      + `${programText ? ` · ${escapeHtml(programText)}` : ''} · ${escapeHtml(String(nucleiCount))} nuclei</p>`;
    return title + head + referenceLine + shieldingTable + couplingHtml;
  }).join('');
  return `<${headingTag}>NMR</${headingTag}>`
    + '<p class="note">Isotropic shieldings are absolute ppm as printed. A shift is only printed when '
    + 'the record carries its reference and that reference states its provenance; a coupling pair is '
    + 'only printed when the log printed it.</p>'
    + blocks;
}

/**
 * DP4+ probability tables (issue 165), rendered once and used by both the
 * results card and the workflow report.
 *
 * The panel prints the numbers `dp4.js` computed and the terms they were
 * computed under: the level and its standard, the variant (DP4+ unscaled,
 * scaled or full — never called classic DP4), the temperature, the error
 * distribution with its per-class fit, the experimental list, and the
 * candidates that were excluded and why. A refused result prints the refusal
 * instead of an empty table.
 *
 * @param {object} result the object `dp4Probabilities()` returned
 * @param {object} [options]
 * @param {string} [options.tableClass] the class this surface's tables carry
 * @param {string} [options.heading] an `<h4>` label, omitted inside a card
 * @param {boolean} [options.compact] trim the per-nucleus tables to 15 rows
 */
export function dp4PanelHtml(result, { tableClass = '', heading = '', compact = false } = {}) {
  const className = tableClass ? ` class="${tableClass}"` : '';
  const label = heading ? `<h4 data-field="dp4-entry">${escapeHtml(heading)}</h4>` : '';
  if (!result || typeof result !== 'object') {
    return label + '<p class="warn" data-field="dp4-state">no DP4 result was recorded for this block</p>';
  }
  if (result.available !== true) {
    return `${label}<p class="warn" data-field="dp4-refusal">DP4+ not computed — `
      + `${escapeHtml(result.reason || result.code || 'unknown reason')}</p>`
      + (Array.isArray(result.excluded) && result.excluded.length
        ? `<p class="meta" data-field="dp4-excluded">Excluded: ${escapeHtml(result.excluded
          .map((entry) => `${entry.candidateId} (${entry.reason})`).join('; '))}</p>`
        : '');
  }

  const verdict = dp4Verdict(result);
  const level = result.level || {};
  const experimental = result.experimental || {};
  const terms = [
    `${level.label || MISSING}`,
    result.variantLabel || result.variant || MISSING,
    `${escapeHtml(String(result.temperatureK ?? MISSING))} K`,
    `bank ${result.bank?.package || MISSING} ${result.bank?.version || ''}`.trim(),
  ].filter(Boolean).join(' · ');

  const probabilityRows = (Array.isArray(result.candidates) ? result.candidates : []).map((candidate) => '<tr>'
    + `<td><strong>${escapeHtml(candidate.title || candidate.id)}</strong></td>`
    + `<td class="num">${escapeHtml(String(candidate.conformerCount ?? MISSING))}</td>`
    + `<td>${escapeHtml(candidate.weights?.source === 'stored' ? 'stored populations' : 'from energies')}</td>`
    + `<td class="num">${escapeHtml(value(candidate.percentages?.uns, 2))}</td>`
    + `<td class="num">${escapeHtml(value(candidate.percentages?.sca, 2))}</td>`
    + `<td class="num">${escapeHtml(value(candidate.percent, 2))}</td>`
    + `<td class="num">${escapeHtml(String(Array.isArray(candidate.nuclei) ? candidate.nuclei.length : MISSING))}</td>`
    + '</tr>').join('');
  const probabilityTable = '<table' + className + ' data-field="dp4-probabilities"><thead><tr>'
    + '<th>Candidate</th><th class="num">Conformers</th><th>Boltzmann weights</th>'
    + '<th class="num">p uns / %</th><th class="num">p sca / %</th><th class="num">p full / %</th>'
    + `<th class="num">Nuclei scored</th></tr></thead><tbody>${probabilityRows}</tbody></table>`;

  // Which fit each nucleus class actually used, and how many nuclei went
  // through it. A class with no nuclei is still listed: the fit exists and its
  // absence from the product is a fact about the molecule, not about the bank.
  const counts = new Map();
  const first = Array.isArray(result.candidates) ? result.candidates[0] : null;
  for (const nucleus of (first?.nuclei || [])) {
    for (const key of [nucleus.unscaledClass, nucleus.scaledClass]) {
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const classes = result.errorDistribution?.classes || {};
  const fitRows = Object.entries(classes).map(([key, fit]) => '<tr>'
    + `<td>${escapeHtml(fit.label || key)}</td>`
    + `<td class="num">${escapeHtml(value(fit.df, 5))}</td>`
    + `<td class="num">${escapeHtml(value(fit.mean, 6))}</td>`
    + `<td class="num">${escapeHtml(value(fit.scale, 6))}</td>`
    + `<td class="num">${escapeHtml(String(counts.get(key) || 0))}</td>`
    + '</tr>').join('');
  const fitTable = '<table' + className + ' data-field="dp4-error-fit"><thead><tr><th>Class</th>'
    + '<th class="num">ν (df)</th><th class="num">mean / ppm</th><th class="num">scale / ppm</th>'
    + `<th class="num">Nuclei</th></tr></thead><tbody>${fitRows}</tbody></table>`;

  const limit = compact ? 15 : 60;
  const deviations = (Array.isArray(result.candidates) ? result.candidates : []).slice(0, compact ? 3 : 12).map((candidate) => {
    const rows = (candidate.nuclei || []).slice(0, limit).map((nucleus) => '<tr>'
      + `<td class="num">${escapeHtml(String(nucleus.index))}</td>`
      + `<td>${escapeHtml(nucleus.nucleus)}${nucleus.sp2 ? ' sp²' : ''}</td>`
      + `<td class="num">${escapeHtml(value(nucleus.experimental, 2))}</td>`
      + `<td class="num">${escapeHtml(value(nucleus.computed, 2))}</td>`
      + `<td class="num">${escapeHtml(value(nucleus.unscaledError, 2))}</td>`
      + `<td class="num">${escapeHtml(value(nucleus.computedScaled, 2))}</td>`
      + `<td class="num">${escapeHtml(value(nucleus.scaledError, 2))}</td>`
      + `<td class="num">${escapeHtml(value(nucleus.unscaledProbability, 4))}</td>`
      + `<td class="num">${escapeHtml(value(nucleus.scaledProbability, 4))}</td>`
      + '</tr>').join('');
    const omitted = (candidate.nuclei || []).length - Math.min((candidate.nuclei || []).length, limit);
    const fits = Object.entries(candidate.fits || {})
      .filter(([, fit]) => fit?.used === 'fit')
      .map(([element, fit]) => `${element}: δ_scaled = ${value(fit.slope, 6)}·δ_uns + ${value(fit.intercept, 6)} (${fit.points} nuclei)`);
    const unused = Object.entries(candidate.fits || {})
      .filter(([, fit]) => fit?.used !== 'fit' && (fit?.points || 0) > 1)
      .map(([element]) => element);
    return `<p class="meta" data-field="dp4-candidate-terms">${escapeHtml(candidate.title || candidate.id)} — `
      + `${escapeHtml(String((candidate.nuclei || []).length))} nuclei, `
      + `${escapeHtml(String(candidate.conformerCount ?? MISSING))} conformers, weights `
      + `${escapeHtml(candidate.weights?.source === 'stored' ? 'as the block stored them' : 'computed from the energies here')}`
      + `${fits.length ? `; ${escapeHtml(fits.join('; '))}` : ''}`
      + `${unused.length ? `; no usable ${escapeHtml(unused.join('/'))} fit, those nuclei keep the unscaled shift` : ''}`
      + `${candidate.diastereotopicLabels?.length ? `; diastereotopic pairs ${escapeHtml(candidate.diastereotopicLabels.join(', '))} ordered by the measured shift` : ''}.</p>`
      + '<table' + className + ' data-field="dp4-deviations"><thead><tr><th class="num">Atom</th><th>Nucleus</th>'
      + '<th class="num">δ exp</th><th class="num">δ uns</th><th class="num">err uns</th>'
      + '<th class="num">δ sca</th><th class="num">err sca</th><th class="num">p uns</th><th class="num">p sca</th>'
      + `</tr></thead><tbody>${rows}</tbody></table>`
      + (omitted > 0 ? `<p class="meta">${omitted} more nuclei are in the result object but not printed here.</p>` : '');
  }).join('');

  const excluded = Array.isArray(result.excluded) && result.excluded.length
    ? `<p class="warn" data-field="dp4-excluded">Excluded from the comparison: ${escapeHtml(result.excluded
      .map((entry) => `${entry.candidateId} — ${entry.reason}`).join('; '))}. A candidate is never scored on `
      + 'fewer nuclei than its rivals: that would compare each one with a different experiment.</p>'
    : '';

  const sp2Count = (experimental.shifts || []).filter((shift) => shift.sp2).length;
  return label
    + `<p class="meta" data-field="dp4-terms">${escapeHtml(terms)}</p>`
    + (verdict ? `<p data-field="dp4-verdict"><strong>${escapeHtml(verdict.text)}</strong></p>` : '')
    + probabilityTable
    + `<p class="meta" data-field="dp4-experimental">${escapeHtml(String(experimental.count ?? MISSING))} experimental shifts `
    + `(${escapeHtml(String(experimental.carbon ?? MISSING))} C, ${escapeHtml(String(experimental.hydrogen ?? MISSING))} H), `
    + `${escapeHtml(String(sp2Count))} marked sp², the rest scored as sp³; `
    + `standard shielding σ(TMS) C ${escapeHtml(value(level.standard?.C, 4))} ppm, H ${escapeHtml(value(level.standard?.H, 4))} ppm `
    + `from the ${escapeHtml(level.standardSheet || MISSING)} standard table.</p>`
    + `<p class="meta" data-field="dp4-distribution">Per-nucleus probability is a Student-t tail, `
    + `${escapeHtml(result.errorDistribution?.statistic || MISSING)}; the fit is per nucleus class and per level, `
    + 'from the bank, and no value is interpolated between levels.</p>'
    + fitTable
    + deviations
    + excluded
    + `<p class="note" data-field="dp4-variant-note">This is ${escapeHtml(result.variantLabel || 'DP4+')}, not classic DP4 `
    + `(Smith &amp; Goodman 2010); ${escapeHtml(result.citation?.short || MISSING)} (doi ${escapeHtml(result.citation?.doi || MISSING)}). `
    + `Parameters: ${escapeHtml(result.citation?.parameters || MISSING)}; workbook SHA-256 `
    + `<span class="mono">${escapeHtml(shortHash(result.bank?.workbookSha256) || MISSING)}</span>.</p>`;
}

/** One report subsection per DP4 analysis the model carries (issue 165). */
export function dp4SectionHtml(entries, headingTag = 'h2') {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const blocks = entries.map((entry) => dp4PanelHtml(entry.result ?? entry.dp4, {
    heading: entry.title || entry.nodeId || MISSING,
  })).join('');
  return `<${headingTag}>DP4+ probabilities</${headingTag}>`
    + '<p class="note">Probabilities of candidate structures under DP4+, computed from the error fits the '
    + 'committed parameter bank carries. A candidate at a level the bank does not carry has no probability '
    + 'here: it is refused, never estimated.</p>'
    + blocks;
}

/**
 * The EPR section (issue 168): per-run spin populations and Fermi-contact
 * couplings, in the units the numbers are in, with the level of theory and the
 * density-only caveat printed beside them. A closed-shell run prints the words
 * `no unpaired electrons`; a run whose block is unavailable prints the reason.
 * An empty table is never rendered — that is the shape this section exists to
 * avoid.
 */
function eprSectionHtml(entries, headingTag = 'h2') {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const blocks = entries.map((entry) => {
    const epr = entry.epr || {};
    const title = `<h4 data-field="epr-entry">${escapeHtml(entry.title || entry.nodeId || MISSING)}</h4>`;
    const gTensor = epr.gTensor && typeof epr.gTensor === 'object'
      ? `<p class="meta" data-field="epr-gtensor">g-tensor: ${escapeHtml(epr.gTensor.message || epr.gTensor.status || MISSING)}</p>`
      : '';
    if (epr.status === 'closed-shell') {
      return title
        + `<p class="ok" data-field="epr-state">no unpaired electrons</p>`
        + gTensor;
    }
    if (epr.status !== 'open-shell') {
      return title
        + `<p class="warn" data-field="epr-state">EPR not available — ${escapeHtml(epr.reason || 'unknown reason')}</p>`
        + gTensor;
    }
    const populations = Array.isArray(epr.populations) ? epr.populations : [];
    const populationRows = populations.map((row) => '<tr>'
      + `<td>${escapeHtml(String(row.atom ?? MISSING))}</td>`
      + `<td>${escapeHtml(row.element ?? MISSING)}</td>`
      + `<td class="num">${escapeHtml(value(row.mulliken, 4))}</td>`
      + `<td class="num">${escapeHtml(value(row.lowdin, 4))}</td>`
      + '</tr>').join('');
    const populationTable = populations.length === 0 ? '' : '<table data-field="epr-populations"><thead><tr><th>Atom</th><th>Element</th>'
      + '<th class="num">Mulliken / e</th><th class="num">Löwdin / e</th></tr></thead>'
      + `<tbody>${populationRows}</tbody></table>`;
    const hyperfine = Array.isArray(epr.hyperfine) ? epr.hyperfine : [];
    const hyperfineRows = hyperfine.map((row) => {
      const reported = row.status === 'reported';
      return '<tr>'
        + `<td>${escapeHtml(String(row.atom ?? MISSING))}</td>`
        + `<td>${escapeHtml(reported ? `${row.element}-${row.massNumber}` : (row.element ?? MISSING))}</td>`
        + `<td class="num">${escapeHtml(reported ? value(row.aIsoMhz, 2) : MISSING)}</td>`
        + `<td class="num">${escapeHtml(reported ? value(row.aIsoGauss, 2) : MISSING)}</td>`
        + `<td>${escapeHtml(reported ? '' : (row.note || row.status || ''))}</td>`
        + '</tr>';
    }).join('');
    const hyperfineTable = '<table data-field="epr-hyperfine"><thead><tr><th>Atom</th><th>Isotope</th>'
      + '<th class="num">A_iso / MHz</th><th class="num">A_iso / gauss</th><th>Note</th></tr></thead>'
      + `<tbody>${hyperfineRows}</tbody></table>`;
    const sum = Number.isFinite(epr.populationSum) ? epr.populationSum.toFixed(6) : MISSING;
    const source = epr.provenance?.spinDensityBlock || epr.provenance?.hyperfineBlock || MISSING;
    const sumText = Number.isFinite(epr.populationSum)
      ? `, sum ${escapeHtml(sum)} electrons (n_alpha − n_beta)`
      : '';
    return title
      + `<p class="meta" data-field="epr-level">${escapeHtml(epr.level || MISSING)} · `
      + `${escapeHtml(String(epr.electrons?.alpha ?? '?'))} alpha, ${escapeHtml(String(epr.electrons?.beta ?? '?'))} beta, `
      + `${escapeHtml(String(epr.electrons?.unpaired ?? '?'))} unpaired · from `
      + `${escapeHtml(source)}${sumText}</p>`
      + populationTable
      + hyperfineTable
      + `<p class="note" data-field="epr-hyperfine-method">${escapeHtml(epr.hyperfineMethod || MISSING)}</p>`
      + `<p class="meta" data-field="epr-hyperfine-caveat">${escapeHtml(epr.hyperfineCaveat || MISSING)}</p>`
      + gTensor;
  }).join('');
  return `<${headingTag}>Spin density / EPR</${headingTag}>`
    + '<p class="note">Spin populations are in electrons (alpha − beta), Fermi-contact couplings in MHz and in '
    + 'gauss, both from the spin density the run recorded.</p>'
    + blocks;
}

/**
 * The wavefunction analysis section (issue 59): the BCP table and the NCI
 * figure, or the reason each is absent. Printed only when the model carries an
 * analysis, so a report built without a checkpoint is unchanged.
 */
function analysisHtml(analysis, headingTag = 'h2') {
  if (!analysis) return '';
  const heading = `<${headingTag}>Wavefunction analysis</${headingTag}>`;
  if (!analysis.qtaim || analysis.qtaim.ok === false) {
    return heading + bcpTableHtml(analysis.qtaim || { ok: false });
  }
  const table = bcpTableHtml(analysis.qtaim);
  const caption = analysis.figure
    ? figureBlockHtml({ ...analysis.figure, key: 'nci' })
    : `<p class="fig-missing">nci figure not available: ${
      analysis.nci && analysis.nci.ok === false
        ? escapeHtml(analysis.nci.reason || 'no data')
        : 'the figure is larger than the report budget'
    }</p>`;
  return heading
    + `<p class="note">${escapeHtml(analysis.qtaim.method)}. ρ and ∇²ρ in e/bohr³ and e/bohr⁵; `
    + `criteria: ${escapeHtml(analysis.qtaim.parameters?.criteria?.sharedShell || '')}; `
    + `${escapeHtml(analysis.qtaim.parameters?.criteria?.closedShell || '')}.</p>`
    + table
    + caption;
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
