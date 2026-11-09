/**
 * Homologous series — one repeat unit, one linkage rule, a range of n (issue 169).
 *
 * Pure module: no DOM, no filesystem, no Electron.
 *
 * A structure block (`type: 'input'`) may carry a **series definition** instead
 * of a plain dataset reference. `expandSeries()` turns that definition into N
 * ordinary records at **plan time**, each a real geometry with explicit bonds
 * and its own provenance, so fan-out, conformers, gates, writers and the report
 * need no change: they all iterate records, and a series is just more records.
 *
 * Geometry, stated plainly
 * ------------------------
 * Each copy of the unit is the unit's **own coordinates** moved by a rigid
 * translation along the donor → acceptor axis. Nothing is rebuilt: every bond
 * length and angle inside a copy is the unit's, and the one new bond at each
 * junction has exactly the requested length by construction. The generated
 * geometry is therefore **a starting point for optimisation, not a minimum** —
 * the same status as an imported or hand-drawn structure.
 *
 * The translation is
 *
 *     u = (acceptor - donor) / |acceptor - donor|      (unit vector, unit axis)
 *     t = (|acceptor - donor| + L) * u                 (step from copy k to k+1)
 *
 * so the junction bond between acceptor(i) and donor(i+1) is
 *
 *     donor(i+1) - acceptor(i) = (donor - acceptor) + t = L * u,  |.| = L.
 *
 * A single-length step (`t = L * u`) would put donor(i+1) exactly on
 * acceptor(i): the bond would be 0 Å, not L. The extra separation is the unit's
 * own donor → acceptor distance, which is what has to be spanned as well.
 *
 * Terminal rule
 * -------------
 * `linkage.leaving` names atoms of the unit that are dropped where a junction
 * forms. A leaving atom attached to the donor is dropped from every copy that
 * uses its donor (copies 1 … n-1); one attached to the acceptor is dropped from
 * every copy that uses its acceptor (copies 0 … n-2). The two end copies keep
 * their outer leaving groups, so the chain is **capped at both ends** and n = 1
 * is the unit itself, byte for byte. This is a deterministic rule, not a
 * chemistry judgement: it is stated on the block and in the project-format
 * documentation.
 *
 * Guards (every one names the atoms it refuses)
 * ---------------------------------------------
 * - donor equals acceptor, or either is outside the unit;
 * - the new bond order would push a linkage atom past its standard valence;
 * - a leaving atom is bonded to something other than the linkage atoms;
 * - two copies overlap (an atom pair below 0.5 Å);
 * - the range is empty, starts below 1, or asks for more than
 *   `SERIES_MAX_MEMBERS` members.
 *
 * Bond orders are not stored on dataset records, so bonds are **perceived**
 * from covalent-radius sums and counted as single bonds. The valence guard
 * therefore catches over-coordination, not an over-valent double bond; that
 * limit is stated in the documentation rather than hidden.
 */

import { COVALENT_RADII_ANGSTROM } from './validityChecks.js';

/**
 * A series is capped at 24 members.
 *
 * Every member multiplies every downstream block, and the plan itself is capped
 * at 5 000 tasks: 24 members across a five-block chain is already 120 runs per
 * optimised structure, and a real xTB/DFT run on an oligomer that long costs
 * minutes to hours. The convergence questions this feature exists for (where a
 * property stops moving with chain length) are answered well below 24 repeat
 * units for the systems this app targets, so a larger default would only
 * produce a queue nobody can finish.
 */
export const SERIES_MAX_MEMBERS = 24;

/** Below this, two atoms are the same place, not a bond. */
export const SERIES_OVERLAP_ANGSTROM = 0.5;

/** A junction bond outside this range is not a bond anyone meant to ask for. */
export const SERIES_BOND_LENGTH = Object.freeze({ min: 0.5, max: 4 });

/** The linkage forms one single bond; the format has no order field for it. */
export const SERIES_LINKAGE_ORDER = 1;

/** Covalent-radius tolerance, the same one the structure viewer perceives with. */
export const SERIES_BOND_TOLERANCE = 0.4;

/**
 * The largest member may hold at most this many atoms — the same ceiling a
 * stored geometry has. It is also what keeps the overlap scan cheap.
 */
export const SERIES_MAX_ATOMS = 1000;

/** The terminal rule above, in one sentence, for the card and the documents. */
export const SERIES_TERMINAL_RULE =
  'Leaving atoms are dropped only where a junction forms, so the first and last copies keep their outer leaving groups: the chain is capped at both ends, and n = 1 is the unit unchanged.';

/**
 * Standard valences for the elements a first-version linkage can reasonably
 * touch. An element missing here cannot be checked, and a linkage atom of that
 * element is refused by name rather than guessed at.
 */
const MAX_VALENCE = Object.freeze({
  H: 1, Li: 1, Be: 2, B: 3, C: 4, N: 3, O: 2, F: 1,
  Na: 1, Mg: 2, Al: 3, Si: 4, P: 3, S: 2, Cl: 1,
  K: 1, Ca: 2, Ge: 4, As: 3, Se: 2, Br: 1,
  Sn: 4, Sb: 3, Te: 2, I: 1, Pb: 4,
});

/** A refusal a caller can report as a validation error, never a crash. */
export class SeriesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SeriesError';
  }
}

const isAtom = (atom) => atom !== null && typeof atom === 'object'
  && Number.isFinite(Number(atom.x)) && Number.isFinite(Number(atom.y)) && Number.isFinite(Number(atom.z));

function covalentRadius(element) {
  return Object.prototype.hasOwnProperty.call(COVALENT_RADII_ANGSTROM, element)
    ? COVALENT_RADII_ANGSTROM[element]
    : null;
}

export function atomDistance(a, b) {
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y), Number(a.z) - Number(b.z));
}

/**
 * Bonds perceived from covalent-radius sums, 1-based like `molecule.bonds`.
 *
 * A pair closer than 0.4 Å is the same atom twice and is skipped, exactly as the
 * structure viewer does. An element with no tabulated radius contributes no
 * perceived bond; `validateSeriesLinkage()` is where that becomes a refusal.
 */
export function perceiveSeriesBonds(atoms, { tolerance = SERIES_BOND_TOLERANCE } = {}) {
  const list = Array.isArray(atoms) ? atoms : [];
  const bonds = [];
  for (let i = 0; i < list.length; i += 1) {
    const radiusA = covalentRadius(String(list[i]?.element || ''));
    if (radiusA === null) continue;
    for (let j = i + 1; j < list.length; j += 1) {
      const radiusB = covalentRadius(String(list[j]?.element || ''));
      if (radiusB === null) continue;
      const distance = atomDistance(list[i], list[j]);
      if (!Number.isFinite(distance) || distance < 0.4) continue;
      if (distance <= radiusA + radiusB + tolerance) bonds.push({ a: i + 1, b: j + 1, order: 1, distance });
    }
  }
  return bonds;
}

/** How many records a definition asks for, or 0 when the range is unusable. */
export function seriesMemberCount(series) {
  const from = Number(series?.from);
  const to = Number(series?.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) return 0;
  return to - from + 1;
}

/** `monomer` + 3 → `monomer-n3`: the member id names its parent and its n. */
export function seriesMemberId(parentId, n) {
  return `${String(parentId || 'unit')}-n${Number(n)}`;
}

/**
 * The unit a series repeats.
 *
 * A named `recordId` must be one of the records the block iterates. Without one,
 * the block needs exactly one candidate: picking the first of several would make
 * the chain a different molecule depending on dataset order.
 */
export function seriesUnitRecord(records, recordId = '') {
  const list = (Array.isArray(records) ? records : []).filter((record) => record && record.enabled !== false);
  const wanted = String(recordId || '');
  if (wanted) {
    const found = list.find((record) => String(record.id) === wanted);
    if (found) return found;
    const known = list.map((record) => record.id).join(', ') || 'none';
    throw new SeriesError(`The series unit record "${wanted}" is not an enabled record of this block's dataset (enabled: ${known}).`);
  }
  if (list.length === 1) return list[0];
  if (list.length === 0) {
    throw new SeriesError('The series block has no enabled record to repeat; enable one record or import a unit.');
  }
  throw new SeriesError(`The series block has ${list.length} enabled records (${list.map((record) => record.id).join(', ')});`
    + ' name the one repeat unit in input.recordId instead of taking the first.');
}

/**
 * Check a linkage rule against a unit and return what the builder needs.
 *
 * Throws `SeriesError` with the atom indices named. Returns the perceived bonds,
 * the axis, and the leaving atoms split by the end they belong to.
 */
export function validateSeriesLinkage({ atoms, linkage, bonds = null } = {}) {
  const list = Array.isArray(atoms) ? atoms : [];
  if (list.length < 2) {
    throw new SeriesError(`The series unit has ${list.length} atom${list.length === 1 ? '' : 's'}; a linkage needs at least two.`);
  }
  list.forEach((atom, index) => {
    if (!isAtom(atom)) {
      throw new SeriesError(`Atom ${index + 1} of the series unit has no finite x, y, z coordinate.`);
    }
  });
  const donor = Number(linkage?.donor);
  const acceptor = Number(linkage?.acceptor);
  if (!Number.isInteger(donor) || donor < 1 || donor > list.length) {
    throw new SeriesError(`The linkage donor (${String(linkage?.donor)}) is not an atom index in the unit, which has ${list.length} atoms.`);
  }
  if (!Number.isInteger(acceptor) || acceptor < 1 || acceptor > list.length) {
    throw new SeriesError(`The linkage acceptor (${String(linkage?.acceptor)}) is not an atom index in the unit, which has ${list.length} atoms.`);
  }
  if (donor === acceptor) {
    throw new SeriesError(`The linkage donor and acceptor are the same atom (${donor}); a junction needs two different atoms.`);
  }
  const length = Number(linkage?.bondLengthAngstrom);
  if (!Number.isFinite(length) || length < SERIES_BOND_LENGTH.min || length > SERIES_BOND_LENGTH.max) {
    throw new SeriesError(`The linkage bond length (${String(linkage?.bondLengthAngstrom)} Å) is outside`
      + ` ${SERIES_BOND_LENGTH.min}–${SERIES_BOND_LENGTH.max} Å.`);
  }
  const distance = atomDistance(list[donor - 1], list[acceptor - 1]);
  if (distance < SERIES_OVERLAP_ANGSTROM) {
    throw new SeriesError(`The linkage donor (${donor}) and acceptor (${acceptor}) are ${distance.toFixed(3)} Å apart;`
      + ' a junction between atoms on top of each other has no axis to build along.');
  }

  const topology = Array.isArray(bonds) && bonds.length ? bonds : perceiveSeriesBonds(list);
  const orderOf = (index) => topology
    .filter((bond) => bond.a === index || bond.b === index)
    .reduce((total, bond) => total + (Number(bond.order) || SERIES_LINKAGE_ORDER), 0);

  for (const [role, index] of [['donor', donor], ['acceptor', acceptor]]) {
    const element = String(list[index - 1].element || '');
    if (covalentRadius(element) === null) {
      throw new SeriesError(`The linkage ${role} is atom ${index} (${element || 'unknown element'}), whose covalent`
        + ' radius is not tabulated here, so its bonds cannot be perceived or checked.');
    }
    const max = MAX_VALENCE[element] ?? null;
    if (max === null) {
      throw new SeriesError(`The linkage ${role} is atom ${index} (${element || 'unknown element'}), which has no standard`
        + ' valence in this app, so the linkage cannot be checked.');
    }
    const used = orderOf(index);
    if (used + SERIES_LINKAGE_ORDER > max) {
      throw new SeriesError(`The linkage ${role} is atom ${index} (${element}) with a bond order of ${used};`
        + ` adding one more single bond would make it ${used + SERIES_LINKAGE_ORDER}, above the ${max} ${element} allows.`);
    }
  }

  const leavingRaw = Array.isArray(linkage?.leaving) ? linkage.leaving : [];
  const leaving = [];
  for (const value of leavingRaw) {
    const index = Number(value);
    if (!Number.isInteger(index) || index < 1 || index > list.length) {
      throw new SeriesError(`A leaving atom (${String(value)}) is not an atom index in the unit, which has ${list.length} atoms.`);
    }
    if (index === donor || index === acceptor) {
      throw new SeriesError(`Atom ${index} is listed as leaving and is also the linkage atom; one atom cannot be both.`);
    }
    if (leaving.includes(index)) continue;
    const attached = topology.filter((bond) => bond.a === index || bond.b === index);
    const others = attached.map((bond) => (bond.a === index ? bond.b : bond.a));
    if (attached.length === 0) {
      throw new SeriesError(`Atom ${index} is listed as leaving but is bonded to nothing, so it would leave a bare atom behind.`);
    }
    const stranger = others.find((other) => other !== donor && other !== acceptor);
    if (stranger !== undefined) {
      throw new SeriesError(`Atom ${index} is listed as leaving but is bonded to atom ${stranger};`
        + ` a leaving atom must be bonded to the linkage atom (donor ${donor} or acceptor ${acceptor}) only.`);
    }
    leaving.push({ index, attachedTo: others[0] === donor ? 'donor' : 'acceptor' });
  }

  const ux = (Number(list[acceptor - 1].x) - Number(list[donor - 1].x)) / distance;
  const uy = (Number(list[acceptor - 1].y) - Number(list[donor - 1].y)) / distance;
  const uz = (Number(list[acceptor - 1].z) - Number(list[donor - 1].z)) / distance;
  return {
    donor,
    acceptor,
    distance,
    bondLength: length,
    axis: { x: ux, y: uy, z: uz },
    // One copy to the next: the unit's own donor→acceptor span plus the new bond.
    step: distance + length,
    bonds: topology,
    leaving,
    leavingAtDonor: leaving.filter((entry) => entry.attachedTo === 'donor').map((entry) => entry.index),
    leavingAtAcceptor: leaving.filter((entry) => entry.attachedTo === 'acceptor').map((entry) => entry.index),
  };
}

/**
 * Refuse a layout where two copies of one member sit on top of each other.
 *
 * The comparison uses the atoms that are actually in the member: a leaving group
 * that a junction removes is not there, so it cannot clash with the next copy.
 * The rule a user can predict is "copies of the chain do not interpenetrate".
 */
function assertCopiesApart(copies, n) {
  for (let i = 0; i < copies.length; i += 1) {
    const left = copies[i];
    for (let j = i + 1; j < copies.length; j += 1) {
      const right = copies[j];
      for (const a of left.atoms) {
        for (const b of right.atoms) {
          const distance = atomDistance(a, b);
          if (distance < SERIES_OVERLAP_ANGSTROM) {
            throw new SeriesError(`Copies ${i + 1} and ${j + 1} of n = ${n} overlap: atom ${a.unitIndex} (${a.element})`
              + ` and atom ${b.unitIndex} (${b.element}) are ${distance.toFixed(3)} Å apart, below`
              + ` ${SERIES_OVERLAP_ANGSTROM} Å. Increase the bond length, or choose a linkage axis the unit grows along.`);
          }
        }
      }
    }
  }
}

/** One copy of the unit, translated by `offset` steps, with its junction atoms removed. */
function buildCopy(atoms, prepared, copyIndex, copies) {
  const removed = new Set();
  if (copyIndex > 0) prepared.leavingAtDonor.forEach((index) => removed.add(index));
  if (copyIndex < copies - 1) prepared.leavingAtAcceptor.forEach((index) => removed.add(index));
  const offset = copyIndex * prepared.step;
  const kept = [];
  const positionOf = new Map();
  atoms.forEach((atom, index) => {
    const unitIndex = index + 1;
    if (removed.has(unitIndex)) return;
    positionOf.set(unitIndex, kept.length + 1);
    kept.push({
      element: String(atom.element || ''),
      unitIndex,
      x: Number(atom.x) + offset * prepared.axis.x,
      y: Number(atom.y) + offset * prepared.axis.y,
      z: Number(atom.z) + offset * prepared.axis.z,
    });
  });
  return { atoms: kept, positionOf };
}

/**
 * Expand a series definition into ordinary records.
 *
 * `unit` is a dataset record (`{ id, label, charge, multiplicity, coords }`);
 * `series` is `{ from, to, linkage { donor, acceptor, bondLengthAngstrom, leaving } }`.
 * Returns `{ records, summary }` or throws `SeriesError`. Nothing is written
 * anywhere: a member that cannot be built is refused, never emitted with a
 * guessed geometry.
 */
export function expandSeries(unit, series) {
  if (!unit || !Array.isArray(unit.coords) || unit.coords.length === 0) {
    throw new SeriesError('The series unit has no coordinates to repeat.');
  }
  const from = Number(series?.from);
  const to = Number(series?.to);
  if (!Number.isInteger(from) || from < 1) {
    throw new SeriesError(`The series starts at n = ${String(series?.from)}; a series starts at 1 or more.`);
  }
  if (!Number.isInteger(to)) {
    throw new SeriesError(`The series ends at n = ${String(series?.to)}; the range needs two integers.`);
  }
  if (to < from) {
    throw new SeriesError(`The series range is empty: n runs from ${from} to ${to}.`);
  }
  const count = to - from + 1;
  if (count > SERIES_MAX_MEMBERS) {
    throw new SeriesError(`The series asks for ${count} members (n = ${from}…${to}); the cap is ${SERIES_MAX_MEMBERS}.`
      + ' Every member multiplies every downstream block, and the plan is capped at 5000 tasks.');
  }
  const atoms = unit.coords;
  const prepared = validateSeriesLinkage({ atoms, linkage: series?.linkage });
  // The largest member is a geometry the app has to write and read: it lives
  // under the same 1000-atom ceiling a stored structure has (LIMITS.atoms), which
  // also keeps the overlap scan below a few hundred thousand comparisons.
  if (atoms.length * to > SERIES_MAX_ATOMS) {
    throw new SeriesError(`n = ${to} with a ${atoms.length}-atom unit would hold ${atoms.length * to} atoms;`
      + ` one member is capped at ${SERIES_MAX_ATOMS} atoms. Lower the range, or repeat a smaller unit.`);
  }

  const records = [];
  for (let n = from; n <= to; n += 1) {
    const memberAtoms = [];
    const memberBonds = [];
    const copies = [];
    const junctionAcceptor = new Map(); // copy index -> member atom number
    const junctionDonor = new Map();
    for (let copy = 0; copy < n; copy += 1) {
      const built = buildCopy(atoms, prepared, copy, n);
      copies.push(built);
      const offset = memberAtoms.length;
      built.atoms.forEach((atom) => memberAtoms.push({
        element: atom.element, x: atom.x, y: atom.y, z: atom.z,
      }));
      for (const bond of prepared.bonds) {
        const a = built.positionOf.get(bond.a);
        const b = built.positionOf.get(bond.b);
        if (!a || !b) continue;
        memberBonds.push({ a: a + offset, b: b + offset, order: Number(bond.order) || 1 });
      }
      const acceptorPosition = built.positionOf.get(prepared.acceptor);
      const donorPosition = built.positionOf.get(prepared.donor);
      if (!Number.isInteger(acceptorPosition) || !Number.isInteger(donorPosition)) {
        // Neither atom can be a leaving group, so this is a bug in the builder
        // rather than a user error; saying so is better than a wrong bond.
        throw new SeriesError(`Copy ${copy + 1} of n = ${n} lost a linkage atom; the series cannot be built.`);
      }
      junctionAcceptor.set(copy, acceptorPosition + offset);
      junctionDonor.set(copy, donorPosition + offset);
    }
    // The member is the thing that has to be a structure, so the clash check
    // runs over the copies as they were actually assembled for this n.
    assertCopiesApart(copies, n);
    for (let copy = 0; copy < n - 1; copy += 1) {
      const a = junctionAcceptor.get(copy);
      const b = junctionDonor.get(copy + 1);
      memberBonds.push({ a: Math.min(a, b), b: Math.max(a, b), order: SERIES_LINKAGE_ORDER });
    }
    const id = seriesMemberId(unit.id, n);
    if (id.length > 64) {
      throw new SeriesError(`The member id "${id}" is ${id.length} characters; record ids stop at 64.`
        + ` Shorten the unit record id "${unit.id}".`);
    }
    records.push({
      id,
      label: `${unit.label || unit.id} · n=${n}`,
      charge: Number.isInteger(unit.charge) ? unit.charge : 0,
      multiplicity: Number.isInteger(unit.multiplicity) ? unit.multiplicity : 1,
      coords: memberAtoms,
      bonds: memberBonds,
      enabled: true,
      series: {
        parentId: String(unit.id),
        parentLabel: String(unit.label || unit.id),
        n,
        count,
        of: `${from}…${to}`,
        linkage: {
          donor: prepared.donor,
          acceptor: prepared.acceptor,
          bondLengthAngstrom: prepared.bondLength,
          leaving: prepared.leaving.map((entry) => entry.index),
        },
        terminal: 'capped',
      },
    });
  }
  return {
    records,
    summary: {
      parentId: String(unit.id),
      count,
      from,
      to,
      donor: prepared.donor,
      acceptor: prepared.acceptor,
      bondLengthAngstrom: prepared.bondLength,
      step: prepared.step,
      axis: prepared.axis,
      terminalRule: SERIES_TERMINAL_RULE,
    },
  };
}
