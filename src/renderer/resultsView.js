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
import { explainRunFailure } from '../shared/errorSignatures.js';
import { compareRuns, comparisonHtml } from '../shared/runCompare.js';
import { broadenedSpectrum, spectrumPolyline } from '../shared/spectrum.js';
import { ircGate, pathBarrier, profileSvg, profilePoints, scanExtremum, scanSurfaceSvg } from '../shared/reactionPath.js';
import {
  RADIATIVE_NOT_MODELLED, buildKinetics, kineticsSummaryLine,
  radiativeKineticsReport, radiativeKineticsSummary,
} from '../shared/kinetics.js';
import { pkaCycle, pkaCycleLine, redoxCycle, redoxCycleLine } from '../shared/pka.js';
import { trajectoryEnergies, trajectorySvg } from '../shared/trajectory.js';
import { mountSuperposition } from './superpositionCard.js';
import { mountWavefunctionViewport } from './wavefunctionViewport.js';
import { elementForNucleus, nmrPolyline, nmrShifts, nmrSpectrum, parseShieldings } from '../shared/nmr.js';
import { ramanPolyline, ramanSpectrum } from '../shared/raman.js';
import { VCD_DIPOLE_UNITS, VCD_UNITS, vcdPolyline, vcdSpectrum } from '../shared/vcd.js';
import { ecdPolyline, ecdSpectrum } from '../shared/ecd.js';
import { scaleToSpectrum } from '../shared/overlay.js';
import {
  fromEcd, fromNmr, fromRaman, fromUvVis, fromVcd, orbitalLevelsFigure,
} from '../shared/figures/index.js';
import {
  importMeasuredSpectrum, importSpectrumText, overlayFromRecord, placeMeasuredOverlay,
  sameAxisUnits, spectrumOverlayField,
} from '../shared/spectrumImport.js';
import { thermoAt, ensembleThermo } from '../shared/thermoSweep.js';
import { IMPORTED_BADGE_TEXT, importedBadgeHtml, importedSummary } from '../shared/importedRecord.js';
import { UNVERIFIED_ESOPT_NOTE, excitedStateGate } from '../shared/excitedStates.js';

const MISSING_TEXT = 'not reported';

const ENGINE_LABELS = Object.freeze({
  gaussian: 'Gaussian 16',
  xtb: 'xTB (GFN-xTB)',
  orca: 'ORCA',
  psi4: 'Psi4',
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
  // The parser's own `truncated` flag is authoritative: a windowed read covers
  // the file without reading every byte, so `bytesRead < size` alone is not
  // evidence of a partial parse.
  const truncated = record?.truncated === true
    || parsed.complete === false
    || bytes?.truncated === true
    || (bytes?.truncated !== false && size !== null && bytesRead !== null && bytesRead < size);
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

/**
 * SAPT is an interaction energy, not a total energy for the complex: the parser
 * deliberately leaves `finalEnergy` empty for it. This card is the only place
 * the components are shown, and it says what the number is.
 */
function saptCard(parsed, flags) {
  const sapt = isObject(parsed?.sapt) ? parsed.sapt : (isObject(parsed?.extras?.sapt) ? parsed.extras.sapt : null);
  if (!sapt) return '';
  const kjm = (value) => (Number.isFinite(value) ? `${value.toFixed(2)} kJ/mol` : missingHtml());
  const rows = [
    fieldValue('SAPT0 total', Number.isFinite(sapt.totalKj) ? `<strong>${esc(sapt.totalKj.toFixed(2))} kJ/mol</strong>` : missingHtml(), 'sapt-total'),
    fieldValue('kcal/mol', Number.isFinite(sapt.totalKcal) ? esc(sapt.totalKcal.toFixed(2)) : missingHtml(), 'sapt-kcal'),
    fieldValue('Electrostatics', kjm(sapt.electrostaticMha === null ? null : sapt.electrostaticMha * 2.6254996394799), 'sapt-electrostatics'),
    fieldValue('Exchange', kjm(sapt.exchangeMha === null ? null : sapt.exchangeMha * 2.6254996394799), 'sapt-exchange'),
    fieldValue('Induction', kjm(sapt.inductionMha === null ? null : sapt.inductionMha * 2.6254996394799), 'sapt-induction'),
    fieldValue('Dispersion', kjm(sapt.dispersionMha === null ? null : sapt.dispersionMha * 2.6254996394799), 'sapt-dispersion'),
  ];
  return card('SAPT', kv(rows)
    + '<p class="results-note">SAPT0 reports the interaction energy for the fragments in this geometry, '
    + 'not a total energy for the complex. The components are additive within SAPT0.</p>'
    + caveatHtml(flags, 'The SAPT decomposition'));
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

/** The six terms the workbench can switch on and off, in display order. */
const THERMO_TERMS = Object.freeze([
  { id: 'zero-point', label: 'Zero-point energy' },
  { id: 'translational', label: 'Translational (3kT/2)' },
  { id: 'rotational', label: 'Rotational (3RT/2)' },
  { id: 'vibrational', label: 'Vibrational thermal' },
  { id: 'pv', label: 'pV = RT' },
  { id: 'entropy', label: '−TΔS' },
]);

/**
 * One source for the on-screen table and the CSV, so the export cannot drift
 * from what the panel shows.
 */
export function thermoTableData(parsed, { temperatureK = 298.15, pressureAtm = 1, enabled = null } = {}) {
  const active = enabled || new Set(THERMO_TERMS.map((term) => term.id));
  let result;
  try {
    result = thermoAt(parsed, { temperatureK, pressureAtm });
  } catch (error) {
    return { available: false, reason: error.message, terms: [], totalKcalPerMol: null };
  }
  if (!result.available) {
    return {
      available: false,
      reason: `Not recomputed: this output has no ${result.missing.join(', ')}.`,
      missing: result.missing,
      terms: [],
      totalKcalPerMol: null,
    };
  }
  const terms = result.terms
    .filter((term) => active.has(term.id))
    .map((term) => ({ id: term.id, label: term.label, kcalPerMol: term.kcalPerMol }));
  const totalKcalPerMol = terms.reduce((sum, term) => sum + term.kcalPerMol, 0);
  return {
    available: true,
    temperatureK: result.temperatureK,
    pressureAtm: result.pressureAtm,
    standardState: result.standardState,
    geometry: result.geometry,
    entropyCalPerMolK: result.totals.entropyCalPerMolK,
    terms,
    totalKcalPerMol,
    gibbsHartree: result.absolute.electronicEnergyHartree === null
      ? null
      : result.absolute.electronicEnergyHartree + totalKcalPerMol / 627.5094740631,
  };
}

function thermoWorkbenchHtml(parsed, options) {
  const data = thermoTableData(parsed, options);
  if (!data.available) {
    return `<p class="results-missing" data-field="thermo-workbench">${esc(data.reason)}</p>`;
  }
  const rows = data.terms.map((term) => '<tr>'
    + `<td>${esc(term.label)}</td>`
    + `<td>${term.kcalPerMol < 0 ? '−' : ''}${Math.abs(term.kcalPerMol).toFixed(3)}</td>`
    + '</tr>').join('');
  return '<table class="thermo-table" data-field="thermo-workbench">'
    + '<thead><tr><th>Term</th><th class="num">kcal mol⁻¹</th></tr></thead>'
    + `<tbody>${rows}</tbody>`
    + '<tfoot>'
    + `<tr><th>Σ correction to G</th><th class="num">${data.totalKcalPerMol < 0 ? '−' : ''}${Math.abs(data.totalKcalPerMol).toFixed(3)}</th></tr>`
    + `<tr><th>G = E<sub>elec</sub> + Σ / Eh</th><th class="num">${data.gibbsHartree === null ? MISSING_TEXT : data.gibbsHartree.toFixed(6)}</th></tr>`
    + '</tfoot></table>'
    + `<p class="results-note">RRHO at ${esc(String(data.temperatureK))} K and ${esc(String(data.pressureAtm))} atm, `
    + `recomputed from the mass, rotational constants, symmetry number (${esc(String(data.geometry))}) and frequencies. `
    + 'Standard state for the printed table: 298.15 K, 1 atm. Electronic excitation is not modelled.</p>';
}

function ensembleTableHtml(rows, { temperatureK = 298.15, selected = [] } = {}) {
  const chosen = rows.filter((row) => selected.includes(row.id));
  const result = ensembleThermo(chosen, { temperatureK });
  if (!result.available) {
    return `<p class="results-missing" data-field="thermo-ensemble">${esc(result.reason)}</p>`;
  }
  const body = result.entries.map((entry) => '<tr>'
    + `<td>${esc(entry.label)}</td>`
    + `<td class="num">${entry.relativeKcalPerMol.toFixed(3)}</td>`
    + `<td class="num">${(entry.population * 100).toFixed(1)} %</td>`
    + '</tr>').join('');
  return '<table class="thermo-table" data-field="thermo-ensemble">'
    + '<thead><tr><th>Run</th><th class="num">ΔG / kcal mol⁻¹</th><th class="num">Population</th></tr></thead>'
    + `<tbody>${body}</tbody></table>`
    + `<p class="results-note">Boltzmann populations at ${esc(String(temperatureK))} K · ensemble G `
    + `= lowest + ${result.ensembleRelativeKcalPerMol.toFixed(3)} kcal mol⁻¹. `
    + 'This assumes the selected runs are conformers of one species at one level of theory; '
    + 'nothing checks that assumption for you.</p>';
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
  const defaultTemperature = temperature === null ? 298.15 : temperature;
  const defaultPressure = pressure === null ? 1 : pressure;
  // The workbench only appears when the output carries what the partition
  // function needs; otherwise the card above already says "not reported".
  const workbench = Array.isArray(thermo.rotationalConstantsGHz) && finite(thermo.molecularMassAmu) !== null
    ? '<div class="thermo-workbench" data-role="thermo-workbench">'
      + '<div class="thermo-controls">'
      + `<label>T / K <input type="number" data-thermo-temperature value="${esc(String(defaultTemperature))}" step="0.01" min="1"></label>`
      + `<label>p / atm <input type="number" data-thermo-pressure value="${esc(String(defaultPressure))}" step="0.01" min="0.0001"></label>`
      + THERMO_TERMS.map((term) => `<label class="thermo-term"><input type="checkbox" data-thermo-term="${esc(term.id)}" checked> ${esc(term.label)}</label>`).join('')
      + '<button type="button" class="btn small" data-thermo-export>Export CSV</button>'
      + '</div>'
      + `<div data-field="thermo-workbench-holder">${thermoWorkbenchHtml(parsed, {
        temperatureK: defaultTemperature, pressureAtm: defaultPressure,
      })}</div>`
      + '<h4>Conformer ensemble</h4>'
      + '<div data-field="thermo-ensemble-picker"><p class="results-note">Pick two or more finished runs to compute Boltzmann populations.</p></div>'
      + '<div data-field="thermo-ensemble-holder"></div>'
      + '</div>'
    : '';
  return card('Thermochemistry', kv(rows)
    + (conditions ? `<p class="results-note" data-field="thermo-conditions">${esc(conditions)}</p>` : '')
    + workbench
    + caveatHtml(flags, 'Thermochemistry'), workbench ? 'is-wide' : '');
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
  // Offline signature table: an explanation is only shown when a signature
  // actually matched. An unmatched failure says so instead of guessing.
  const diagnosis = explainRunFailure(record);
  if (diagnosis?.matched && diagnosis.explanation) {
    const { title, cause, action, docs } = diagnosis.explanation;
    blocks.push(
      '<div class="results-diagnosis" data-field="error-explanation"'
      + ` data-signature="${esc(diagnosis.signature.id)}" data-severity="${esc(diagnosis.severity)}">`
      + `<h5 class="results-diagnosis-title">${esc(title)}</h5>`
      + `<p class="results-diagnosis-cause">${esc(cause)}</p>`
      + `<p class="results-diagnosis-action"><strong>Next step:</strong> ${esc(action)}</p>`
      + '</div>',
    );
  } else if (errorTermination || runnerError) {
    blocks.push(`<p class="results-missing" data-field="error-explanation">No known signature matched this failure. Read the cause line above; nothing is inferred.</p>`);
  }
  if (!blocks.length) {
    blocks.push(`<p class="results-missing" data-field="error-cause">${MISSING_TEXT}</p>`);
  }
  return card('Error termination', blocks.join(''), 'is-wide is-error');
}

/**
 * Emission (#75). The same excitation table means absorption at the ground-state
 * minimum and vertical emission at the excited minimum; only the workflow knows
 * which one this run is, so the label comes from the task and not from the log.
 */
function emissionLine(record, parsed) {
  const emission = record?.task?.emission;
  const states = Array.isArray(parsed?.excitedStates?.states) ? parsed.excitedStates.states : [];
  if (!emission || states.length === 0) return '';
  const first = states[0];
  const energy = Number(first.energyEv);
  const nm = Number(first.wavelengthNm);
  if (!Number.isFinite(energy) && !Number.isFinite(nm)) return '';
  return '<p class="results-note" data-field="emission">'
    + `<strong>${esc(emission.quantity)}</strong> from `
    + `<code>${esc(emission.sourceNodeId)}</code>${emission.root ? ` (root ${esc(emission.root)})` : ''}: `
    + `${Number.isFinite(energy) ? `${esc(energy.toFixed(4))} eV` : ''}`
    + `${Number.isFinite(energy) && Number.isFinite(nm) ? ' · ' : ''}`
    + `${Number.isFinite(nm) ? `${esc(nm.toFixed(2))} nm` : ''}. `
    + 'This is a vertical energy at the excited minimum, not the adiabatic 0–0 energy, which '
    + 'also needs the zero-point energy of both surfaces.</p>';
}

/**
 * Vertical emission (issue 146).
 *
 * The emission block is an SP TD job whose whole purpose is the energy at the
 * geometry it receives. The card prints the three quantities the log carries
 * for the emitting state — λ_em, E and f — and names what it does **not**
 * report. The label is only printed as belonging to an optimised excited state
 * when the graph supports it; otherwise the card says which geometry it used.
 */
function emissionCard(parsed, flags, emission) {
  if (!isObject(emission) || emission.block !== 'emission') return '';
  const states = Array.isArray(parsed?.excitedStates?.states)
    ? parsed.excitedStates.states.filter(isObject)
    : [];
  const emitting = states.find((state) => Number(state.index) === 1) || null;
  const wavelength = finite(emitting?.wavelengthNm);
  const energy = finite(emitting?.energyEv);
  const strength = finite(emitting?.oscillatorStrength);
  const reason = states.length === 0
    ? 'the output carries no excited-state table'
    : 'the Excited State 1 row of the table is incomplete';
  const orMissing = (value, digits, unit) => (value === null
    ? `${missingHtml()} <span class="results-missing">(${esc(reason)})</span>`
    : `${esc(value.toFixed(digits))} ${esc(unit)}`);
  const rows = [
    ['Excited state', '1 (the emitting state)', 'emission-root'],
    ['λ_em', orMissing(wavelength, 2, 'nm'), 'emission-wavelength'],
    ['E', orMissing(energy, 4, 'eV'), 'emission-energy'],
    ['f', orMissing(strength, 4, ''), 'emission-oscillator-strength'],
  ];
  const origin = emission.geometryHandoff === 'checkpoint'
    ? `Geometry handed over from <code>${esc(emission.sourceNodeId || 'an unnamed block')}</code> over a checkpoint edge.`
    : (emission.sourceNodeId
      ? `No checkpoint edge supplies the geometry: the run used the block's own input geometry, and `
        + `<code>${esc(emission.sourceNodeId)}</code> only ordered it. `
      : 'No upstream block is connected, so the geometry provenance is not recorded. ');
  const supported = emission.sourceIsExcitedStateOptimization === true
    ? ''
    : 'The graph does not connect this block to an excited-state optimisation, so the vertical-emission '
      + 'reading is not supported by the workflow it was run in. ';
  return card('Vertical emission', `<p class="results-note" data-field="emission-quantity">`
    + 'The values below are the <strong>vertical emission from the optimised excited state</strong> — '
    + `${emitting ? `Excited State ${esc(emitting.index)}, the state the block pins with <code>Root=1</code>` : 'the emitting state (<code>Root=1</code>)'} `
    + 'at one geometry.</p>'
    + kv(rows)
    + `<p class="results-note">${origin}${supported}`
    + 'A vertical energy at the excited-state geometry is <em>not</em> the adiabatic 0–0 energy: the latter '
    + 'also needs the zero-point energy of both surfaces, which this workflow does not compute.</p>'
    + '<p class="results-note" data-field="emission-not-reported"><strong>Not reported:</strong> fluorescence '
    + 'lifetime, fluorescence quantum yield, and a Stokes shift against an experimental band maximum. '
    + 'Gaussian 16 does not print the first two for this workflow, and the third needs a measured spectrum '
    + 'this run does not contain. The <strong>Excited states</strong> card prints the radiative-only '
    + 'lifetime derived from f — an upper bound on the observed lifetime, not a fluorescence lifetime.</p>'
    + caveatHtml(flags, 'These emission values'), 'is-wide');
}

/**
 * NTO analysis (issue 146). The two-job chain is written honestly; the printed table
 * is **not** parsed, because no real NTO log exists in this repository and
 * guessing the layout is exactly what the project forbids. The card says so
 * rather than showing a half-read orbital pair.
 */
function ntoCard(flags, nto) {
  if (!isObject(nto)) return '';
  const transition = finite(nto.transition);
  const states = finite(nto.states);
  const chain = [
    ['1. TD job (writes the checkpoint)', `#p &lt;method&gt;/&lt;basis&gt; SP TD=(NStates=${states === null ? 'n' : esc(states)}) `
      + `Density=(Check,Transition=${transition === null ? 'k' : esc(transition)})`, 'nto-first-route'],
    ['2. NTO job (this block)', '#p &lt;method&gt;/&lt;basis&gt; Guess=Only Pop=NTO', 'nto-second-route'],
  ];
  const rows = chain.map(([label, route, field]) => [label,
    `<code data-field="${field}">${route}</code>`]);
  return card('Natural transition orbitals', kv(rows)
    + `<p class="results-missing" data-field="nto-table">The printed NTO table is not parsed by this build: `
    + 'no real NTO log exists in this repository, so the eigenvalue/occupation layout has not been verified. '
    + `The NTO pair${transition === null ? '' : ` for transition ${esc(transition)}`} is therefore `
    + '<strong>not reported</strong>.</p>'
    + caveatHtml(flags, 'This NTO request'), 'is-wide');
}

/**
 * Excited-state optimisation (issue 146).
 *
 * `parsed.excitedStateOptimization` comes from `parseExcitedStateOptimization`,
 * which has never seen a real Opt TD log (none exists in the repository). The
 * card repeats that sentence next to the convergence verdict and never turns a
 * missing marker into a pass: `converged` is true / false / unknown exactly as
 * the parser reports it.
 */
function excitedStateOptimizationCard(parsed, flags, settings) {
  const report = isObject(parsed?.excitedStateOptimization) ? parsed.excitedStateOptimization : null;
  const jobType = String(settings?.jobType || '');
  const states = Number(settings?.tdStates ?? 0);
  const requestedRoot = Number(settings?.tdRoot ?? 0);
  const isEsOpt = /^Opt/.test(jobType) && states > 0;
  if (!isEsOpt && !(report && report.applicable === true)) return '';
  const unverified = `<p class="results-caveat" data-field="esopt-unverified">${esc(UNVERIFIED_ESOPT_NOTE)}. `
    + 'The parser is written from the Gaussian output documentation and the real TD single-point table in the '
    + 'test corpus; no real <code>Opt TD</code> log has been checked against it, so treat the convergence '
    + 'verdict as unverified.</p>';
  if (!report || report.applicable !== true) {
    return card('Excited-state optimisation',
      `<p class="results-missing" data-field="esopt-report">Whether root ${esc(requestedRoot > 0 ? requestedRoot : 'n')} `
      + 'converged is not reported: the output carries no excited-state optimisation ladder.</p>'
      + unverified, 'is-wide');
  }
  const gate = excitedStateGate(report, { requestedRoot: requestedRoot > 0 ? requestedRoot : null });
  const root = report.root === null ? null : finite(report.root);
  const convergedText = report.converged === true ? 'yes — Optimization completed'
    : report.converged === false ? 'no — the optimisation stopped before its criteria'
      : 'unknown';
  const rows = [
    ['Root followed', root === null ? missingHtml() : esc(root), 'esopt-root'],
    ['Converged', esc(convergedText), 'esopt-converged'],
    ['Why', esc(report.convergedReason || MISSING_TEXT), 'esopt-converged-reason'],
    ['Steps read', `${esc(report.steps.length)}${report.steps.length === 0 ? ` — ${missingHtml()}` : ''}`, 'esopt-steps'],
    ['excited-state gate', `<span class="results-gate is-${esc(gateResult(gate.result))}">${esc(gateResult(gate.result))}</span>`, 'esopt-gate'],
    ['Gate detail', esc(gate.detail), 'esopt-gate-detail'],
  ];
  const stepRows = report.steps.map((step) => '<tr>'
    + `<td>${esc(step.index)}</td>`
    + `<td>${esc(step.tableIndex)}</td>`
    + `<td>${step.energyEv === null ? missingHtml() : esc(step.energyEv.toFixed(4))}</td>`
    + `<td>${step.energyHartree === null ? `${missingHtml()} <span class="results-missing">(the log prints the TD total energy only for the state being optimised)</span>` : esc(step.energyHartree)}</td>`
    + `<td>${step.geometry === null ? `${missingHtml()} <span class="results-missing">(per-step geometry is not parsed)</span>` : esc(step.geometry)}</td>`
    + '</tr>').join('');
  const stepsTable = report.steps.length === 0 ? ''
    : '<table class="results-table" data-field="esopt-steps"><thead><tr><th>#</th><th>Step</th><th>E (eV)</th>'
      + '<th>E (Eh)</th><th>Geometry</th></tr></thead><tbody>' + stepRows + '</tbody></table>';
  const finalStates = Array.isArray(report.finalTable?.states) ? report.finalTable.states : [];
  const finalRows = finalStates.slice(0, 20).map((state) => (
    `<tr${Number(state.index) === root ? ' class="is-root" data-root-row="true"' : ''}>`
    + `<td>${esc(state.index)}</td>`
    + `<td>${state.energyEv === null ? missingHtml() : esc(state.energyEv.toFixed(4))}</td>`
    + `<td>${state.wavelengthNm === null ? missingHtml() : esc(state.wavelengthNm.toFixed(2))}</td>`
    + `<td>${state.oscillatorStrength === null ? missingHtml() : esc(state.oscillatorStrength.toFixed(4))}</td>`
    + '</tr>')).join('');
  const finalTable = finalStates.length === 0 ? ''
    : '<table class="results-table" data-field="esopt-final-table"><thead><tr><th>#</th><th>eV</th><th>nm</th>'
      + '<th>f</th></tr></thead><tbody>' + finalRows + '</tbody></table>';
  const meaning = '<p class="results-note">“Converged” here means Gaussian printed '
    + '<code>Optimization completed</code>: its optimisation criteria were met on the potential-energy surface '
    + 'of the root it followed. It does <em>not</em> mean the geometry is a minimum of that surface — proving '
    + 'that needs a frequency job on the excited-state surface, which this block did not run — and it does '
    + 'not mean the 0–0 energy is known.</p>';
  return card('Excited-state optimisation', kv(rows) + stepsTable + finalTable + meaning + unverified
    + caveatHtml(flags, 'This convergence verdict'), 'is-wide');
}

function orbitalsCard(parsed, flags) {
  const orbitals = isObject(parsed?.orbitals) ? parsed.orbitals : null;
  if (!orbitals || orbitals.matched !== true) return '';
  const alpha = isObject(orbitals.alpha) ? orbitals.alpha : null;
  if (!alpha) return '';
  const beta = isObject(orbitals.beta) ? orbitals.beta : null;

  const rows = [
    ['HOMO', (d) => `${esc(d.homoHartree.toFixed(5))} Ha`, (d) => `${esc(d.homoEv.toFixed(3))} eV`],
    ['LUMO', (d) => `${esc(d.lumoHartree.toFixed(5))} Ha`, (d) => `${esc(d.lumoEv.toFixed(3))} eV`],
    ['Gap', null, (d) => `${esc(d.gapEv.toFixed(3))} eV`],
    ['Ionisation potential', null, (d) => `${esc(d.ipEv.toFixed(3))} eV`],
    ['Electron affinity', null, (d) => `${esc(d.eaEv.toFixed(3))} eV`],
    ['Chemical potential (mu)', null, (d) => `${esc(d.muEv.toFixed(3))} eV`],
    ['Electronegativity (chi)', null, (d) => `${esc(d.chiEv.toFixed(3))} eV`],
    ['Hardness (eta)', null, (d) => `${esc(d.etaEv.toFixed(3))} eV`],
    ['Softness (sigma)', null, (d) => (finite(d.softnessPerEv) === null ? MISSING_TEXT : `${esc(d.softnessPerEv.toFixed(3))} 1/eV`)],
    ['Electrophilicity (omega)', null, (d) => (finite(d.electrophilicityEv) === null ? MISSING_TEXT : `${esc(d.electrophilicityEv.toFixed(3))} eV`)],
  ];

  const cell = (fn, descriptor) => (fn ? fn(descriptor) : '');
  const head = `<tr><th>Quantity</th><th>Alpha${beta ? ' (restricted alpha)' : ''}</th>${beta ? '<th>Beta</th>' : ''}</tr>`;
  const body = rows.map(([label, hartreeCell, evCell]) => (
    '<tr>'
    + `<td>${esc(label)}</td>`
    + `<td>${hartreeCell ? `${hartreeCell(alpha)} ` : ''}${cell(evCell, alpha)}</td>`
    + (beta ? `<td>${hartreeCell ? `${hartreeCell(beta)} ` : ''}${cell(evCell, beta)}</td>` : '')
    + '</tr>'
  )).join('');

  const note = '<p class="results-note">Orbital energies as printed by <code>Pop=Full</code>, in hartree and eV. '
    + 'The derived quantities are Koopmans\' estimates: IP = -E(HOMO), EA = -E(LUMO), gap = E(LUMO) - E(HOMO), '
    + 'and mu, chi, eta, sigma and omega follow from those two numbers. They are not Delta-SCF ionisation '
    + 'potentials or electron affinities, which differ by several tenths of an eV.'
    + (beta ? ' The open-shell case keeps the alpha and beta manifolds apart rather than averaging them.' : '')
    + '</p>';

  // The level diagram reads the manifolds when the parser kept them, and falls
  // back to the frontier pair otherwise — never to an invented level.
  const levelsFor = (manifold) => {
    if (!manifold) return [];
    const occupied = Array.isArray(manifold.occupied) ? manifold.occupied.slice(-3) : [];
    const virtual = Array.isArray(manifold.virtual) ? manifold.virtual.slice(0, 3) : [];
    return occupied.map((energyEh) => ({ energyEh, occupation: 2 }))
      .concat(virtual.map((energyEh) => ({ energyEh, occupation: 0 })));
  };
  const alphaLevels = orbitals.manifolds?.alpha ? levelsFor(orbitals.manifolds.alpha) : [];
  const betaLevels = orbitals.manifolds?.beta ? levelsFor(orbitals.manifolds.beta) : [];
  const levelsFigure = (() => {
    if (alphaLevels.length === 0) return '';
    const drawn = orbitalLevelsFigure({ alpha: alphaLevels, beta: betaLevels });
    return drawn ? `<figure class="results-spectrum" data-field="orbital-levels">${drawn.svg}`
      + `<figcaption>${esc(drawn.caption)}</figcaption></figure>` : '';
  })();

  return card(
    'Frontier orbitals',
    note
    + levelsFigure
    + `<table class="results-table" data-field="orbitals"><thead>${head}</thead><tbody>${body}</tbody></table>`
    + caveatHtml(flags, 'These orbital energies'),
    'is-wide',
  );
}

/**
 * Excited states, with the radiative kinetics those states imply (issue 170).
 *
 * The table keeps the printed quantities and adds two derived columns: k_r and
 * its inverse, the *radiative* lifetime. Both are labelled in the header, and
 * the paragraph under the table prints the relation, the wavenumber source and
 * the level of theory, then says what the estimate leaves out. A cell that
 * could not be computed prints `not reported` with the reason; an f = 0 state
 * prints `not finite (f = 0)` rather than a lifetime that does not exist.
 */
function excitedStatesCard(parsed, flags, record = null, overlay = null, overlayNote = '') {
  const block = parsed?.excitedStates;
  const states = Array.isArray(block?.states) ? block.states.filter(isObject) : [];
  if (!Number.isFinite(block?.count) || block.count === 0 || states.length === 0) return '';
  const levelOfTheory = methodSummary(record?.provenance?.method);
  const kinetics = radiativeKineticsReport(states, { levelOfTheory });
  const rows = states.slice(0, 20).map((state, position) => {
    const dominant = Array.isArray(state.transitions) && state.transitions.length
      ? [...state.transitions]
        .sort((a, b) => Math.abs(Number(b.coefficient) || 0) - Math.abs(Number(a.coefficient) || 0))
        .slice(0, 2)
        .map((transition) => `${esc(transition.from)}→${esc(transition.to)} (${esc(Number(transition.coefficient).toFixed(3))})`)
        .join(' · ')
      : MISSING_TEXT;
    const label = [state.spin, state.symmetry].filter(Boolean).join('-');
    const kineticsRow = kinetics.rows[position] || null;
    const unavailable = kineticsRow && !kineticsRow.available
      ? ` <span class="results-missing">(${esc(kineticsRow.reason)})</span>`
      : '';
    const rate = kineticsRow
      ? `${kineticsRow.available ? esc(kineticsRow.rateText) : missingHtml()}${unavailable}`
      : missingHtml();
    const lifetime = kineticsRow && kineticsRow.available
      ? esc(kineticsRow.radiativeLifetimeText)
      : `${missingHtml()}${unavailable}`;
    return '<tr data-excited-state="' + esc(state.index) + '">'
      + `<td>${esc(state.index)}</td>`
      + `<td>${esc(label || MISSING_TEXT)}</td>`
      + `<td>${Number.isFinite(state.energyEv) ? state.energyEv.toFixed(4) : MISSING_TEXT}</td>`
      + `<td>${Number.isFinite(state.wavelengthNm) ? state.wavelengthNm.toFixed(2) : MISSING_TEXT}</td>`
      + `<td>${Number.isFinite(state.oscillatorStrength) ? state.oscillatorStrength.toFixed(4) : MISSING_TEXT}</td>`
      + `<td data-field="radiative-rate">${rate}</td>`
      + `<td data-field="radiative-lifetime">${lifetime}</td>`
      + `<td class="is-left">${dominant}</td>`
      + '</tr>';
  }).join('');
  const body = emissionLine(record, parsed)
    + '<table class="results-table" data-field="excited-states">'
    + '<thead><tr><th>#</th><th>State</th><th>eV</th><th>nm</th><th>f</th>'
    + '<th>k_r (s⁻¹)</th><th>τ_r (radiative)</th>'
    + '<th class="is-left">Dominant transitions</th></tr></thead>'
    + `<tbody>${rows}</tbody></table>`
    + (states.length > 20
      ? `<p class="results-missing">Showing the first 20 of ${esc(block.count)} parsed states.</p>`
      : '')
    + excitedSpectrumHtml(states, overlay, overlayNote)
    + radiativeKineticsHtml(kinetics)
    + caveatHtml(flags, 'These excitation energies and the rates derived from them');
  return card('Excited states', body, 'is-wide');
}

/**
 * The paragraph that keeps τ_r honest: the relation, where ν̄ came from, the
 * level of theory, the strongest channel, and the channels that are not in this
 * calculation at all. The "not modelled" sentence is not a footnote to be
 * dropped — it is the difference between an upper bound and a prediction.
 */
function radiativeKineticsHtml(kinetics) {
  const sources = new Set(kinetics.rows.map((row) => row.wavenumberSource).filter(Boolean));
  const sourceSentence = sources.size === 1
    ? (sources.has('energy')
      ? 'ν̄ comes from the energy column: ν̄ = E(eV) × 8065.544 cm⁻¹.'
      : 'ν̄ comes from the wavelength column: ν̄ = 1 × 10⁷ / λ(nm) cm⁻¹.')
    : 'ν̄ comes from the wavelength column where the table carries one, and from the energy '
      + 'column otherwise.';
  const levelSentence = kinetics.levelOfTheory
    ? `Level of theory: ${esc(kinetics.levelOfTheory)}.`
    : 'Level of theory: not recorded for this run.';
  return '<p class="results-note" data-field="radiative-kinetics">'
    + '<strong>Radiative kinetics.</strong> Per state, '
    + `<code>${esc(kinetics.formula)}</code> s⁻¹ (f dimensionless, λ in nm), and `
    + `τ_r = 1 / k_r. ${esc(sourceSentence)} ${levelSentence} `
    + `${esc(radiativeKineticsSummary(kinetics, { note: false }))}</p>`
    + '<p class="results-missing" data-field="radiative-not-modelled">'
    + `<strong>Not modelled:</strong> ${esc(RADIATIVE_NOT_MODELLED.join('; '))}. `
    + 'No observed lifetime, fluorescence quantum yield or phosphorescence rate is predicted from '
    + 'this calculation.</p>';
}

/**
 * Simulated UV-Vis curve, drawn by the shared figure module so the panel and the
 * workflow report cannot show different pictures of the same numbers. The
 * broadening is a stated parameter, not a hidden default: the caption prints the
 * FWHM and the number of transitions used.
 *
 * Issue 184: a measured trace, when the record carries one, is drawn on the same
 * axes at the same scale. The trace is placed by `placeMeasuredOverlay()`, which
 * refuses an axis it cannot honour; when the record's axis is cm⁻¹ it is plotted
 * as the reciprocal on the nm axis and the caption says so. Nothing is resampled
 * and nothing is invented: without a recorded overlay the figure is the computed
 * one, and a malformed field prints the reason instead of half a curve.
 */
function excitedSpectrumHtml(states, overlayField = null, overlayNote = '') {
  let spectrum;
  try {
    spectrum = broadenedSpectrum(states);
  } catch {
    return '';
  }
  const overlays = [];
  let overlayError = '';
  if (isObject(overlayField)) {
    try {
      const measured = overlayFromRecord(overlayField);
      const placed = placeMeasuredOverlay(measured, { axis: 'wavelength', allowReciprocal: true });
      overlays.push({ ...measured, note: placed.note, points: placed.points });
    } catch (error) {
      overlayError = error.message;
    }
  }
  const figure = fromUvVis(spectrum, { overlays });
  if (!figure) return '';
  const note = overlayError || overlayNote;
  const caption = overlays.length > 0
    ? figure.caption
    : `${figure.caption} · oscillator strengths as computed, intensity relative to the `
      + 'strongest point. This is a simulation, not a measured spectrum.';
  return '<figure class="results-spectrum" data-field="excited-spectrum">'
    + figure.svg
    + '<div class="results-note" data-field="measured-overlay-control">'
    + '<label>Measured spectrum (two-column CSV/TSV) '
    + '<input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" data-spectrum-overlay></label>'
    + (overlays.length > 0
      ? ' <button type="button" class="results-link" data-spectrum-overlay-clear>Remove measured trace</button>'
      : '')
    + '</div>'
    + (note ? `<p class="results-note" data-field="spectrum-overlay-note">${esc(note)}</p>` : '')
    + `<figcaption>${esc(caption)}</figcaption>`
    + '</figure>';
}

/**
 * Reaction path (IRC) or potential-energy scan. The barrier printed here is a
 * potential-energy difference on the computed points, not ΔG‡, and the caption
 * says so; a rate is only derived when the queue supplies a ΔG‡ verdict for
 * this path — never from the potential-energy barrier.
 *
 * `options.reaction` is the queue's verdict for this run (`kcalPerMol`,
 * `temperatureK`, `available`), and `options.molecularity` the reactant block's
 * fragment count. Without them the card says k is not reported and names what
 * is missing rather than guessing a unit.
 */
function reactionPathCard(runRecord, parsed, flags, options = {}) {
  const record = parsed?.reactionPath || parsed?.scan;
  if (!record || !Array.isArray(record.points) || record.points.length === 0) return '';
  const method = runRecord?.provenance?.method || null;
  const level = method
    ? (method.hamiltonian
      ? [method.hamiltonian, method.optLevel].filter(Boolean).join(' · ')
      : [method.functional, method.basis].filter(Boolean).join('/'))
    : '';
  const levelText = level
    ? `Level of theory: ${esc(level)}.`
    : 'Level of theory: not recorded for this run.';
  const irc = record.kind === 'irc' || Boolean(parsed?.reactionPath);
  const points = profilePoints(record);
  if (points.length === 0) return '';
  const treatment = parsed?.thermochemistry?.entropyTreatment
    || (parsed?.frequencies?.count ? 'harmonic frequencies' : null);
  // A barrier is never printed without its level of theory and treatment; both
  // say "not recorded" when the run did not carry them.
  const barrier = pathBarrier(record, { levelOfTheory: level || null, thermochemicalTreatment: treatment });
  const parameter = Array.isArray(record.parameterNames) && record.parameterNames.length
    ? record.parameterNames[0] : null;
  const extremum = irc ? null : scanExtremum(record);
  const rows = points.slice(0, 25).map((point) => '<tr>'
    + `<td>${esc(point.point)}</td>`
    + `<td class="is-left">${esc(irc
      ? (Number.isFinite(point.rxCoord) ? point.rxCoord.toFixed(5) : MISSING_TEXT)
      : (Number.isFinite(point.label) ? Number(point.label).toFixed(4) : MISSING_TEXT))}</td>`
    + `<td>${esc(Number(point.relativeKcal).toFixed(2))}</td>`
    + `<td>${Number.isFinite(point.energyHartree) ? esc(point.energyHartree.toFixed(6)) : MISSING_TEXT}</td>`
    + '</tr>').join('');
  const body = '<p class="results-note">'
    + (irc
      ? 'IRC path from the summary Gaussian printed at the end of the job. Energies are relative to the lowest computed point.'
      : `${record.kind === 'relaxed' ? 'Relaxed' : 'Unrelaxed'} potential-energy scan over ${esc(parameter || 'the scanned coordinate')}. Energies are relative to the lowest computed point.`)
    + '</p>'
    + (irc
      ? (() => {
        const gate = ircGate(record);
        const badge = gate.status === 'pass' ? 'gates-pass' : gate.status === 'fail' ? 'gates-fail' : '';
        return `<p class="results-note ${badge}" data-field="irc-gate">Path gate: <strong>${esc(gate.status)}</strong> — ${esc(gate.reason)} `
          + `${gate.checks.map((check) => `${esc(check.id)}: ${esc(check.status)}`).join(' · ')}</p>`;
      })()
      : (() => {
        if (!extremum) return '';
        return `<p class="results-note" data-field="scan-extremum">Extremum: <strong>${esc(extremum.relativeKcal.toFixed(2))} kcal mol⁻¹</strong>`
          + `${extremum.interpolated
            ? ` at ${esc(extremum.coordinate || 'coordinate')} = ${esc(extremum.vertexX.toFixed(4))} (parabolic fit through ${extremum.neighbours.length} points)`
            : ` at node ${esc(extremum.point)}`}`
          + `${extremum.interpolated ? '' : ` — ${esc(extremum.note)}`}</p>`;
      })())
    + (extremum
      ? '<p class="results-note" data-field="barrier">Scan barrier: '
        + `<strong>${esc((Number.isFinite(extremum.vertexKcal) ? extremum.vertexKcal : extremum.relativeKcal).toFixed(2))} kcal mol⁻¹</strong>`
        + `${extremum.interpolated
          ? ` at ${esc(extremum.coordinate || 'coordinate')} = ${esc(extremum.vertexX.toFixed(4))}`
          : ` at grid node ${esc(extremum.point)}`}`
        + `${scanStepText(extremum)}. This is a barrier from the scan extremum, not a transition-state barrier: a scan surface has an extremum on a grid, not a saddle point, and it carries no ΔG‡. `
        + `± the grid step is the resolution of the scan. ${levelText}</p>`
      : (barrier
        ? `<p class="results-note" data-field="barrier">Highest point: <strong>${esc(barrier.maxKcal.toFixed(2))} kcal mol⁻¹</strong>`
          + ` at point ${esc(barrier.point)}${Number.isFinite(barrier.rxCoord) ? ` (RxCoord ${esc(barrier.rxCoord.toFixed(5))})` : ''}.`
          + ` ${levelText} This is a potential-energy difference on the computed points — not ΔG‡, no thermochemical correction is applied, and no rate constant is derived from it.</p>`
        : ''))
    + (irc ? kineticsBlockHtml(options, flags) : '')
    + (record.kind === 'relaxed' || record.kind === 'unrelaxed' ? (scanSurfaceSvg(record) || profileSvg(record)) : profileSvg(record))
    + '<table class="results-table" data-field="reaction-path">'
    + `<thead><tr><th>#</th><th class="is-left">${irc ? 'RxCoord' : esc(parameter || 'coordinate')}</th><th>ΔE / kcal mol⁻¹</th><th>E / Eh</th></tr></thead>`
    + `<tbody>${rows}</tbody></table>`
    + (points.length > 25 ? `<p class="results-missing">Showing the first 25 of ${esc(points.length)} points.</p>` : '')
    + caveatHtml(flags, 'These path energies');
  return card(irc ? 'Reaction path' : 'Potential-energy scan', body, 'is-wide');
}

/** The scan step, when the fitted extremum carries its neighbours. */
function scanStepText(extremum) {
  if (!Array.isArray(extremum.neighbours) || extremum.neighbours.length < 3) return '';
  const step = Math.abs(extremum.neighbours[1].x - extremum.neighbours[0].x);
  if (!Number.isFinite(step) || step === 0) return '';
  return ` (± ${esc(step.toPrecision(3))} ${esc(extremum.coordinate || 'coordinate')} grid)`;
}

/**
 * Eyring kinetics for the reaction this path belongs to.
 *
 * The queue's verdict supplies ΔG‡ and its temperature; the reactant block's
 * fragment count supplies the unit. A missing number is printed as
 * `not reported` with the reason, never as zero.
 */
function kineticsBlockHtml(options, flags) {
  const reaction = isObject(options.reaction) ? options.reaction : null;
  if (!reaction) {
    return '<p class="results-note" data-field="kinetics">k = <strong>not reported</strong> — this run record carries no ΔG‡ for the reaction, '
      + 'so no rate constant is computed. The queue verdict for this path names the transition-state and reactant blocks; without both free energies there is no barrier to convert.</p>';
  }
  const molecularity = Number.isFinite(options.molecularity)
    ? { value: options.molecularity, basis: text(options.molecularityBasis) || 'the reactant block' }
    : null;
  const report = buildKinetics({
    deltaGkcal: Number.isFinite(reaction.kcalPerMol) ? reaction.kcalPerMol : null,
    deltaGLabel: 'G(TS) − G(reactant)',
    freeEnergyKey: reaction.available ? 'Sum of electronic and thermal Free Energies' : null,
    zpeIncluded: reaction.available === true,
    thermalIncluded: reaction.available === true,
    temperatureK: Number.isFinite(reaction.temperatureK) ? reaction.temperatureK : null,
    molecularity,
    refusalReason: text(reaction.reason),
  });
  const table = report.available
    ? '<table class="results-table" data-field="kinetics-temperature-table">'
      + '<thead><tr><th>T / K</th><th>k / ' + esc(report.units) + '</th><th>t½</th></tr></thead><tbody>'
      + report.table.map((row) => '<tr>'
        + `<td>${esc(row.temperatureK.toFixed(2))}</td>`
        + `<td>${esc(row.kText)}</td>`
        + `<td>${esc(row.halfLifeText)}</td>`
        + '</tr>').join('')
      + '</tbody></table>'
    : '';
  const fit = report.available && report.fit?.available
    ? `<p class="results-note" data-field="kinetics-fit">Arrhenius fit from the table: Ea = ${esc(report.fit.eaKcalPerMol.toFixed(2))} kcal mol⁻¹, `
      + `ln A = ${esc(report.fit.lnA.toFixed(3))}, R² = ${esc(report.fit.rSquared === null ? MISSING_TEXT : report.fit.rSquared.toFixed(5))}. `
      + `${esc(report.fit.scheme)}</p>`
    : report.available
      ? `<p class="results-note" data-field="kinetics-fit">Arrhenius fit: ${esc(report.fit?.reason || MISSING_TEXT)}</p>`
      : '';
  const provenance = report.available
    ? `<p class="results-note" data-field="kinetics-provenance">ΔG‡ from ${esc(report.deltaG.label)}`
      + `${report.deltaG.freeEnergyKey ? ` (${esc(report.deltaG.freeEnergyKey)})` : ''}; `
      + `${esc(report.provenance.corrections.statement)} `
      + `${esc(report.provenance.temperature.statement)} `
      + `Molecularity ${esc(String(report.molecularity))} from ${esc(report.provenance.molecularity.basis || 'the reactant block')}.</p>`
    : '';
  return '<div data-field="kinetics">'
    + `<p class="results-note results-kinetics-line" data-field="kinetics-line">${esc(kineticsSummaryLine(report))}</p>`
    + table
    + fit
    + provenance
    + (report.available ? `<p class="results-note">Assumptions: ${esc(report.assumptions.join(' '))}</p>` : '')
    + (report.warnings.length ? `<p class="results-note is-warn">${esc(report.warnings.join(' '))}</p>` : '')
    + caveatHtml(flags, 'This rate constant')
    + '</div>';
}

/**
 * The one card an imported record gets. There is no SCF table, no termination,
 * no gate: those describe a run, and no run happened. The number is printed with
 * the label attached, and the provenance that makes the label checkable.
 */
function importedEnergyCard(imported) {
  const level = [imported.method, imported.basis].filter((value) => value !== null).join('/') || null;
  return card('Imported energy', kv([
    fieldValue(
      'Final energy',
      `${esc(hartreeText(imported.energyHartree) ?? MISSING_TEXT)} <span class="results-badge is-imported">${esc(IMPORTED_BADGE_TEXT)}</span>`,
      'imported-energy',
    ),
    fieldValue('Program', safeText(`${imported.program ?? ''}${imported.version ? ` ${imported.version}` : ''}`.trim() || null), 'imported-program'),
    fieldValue('Level of theory', safeText(level), 'imported-level'),
    fieldValue('Source file', safeText(imported.sourceName), 'imported-source'),
    fieldValue('Source SHA-256', imported.sourceSha256 ? esc(imported.sourceSha256) : missingHtml(), 'imported-source-sha256'),
    fieldValue('Imported at', safeText(formatTimestamp(imported.importedAt)), 'imported-at'),
  ]) + '<p class="results-note">The hash identifies the file these numbers were read from; '
    + 'it does not prove the calculation, and no executable ran here.</p>', 'is-imported');
}

/**
 * pKa and redox cycles.
 *
 * A cycle is a group of blocks whose free energies are subtracted, so it is
 * carried on the parsed output as `cycles[]` (see `docs/guide/results.md`).
 * Every number is rendered with the reference and citation it was anchored to,
 * and an incomplete cycle prints `not reported` with the missing block named.
 *
 * Issue 131: an imported result can be shown *beside* the cycles when the
 * caller asks for it (`options.includeImported`). It is never folded into a
 * cycle: subtracting a number this app did not compute would be a derived
 * quantity with two provenances and one label.
 */
function solutionEnergeticsCard(record, parsed, flags, options = {}) {
  const cycles = Array.isArray(parsed?.cycles) ? parsed.cycles
    : Array.isArray(record?.cycles) ? record.cycles : [];
  const requested = isObject(options) && options.includeImported === true && Array.isArray(options.imported)
    ? options.imported
    : [];
  const importedBlocks = requested
    .map((entry) => importedSummary(entry))
    .filter(Boolean)
    .map((imported) => '<div data-field="imported-energetics">'
      + `<p class="results-note">${importedBadgeHtml(imported)}</p>`
      + `<p class="results-note" data-field="imported-energetics-value">Reference energy E = ${esc(hartreeText(imported.energyHartree) ?? MISSING_TEXT)}`
      + ` at ${esc(imported.method ?? MISSING_TEXT)}/${esc(imported.basis ?? MISSING_TEXT)}, computed by ${esc(imported.program ?? MISSING_TEXT)}`
      + `${imported.version ? ` ${esc(imported.version)}` : ''}. `
      + `This value is shown beside the cycles, not inside one: it is not subtracted from anything here.</p>`
      + '</div>')
    .join('');
  const blocks = cycles.map((cycle) => {
    if (cycle?.kind === 'pka') {
      const result = pkaCycle(cycle);
      const line = pkaCycleLine(result);
      return '<div data-field="pka-cycle">'
        + `<p class="results-note" data-field="pka-line">${esc(line)}</p>`
        + '<p class="results-note" data-field="pka-unit">Conversion: '
        + `${esc(result.unit.name)} (${esc(result.unit.meaning)}). `
        + 'A pKa is only defined in a solvent against a reference acid; both are printed above.</p>'
        + (result.available
          ? `<p class="results-note">ΔG_deprot = ${esc(result.deltaGDeprotonationKcal.toFixed(2))} kcal mol⁻¹; `
            + `ΔG(reference) = ${esc(result.deltaGReferenceKcal.toFixed(2))} kcal mol⁻¹. ${esc(result.scheme)}</p>`
          : '')
        + '</div>';
    }
    if (cycle?.kind === 'redox') {
      const result = redoxCycle(cycle);
      return '<div data-field="redox-cycle">'
        + `<p class="results-note" data-field="redox-line">${esc(redoxCycleLine(result))}</p>`
        + '<p class="results-note" data-field="redox-scheme">'
        + `${esc(result.scheme)}; F = ${esc(result.faraday.value.toFixed(4))} kcal mol⁻¹ V⁻¹, `
        + `SHE offset ${esc(result.sheOffsetV === null ? MISSING_TEXT : `${result.sheOffsetV.toFixed(3)} V`)}. `
        + 'E° is reported against SHE by adding the reference couple\'s offset; the electron convention cancels in the cycle.</p>'
        + '</div>';
    }
    return '';
  }).join('');
  if (!blocks && !importedBlocks) return '';
  return card('Solution energetics', blocks + importedBlocks + caveatHtml(flags, 'These cycle results'), 'is-wide');
}

/**
 * NMR shieldings. Gaussian reports absolute isotropic shieldings; a chemical
 * shift is `σ_reference − σ_isotropic` and needs a reference computed at the
 * same level, so the panel starts in absolute mode and only shows shifts once
 * the user supplies one. The gauge, the reference and the broadening are
 * printed with the numbers.
 */
function nmrCard(parsed, flags) {
  const nmr = parsed?.nmr;
  if (!nmr || !Array.isArray(nmr.atoms) || nmr.atoms.length === 0) return '';
  const elements = [...new Set(nmr.atoms.map((atom) => atom.element))];
  const nuclei = elements
    .map((element) => ({ element, nucleus: element === 'H' ? '1H' : `13${element}`.replace('13', '13') }))
    .filter((entry) => elementForNucleus(entry.nucleus) === entry.element);
  const options = (nuclei.length ? nuclei : [{ element: elements[0], nucleus: elements[0] }])
    .map((entry) => `<option value="${esc(entry.nucleus)}">${esc(entry.nucleus)}</option>`).join('');
  const initialNucleus = nuclei.length ? nuclei[0].nucleus : (elements.includes('H') ? '1H' : `${elements[0]}`);

  const body = `<p class="results-note">Absolute isotropic shieldings from a ${esc(nmr.gauge || 'unknown')} calculation`
    + `${nmr.method ? ` (${esc(nmr.method)})` : ''}, ${esc(nmr.count)} atoms. A chemical shift is `
    + '<code>σ_reference − σ_isotropic</code> and the reference must come from the same level of theory; '
    + 'enter it below to convert. Without one, the figure plots absolute shielding — it is not a spectrum in ppm shift.</p>'
    + '<div class="nmr-controls">'
    + `<label>Nucleus <select data-nmr-nucleus>${options}</select></label>`
    + '<label>σ<sub>ref</sub> / ppm <input type="number" step="0.01" data-nmr-reference placeholder="not set"></label>'
    + '<label>FWHM / ppm <input type="number" step="0.01" min="0.001" data-nmr-fwhm value="0.10"></label>'
    + '</div>'
    + `<div data-field="nmr-figure">${nmrSectionHtml(nmr, { nucleus: initialNucleus })}</div>`
    + caveatHtml(flags, 'These shieldings');
  return card('NMR', body, 'is-wide');
}

/** The figure and peak table for one nucleus, recomputed when a control changes. */
function nmrSectionHtml(nmr, { nucleus = '1H', referencePpm = null, fwhmPpm = 0.1 } = {}) {
  const element = elementForNucleus(nucleus) || nucleus;
  const rows = nmr.atoms.filter((atom) => atom.element === element).slice(0, 40);
  if (rows.length === 0) {
    return `<p class="results-missing">No ${esc(nucleus)} nucleus in this output.</p>`;
  }
  const shifts = nmrShifts(rows, { referencePpm });
  const spectrum = nmrSpectrum({ atoms: nmr.atoms, nucleus, referencePpm, fwhmPpm });
  const figure = spectrum
    ? (() => {
      const drawn = fromNmr(spectrum);
      if (!drawn) return '';
      return '<figure class="results-spectrum" data-field="nmr-spectrum">'
        + drawn.svg
        + `<figcaption>${esc(drawn.caption)} · ${esc(rows.length)} ${esc(element)} nuclei`
        + `${spectrum.referencePpm === null ? ' · no reference set (absolute shielding)' : ` · reference σ_ref = ${esc(spectrum.referencePpm.toFixed(2))} ppm`}</figcaption>`
        + '</figure>';
    })()
    : '';
  const rowsHtml = shifts.map((atom) => '<tr>'
    + `<td>${esc(atom.index)}</td>`
    + `<td>${esc(atom.element)}</td>`
    + `<td>${esc(atom.isotropic.toFixed(4))}</td>`
    + `<td>${atom.shiftPpm === null ? MISSING_TEXT : esc(atom.shiftPpm.toFixed(4))}</td>`
    + `<td>${esc(atom.anisotropy.toFixed(4))}</td>`
    + '</tr>').join('');
  const table = '<table class="results-table" data-field="nmr-shieldings">'
    + '<thead><tr><th>Atom</th><th>Element</th><th>σ<sub>iso</sub> / ppm</th><th>Shift / ppm</th><th>Anisotropy / ppm</th></tr></thead>'
    + `<tbody>${rowsHtml}</tbody></table>`;
  return figure + table;
}

/**
 * Raman (#76). The y axis is the printed activity in Å⁴/amu, not a scattering
 * cross-section: converting to one needs the excitation wavelength and a
 * Boltzmann population factor that the log does not carry.
 */
function ramanCard(parsed, flags) {
  const modes = parsed?.raman;
  if (!Array.isArray(modes) || modes.length === 0) return '';
  const withActivity = modes.filter((mode) => Number.isFinite(mode.ramanActivity));
  if (withActivity.length === 0) return '';
  const body = '<p class="results-note">Per-mode Raman scattering activities as printed by Gaussian '
    + `(Å⁴/amu), with the depolarisation ratio for plane- and unpolarised incident light. `
    + 'The curve below is the <em>activity</em> broadened with a Lorentzian of the stated FWHM: it is not a '
    + 'scattering cross-section, which would need the excitation wavelength and a population factor.</p>'
    + '<div class="nmr-controls">'
    + '<label>FWHM / cm<sup>−1</sup> <input type="number" step="1" min="0.5" data-raman-fwhm value="12"></label>'
    + '<label>Measured trace <input type="file" accept=".csv,.txt,.jdx,.dx,text/csv,text/plain" data-raman-overlay></label>'
    + '</div>'
    + `<div data-field="raman-figure">${ramanSectionHtml(modes, { fwhmCm: 12 })}</div>`
    + caveatHtml(flags, 'These activities');
  return card('Raman', body, 'is-wide');
}

/** The figure and the per-mode table, recomputed when a control changes. */
export function ramanSectionHtml(modes, { fwhmCm = 12, measured = null, overlayName = '', overlayNote = '' } = {}) {
  const spectrum = ramanSpectrum(modes, { fwhmCm });
  if (!spectrum) return '<p class="results-missing">No Raman activity was printed, so there is nothing to plot.</p>';
  const scaled = measured ? scaleToSpectrum(measured, { peakIntensity: 1 }) : null;
  // The measured trace is passed in data units and clipped by the figure: the
  // old polyline was clamped to the 0…100 box, which silently pinned points
  // outside the window to the axis.
  const overlayPoints = scaled && Array.isArray(scaled.points)
    ? scaled.points.map((point) => ({ x: Number(point.x), y: Number(point.y) }))
    : [];
  const drawn = fromRaman(spectrum, {
    overlays: overlayPoints.length > 1
      ? [{ points: overlayPoints, label: overlayName || 'imported' }]
      : [],
  });
  const figure = '<figure class="results-spectrum" data-field="raman-spectrum">'
    + (drawn ? drawn.svg : '')
    + `<figcaption>${esc(spectrum.quantity)} · ${esc(spectrum.units)} · ${esc(modes.length)} modes · `
    + `Lorentzian broadening, FWHM ${esc(Number(fwhmCm).toFixed(1))} cm⁻¹ · ${esc(spectrum.normalisation)}`
    + (scaled ? ` · measured series “${esc(overlayName || 'imported')}” scaled by ×${esc(scaled.scale.toPrecision(4))} to match the strongest simulated peak` : '')
    + (overlayNote ? `<br>${esc(overlayNote)}` : '')
    + '</figcaption>'
    + '</figure>';

  const rows = spectrum.peaks.map((peak, index) => '<tr>'
    + `<td>${esc(index + 1)}</td>`
    + `<td>${esc(peak.wavenumber.toFixed(4))}</td>`
    + `<td>${esc(peak.ramanActivity.toFixed(4))}</td>`
    + `<td>${peak.depolarizationPlane === null ? MISSING_TEXT : esc(peak.depolarizationPlane.toFixed(4))}</td>`
    + '</tr>').join('');
  const table = '<table class="results-table" data-field="raman-modes">'
    + '<thead><tr><th>Mode</th><th>Frequency / cm⁻¹</th><th>Activity / Å⁴ amu⁻¹</th><th>Depolarisation (plane)</th></tr></thead>'
    + `<tbody>${rows}</tbody></table>`;
  return figure + table;
}

/**
 * VCD (#78). Rotational strengths are signed, so the curve is drawn around a
 * zero line and the table keeps the sign; normalising to the strongest
 * positive band would hide half the spectrum.
 *
 * Gaussian 16 A.03 prints the row as `Rot. str. --` with the unit
 * (10⁻⁴⁴ esu² cm²) and **no velocity/length label**. The two representations
 * agree only in a complete basis, so the card says "not stated in the output"
 * instead of choosing one; the unit and the E–M angle are printed so a reader
 * can identify the convention from the numbers.
 */
function vcdCard(parsed, flags) {
  const modes = parsed?.vcd;
  if (!Array.isArray(modes) || modes.length === 0) return '';
  const withStrength = modes.filter((mode) => Number.isFinite(mode.rotationalStrength));
  if (withStrength.length === 0) return '';
  const representation = parsed?.vcdTable?.representation ?? null;
  const body = '<p class="results-note">Per-mode vibrational circular dichroism as printed by Gaussian: '
    + 'rotational strength <em>R</em>, dipole strength and the E–M angle between the electric and magnetic '
    + `dipole transition moments. R is <strong>signed</strong> (${esc(VCD_UNITS)}), and the curve below is `
    + 'the signed Lorentzian sum normalised to the strongest |R|, not to the strongest positive band. '
    + `Representation: ${representation === null
      ? '<strong>not stated in the output</strong> — Gaussian 16 prints the unit only, and velocity and length '
        + 'representations agree only in a complete basis, so none is assumed here.'
      : `<code>${esc(representation)}</code>, as stated in the output.`}</p>`
    + '<div class="nmr-controls">'
    + '<label>FWHM / cm<sup>−1</sup> <input type="number" step="1" min="0.5" data-vcd-fwhm value="12"></label>'
    + '</div>'
    + `<div data-field="vcd-figure">${vcdSectionHtml(modes, { fwhmCm: 12 })}</div>`
    + caveatHtml(flags, 'These rotational strengths');
  return card('VCD', body, 'is-wide');
}

/** The signed figure and the per-mode table, recomputed when the FWHM changes. */
export function vcdSectionHtml(modes, { fwhmCm = 12 } = {}) {
  const spectrum = vcdSpectrum(modes, { fwhmCm });
  if (!spectrum) return '<p class="results-missing">No rotational strengths were printed, so there is nothing to plot.</p>';
  const drawn = fromVcd(spectrum);
  const figure = '<figure class="results-spectrum" data-field="vcd-spectrum">'
    + (drawn ? drawn.svg : '')
    + `<figcaption>${esc(spectrum.quantity)} · ${esc(spectrum.units)} · ${esc(spectrum.counts.total)} modes `
    + `(${esc(spectrum.counts.positive)} positive, ${esc(spectrum.counts.negative)} negative) · `
    + `Lorentzian broadening, FWHM ${esc(Number(fwhmCm).toFixed(1))} cm⁻¹ · ${esc(spectrum.normalisation)}</figcaption>`
    + '</figure>';

  const rows = spectrum.peaks.map((peak, index) => '<tr>'
    + `<td>${esc(index + 1)}</td>`
    + `<td>${esc(peak.wavenumber.toFixed(4))}</td>`
    + `<td>${esc(peak.rotationalStrength.toFixed(4))}</td>`
    + `<td>${peak.dipoleStrength === null ? MISSING_TEXT : esc(peak.dipoleStrength.toFixed(4))}</td>`
    + `<td>${peak.emAngle === null ? MISSING_TEXT : esc(peak.emAngle.toFixed(4))}</td>`
    + '</tr>').join('');
  const table = '<table class="results-table" data-field="vcd-modes">'
    + `<thead><tr><th>Mode</th><th>Frequency / cm⁻¹</th><th>R / ${esc(VCD_UNITS)}</th>`
    + `<th>Dip. strength / ${esc(VCD_DIPOLE_UNITS)}</th><th>E–M angle / °</th></tr></thead>`
    + `<tbody>${rows}</tbody></table>`;
  return figure + table;
}

/**
 * ECD (#75). Rotatory strength is signed, so the curve is too.
 * (velocity vs length) is chosen by the reader and printed, because the two
 * numbers agree only in a complete basis and mixing them is meaningless.
 */
function ecdCard(parsed, flags) {
  const table = parsed?.rotatoryStrengths;
  const states = Array.isArray(parsed?.excitedStates?.states) ? parsed.excitedStates.states : [];
  if (!table || states.length === 0) return '';
  const velocity = table.conventions?.velocity ?? [];
  const length = table.conventions?.length ?? [];
  if (velocity.length === 0 && length.length === 0) return '';
  const body = '<p class="results-note">Rotatory strengths as Gaussian printed them, in '
    + `${esc(table.unit)}. The <strong>velocity</strong> and <strong>length</strong> forms agree only in a `
    + 'complete basis; the panel plots the one you choose and names it. No Δε is computed: that needs a band '
    + 'shape and an instrument calibration the log does not carry.</p>'
    + '<div class="nmr-controls">'
    + '<label>Convention <select data-ecd-convention>'
    + '<option value="velocity">R(velocity)</option>'
    + '<option value="length">R(length)</option>'
    + '</select></label>'
    + '<label>FWHM / eV <input type="number" step="0.01" min="0.01" data-ecd-fwhm value="0.20"></label>'
    + '</div>'
    + `<div data-field="ecd-figure">${ecdSectionHtml(parsed, { convention: 'velocity', fwhmEv: 0.2 })}</div>`
    + caveatHtml(flags, 'These rotatory strengths');
  return card('ECD', body, 'is-wide');
}

export function ecdSectionHtml(parsed, { convention = 'velocity', fwhmEv = 0.2 } = {}) {
  const table = parsed?.rotatoryStrengths;
  const states = Array.isArray(parsed?.excitedStates?.states) ? parsed.excitedStates.states : [];
  const rowsByState = new Map((table?.conventions?.[convention] ?? []).map((row) => [row.state, row]));
  const combined = states.map((state) => ({
    index: state.index,
    energyEv: Number(state.energyEv),
    wavelengthNm: Number(state.wavelengthNm),
    rotatoryStrength: rowsByState.has(state.index) ? rowsByState.get(state.index).r : null,
  }));
  const spectrum = ecdSpectrum(combined, { convention, fwhmEv });
  if (!spectrum) return '<p class="results-missing">No rotatory strength could be matched to a state.</p>';
  const drawn = fromEcd(spectrum);
  const figure = '<figure class="results-spectrum" data-field="ecd-spectrum">'
    + (drawn ? drawn.svg : '')
    + `<figcaption>${esc(spectrum.conventionLabel)} · ${esc(spectrum.units)} · `
    + `Lorentzian broadening, FWHM ${esc(spectrum.fwhmEv.toFixed(2))} eV · ${esc(spectrum.normalisation)}</figcaption>`
    + '</figure>';
  const rows = combined.map((row) => '<tr>'
    + `<td>${esc(row.index)}</td>`
    + `<td>${Number.isFinite(row.energyEv) ? esc(row.energyEv.toFixed(4)) : MISSING_TEXT}</td>`
    + `<td>${Number.isFinite(row.wavelengthNm) ? esc(row.wavelengthNm.toFixed(2)) : MISSING_TEXT}</td>`
    + `<td>${row.rotatoryStrength === null ? MISSING_TEXT : esc(row.rotatoryStrength.toFixed(4))}</td>`
    + '</tr>').join('');
  const tableHtml = '<table class="results-table" data-field="ecd-states">'
    + `<thead><tr><th>#</th><th>eV</th><th>nm</th><th>R (${esc(spectrum.conventionLabel)})</th></tr></thead>`
    + `<tbody>${rows}</tbody></table>`;
  const achiral = combined.every((row) => row.rotatoryStrength === null || Math.abs(row.rotatoryStrength) < 1e-6);
  return figure + tableHtml
    + (achiral
      ? '<p class="results-missing">Every printed rotatory strength is zero: this molecule is achiral, so the ECD spectrum is flat by symmetry rather than by a parsing failure.</p>'
      : '');
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

/**
 * Method sensitivity (#96): the ladder/ensemble provenance a record may carry.
 * Every number that came from a ladder or an ensemble is printed with the
 * spread it came from; a refused extrapolation is printed as "not reported"
 * with the missing input, never as a number.
 */
function sensitivityCard(record) {
  const ladder = isObject(record?.ladder) ? record.ladder : null;
  const ensemble = isObject(record?.ensemble) ? record.ensemble : null;
  const conformer = isObject(record?.conformer) ? record.conformer : null;
  if (!ladder && !ensemble && !conformer) return '';

  const blocks = [];

  if (ladder) {
    const entries = Array.isArray(ladder.entries) ? ladder.entries : [];
    if (entries.length > 0) {
      const rows = entries.map((entry) => '<tr>'
        + `<td>${esc(text(entry?.label) || text(entry?.id) || MISSING_TEXT)}</td>`
        + `<td>${esc(text(entry?.method) || MISSING_TEXT)}</td>`
        + `<td>${esc(text(entry?.basis) || MISSING_TEXT)}</td>`
        + `<td class="num">${esc(finite(entry?.energyHartree) === null ? MISSING_TEXT : finite(entry.energyHartree).toFixed(8))}</td>`
        + `<td class="num">${esc(finite(entry?.relativeKcalPerMol) === null ? MISSING_TEXT : finite(entry.relativeKcalPerMol).toFixed(2))}</td>`
        + '</tr>').join('');
      blocks.push('<table class="results-table" data-field="ladder-rungs"><thead><tr><th>Rung</th>'
        + '<th>Method</th><th>Basis</th><th class="num">E / Eh</th><th class="num">ΔE / kcal mol⁻¹</th>'
        + `</tr></thead><tbody>${rows}</tbody></table>`);
    }
    const spread = finite(ladder.spreadKcal);
    const over = text(ladder.spreadOver) || `${entries.length} rung${entries.length === 1 ? '' : 's'}`;
    blocks.push(`<p class="results-note results-spread" data-field="ladder-spread">spread `
      + `${spread === null ? MISSING_TEXT : `${spread.toFixed(2)} kcal/mol`} over ${esc(over)}</p>`);

    const cbs = isObject(ladder.cbs) ? ladder.cbs : null;
    if (cbs?.available === true) {
      const pair = isObject(cbs.pair) ? cbs.pair : {};
      const lower = text(pair.lower?.basis) || MISSING_TEXT;
      const upper = text(pair.upper?.basis) || MISSING_TEXT;
      const energy = finite(cbs.energyHartree);
      blocks.push('<p class="results-note" data-field="ladder-cbs">'
        + `CBS ${esc(text(cbs.form) || 'estimate')} · `
        + `<strong>${esc(energy === null ? MISSING_TEXT : `${energy.toFixed(8)} Eh`)}</strong> · `
        + `pair ${esc(lower)} → ${esc(upper)}</p>`);
    } else if (cbs) {
      blocks.push(`<p class="results-note results-missing" data-field="ladder-cbs">CBS not reported: `
        + `${esc(text(cbs.reason) || 'the ladder did not carry a usable basis pair')}</p>`);
    }
  }

  if (ensemble) {
    if (ensemble.available === true) {
      blocks.push(`<p class="results-note" data-field="ensemble-label">${esc(text(ensemble.label) || 'ensemble-averaged')}</p>`);
      const temperature = finite(ensemble.temperatureK);
      blocks.push(`<p class="results-note" data-field="ensemble-temperature">at `
        + `${temperature === null ? MISSING_TEXT : `${temperature.toFixed(2)} K`} over `
        + `${Number.isInteger(ensemble.memberCount) ? ensemble.memberCount : 'the'} retained conformers</p>`);
      const observables = Array.isArray(ensemble.observables) ? ensemble.observables : [];
      if (observables.length > 0) {
        const rows = observables.map((observable) => {
          const unit = text(observable?.unit) || '';
          const weighted = finite(observable?.weightedMean);
          const unweighted = finite(observable?.unweightedMean);
          const spread = finite(observable?.spread);
          const over = text(observable?.over) || 'the retained conformers';
          return '<tr>'
            + `<td>${esc(text(observable?.label) || text(observable?.key) || MISSING_TEXT)}</td>`
            + `<td class="num" data-field="ensemble-value">${esc(weighted === null ? MISSING_TEXT : `${weighted.toFixed(6)} ${unit}`.trim())}</td>`
            + `<td class="num" data-field="ensemble-spread">${esc(spread === null ? MISSING_TEXT : `spread ${spread.toFixed(6).replace(/\.?0+$/, '')} ${unit} over ${over}`.trim())}</td>`
            + `<td class="num" data-field="ensemble-unweighted">${esc(unweighted === null ? MISSING_TEXT : `${unweighted.toFixed(6)} ${unit}`.trim())}</td>`
            + '</tr>';
        }).join('');
        blocks.push('<table class="results-table" data-field="ensemble-observables"><thead><tr>'
          + '<th>Observable</th><th class="num">Ensemble-averaged</th><th class="num">Spread</th>'
          + '<th class="num">Unweighted</th></tr></thead>'
          + `<tbody>${rows}</tbody></table>`);
      }
    } else {
      blocks.push(`<p class="results-note results-missing" data-field="ensemble-label">not ensemble-averaged: `
        + `${esc(text(ensemble.reason) || 'the ensemble was not retained')}</p>`);
    }
  }

  if (conformer) {
    const population = finite(conformer.population);
    const relative = finite(conformer.relativeKcal);
    const spread = finite(conformer.spreadKcal);
    const count = finite(conformer.count);
    blocks.push(`<p class="results-note" data-field="conformer-population">`
      + `Conformer ${esc(text(conformer.id) || '(unnamed)')} · population `
      + `${population === null ? MISSING_TEXT : `${(population * 100).toFixed(1)}%`}`
      + `${relative === null ? '' : ` · ΔE ${relative.toFixed(2)} kcal/mol`}</p>`);
    if (spread !== null) {
      blocks.push(`<p class="results-note results-spread" data-field="conformer-spread">ensemble spread `
        + `${spread.toFixed(2)} kcal/mol over ${count === null ? 'the retained' : `${count}`} conformers</p>`);
    }
  }

  return card('Method sensitivity', blocks.join(''));
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
 * Optimisation replay: every geometry the output printed, with the energy that
 * preceded it. A step whose energy was not printed keeps an empty cell and does
 * not appear on the curve.
 */
function trajectoryCard(parsed, flags) {
  const trajectory = parsed?.trajectory;
  if (!isObject(trajectory) || !Array.isArray(trajectory.steps) || trajectory.steps.length < 2) return '';
  const series = trajectoryEnergies(trajectory);
  if (!series) return '';
  const rows = series.map((point) => {
    const step = trajectory.steps[point.step - 1];
    const coordinates = step.atoms.map((atom, index) => `<tr><td>${index + 1}</td><td>${esc(atom.element)}</td>`
      + `<td class="num">${atom.x.toFixed(4)}</td><td class="num">${atom.y.toFixed(4)}</td><td class="num">${atom.z.toFixed(4)}</td></tr>`).join('');
    return `<tr${point.reference ? ' class="is-reference"' : ''}>`
      + `<td>${point.step}</td>`
      + `<td class="num">${point.energyHartree === null ? 'not reported' : point.energyHartree.toFixed(6)}</td>`
      + `<td class="num">${point.relativeKcal === null ? '—' : point.relativeKcal.toFixed(2)}</td>`
      + `<td class="num">${point.atoms}</td>`
      + `<td><details><summary>geometry</summary><table class="results-table"><thead><tr><th>#</th><th>El</th>`
      + '<th class="num">x / Å</th><th class="num">y / Å</th><th class="num">z / Å</th></tr></thead>'
      + `<tbody>${coordinates}</tbody></table></details></td></tr>`;
  }).join('');
  const missing = series.filter((point) => point.energyHartree === null).length;
  return '<section class="results-card is-wide" data-field="optimisation-replay">'
    + '<h3 class="results-card-title">Optimisation replay</h3>'
    + trajectorySvg(trajectory)
    + `<p class="results-note">${series.length} geometries were printed; ${missing === 0
      ? 'each has the energy from the SCF that preceded it.'
      : `${missing} of them ${missing === 1 ? 'has' : 'have'} no preceding SCF energy and ${missing === 1 ? 'is' : 'are'} shown as a gap rather than at zero.`}`
    + ` The reference is the lowest energy recorded, not the first geometry.</p>`
    + '<table class="results-table" data-field="trajectory-steps"><thead><tr><th>Step</th>'
    + '<th class="num">E / Eh</th><th class="num">ΔE / kcal mol⁻¹</th><th class="num">Atoms</th><th>Geometry</th>'
    + `</tr></thead><tbody>${rows}</tbody></table>`
    + (flags.truncated ? '<p class="results-note">Truncated output: later steps may be missing.</p>' : '')
    + '</section>';
}

/**
 * Render one run record. Missing sections are omitted or marked
 * "not reported"; nothing is derived from a field the record does not carry.
 */
export function resultsPanelHtml(record, options = {}) {
  if (!isObject(record)) return emptyStateHtml();
  const parsed = isObject(record.parsed) ? record.parsed : {};
  const gates = isObject(record.gates) ? record.gates : null;
  const flags = flagsFor(record);
  const status = statusOf(record);
  const imported = importedSummary(record);
  const engineId = engineOf(record, parsed);
  // issue 146: the task settings and the workflow-derived emission/NTO context reach
  // the cards through `options` (the queue knows the task) or through a record
  // that already carries them. Nothing here is guessed from the log.
  const task = isObject(record.task) ? record.task : {};
  const jobSettings = isObject(options.settings) ? options.settings : (isObject(task.settings) ? task.settings : {});
  const emission = isObject(options.emission) ? options.emission
    : (isObject(task.emission) ? task.emission : (isObject(record.emission) ? record.emission : null));
  const nto = isObject(options.nto) ? options.nto : (isObject(task.nto) ? task.nto : (isObject(record.nto) ? record.nto : null));
  const engineLabel = imported
    ? imported.program
    : engineId
      ? (Object.hasOwn(ENGINE_LABELS, engineId) ? ENGINE_LABELS[engineId] : engineId)
      : null;
  const overall = gates ? gateResult(gates.overall) : null;
  const title = text(record.title);

  // Issue 131: an imported record is never given the run treatment. It has no
  // status, no gates and no fixture flag, because none of those happened here;
  // the header carries the one badge that says what it is.
  const badges = imported
    ? [
      importedBadgeHtml(record),
      flags.truncated ? '<span class="results-badge is-truncated" data-role="truncated-badge">TRUNCATED</span>' : '',
    ].filter(Boolean).join('')
    : [
      `<span class="results-badge is-status-${esc(status)}" data-role="run-status">${esc(status)}</span>`,
      overall ? `<span class="results-badge is-gates-${overall}" data-role="gates-overall">gates ${esc(overall)}</span>` : '',
      flags.fixture ? '<span class="results-badge is-fixture" data-role="fixture-badge">FIXTURE</span>' : '',
      flags.truncated ? '<span class="results-badge is-truncated" data-role="truncated-badge">TRUNCATED</span>' : '',
    ].filter(Boolean).join('');

  const banners = [
    imported
      ? '<p class="results-banner is-imported" data-role="imported-banner">'
        + `Imported result — this number was computed by ${esc(imported.program ?? MISSING_TEXT)}`
        + `${imported.version ? ` ${esc(imported.version)}` : ''}, not by NodeChem Studio. `
        + 'The source hash identifies the file it came from; it does not certify the calculation.</p>'
      : '',
    flags.fixture
      ? '<p class="results-banner is-fixture" data-role="fixture-banner">Fixture output — synthetic dry-run data, not a real calculation. Treat every number below as test data.</p>'
      : '',
    flags.truncated
      ? `<p class="results-banner is-truncated" data-role="truncation-banner">${esc(truncationBanner(flags.bytes))}</p>`
      : '',
  ].filter(Boolean).join('');

  // Issue 184: the measured trace lives on the record. `options` carries the
  // one imported in this session before it is written back, and the note explains
  // the last import attempt (or its refusal).
  const spectrumOverlay = isObject(options.spectrumOverlay)
    ? options.spectrumOverlay
    : (isObject(record.spectrumOverlay) ? record.spectrumOverlay : null);
  const spectrumOverlayNote = text(options.spectrumOverlayNote);

  const cards = imported
    ? [
      importedEnergyCard(imported),
      solutionEnergeticsCard(record, parsed, flags, options),
    ].filter(Boolean).join('')
    : [
      runCard(record, parsed, status, engineLabel),
      programCard(parsed, flags),
      energyCard(parsed, flags),
      saptCard(parsed, flags),
      thermochemistryCard(parsed, flags),
      methodsCard(record),
      frequenciesCard(parsed, flags),
      excitedStatesCard(parsed, flags, record, spectrumOverlay, spectrumOverlayNote),
      emissionCard(parsed, flags, emission),
      ntoCard(flags, nto),
      excitedStateOptimizationCard(parsed, flags, jobSettings),
      orbitalsCard(parsed, flags),
      reactionPathCard(record, parsed, flags, options),
      solutionEnergeticsCard(record, parsed, flags, options),
      trajectoryCard(parsed, flags),
      nmrCard(parsed, flags),
      ramanCard(parsed, flags),
      vcdCard(parsed, flags),
      ecdCard(parsed, flags),
      chargesCard(parsed, flags),
      sensitivityCard(record),
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
    + `<h3 class="results-title">${title ? esc(title) : (imported ? 'Imported result' : 'Untitled run')}</h3>`
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
  let wavefunctionViewport = null;
  installStyles(doc);

  // The queue that produced the run is kept so a reaction path can be rendered
  // with the ΔG‡ verdict the queue computed for it. The card still refuses to
  // print k when a run has no verdict or no declared molecularity; this only
  // supplies what the queue already knows.
  let queueReactions = {};
  let queueTasksByRunId = new Map();
  const rememberQueue = (queue) => {
    if (!queue || typeof queue !== 'object') return;
    queueReactions = queue.reactions && typeof queue.reactions === 'object' ? queue.reactions : {};
    queueTasksByRunId = new Map((Array.isArray(queue.tasks) ? queue.tasks : [])
      .filter((task) => task?.runId)
      .map((task) => [String(task.runId), task]));
  };
  const reactionOptions = (record) => {
    const task = queueTasksByRunId.get(String(record?.id ?? ''));
    if (!task) return {};
    const base = {
      // issue 146: the queue knows which block produced this run, so the emission
      // label and the NTO/Pop chain reach the cards from the workflow — not
      // from a guess about the excitation table.
      ...(isObject(task.settings) ? { settings: task.settings } : {}),
      ...(isObject(task.emission) ? { emission: task.emission } : {}),
      ...(isObject(task.nto) ? { nto: task.nto } : {}),
    };
    const reaction = task ? queueReactions[task.nodeId] : null;
    if (!reaction) return base;
    return {
      ...base,
      reaction,
      molecularity: Number.isFinite(task?.molecularity) ? task.molecularity : null,
      molecularityBasis: task?.molecularityBasis || null,
    };
  };

  /**
   * Issue 184: the measured trace is imported from the excited-state card. The
   * file's bytes are hashed on the way in, so the figure can state which file it
   * drew. The digest and the points go on the record this panel renders; nothing
   * is written to `run.json` here — the runner owns that file.
   */
  let spectrumOverlayNote = '';

  const show = (record, { note = null } = {}) => {
    if (!isObject(record)) {
      currentRecord = null;
      container.hidden = true;
      container.innerHTML = '';
      wavefunctionViewport?.destroy();
      wavefunctionViewport = null;
      consoleEl?.classList.remove('has-results');
      return;
    }
    // A note about an import belongs to the record it was made on.
    if (text(currentRecord?.id) !== text(record.id)) spectrumOverlayNote = '';
    if (note !== null) spectrumOverlayNote = note;
    currentRecord = record;
    container.innerHTML = resultsPanelHtml(record, { ...reactionOptions(record), spectrumOverlayNote });
    container.hidden = false;
    consoleEl?.classList.add('has-results');
    mountCompareBar(record);
    mountThermoEnsemble();
    mountSuperposition({ container, currentRecord: record, desktop, doc });
    // The wavefunction viewport evaluates the basis this record carries (or a
    // cube the user opens) into a slice or an isosurface. It mounts last so it
    // can append its own wide card after the generated ones.
    wavefunctionViewport?.destroy();
    wavefunctionViewport = mountWavefunctionViewport({ container, record, desktop, doc });
  };

  /**
   * The NMR card owns its broadening and reference controls: changing either
   * recomputes the figure and the table from the parsed shieldings without a
   * round trip to the main process.
   */
  const rerenderNmr = () => {
    const nmr = currentRecord?.parsed?.nmr;
    const holder = container.querySelector('[data-field="nmr-figure"]');
    if (!nmr || !holder) return;
    const value = (selector) => container.querySelector(selector)?.value ?? '';
    const reference = value('[data-nmr-reference]').trim();
    holder.innerHTML = nmrSectionHtml(nmr, {
      nucleus: value('[data-nmr-nucleus]') || '1H',
      referencePpm: reference === '' ? null : Number(reference),
      fwhmPpm: Number(value('[data-nmr-fwhm]')) > 0 ? Number(value('[data-nmr-fwhm]')) : 0.1,
    });
  };
  /**
   * The thermochemistry workbench: T, p and the term switches recompute the
   * table in place, and the CSV is generated from the same data object the
   * table is rendered from.
   */
  let ensembleRows = [];
  const thermoControls = () => {
    const value = (selector) => container.querySelector(selector)?.value ?? '';
    const temperatureK = Number(value('[data-thermo-temperature]'));
    const pressureAtm = Number(value('[data-thermo-pressure]'));
    const boxes = [...container.querySelectorAll('[data-thermo-term]')];
    return {
      temperatureK: temperatureK > 0 ? temperatureK : 298.15,
      pressureAtm: pressureAtm > 0 ? pressureAtm : 1,
      enabled: new Set(boxes.filter((box) => box.checked).map((box) => box.dataset.thermoTerm)),
    };
  };
  const selectedEnsemble = () => [...container.querySelectorAll('[data-ensemble-run]')]
    .filter((box) => box.checked)
    .map((box) => box.value);
  /**
   * Raman (#76): the FWHM and the measured overlay both redraw from the same
   * parsed mode list. The imported series is held here, not re-read from the
   * file input, so changing the FWHM keeps it.
   */
  let ramanMeasured = null;
  let ramanOverlayName = '';
  let ramanOverlayNote = '';
  const rerenderEcd = () => {
    const parsed = currentRecord?.parsed;
    const holder = container.querySelector('[data-field="ecd-figure"]');
    if (!parsed?.rotatoryStrengths || !holder) return;
    const convention = container.querySelector('[data-ecd-convention]')?.value === 'length' ? 'length' : 'velocity';
    const raw = container.querySelector('[data-ecd-fwhm]')?.value ?? '';
    holder.innerHTML = ecdSectionHtml(parsed, { convention, fwhmEv: Number(raw) > 0 ? Number(raw) : 0.2 });
  };

  const rerenderRaman = () => {
    const modes = currentRecord?.parsed?.raman;
    const holder = container.querySelector('[data-field="raman-figure"]');
    if (!modes || !holder) return;
    const raw = container.querySelector('[data-raman-fwhm]')?.value ?? '';
    const fwhmCm = Number(raw) > 0 ? Number(raw) : 12;
    holder.innerHTML = ramanSectionHtml(modes, { fwhmCm, measured: ramanMeasured, overlayName: ramanOverlayName, overlayNote: ramanOverlayNote });
  };

  /**
   * VCD (#78): one control, one redraw. The signed curve is rebuilt from the
   * parsed mode list so the FWHM never has to be sent back to the engine.
   */
  const rerenderVcd = () => {
    const modes = currentRecord?.parsed?.vcd;
    const holder = container.querySelector('[data-field="vcd-figure"]');
    if (!modes || !holder) return;
    const raw = container.querySelector('[data-vcd-fwhm]')?.value ?? '';
    const fwhmCm = Number(raw) > 0 ? Number(raw) : 12;
    holder.innerHTML = vcdSectionHtml(modes, { fwhmCm });
  };

  const rerenderThermo = () => {
    const parsed = currentRecord?.parsed;
    const options = thermoControls();
    const holder = container.querySelector('[data-field="thermo-workbench-holder"]');
    if (parsed && holder) holder.innerHTML = thermoWorkbenchHtml(parsed, options);
    const ensemble = container.querySelector('[data-field="thermo-ensemble-holder"]');
    if (!ensemble) return;
    const selected = selectedEnsemble();
    ensemble.innerHTML = selected.length === 0
      ? ''
      : ensembleTableHtml(ensembleRows, { temperatureK: options.temperatureK, selected });
  };
  const exportThermoCsv = async () => {
    const parsed = currentRecord?.parsed;
    if (!parsed) return;
    const data = thermoTableData(parsed, thermoControls());
    if (!data.available) return;
    const csv = [
      'term,kcal_per_mol',
      ...data.terms.map((term) => `"${term.label.replace(/"/g, '""')}",${term.kcalPerMol.toFixed(3)}`),
      `"Σ correction to G",${data.totalKcalPerMol.toFixed(3)}`,
      `"G / Eh",${data.gibbsHartree === null ? '' : data.gibbsHartree.toFixed(6)}`,
      `"T / K",${data.temperatureK}`,
      `"p / atm",${data.pressureAtm}`,
      `"standard state T / K",${data.standardState.temperatureK}`,
      `"standard state p / atm",${data.standardState.pressureAtm}`,
    ].join('\n') + '\n';
    if (desktop?.saveText) {
      await desktop.saveText({ suggestedName: `thermochemistry-${text(currentRecord?.id) || 'run'}.csv`, text: csv });
    }
  };
  const mountThermoEnsemble = async () => {
    const picker = container.querySelector('[data-field="thermo-ensemble-picker"]');
    if (!picker || !desktop?.listRuns) return;
    let runs = [];
    try {
      runs = await desktop.listRuns();
    } catch {
      return;
    }
    ensembleRows = (Array.isArray(runs) ? runs : [])
      .filter((run) => Number.isFinite(run?.parsed?.thermochemistry?.freeEnergyHartree))
      .slice(0, 12)
      .map((run) => ({
        id: run.id,
        label: `${run.id}${run.title ? ` · ${run.title}` : ''}`,
        gibbsHartree: run.parsed.thermochemistry.freeEnergyHartree,
      }));
    if (ensembleRows.length < 2) {
      picker.innerHTML = '<p class="results-missing">No two finished runs report a free energy, so no ensemble can be built.</p>';
      return;
    }
    picker.innerHTML = '<div class="thermo-ensemble-picker">'
      + ensembleRows.map((row) => `<label><input type="checkbox" data-ensemble-run value="${esc(row.id)}"> ${esc(row.label)}</label>`).join('')
      + '</div>';
    rerenderThermo();
  };

  /**
   * Read the chosen file as bytes, not text: the sha256 in the record must be
   * the digest of the file on disk, and a text round trip can renormalise line
   * endings. A refusal is printed verbatim and never replaces the trace already
   * on the figure.
   */
  const importSpectrumOverlay = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result || new ArrayBuffer(0));
      try {
        const imported = importMeasuredSpectrum({ name: file.name, bytes });
        currentRecord = { ...currentRecord, spectrumOverlay: spectrumOverlayField(imported) };
        spectrumOverlayNote = `Imported ${imported.points.length} points from “${file.name}” `
          + `(${imported.columns.x}, ${imported.columns.y}; x in ${imported.units.x}), `
          + `sha256 ${imported.sha256}.`;
      } catch (error) {
        spectrumOverlayNote = currentRecord?.spectrumOverlay
          ? `${error.message} The figure still shows the previously imported trace.`
          : error.message;
      }
      show(currentRecord);
    };
    reader.readAsArrayBuffer(file);
  };

  container.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.matches('[data-nmr-nucleus], [data-nmr-reference], [data-nmr-fwhm]')) rerenderNmr();
    if (target.matches('[data-raman-fwhm]')) rerenderRaman();
    if (target.matches('[data-vcd-fwhm]')) rerenderVcd();
    if (target.matches('[data-ecd-convention], [data-ecd-fwhm]')) rerenderEcd();
    if (target.matches('[data-thermo-temperature], [data-thermo-pressure], [data-thermo-term], [data-ensemble-run]')) rerenderThermo();
  });
  container.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.matches('[data-nmr-nucleus], [data-nmr-reference], [data-nmr-fwhm]')) rerenderNmr();
    if (target.matches('[data-raman-fwhm]')) rerenderRaman();
    if (target.matches('[data-vcd-fwhm]')) rerenderVcd();
    if (target.matches('[data-spectrum-overlay]') && target.files && target.files[0]) {
      importSpectrumOverlay(target.files[0]);
    }
    if (target.matches('[data-raman-overlay]') && target.files && target.files[0]) {
      const file = target.files[0];
      const reader = new FileReader();
      reader.onload = () => {
        // A JCAMP-DX file and a two-column dump arrive through the same input;
        // importSpectrumText decides which it is and the reader's refusals are
        // printed verbatim rather than collapsed into "nothing was overlayed".
        const text = String(reader.result || '');
        ramanMeasured = null;
        ramanOverlayName = '';
        ramanOverlayNote = '';
        try {
          const imported = importSpectrumText(text);
          if (!imported) {
            ramanOverlayNote = 'That file holds no two-column numeric rows and no JCAMP-DX data section, so nothing was overlayed.';
          } else if (imported.format === 'jcamp-dx' && sameAxisUnits(imported.xUnits, '1/CM') === false) {
            ramanOverlayNote = `That JCAMP-DX file declares ${imported.xUnits} on its x axis, not 1/CM, so it is not drawn against a vibrational spectrum.`;
          } else {
            ramanMeasured = imported;
            ramanOverlayName = file.name;
            if (imported.format === 'jcamp-dx') {
              ramanOverlayNote = imported.xUnitsUnknown
                ? `Imported ${imported.npoints} points from ${imported.axis}; the file declares no ##XUNITS, so its axis is assumed to match the simulated one.`
                : `Imported ${imported.npoints} points from ${imported.axis} in ${imported.xUnits}.`;
            }
          }
        } catch (error) {
          ramanOverlayNote = error.message;
        }
        rerenderRaman();
      };
      reader.readAsText(file);
    }
    if (target.matches('[data-thermo-temperature], [data-thermo-pressure], [data-thermo-term], [data-ensemble-run]')) rerenderThermo();
  });
  container.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-thermo-export]')) exportThermoCsv();
    if (target.closest('[data-spectrum-overlay-clear]') && isObject(currentRecord)) {
      const next = { ...currentRecord };
      delete next.spectrumOverlay;
      show(next, { note: 'Removed the measured trace; the figure is the computed spectrum again.' });
    }
  });

  /**
   * Difference-first comparison against any other finished run. The select is
   * populated lazily from the run folders the main process already lists; a
   * failed load leaves the panel alone instead of blanking it.
   */
  const mountCompareBar = async (record) => {
    if (!desktop?.listRuns) return;
    const runId = text(record.id);
    if (!runId) return;
    let runs = [];
    try {
      runs = await desktop.listRuns();
    } catch {
      return;
    }
    const others = (Array.isArray(runs) ? runs : [])
      .filter((candidate) => candidate && text(candidate.id) && text(candidate.id) !== runId)
      .slice(0, 40);
    if (!others.length) return;
    if (text(currentRecord?.id) !== runId) return;
    const bar = doc.createElement('div');
    bar.className = 'results-compare-bar';
    bar.innerHTML = '<label class="results-compare-label">Compare with'
      + '<select class="results-compare-select" data-role="compare-select">'
      + '<option value="">Select a finished run…</option>'
      + others.map((candidate) => `<option value="${esc(candidate.id)}">`
        + `${esc(candidate.title || candidate.id)} · ${esc(candidate.status || 'unknown')}</option>`).join('')
      + '</select></label><div class="results-compare-output" data-role="compare-output"></div>';
    container.appendChild(bar);
    const select = bar.querySelector('[data-role="compare-select"]');
    const output = bar.querySelector('[data-role="compare-output"]');
    select?.addEventListener('change', async () => {
      const otherId = select.value;
      if (!otherId) {
        output.innerHTML = '';
        return;
      }
      const other = await findRun(desktop, otherId);
      if (!other) {
        output.innerHTML = '<p class="results-missing">That run could not be loaded.</p>';
        return;
      }
      output.innerHTML = comparisonHtml(compareRuns(other, record));
    });
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

  /**
   * Issue 154: a click on a queue/history row must land on the Results
   * section, not just build the panel behind the Queue pane. The console and
   * its tabs are the app shell's, but this module already holds the console
   * element, so the switch happens here on the same attributes `app.js` uses.
   * The Results tab is enabled in the same gesture: a user who has just
   * finished a run should not have to click a row *and then* find the tab.
   */
  const revealResultsSection = () => {
    if (consoleEl) consoleEl.dataset.pane = 'results';
    for (const tab of doc.querySelectorAll('#run-tabs [data-run-tab]')) {
      const active = tab.dataset.runTab === 'results';
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    const resultsTab = doc.querySelector('#run-tabs [data-run-tab="results"]');
    if (resultsTab) {
      resultsTab.classList.remove('is-disabled');
      resultsTab.setAttribute('aria-disabled', 'false');
      resultsTab.title = 'Parsed results of the last run';
    }
    const dot = doc.getElementById('run-tab-results-dot');
    if (dot) dot.hidden = false;
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
    // Both branches have replaced the results panel, so both belong on screen.
    revealResultsSection();
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

  // Queue snapshots carry the reaction verdicts. A later snapshot re-renders a
  // reaction path that was shown before its ΔG‡ was available.
  desktop?.onQueueEvent?.((event) => {
    rememberQueue(event?.queue);
    if (currentRecord && Object.keys(reactionOptions(currentRecord)).length > 0) show(currentRecord);
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
/* Results are a section of the console now (Setup · Queue · Results), so a
   finished run must not blow the window up to a 980 × 940 hero: the console
   keeps its bounded size and the results pane scrolls inside it. */
/* No width override: the console is one size whatever section is open. */
.run-results {
  min-height: 0; overflow-y: auto; padding: 12px 14px 14px;
  background: color-mix(in srgb, var(--surface-panel) 72%, transparent);
}
.results-panel { display: flex; flex-direction: column; gap: 10px; font-size: var(--text-size-xs); color: var(--text-primary); }
.results-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.results-head-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.results-title { font-size: var(--text-size-md); font-weight: 650; letter-spacing: -.01em; line-height: 1.3; overflow-wrap: anywhere; }
.results-badges { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.results-badge {
  font-size: var(--text-size-xs); font-weight: 650; letter-spacing: .06em; text-transform: uppercase;
  padding: 3px 7px; border: 1px solid var(--border-subtle); border-radius: 999px; color: var(--text-secondary);
  white-space: nowrap;
}
.results-badge.is-status-completed, .results-badge.is-gates-pass { color: var(--state-passed); border-color: color-mix(in srgb, var(--state-passed) 45%, var(--border-subtle)); }
.results-badge.is-status-failed, .results-badge.is-gates-fail { color: var(--state-review); border-color: color-mix(in srgb, var(--state-review) 45%, var(--border-subtle)); }
.results-badge.is-status-needs-review, .results-badge.is-status-running,
.results-badge.is-gates-unknown { color: var(--kind-condition); border-color: color-mix(in srgb, var(--kind-condition) 45%, var(--border-subtle)); }
.results-badge.is-status-cancelled, .results-badge.is-status-unknown { color: var(--text-secondary); }
.results-badge.is-fixture { color: var(--kind-condition); background: var(--tone-orange-6a); border-color: var(--tone-orange-13a); }
.results-badge.is-imported { color: var(--tone-blue-126); background: var(--tone-blue-100a); border-color: var(--tone-blue-106a); }
.results-badge.is-truncated { color: var(--state-review); background: var(--tone-red-6a); border-color: var(--tone-red-13a); }
.results-banners { display: flex; flex-direction: column; gap: 6px; }
.results-banner {
  margin: 0; padding: 7px 9px; border: 1px solid var(--border-subtle); border-radius: 8px;
  font-size: var(--text-size-xs); line-height: 1.45;
}
.results-banner.is-fixture { color: var(--tone-yellow-1); background: var(--tone-orange-5a); border-color: var(--tone-orange-12a); }
.results-banner.is-truncated { color: var(--tone-red-16); background: var(--tone-red-5a); border-color: var(--tone-red-12a); }
.results-banner.is-imported { color: var(--tone-blue-126); background: var(--tone-blue-100a); border-color: var(--tone-blue-106a); }
.results-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.results-card {
  min-width: 0; padding: 9px 10px; border: 1px solid var(--border-subtle); border-radius: 9px;
  background: color-mix(in srgb, var(--surface-raised) 52%, transparent);
}
.results-card.is-wide { grid-column: 1 / -1; }
.results-card.is-error { border-color: color-mix(in srgb, var(--state-review) 30%, var(--border-subtle)); }
.results-methods-text {
  margin: 0; white-space: pre-wrap; overflow-wrap: anywhere;
  color: var(--text-primary); font: var(--text-size-xs)/1.5 var(--font-mono);
}
.results-card-title {
  margin-bottom: 6px; color: var(--text-secondary); font-size: var(--text-size-xs); font-weight: 700;
  letter-spacing: .1em; text-transform: uppercase;
}
.results-kv { display: grid; grid-template-columns: minmax(92px, 40%) minmax(0, 1fr); gap: 3px 9px; }
.results-kv-wide { grid-template-columns: minmax(86px, 18%) minmax(0, 1fr); }
.results-kv dt { color: var(--text-secondary); font-size: var(--text-size-xs); }
.results-kv dd { margin: 0; min-width: 0; font: var(--text-size-xs)/1.45 var(--font-mono); overflow-wrap: anywhere; }
.results-kv dd code { font: inherit; }
.results-missing { color: var(--text-tertiary); font: italic var(--text-size-xs)/1.45 var(--font-ui); }
.results-route {
  display: block; margin-top: 7px; padding: 6px 7px; border: 1px solid var(--border-subtle);
  border-radius: 6px; background: var(--tone-blue-5); color: var(--tone-blue-126);
  font: var(--text-size-xs)/1.45 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere;
}
.results-chip, .results-gate {
  display: inline-block; padding: 2px 6px; border: 1px solid var(--border-subtle);
  border-radius: 999px; font: var(--text-size-xs)/1.35 var(--font-mono); text-transform: lowercase;
}
.results-chip.is-status-completed, .results-gate.is-pass { color: var(--state-passed); border-color: color-mix(in srgb, var(--state-passed) 40%, var(--border-subtle)); }
.results-chip.is-status-failed, .results-gate.is-fail { color: var(--state-review); border-color: color-mix(in srgb, var(--state-review) 40%, var(--border-subtle)); }
.results-chip.is-status-needs-review, .results-chip.is-status-running,
.results-chip.is-status-unknown, .results-gate.is-unknown { color: var(--kind-condition); border-color: color-mix(in srgb, var(--kind-condition) 40%, var(--border-subtle)); }
.results-note { margin: 6px 0 0; color: var(--text-tertiary); font-size: var(--text-size-xs); line-height: 1.45; }
.results-note.is-warn { color: var(--state-review); }
.results-kinetics-line { font-family: var(--font-mono); color: var(--text-primary); }
.results-big { margin: 2px 0 0; font: var(--text-size-lg)/1.35 var(--font-mono); color: var(--text-primary); }
.results-modes { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 3px 6px; }
.results-mode { font: var(--text-size-xs)/1.35 var(--font-mono); color: var(--text-primary); }
.results-mode.is-imaginary { color: var(--state-review); }
.results-unit { color: var(--text-tertiary); font-size: var(--text-size-xs); }
.results-table { width: 100%; border-collapse: collapse; margin-top: 4px; font: var(--text-size-xs)/1.5 var(--font-mono); }
.results-table th {
  padding: 3px 4px; border-bottom: 1px solid var(--border-subtle); color: var(--text-secondary);
  font: 600 var(--text-size-2xl)/1.4 var(--font-ui); text-align: left; letter-spacing: .03em;
}
.results-table td { padding: 2px 4px; border-bottom: 1px solid var(--tone-blue-69a); vertical-align: top; overflow-wrap: anywhere; }
.results-table tbody tr:last-child td { border-bottom: 0; }
.results-gate-table td { font-family: var(--font-ui); }
.results-gate-table td:nth-child(2) { width: 64px; }
.results-gate-table td:nth-child(3) { color: var(--text-secondary); font-family: var(--font-mono); font-size: var(--text-size-xs); }
.results-gates-head { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.results-gate-optional { color: var(--text-tertiary); font: var(--text-size-xs)/1.3 var(--font-ui); text-transform: uppercase; letter-spacing: .05em; }
.results-caveat { margin: 7px 0 0; color: var(--kind-condition); font-size: var(--text-size-xs); line-height: 1.45; }
.results-charge-block + .results-charge-block { margin-top: 8px; }
.results-charge-title {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  color: var(--text-primary); font-size: var(--text-size-xs); font-weight: 600;
}
.results-charge-title span { color: var(--text-tertiary); font-size: var(--text-size-xs); font-weight: 400; }
.results-charge-table th:first-child, .results-charge-table td:first-child { width: 42px; }
.results-pre {
  margin: 7px 0 0; padding: 7px; max-height: 110px; overflow: auto; border-radius: 6px;
  background: var(--tone-blue-5); color: var(--tone-blue-126); font: var(--text-size-xs)/1.5 var(--font-mono); white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.results-diagnosis {
  margin-top: 8px; padding: 8px 9px; border-radius: 7px;
  border: 1px solid var(--tone-neutral-15a);
  background: var(--tone-neutral-11a);
}
.results-diagnosis[data-severity="fatal"] { border-color: var(--tone-red-3a); }
.results-diagnosis-title {
  margin: 0 0 4px; font-size: var(--text-size-xs); font-weight: 650; letter-spacing: .01em;
}
.results-diagnosis-cause { margin: 0 0 5px; color: var(--text-secondary); font-size: var(--text-size-xs); line-height: 1.5; }
.results-diagnosis-action { margin: 0; font-size: var(--text-size-xs); line-height: 1.5; }
.results-diagnosis-action strong { color: var(--text-primary); font-weight: 650; }

.results-compare-bar {
  margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--border-subtle);
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
}
.results-compare-label {
  display: flex; gap: 6px; align-items: center;
  color: var(--text-secondary); font-size: var(--text-size-xs); letter-spacing: .06em; text-transform: uppercase;
}
.results-compare-select {
  background: var(--tone-blue-12); color: var(--text-primary); border: 1px solid var(--border-subtle);
  border-radius: 6px; padding: 4px 6px; font: var(--text-size-xs) var(--font-ui);
}
.results-compare-output { flex-basis: 100%; }
.results-compare {
  margin-top: 6px; border: 1px solid var(--border-subtle); border-radius: 7px; overflow: hidden;
}
.results-compare-head {
  display: flex; flex-direction: column; gap: 2px; padding: 7px 9px;
  background: var(--tone-neutral-11a);
}
.results-compare-title { font-size: var(--text-size-xs); font-weight: 650; }
.results-compare-summary { color: var(--text-secondary); font-size: var(--text-size-xs); }
.results-compare-note {
  margin: 0; padding: 5px 9px; font-size: var(--text-size-xs); color: var(--tone-orange-18);
  background: var(--tone-orange-17a);
}
.results-compare-table { width: 100%; border-collapse: collapse; font-size: var(--text-size-xs); }
.results-compare-table th, .results-compare-table td {
  padding: 4px 9px; text-align: right; border-top: 1px solid var(--border-subtle);
}
.results-compare-table thead th { color: var(--text-tertiary); font-weight: 500; text-transform: uppercase; letter-spacing: .05em; }
.results-compare-table tbody th { text-align: left; font-weight: 500; color: var(--text-secondary); }
.results-compare-table tr.is-changed td { color: var(--tone-orange-18); }
.results-compare-row-note { display: block; color: var(--text-tertiary); font-size: var(--text-size-xs); }
.results-compare-foot { margin: 0; padding: 5px 9px 7px; color: var(--text-tertiary); font-size: var(--text-size-xs); }

.results-spectrum { margin: 8px 0 2px; }
.results-spectrum svg { width: 100%; max-width: 420px; height: auto; display: block; }
.spectrum-axis { stroke: var(--tone-blue-76a); stroke-width: 1; }
.spectrum-curve { fill: none; stroke: var(--tone-blue-124); stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round; }
.spectrum-curve.is-overlay { stroke: var(--kind-condition); stroke-width: 1.2; stroke-dasharray: 2.5 1.6; }
.nmr-controls input[type="file"] { width: auto; max-width: 220px; padding: 2px; }
.spectrum-label { fill: var(--text-tertiary); font-size: var(--text-size-xs); font-family: var(--font-mono); }
.profile-peak { fill: var(--tone-blue-124); stroke: var(--tone-blue-20); stroke-width: 1; }
.nmr-controls { display: flex; flex-wrap: wrap; gap: 10px; margin: 6px 0 8px; font-size: var(--text-size-xs); color: var(--text-secondary); }
.nmr-controls label { display: flex; align-items: center; gap: 5px; }
.nmr-controls input, .nmr-controls select { width: 92px; font: inherit; padding: 2px 4px; background: var(--surface-well); color: var(--text-primary); border: 1px solid var(--border-subtle); border-radius: 4px; }
.nmr-controls input[type="number"] { width: 78px; }
.results-spectrum figcaption { margin-top: 3px; color: var(--text-tertiary); font-size: var(--text-size-xs); line-height: 1.45; }
.results-provenance { border-top: 1px solid var(--border-subtle); padding-top: 7px; }
.results-provenance summary {
  cursor: pointer; color: var(--text-secondary); font-size: var(--text-size-xs); letter-spacing: .08em;
  text-transform: uppercase;
}
.results-provenance summary span {
  margin-left: 8px; color: var(--text-tertiary); letter-spacing: 0; text-transform: none;
}
.results-empty { padding: 4px 0; }
.results-empty p { margin-top: 4px; color: var(--text-secondary); font-size: var(--text-size-xs); }
#run-history [data-run-id]:not([data-run-id=""]),
#queue-list [data-run-id]:not([data-run-id=""]) { cursor: pointer; }
#run-history [data-run-id]:not([data-run-id=""]):hover,
#queue-list [data-run-id]:not([data-run-id=""]):hover { border-color: var(--border-strong); }
#run-history .queue-item.is-selected, #queue-list .queue-item.is-selected {
  border-color: color-mix(in srgb, var(--action) 55%, var(--border-subtle));
  background: color-mix(in srgb, var(--action) 12%, var(--surface-raised));
}
.results-spread { color: var(--kind-condition); }
.results-card .results-table + .results-note { margin-top: 5px; }
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
