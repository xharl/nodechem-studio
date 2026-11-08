/**
 * NMR shieldings and a simulated spectrum.
 *
 * Gaussian prints an absolute isotropic shielding per atom (ppm) in a GIAO
 * block. That number is not a chemical shift: a shift needs a reference
 * shielding computed at the same level of theory. This module keeps the two
 * apart — the parser never subtracts anything, and `nmrShifts` only produces
 * shifts when the caller supplies a reference. The convention is printed with
 * the numbers in the results panel, never implied.
 */

const NUCLEUS_ELEMENTS = Object.freeze({
  '1H': 'H',
  H: 'H',
  '13C': 'C',
  C: 'C',
  '15N': 'N',
  N: 'N',
  '19F': 'F',
  F: 'F',
  '31P': 'P',
  P: 'P',
  '29Si': 'Si',
  Si: 'Si',
});

/** Which element a nucleus label refers to, e.g. `13C` → `C`. */
export function elementForNucleus(nucleus) {
  const key = String(nucleus || '').trim();
  return NUCLEUS_ELEMENTS[key] || null;
}

/**
 * Parse the shielding block:
 *
 *   SCF GIAO Magnetic shielding tensor (ppm):
 *         1  C    Isotropic =   114.0880   Anisotropy =   147.6438
 *      XX=    57.6159   YX=   -13.4888   ZX=     0.0000
 *      ...
 *      Eigenvalues:    48.6622    81.0847   212.5172
 *
 * A job with no NMR block returns null; a block with no atoms returns null.
 */
export function parseShieldings(source) {
  const lines = String(source ?? '').split(/\r\n|\n|\r/);
  const start = lines.findIndex((line) => /Magnetic shielding tensor\s*\(ppm\)/i.test(line));
  if (start === -1) return null;

  const header = lines[start];
  const gauge = /GIAO/i.test(header) ? 'GIAO' : (/CSGT/i.test(header) ? 'CSGT' : null);
  const methodMatch = /^\s*([A-Z0-9]+)\s+(?:GIAO|CSGT)?\s*Magnetic shielding tensor/i.exec(header.trim());
  const method = methodMatch ? methodMatch[1] : null;

  const atoms = [];
  let current = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (atoms.length > 0 && line.trim() === '') break;
    const atomMatch = /^\s*(\d+)\s+([A-Z][a-z]?)\s+Isotropic\s*=\s*(-?\d+\.\d+)\s+Anisotropy\s*=\s*(-?\d+\.\d+)/.exec(line);
    if (atomMatch) {
      current = {
        index: Number(atomMatch[1]),
        element: atomMatch[2],
        isotropic: Number(atomMatch[3]),
        anisotropy: Number(atomMatch[4]),
        eigenvalues: null,
      };
      atoms.push(current);
      continue;
    }
    const eigen = /^\s*Eigenvalues:\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/.exec(line);
    if (eigen && current) {
      current.eigenvalues = [Number(eigen[1]), Number(eigen[2]), Number(eigen[3])];
      continue;
    }
    if (!/^\s*(?:XX|YX|ZX|XY|YY|ZY|XZ|YZ|ZZ)=/.test(line) && !/Magnetic shielding/i.test(line)) {
      if (atoms.length > 0) break;
    }
  }
  if (atoms.length === 0) return null;

  return { gauge, method, count: atoms.length, atoms };
}

/**
 * Shift = σ_reference − σ_isotropic, the IUPAC convention. `referencePpm` must
 * come from the same level of theory; nothing is assumed when it is absent.
 */
export function nmrShifts(atoms, { referencePpm = null } = {}) {
  // Number(null) is 0, which would silently turn every shielding into a shift
  // against a reference of zero.
  const usable = referencePpm !== null && referencePpm !== undefined
    && String(referencePpm).trim() !== '' && Number.isFinite(Number(referencePpm));
  const reference = usable ? Number(referencePpm) : null;
  return (Array.isArray(atoms) ? atoms : []).map((atom) => ({
    ...atom,
    shiftPpm: usable ? reference - atom.isotropic : null,
  }));
}

/**
 * A Lorentzian stick spectrum over the shifts (or absolute shieldings when no
 * reference is supplied). Peaks are per atom; degenerate atoms stack.
 */
export function nmrSpectrum({
  atoms = [],
  nucleus = '1H',
  referencePpm = null,
  fwhmPpm = 0.1,
  points = 600,
} = {}) {
  const element = elementForNucleus(nucleus);
  const shifted = nmrShifts(atoms, { referencePpm });
  const selected = shifted.filter((atom) => (element ? atom.element === element : true)
    && Number.isFinite(atom.shiftPpm ?? atom.isotropic));
  if (selected.length === 0) return null;

  const values = selected.map((atom) => (atom.shiftPpm ?? atom.isotropic));
  const half = Math.max(Number(fwhmPpm) / 2, 0.001);
  const pad = Math.max(5 * half, 0.5);
  const low = Math.min(...values) - pad;
  const high = Math.max(...values) + pad;
  const span = high - low || 1;
  const step = span / Math.max(points - 1, 1);

  const curve = [];
  for (let index = 0; index < points; index += 1) {
    const ppm = low + step * index;
    let intensity = 0;
    for (const value of values) {
      const delta = ppm - value;
      intensity += (half * half) / (delta * delta + half * half);
    }
    curve.push({ ppm, intensity });
  }
  const max = Math.max(...curve.map((point) => point.intensity));

  const hasReference = referencePpm !== null && referencePpm !== undefined
    && String(referencePpm).trim() !== '' && Number.isFinite(Number(referencePpm));
  return {
    nucleus,
    element,
    referencePpm: hasReference ? Number(referencePpm) : null,
    fwhmPpm: Number(fwhmPpm),
    shape: 'lorentzian',
    units: hasReference ? 'ppm shift' : 'ppm shielding (absolute)',
    minPpm: low,
    maxPpm: high,
    peaks: selected.map((atom) => ({
      atom: atom.index,
      element: atom.element,
      isotropic: atom.isotropic,
      shiftPpm: atom.shiftPpm,
      value: atom.shiftPpm ?? atom.isotropic,
    })).sort((a, b) => a.value - b.value),
    curve: curve.map((point) => ({ ppm: point.ppm, intensity: max > 0 ? point.intensity / max : 0 })),
  };
}

/** SVG polyline in the same 0–100 × 0–100 box the other spectrum figures use. */
export function nmrPolyline(spectrum, { width = 100, height = 100 } = {}) {
  if (!spectrum || !Array.isArray(spectrum.curve) || spectrum.curve.length === 0) return '';
  const span = spectrum.maxPpm - spectrum.minPpm || 1;
  return spectrum.curve.map((point, index) => {
    const x = ((point.ppm - spectrum.minPpm) / span) * width;
    const y = height - point.intensity * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}
