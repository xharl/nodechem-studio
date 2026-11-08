/**
 * Spectra figures: IR, Raman, UV-Vis, VCD, ECD and NMR, drawn once and used by
 * both the app and the report.
 *
 * The data are already computed elsewhere — `spectrum.js` (UV-Vis),
 * `raman.js`, `vcd.js`, `ecd.js`, `nmr.js` each return a `{ curve, peaks, … }`
 * object from a run record. The adapters below turn those into one normalised
 * shape so this module never recomputes a spectrum: a figure and the table
 * beside it cannot disagree, because they read the same numbers.
 *
 * Every figure states its broadening (`fwhm`) and prints it in the caption: a
 * simulated spectrum without its width is a picture of an assumption.
 */

import {
  PALETTE, axis, escapeXml, figureFrame, figureResult, fmtNum, niceTicks, pathOf, round, scaleLinear,
} from './primitives.js';

/** Photon energy ↔ wavelength in nm, the constant the spectrum module uses. */
export const HC_EV_NM = 1239.841984;

const KINDS = {
  ir: { xLabel: 'Wavenumber / cm⁻¹', invert: true, signed: false, yLabel: 'IR intensity (rel.)' },
  raman: { xLabel: 'Wavenumber / cm⁻¹', invert: false, signed: false, yLabel: 'Raman activity (rel.)' },
  uvvis: { xLabel: 'Wavelength / nm', invert: true, signed: false, yLabel: 'ε (rel.)' },
  ecd: { xLabel: 'Wavelength / nm', invert: true, signed: true, yLabel: 'Δε (rel.)' },
  vcd: { xLabel: 'Wavenumber / cm⁻¹', invert: true, signed: true, yLabel: 'Δε (rel.)' },
  nmr: { xLabel: 'Chemical shift / ppm', invert: true, signed: false, yLabel: 'intensity (rel.)' },
};

export const SPECTRUM_KINDS = Object.freeze(Object.keys(KINDS));

function maxAbs(values) {
  let max = 0;
  for (const value of values) {
    const abs = Math.abs(Number(value));
    if (Number.isFinite(abs) && abs > max) max = abs;
  }
  return max;
}

/** Normalises a stick list so the tallest stick is 1 (or −1…1 when signed). */
function normaliseSticks(sticks, { signed = false } = {}) {
  const scale = maxAbs(sticks.map((stick) => stick.height));
  if (scale === 0) return sticks.map((stick) => ({ ...stick, height: 0 }));
  return sticks.map((stick) => ({ ...stick, height: (signed ? 1 : 1) * (stick.height / scale) }));
}

/**
 * Broadens a stick list into an envelope. Used for IR, where the parser gives
 * frequencies and intensities but no curve, so the figure and the table read the
 * same two columns with the stated width.
 */
export function broadenSticks(sticks, { fwhm = 12, points = 400, shape = 'lorentzian', pad = null } = {}) {
  const usable = (Array.isArray(sticks) ? sticks : [])
    .filter((stick) => Number.isFinite(Number(stick.x)) && Number.isFinite(Number(stick.height)));
  if (usable.length === 0) return [];
  const half = Math.max(Number(fwhm) / 2, 0.001);
  const values = usable.map((stick) => Number(stick.x));
  const margin = pad === null ? Math.max(6 * half, 20) : Number(pad);
  const low = Math.min(...values) - margin;
  const high = Math.max(...values) + margin;
  const step = (high - low) / Math.max(points - 1, 1);
  const curve = [];
  let max = 0;
  for (let index = 0; index < points; index += 1) {
    const x = low + step * index;
    let intensity = 0;
    for (const stick of usable) {
      const delta = x - Number(stick.x);
      intensity += shape === 'gaussian'
        ? Number(stick.height) * Math.exp(-(delta * delta) / (2 * (half / 1.1774) ** 2))
        : (Number(stick.height) * half * half) / (delta * delta + half * half);
    }
    if (intensity > max) max = intensity;
    curve.push({ x, y: intensity });
  }
  return max > 0 ? curve.map((point) => ({ x: point.x, y: point.y / max })) : curve;
}

/**
 * Draws a normalised spectrum.
 *
 * @param {object} input
 * @param {string} input.kind        one of `SPECTRUM_KINDS`
 * @param {Array<{x:number,y:number}>} input.curve   envelope, y in 0…1 (or −1…1)
 * @param {Array<{x:number,height:number,label?:string}>} input.sticks  peak sticks
 * @param {[number, number]} input.range             x axis in data units
 * @param {string} input.fwhm                        broadening statement for the caption
 * @param {string} [input.quantity]                  what the y axis measures
 * @param {string} [input.title]
 */
export function spectrumFigure({
  kind, curve = [], sticks = [], range = null, fwhm = '', quantity = '', title = '', width = 420, height = 170,
  overlays = [],
} = {}) {
  const config = KINDS[kind];
  if (!config) throw new Error(`unknown spectrum kind: ${kind}`);
  const points = (Array.isArray(curve) ? curve : [])
    .filter((point) => point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)));
  const peaks = (Array.isArray(sticks) ? sticks : [])
    .filter((stick) => stick && Number.isFinite(Number(stick.x)) && Number.isFinite(Number(stick.height)));
  if (points.length === 0 && peaks.length === 0) return null;

  const xs = points.map((point) => Number(point.x)).concat(peaks.map((stick) => Number(stick.x)));
  const lo = Array.isArray(range) ? Number(range[0]) : Math.min(...xs);
  const hi = Array.isArray(range) ? Number(range[1]) : Math.max(...xs);
  const x0 = Math.min(lo, hi);
  const x1 = Math.max(lo, hi);

  const ys = points.map((point) => Number(point.y)).concat(peaks.map((stick) => stick.height));
  const signed = config.signed || ys.some((value) => value < 0);
  const yMax = Math.max(signed ? Math.max(...ys.map((v) => Math.max(0, v))) : Math.max(...ys, 0), 0.05);
  const yMin = signed ? Math.min(Math.min(...ys, 0), -0.05) : 0;

  const padLeft = 46;
  const padRight = 12;
  const padTop = 14;
  const padBottom = 40;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const bandTop = padTop;
  const bandBottom = padTop + plotH;

  // The x axis direction is a convention per spectrum type: IR and NMR read
  // right-to-left in wavenumber/ppm, UV-Vis long to short wavelength.
  const xMap = config.invert
    ? scaleLinear([x0, x1], [padLeft + plotW, padLeft])
    : scaleLinear([x0, x1], [padLeft, padLeft + plotW]);
  const yMap = scaleLinear([yMin, yMax], [bandBottom, bandTop]);

  const parts = [];
  const clipId = 'plot-clip';
  parts.push(`<defs><clipPath id="${clipId}"><rect x="${padLeft}" y="${bandTop}"`
    + ` width="${plotW}" height="${plotH}"/></clipPath></defs>`);
  parts.push(`<rect x="${padLeft}" y="${bandTop}" width="${plotW}" height="${plotH}" fill="#ffffff"/>`);

  const { ticks, step } = niceTicks(x0, x1, 5);
  parts.push(axis({
    orient: 'x', x1: padLeft, y1: bandBottom, x2: padLeft + plotW, y2: bandBottom,
    ticks: ticks.map((value) => ({ value, pos: xMap(value) })), step, label: config.xLabel,
  }));

  if (signed) {
    const zeroY = yMap(0);
    parts.push(`<line x1="${padLeft}" y1="${round(zeroY)}" x2="${padLeft + plotW}" y2="${round(zeroY)}"`
      + ` stroke="${PALETTE.muted}" stroke-width="0.8" stroke-dasharray="3 3"/>`);
  }

  // Sticks first (behind the envelope), drawn from the baseline.
  const baseY = yMap(0);
  for (const stick of peaks) {
    const x = xMap(Number(stick.x));
    const y = yMap(stick.height);
    const colour = stick.height < 0 ? PALETTE.negative : PALETTE.curveSoft;
    parts.push(`<line x1="${round(x)}" y1="${round(baseY)}" x2="${round(x)}" y2="${round(y)}"`
      + ` stroke="${colour}" stroke-width="1" opacity="0.75"/>`);
  }

  if (points.length > 1) {
    const path = pathOf(points.map((point) => [xMap(Number(point.x)), yMap(Number(point.y))]));
    parts.push(`<path d="${path}" fill="none" stroke="${PALETTE.curve}" stroke-width="1.4"`
      + ' stroke-linejoin="round" stroke-linecap="round"/>');
  }

  // A measured trace, if one was imported. It is drawn in the accent colour and
  // dashed so it can never be mistaken for the computed envelope, and the
  // caption names the scale factor the caller applied.
  for (const overlay of Array.isArray(overlays) ? overlays : []) {
    const overlayPoints = (Array.isArray(overlay?.points) ? overlay.points : [])
      .filter((point) => Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)));
    if (overlayPoints.length < 2) continue;
    parts.push(`<path class="spectrum-curve is-overlay"`
      + ` d="${pathOf(overlayPoints.map((point) => [xMap(Number(point.x)), yMap(Number(point.y))]))}"`
      + ` fill="none" stroke="${PALETTE.accent}" stroke-width="1" stroke-dasharray="4 3" opacity="0.8"`
      + ` clip-path="url(#${clipId})"/>`);
  }

  // Label the three strongest sticks, never more: a spectrum with ten labels is
  // a table drawn badly.
  const labelled = peaks
    .slice()
    .sort((a, b) => Math.abs(b.height) - Math.abs(a.height))
    .slice(0, 3)
    .filter((stick) => Math.abs(stick.height) > 0.15);
  for (const stick of labelled) {
    const x = xMap(Number(stick.x));
    const y = yMap(stick.height);
    const above = stick.height >= 0;
    parts.push(`<text x="${round(x)}" y="${round(above ? y - 3 : y + 10)}" text-anchor="middle"`
      + ` font-size="8" fill="${PALETTE.muted}">${escapeXml(stick.label ?? fmtNum(stick.x, 1))}</text>`);
  }

  parts.push(`<text x="${padLeft - 6}" y="${bandTop + 8}" text-anchor="end" font-size="9"`
    + ` fill="${PALETTE.muted}">${escapeXml(signed ? '+1' : '1')}</text>`);
  parts.push(`<text x="${padLeft - 6}" y="${bandBottom}" text-anchor="end" font-size="9"`
    + ` fill="${PALETTE.muted}">${escapeXml(signed ? '−1' : '0')}</text>`);

  const captionParts = [title || `${kind.toUpperCase()} spectrum`];
  if (quantity) captionParts.push(quantity);
  if (fwhm) captionParts.push(fwhm);
  captionParts.push(`${points.length || peaks.length} points`);
  const overlaid = (Array.isArray(overlays) ? overlays : []).filter((overlay) => Array.isArray(overlay?.points) && overlay.points.length > 1);
  for (const overlay of overlaid) captionParts.push(`measured “${overlay.label || 'imported'}”`);
  const caption = captionParts.join(' · ');

  return figureResult({
    kind: `spectrum:${kind}`,
    svg: figureFrame({
      width,
      height,
      title: caption,
      desc: `${config.yLabel} against ${config.xLabel}. ${fwhm}`.trim(),
      body: parts.join(''),
      className: 'figure-spectrum',
    }),
    width,
    height,
    caption,
    params: {
      spectrum: kind, fwhm, points: points.length, sticks: peaks.length, range: [x0, x1], signed,
      overlays: overlaid.length,
    },
  });
}

/* ------------------------------------------------------------------ *
 * Adapters: existing spectrum objects → the normalised figure input.
 * ------------------------------------------------------------------ */

/** UV-Vis from `broadenedSpectrum()` — wavelength axis, long to short. */
export function fromUvVis(spectrum, { title = 'UV-Vis (simulated)' } = {}) {
  if (!spectrum || !Array.isArray(spectrum.points) || spectrum.points.length === 0) return null;
  const sticks = (spectrum.states ?? []).map((state) => ({
    x: state.wavelengthNm,
    height: state.oscillatorStrength ?? 0,
    label: state.index === null || state.index === undefined ? undefined : `S${state.index}`,
  }));
  return spectrumFigure({
    kind: 'uvvis',
    title,
    curve: spectrum.points.map((point) => ({ x: point.wavelengthNm, y: point.relative })),
    sticks: normaliseSticks(sticks),
    range: [spectrum.maxWavelengthNm, spectrum.minWavelengthNm],
    fwhm: `Gaussian broadening, FWHM ${fmtNum(spectrum.fwhmEv, 2)} eV`,
    quantity: 'oscillator strengths as computed',
  });
}

/** Raman from `ramanSpectrum()` — ascendi ng wavenumber. */
export function fromRaman(spectrum, { title = 'Raman (simulated)', overlays = [] } = {}) {
  if (!spectrum || !Array.isArray(spectrum.curve) || spectrum.curve.length === 0) return null;
  const sticks = (spectrum.peaks ?? []).map((peak) => ({ x: peak.wavenumber, height: peak.ramanActivity }));
  return spectrumFigure({
    kind: 'raman',
    title,
    curve: spectrum.curve.map((point) => ({ x: point.wavenumber, y: point.intensity })),
    sticks: normaliseSticks(sticks),
    range: [spectrum.minCm, spectrum.maxCm],
    fwhm: `Lorentzian, FWHM ${fmtNum(spectrum.fwhmCm, 1)} cm⁻¹`,
    quantity: spectrum.quantity || 'Raman activity',
    overlays,
  });
}

/** VCD from `vcdSpectrum()` — signed about zero, wavenumber descending. */
export function fromVcd(spectrum, { title = 'VCD (simulated)' } = {}) {
  if (!spectrum || !Array.isArray(spectrum.curve) || spectrum.curve.length === 0) return null;
  const sticks = normaliseSticks(
    (spectrum.peaks ?? []).map((peak) => ({ x: peak.wavenumber, height: peak.rotationalStrength })),
    { signed: true },
  );
  return spectrumFigure({
    kind: 'vcd',
    title,
    curve: spectrum.curve.map((point) => ({ x: point.wavenumber, y: point.intensity })),
    sticks,
    range: [spectrum.minCm, spectrum.maxCm],
    fwhm: `Lorentzian, FWHM ${fmtNum(spectrum.fwhmCm, 1)} cm⁻¹`,
    quantity: 'rotational strength, signed',
  });
}

/** ECD from `ecdSpectrum()` — photon energies converted to wavelength. */
export function fromEcd(spectrum, { title = 'ECD (simulated)' } = {}) {
  if (!spectrum || !Array.isArray(spectrum.curve) || spectrum.curve.length === 0) return null;
  const toNm = (energyEv) => (Number(energyEv) > 0 ? HC_EV_NM / Number(energyEv) : null);
  const sticks = normaliseSticks(
    (spectrum.peaks ?? [])
      .map((peak) => ({ x: toNm(peak.energyEv), height: peak.rotatoryStrength }))
      .filter((stick) => Number.isFinite(stick.x)),
    { signed: true },
  );
  const nm = spectrum.curve.map((point) => ({ x: toNm(point.energyEv), y: point.intensity }))
    .filter((point) => Number.isFinite(point.x));
  const values = nm.map((point) => point.x);
  return spectrumFigure({
    kind: 'ecd',
    title,
    curve: nm,
    sticks,
    range: [Math.max(...values), Math.min(...values)],
    fwhm: `Lorentzian, FWHM ${fmtNum(spectrum.fwhmEv, 2)} eV`,
    quantity: 'rotatory strength, signed',
  });
}

/** NMR from `nmrSpectrum()` — ppm descending. */
export function fromNmr(spectrum, { title = null } = {}) {
  if (!spectrum || !Array.isArray(spectrum.curve) || spectrum.curve.length === 0) return null;
  const sticks = (spectrum.peaks ?? []).map((peak) => ({ x: peak.value, height: 1 }));
  return spectrumFigure({
    kind: 'nmr',
    title: title || `${spectrum.nucleus} NMR (simulated)`,
    curve: spectrum.curve.map((point) => ({ x: point.ppm, y: point.intensity })),
    sticks,
    range: [spectrum.maxPpm, spectrum.minPpm],
    fwhm: `Lorentzian, FWHM ${fmtNum(spectrum.fwhmPpm, 2)} ppm`,
    quantity: spectrum.units,
  });
}
