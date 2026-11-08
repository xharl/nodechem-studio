/**
 * Spectrum import (#119): one entry point for a measured trace.
 *
 * Before this, the results panel could only overlay a two-column text dump. A
 * spectrum from a spectrometer arrives as JCAMP-DX, so the panel needed a
 * branch — or, better, an import function that answers "what is in this file"
 * once and returns one shape whichever format it found.
 *
 * A JCAMP-DX file is detected by its `##` header, not by its extension: a
 * `.txt` holding a JCAMP-DX document is read correctly, and a `.jdx` that is
 * really a two-column dump is not pretend-parsed as JCAMP.
 *
 * Refusals from the reader are not swallowed. A file that is JCAMP-DX but
 * carries peaks, or more than one block, throws with the section named, and the
 * caller can print that sentence instead of "nothing was overlayed".
 */

import { isJcampDx, readJcampDx } from './jcamp.js';
import { parseMeasuredSpectrum } from './overlay.js';

export { isJcampDx, readJcampDx };

/**
 * @param {string} text the file's contents
 * @returns {object|null} a spectrum with `points` in both cases; `null` when a
 *   plain-text dump holds no two-column numeric row
 */
export function importSpectrumText(text) {
  if (isJcampDx(text)) return readJcampDx(text);
  return parseMeasuredSpectrum(text);
}

/**
 * The axis quantity a unit string names, or `null` when this module does not
 * recognise it. Recognising the quantity — not the spelling — is what lets the
 * panel refuse an nm trace on a cm⁻¹ axis instead of drawing a meaningless
 * overlay.
 */
const AXIS_QUANTITIES = new Map([
  ['1/CM', 'wavenumber'],
  ['CM-1', 'wavenumber'],
  ['CM^-1', 'wavenumber'],
  ['CM**-1', 'wavenumber'],
  ['WAVENUMBER', 'wavenumber'],
  ['NM', 'wavelength'],
  ['NANOMETER', 'wavelength'],
  ['NANOMETERS', 'wavelength'],
  ['NANOMETRE', 'wavelength'],
  ['NANOMETRES', 'wavelength'],
  ['PPM', 'chemical-shift'],
  ['HZ', 'frequency'],
  ['MHZ', 'frequency'],
  ['EV', 'energy'],
]);

export function axisQuantity(units) {
  if (typeof units !== 'string') return null;
  const key = units.trim().toUpperCase().replace(/[\s_]+/g, '');
  return AXIS_QUANTITIES.get(key) ?? null;
}

/**
 * Whether two axis unit strings name the same quantity.
 *
 * `null` means "cannot tell": either side is missing, or it uses a unit this
 * module does not map. An unknown unit is not treated as a match — the caller
 * has to say that the axis was not declared rather than implying it was
 * checked.
 */
export function sameAxisUnits(a, b) {
  const left = axisQuantity(a);
  const right = axisQuantity(b);
  if (left === null || right === null) return null;
  return left === right;
}
