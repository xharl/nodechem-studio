/**
 * Wavefunction values that can be derived without a renderer (#59).
 *
 * Everything here is arithmetic on a parsed cube (`cubeFile.js`) or a parsed
 * formatted checkpoint (`fchk.js`). Nothing draws, nothing guesses, and every
 * function that cannot answer says so in the same shape:
 *
 *     { ok: false, reason: '…' }
 *
 * rather than returning `0`, `null` in a numeric position, or the nearest
 * plausible number. A caller can therefore tell "the gap is 4.2 eV" from "the
 * file did not carry an occupied orbital", which is the difference between a
 * result and a bug that looks like one.
 *
 * Units: both parsers already return coordinates in Å, so nothing here converts
 * a coordinate again. The one conversion this module performs is
 * Hartree → eV / kcal·mol⁻¹ on orbital energies, and it is applied to the gap,
 * not to the stored orbital energies.
 *
 * Not here, by design: orbital isosurfaces, ESP colour maps, QTAIM basins and
 * NCI surfaces. Those need a mesh, a camera and a colour scale — i.e. a
 * renderer — and are the other half of #59.
 */

import { createHash } from 'node:crypto';
import { parseCube, BOHR_TO_ANGSTROM } from './cubeFile.js';
import { parseFchk } from './fchk.js';

export { BOHR_TO_ANGSTROM };

/** CODATA 2018. */
export const HARTREE_TO_EV = 27.211386245988;
export const HARTREE_TO_KCAL = 627.5094740631;

export const WAVEFUNCTION_RECORD_VERSION = 1;

/** Charge sums are compared with this tolerance, in electrons. */
export const CHARGE_SUM_TOLERANCE = 0.01;

function notComputable(reason) {
  return { ok: false, reason };
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object';
}

function byteLength(text) {
  // Buffer in the main process (no copy); TextEncoder where Buffer is absent.
  return typeof Buffer === 'undefined'
    ? new TextEncoder().encode(text).length
    : Buffer.byteLength(text);
}

/* ── cube: point, slice, isosurface ───────────────────────── */

function determinant(a, b, c) {
  return a[0] * (b[1] * c[2] - b[2] * c[1])
    - a[1] * (b[0] * c[2] - b[2] * c[0])
    + a[2] * (b[0] * c[1] - b[1] * c[0]);
}

/**
 * Fractional grid coordinates of a point given in Å. The axes are solved as a
 * linear system rather than dotted with unit vectors, so a non-orthogonal
 * hexagonal cell is handled by the same code.
 */
function gridCoordinates(cube, point) {
  const [a, b, c] = cube.axes;
  const det = determinant(a, b, c);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const p = [
    point[0] - cube.origin[0],
    point[1] - cube.origin[1],
    point[2] - cube.origin[2],
  ];
  return [
    determinant(p, b, c) / det,
    determinant(a, p, c) / det,
    determinant(a, b, p) / det,
  ];
}

function clampIndex(value, size) {
  if (size <= 1) return 0;
  if (value < 0) return 0;
  if (value > size - 1) return size - 1;
  return value;
}

/**
 * The value at a point, in Å, by trilinear interpolation.
 *
 * `null` means the point is outside the grid — genuinely not computable from
 * this cube, not "zero density". Callers should say "outside the grid" rather
 * than draw a zero.
 */
export function cubeValueAt(cube, point, { method = 'trilinear' } = {}) {
  if (!isObject(cube) || !Array.isArray(cube.dims) || !cube.values) {
    throw new TypeError('cubeValueAt needs a parsed cube (see cubeFile.js).');
  }
  if (!Array.isArray(point) || point.length !== 3 || !point.every((value) => Number.isFinite(value))) {
    throw new TypeError('cubeValueAt needs a point as [x, y, z] in Å.');
  }
  const fractions = gridCoordinates(cube, point);
  if (!fractions) return null;
  const [nx, ny, nz] = cube.dims;
  const sizes = [nx, ny, nz];
  for (let axis = 0; axis < 3; axis += 1) {
    // A hair of tolerance so a point exactly on the far face is inside.
    if (fractions[axis] < -1e-9 || fractions[axis] > sizes[axis] - 1 + 1e-9) return null;
  }
  const { values } = cube;
  const at = (i, j, k) => values[i + nx * (j + ny * k)];

  const base = fractions.map((value, axis) => clampIndex(Math.floor(value), sizes[axis]));
  if (method === 'nearest') {
    return at(
      clampIndex(Math.round(fractions[0]), nx),
      clampIndex(Math.round(fractions[1]), ny),
      clampIndex(Math.round(fractions[2]), nz),
    );
  }
  const upper = fractions.map((value, axis) => clampIndex(Math.ceil(value), sizes[axis]));
  const weight = [0, 1, 2].map((axis) => fractions[axis] - base[axis]);

  let total = 0;
  for (let corner = 0; corner < 8; corner += 1) {
    const i = corner & 1 ? upper[0] : base[0];
    const j = corner & 2 ? upper[1] : base[1];
    const k = corner & 4 ? upper[2] : base[2];
    const w = (corner & 1 ? weight[0] : 1 - weight[0])
      * (corner & 2 ? weight[1] : 1 - weight[1])
      * (corner & 4 ? weight[2] : 1 - weight[2]);
    total += w * at(i, j, k);
  }
  return total;
}

const AXIS_NAMES = { x: 0, y: 1, z: 2 };

function axisIndex(axis) {
  if (typeof axis === 'number' && Number.isInteger(axis) && axis >= 0 && axis <= 2) return axis;
  const named = AXIS_NAMES[String(axis).toLowerCase()];
  if (named !== undefined) return named;
  throw new RangeError('A slice axis is "x", "y", "z" or 0, 1, 2.');
}

/**
 * One plane of the grid, ready for a 2D canvas or a heat map.
 *
 * `values` is row-major with `height` rows of `width` entries; `rowAxis` runs
 * down the plane and `columnAxis` across it, both named so a caller cannot
 * silently transpose the picture.
 */
export function cubeSlice(cube, { axis = 'z', index } = {}) {
  if (!isObject(cube) || !Array.isArray(cube.dims) || !cube.values) {
    throw new TypeError('cubeSlice needs a parsed cube (see cubeFile.js).');
  }
  const normal = axisIndex(axis);
  const planeIndex = Number(index);
  if (!Number.isInteger(planeIndex) || planeIndex < 0 || planeIndex >= cube.dims[normal]) {
    throw new RangeError(`The slice index must be an integer from 0 to ${cube.dims[normal] - 1}.`);
  }
  const [nx, ny, nz] = cube.dims;
  const sizes = [nx, ny, nz];
  const columns = [0, 1, 2].filter((value) => value !== normal)[0];
  const rows = [0, 1, 2].filter((value) => value !== normal)[1];
  const width = sizes[columns];
  const height = sizes[rows];
  const values = new Float64Array(width * height);
  const index3 = [0, 0, 0];
  index3[normal] = planeIndex;
  let min = Infinity;
  let max = -Infinity;
  for (let row = 0; row < height; row += 1) {
    index3[rows] = row;
    for (let column = 0; column < width; column += 1) {
      index3[columns] = column;
      const value = cube.values[index3[0] + nx * (index3[1] + ny * index3[2])];
      values[row * width + column] = value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  const origin = [0, 1, 2].map((component) => cube.origin[component] + cube.axes[normal][component] * planeIndex);
  return {
    axis: ['x', 'y', 'z'][normal],
    index: planeIndex,
    width,
    height,
    columns: ['x', 'y', 'z'][columns],
    rows: ['x', 'y', 'z'][rows],
    origin,
    axes: [cube.axes[columns], cube.axes[rows]],
    values,
    min,
    max,
    units: { coordinates: 'angstrom' },
  };
}

function voxelPoint(cube, i, j, k) {
  return [0, 1, 2].map((component) => (
    cube.origin[component] + cube.axes[0][component] * i + cube.axes[1][component] * j + cube.axes[2][component] * k
  ));
}

/**
 * What an isosurface at `isovalue` would enclose: how many grid points are
 * above it on each phase, what fraction of the cell that is, and the box the
 * surface has to cover. Enough for a viewer to place a mesh and report a
 * volume, and enough for a report to state the isovalue it used.
 *
 * Sign convention: a cube of an orbital has both phases, so the positive and
 * negative counts are reported separately. A density has no negative values
 * and the negative phase is simply zero points — not an error.
 */
export function summariseIsosurface(cube, { isovalue } = {}) {
  if (!isObject(cube) || !Array.isArray(cube.dims) || !cube.values) {
    throw new TypeError('summariseIsosurface needs a parsed cube (see cubeFile.js).');
  }
  const threshold = Number(isovalue);
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new RangeError('An isovalue must be a finite number greater than zero; there is no surface at zero.');
  }
  const [nx, ny, nz] = cube.dims;
  const total = cube.values.length;
  const cellVolume = isFinite(cube.volumeAngstrom3) ? cube.volumeAngstrom3 : 0;
  let positive = 0;
  let negative = 0;
  let box = null;
  const extend = (i, j, k) => {
    const point = voxelPoint(cube, i, j, k);
    if (!box) {
      box = { min: [...point], max: [...point] };
      return;
    }
    for (let axis = 0; axis < 3; axis += 1) {
      if (point[axis] < box.min[axis]) box.min[axis] = point[axis];
      if (point[axis] > box.max[axis]) box.max[axis] = point[axis];
    }
  };
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const value = cube.values[i + nx * (j + ny * k)];
        if (value >= threshold && threshold > 0) {
          positive += 1;
          extend(i, j, k);
        } else if (value <= -threshold && threshold > 0) {
          negative += 1;
          extend(i, j, k);
        }
      }
    }
  }
  const share = (count) => (total ? count / total : 0);
  return {
    isovalue: threshold,
    positive: { voxels: positive, fraction: share(positive), volumeAngstrom3: share(positive) * cellVolume },
    negative: { voxels: negative, fraction: share(negative), volumeAngstrom3: share(negative) * cellVolume },
    totalVoxels: total,
    cellVolumeAngstrom3: cellVolume,
    extent: box,
    units: { coordinates: 'angstrom', volume: 'angstrom^3' },
  };
}

/**
 * An isovalue that encloses `fraction` of the grid, computed from the data
 * instead of from a fixed number that would mean one thing for a density and
 * nothing for an orbital.
 *
 * This is a percentile of |value|. It is a starting point for a viewer control,
 * not a chemical recommendation, and the caller must still print the value it
 * used.
 */
export function suggestIsovalue(cube, { fraction = 0.02 } = {}) {
  if (!isObject(cube) || !cube.values || cube.values.length === 0) return null;
  const target = Number(fraction);
  if (!Number.isFinite(target) || target <= 0 || target >= 1) {
    throw new RangeError('The enclosed fraction must be between 0 and 1 (exclusive).');
  }
  const sorted = Float64Array.from(cube.values, (value) => Math.abs(value)).sort();
  const position = Math.min(sorted.length - 1, Math.floor((1 - target) * sorted.length));
  return sorted[position];
}

/* ── fchk: gap, spin, charge ──────────────────────────────── */

/**
 * HOMO/LUMO gap from the orbital energies and the alpha-electron count.
 *
 * Restricted: `Orbital Energies` holds every spatial orbital, so the HOMO is
 * index `nAlpha − 1`. Unrestricted: the same array holds the alpha orbitals and
 * `Orbital Energies, spin 2` the beta set, so both gaps are computed.
 *
 * The gap is between Kohn–Sham (or Hartree–Fock) orbitals. It is not the
 * fundamental gap and not an optical excitation energy; the returned `note`
 * says so, and the results surface must print it next to the number.
 */
export function orbitalGap(fchk) {
  if (!isObject(fchk)) return notComputable('there is no parsed checkpoint');
  const energies = fchk.orbitalEnergies;
  if (!Array.isArray(energies) || energies.length === 0) {
    return notComputable('the checkpoint has no "Orbital Energies" array');
  }
  const alpha = fchk.numberOfAlphaElectrons;
  if (!Number.isInteger(alpha) || alpha < 1) {
    return notComputable('the checkpoint has no "Number of alpha electrons", so the occupied orbitals cannot be identified');
  }
  const energiesOk = energies.every((value) => Number.isFinite(value));
  if (!energiesOk) return notComputable('the orbital energies contain a non-finite value');

  const homoIndex = alpha - 1;
  const lumoIndex = alpha;
  if (homoIndex >= energies.length) {
    return notComputable(`the occupied count (${alpha}) is larger than the ${energies.length} orbital energies in the file`);
  }
  if (lumoIndex >= energies.length) {
    return notComputable(`the orbital list ends at the HOMO (${energies.length} orbitals), so there is no LUMO`);
  }

  const gapHartree = energies[lumoIndex] - energies[homoIndex];
  const result = {
    ok: true,
    channel: 'alpha',
    homo: { index: homoIndex, energyHartree: energies[homoIndex], energyEv: energies[homoIndex] * HARTREE_TO_EV },
    lumo: { index: lumoIndex, energyHartree: energies[lumoIndex], energyEv: energies[lumoIndex] * HARTREE_TO_EV },
    gapHartree,
    gapEv: gapHartree * HARTREE_TO_EV,
    gapKcal: gapHartree * HARTREE_TO_KCAL,
    occupiedCount: alpha,
    orbitalCount: energies.length,
    note: 'Kohn–Sham/Hartree–Fock orbital energies: this is an orbital-energy gap, not the fundamental gap and not an excitation energy.',
  };

  if (Array.isArray(fchk.orbitalEnergiesBeta) && Number.isInteger(fchk.numberOfBetaElectrons) && fchk.numberOfBetaElectrons >= 1) {
    const beta = fchk.numberOfBetaElectrons;
    const betaHomo = beta - 1;
    const betaLumo = beta;
    if (betaLumo < fchk.orbitalEnergiesBeta.length) {
      const betaGap = fchk.orbitalEnergiesBeta[betaLumo] - fchk.orbitalEnergiesBeta[betaHomo];
      result.beta = {
        homo: { index: betaHomo, energyHartree: fchk.orbitalEnergiesBeta[betaHomo], energyEv: fchk.orbitalEnergiesBeta[betaHomo] * HARTREE_TO_EV },
        lumo: { index: betaLumo, energyHartree: fchk.orbitalEnergiesBeta[betaLumo], energyEv: fchk.orbitalEnergiesBeta[betaLumo] * HARTREE_TO_EV },
        gapHartree: betaGap,
        gapEv: betaGap * HARTREE_TO_EV,
        gapKcal: betaGap * HARTREE_TO_KCAL,
      };
    }
  }
  return result;
}

/**
 * Spin state implied by the alpha/beta counts.
 *
 * `sSquared` is S(S+1) for a pure spin state. It is *not* the SCF ⟨S²⟩, which
 * can be larger when the determinant is spin-contaminated; the log carries
 * that value and the two must not be confused.
 */
export function spinFromElectrons(fchk) {
  if (!isObject(fchk)) return notComputable('there is no parsed checkpoint');
  const alpha = fchk.numberOfAlphaElectrons;
  const beta = fchk.numberOfBetaElectrons;
  if (!Number.isInteger(alpha) || !Number.isInteger(beta) || alpha < 0 || beta < 0) {
    return notComputable('the checkpoint has no "Number of alpha/beta electrons" pair');
  }
  const unpaired = Math.abs(alpha - beta);
  const s = unpaired / 2;
  return {
    ok: true,
    alpha,
    beta,
    unpairedElectrons: unpaired,
    s,
    multiplicity: unpaired + 1,
    sSquared: s * (s + 1),
    note: 'S(S+1) for a pure spin state; the SCF ⟨S²⟩ in the output can be larger when the determinant is spin-contaminated.',
  };
}

/**
 * The sum of the partial charges against the total charge the file states (or
 * the one its nuclear charges and electron count imply).
 *
 * A Mulliken population analysis sums to the total electron count by
 * construction, so a deviation larger than a few hundredths of an electron
 * means the charge array and the rest of the file describe different systems.
 */
export function chargeSanity(fchk, { tolerance = CHARGE_SUM_TOLERANCE } = {}) {
  if (!isObject(fchk)) return notComputable('there is no parsed checkpoint');
  const charges = Array.isArray(fchk.mullikenCharges) && fchk.mullikenCharges.length
    ? fchk.mullikenCharges
    : Array.isArray(fchk.espCharges) && fchk.espCharges.length ? fchk.espCharges : null;
  if (!charges) return notComputable('the checkpoint has neither "Mulliken Charges" nor "ESP Charges"');
  if (!charges.every((value) => Number.isFinite(value))) {
    return notComputable('the charge array contains a non-finite value');
  }

  let expectedCharge = null;
  let expectedFrom = null;
  if (Number.isInteger(fchk.charge)) {
    expectedCharge = fchk.charge;
    expectedFrom = 'the checkpoint Charge field';
  } else if (Array.isArray(fchk.atomicNumbers) && Number.isInteger(fchk.numberOfElectrons)) {
    const nuclear = fchk.atomicNumbers.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
    expectedCharge = nuclear - fchk.numberOfElectrons;
    expectedFrom = 'nuclear charge minus electron count';
  } else if (Array.isArray(fchk.atomicNumbers)
    && Number.isInteger(fchk.numberOfAlphaElectrons) && Number.isInteger(fchk.numberOfBetaElectrons)) {
    const nuclear = fchk.atomicNumbers.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
    expectedCharge = nuclear - (fchk.numberOfAlphaElectrons + fchk.numberOfBetaElectrons);
    expectedFrom = 'nuclear charge minus alpha/beta electron counts';
  }
  if (expectedCharge === null) {
    return notComputable('the checkpoint states neither a total charge nor the electron and nuclear counts to derive one');
  }

  const limit = Number(tolerance);
  const bound = Number.isFinite(limit) && limit >= 0 ? limit : CHARGE_SUM_TOLERANCE;
  const sum = charges.reduce((total, value) => total + value, 0);
  const deviation = sum - expectedCharge;
  return {
    ok: true,
    source: charges === fchk.mullikenCharges ? 'mulliken' : 'esp',
    atomCount: charges.length,
    chargeSum: sum,
    expectedCharge,
    expectedFrom,
    deviation,
    tolerance: bound,
    withinTolerance: Math.abs(deviation) <= bound,
  };
}

/* ── input dispatch and the run-record block ──────────────── */

const CUBE_HEADER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/;

function looksLikeCube(text) {
  const lines = String(text).split(/\r\n|\n|\r/);
  if (lines.length < 4) return false;
  const tokens = lines[2].trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 4 || tokens.length > 5) return false;
  if (!tokens.every((token) => CUBE_HEADER.test(token))) return false;
  const atoms = Number(tokens[0]);
  return Number.isInteger(atoms) && atoms >= 0;
}

/**
 * Which reader a file needs, from its content rather than its extension — a
 * `.txt` cube and a `.fchk` renamed to `.out` are both common in the wild.
 */
export function detectWavefunctionFormat(text) {
  const source = String(text ?? '');
  if (!source.trim()) return '';
  if (/^\s*(?:Number of atoms|Atomic numbers|Current cartesian coordinates)\s+[IR]\b/m.test(source)) return 'fchk';
  if (looksLikeCube(source)) return 'cube';
  return '';
}

/** Parse a cube or a checkpoint, whichever the text turns out to be. */
export function readWavefunction(text, { filename = '', maxChars } = {}) {
  const kind = detectWavefunctionFormat(text);
  if (kind === 'cube') return { kind, parsed: parseCube(text, maxChars ? { maxChars } : undefined) };
  if (kind === 'fchk') return { kind, parsed: parseFchk(text, maxChars ? { maxChars } : undefined) };
  throw new Error(
    `${filename || 'The file'} is neither a Gaussian cube nor a formatted checkpoint. `
    + 'A cube starts with two comment lines and an "atoms ox oy oz" header; an fchk starts with "Number of atoms".',
  );
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function summariseCube(cube) {
  return {
    title: cube.title,
    dims: cube.dims,
    voxels: cube.values.length,
    atoms: cube.atoms.length,
    units: cube.units,
    origin: cube.origin,
    axes: cube.axes,
    spacing: cube.spacing,
    volumeAngstrom3: cube.volumeAngstrom3,
    stats: {
      min: cube.stats.min,
      max: cube.stats.max,
      mean: cube.stats.mean,
      absMax: cube.stats.absMax,
      minVoxel: cube.stats.minVoxel,
      maxVoxel: cube.stats.maxVoxel,
      absMaxVoxel: cube.stats.absMaxVoxel,
    },
  };
}

function summariseFchk(fchk) {
  const summary = {
    fields: { found: [...fchk.found], missing: [...fchk.missing] },
    units: fchk.units,
    orbitalGap: orbitalGap(fchk),
    spin: spinFromElectrons(fchk),
    // Not `charge`: that name belongs to the checkpoint's own Charge field,
    // which is copied below when present.
    chargeSanity: chargeSanity(fchk),
  };
  // Optional fields are copied only when the file carried them: an absent key
  // is the only honest way to say "not in this checkpoint".
  const copy = [
    'numberOfAtoms', 'numberOfBasisFunctions', 'numberOfElectrons', 'charge', 'multiplicity',
    'numberOfAlphaElectrons', 'numberOfBetaElectrons',
    'totalEnergyHartree', 'virialRatio',
  ];
  for (const key of copy) {
    if (fchk[key] !== undefined) summary[key] = fchk[key];
  }
  if (Array.isArray(fchk.atoms)) summary.atoms = fchk.atoms.length;
  return summary;
}

/**
 * Build the `wavefunction` block a run record carries. It is deliberately
 * small: dimensions, extrema and derived values, never the grid itself, so a
 * `run.json` stays readable.
 */
export function buildWavefunctionRecord({ cube = null, fchk = null, artifacts = [] } = {}) {
  const record = {
    version: WAVEFUNCTION_RECORD_VERSION,
    artifacts: Array.isArray(artifacts) ? artifacts : [],
  };
  if (cube) record.cube = summariseCube(cube);
  if (fchk) record.fchk = summariseFchk(fchk);
  if (!cube && !fchk) throw new Error('A wavefunction record needs at least one of cube or fchk.');
  return record;
}

/**
 * Read one or more files into a single run-record block.
 *
 * `files` is `[{ text, filename }]`. One cube and one checkpoint fit in a
 * record; a second of either is refused rather than silently replaced, because
 * two densities are two results.
 */
export function wavefunctionRecord(files, { maxChars } = {}) {
  const list = Array.isArray(files) ? files : [files];
  const artifacts = [];
  let cube = null;
  let fchk = null;
  for (const file of list) {
    if (!file || typeof file.text !== 'string') {
      throw new TypeError('wavefunctionRecord needs {text, filename} objects.');
    }
    const { kind, parsed } = readWavefunction(file.text, { filename: file.filename, maxChars });
    if (kind === 'cube') {
      if (cube) throw new Error('Only one cube fits in a wavefunction record; attach the second cube to its own run.');
      cube = parsed;
    } else {
      if (fchk) throw new Error('Only one checkpoint fits in a wavefunction record; attach the second one to its own run.');
      fchk = parsed;
    }
    artifacts.push({
      kind,
      file: String(file.filename || '').trim(),
      sha256: typeof file.sha256 === 'string' && file.sha256 ? file.sha256 : sha256(file.text),
      bytes: byteLength(file.text),
    });
  }
  return buildWavefunctionRecord({ cube, fchk, artifacts });
}
