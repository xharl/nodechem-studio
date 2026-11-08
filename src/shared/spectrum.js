/**
 * Simulated UV-Vis spectrum from parsed TD-DFT excited states.
 *
 * Pure maths, no DOM. Each state contributes a Gaussian line shape in energy
 * (eV) with the same full width at half maximum; the curve is normalised to its
 * own maximum so it can be drawn without an arbitrary intensity axis.
 *
 * The plot is a simulation of the computed transitions, never a measurement:
 * the caller must show `fwhmEv` and the number of states it was built from.
 */

/** hc in eV·nm (CODATA 2018), used for the energy ↔ wavelength axis. */
export const HC_EV_NM = 1239.841984;

export const DEFAULT_FWHM_EV = 0.30;

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * @param {Array<{energyEv:number, oscillatorStrength:number, wavelengthNm?:number, index?:number}>} states
 * @param {{fwhmEv?: number, samples?: number}} options
 * @returns {null | {fwhmEv:number, samples:number, states:Array, points:Array,
 *                   maxIntensity:number, minWavelengthNm:number, maxWavelengthNm:number}}
 */
export function broadenedSpectrum(states, { fwhmEv = DEFAULT_FWHM_EV, samples = 240 } = {}) {
  const width = num(fwhmEv);
  if (width === null || width <= 0) throw new Error('FWHM must be a positive number of eV.');
  const usable = (Array.isArray(states) ? states : [])
    .filter((state) => state && typeof state === 'object')
    .map((state) => ({
      index: Number.isInteger(state.index) ? state.index : null,
      energyEv: num(state.energyEv),
      oscillatorStrength: num(state.oscillatorStrength),
      wavelengthNm: num(state.wavelengthNm),
      spin: state.spin ?? null,
      symmetry: state.symmetry ?? null,
    }))
    .filter((state) => state.energyEv !== null && state.energyEv > 0);
  if (usable.length === 0) return null;

  const stickTotal = usable.reduce((sum, state) => sum + Math.max(0, state.oscillatorStrength ?? 0), 0);
  const sticks = usable.map((state) => ({
    ...state,
    /** Share of the total oscillator strength; null when none was reported. */
    weight: stickTotal > 0 ? Math.max(0, state.oscillatorStrength ?? 0) / stickTotal : null,
  }));

  const sigma = width / (2 * Math.sqrt(2 * Math.log(2)));
  const energies = usable.map((state) => state.energyEv);
  const minEnergy = Math.max(0.2, Math.min(...energies) - 4 * sigma);
  const maxEnergy = Math.max(...energies) + 4 * sigma;
  const count = Math.max(24, Math.min(2000, Math.floor(Number(samples) || 240)));
  const step = (maxEnergy - minEnergy) / (count - 1);

  const points = [];
  let maxIntensity = 0;
  for (let index = 0; index < count; index += 1) {
    const energyEv = minEnergy + step * index;
    let intensity = 0;
    for (const state of usable) {
      const delta = energyEv - state.energyEv;
      intensity += Math.max(0, state.oscillatorStrength ?? 0)
        * Math.exp(-(delta * delta) / (2 * sigma * sigma));
    }
    maxIntensity = Math.max(maxIntensity, intensity);
    points.push({ energyEv, wavelengthNm: HC_EV_NM / energyEv, intensity });
  }
  for (const point of points) point.relative = maxIntensity > 0 ? point.intensity / maxIntensity : 0;

  return {
    fwhmEv: width,
    samples: count,
    states: sticks,
    points,
    maxIntensity,
    minWavelengthNm: HC_EV_NM / maxEnergy,
    maxWavelengthNm: HC_EV_NM / minEnergy,
  };
}

/**
 * SVG polyline coordinates for a spectrum, in a viewBox of `width` x `height`
 * with a fixed inset. Wavelength runs left-to-right from long to short, which
 * is the convention for UV-Vis spectra.
 */
export function spectrumPolyline(spectrum, { width = 320, height = 90, inset = 24 } = {}) {
  if (!spectrum || !Array.isArray(spectrum.points) || spectrum.points.length === 0) return '';
  const longNm = spectrum.maxWavelengthNm;
  const shortNm = spectrum.minWavelengthNm;
  const span = longNm - shortNm || 1;
  return spectrum.points.map((point) => {
    const x = inset + ((longNm - point.wavelengthNm) / span) * (width - inset * 2);
    const y = height - inset - point.relative * (height - inset * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}
