/**
 * ECD — electronic circular dichroism from TD-DFT (#75).
 *
 * A TD job prints the rotatory strength of each excited state in **two**
 * conventions:
 *
 *   R(velocity)  — the magnetic-dipole operator enters through the momentum
 *   R(length)    — through the position operator
 *
 * They agree only in a complete basis. A spectrum that does not say which one
 * produced it is not reproducible, so the convention is a required argument
 * here and is printed on the panel.
 *
 * The unit is the one Gaussian prints: 10⁻⁴⁰ erg·esu·cm/Gauss (cgs). No
 * conversion to Δε is attempted: that needs a band shape and a calibration to
 * the instrument, and inventing one would make the figure look quantitative
 * when it is not.
 */

import { toLines } from './lines.js';

const HEADER = /Rotatory\s+Strengths\s*\(R\)\s*in\s*cgs/i;
const VELOCITY = /R\s*\(\s*velocity\s*\)/i;
const LENGTH = /R\s*\(\s*length\s*\)/i;
const ROW = /^\s*(\d+)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+(-?\d+(?:\.\d+)?))?\s*$/;

/**
 * @returns {{conventions: {velocity: Array, length: Array}, unit: string,
 *   scaleFactor: string}|null}
 */
export function parseRotatoryStrengths(text) {
  const lines = toLines(text);
  const conventions = { velocity: [], length: [] };
  let conventionsSeen = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!HEADER.test(line)) continue;
    // The column header on the next line names the convention; the rows after
    // it belong to that table until something else starts.
    const header = lines[index + 1] || '';
    const convention = VELOCITY.test(header) ? 'velocity' : LENGTH.test(header) ? 'length' : '';
    if (!convention) continue;
    conventionsSeen += 1;
    for (let cursor = index + 2; cursor < lines.length; cursor += 1) {
      const match = lines[cursor].match(ROW);
      if (!match) break;
      conventions[convention].push({
        state: Number(match[1]),
        xx: Number(match[2]),
        yy: Number(match[3]),
        zz: Number(match[4]),
        r: Number(match[5]),
        // The velocity table also prints the electric-magnetic angle; the
        // length table stops at R.
        emAngleDeg: match[6] === undefined ? null : Number(match[6]),
      });
    }
  }

  if (conventionsSeen === 0) return null;
  return {
    conventions,
    unit: '10^-40 erg·esu·cm/Gauss (cgs)',
    // Gaussian prints the header with this factor; keeping it lets the panel
    // state the scale instead of implying the raw number is unitless.
    scaleFactor: '1e-40 cgs',
  };
}

/**
 * Signed ECD curve.
 *
 * Rotatory strength is signed, so the curve is too: a positive band is one
 * sign of the Cotton effect, negative the other. Energies come from the TD
 * state table, which is parsed separately, and are matched by state index.
 */
export function ecdSpectrum(states, { convention = 'velocity', fwhmEv = 0.20, points = 600 } = {}) {
  const list = Array.isArray(states) ? states : [];
  const peaks = list
    .filter((state) => Number.isFinite(state?.energyEv) && Number.isFinite(state?.rotatoryStrength))
    .map((state) => ({ energyEv: state.energyEv, r: state.rotatoryStrength, state: state.index }));
  if (peaks.length === 0) return null;

  const half = Math.max(Number(fwhmEv) / 2, 0.001);
  const pad = Math.max(6 * half, 0.4);
  const low = Math.max(0, Math.min(...peaks.map((peak) => peak.energyEv)) - pad);
  const high = Math.max(...peaks.map((peak) => peak.energyEv)) + pad;
  const step = (high - low) / Math.max(points - 1, 1);

  const curve = [];
  for (let index = 0; index < points; index += 1) {
    const energy = low + step * index;
    let intensity = 0;
    for (const peak of peaks) {
      const delta = energy - peak.energyEv;
      intensity += (peak.r * half * half) / (delta * delta + half * half);
    }
    curve.push({ energyEv: energy, intensity });
  }
  const scale = Math.max(...curve.map((point) => Math.abs(point.intensity))) || 1;

  return {
    convention,
    conventionLabel: convention === 'length' ? 'R(length)' : 'R(velocity)',
    fwhmEv: Number(fwhmEv),
    shape: 'lorentzian',
    units: '10^-40 erg·esu·cm/Gauss (cgs)',
    quantity: 'rotatory strength',
    normalisation: `largest |band| = 1.00 (${scale.toPrecision(4)} in printed units × 1e-40)`,
    minEv: low,
    maxEv: high,
    peaks: peaks
      .map((peak) => ({ state: peak.state, energyEv: peak.energyEv, rotatoryStrength: peak.r }))
      .sort((a, b) => a.energyEv - b.energyEv),
    curve: curve.map((point) => ({ energyEv: point.energyEv, intensity: point.intensity / scale })),
  };
}

/** SVG polyline; the y axis is centred on zero because the sign is the point. */
export function ecdPolyline(spectrum, { width = 100, height = 100 } = {}) {
  if (!spectrum || !Array.isArray(spectrum.curve) || spectrum.curve.length === 0) return '';
  const span = spectrum.maxEv - spectrum.minEv || 1;
  return spectrum.curve
    .map((point) => {
      const x = ((point.energyEv - spectrum.minEv) / span) * width;
      const y = height / 2 - (point.intensity * height) / 2;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}
