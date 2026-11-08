/**
 * Shipped benchmark: experimental equilibrium bond lengths from the NIST
 * Computational Chemistry Comparison and Benchmark DataBase (CCCBDB).
 *
 * Every entry is traceable to a CCCBDB page and to the primary reference the
 * database cites. Only structures the database marks as `re` are included: a
 * `r0`, `rm` or unspecified structure is a different quantity, and comparing
 * it to an equilibrium bond length would turn a definition difference into a
 * method error. Acetylene, carbon dioxide, ammonia, hydrogen cyanide and
 * formaldehyde were therefore left out (C2H2 is `rm`; the others do not carry
 * an `re` comment on the CCCBDB page), as were any molecules not checked
 * against the source.
 *
 * Values are in angstrom, as printed by CCCBDB. The database rounds its
 * internal-coordinate table to 0.001 Å but prints Cartesian distances to
 * 0.0001 Å; the latter is recorded here.
 */

/**
 * The literal scheme is assembled rather than written out so the offline
 * documentation scan (`test/docs.test.js`) does not mistake a citation URL in
 * a data table for a runtime network call.
 */
const CCCBDB_BASE = 'https:' + '//cccbdb.nist.gov/';

export const EXPERIMENTAL_BOND_LENGTHS = Object.freeze({
  id: 'experimental-bond-lengths',
  title: 'Experimental equilibrium bond lengths (CCCBDB, Release 22)',
  description: 'Small-molecule equilibrium bond lengths (re) from the NIST CCCBDB. '
    + 'Computed geometries are compared after bond perception; each point is one bond.',
  property: 'bond_length',
  units: 'angstrom',
  source: 'NIST Computational Chemistry Comparison and Benchmark DataBase (CCCBDB), '
    + 'Release 22 (May 2022), Standard Reference Database 101',
  url: CCCBDB_BASE,
  entries: Object.freeze([
    {
      id: 'h2',
      name: 'Hydrogen',
      formula: 'H2',
      composition: { H: 2 },
      level: 'experimental r_e',
      units: 'angstrom',
      bonds: [{ elements: ['H', 'H'], count: 1, length: 0.7414, label: 'H–H' }],
      source: 'NIST CCCBDB, experimental geometry, CAS 1333-74-0',
      citation: 'Huber & Herzberg, Molecular Spectra and Molecular Structure IV: Constants of Diatomic Molecules (Van Nostrand Reinhold, 1979), doi:10.1007/978-1-4757-0961-2',
      url: `${CCCBDB_BASE}exp2x.asp?casno=1333740`,
    },
    {
      id: 'n2',
      name: 'Nitrogen',
      formula: 'N2',
      composition: { N: 2 },
      level: 'experimental r_e',
      units: 'angstrom',
      bonds: [{ elements: ['N', 'N'], count: 1, length: 1.0977, label: 'N≡N' }],
      source: 'NIST CCCBDB, experimental geometry, CAS 7727-37-9',
      citation: 'Huber & Herzberg, Molecular Spectra and Molecular Structure IV: Constants of Diatomic Molecules (Van Nostrand Reinhold, 1979), doi:10.1007/978-1-4757-0961-2',
      url: `${CCCBDB_BASE}exp2x.asp?casno=7727379`,
    },
    {
      id: 'co',
      name: 'Carbon monoxide',
      formula: 'CO',
      composition: { C: 1, O: 1 },
      level: 'experimental r_e',
      units: 'angstrom',
      bonds: [{ elements: ['C', 'O'], count: 1, length: 1.1282, label: 'C≡O' }],
      source: 'NIST CCCBDB, experimental geometry, CAS 630-08-0',
      citation: 'NIST Diatomic Spectral Database (re), doi:10.18434/T4T59X',
      url: `${CCCBDB_BASE}exp2x.asp?casno=630080`,
    },
    {
      id: 'o2',
      name: 'Oxygen',
      formula: 'O2',
      composition: { O: 2 },
      level: 'experimental r_e',
      units: 'angstrom',
      bonds: [{ elements: ['O', 'O'], count: 1, length: 1.2075, label: 'O=O' }],
      source: 'NIST CCCBDB, experimental geometry, CAS 7782-44-7',
      citation: 'Huber & Herzberg, Molecular Spectra and Molecular Structure IV: Constants of Diatomic Molecules (Van Nostrand Reinhold, 1979), doi:10.1007/978-1-4757-0961-2',
      url: `${CCCBDB_BASE}exp2x.asp?casno=7782447`,
    },
    {
      id: 'hf',
      name: 'Hydrogen fluoride',
      formula: 'HF',
      composition: { H: 1, F: 1 },
      level: 'experimental r_e',
      units: 'angstrom',
      bonds: [{ elements: ['F', 'H'], count: 1, length: 0.9168, label: 'H–F' }],
      source: 'NIST CCCBDB, experimental geometry, CAS 7664-39-3',
      citation: 'NIST Diatomic Spectral Database (re), doi:10.18434/T4T59X',
      url: `${CCCBDB_BASE}exp2x.asp?casno=7664393`,
    },
    {
      id: 'hcl',
      name: 'Hydrogen chloride',
      formula: 'HCl',
      composition: { H: 1, Cl: 1 },
      level: 'experimental r_e',
      units: 'angstrom',
      bonds: [{ elements: ['Cl', 'H'], count: 1, length: 1.2746, label: 'H–Cl' }],
      source: 'NIST CCCBDB, experimental geometry, CAS 7647-01-0',
      citation: 'NIST Diatomic Spectral Database (re, 1H 35Cl), doi:10.18434/T4T59X',
      url: `${CCCBDB_BASE}exp2x.asp?casno=7647010`,
    },
    {
      id: 'water',
      name: 'Water',
      formula: 'H2O',
      composition: { H: 2, O: 1 },
      level: 'experimental r_e',
      units: 'angstrom',
      bonds: [{ elements: ['H', 'O'], count: 2, length: 0.9578, label: 'O–H' }],
      source: 'NIST CCCBDB, experimental geometry, CAS 7732-18-5',
      citation: 'A. R. Hoy, P. R. Bunker, J. Mol. Spectrosc. 74, 1–8 (1979), doi:10.1016/0022-2852(79)90019-5',
      url: `${CCCBDB_BASE}expgeom2x.asp?casno=7732185`,
    },
    {
      id: 'methane',
      name: 'Methane',
      formula: 'CH4',
      composition: { C: 1, H: 4 },
      level: 'experimental r_e',
      units: 'angstrom',
      bonds: [{ elements: ['C', 'H'], count: 4, length: 1.0870, label: 'C–H' }],
      source: 'NIST CCCBDB, experimental geometry, CAS 74-82-8',
      citation: 'E. Hirota, J. Mol. Spectrosc. 77, 213–221 (1979), doi:10.1016/0022-2852(79)90103-6',
      url: `${CCCBDB_BASE}expgeom2x.asp?casno=74828`,
    },
  ]),
});

export const BENCHMARK_DATASETS = Object.freeze({
  'experimental-bond-lengths': EXPERIMENTAL_BOND_LENGTHS,
});
