/**
 * Complex blocks — several records combined into one system, at plan time (issue 188).
 *
 * Pure module: no DOM, no filesystem, no Electron.
 *
 * A structure block (`type: 'input'`) may carry a **complex definition**
 * instead of a plain dataset reference. `expandComplex()` turns that definition
 * into **one** ordinary record at plan time, so fan-out, conformers, gates,
 * writers and the report need no change: they all iterate records, and a
 * complex is one more record.
 *
 * Fragment labels
 * ---------------
 * The atoms of member *i* (0-based) carry `fragment = i + 1`. That is the
 * numbering `atom.fragment` in the schema and the `--` separator in
 * `engines/psi4.js` already use (1 … `LIMITS.fragments`), which is what lets a
 * SAPT0 block consume the complex with no manual labelling.
 *
 * Geometry, stated plainly
 * ------------------------
 * Every placement is a **rigid body** move: member coordinates are translated
 * and — in `axis` mode — rotated as a whole. No bond length, bond angle or
 * dihedral inside a member is recomputed, so each member stays the molecule it
 * was. The result is therefore **a starting geometry, not a minimum**: the
 * record carries `geometryStatus: 'needs optimisation'` and nothing downstream
 * may present it as a stationary point.
 *
 *   as-drawn   every coordinate is copied verbatim; the members keep the
 *              relative geometry they already had.
 *   axis       member centres of mass lie on the stated axis, `distanceAngstrom`
 *              apart, and member k > 0 is rotated by `angleDegrees` about that
 *              axis (through its own centre of mass). Member 1 is never moved.
 *   principal  member centres of mass lie along member 1's **smallest principal
 *              axis of inertia**, `distanceAngstrom` apart. Member 2 keeps its
 *              drawn orientation; only the separation direction is derived.
 *
 * The inertia tensor is built properly (masses from `formula.js`, tensor about
 * the centre of mass) and diagonalised by a Jacobi rotation. A molecule whose
 * three principal moments are equal (a spherical top such as methane) has no
 * unique principal axis, and that is refused by name instead of guessed at.
 *
 * Guards (every one refuses by name, before a record is built)
 * -----------------------------------------------------------
 * - a member with no coordinates — never the demo-water fallback;
 * - more members than `COMPLEX_MAX_MEMBERS`, or a total above `COMPLEX_MAX_ATOMS`;
 * - the same record twice, unless the block says `homodimer`;
 * - `distanceAngstrom` below the sum of the two members' covalent radii;
 * - any interatomic distance between members below 0.7 Å (a clash, not a complex);
 * - an unknown placement mode, a zero-length axis, or a degenerate principal axis.
 */

import { atomicMass } from './formula.js';
import { COVALENT_RADII_ANGSTROM } from './validityChecks.js';

/**
 * A complex is capped at four members.
 *
 * The systems this block exists for are a dimer, a trimer, a tetramer — a
 * contact pair, a solvated pair, a small cluster. Each member multiplies every
 * downstream block, and the record id has to name its members inside the
 * 64-character record-id budget, so a larger default would only produce task
 * ids and folder names nobody can read.
 */
export const COMPLEX_MAX_MEMBERS = 4;

/**
 * The largest complex at most this many atoms — the same ceiling a stored
 * geometry has (`LIMITS.atoms` in `projectSchema.js`). It is duplicated rather
 * than imported because `projectSchema.js` imports `flows.js`, which imports
 * this module: importing the schema back would be a cycle. The two values are
 * asserted equal in the tests.
 */
export const COMPLEX_MAX_ATOMS = 1000;

/** Below this, two members are in the same place, not a complex. */
export const COMPLEX_MIN_SEPARATION_ANGSTROM = 0.7;

/** The placement modes, in the order the inspector offers them. */
export const COMPLEX_PLACEMENT_MODES = Object.freeze(['as-drawn', 'axis', 'principal']);

/** The status every generated complex carries, on the card and in the record. */
export const COMPLEX_GEOMETRY_STATUS = 'needs optimisation';

/** The note that travels with the record and is shown on the card. */
export const COMPLEX_GEOMETRY_NOTE = 'Members are placed as rigid bodies — translated, and rotated in axis '
  + 'mode — so every bond inside a member is the member\'s own. The relative orientation and '
  + 'separation are the ones the block states, not an energy minimum: this is a starting geometry '
  + 'for optimisation.';

/** A refusal a caller can report as a validation error, never a crash. */
export class ComplexError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ComplexError';
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function finiteCoordinate(atom) {
  return atom !== null && typeof atom === 'object'
    && Number.isFinite(Number(atom.x)) && Number.isFinite(Number(atom.y)) && Number.isFinite(Number(atom.z));
}

function covalentRadius(element) {
  return Object.prototype.hasOwnProperty.call(COVALENT_RADII_ANGSTROM, element)
    ? COVALENT_RADII_ANGSTROM[element]
    : null;
}

/** `complex-water-a-water-b`: names every parent, so a task id is traceable. */
export function complexRecordId(members) {
  const ids = (Array.isArray(members) ? members : []).map((member) => String(member?.id ?? member?.recordId ?? ''));
  return ['complex', ...ids].join('-');
}

/**
 * Centre of mass, in Å, from the members' own atoms.
 *
 * An element with no standard atomic weight is refused rather than weighted as
 * zero: a missing mass would silently move the whole placement.
 */
export function centreOfMass(atoms, label = 'member') {
  const list = Array.isArray(atoms) ? atoms : [];
  let mass = 0;
  let x = 0;
  let y = 0;
  let z = 0;
  list.forEach((atom, index) => {
    const weight = atomicMass(String(atom?.element || ''));
    if (weight === null) {
      throw new ComplexError(`Atom ${index + 1} of ${label} is "${String(atom?.element || '')}", whose standard`
        + ' atomic weight is not tabulated here, so its centre of mass cannot be computed.');
    }
    mass += weight;
    x += weight * Number(atom.x);
    y += weight * Number(atom.y);
    z += weight * Number(atom.z);
  });
  if (mass === 0) {
    throw new ComplexError(`${label} has no atoms, so it has no centre of mass.`);
  }
  return { x: x / mass, y: y / mass, z: z / mass, mass };
}

/**
 * Eigenvalues and eigenvectors of a symmetric 3×3 matrix, by Jacobi rotation.
 *
 * Small, fixed-size and deterministic — the project has no numerical library
 * and a 3×3 symmetric problem needs none. Returns eigenvalues in ascending
 * order with the matching eigenvectors (columns of the rotation matrix).
 */
function symmetricEigen3(matrix) {
  const a = matrix.map((row) => row.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const pairs = [[0, 1], [0, 2], [1, 2]];
  for (let sweep = 0; sweep < 60; sweep += 1) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-18) break;
    for (const [p, q] of pairs) {
      const apq = a[p][q];
      if (Math.abs(apq) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * apq);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      const tau = s / (1 + c);
      const app = a[p][p];
      const aqq = a[q][q];
      a[p][p] = app - t * apq;
      a[q][q] = aqq + t * apq;
      a[p][q] = 0;
      a[q][p] = 0;
      for (const r of [0, 1, 2]) {
        if (r === p || r === q) continue;
        const arp = a[r][p];
        const arq = a[r][q];
        a[r][p] = arp - s * (arq + tau * arp);
        a[p][r] = a[r][p];
        a[r][q] = arq + s * (arp - tau * arq);
        a[q][r] = a[r][q];
      }
      for (const r of [0, 1, 2]) {
        const vrp = v[r][p];
        const vrq = v[r][q];
        v[r][p] = vrp - s * (vrq + tau * vrp);
        v[r][q] = vrq + s * (vrp - tau * vrq);
      }
    }
  }
  const entries = [0, 1, 2].map((index) => ({
    value: a[index][index],
    vector: [v[0][index], v[1][index], v[2][index]],
  }));
  entries.sort((left, right) => left.value - right.value);
  return entries;
}

/**
 * Principal moments and axes of a molecule's inertia tensor about its centre of
 * mass, ascending by moment (so `[0]` is the smallest).
 *
 * Units are amu·Å², which is only ever used for ordering and for the
 * degeneracy check — no value here is reported as a physical constant.
 */
export function principalAxesOfInertia(atoms, label = 'member') {
  const list = Array.isArray(atoms) ? atoms : [];
  const com = centreOfMass(list, label);
  let ixx = 0;
  let iyy = 0;
  let izz = 0;
  let ixy = 0;
  let ixz = 0;
  let iyz = 0;
  list.forEach((atom, index) => {
    const weight = atomicMass(String(atom?.element || ''));
    if (weight === null) {
      throw new ComplexError(`Atom ${index + 1} of ${label} is "${String(atom?.element || '')}", whose standard`
        + ' atomic weight is not tabulated here, so its inertia tensor cannot be computed.');
    }
    const dx = Number(atom.x) - com.x;
    const dy = Number(atom.y) - com.y;
    const dz = Number(atom.z) - com.z;
    ixx += weight * (dy * dy + dz * dz);
    iyy += weight * (dx * dx + dz * dz);
    izz += weight * (dx * dx + dy * dy);
    ixy -= weight * dx * dy;
    ixz -= weight * dx * dz;
    iyz -= weight * dy * dz;
  });
  const entries = symmetricEigen3([[ixx, ixy, ixz], [ixy, iyy, iyz], [ixz, iyz, izz]]);
  return { com, moments: entries.map((entry) => entry.value), axes: entries.map((entry) => entry.vector) };
}

/** Unit vector, with a stable sign: the first non-zero component is positive. */
function unitAxis(vector, fallbackLabel = 'axis') {
  const x = Number(vector?.x ?? vector?.[0]);
  const y = Number(vector?.y ?? vector?.[1]);
  const z = Number(vector?.z ?? vector?.[2]);
  if (![x, y, z].every((value) => Number.isFinite(value))) {
    throw new ComplexError(`The ${fallbackLabel} must be three finite numbers.`);
  }
  const length = Math.hypot(x, y, z);
  if (length === 0) {
    throw new ComplexError(`The ${fallbackLabel} is the zero vector (0, 0, 0), which has no direction;`
      + ' give an axis such as (1, 0, 0).');
  }
  const unit = [x / length, y / length, z / length];
  const first = unit.find((value) => Math.abs(value) > 1e-12);
  if (first !== undefined && first < 0) {
    return { x: -unit[0], y: -unit[1], z: -unit[2] };
  }
  return { x: unit[0], y: unit[1], z: unit[2] };
}

/**
 * Rotation about a unit axis, right-handed, by `degrees`.
 *
 * Rodrigues' formula. A zero angle returns the identity exactly, so a 0°
 * placement does not perturb a coordinate.
 */
function rotationMatrix(axis, degrees) {
  const radians = (Number(degrees) * Math.PI) / 180;
  if (!Number.isFinite(radians) || radians === 0) {
    return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  }
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const t = 1 - c;
  const { x, y, z } = axis;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

/** The member record a definition names, or a refusal that names what was asked for. */
function resolveMember(member, index, dataset, datasets) {
  const wantedDatasetId = String(member?.datasetId || dataset?.id || '');
  const pool = Array.isArray(datasets) && datasets.length ? datasets : (dataset ? [dataset] : []);
  const bound = pool.find((entry) => entry?.id === wantedDatasetId)
    || (dataset && String(dataset.id) === wantedDatasetId ? dataset : null);
  const where = `member ${index + 1}`;
  if (!bound) {
    throw new ComplexError(`The complex ${where} names dataset "${wantedDatasetId}", which is not part of this`
      + ' block; bind the dataset or name one that exists.');
  }
  const recordId = String(member?.recordId || '');
  if (!recordId) {
    throw new ComplexError(`The complex ${where} names no record id; pick the record it should place.`);
  }
  const records = (Array.isArray(bound.records) ? bound.records : []).filter((record) => record && record.enabled !== false);
  const record = records.find((entry) => String(entry.id) === recordId);
  if (!record) {
    const known = records.map((entry) => entry.id).join(', ') || 'none';
    throw new ComplexError(`The complex ${where} names record "${recordId}", which is not an enabled record of`
      + ` dataset "${bound.id}" (enabled: ${known}).`);
  }
  return {
    recordId,
    datasetId: String(bound.id),
    label: String(record.label || record.id),
    charge: Number.isInteger(member?.charge) ? member.charge : (Number.isInteger(record.charge) ? record.charge : 0),
    multiplicity: Number.isInteger(member?.multiplicity)
      ? member.multiplicity
      : (Number.isInteger(record.multiplicity) ? record.multiplicity : 1),
    coords: record.coords,
    bonds: Array.isArray(record.bonds) ? record.bonds : [],
  };
}

/** The largest covalent radius in a member: the radius that decides a contact floor. */
function memberRadius(member) {
  let largest = null;
  member.coords.forEach((atom, index) => {
    const element = String(atom?.element || '');
    const radius = covalentRadius(element);
    if (radius === null) {
      throw new ComplexError(`Atom ${index + 1} of complex member "${member.recordId}" is "${element}", whose`
        + ' covalent radius is not tabulated here, so a contact distance for that member cannot be checked.');
    }
    if (largest === null || radius > largest.radius) largest = { element, radius };
  });
  return largest;
}

/**
 * Refuse a placement where two members are on top of each other.
 *
 * Only **inter-member** pairs are compared: an overlap inside a member is that
 * member's own geometry and not something this block created.
 */
function assertMembersApart(placed) {
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const left = placed[i].member;
      const right = placed[j].member;
      const leftAtoms = placed[i].atoms;
      const rightAtoms = placed[j].atoms;
      for (let a = 0; a < leftAtoms.length; a += 1) {
        for (let b = 0; b < rightAtoms.length; b += 1) {
          const one = leftAtoms[a];
          const two = rightAtoms[b];
          const distance = Math.hypot(one.x - two.x, one.y - two.y, one.z - two.z);
          if (distance < COMPLEX_MIN_SEPARATION_ANGSTROM) {
            throw new ComplexError(`Complex members "${left.recordId}" and "${right.recordId}" overlap: atom`
              + ` ${a + 1} (${one.element}) of "${left.recordId}" and atom ${b + 1} (${two.element}) of`
              + ` "${right.recordId}" are ${distance.toFixed(3)} Å apart, below`
              + ` ${COMPLEX_MIN_SEPARATION_ANGSTROM} Å. Increase the separation, or choose another placement.`);
          }
        }
      }
    }
  }
}

/** Rotation of one atom about a point, with the matrix applied. */
function rotateAbout(atom, com, matrix) {
  const dx = atom.x - com.x;
  const dy = atom.y - com.y;
  const dz = atom.z - com.z;
  return {
    x: matrix[0][0] * dx + matrix[0][1] * dy + matrix[0][2] * dz + com.x,
    y: matrix[1][0] * dx + matrix[1][1] * dy + matrix[1][2] * dz + com.y,
    z: matrix[2][0] * dx + matrix[2][1] * dy + matrix[2][2] * dz + com.z,
  };
}

/**
 * Expand a complex definition into one ordinary record.
 *
 * `definition` is `{ members: [{ datasetId, recordId, charge?, multiplicity? }],
 * placement: { mode, axis?, distanceAngstrom?, angleDegrees? }, homodimer? }`.
 * `dataset` is the block's bound dataset; `datasets` is the project's list when
 * members may name another one. Returns `{ records, summary }` or throws
 * `ComplexError`. Nothing is written anywhere: a member that cannot be placed is
 * refused, never emitted with a guessed geometry.
 */
export function expandComplex(definition, { dataset = null, datasets = null } = {}) {
  const source = isPlainObject(definition) ? definition : {};
  const membersRaw = Array.isArray(source.members) ? source.members : [];
  if (membersRaw.length < 2) {
    throw new ComplexError(`A complex needs at least two members; this block lists ${membersRaw.length}.`
      + ' One record on its own is a plain dataset block.');
  }
  if (membersRaw.length > COMPLEX_MAX_MEMBERS) {
    throw new ComplexError(`A complex is capped at ${COMPLEX_MAX_MEMBERS} members; this block lists`
      + ` ${membersRaw.length}.`);
  }
  const members = membersRaw.map((member, index) => resolveMember(member, index, dataset, datasets));

  // A record with no coordinates would be built as the demo water molecule by
  // `moleculeForNode`; the honest answer is this refusal, never a substitute.
  members.forEach((member) => {
    const coords = Array.isArray(member.coords) ? member.coords : [];
    if (coords.length === 0) {
      throw new ComplexError(`Complex member "${member.recordId}" has no 3D coordinates.`
        + ' A member without a geometry would be built as the demo water molecule, so the block refuses it.'
        + ' Import or draw the structure first.');
    }
    coords.forEach((atom, index) => {
      if (!finiteCoordinate(atom)) {
        throw new ComplexError(`Atom ${index + 1} of complex member "${member.recordId}" has no finite x, y, z`
          + ' coordinate.');
      }
    });
  });

  // The same record twice is an ambiguity: two copies at the same place, or two
  // different placements of one parent? A homodimer says which one is meant.
  const homodimer = source.homodimer === true;
  const keys = members.map((member) => `${member.datasetId}::${member.recordId}`);
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate && !homodimer) {
    const recordId = duplicate.split('::')[1];
    throw new ComplexError(`Complex record "${recordId}" appears twice in this block. Two copies of one record`
      + ' are only built when the block says the pair is a homodimer; otherwise pick two different records.');
  }
  if (homodimer) {
    if (members.length !== 2) {
      throw new ComplexError(`A homodimer is exactly two members; this block lists ${members.length}.`
        + ' Turn homodimer off for a larger complex.');
    }
    if (keys[0] !== keys[1]) {
      throw new ComplexError(`The block says homodimer, but its members are "${members[0].recordId}" and`
        + ` "${members[1].recordId}". A homodimer is two copies of one record.`);
    }
  }

  const totalAtoms = members.reduce((total, member) => total + member.coords.length, 0);
  if (totalAtoms > COMPLEX_MAX_ATOMS) {
    throw new ComplexError(`This complex would hold ${totalAtoms} atoms; a structure is capped at`
      + ` ${COMPLEX_MAX_ATOMS} atoms. Use smaller members, or fewer of them.`);
  }

  const placementRaw = isPlainObject(source.placement) ? source.placement : {};
  const mode = String(placementRaw.mode || 'as-drawn');
  if (!COMPLEX_PLACEMENT_MODES.includes(mode)) {
    throw new ComplexError(`"${mode}" is not a placement mode; a complex places members by`
      + ` ${COMPLEX_PLACEMENT_MODES.join(', ')}.`);
  }
  const distance = Number(placementRaw.distanceAngstrom);
  const angle = placementRaw.angleDegrees === undefined || placementRaw.angleDegrees === null
    ? 0 : Number(placementRaw.angleDegrees);
  if (mode !== 'as-drawn' && !Number.isFinite(distance)) {
    throw new ComplexError(`The ${mode} placement needs distanceAngstrom; it is the separation between the`
      + ' members\' centres of mass.');
  }
  if (mode !== 'as-drawn' && distance <= 0) {
    throw new ComplexError(`The ${mode} placement distance is ${distance} Å; it must be a positive length.`);
  }

  let axis = null;
  if (mode === 'axis') {
    const raw = Array.isArray(placementRaw.axis) ? placementRaw.axis : null;
    if (!raw || raw.length !== 3) {
      throw new ComplexError('The axis placement needs axis: three numbers, such as [1, 0, 0].');
    }
    axis = unitAxis(raw, 'placement axis');
  }
  if (mode === 'principal') {
    const { moments, axes } = principalAxesOfInertia(members[0].coords, `complex member "${members[0].recordId}"`);
    const scale = Math.max(Math.abs(moments[2]), 1);
    if (Math.abs(moments[1] - moments[0]) <= 1e-9 * scale) {
      throw new ComplexError(`Member "${members[0].recordId}" has three (or two) equal principal moments of`
        + ' inertia, so it has no unique principal axis to place the next member along. Use the axis'
        + ' placement and state the direction.');
    }
    axis = unitAxis(axes[0], 'principal axis');
  }

  const centres = members.map((member) => centreOfMass(member.coords, `complex member "${member.recordId}"`));
  const origin = centres[0];
  const matrix = mode === 'axis' ? rotationMatrix(axis, angle) : null;

  const placed = members.map((member, index) => {
    if (mode === 'as-drawn' || index === 0) {
      // `as-drawn` is the promise that every coordinate is unchanged, so the
      // first member is always copied verbatim rather than moved by a zero
      // vector (which would still round every coordinate).
      return {
        member,
        atoms: member.coords.map((atom) => ({
          element: String(atom.element || ''),
          x: Number(atom.x),
          y: Number(atom.y),
          z: Number(atom.z),
          ...(Number.isInteger(atom.isotope) && atom.isotope > 0 ? { isotope: atom.isotope } : {}),
        })),
      };
    }
    const step = index * distance;
    const target = {
      x: origin.x + step * axis.x,
      y: origin.y + step * axis.y,
      z: origin.z + step * axis.z,
    };
    return {
      member,
      atoms: member.coords.map((atom) => {
        const base = {
          x: Number(atom.x),
          y: Number(atom.y),
          z: Number(atom.z),
        };
        const rotated = matrix ? rotateAbout(base, centres[index], matrix) : base;
        return {
          element: String(atom.element || ''),
          // Rigid translation: the member's own internal geometry is untouched.
          x: rotated.x + (target.x - centres[index].x),
          y: rotated.y + (target.y - centres[index].y),
          z: rotated.z + (target.z - centres[index].z),
          ...(Number.isInteger(atom.isotope) && atom.isotope > 0 ? { isotope: atom.isotope } : {}),
        };
      }),
    };
  });

  assertMembersApart(placed);

  // A contact floor from the members' own covalent radii: below the sum of the
  // two largest radii, the centres of mass are inside each other's atoms.
  if (mode !== 'as-drawn') {
    const left = memberRadius(members[0]);
    const right = memberRadius(members[1]);
    const floor = left.radius + right.radius;
    if (distance < floor) {
      throw new ComplexError(`The requested separation (${Number(distance).toFixed(2)} Å) is below the sum of the`
        + ` members' covalent radii (${left.element} ${left.radius.toFixed(2)} Å +`
        + ` ${right.element} ${right.radius.toFixed(2)} Å = ${floor.toFixed(2)} Å);`
        + ' two molecules cannot be that close.');
    }
  }

  const id = complexRecordId(members);
  if (id.length > 64) {
    throw new ComplexError(`The complex id "${id}" is ${id.length} characters; record ids stop at 64.`
      + ' Shorten the member record ids.');
  }

  const coords = [];
  const bonds = [];
  const provenanceMembers = [];
  placed.forEach((entry, index) => {
    const offset = coords.length;
    const fragment = index + 1;
    entry.atoms.forEach((atom) => coords.push({ ...atom, fragment }));
    entry.member.bonds.forEach((bond) => {
      const a = Number(bond?.a) + offset;
      const b = Number(bond?.b) + offset;
      if (!Number.isInteger(a) || !Number.isInteger(b)) return;
      bonds.push({ a, b, order: Number(bond?.order) || 1 });
    });
    provenanceMembers.push({
      id: entry.member.recordId,
      label: entry.member.label,
      datasetId: entry.member.datasetId,
      fragment,
      atomCount: entry.atoms.length,
      charge: entry.member.charge,
      multiplicity: entry.member.multiplicity,
    });
  });

  // Charge adds; multiplicity is the highest-spin coupling of the members
  // (sum of unpaired electrons plus one). That is a stated rule, not a guess:
  // a low-spin coupled complex has to be assembled outside this block.
  const charge = members.reduce((total, member) => total + member.charge, 0);
  const multiplicity = Math.max(1, members.reduce((total, member) => total + member.multiplicity, 0) - members.length + 1);

  const placement = {
    mode,
    ...(axis ? { axis: [axis.x, axis.y, axis.z] } : {}),
    ...(mode === 'as-drawn' ? {} : { distanceAngstrom: distance }),
    ...(mode === 'axis' ? { angleDegrees: angle } : {}),
  };

  const record = {
    id,
    label: members.map((member) => member.label).join(' + '),
    charge,
    multiplicity,
    coords,
    bonds,
    enabled: true,
    complex: {
      members: provenanceMembers,
      placement,
      ...(homodimer ? { homodimer: true } : {}),
      geometryStatus: COMPLEX_GEOMETRY_STATUS,
      geometryNote: COMPLEX_GEOMETRY_NOTE,
    },
  };

  return {
    records: [record],
    summary: {
      id,
      label: record.label,
      atomCount: coords.length,
      memberCount: members.length,
      charge,
      multiplicity,
      placement,
      geometryStatus: COMPLEX_GEOMETRY_STATUS,
      note: COMPLEX_GEOMETRY_NOTE,
    },
  };
}
