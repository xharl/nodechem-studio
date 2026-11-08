/**
 * Results surface for the run console.
 *
 * `resultsPanelHtml(record)` is a pure function: one `run.json` record in, one
 * HTML string out. It never reads disk, never calls the desktop bridge and
 * never invents a value — a field the parser did not report is rendered as
 * "not reported". Fixture (dry-run) records and truncated parses are labelled
 * on the panel and again next to the numbers they affect.
 *
 * `installResultsView()` is the only DOM-aware part. It subscribes to the run
 * and queue events, renders the panel when a run finishes, and opens a
 * finished run when its row in "Recent runs" or the workflow queue is
 * selected. Keeping the wiring here means `app.js` needs one import and one
 * call.
 */

import { methodsParagraphFor } from '../shared/methodsParagraph.js';

const MISSING_TEXT = 'not reported';

const ENGINE_LABELS = Object.freeze({
  gaussian: 'Gaussian 16',
  xtb: 'xTB (GFN-xTB)',
});

const RUN_STATUSES = new Set(['completed', 'failed', 'needs-review', 'cancelled', 'running']);
const GATE_RESULTS = new Set(['pass', 'fail', 'unknown']);

const CHARGE_SCHEMES = Object.freeze([
  ['mulliken', 'Mulliken charges'],
  ['lowdin', 'Löwdin charges'],
  ['nbo', 'Natural population analysis (NBO)'],
  ['esp', 'ESP charges'],
]);

const ENERGY_SOURCE_LABELS = Object.freeze({
  scf: 'SCF',
  'post-hf': 'post-HF correlation',
  scc: 'xTB SCC',
  'force-field': 'GFN-FF energy',
});

const HARTREE_DIGITS = 10;

const RESULTS_VIEW_STYLE_ID = 'results-view-styles';

/* ── Small formatting helpers ───────────────────────────────── */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function missingHtml() {
  return `<span class="results-missing">${MISSING_TEXT}</span>`;
}

function safeText(value) {
  const cleaned = text(value);
  return cleaned === null ? missingHtml() : esc(cleaned);
}

function valueOrMissing(value) {
  return value === null || value === undefined || value === ''
    ? missingHtml()
    : esc(value);
}

function numberText(value, digits) {
  const number = finite(value);
  return number === null ? null : number.toFixed(digits);
}

function integerText(value) {
  const number = finite(value);
  return number === null ? null : String(Math.trunc(number));
}

/** Hartree values are printed with fixed precision so trailing zeros mean "as parsed". */
function hartreeText(value) {
  const number = finite(value);
  return number === null ? null : `${number.toFixed(HARTREE_DIGITS)} Eh`;
}

function formatTimestamp(value) {
  const cleaned = text(value);
  if (cleaned === null) return null;
  // Do not re-interpret the timestamp in the viewer's timezone. ISO is what
  // the runner wrote; show it as written.
  return cleaned.replace('T', ' ').replace(/\.(\d{3})Z$/, 'Z');
}

function formatBytes(value) {
  const bytes = finite(value);
  if (bytes === null) return null;
  if (bytes < 1024) return `${Math.trunc(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatSeconds(value) {
  const seconds = finite(value);
  if (seconds === null) return null;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  return [hours ? `${hours} h` : '', minutes ? `${minutes} min` : '', rest ? `${rest} s` : '']
    .filter(Boolean).join(' ');
}

function programBanner(program) {
  if (!isObject(program) || !text(program.name)) return null;
  const name = text(program.name);
  const version = text(program.version);
  const revision = text(program.revision);
  return `${name}${version ? ` ${version}` : ''}${revision ? `, Revision ${revision}` : ''}`;
}

function methodSummary(method) {
  if (!isObject(method)) return null;
  const parts = [];
  if (text(method.functional) || text(method.basis)) {
    parts.push([text(method.functional), text(method.basis)].filter(Boolean).join('/'));
  }
  if (text(method.dispersion)) parts.push(text(method.dispersion));
  if (text(method.solvation)) parts.push(`solvation ${text(method.solvation)}`);
  if (text(method.grid)) parts.push(`grid ${text(method.grid)}`);
  if (text(method.scf)) parts.push(`SCF ${text(method.scf)}`);
  return parts.length ? parts.join(' · ') : null;
}

function gateResult(value) {
  const cleaned = text(value)?.toLowerCase() || 'unknown';
  return GATE_RESULTS.has(cleaned) ? cleaned : 'unknown';
}

function statusOf(record) {
  const value = text(record?.status);
  return value !== null && RUN_STATUSES.has(value) ? value : 'unknown';
}

function engineOf(record, parsed) {
  return text(record?.engine) || text(parsed?.engine);
}

/* ── Fixture and truncation flags ───────────────────────────── */

/**
 * A fixture record and a truncated parse are both facts about the run, not
 * presentation choices. Derive them from every field that can carry the fact
 * so an older or partially written record cannot silently look complete.
 */
function flagsFor(record) {
  const provenance = isObject(record?.provenance) ? record.provenance : {};
  const bytes = isObject(record?.outputBytes) ? record.outputBytes : null;
  const parsed = isObject(record?.parsed) ? record.parsed : {};
  const size = finite(bytes?.size);
  const bytesRead = finite(bytes?.bytesRead);
  const fixture = record?.dryRun === true || provenance.kind === 'fixture';
  const truncated = record?.truncated === true
    || parsed.complete === false
    || bytes?.truncated === true
    || (size !== null && bytesRead !== null && bytesRead < size);
  return { fixture, truncated, bytes };
}

function caveatHtml(flags, subject) {
  const notes = [];
  if (flags.fixture) notes.push(`${subject}: synthetic fixture output — not a calculated value.`);
  if (flags.truncated) notes.push(`${subject}: partial parse — values may be missing or stale.`);
  return notes.length ? `<p class="results-caveat">${notes.map(esc).join(' ')}</p>` : '';
}

function truncationBanner(bytes) {
  const size = finite(bytes?.size);
  const bytesRead = finite(bytes?.bytesRead);
  const windows = Array.isArray(bytes?.windows)
    ? bytes.windows.map((window) => text(window?.name)).filter(Boolean)
    : [];
  const coverage = bytesRead !== null && size !== null
    ? `${bytesRead} of ${size} bytes`
    : bytesRead !== null ? `${bytesRead} bytes` : 'only part of the output';
  const windowText = windows.length ? ` (${windows.join(' + ')})` : '';
  return `Truncated parse — ${coverage}${windowText}. Values may be missing or partial, and no gate can pass on a partial parse.`;
}

/* ── HTML building blocks ──────────────────────────────────── */

function card(title, body, extraClass = '') {
  return `<section class="results-card${extraClass ? ` ${extraClass}` : ''}">`
    + `<h4 class="results-card-title">${esc(title)}</h4>${body}</section>`;
}

/**
 * Definition rows. `valueHtml` must already be escaped or built from one of
 * the safe helpers above; labels and field names are escaped here.
 */
function kv(rows, className = 'results-kv') {
  return `<dl class="${className}">${rows.map(([label, valueHtml, field]) => (
    `<dt>${esc(label)}</dt><dd${field ? ` data-field="${esc(field)}"` : ''}>${valueHtml}</dd>`
  )).join('')}</dl>`;
}

function fieldValue(label, valueHtml, field) {
  return [label, valueHtml, field];
}

function emptyStateHtml() {
  return '<div class="results-empty"><span class="results-eyebrow">Results</span>'
    + '<p>Select a completed run to see its parsed quantities.</p></div>';
}

/* ── Cards ─────────────────────────────────────────────────── */

function runCard(record, parsed, status, engineLabel) {
  const dryRun = typeof record?.dryRun === 'boolean'
    ? (record.dryRun ? 'yes — fixture output' : 'no — real executable')
    : null;
  return card('Run', kv([
    fieldValue('Status', `<span class="results-chip is-status-${esc(status)}">${esc(status)}</span>`, 'status'),
    fieldValue('Engine', engineLabel ? esc(engineLabel) : missingHtml(), 'engine'),
    fieldValue('Termination', safeText(parsed?.termination), 'termination'),
    fieldValue('Exit code', integerText(record?.exitCode) ?? missingHtml(), 'exit-code'),
    fieldValue('Started', safeText(formatTimestamp(record?.startedAt)), 'started-at'),
    fieldValue('Finished', safeText(formatTimestamp(record?.finishedAt)), 'finished-at'),
    fieldValue('Dry run', dryRun ? esc(dryRun) : missingHtml(), 'dry-run'),
  ]));
}

function programCard(parsed, flags) {
  const banner = programBanner(parsed?.program);
  const route = text(parsed?.route);
  const routeHtml = route
    ? `<code class="results-route" data-field="route">${esc(route)}</code>`
    : `<p class="results-missing" data-field="route">${MISSING_TEXT}</p>`;
  return card('Program & route', kv([
    fieldValue('Program banner', banner ? esc(banner) : missingHtml(), 'program'),
  ]) + routeHtml + caveatHtml(flags, 'The program and route record'));
}

function energyCard(parsed, flags) {
  const finalEnergy = isObject(parsed?.finalEnergy) ? parsed.finalEnergy : {};
  const scf = isObject(parsed?.scf) ? parsed.scf : {};
  const source = text(finalEnergy.source);
  const sourceLabel = source
    ? (Object.hasOwn(ENERGY_SOURCE_LABELS, source) ? ENERGY_SOURCE_LABELS[source] : source)
    : null;
  const scfApplicable = scf.applicable !== false;
  const rows = [
    fieldValue('Final energy', hartreeText(finalEnergy.hartree) ?? missingHtml(), 'final-energy'),
    fieldValue('Source', sourceLabel ? esc(sourceLabel) : missingHtml(), 'final-energy-source'),
  ];
  if (scfApplicable) {
    rows.push(
      fieldValue('SCF energy', hartreeText(scf.energyHartree) ?? missingHtml(), 'scf-energy'),
      fieldValue('SCF status', safeText(scf.status), 'scf-status'),
    );
  } else {
    rows.push(
      fieldValue('SCF energy', missingHtml(), 'scf-energy'),
      fieldValue('SCF status', 'not applicable (force-field result)', 'scf-status'),
    );
  }
  return card('Energy', kv(rows) + caveatHtml(flags, 'The final energy'));
}

function thermochemistryCard(parsed, flags) {
  const thermo = isObject(parsed?.thermochemistry) ? parsed.thermochemistry : {};
  // Gaussian writes `zeroPointEnergyHartree`; the canonical engine-neutral
  // shape uses `zpeHartree`. Read both, but never derive one from the SCF
  // energy or from a correction.
  const eZpe = finite(thermo.zeroPointEnergyHartree) !== null
    ? thermo.zeroPointEnergyHartree
    : finite(thermo.zpeHartree) !== null ? thermo.zpeHartree : null;
  const entropy = finite(thermo.entropyCalPerMolK?.total);
  const temperature = finite(thermo.temperatureK);
  const pressure = finite(thermo.pressureAtm);
  const treatment = text(thermo.entropyTreatment);
  const rows = [
    fieldValue('E + ZPE', hartreeText(eZpe) ?? missingHtml(), 'thermo-ezpe'),
    fieldValue('H (enthalpy)', hartreeText(thermo.enthalpyHartree) ?? missingHtml(), 'thermo-h'),
    fieldValue('G (free energy)', hartreeText(thermo.freeEnergyHartree) ?? missingHtml(), 'thermo-g'),
    fieldValue('Entropy', entropy === null ? missingHtml() : `${entropy.toFixed(3)} cal mol⁻¹ K⁻¹`, 'thermo-entropy'),
  ];
  if (treatment) rows.push(fieldValue('Entropy treatment', esc(treatment), 'thermo-entropy-treatment'));
  const conditions = [
    temperature === null ? null : `${temperature.toFixed(2)} K`,
    pressure === null ? null : `${pressure.toFixed(5)} atm`,
  ].filter(Boolean).join(' · ');
  return card('Thermochemistry', kv(rows)
    + (conditions ? `<p class="results-note" data-field="thermo-conditions">${esc(conditions)}</p>` : '')
    + caveatHtml(flags, 'Thermochemistry'));
}

function frequenciesCard(parsed, flags) {
  const freq = isObject(parsed?.frequencies) ? parsed.frequencies : {};
  const count = finite(freq.count);
  const imaginaryCount = finite(freq.imaginaryCount);
  const lowest = Array.isArray(freq.lowest)
    ? freq.lowest.filter((value) => finite(value) !== null)
    : [];
  const imaginaryValues = Array.isArray(freq.imaginaryValues)
    ? freq.imaginaryValues.filter((value) => finite(value) !== null)
    : [];
  const hasRecord = (count !== null && count > 0)
    || lowest.length > 0
    || imaginaryValues.length > 0
    || (imaginaryCount !== null && imaginaryCount > 0);
  const rows = [
    fieldValue('Modes reported', hasRecord && count !== null ? integerText(count) : missingHtml(), 'freq-count'),
    fieldValue('Imaginary modes', hasRecord && imaginaryCount !== null ? integerText(imaginaryCount) : missingHtml(), 'freq-imaginary-count'),
    fieldValue('Most negative', finite(freq.minImaginary) === null
      ? missingHtml()
      : `${freq.minImaginary.toFixed(1)} cm⁻¹`, 'freq-min-imaginary'),
  ];
  const modes = lowest.length ? lowest : imaginaryValues;
  if (modes.length) {
    const chips = modes.map((value) => (
      `<span class="results-mode${value < 0 ? ' is-imaginary' : ''}">${esc(value.toFixed(1))}</span>`
    )).join('');
    rows.push(fieldValue(
      lowest.length ? 'Lowest modes' : 'Imaginary modes',
      `<span class="results-modes">${chips}<span class="results-unit">cm⁻¹</span></span>`,
      'freq-modes',
    ));
  } else {
    rows.push(fieldValue('Lowest modes', missingHtml(), 'freq-modes'));
  }
  return card('Frequencies', kv(rows) + caveatHtml(flags, 'The frequency summary'));
}

function chargeCell(value, digits = 6) {
  const number = finite(value);
  return number === null ? missingHtml() : esc(number.toFixed(digits));
}

function chargeTable(label, rows) {
  const hasSpin = rows.some((row) => finite(row.spinDensity) !== null);
  const head = '<tr><th>Atom</th><th>El</th><th>Charge</th>'
    + (hasSpin ? '<th>Spin</th>' : '') + '</tr>';
  const body = rows.map((row) => (
    '<tr>'
    + `<td>${integerText(row.atom) ?? missingHtml()}</td>`
    + `<td>${valueOrMissing(row.element)}</td>`
    + `<td>${chargeCell(row.charge)}</td>`
    + (hasSpin ? `<td>${chargeCell(row.spinDensity)}</td>` : '')
    + '</tr>'
  )).join('');
  return `<div class="results-charge-block"><h5 class="results-charge-title">${esc(label)}`
    + `<span>${rows.length} atom${rows.length === 1 ? '' : 's'}</span></h5>`
    + `<table class="results-table results-charge-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function dipoleTable(dipole) {
  const cell = (value) => (finite(value) === null ? missingHtml() : esc(value.toFixed(4)));
  return '<div class="results-charge-block"><h5 class="results-charge-title">Dipole moment'
    + '<span>Debye</span></h5>'
    + '<table class="results-table results-charge-table"><thead>'
    + '<tr><th>X</th><th>Y</th><th>Z</th><th>Total</th></tr></thead><tbody><tr>'
    + `<td>${cell(dipole.x)}</td><td>${cell(dipole.y)}</td>`
    + `<td>${cell(dipole.z)}</td><td>${cell(dipole.total)}</td>`
    + '</tr></tbody></table></div>';
}

function chargesCard(parsed, flags) {
  const charges = isObject(parsed?.charges) ? parsed.charges : {};
  const blocks = [];
  for (const [key, label] of CHARGE_SCHEMES) {
    const rows = Array.isArray(charges[key])
      ? charges[key].filter((row) => isObject(row))
      : [];
    if (rows.length) blocks.push(chargeTable(label, rows));
  }
  const dipole = isObject(charges.dipole) ? charges.dipole : null;
  if (dipole) blocks.push(dipoleTable(dipole));
  if (!blocks.length) return '';
  return card('Charges & dipole', blocks.join('') + caveatHtml(flags, 'This charge record'), 'is-wide');
}

function t1Card(parsed, flags) {
  const t1 = finite(parsed?.t1Diagnostic);
  const body = t1 === null
    ? `<p class="results-missing" data-field="t1">${MISSING_TEXT}</p>`
    : `<p class="results-big" data-field="t1">${esc(t1.toFixed(6))}</p>`
      + '<p class="results-note">T1 diagnostic as printed by the program; no pass/fail threshold is applied here.</p>';
  return card('T1 diagnostic', body + caveatHtml(flags, 'The T1 diagnostic'));
}

function resourcesCard(parsed, flags) {
  const resources = isObject(parsed?.resources) ? parsed.resources : {};
  const rows = [
    fieldValue('NBasis', integerText(resources.nBasis) ?? missingHtml(), 'resources-nbasis'),
    fieldValue('Basis functions', integerText(resources.basisFunctions) ?? missingHtml(), 'resources-basis-functions'),
    fieldValue('Primitive gaussians', integerText(resources.primitiveGaussians) ?? missingHtml(), 'resources-primitive-gaussians'),
    fieldValue('Processors', integerText(resources.processors) ?? missingHtml(), 'resources-processors'),
    fieldValue('Memory', safeText(resources.memory), 'resources-memory'),
    fieldValue('CPU time', formatSeconds(resources.cpuSeconds) ?? missingHtml(), 'resources-cpu-seconds'),
    fieldValue('Elapsed time', formatSeconds(resources.elapsedSeconds) ?? missingHtml(), 'resources-elapsed-seconds'),
  ];
  return card('Resources', kv(rows) + caveatHtml(flags, 'The resource record'));
}

function errorCard(record, parsed) {
  const errorTermination = isObject(parsed?.errorTermination) ? parsed.errorTermination : null;
  const runnerError = text(record?.error);
  const status = text(parsed?.status);
  if (!errorTermination && !runnerError && status !== 'error') return '';
  const blocks = [];
  if (errorTermination) {
    blocks.push(kv([
      fieldValue('Cause', safeText(errorTermination.cause), 'error-cause'),
      fieldValue('Termination line', safeText(errorTermination.terminationLine), 'error-termination'),
    ]));
    const lines = Array.isArray(errorTermination.lines)
      ? errorTermination.lines.map(text).filter(Boolean)
      : [];
    if (lines.length) {
      blocks.push(`<pre class="results-pre" data-field="error-lines">${esc(lines.join('\n'))}</pre>`);
    }
  }
  if (runnerError) {
    blocks.push(kv([fieldValue('Runner error', esc(runnerError), 'runner-error')]));
  }
  if (!blocks.length) {
    blocks.push(`<p class="results-missing" data-field="error-cause">${MISSING_TEXT}</p>`);
  }
  return card('Error termination', blocks.join(''), 'is-wide is-error');
}

function methodsCard(record) {
  let result;
  try {
    result = methodsParagraphFor(record, { form: 'full' });
  } catch (error) {
    return card('Methods paragraph', `<p class="results-missing">${esc(error.message)}</p>`, 'is-wide');
  }
  if (!result?.ok) {
    return card('Methods paragraph', `<p class="results-missing">${esc(result?.message || 'No methods paragraph is available for this run.')}</p>`, 'is-wide');
  }
  return card('Methods paragraph', `<pre class="results-methods-text">${esc(result.markdown)}</pre>`, 'is-wide');
}

function gatesCard(gates) {
  const overall = gateResult(gates?.overall);
  const list = Array.isArray(gates?.gates) ? gates.gates : [];
  const head = '<div class="results-gates-head"><span class="results-eyebrow">Overall</span>'
    + `<span class="results-badge is-gates-${overall}" data-field="gate-overall">${esc(overall)}</span></div>`;
  if (!list.length) {
    return card('Gates', head
      + `<p class="results-missing">${MISSING_TEXT} — no gate record was saved for this run.</p>`,
    'is-wide');
  }
  const rows = list.map((gate) => {
    const result = gateResult(gate?.result);
    const name = text(gate?.name) || MISSING_TEXT;
    const detail = text(gate?.detail);
    const optional = gate?.required === false
      ? ' <span class="results-gate-optional">optional</span>'
      : '';
    return `<tr data-gate="${esc(name)}" data-result="${result}" class="is-${result}">`
      + `<td>${esc(name)}${optional}</td>`
      + `<td><span class="results-gate is-${result}">${esc(result)}</span></td>`
      + `<td>${detail === null ? missingHtml() : esc(detail)}</td>`
      + '</tr>';
  }).join('');
  return card('Gates', head
    + '<table class="results-table results-gate-table"><thead>'
    + '<tr><th>Gate</th><th>Result</th><th>Evidence</th></tr></thead>'
    + `<tbody>${rows}</tbody></table>`, 'is-wide');
}

function provenanceBlock(record) {
  const provenance = isObject(record?.provenance) ? record.provenance : {};
  const input = isObject(provenance.input) ? provenance.input : {};
  const output = isObject(provenance.output) ? provenance.output : {};
  const app = isObject(record?.app) ? record.app : {};
  const bytes = isObject(record?.outputBytes) ? record.outputBytes : null;
  const windows = Array.isArray(bytes?.windows) ? bytes.windows : [];
  const inputSha = text(record?.inputSha256) || text(input.sha256);
  const outputSha = text(record?.outputSha256) || text(output.sha256);
  const method = methodSummary(provenance.method);
  const inputLine = [
    text(input.name),
    finite(input.bytes) === null ? null : formatBytes(input.bytes),
  ].filter(Boolean).join(' · ');
  const outputLine = [
    text(output.name),
    text(output.source),
    finite(output.bytes) === null ? null : formatBytes(output.bytes),
  ].filter(Boolean).join(' · ');
  const bytesRead = finite(bytes?.bytesRead);
  const bytesSize = finite(bytes?.size);
  const bytesLine = bytesRead === null
    ? null
    : `${bytesRead}${bytesSize === null ? '' : ` of ${bytesSize}`} bytes${bytes?.truncated === true ? ' (truncated)' : ''}`;
  const rows = [
    fieldValue('Run id', safeText(record?.id), 'run-id'),
    fieldValue('Provenance', safeText(provenance.kind), 'provenance-kind'),
    fieldValue('Method', method ? esc(method) : missingHtml(), 'provenance-method'),
    fieldValue('Input file', inputLine ? esc(inputLine) : missingHtml(), 'provenance-input'),
    fieldValue('Input sha256', inputSha ? `<code>${esc(inputSha)}</code>` : missingHtml(), 'input-sha256'),
    fieldValue('Output file', outputLine ? esc(outputLine) : missingHtml(), 'provenance-output'),
    fieldValue('Output sha256', outputSha ? `<code>${esc(outputSha)}</code>` : missingHtml(), 'output-sha256'),
    fieldValue('Output bytes', bytesLine ? esc(bytesLine) : missingHtml(), 'output-bytes'),
    fieldValue('App version', safeText(app.version), 'app-version'),
    fieldValue('App commit', safeText(app.commit), 'app-commit'),
  ];
  if (windows.length) {
    const windowText = windows.map((window) => {
      const name = text(window?.name) || 'window';
      const start = finite(window?.start);
      const end = finite(window?.end);
      return start !== null && end !== null ? `${name} ${start}-${end}` : name;
    }).join(' · ');
    rows.push(fieldValue('Parser windows', esc(windowText), 'output-windows'));
  }
  return '<details class="results-provenance"><summary>Provenance'
    + '<span>hashes, versions, method</span></summary>'
    + kv(rows, 'results-kv results-kv-wide')
    + '</details>';
}

/* ── Public pure renderer ──────────────────────────────────── */

/**
 * Render one run record. Missing sections are omitted or marked
 * "not reported"; nothing is derived from a field the record does not carry.
 */
export function resultsPanelHtml(record) {
  if (!isObject(record)) return emptyStateHtml();
  const parsed = isObject(record.parsed) ? record.parsed : {};
  const gates = isObject(record.gates) ? record.gates : null;
  const flags = flagsFor(record);
  const status = statusOf(record);
  const engineId = engineOf(record, parsed);
  const engineLabel = engineId
    ? (Object.hasOwn(ENGINE_LABELS, engineId) ? ENGINE_LABELS[engineId] : engineId)
    : null;
  const overall = gates ? gateResult(gates.overall) : null;
  const title = text(record.title);

  const badges = [
    `<span class="results-badge is-status-${esc(status)}" data-role="run-status">${esc(status)}</span>`,
    overall ? `<span class="results-badge is-gates-${overall}" data-role="gates-overall">gates ${esc(overall)}</span>` : '',
    flags.fixture ? '<span class="results-badge is-fixture" data-role="fixture-badge">FIXTURE</span>' : '',
    flags.truncated ? '<span class="results-badge is-truncated" data-role="truncated-badge">TRUNCATED</span>' : '',
  ].filter(Boolean).join('');

  const banners = [
    flags.fixture
      ? '<p class="results-banner is-fixture" data-role="fixture-banner">Fixture output — synthetic dry-run data, not a real calculation. Treat every number below as test data.</p>'
      : '',
    flags.truncated
      ? `<p class="results-banner is-truncated" data-role="truncation-banner">${esc(truncationBanner(flags.bytes))}</p>`
      : '',
  ].filter(Boolean).join('');

  const cards = [
    runCard(record, parsed, status, engineLabel),
    programCard(parsed, flags),
    energyCard(parsed, flags),
    thermochemistryCard(parsed, flags),
    methodsCard(record),
    frequenciesCard(parsed, flags),
    chargesCard(parsed, flags),
    t1Card(parsed, flags),
    resourcesCard(parsed, flags),
    errorCard(record, parsed),
    gatesCard(gates),
  ].filter(Boolean).join('');

  return `<section class="results-panel" data-status="${esc(status)}"`
    + ` data-engine="${engineId ? esc(engineId) : ''}"`
    + ` data-fixture="${flags.fixture}" data-truncated="${flags.truncated}"`
    + ' aria-label="Parsed results">'
    + '<header class="results-head"><div class="results-head-copy">'
    + `<span class="results-eyebrow">Results · ${esc(engineLabel || MISSING_TEXT)}`
    + `${text(record.id) ? ` · ${esc(record.id)}` : ''}</span>`
    + `<h3 class="results-title">${title ? esc(title) : 'Untitled run'}</h3>`
    + `</div><div class="results-badges">${badges}</div></header>`
    + (banners ? `<div class="results-banners">${banners}</div>` : '')
    + `<div class="results-grid">${cards}</div>`
    + provenanceBlock(record)
    + '</section>';
}

/* ── Console wiring ────────────────────────────────────────── */

async function findRun(desktop, runId) {
  if (!runId || !desktop?.listRuns) return null;
  try {
    const runs = await desktop.listRuns();
    return Array.isArray(runs) ? runs.find((run) => run?.id === runId) || null : null;
  } catch {
    return null;
  }
}

function isQueueRunning(doc) {
  return Boolean(doc?.getElementById('queue-state')?.classList.contains('is-running'));
}

/**
 * Wire the results surface into the existing run console.
 *
 * The module subscribes to the same run/queue events as `app.js`; a finished
 * run updates the panel without `app.js` having to pass records around.
 * Clicking a row in "Recent runs" or the workflow queue loads that run's
 * `run.json` through `desktop.listRuns()` and renders it.
 */
export function installResultsView({
  desktop = globalThis.window?.desktop ?? null,
  doc = globalThis.document,
} = {}) {
  if (!doc) return null;
  const container = doc.getElementById('run-results');
  if (!container) return null;
  if (container.dataset.resultsViewInstalled === 'true') return null;
  container.dataset.resultsViewInstalled = 'true';

  const consoleEl = container.closest('.run-console');
  let currentRecord = null;
  installStyles(doc);

  const show = (record) => {
    if (!isObject(record)) {
      currentRecord = null;
      container.hidden = true;
      container.innerHTML = '';
      consoleEl?.classList.remove('has-results');
      return;
    }
    currentRecord = record;
    container.innerHTML = resultsPanelHtml(record);
    container.hidden = false;
    consoleEl?.classList.add('has-results');
  };

  const showUnavailable = (runId) => {
    currentRecord = null;
    container.innerHTML = '<div class="results-empty"><span class="results-eyebrow">Results</span>'
      + `<p>Run ${esc(runId)} could not be loaded from the run folder.</p></div>`;
    container.hidden = false;
    consoleEl?.classList.add('has-results');
  };

  const markSelected = (element) => {
    for (const item of doc.querySelectorAll('#run-history [data-run-id], #queue-list [data-run-id]')) {
      item.classList.remove('is-selected');
      item.removeAttribute('aria-current');
    }
    if (element) {
      element.classList.add('is-selected');
      element.setAttribute('aria-current', 'true');
    }
  };

  const openRun = async (runId, element) => {
    if (!text(runId)) return;
    const record = await findRun(desktop, runId);
    if (record) {
      show(record);
      markSelected(element);
    } else {
      showUnavailable(runId);
    }
  };

  const onClick = (event) => {
    const item = event.target?.closest?.('[data-run-id]');
    if (!item) return;
    const runId = item.getAttribute('data-run-id');
    if (!runId) return;
    openRun(runId, item);
  };

  const onKeyDown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const item = event.target?.closest?.('[data-run-id]');
    if (!item) return;
    event.preventDefault();
    const runId = item.getAttribute('data-run-id');
    if (runId) openRun(runId, item);
  };

  doc.getElementById('run-history')?.addEventListener('click', onClick);
  doc.getElementById('run-history')?.addEventListener('keydown', onKeyDown);
  doc.getElementById('queue-list')?.addEventListener('click', onClick);
  doc.getElementById('queue-list')?.addEventListener('keydown', onKeyDown);

  desktop?.onRunEvent?.((event) => {
    if (!event) return;
    if (event.type === 'done' && isObject(event.record)) {
      show(event.record);
      return;
    }
    // A new single run replaces the previous result. A queued workflow keeps
    // whatever result is being inspected until one of its tasks finishes;
    // otherwise every queued step would blank the panel.
    if (event.type === 'started' && !isQueueRunning(doc)) show(null);
  });

  return {
    show,
    get record() {
      return currentRecord;
    },
    refresh: async (runId) => {
      const record = await findRun(desktop, runId);
      if (record) show(record);
    },
  };
}

/* ── Styles ────────────────────────────────────────────────── */

function installStyles(doc) {
  if (!doc?.head || doc.getElementById(RESULTS_VIEW_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = RESULTS_VIEW_STYLE_ID;
  style.textContent = RESULTS_VIEW_CSS;
  doc.head.appendChild(style);
}

/**
 * Kept here rather than in `styles.css` so the results surface ships as one
 * module. It only uses the existing tokens and adds no second design system.
 */
const RESULTS_VIEW_CSS = `
.run-console.has-results {
  width: min(980px, calc(100vw - 36px));
  height: min(940px, calc(100vh - 70px));
  max-height: min(940px, calc(100vh - 70px));
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) minmax(200px, 42%);
}
.run-console.has-results .run-body { min-height: 0; overflow-y: auto; }
.run-results {
  min-height: 0; overflow-y: auto; padding: 12px 14px 14px;
  border-top: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel) 72%, transparent);
}
.results-panel { display: flex; flex-direction: column; gap: 10px; font-size: 10.5px; color: var(--text); }
.results-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.results-head-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.results-title { font-size: 14px; font-weight: 650; letter-spacing: -.01em; line-height: 1.3; overflow-wrap: anywhere; }
.results-badges { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.results-badge {
  font-size: 8.5px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase;
  padding: 3px 7px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted);
  white-space: nowrap;
}
.results-badge.is-status-completed, .results-badge.is-gates-pass { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, var(--line)); }
.results-badge.is-status-failed, .results-badge.is-gates-fail { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, var(--line)); }
.results-badge.is-status-needs-review, .results-badge.is-status-running,
.results-badge.is-gates-unknown { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 45%, var(--line)); }
.results-badge.is-status-cancelled, .results-badge.is-status-unknown { color: var(--muted); }
.results-badge.is-fixture { color: var(--amber); background: rgba(251, 191, 36, .08); border-color: rgba(251, 191, 36, .4); }
.results-badge.is-truncated { color: var(--red); background: rgba(251, 113, 133, .08); border-color: rgba(251, 113, 133, .42); }
.results-banners { display: flex; flex-direction: column; gap: 6px; }
.results-banner {
  margin: 0; padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px;
  font-size: 9.5px; line-height: 1.45;
}
.results-banner.is-fixture { color: #fcd34d; background: rgba(251, 191, 36, .07); border-color: rgba(251, 191, 36, .34); }
.results-banner.is-truncated { color: #fda4af; background: rgba(251, 113, 133, .07); border-color: rgba(251, 113, 133, .36); }
.results-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.results-card {
  min-width: 0; padding: 9px 10px; border: 1px solid var(--line); border-radius: 9px;
  background: color-mix(in srgb, var(--panel-2) 52%, transparent);
}
.results-card.is-wide { grid-column: 1 / -1; }
.results-card.is-error { border-color: color-mix(in srgb, var(--red) 30%, var(--line)); }
.results-methods-text {
  margin: 0; white-space: pre-wrap; overflow-wrap: anywhere;
  color: var(--text); font: 9.5px/1.5 var(--mono);
}
.results-card-title {
  margin-bottom: 6px; color: var(--muted); font-size: 8.5px; font-weight: 700;
  letter-spacing: .1em; text-transform: uppercase;
}
.results-kv { display: grid; grid-template-columns: minmax(92px, 40%) minmax(0, 1fr); gap: 3px 9px; }
.results-kv-wide { grid-template-columns: minmax(86px, 18%) minmax(0, 1fr); }
.results-kv dt { color: var(--muted); font-size: 9.5px; }
.results-kv dd { margin: 0; min-width: 0; font: 9.5px/1.45 var(--mono); overflow-wrap: anywhere; }
.results-kv dd code { font: inherit; }
.results-missing { color: var(--faint); font: italic 9.5px/1.45 var(--sans); }
.results-route {
  display: block; margin-top: 7px; padding: 6px 7px; border: 1px solid var(--line);
  border-radius: 6px; background: #080b11; color: #c8d2e0;
  font: 9.5px/1.45 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere;
}
.results-chip, .results-gate {
  display: inline-block; padding: 2px 6px; border: 1px solid var(--line);
  border-radius: 999px; font: 8.5px/1.35 var(--mono); text-transform: lowercase;
}
.results-chip.is-status-completed, .results-gate.is-pass { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, var(--line)); }
.results-chip.is-status-failed, .results-gate.is-fail { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, var(--line)); }
.results-chip.is-status-needs-review, .results-chip.is-status-running,
.results-chip.is-status-unknown, .results-gate.is-unknown { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 40%, var(--line)); }
.results-note { margin: 6px 0 0; color: var(--faint); font-size: 9px; line-height: 1.45; }
.results-big { margin: 2px 0 0; font: 15px/1.35 var(--mono); color: var(--text); }
.results-modes { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 3px 6px; }
.results-mode { font: 9.5px/1.35 var(--mono); color: var(--text); }
.results-mode.is-imaginary { color: var(--red); }
.results-unit { color: var(--faint); font-size: 8.5px; }
.results-table { width: 100%; border-collapse: collapse; margin-top: 4px; font: 9px/1.5 var(--mono); }
.results-table th {
  padding: 3px 4px; border-bottom: 1px solid var(--line); color: var(--muted);
  font: 600 8.5px/1.4 var(--sans); text-align: left; letter-spacing: .03em;
}
.results-table td { padding: 2px 4px; border-bottom: 1px solid rgba(148, 163, 184, .07); vertical-align: top; overflow-wrap: anywhere; }
.results-table tbody tr:last-child td { border-bottom: 0; }
.results-gate-table td { font-family: var(--sans); }
.results-gate-table td:nth-child(2) { width: 64px; }
.results-gate-table td:nth-child(3) { color: var(--muted); font-family: var(--mono); font-size: 8.5px; }
.results-gates-head { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.results-gate-optional { color: var(--faint); font: 8px/1.3 var(--sans); text-transform: uppercase; letter-spacing: .05em; }
.results-caveat { margin: 7px 0 0; color: var(--amber); font-size: 9px; line-height: 1.45; }
.results-charge-block + .results-charge-block { margin-top: 8px; }
.results-charge-title {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  color: var(--text); font-size: 9px; font-weight: 600;
}
.results-charge-title span { color: var(--faint); font-size: 8.5px; font-weight: 400; }
.results-charge-table th:first-child, .results-charge-table td:first-child { width: 42px; }
.results-pre {
  margin: 7px 0 0; padding: 7px; max-height: 110px; overflow: auto; border-radius: 6px;
  background: #080b11; color: #c8d2e0; font: 9px/1.5 var(--mono); white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.results-provenance { border-top: 1px solid var(--line); padding-top: 7px; }
.results-provenance summary {
  cursor: pointer; color: var(--muted); font-size: 9px; letter-spacing: .08em;
  text-transform: uppercase;
}
.results-provenance summary span {
  margin-left: 8px; color: var(--faint); letter-spacing: 0; text-transform: none;
}
.results-empty { padding: 4px 0; }
.results-empty p { margin-top: 4px; color: var(--muted); font-size: 10px; }
#run-history [data-run-id]:not([data-run-id=""]),
#queue-list [data-run-id]:not([data-run-id=""]) { cursor: pointer; }
#run-history [data-run-id]:not([data-run-id=""]):hover,
#queue-list [data-run-id]:not([data-run-id=""]):hover { border-color: var(--line-2); }
#run-history .queue-item.is-selected, #queue-list .queue-item.is-selected {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--line));
  background: color-mix(in srgb, var(--accent) 12%, var(--panel-2));
}
@media (max-width: 820px) {
  .run-console.has-results {
    right: 0; bottom: 0; width: 100%; height: 92dvh; max-height: 92dvh;
    border-radius: 14px 14px 0 0;
    grid-template-rows: auto minmax(0, 1fr) minmax(150px, 46%);
  }
  .results-grid { grid-template-columns: 1fr; }
  .results-kv, .results-kv-wide { grid-template-columns: minmax(84px, 38%) minmax(0, 1fr); }
}
`;
