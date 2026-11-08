/**
 * Extended XYZ (`extxyz`), the format ASE, OVITO, libAtoms and VMD's plugin
 * ecosystem agree on.
 *
 * It is plain XYZ with a keyword line in place of the free-text comment:
 *
 *     Properties=species:S:1:pos:R:3 energy=-1.234567
 *
 * `Properties` declares each column in order — name, type (`S` string, `R`
 * real, `I` integer, `L` logical) and count — so a reader knows where the
 * element ends and the coordinates begin without guessing from the line.
 *
 * The one convention worth stating out loud: **`energy` is in eV**, because
 * that is what ASE reads and writes. A hartree value written there would be
 * silently wrong by a factor of 27.2 for anyone who imported it, so this
 * writer also emits `energy_hartree` for the unrounded value. Nothing is
 * guessed: a frame with no parsed energy simply has no energy key.
 */

import { HARTREE_TO_EV } from '../orbitals.js';
import { ConversionError } from './xyz.js';

const PROPERTIES = 'Properties=species:S:1:pos:R:3 pbc="F F F"';

/**
 * `Number(null)` and `Number('')` are 0, which would turn an unparsed energy
 * into a perfectly finite zero. Only a real number counts.
 */
function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function infoOf(frame, frameIndex) {
  const info = [];
  const energy = finite(frame?.energyHartree);
  if (energy !== null) {
    info.push(`energy=${(energy * HARTREE_TO_EV).toFixed(8)}`);
    info.push(`energy_hartree=${energy.toFixed(10)}`);
  }
  if (Number.isInteger(frame?.step)) info.push(`step=${frame.step}`);
  if (Number.isInteger(frameIndex) && !Number.isInteger(frame?.step)) info.push(`frame=${frameIndex + 1}`);
  return info;
}

function linesOf(frame, frameIndex, precision) {
  const atoms = Array.isArray(frame?.atoms) ? frame.atoms : [];
  if (atoms.length === 0) {
    throw new ConversionError(`frame ${frameIndex + 1} has no atoms.`);
  }
  const body = atoms.map((atom, index) => {
    const element = typeof atom?.element === 'string' ? atom.element.trim() : '';
    if (!element) throw new ConversionError(`frame ${frameIndex + 1}: atom ${index + 1} has no element symbol.`);
    const x = finite(atom.x);
    const y = finite(atom.y);
    const z = finite(atom.z);
    if (x === null || y === null || z === null) {
      throw new ConversionError(`frame ${frameIndex + 1}: atom ${index + 1} has a non-finite coordinate.`);
    }
    return `${element} ${x.toFixed(precision)} ${y.toFixed(precision)} ${z.toFixed(precision)}`;
  });
  return [String(atoms.length), [PROPERTIES, ...infoOf(frame, frameIndex)].join(' '), ...body];
}

/**
 * @param {Array<{atoms: Array<{element: string, x: number, y: number, z: number}>, step?: number, energyHartree?: number}>} frames
 * @returns {string}
 */
export function writeExtxyz(frames, { precision = 8 } = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new ConversionError('there is no geometry to write: the run produced no frames.');
  }
  return `${frames.flatMap((frame, index) => linesOf(frame, index, precision)).join('\n')}\n`;
}
