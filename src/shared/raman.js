/**
 * Raman spectroscopy (#76).
 *
 * A `Freq=Raman` job prints, per mode, the Raman scattering activity in Å⁴/amu
 * and the depolarisation ratio for plane-polarised and unpolarised incident
 * light. Gaussian prints the same numbers in two layouts depending on the
 * section ("Raman Activities ---" in the short table, "Raman Activ --" in the
 * long one), so both are read here.
 *
 * What is plotted is the **activity**, not a scattering cross-section. Turning
 * activities into a measurable intensity needs the excitation wavelength, a
 * temperature-dependent population factor and the instrument's collection
 * geometry; inventing those would produce a spectrum that looks quantitative
 * and is not. The panel says which quantity it shows.
 */

const RAMAN_ACTIVITIES = /^\s*Raman\s+Activ\S*\s*-{2,}\s*(.*)$/i;
const DEPOL_PLANE = /^\s*Depol(?:ar)?\.?\s*\(\s*(?:Plane|P)\s*\)\s*-{2,}\s*(.*)$/i;
const DEPOL_UNPOL = /^\s*Depol(?:ar)?\.?\s*\(\s*(?:Unpol|U)\s*\)\s*-{2,}\s*(.*)$/i;
const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;

const numbers = (text) => (String(text || '').match(NUMBER) || []).map(Number);

/**
 * Pull the Raman rows out of a frequency section.
 *
 * Returns `null` when the file has no Raman data at all, so a plain `Freq` job
 * is distinguishable from a `Freq=Raman` job whose rows came out empty.
 */
export function parseRamanActivities(text) {
  const lines = String(text || '').split(/\r\n|\n|\r/);
  const activities = [];
  const depolarizationPlane = [];
  const depolarizationUnpolarized = [];
  let seen = false;

  for (const line of lines) {
    if (RAMAN_ACTIVITIES.test(line)) {
      // Only the first table of a section is the per-mode row; later sections
      // repeat the same numbers in the long layout.
      if (activities.length === 0) activities.push(...numbers(line.match(RAMAN_ACTIVITIES)[1]));
      seen = true;
      continue;
    }
    if (DEPOL_PLANE.test(line)) {
      if (depolarizationPlane.length === 0) depolarizationPlane.push(...numbers(line.match(DEPOL_PLANE)[1]));
      continue;
    }
    if (DEPOL_UNPOL.test(line)) {
      if (depolarizationUnpolarized.length === 0) depolarizationUnpolarized.push(...numbers(line.match(DEPOL_UNPOL)[1]));
    }
  }

  if (!seen || activities.every((value) => !Number.isFinite(value))) return null;
  return {
    activities,
    depolarizationPlane,
    depolarizationUnpolarized,
  };
}

/**
 * Attach Raman rows to a frequency mode table.
 *
 * `modes` are `{ wavenumber, irIntensity, … }`; a mode with no Raman row keeps
 * `null`, never `0`, so "not reported" stays visible.
 */
export function attachRaman(modes, raman) {
  const list = Array.isArray(modes) ? modes : [];
  if (!raman) return list.map((mode) => ({ ...mode, ramanActivity: null, depolarizationPlane: null, depolarizationUnpolarized: null }));
  return list.map((mode, index) => ({
    ...mode,
    ramanActivity: Number.isFinite(raman.activities[index]) ? raman.activities[index] : null,
    depolarizationPlane: Number.isFinite(raman.depolarizationPlane[index]) ? raman.depolarizationPlane[index] : null,
    depolarizationUnpolarized: Number.isFinite(raman.depolarizationUnpolarized[index]) ? raman.depolarizationUnpolarized[index] : null,
  }));
}

/**
 * Broadened Raman spectrum in cm⁻¹.
 *
 * Lorentzian, FWHM stated in the returned record. The y axis is the activity
 * (Å⁴/amu), normalised to the strongest peak so that an overlay can be scaled
 * onto the same axis; the normalisation is recorded rather than implied.
 */
export function ramanSpectrum(modes, { fwhmCm = 12, points = 600 } = {}) {
  const peaks = (Array.isArray(modes) ? modes : [])
    .filter((mode) => Number.isFinite(mode.wavenumber) && Number.isFinite(mode.ramanActivity) && mode.ramanActivity > 0);
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
      intensity += (mode.ramanActivity * half * half) / (delta * delta + half * half);
    }
    curve.push({ wavenumber, intensity });
  }
  const max = Math.max(...curve.map((point) => point.intensity));
  const strongest = Math.max(...peaks.map((mode) => mode.ramanActivity));

  return {
    fwhmCm: Number(fwhmCm),
    shape: 'lorentzian',
    quantity: 'Raman activity',
    units: 'Å⁴/amu',
    normalisation: `strongest peak = 1.00 (${strongest.toFixed(4)} Å⁴/amu)`,
    minCm: low,
    maxCm: high,
    peaks: peaks
      .map((mode) => ({
        wavenumber: mode.wavenumber,
        ramanActivity: mode.ramanActivity,
        depolarizationPlane: Number.isFinite(mode.depolarizationPlane) ? mode.depolarizationPlane : null,
      }))
      .sort((a, b) => a.wavenumber - b.wavenumber),
    curve: curve.map((point) => ({ wavenumber: point.wavenumber, intensity: max > 0 ? point.intensity / max : 0 })),
  };
}

/** SVG polyline in the 0–100 × 0–100 box the other spectrum figures use. */
export function ramanPolyline(spectrum, { width = 100, height = 100 } = {}) {
  if (!spectrum || !Array.isArray(spectrum.curve) || spectrum.curve.length === 0) return '';
  const span = spectrum.maxCm - spectrum.minCm || 1;
  return spectrum.curve
    .map((point) => {
      const x = ((point.wavenumber - spectrum.minCm) / span) * width;
      const y = height - point.intensity * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}
