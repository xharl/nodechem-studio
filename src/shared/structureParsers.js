/**
 * Additional structure readers: PDB, PDBQT, Tripos MOL2, RDKit cJSON and a
 * Gaussian log's optimisation frames (#79).
 *
 * Each parser returns the shape `structureImport.finalize()` expects — atoms as
 * `{element, x, y, z}`, bonds as 1-based `{a, b, order}`, plus warnings — so
 * validation, the atom limit and the electron-parity check stay in one place.
 *
 * Rules followed here:
 * - Never invent a topology. A format that states bonds gets them; a format
 *   whose bond records are incomplete (PDB `CONECT`) does not, and says so,
 *   because the viewer's distance perception is the more complete answer for a
 *   protein.
 * - Never invent an element. The element column wins; when it is missing the
 *   name is used and that inference is reported.
 * - Never silently drop alternative locations, alternate models or records.
 */

import { atomicNumber, isElementSymbol } from './elements.js';

const MAX_ATOMS = 1000;

class FormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FormatError';
  }
}

function number(value) {
  const parsed = Number(String(value ?? '').trim().replace(/[Dd]/, 'E'));
  return Number.isFinite(parsed) ? parsed : null;
}

/** `C.3` → C, `N.pl3` → N, `Cl` → Cl, `S.o2` → S. */
function elementFromTriposType(type) {
  const head = String(type ?? '').split('.')[0].replace(/[^A-Za-z]/g, '');
  if (!head) return '';
  const two = head.slice(0, 2);
  if (isElementSymbol(two) && head[1] === head[1]?.toLowerCase() && /[A-Z]/.test(head[0])) return two[0].toUpperCase() + two.slice(1).toLowerCase();
  const one = head[0].toUpperCase();
  return isElementSymbol(one) ? one : '';
}

/**
 * PDB atom name → element. `CA` in a protein is a carbon alpha, not calcium,
 * so a two-letter symbol is only taken when its second letter is lowercase
 * (the PDB convention) or when the element column says so.
 */
function elementFromPdbName(name) {
  const cleaned = String(name ?? '').replace(/[^A-Za-z]/g, '');
  if (!cleaned) return '';
  const two = cleaned.slice(0, 2);
  if (/^[A-Z][a-z]$/.test(two) && isElementSymbol(two)) return two;
  const one = cleaned[0].toUpperCase();
  return isElementSymbol(one) ? one : '';
}

/* ── CDXML ────────────────────────────────────────────────── */

/**
 * ChemDraw's XML drawing format (#120). The reader lives in `cdxml.js`; it is
 * re-exported here because every other format reader is reached through this
 * module, and `structureImport.js` should not grow a second back door.
 */
export { isCdxmlDocument, parseCdxmlRecords as parseCdxml } from './cdxml.js';

/* ── PDB / PDBQT ──────────────────────────────────────────── */

/**
 * AutoDock atom types (PDBQT columns 78–79): `OA` is an oxygen acceptor, `HD` a
 * polar hydrogen, `A` an aromatic carbon, `NA` a nitrogen acceptor. The first
 * letter is not the element — `HD` starts with H but `NA` starts with N while
 * `A` starts with nothing usable.
 */
function elementFromAdType(type) {
  const raw = String(type ?? '').trim();
  if (!raw) return '';
  const table = {
    A: 'C', C: 'C', N: 'N', NA: 'N', NS: 'N', OA: 'O', OS: 'O', S: 'S', SA: 'S',
    H: 'H', HD: 'H', HS: 'H', P: 'P', F: 'F', Cl: 'Cl', CL: 'Cl', Br: 'Br', BR: 'Br',
    I: 'I', Zn: 'Zn', ZN: 'Zn', Mg: 'Mg', MG: 'Mg', Fe: 'Fe', FE: 'Fe', Ca: 'Ca', CA: 'Ca',
  };
  if (table[raw]) return table[raw];
  const letters = raw.replace(/[^A-Za-z]/g, '');
  const two = letters.slice(0, 2);
  if (/^[A-Z][a-z]$/.test(two) && isElementSymbol(two)) return two;
  const one = letters[0]?.toUpperCase();
  return isElementSymbol(one) ? one : '';
}

function pdbLine(line, index, { pdbqt = false } = {}) {
  // Fixed columns per the PDB specification; a PDBQT adds charge and type after
  // the coordinates and otherwise keeps the same geometry columns.
  const record = line.slice(0, 6).trim();
  const atomName = line.slice(12, 16);
  const altLoc = line.slice(16, 17).trim();
  const residue = line.slice(17, 20).trim();
  const chain = line.slice(21, 22).trim();
  const resSeq = line.slice(22, 26).trim();
  const icode = line.slice(26, 27).trim();
  const x = number(line.slice(30, 38));
  const y = number(line.slice(38, 46));
  const z = number(line.slice(46, 54));
  const occupancy = number(line.slice(54, 60));
  const declared = line.slice(76, 78).trim();
  const adType = line.slice(77, 79).trim();
  const declaredElement = isElementSymbol(declared) ? declared[0].toUpperCase() + declared.slice(1).toLowerCase() : '';
  const typedElement = pdbqt ? elementFromAdType(adType) : '';
  const element = declaredElement || typedElement || elementFromPdbName(atomName);
  if (x === null || y === null || z === null) {
    throw new FormatError(`Line ${index + 1} has no readable coordinates in columns 31–54.`);
  }
  if (!element) {
    throw new FormatError(`Line ${index + 1} has neither an element column nor a recognisable atom name ("${atomName.trim()}").`);
  }
  return {
    record,
    serial: number(line.slice(6, 11)),
    element,
    x,
    y,
    z,
    occupancy: occupancy === null ? 1 : occupancy,
    altLoc,
    key: altLoc ? `${chain}|${resSeq}|${icode}|${residue}|${atomName.trim()}` : '',
    // The AutoDock type is a declaration too, so it does not count as a guess.
    declaredElement: Boolean(declaredElement || typedElement),
    charge: number(line.slice(70, 76)),
  };
}

/**
 * One `MODEL` block (or the whole file when there is no `MODEL`).
 *
 * Alternative locations are resolved by keeping the highest-occupancy copy of
 * each atom and reporting how many were dropped — a crystallographer's choice,
 * stated, not hidden.
 */
function parsePdbBlock(lines, { name = '', pdbqt = false } = {}) {
  const warnings = [];
  const rows = [];
  const conect = [];
  let conectLines = 0;
  let sawAtom = false;
  let inferred = 0;

  lines.forEach((line, index) => {
    const record = line.slice(0, 6).trim();
    if (record === 'CONECT') {
      conectLines += 1;
      const partners = line.slice(6).trim().split(/\s+/).map(Number).filter((value) => Number.isFinite(value));
      if (partners.length > 1) conect.push({ from: partners[0], to: partners.slice(1) });
      return;
    }
    if (record !== 'ATOM' && record !== 'HETATM') return;
    const atom = pdbLine(line, index, { pdbqt });
    if (!atom.declaredElement) inferred += 1;
    sawAtom = true;
    rows.push(atom);
  });

  if (!sawAtom) throw new FormatError('No ATOM or HETATM records were found.');

  const best = new Map();
  const keptOrder = [];
  let altDropped = 0;
  for (const row of rows) {
    // A blank alternate-location indicator means "the only copy", so it is
    // never grouped with anything else — a PDBQT ligand reuses atom names like
    // "C" for every carbon, and grouping by name would collapse the molecule.
    if (!row.key) {
      keptOrder.push(row);
      continue;
    }
    const previous = best.get(row.key);
    if (!previous) {
      best.set(row.key, row);
      keptOrder.push(row);
      continue;
    }
    altDropped += 1;
    if (row.occupancy > previous.occupancy) {
      best.set(row.key, row);
      const at = keptOrder.indexOf(previous);
      if (at >= 0) keptOrder[at] = row;
    }
  }

  const kept = keptOrder;
  if (kept.length > MAX_ATOMS) {
    throw new FormatError(`The file has ${kept.length} atoms; the limit is ${MAX_ATOMS}.`);
  }

  if (altDropped > 0) warnings.push(`${altDropped} alternative-location atom${altDropped === 1 ? '' : 's'} resolved by occupancy.`);
  if (inferred > 0) warnings.push(`Element inferred from the atom name for ${inferred} atom${inferred === 1 ? '' : 's'} (no element column).`);
  // CONECT is only a usable topology when it actually covers the structure: in
  // a protein it lists the disulfides and little else, so using it would hide
  // every backbone bond behind a "file topology" label. Coverage is measured on
  // heavy atoms, and a file that names most of them states its bonds.
  let bonds = [];
  if (conectLines > 0) {
    const indexBySerial = new Map();
    kept.forEach((row, index) => {
      if (row.serial !== null) indexBySerial.set(row.serial, index);
    });
    const heavy = kept.filter((row) => row.element !== 'H').length || kept.length;
    const mentioned = new Set();
    const seen = new Set();
    for (const entry of conect) {
      const from = indexBySerial.get(entry.from);
      if (from === undefined) continue;
      for (const partner of entry.to) {
        const to = indexBySerial.get(partner);
        if (to === undefined || to === from) continue;
        mentioned.add(from);
        mentioned.add(to);
        const key = `${Math.min(from, to)}-${Math.max(from, to)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bonds.push({ a: Math.min(from, to) + 1, b: Math.max(from, to) + 1, order: 1 });
      }
    }
    const coverage = heavy === 0 ? 0 : mentioned.size / heavy;
    if (coverage < 0.9) {
      bonds = [];
      warnings.push(`CONECT records cover ${Math.round(coverage * 100)}% of the atoms, so they were not treated as a topology; the viewer perceives bonds from distances instead.`);
    } else {
      warnings.push('Bonds taken from CONECT (no bond orders are stored in a PDB, so all are single).');
    }
  }
  if (conectLines === 0) bonds = [];
  if (pdbqt) {
    const partial = kept.map((row) => row.charge).filter((value) => value !== null);
    if (partial.length) warnings.push(`Partial charges were read for ${partial.length} atoms; the total charge is not set from them.`);
  }

  return {
    atoms: kept.map((row) => ({ element: row.element, x: row.x, y: row.y, z: row.z })),
    bonds,
    charge: 0,
    multiplicity: 1,
    name,
    warnings,
  };
}

export function parsePdb(text, { name = '', pdbqt = false } = {}) {
  const lines = String(text ?? '').split(/\r\n|\n|\r/);
  // An ensemble file read as a single structure means the first model: folding
  // every MODEL into one atom list would look like alternative locations and
  // resolve half of the atoms away.
  const start = lines.findIndex((line) => line.slice(0, 6).trim() === 'MODEL');
  if (start < 0) return parsePdbBlock(lines, { name, pdbqt });
  const end = lines.findIndex((line, index) => index > start && line.slice(0, 6).trim() === 'ENDMDL');
  const block = lines.slice(start + 1, end < 0 ? lines.length : end);
  return parsePdbBlock(block, { name: `${name} model 1`.trim(), pdbqt });
}

/**
 * Every `MODEL` in an NMR/cryo-EM ensemble. A file without `MODEL` yields one
 * record, so the caller can always offer a picker.
 */
export function parsePdbModels(text, { name = '', pdbqt = false } = {}) {
  const lines = String(text ?? '').split(/\r\n|\n|\r/);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const record = line.slice(0, 6).trim();
    if (record === 'MODEL') {
      current = [];
      continue;
    }
    if (record === 'ENDMDL') {
      if (current && current.length) blocks.push(current);
      current = null;
      continue;
    }
    if (current) current.push(line);
  }
  if (blocks.length === 0) return [{ ...parsePdbBlock(lines, { name, pdbqt }) }];
  return blocks.map((block, index) => ({
    ...parsePdbBlock(block, { name: `${name} model ${index + 1}`.trim(), pdbqt }),
  }));
}

/* ── Tripos MOL2 ──────────────────────────────────────────── */

const MOL2_BOND_ORDER = { 1: 1, 2: 2, 3: 3, ar: 1.5, am: 1, du: 1, un: 1, nc: 1 };

/**
 * MOL2 states a complete topology, so its bond block is authoritative — orders
 * included (`ar` is aromatic, `am` an amide bond, `du`/`un` unknown).
 */
export function parseMol2(text, { name = '' } = {}) {
  const lines = String(text ?? '').split(/\r\n|\n|\r/);
  const warnings = [];
  const moleculeAt = lines.findIndex((line) => /^@<TRIPOS>MOLECULE/i.test(line));
  if (moleculeAt < 0) throw new FormatError('No @<TRIPOS>MOLECULE record was found.');
  const moleculeName = (lines[moleculeAt + 1] || '').trim();
  const counts = (lines[moleculeAt + 2] || '').trim().split(/\s+/).map(Number);
  const declaredAtoms = Number.isFinite(counts[0]) ? counts[0] : null;
  const declaredBonds = Number.isFinite(counts[1]) ? counts[1] : null;
  if (declaredAtoms && declaredAtoms > MAX_ATOMS) {
    throw new FormatError(`The MOL2 declares ${declaredAtoms} atoms; the limit is ${MAX_ATOMS}.`);
  }

  const atoms = [];
  const byId = new Map();
  const bonds = [];
  let section = '';
  let unknownBonds = 0;

  for (const line of lines) {
    const header = line.match(/^@<TRIPOS>(\w+)/i);
    if (header) {
      section = header[1].toUpperCase();
      continue;
    }
    if (!line.trim() || line.startsWith('#')) continue;
    if (section === 'ATOM') {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const element = elementFromTriposType(parts[5]);
      if (!element) {
        throw new FormatError(`MOL2 atom ${parts[0]} has an unrecognised type "${parts[5]}".`);
      }
      const atom = { id: Number(parts[0]), element, x: number(parts[2]), y: number(parts[3]), z: number(parts[4]), charge: number(parts[8]) };
      if (atom.x === null || atom.y === null || atom.z === null) {
        throw new FormatError(`MOL2 atom ${parts[0]} has unreadable coordinates.`);
      }
      byId.set(atom.id, atoms.length + 1);
      atoms.push(atom);
    } else if (section === 'BOND') {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const a = byId.get(Number(parts[1]));
      const b = byId.get(Number(parts[2]));
      const type = parts[3].toLowerCase();
      if (!a || !b || a === b) {
        warnings.push(`MOL2 bond ${parts[0]} refers to atoms that are not in the atom block; it was dropped.`);
        continue;
      }
      const order = MOL2_BOND_ORDER[type];
      if (order === undefined) {
        unknownBonds += 1;
      }
      bonds.push({ a, b, order: order ?? 1 });
      if (type === 'du' || type === 'un' || type === 'nc') unknownBonds += 0;
    }
  }

  if (atoms.length === 0) throw new FormatError('The MOL2 atom block is empty.');
  if (declaredAtoms && declaredAtoms !== atoms.length) {
    warnings.push(`The header declares ${declaredAtoms} atoms; ${atoms.length} were read.`);
  }
  if (declaredBonds && declaredBonds !== bonds.length) {
    warnings.push(`The header declares ${declaredBonds} bonds; ${bonds.length} were read.`);
  }
  if (unknownBonds > 0) warnings.push(`${unknownBonds} bond${unknownBonds === 1 ? '' : 's'} of unknown type were kept as single.`);

  // Total charge: only when the atom charges sum to an integer within rounding,
  // otherwise leaving it at 0 with a warning is more honest than guessing.
  const charges = atoms.map((atom) => atom.charge).filter((value) => value !== null);
  let charge = 0;
  if (charges.length === atoms.length) {
    const sum = charges.reduce((total, value) => total + value, 0);
    if (Math.abs(sum - Math.round(sum)) <= 0.05) charge = Math.round(sum);
    else warnings.push(`Atom charges sum to ${sum.toFixed(3)}, which is not an integer; the total charge is left at 0.`);
  } else if (charges.length > 0) {
    warnings.push(`Only ${charges.length} of ${atoms.length} atoms carry a charge; the total charge is left at 0.`);
  }

  return {
    atoms: atoms.map((atom) => ({ element: atom.element, x: atom.x, y: atom.y, z: atom.z })),
    bonds,
    charge,
    multiplicity: 1,
    name: name || moleculeName,
    warnings,
  };
}

/* ── RDKit cJSON ──────────────────────────────────────────── */

/**
 * RDKit's `Chem.Mol.ToJSON()` output: atoms with elements, bonds with indices
 * and orders, and a conformer holding flat xyz triples. Lossless, so the
 * topology is carried straight through.
 */
export function parseCjson(text, { name = '' } = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new FormatError('The file is not valid JSON.');
  }
  const molecule = data?.molecule ?? data;
  const atoms = Array.isArray(molecule?.atoms) ? molecule.atoms : null;
  if (!atoms || atoms.length === 0) throw new FormatError('The cJSON has no atoms.');
  if (atoms.length > MAX_ATOMS) throw new FormatError(`The structure has ${atoms.length} atoms; the limit is ${MAX_ATOMS}.`);
  const positions = molecule?.conformer?.position;
  if (!Array.isArray(positions) || positions.length < atoms.length * 3) {
    throw new FormatError('The cJSON has no conformer with 3D positions; a 2D depiction cannot be used as a geometry.');
  }
  const bonds = Array.isArray(molecule?.bonds)
    ? molecule.bonds
      .filter((bond) => Number.isInteger(bond?.aid1) && Number.isInteger(bond?.aid2))
      .map((bond) => ({ a: bond.aid1 + 1, b: bond.aid2 + 1, order: Number(bond.order) === 2 ? 2 : Number(bond.order) === 3 ? 3 : Number(bond.order) === 1.5 ? 1.5 : 1 }))
    : [];
  // Issue 273: a cclib sidecar writes the program/version/method and the final
  // energy alongside the Avogadro molecule. Keep them on the imported record;
  // the native parsers never populate these keys.
  const energy = Number(data?.properties?.energy?.total);
  const origin = data?.origin && typeof data.origin === 'object' && !Array.isArray(data.origin)
    ? {
      program: String(data.origin.program || '').trim(),
      version: String(data.origin.version || '').trim(),
      method: String(data.origin.method || '').trim(),
      basis: String(data.origin.basis || '').trim(),
      cclibVersion: String(data.origin.cclibVersion || '').trim(),
      source: String(data.origin.source || '').trim(),
      sourceSha256: String(data.origin.sourceSha256 || '').trim(),
    }
    : null;
  return {
    atoms: atoms.map((atom, index) => ({
      element: String(atom?.element ?? ''),
      x: positions[index * 3],
      y: positions[index * 3 + 1],
      z: positions[index * 3 + 2],
    })),
    bonds,
    charge: Number.isFinite(molecule?.formalCharge) ? molecule.formalCharge : 0,
    multiplicity: 1,
    name,
    warnings: [],
    ...(Number.isFinite(energy) ? { energyHartree: energy } : {}),
    ...(origin ? { origin } : {}),
  };
}

/* ── Gaussian log frames ──────────────────────────────────── */

/**
 * Frames from a Gaussian output, so a geometry already on disk can become the
 * project molecule. The frames come from `parseTrajectory`, i.e. from the same
 * reader the results panel uses — one definition of "a geometry in this log".
 */
export function logFrames(steps, { name = '' } = {}) {
  if (!Array.isArray(steps) || steps.length === 0) return [];
  return steps.map((step, index) => ({
    atoms: step.atoms.map((atom) => ({ element: atom.element, x: atom.x, y: atom.y, z: atom.z })),
    charge: 0,
    multiplicity: 1,
    name: `${name} frame ${index + 1}/${steps.length}`.trim(),
    warnings: step.energyHartree === null || step.energyHartree === undefined
      ? ['This frame has no preceding SCF energy in the log.']
      : [],
  }));
}
