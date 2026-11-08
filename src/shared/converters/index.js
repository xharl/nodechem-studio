/**
 * Converters: parsed results to the formats other software reads.
 *
 * The rule that keeps this useful across engines is that nothing here knows
 * what produced the numbers. A converter takes either a parsed Gaussian output
 * or a structure record and writes text; when ORCA lands, its parser produces
 * the same shapes and these writers keep working unchanged.
 *
 * Formats, and why each one earns its place:
 *
 *   extxyz  trajectories for ASE / OVITO / VMD, with per-frame energy
 *   xyz     the lowest common denominator; every viewer reads it
 *   sdf     a structure plus its bond table; refuses when the record has none
 *   jcamp   spectra as data rather than a picture, with units in the header
 *
 *   molden  structure plus basis plus orbitals, from a formatted checkpoint
 *           (the only format here that cannot come from a log)
 */

import { broadenedSpectrum } from '../spectrum.js';
import { moldenFromFchk } from './molden.js';
import { writeExtxyz } from './extxyz.js';
import { writeJcampDx } from './jcampDx.js';
import { writeSdf } from './sdf.js';
import { ConversionError, writeXyz } from './xyz.js';

export { ConversionError };

export const CONVERT_FORMATS = Object.freeze([
  {
    id: 'extxyz', label: 'Extended XYZ', extension: 'extxyz', mediaType: 'chemical/x-extxyz', kind: 'frames',
  },
  {
    id: 'xyz', label: 'XYZ', extension: 'xyz', mediaType: 'chemical/x-xyz', kind: 'frames',
  },
  {
    id: 'sdf', label: 'SDF (V2000)', extension: 'sdf', mediaType: 'chemical/x-mdl-sdfile', kind: 'structure',
  },
  {
    id: 'jcamp', label: 'JCAMP-DX', extension: 'jdx', mediaType: 'chemical/x-jcamp-dx', kind: 'spectrum',
  },
  {
    id: 'molden', label: 'Molden', extension: 'molden', mediaType: 'chemical/x-molden', kind: 'wavefunction',
  },
]);

export const SPECTRUM_KINDS = Object.freeze(['ir', 'raman', 'uv']);

export function formatById(id) {
  return CONVERT_FORMATS.find((entry) => entry.id === id) || null;
}

function atomsOf(source) {
  const atoms = Array.isArray(source) ? source : source?.atoms;
  if (!Array.isArray(atoms) || atoms.length === 0) return null;
  return atoms;
}

/**
 * Every geometry the record has, best first: the optimisation/IRC trajectory
 * when the run printed one, otherwise the final geometry, otherwise the input
 * geometry. The caller is told which one it got, because "the last frame" and
 * "the only frame" are different claims about a run.
 */
export function framesFromParsed(parsed) {
  const steps = parsed?.trajectory?.steps;
  if (Array.isArray(steps) && steps.length > 0) {
    return {
      frames: steps.map((step) => ({
        atoms: step.atoms,
        step: step.index,
        energyHartree: step.energyHartree,
      })),
      source: 'trajectory',
    };
  }
  const final = atomsOf(parsed?.finalGeometry) || atomsOf(parsed?.geometry?.final);
  if (final) return { frames: [{ atoms: final }], source: 'final-geometry' };
  const input = atomsOf(parsed?.geometry?.input);
  if (input) return { frames: [{ atoms: input }], source: 'input-geometry' };
  throw new ConversionError('the run carries no geometry: neither a trajectory nor an input or final structure.');
}

function bondsOf(parsed) {
  const bonds = parsed?.bonds ?? parsed?.molecule?.bonds;
  return Array.isArray(bonds) && bonds.length > 0 ? bonds : null;
}

/**
 * The IR table as Gaussian printed it: mode frequency and its intensity. Modes
 * the normal-mode parser could not pair keep `null` and are left out — an
 * intensity of zero would be a measurement, not a missing value.
 */
function irPoints(parsed) {
  const meta = parsed?.normalModesMeta;
  const frequencies = Array.isArray(meta?.frequencies) ? meta.frequencies : null;
  const intensities = Array.isArray(meta?.irIntensities) ? meta.irIntensities : null;
  if (!frequencies || !intensities) {
    throw new ConversionError('this run has no IR intensity table to write.');
  }
  const points = [];
  frequencies.forEach((wavenumber, index) => {
    const intensity = Number(intensities[index]);
    if (Number.isFinite(wavenumber) && Number.isFinite(intensity)) {
      points.push({ x: Number(wavenumber), y: intensity });
    }
  });
  if (points.length === 0) throw new ConversionError('the IR table has no finite intensity values.');
  return points;
}

function ramanPoints(parsed) {
  const modes = parsed?.raman;
  if (!Array.isArray(modes) || modes.length === 0) {
    throw new ConversionError('this run has no Raman table; the route needs Freq with Raman.');
  }
  const points = modes
    .filter((mode) => Number.isFinite(mode?.wavenumber) && Number.isFinite(mode?.ramanActivity))
    .map((mode) => ({ x: Number(mode.wavenumber), y: Number(mode.ramanActivity) }));
  if (points.length === 0) throw new ConversionError('the Raman table has no finite activities.');
  return points;
}

function uvPoints(parsed, fwhmEv) {
  const states = parsed?.excitedStates?.states;
  if (!Array.isArray(states) || states.length === 0) {
    throw new ConversionError('this run has no excited states to broaden into a UV/Vis spectrum.');
  }
  const spectrum = broadenedSpectrum(states, fwhmEv ? { fwhmEv } : undefined);
  if (!spectrum || !Array.isArray(spectrum.points) || spectrum.points.length === 0) {
    throw new ConversionError('the excited states carry no oscillator strengths, so no spectrum can be built.');
  }
  return {
    points: spectrum.points.map((point) => ({ x: point.wavelengthNm, y: point.relative })),
    notes: [`Broadened with a ${spectrum.fwhmEv} eV FWHM over ${spectrum.samples} samples; intensities are relative.`],
  };
}

/**
 * One spectrum, with its axis units decided by the data rather than assumed.
 * @param {'ir'|'raman'|'uv'} kind
 */
export function spectrumFromParsed(parsed, kind, { fwhmEv } = {}) {
  if (kind === 'ir') {
    return {
      points: irPoints(parsed), dataType: 'INFRARED SPECTRUM', xUnits: '1/CM', yUnits: 'ARBITRARY UNITS', notes: [],
    };
  }
  if (kind === 'raman') {
    return {
      points: ramanPoints(parsed), dataType: 'RAMAN SPECTRUM', xUnits: '1/CM', yUnits: 'ARBITRARY UNITS', notes: [],
    };
  }
  if (kind === 'uv') {
    const result = uvPoints(parsed, fwhmEv);
    return {
      points: result.points, dataType: 'UV/VIS SPECTRUM', xUnits: 'NM', yUnits: 'ARBITRARY UNITS', notes: result.notes,
    };
  }
  throw new ConversionError(`unknown spectrum "${kind}"; expected one of ${SPECTRUM_KINDS.join(', ')}.`);
}

/**
 * Convert a parsed record.
 *
 * @returns {{format: string, extension: string, mediaType: string, text: string, notes: string[]}}
 */
export function convertParsed(parsed, formatId, { spectrum = 'ir', title = '', date = null, fwhmEv } = {}) {
  const format = formatById(formatId);
  if (!format) {
    throw new ConversionError(`unknown format "${formatId}"; expected one of ${CONVERT_FORMATS.map((entry) => entry.id).join(', ')}.`);
  }
  if (format.kind === 'wavefunction') {
    throw new ConversionError(
      'Molden needs basis functions and MO coefficients, which a log does not carry. '
      + 'Export the job\'s .fchk and convert that instead.',
    );
  }

  if (format.kind === 'spectrum') {
    const chosen = spectrumFromParsed(parsed, spectrum, { fwhmEv });
    const text = writeJcampDx({
      title: title || `${chosen.dataType.toLowerCase()} from NodeChem Studio`,
      dataType: chosen.dataType,
      xUnits: chosen.xUnits,
      yUnits: chosen.yUnits,
      points: chosen.points,
      date,
    });
    return {
      format: format.id,
      extension: format.extension,
      mediaType: format.mediaType,
      text,
      notes: [...chosen.notes],
    };
  }

  if (format.id === 'sdf') {
    const { frames, source } = framesFromParsed(parsed);
    const atoms = frames[frames.length - 1].atoms;
    const bonds = bondsOf(parsed);
    if (!bonds) {
      throw new ConversionError(
        'this record states no bonds, and SDF without a bond table is a list of isolated atoms. '
        + 'Export extxyz or xyz instead, or open a structure file that carries its connectivity.',
      );
    }
    return {
      format: format.id,
      extension: format.extension,
      mediaType: format.mediaType,
      text: writeSdf({ atoms, bonds, title: title || 'NodeChem structure' }),
      notes: [`Bond table taken from the record; geometry from the ${source}.`],
    };
  }

  const { frames, source } = framesFromParsed(parsed);
  const notes = [`${frames.length} frame(s) from the ${source}.`];
  if (format.id === 'extxyz') {
    notes.push('Per-frame energy is written in eV for ASE; energy_hartree carries the unrounded value.');
    return {
      format: format.id,
      extension: format.extension,
      mediaType: format.mediaType,
      text: writeExtxyz(frames),
      notes,
    };
  }
  return {
    format: format.id,
    extension: format.extension,
    mediaType: format.mediaType,
    text: writeXyz(frames),
    notes,
  };
}

/**
 * Convert a parsed formatted checkpoint.
 *
 * Only Molden takes this path today: it is the one format that needs the basis
 * and the orbital coefficients, and the fchk is where they are.
 */
export function convertFchk(fchk, formatId, { title = '' } = {}) {
  const format = formatById(formatId);
  if (!format) {
    throw new ConversionError(`unknown format "${formatId}"; expected one of ${CONVERT_FORMATS.map((entry) => entry.id).join(', ')}.`);
  }
  if (format.id !== 'molden') {
    throw new ConversionError(`${format.id} is not written from a checkpoint; convert a structure file or a run instead.`);
  }
  const written = moldenFromFchk(fchk, { title });
  return {
    format: format.id,
    extension: format.extension,
    mediaType: format.mediaType,
    text: written.text,
    notes: written.notes,
  };
}

/** Convert an already-imported structure record (atoms, optional 1-based bonds). */
export function convertStructure(structure, formatId, { title = '' } = {}) {
  const format = formatById(formatId);
  if (!format) {
    throw new ConversionError(`unknown format "${formatId}"; expected one of ${CONVERT_FORMATS.map((entry) => entry.id).join(', ')}.`);
  }
  const atoms = atomsOf(structure);
  if (!atoms) throw new ConversionError('the structure has no atoms.');
  if (format.kind === 'spectrum') {
    throw new ConversionError(`${format.id} is a spectrum format; a structure has no spectrum.`);
  }
  if (format.kind === 'wavefunction') {
    throw new ConversionError(`${format.id} needs basis functions and orbitals; convert a formatted checkpoint instead.`);
  }
  if (format.id === 'sdf') {
    const bonds = bondsOf(structure);
    if (!bonds) {
      throw new ConversionError('this structure file states no bonds, so SDF would hold isolated atoms. Use xyz or extxyz.');
    }
    return {
      format: format.id,
      extension: format.extension,
      mediaType: format.mediaType,
      text: writeSdf({ atoms, bonds, title: title || 'NodeChem structure' }),
      notes: ['Bond table taken from the source file.'],
    };
  }
  const frames = [{ atoms }];
  const text = format.id === 'extxyz' ? writeExtxyz(frames) : writeXyz(frames);
  return {
    format: format.id, extension: format.extension, mediaType: format.mediaType, text, notes: ['1 frame from the imported structure.'],
  };
}
