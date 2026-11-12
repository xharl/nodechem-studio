/**
 * Thermochemistry view for the run console.
 *
 * Pure presentation: the numbers and the audit trail come from
 * `src/shared/thermochemistry.js`. This module only touches the DOM in
 * `mountThermochemistryView`; `thermochemistryPanelHtml` is a pure string
 * function so the row layout can be tested without a browser.
 */

import {
  HARTREE_TO_KCAL_PER_MOL,
  STANDARD_STATE_CORRECTION_KCAL_PER_MOL,
  buildThermochemistryReport,
} from '../shared/thermochemistry.js';

const OPTION_BY_LINE = {
  'quasi-rrho': 'quasiRRHO',
  'standard-state': 'standardState',
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function number(value, digits = 2, signed = false) {
  if (!Number.isFinite(value)) return '—';
  const text = value.toFixed(digits);
  return signed && value > 0 ? `+${text}` : text;
}

function constantLabel(line) {
  if (line.id === 'quasi-rrho') return `cutoff = ${line.constant.value} cm⁻¹`;
  if (line.id === 'standard-state') return `1 atm → 1 M = ${line.constant.value} kcal/mol`;
  return `${line.constant.name} = ${line.constant.value} ${line.constant.unit}`;
}

/**
 * Render the thermochemistry panel. Every correction is its own row with its
 * constant; the total is a separate row. A disabled correction shows its
 * computed value but contributes zero.
 *
 * Issue 350: when a frequency factor was applied, the ZPE correction is shown
 * as `raw → scaled` with the factor and its source. The printed G is not
 * re-derived, and the note beside the row says so.
 */
export function thermochemistryPanelHtml(report) {
  if (!report) return '';
  const baseline = report.baseline?.hartree !== null && Number.isFinite(report.baseline?.hartree)
    ? `${number(report.baseline.hartree, 6)} Eh · ${number(report.baseline.kcalPerMol)} kcal/mol`
    : 'not parsed';
  const rows = report.lines.map((line) => {
    const option = OPTION_BY_LINE[line.id];
    const checked = line.enabled ? ' checked' : '';
    const value = line.correctionKcalPerMol === null
      ? 'unavailable'
      : `${number(line.correctionKcalPerMol, 2, true)} kcal/mol`;
    return `<label class="run-thermo-row" title="${esc(line.detail)}">`
      + `<input type="checkbox" data-thermo-toggle="${esc(option)}"${checked}>`
      + `<span class="run-thermo-label">${esc(line.label)}`
      + `<small title="${esc(`${line.constant.name} = ${line.constant.value} ${line.constant.unit}`)}">`
      + `${esc(constantLabel(line))}</small></span>`
      + `<span class="run-thermo-value">${esc(value)}</span>`
      + '</label>';
  }).join('');
  const zeroPoint = report.zeroPoint;
  const zpeRow = zeroPoint && Number.isFinite(zeroPoint.rawHartree)
    ? '<div class="run-thermo-row" data-field="thermo-zpe">'
      + '<span class="run-thermo-label">ZPE correction'
      + `<small>${zeroPoint.applied
        ? `×${Number(zeroPoint.factor).toFixed(4)} · ${esc(zeroPoint.source || 'source not recorded')}`
        : 'unscaled — as printed'}</small></span>`
      + `<span class="run-thermo-value">${zeroPoint.applied
        ? `${number(zeroPoint.rawHartree, 6)} → ${number(zeroPoint.scaledHartree, 6)} Eh`
        : `${number(zeroPoint.rawHartree, 6)} Eh`}</span>`
      + '</div>'
    : '';
  const total = report.available
    ? `<strong>${number(report.total.hartree, 6)} Eh</strong>`
      + `<span>${number(report.total.kcalPerMol)} kcal/mol</span>`
    : '<strong class="run-thermo-unknown">unknown</strong>'
      + '<span>an enabled correction could not be computed</span>';
  const warnings = report.warnings.length
    ? `<div class="run-thermo-warn">${report.warnings.map(esc).join('<br>')}</div>`
    : '';
  return `<div class="run-thermo-head"><span>Thermochemistry</span>`
    + `<span>G from log: ${esc(baseline)}</span></div>`
    + rows
    + zpeRow
    + `<div class="run-thermo-total"><span>Corrected G</span>${total}</div>`
    + `<div class="run-thermo-note">1 Ha = ${number(HARTREE_TO_KCAL_PER_MOL, 4)} kcal/mol · `
    + `standard state ${number(STANDARD_STATE_CORRECTION_KCAL_PER_MOL)} kcal/mol `
    + `(298.15 K, RT ln 24.465)`
    + `${zeroPoint?.applied ? ' · the printed G is not re-derived from scaled frequencies' : ''}</div>`
    + warnings;
}

/**
 * Mount the panel and keep its two correction toggles live. Passing `null`
 * (a new run, or an output with no thermochemistry) hides and clears it.
 * xTB already reports a free energy with mRRHO entropy; the Gaussian
 * quasi-RRHO / standard-state corrections must not be offered on top of it.
 */
export function mountThermochemistryView(container, parsed, { engine = null, settings = null, frequencyScaleResolution = null } = {}) {
  if (!container) return;
  if (engine === 'xtb') {
    container.hidden = false;
    container.innerHTML = '<div class="run-thermo-head"><span>Thermochemistry</span><span>xTB mRRHO</span></div>'
      + '<p class="run-thermo-note">xTB free energies already use the mRRHO entropy treatment; '
      + 'Gaussian quasi-RRHO and 1 atm → 1 M corrections do not apply.</p>';
    return;
  }
  const thermochemistry = parsed?.thermochemistry;
  const hasThermochemistry = thermochemistry
    && (Number.isFinite(thermochemistry.freeEnergyHartree)
      || Number.isFinite(thermochemistry.temperatureK));
  if (!hasThermochemistry) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  const options = {
    quasiRRHO: true,
    standardState: true,
    frequencyScale: settings?.frequencyScale ?? 'unscaled',
    frequencyScaleResolution,
  };
  const render = () => {
    const report = buildThermochemistryReport(parsed, options);
    container.innerHTML = thermochemistryPanelHtml(report);
    container.hidden = false;
    for (const input of container.querySelectorAll('input[data-thermo-toggle]')) {
      input.addEventListener('change', () => {
        options[input.dataset.thermoToggle] = input.checked;
        render();
      });
    }
  };
  render();
}
