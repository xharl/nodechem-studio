/**
 * Report figures: which pictures a run record can support, and from what.
 *
 * This module is the honest half of the report's figures. Each entry names the
 * data it was built from; when the data are absent the entry says why instead of
 * disappearing, so a reader can tell "this run printed no Raman activities" from
 * "the report builder forgot".
 *
 * Everything here is pure: `run.json` parsed fields in, figure strings out. A
 * .cube volume, when the run folder has one, is passed in already parsed.
 */

import { ecdSpectrum } from '../ecd.js';
import { nmrShifts, nmrSpectrum } from '../nmr.js';
import { ramanSpectrum } from '../raman.js';
import { broadenedSpectrum } from '../spectrum.js';
import { trajectoryEnergies } from '../trajectory.js';
import { vcdSpectrum } from '../vcd.js';
import { broadenSticks, fromEcd, fromNmr, fromRaman, fromUvVis, fromVcd, spectrumFigure } from './spectra.js';
import { orbitalLevelsFigure } from './levels.js';
import { convergenceFigure } from './convergence.js';
import { contourFigure, sliceOf } from './contour.js';
import { surfaceFigure } from './surface.js';

const IR_FWHM = 12;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function numbers(list) {
  return (Array.isArray(list) ? list : []).map(Number).filter((value) => Number.isFinite(value));
}

/** IR from the printed frequency/IR-intensity columns, broadened at a stated width. */
function irFigure(parsed) {
  const meta = isObject(parsed?.normalModesMeta) ? parsed.normalModesMeta : null;
  const frequencies = numbers(meta?.frequencies);
  const intensities = numbers(meta?.irIntensities);
  const count = Math.min(frequencies.length, intensities.length);
  if (count < 1) return null;
  const sticks = frequencies.slice(0, count)
    .map((x, index) => ({ x, height: intensities[index], label: x.toFixed(0) }))
    .filter((stick) => stick.height > 0);
  if (sticks.length === 0) return null;
  const curve = broadenSticks(sticks, { fwhm: IR_FWHM });
  return spectrumFigure({
    kind: 'ir', title: 'IR (simulated)', curve, sticks, range: [Math.max(...frequencies) + 40, Math.min(...frequencies) - 40],
    fwhm: `Lorentzian, FWHM ${IR_FWHM} cm⁻¹`, quantity: 'IR intensities as printed (km/mol)',
  });
}

function ramanFigure(parsed) {
  const modes = Array.isArray(parsed?.raman) ? parsed.raman : [];
  const withActivity = modes.filter((mode) => Number.isFinite(mode.ramanActivity));
  if (withActivity.length === 0) return null;
  return fromRaman(ramanSpectrum(withActivity, { fwhmCm: IR_FWHM }));
}

function vcdFigure(parsed) {
  const modes = Array.isArray(parsed?.vcd) ? parsed.vcd : [];
  const withStrength = modes.filter((mode) => Number.isFinite(mode.rotationalStrength));
  if (withStrength.length === 0) return null;
  return fromVcd(vcdSpectrum(withStrength, { fwhmCm: IR_FWHM }));
}

function uvVisFigure(parsed) {
  const states = Array.isArray(parsed?.excitedStates?.states) ? parsed.excitedStates.states : [];
  if (states.length === 0) return null;
  return fromUvVis(broadenedSpectrum(states));
}

function ecdFigure(parsed) {
  const states = Array.isArray(parsed?.excitedStates?.states) ? parsed.excitedStates.states : [];
  const table = parsed?.rotatoryStrengths;
  const rows = Array.isArray(table?.conventions?.velocity) ? table.conventions.velocity : [];
  if (states.length === 0 || rows.length === 0) return null;
  const byState = new Map(rows.map((row) => [row.state, row]));
  const combined = states.map((state) => ({
    index: state.index,
    energyEv: Number(state.energyEv),
    wavelengthNm: Number(state.wavelengthNm),
    rotatoryStrength: byState.has(state.index) ? byState.get(state.index).r : null,
  }));
  return fromEcd(ecdSpectrum(combined, { convention: 'velocity' }));
}

function nmrFigure(parsed) {
  const block = isObject(parsed?.nmr) ? parsed.nmr : null;
  const atoms = Array.isArray(block?.atoms) ? block.atoms : [];
  if (!atoms || atoms.length === 0) return null;
  const spectrum = nmrSpectrum({ atoms, nucleus: '1H', fwhmPpm: 0.1 });
  return spectrum ? fromNmr(spectrum) : null;
}

function levelsFigure(parsed) {
  const manifolds = isObject(parsed?.orbitals?.manifolds) ? parsed.orbitals.manifolds : null;
  if (!manifolds) return null;
  const levelsFor = (manifold) => {
    if (!manifold) return [];
    const occupied = Array.isArray(manifold.occupied) ? manifold.occupied.slice(-3) : [];
    const virtual = Array.isArray(manifold.virtual) ? manifold.virtual.slice(0, 3) : [];
    return occupied.map((energyEh) => ({ energyEh, occupation: 2 }))
      .concat(virtual.map((energyEh) => ({ energyEh, occupation: 0 })));
  };
  const alpha = levelsFor(manifolds.alpha);
  if (alpha.length === 0) return null;
  return orbitalLevelsFigure({ alpha, beta: levelsFor(manifolds.beta) });
}

function convergenceFigureFor(parsed) {
  const points = trajectoryEnergies(parsed?.trajectory);
  if (!Array.isArray(points) || points.length < 2) return null;
  const series = points
    .filter((point) => Number.isFinite(point.energyHartree))
    .map((point) => ({ x: point.step, y: point.energyHartree }));
  return convergenceFigure({ series, title: 'Optimisation', xLabel: 'step', yLabel: 'E / Hartree' });
}

/**
 * Builds every figure a record supports.
 *
 * @param {object} record   the `run.json` document
 * @param {object} options
 * @param {object|null} options.volume   parsed cube volume, when the run folder has one
 * @param {string} options.level         'basic' | 'surfaces'
 * @returns {Array<{key:string, figure:object|null, reason?:string}>}
 */
export function taskFigures(record, { volume = null, surfaces = null, level = 'basic' } = {}) {
  const parsed = isObject(record?.parsed) ? record.parsed : {};
  const entries = [
    ['ir', irFigure(parsed)],
    ['raman', ramanFigure(parsed)],
    ['vcd', vcdFigure(parsed)],
    ['uvvis', uvVisFigure(parsed)],
    ['ecd', ecdFigure(parsed)],
    ['nmr', nmrFigure(parsed)],
    ['levels', levelsFigure(parsed)],
    ['convergence', convergenceFigureFor(parsed)],
  ];

  const figures = entries.map(([key, figure]) => ({ key, figure: figure || null }));

  if (surfaces && Array.isArray(surfaces.meshes) && surfaces.meshes.length > 0) {
    const drawn = surfaceFigure({
      meshes: surfaces.meshes, iso: surfaces.iso ?? null, field: 'ψ isosurface', units: 'au',
    });
    figures.push(drawn
      ? { key: 'surface', figure: drawn }
      : { key: 'surface', figure: null, reason: 'the isosurface has too many triangles to draw as vector output' });
  } else if (level === 'surfaces') {
    figures.push({ key: 'surface', figure: null, reason: 'no cube file in the run folder' });
  }

  if (level === 'surfaces' || level === 'basic') {
    if (volume && volume.axisAligned === false) {
      figures.push({
        key: 'contour',
        figure: null,
        reason: 'the cube axes are rotated, so an index-space slice would not be an xy plane',
      });
    } else if (volume && Array.isArray(volume.counts)) {
      const slice = sliceOf(volume, 'z');
      const contour = slice ? contourFigure({ slice, field: 'ψ (slice)', units: 'au' }) : null;
      if (contour) figures.push({ key: 'contour', figure: contour });
      else figures.push({ key: 'contour', figure: null, reason: 'the cube file could not be sliced' });
    } else if (level === 'surfaces') {
      figures.push({ key: 'contour', figure: null, reason: 'no cube file in the run folder' });
    }
  }
  return figures;
}

export { nmrShifts };
