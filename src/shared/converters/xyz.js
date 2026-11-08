/**
 * Plain multi-frame XYZ.
 *
 * The most boring format in the toolbox, and that is the point: every viewer
 * reads it, including ones that predate the idea of per-frame metadata. One
 * frame is `N`, a free-text comment line, then one `element x y z` line per
 * atom. Frames follow one another with no separator, which is what VMD, OVITO
 * and Avogadro expect when a trajectory is handed to them as `.xyz`.
 *
 * The comment line carries the step and its energy in free text, because the
 * format has nowhere else to put them and a reader that ignores the comment
 * still gets every geometry right.
 */

export class ConversionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConversionError';
  }
}

function coordinate(value, what, frame) {
  // `Number(null)` is 0, so a missing coordinate must be rejected by kind, not
  // by the result of the conversion.
  const number = (value === null || value === undefined || value === '') ? Number.NaN : Number(value);
  if (!Number.isFinite(number)) {
    throw new ConversionError(`frame ${frame}: ${what} is not a finite number (${JSON.stringify(value)}).`);
  }
  return number;
}

function atomLine(atom, precision, frame, index) {
  const element = typeof atom?.element === 'string' ? atom.element.trim() : '';
  if (!element) {
    throw new ConversionError(`frame ${frame}: atom ${index + 1} has no element symbol.`);
  }
  return `${element} ${coordinate(atom.x, `atom ${index + 1} x`, frame).toFixed(precision)} `
    + `${coordinate(atom.y, `atom ${index + 1} y`, frame).toFixed(precision)} `
    + `${coordinate(atom.z, `atom ${index + 1} z`, frame).toFixed(precision)}`;
}

/** The comment line: free text, so a reader that ignores it loses nothing. */
function frameComment(frame, { comment } = {}) {
  const parts = [];
  if (comment) parts.push(comment);
  if (Number.isInteger(frame?.step)) parts.push(`step ${frame.step}`);
  if (Number.isFinite(frame?.energyHartree)) {
    parts.push(`energy ${frame.energyHartree.toFixed(8)} Eh`);
  }
  return parts.length ? parts.join(' | ') : 'NodeChem Studio';
}

/**
 * Write one or more frames as XYZ.
 *
 * @param {Array<{atoms: Array<{element: string, x: number, y: number, z: number}>, step?: number, energyHartree?: number}>} frames
 * @returns {string}
 */
export function writeXyz(frames, { precision = 6, comment = '' } = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new ConversionError('there is no geometry to write: the run produced no frames.');
  }
  const lines = [];
  frames.forEach((frame, frameIndex) => {
    const atoms = Array.isArray(frame?.atoms) ? frame.atoms : [];
    if (atoms.length === 0) {
      throw new ConversionError(`frame ${frameIndex + 1} has no atoms.`);
    }
    lines.push(String(atoms.length));
    lines.push(frameComment(frame, { comment }));
    atoms.forEach((atom, index) => lines.push(atomLine(atom, precision, frameIndex + 1, index)));
  });
  return `${lines.join('\n')}\n`;
}
