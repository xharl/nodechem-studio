/**
 * Run-to-run comparison.
 *
 * Two `run.json` records in, one difference-first model out. The model is pure
 * and engine-neutral: it reads only fields both records may carry, reports
 * `null` for a value either side does not have, and never invents a delta when
 * the units or the level of theory differ.
 *
 * The rule that matters: a difference is only called a *change* when the two
 * runs are comparable. If the method, basis or engine differ, the comparison
 * still shows both values but labels the delta as cross-method rather than
 * presenting it as a re-run result.
 */

const HARTREE_TO_KCAL_PER_MOL = 627.5094740631;

function num(value) {
  const number = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(number) ? null : number;
}

function str(value) {
  return value === null || value === undefined ? null : String(value);
}

function methodOf(record) {
  const method = record?.provenance?.method && typeof record.provenance.method === 'object'
    ? record.provenance.method : {};
  return {
    engine: str(record?.engine ?? record?.parsed?.engine),
    functional: str(method.functional),
    basis: str(method.basis),
    dispersion: str(method.dispersion),
    solvation: str(method.solvation),
    jobType: str(method.jobType ?? record?.provenance?.jobType),
  };
}

function isSameLevelOfTheory(a, b) {
  const left = methodOf(a);
  const right = methodOf(b);
  const keys = ['engine', 'functional', 'basis', 'dispersion', 'solvation', 'jobType'];
  const differing = keys.filter((key) => left[key] !== right[key]);
  return { same: differing.length === 0, differing, left, right };
}

function gateVerdict(record) {
  const overall = record?.gates?.overall;
  return overall === 'pass' || overall === 'fail' || overall === 'unknown' ? overall : null;
}

function energyOf(record) {
  const parsed = record?.parsed || {};
  const final = num(parsed?.finalEnergy?.hartree);
  if (final !== null) return { hartree: final, source: str(parsed?.finalEnergy?.source) ?? 'final energy' };
  const scf = num(parsed?.scf?.energyHartree);
  return scf === null ? null : { hartree: scf, source: 'SCF energy' };
}

function gibbsOf(record) {
  const parsed = record?.parsed || {};
  const raw = num(parsed?.thermochemistry?.freeEnergyHartree);
  if (raw === null) return null;
  return { hartree: raw, source: 'thermal free energy' };
}

function deltaRow(id, label, a, b, { unit = null, comparable = true, digits = 4, note = null } = {}) {
  const left = num(a);
  const right = num(b);
  const delta = left === null || right === null ? null : right - left;
  return {
    id,
    label,
    unit,
    left,
    right,
    delta,
    digits,
    comparable: Boolean(comparable),
    note,
  };
}

/**
 * Compare two run records.
 *
 * @param {object} left  the baseline (older) run
 * @param {object} right the run under comparison (newer)
 * @returns {object} a difference-first model; never throws on malformed records
 */
export function compareRuns(left, right) {
  const a = left && typeof left === 'object' ? left : {};
  const b = right && typeof right === 'object' ? right : {};
  const level = isSameLevelOfTheory(a, b);
  const energyA = energyOf(a);
  const energyB = energyOf(b);
  const gibbsA = gibbsOf(a);
  const gibbsB = gibbsOf(b);

  const energyDeltaKcal = energyA && energyB
    ? (energyB.hartree - energyA.hartree) * HARTREE_TO_KCAL_PER_MOL
    : null;
  const gibbsDeltaKcal = gibbsA && gibbsB
    ? (gibbsB.hartree - gibbsA.hartree) * HARTREE_TO_KCAL_PER_MOL
    : null;

  const rows = [
    deltaRow('energy', 'Final energy', energyA?.hartree ?? null, energyB?.hartree ?? null, {
      unit: 'Eh',
      digits: 8,
      comparable: level.same,
      note: level.same ? null : 'different level of theory',
    }),
    {
      id: 'energy-delta',
      label: 'Energy difference',
      unit: 'kcal/mol',
      left: null,
      right: null,
      delta: energyDeltaKcal,
      digits: 3,
      comparable: level.same,
      note: level.same ? null : 'cross-method; not a re-run difference',
    },
    deltaRow('gibbs', 'Thermal free energy', gibbsA?.hartree ?? null, gibbsB?.hartree ?? null, {
      unit: 'Eh',
      digits: 8,
      comparable: level.same,
      note: level.same ? null : 'different level of theory',
    }),
    {
      id: 'gibbs-delta',
      label: 'Free-energy difference',
      unit: 'kcal/mol',
      left: null,
      right: null,
      delta: gibbsDeltaKcal,
      digits: 3,
      comparable: level.same,
      note: level.same ? null : 'cross-method; not a re-run difference',
    },
    deltaRow('scf-cycles', 'SCF cycles', a?.parsed?.scf?.cycles ?? null, b?.parsed?.scf?.cycles ?? null, {
      digits: 0,
    }),
    deltaRow('imaginary', 'Imaginary modes',
      a?.parsed?.frequencies?.imaginaryCount ?? null,
      b?.parsed?.frequencies?.imaginaryCount ?? null, { digits: 0 }),
    deltaRow('elapsed', 'Elapsed time',
      a?.elapsedSeconds ?? a?.parsed?.resources?.elapsedSeconds ?? null,
      b?.elapsedSeconds ?? b?.parsed?.resources?.elapsedSeconds ?? null,
      { unit: 's', digits: 1 }),
  ];

  const statusChanges = [
    { id: 'status', label: 'Run status', left: str(a.status), right: str(b.status) },
    { id: 'gates', label: 'Gate verdict', left: gateVerdict(a), right: gateVerdict(b) },
    {
      id: 'validity',
      label: 'Validity verdict',
      left: str(a?.gates?.validity?.overall ?? a?.validity?.overall),
      right: str(b?.gates?.validity?.overall ?? b?.validity?.overall),
    },
    {
      id: 'output-hash',
      label: 'Output SHA-256',
      left: str(a.outputSha256),
      right: str(b.outputSha256),
    },
  ].map((entry) => ({ ...entry, changed: entry.left !== entry.right }));

  const changedLevels = level.differing.filter((key) => level.left[key] !== level.right[key]);

  return {
    left: { id: str(a.id), title: str(a.title), status: str(a.status), finishedAt: str(a.finishedAt) },
    right: { id: str(b.id), title: str(b.title), status: str(b.status), finishedAt: str(b.finishedAt) },
    sameLevelOfTheory: level.same,
    changedLevelKeys: changedLevels,
    levels: { left: level.left, right: level.right },
    rows,
    statusChanges,
    energySources: { left: energyA?.source ?? null, right: energyB?.source ?? null },
    summary: summarize(rows, statusChanges, level.same),
  };
}

function summarize(rows, statusChanges, sameLevel) {
  const changed = [];
  if (!sameLevel) changed.push('level of theory differs');
  for (const row of rows) {
    if (row.delta !== null && row.delta !== 0) changed.push(row.label);
  }
  for (const entry of statusChanges) {
    if (entry.changed && entry.id !== 'output-hash') changed.push(entry.label);
  }
  if (changed.length === 0) return 'No difference in the compared fields.';
  return `Changed: ${changed.join(', ')}.`;
}

function formatValue(value, digits) {
  if (value === null || value === undefined) return 'not reported';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return number.toFixed(Math.max(0, Math.min(12, digits)));
}

function signed(value, digits) {
  if (value === null || value === undefined) return 'not reported';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  const text = number.toFixed(Math.max(0, Math.min(12, digits)));
  return number > 0 ? `+${text}` : text;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render the comparison as a self-contained HTML block. Pure: no DOM, no disk.
 * Values either side lacks are rendered as "not reported"; a delta across two
 * levels of theory is marked instead of being presented as a re-run result.
 */
export function comparisonHtml(model) {
  if (!model || typeof model !== 'object') return '';
  const header = `<header class="results-compare-head">`
    + `<span class="results-compare-title">${escapeHtml(model.left.title || model.left.id || 'baseline')}`
    + ` → ${escapeHtml(model.right.title || model.right.id || 'comparison')}</span>`
    + `<span class="results-compare-summary">${escapeHtml(model.summary)}</span>`
    + '</header>';

  const levelNote = model.sameLevelOfTheory
    ? ''
    : `<p class="results-compare-note" data-role="cross-method">Different ${model.changedLevelKeys.join(', ')}.`
      + ' Deltas are shown for information and are not a re-run difference.</p>';

  const rows = model.rows.map((row) => {
    const unit = row.unit ? ` ${escapeHtml(row.unit)}` : '';
    const delta = row.delta === null
      ? 'not computed'
      : `${signed(row.delta, row.digits)}${unit}`;
    const note = row.note ? `<span class="results-compare-row-note">${escapeHtml(row.note)}</span>` : '';
    return '<tr data-compare-row="' + escapeHtml(row.id) + '">'
      + `<th scope="row">${escapeHtml(row.label)}${note}</th>`
      + `<td>${escapeHtml(formatValue(row.left, row.digits))}${unit}</td>`
      + `<td>${escapeHtml(formatValue(row.right, row.digits))}${unit}</td>`
      + `<td data-delta="${row.delta === null ? 'none' : 'value'}">${escapeHtml(delta)}</td>`
      + '</tr>';
  }).join('');

  const statusRows = model.statusChanges.map((entry) => (
    '<tr data-compare-status="' + escapeHtml(entry.id) + '"'
    + (entry.changed ? ' class="is-changed"' : '') + '>'
    + `<th scope="row">${escapeHtml(entry.label)}</th>`
    + `<td>${escapeHtml(entry.left ?? 'not reported')}</td>`
    + `<td>${escapeHtml(entry.right ?? 'not reported')}</td>`
    + `<td>${entry.changed ? 'changed' : 'unchanged'}</td>`
    + '</tr>'
  )).join('');

  return '<section class="results-compare" data-role="run-comparison">'
    + header + levelNote
    + '<table class="results-compare-table"><thead><tr>'
    + '<th scope="col">Field</th><th scope="col">Baseline</th><th scope="col">Comparison</th><th scope="col">Δ</th>'
    + '</tr></thead><tbody>' + rows + statusRows + '</tbody></table>'
    + '<p class="results-compare-foot">Δ is comparison minus baseline. '
    + 'A field one run did not report stays “not reported”; nothing is inferred.</p>'
    + '</section>';
}
