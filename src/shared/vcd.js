/**
 * VCD rotational strengths (#78).
 *
 * A `Freq=(VCD)` job prints two extra per-mode rows inside the frequency
 * section, next to the Raman rows:
 *
 * ```
 *  Harmonic frequencies (cm**-1), IR intensities (KM/Mole), Raman scattering
 *  activities (A**4/AMU), depolarization ratios for plane and unpolarized
 *  incident light, reduced masses (AMU), force constants (mDyne/A),
 *  Dipole strengths (10**-40 esu**2-cm**2),
 *  Rotational strengths (10**-44 esu**2-cm**2),
 *  E-M angle = Angle between electric and magnetic dipole transition moments (deg),
 *  and normal coordinates:
 *  ...
 *  Dip. str.   --      9.8394                40.5893                41.8584
 *  Rot. str.   --      3.9145               -12.6414                -2.0675
 *  E-M angle   --     70.6644               123.5470                97.0148
 * ```
 *
 * Three things the layout forces us to say out loud, and the card says them:
 *
 * 1. **Rotational strength is signed.** Unlike a Raman activity it can be
 *    negative; a spectrum built from |R| would be wrong and a spectrum
 *    normalised to the strongest positive band would hide the sign. The curve
 *    below is signed and normalised to the strongest |R|.
 * 2. **The printed unit is the whole statement.** Gaussian 16 A.03 writes
 *    `Rotational strengths (10**-44 esu**2-cm**2)` and prints no velocity-vs-
 *    length label for the row. The two representations agree only in a
 *    complete basis, so the record keeps `representation: null` and the card
 *    says "not stated in the output" rather than guessing.
 * 3. **The E-M angle is printed, not derived.** It is the angle between the
 *    electric and magnetic dipole transition moments in degrees, and it is
 *    carried through unchanged so a reader can check the sign convention.
 *
 * A plain `Freq` job has none of these rows, so `parseVcdStrengths` returns
 * `null` and no card is drawn — "no VCD" and "VCD with an empty table" are
 * different claims about a run.
 */

import { toLines } from './lines.js';
import { scaledModeTable } from './frequencyScaling.js';

const DIP_STRENGTH = /^\s*Dip\.\s*str(?:ength)?\.?\s*-{2,}\s*(.*)$/i;
const ROT_STRENGTH = /^\s*Rot\.\s*str(?:ength)?\.?\s*-{2,}\s*(.*)$/i;
const EM_ANGLE = /^\s*E-M\s*angle\s*-{2,}\s*(.*)$/i;
const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;

/** The unit Gaussian prints for the rotational-strength row, as written. */
export const VCD_UNITS = '10⁻⁴⁴ esu² cm²';
export const VCD_DIPOLE_UNITS = '10⁻⁴⁰ esu² cm²';

const numbers = (text) => (String(text || '').match(NUMBER) || []).map(Number);

/**
 * Pull the VCD rows out of a frequency section.
 *
 * Every row is appended rather than overwritten: a job prints one block per
 * group of (up to) three modes, so the rows are concatenated in mode order
 * exactly like the frequency table itself.
 */
export function parseVcdStrengths(text) {
  const lines = toLines(text);
  const rotational = [];
  const dipole = [];
  const emAngle = [];
  let representation = null;

  for (const line of lines) {
    const rot = line.match(ROT_STRENGTH);
    if (rot) {
      rotational.push(...numbers(rot[1]));
      continue;
    }
    const dip = line.match(DIP_STRENGTH);
    if (dip) {
      dipole.push(...numbers(dip[1]));
      continue;
    }
    const angle = line.match(EM_ANGLE);
    if (angle) {
      emAngle.push(...numbers(angle[1]));
      continue;
    }
    // A future revision (or a hand-annotated log) may state the representation.
    // Record it when it is there; never invent it when it is not.
    if (representation === null && /\b(velocity|length)\s+representation\b/i.test(line)) {
      const match = line.match(/\b(velocity|length)\s+representation\b/i);
      representation = match[1].toLowerCase();
    }
  }

  if (rotational.length === 0 || rotational.every((value) => !Number.isFinite(value))) return null;
  return {
    rotationalStrengths: rotational,
    dipoleStrengths: dipole,
    emAngles: emAngle,
    units: VCD_UNITS,
    dipoleUnits: VCD_DIPOLE_UNITS,
    representation,
  };
}

/**
 * Attach the VCD rows to a frequency mode table.
 *
 * A mode with no row keeps `null`, never `0`: a rotational strength of zero is
 * a measurement (an achiral mode), absence is not.
 */
export function attachVcd(modes, vcd) {
  const list = Array.isArray(modes) ? modes : [];
  if (!vcd) {
    return list.map((mode) => ({ ...mode, rotationalStrength: null, dipoleStrength: null, emAngle: null }));
  }
  return list.map((mode, index) => ({
    ...mode,
    rotationalStrength: Number.isFinite(vcd.rotationalStrengths[index]) ? vcd.rotationalStrengths[index] : null,
    dipoleStrength: Number.isFinite(vcd.dipoleStrengths[index]) ? vcd.dipoleStrengths[index] : null,
    emAngle: Number.isFinite(vcd.emAngles[index]) ? vcd.emAngles[index] : null,
  }));
}

/**
 * Broadened VCD spectrum in cm⁻¹.
 *
 * Signed Lorentzian sum of the rotational strengths, normalised to the
 * strongest |R| so an overlay can be scaled onto the same axis. `zero` marks
 * the sign change line at y = 0 in the normalised frame, because a VCD curve
 * that is drawn without it is unreadable.
 *
 * `scale` is a frequency-scaling resolution from `frequencyScaling.js`: when it
 * applied a factor the peaks carry `wavenumberRaw` beside the scaled
 * `wavenumber`, and `scaling` records the factor and its source. The rotational
 * strength itself is not scaled — #350's scope excludes intensities.
 */
export function vcdSpectrum(modes, { fwhmCm = 12, points = 600, scale = null } = {}) {
  const factor = scale?.applied ? Number(scale.factor) : 1;
  const peaks = scaledModeTable((Array.isArray(modes) ? modes : [])
    .filter((mode) => Number.isFinite(mode.wavenumber) && Number.isFinite(mode.rotationalStrength)), scale);
  if (peaks.length === 0) return null;

  const values = peaks.map((mode) => mode.wavenumber);
  const half = Math.max(Number(fwhmCm) / 2, 0.001);
  const pad = Math.max(6 * half, 20);
  const low = Math.min(...values) - pad;
  const high = Math.max(...values) + pad;
  const span = high - low || 1;
  const step = span / Math.max(points - 1, 1);

  const curve = [];
  for (let index = 0; index < points; index += 1) {
    const wavenumber = low + step * index;
    let intensity = 0;
    for (const mode of peaks) {
      const delta = wavenumber - mode.wavenumber;
      intensity += (mode.rotationalStrength * half * half) / (delta * delta + half * half);
    }
    curve.push({ wavenumber, intensity });
  }
  const strongest = Math.max(...peaks.map((mode) => Math.abs(mode.rotationalStrength)));
  const positive = peaks.filter((mode) => mode.rotationalStrength > 0).length;

  return {
    fwhmCm: Number(fwhmCm),
    shape: 'lorentzian',
    signed: true,
    quantity: 'VCD rotational strength',
    units: VCD_UNITS,
    representation: null,
    normalisation: `strongest |R| = 1.00 (${strongest.toFixed(4)} ${VCD_UNITS})`,
    scaling: scale
      ? {
        mode: scale.mode,
        factor,
        applied: factor !== 1,
        key: scale.key ?? null,
        source: scale.source ?? null,
        doi: scale.doi ?? null,
        tableVersion: scale.tableVersion ?? null,
      }
      : null,
    minCm: low,
    maxCm: high,
    peaks: peaks
      .map((mode) => ({
        wavenumber: mode.wavenumber,
        wavenumberRaw: mode.wavenumberRaw,
        rotationalStrength: mode.rotationalStrength,
        dipoleStrength: Number.isFinite(mode.dipoleStrength) ? mode.dipoleStrength : null,
        emAngle: Number.isFinite(mode.emAngle) ? mode.emAngle : null,
        sign: mode.rotationalStrength >= 0 ? '+' : '−',
      }))
      .sort((a, b) => a.wavenumber - b.wavenumber),
    counts: { total: peaks.length, positive, negative: peaks.length - positive },
    curve: curve.map((point) => ({
      wavenumber: point.wavenumber,
      // −1 … +1 in the normalised frame; the drawing maps that onto 0 … 100.
      intensity: strongest > 0 ? point.intensity / strongest : 0,
    })),
  };
}

/**
 * SVG polyline in the 0–100 × 0–100 box the other spectrum figures use.
 *
 * A signed curve is drawn around the midline: y = 50 is R = 0, positive bands
 * go up (smaller y) and negative bands go down, so the sign is visible without
 * a legend.
 */
export function vcdPolyline(spectrum, { width = 100, height = 100 } = {}) {
  if (!spectrum || !Array.isArray(spectrum.curve) || spectrum.curve.length === 0) return '';
  const span = spectrum.maxCm - spectrum.minCm || 1;
  const mid = height / 2;
  return spectrum.curve
    .map((point) => {
      const x = ((point.wavenumber - spectrum.minCm) / span) * width;
      const y = mid - point.intensity * mid;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}
