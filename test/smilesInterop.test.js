import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  SmilesError,
  describeSmilesGraph,
  parseSmiles,
  parseSmilesList,
} from '../src/shared/interop/index.js';
import { parseStructure, parseStructureRecords } from '../src/shared/structureImport.js';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'bin', 'ncs.js');

async function ncs(args) {
  try {
    const result = await run(process.execPath, [cli, ...args], { cwd: root });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

/**
 * The reference values here are formulas a chemist can check by hand, not
 * values this reader produced. That is the point: a parser tested against its
 * own output proves only that it is consistent.
 */
describe('SMILES — the graph, not a geometry', () => {
  it('reads ethanol as C2H6O with three heavy atoms and two bonds', () => {
    const graph = parseSmiles('CCO');
    expect(graph.formula).toBe('C2H6O');
    expect(graph.atoms.map((atom) => [atom.element, atom.hydrogens])).toEqual([['C', 3], ['C', 2], ['O', 1]]);
    expect(graph.bonds).toEqual([{ a: 1, b: 2, order: 1 }, { a: 2, b: 3, order: 1 }]);
    expect(graph.charge).toBe(0);
    expect(graph.multiplicity).toBe(1);
    // Not one coordinate anywhere: the reader has nothing to invent them from.
    expect(graph.atoms.every((atom) => atom.x === undefined)).toBe(true);
  });

  it('counts hydrogens that the string does not write', () => {
    expect(parseSmiles('C').formula).toBe('CH4');
    expect(parseSmiles('N').formula).toBe('H3N');
    expect(parseSmiles('S').formula).toBe('H2S');
    expect(parseSmiles('P').formula).toBe('H3P');
  });

  it('reads paracetamol (a real database string) as C8H9NO2', () => {
    // PubChem CID 1983, "CC(=O)Nc1ccc(O)cc1".
    const graph = parseSmiles('CC(=O)Nc1ccc(O)cc1');
    expect(graph.formula).toBe('C8H9NO2');
    expect(graph.atoms).toHaveLength(11);
    expect(graph.bonds).toHaveLength(11);
    expect(graph.atoms.filter((atom) => atom.aromatic)).toHaveLength(6);
  });

  it('reads the acetate anion and the ammonium cation with their charges', () => {
    const acetate = parseSmiles('CC(=O)[O-]');
    expect(acetate.formula).toBe('C2H3O2');
    expect(acetate.charge).toBe(-1);
    expect(acetate.multiplicity).toBe(1);
    const ammonium = parseSmiles('C[NH3+]');
    expect(ammonium.formula).toBe('CH6N');
    expect(ammonium.charge).toBe(1);
    expect(ammonium.electrons).toBe(18);
  });
});

describe('SMILES — aromaticity is carried, never invented', () => {
  it('keeps benzene aromatic instead of assigning Kekulé double bonds', () => {
    const graph = parseSmiles('c1ccccc1');
    expect(graph.formula).toBe('C6H6');
    expect(graph.bonds).toHaveLength(6);
    expect(graph.bonds.every((bond) => bond.order === 1.5)).toBe(true);
    // One hydrogen per aromatic carbon is the benzine answer; a Kekulé guess
    // would put 0 on two of them and 1 on the other four.
    expect(graph.atoms.map((atom) => atom.hydrogens)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('gives pyridine nitrogen no hydrogen and pyrrole nitrogen the written one', () => {
    const pyridine = parseSmiles('c1ccncc1');
    expect(pyridine.formula).toBe('C5H5N');
    expect(pyridine.atoms[3]).toMatchObject({ element: 'N', aromatic: true, hydrogens: 0 });

    const pyrrole = parseSmiles('c1cc[nH]c1');
    expect(pyrrole.formula).toBe('C4H5N');
    expect(pyrrole.atoms[3]).toMatchObject({ element: 'N', aromatic: true, hydrogens: 1 });
  });

  it('reads furan, thiophene and naphthalene by the same rule', () => {
    expect(parseSmiles('c1ccoc1').formula).toBe('C4H4O');
    expect(parseSmiles('c1ccsc1').formula).toBe('C4H4S');
    const naphthalene = parseSmiles('c1ccc2ccccc2c1');
    expect(naphthalene.formula).toBe('C10H8');
    expect(naphthalene.bonds).toHaveLength(11);
  });

  it('accepts the Kekulé spelling of the same molecule as an explicit alternative', () => {
    const kekule = parseSmiles('C1=CC=CC=C1');
    expect(kekule.formula).toBe('C6H6');
    expect(kekule.bonds.filter((bond) => bond.order === 2)).toHaveLength(3);
    expect(kekule.atoms.every((atom) => atom.aromatic === false)).toBe(true);
  });

  it('refuses aromatic boron by name rather than guessing its pi electron', () => {
    expect(() => parseSmiles('c1ccbc1')).toThrow(/Aromatic "b" has no valence model/);
  });
});

describe('SMILES — topology', () => {
  it('reads nested branches and ring closures', () => {
    const graph = parseSmiles('CC(C)(C)O');
    expect(graph.formula).toBe('C4H10O');
    expect(graph.atoms).toHaveLength(5);
    expect(graph.bonds).toHaveLength(4);
  });

  it('reads a two-digit %nn ring closure', () => {
    const graph = parseSmiles('C%10CCCCC%10');
    expect(graph.atoms).toHaveLength(6);
    expect(graph.bonds).toHaveLength(6);
    expect(graph.bonds.at(-1)).toEqual({ a: 1, b: 6, order: 1 });
  });

  it('reads two components separated by a dot', () => {
    const graph = parseSmiles('CC.CC');
    expect(graph.formula).toBe('C4H12');
    expect(graph.bonds).toHaveLength(2);
  });

  it('reads sulfur in its sulfoxide and sulfone valences', () => {
    expect(parseSmiles('CS(C)=O').formula).toBe('C2H6OS');
    expect(parseSmiles('CS(=O)(=O)C').formula).toBe('C2H6O2S');
  });
});

describe('SMILES — refusals name the token and the position', () => {
  const cases = [
    ['C[C@H](O)C', /Stereochemistry \(@\)/, 4],
    ['C[C@@H](O)C', /Stereochemistry \(@@\)/, 4],
    ['F/C=C/F', /Cis\/trans bond direction/, 2],
    ['[13CH4]', /Isotopes are not supported/, 2],
    ['[Na+].[Cl-]', /"Na" is outside the organic subset/, 2],
    ['C[Si](C)(C)C', /"Si" is outside the organic subset/, 3],
    ['C*', /SMARTS operator/, 2],
    ['CC~CC', /SMARTS operator/, 3],
    ['[S+2]', /charge of \+2/, 3],
    ['C1CC', /Ring closure 1 is opened but never closed/, 2],
    ['C(C', /branch is never closed/, 3],
    ['C()', /branch contains no atom/, 3],
    ['C(C)(C)(C)(C)C', /C \(atom 1\) is written with 5 bonds/, null],
  ];
  it.each(cases)('refuses %s', (smiles, pattern, position) => {
    let error = null;
    try {
      parseSmiles(smiles);
    } catch (caught) {
      error = caught;
    }
    expect(error instanceof SmilesError, `expected a SmilesError for ${smiles}`).toBe(true);
    expect(error.message).toMatch(pattern);
    if (position !== null) expect(error.message).toMatch(new RegExp(`at character ${position}\\b`));
  });

  it('refuses an empty string', () => {
    expect(() => parseSmiles('')).toThrow(/empty/);
  });

  it('warns that a bracket atom is a radical instead of guessing a spin state', () => {
    const graph = parseSmiles('[CH3]');
    expect(graph.multiplicity).toBe(2);
    expect(graph.warnings.join(' ')).toMatch(/radical or a carbene/);
  });
});

describe('SMILES — a .smi list', () => {
  const text = [
    '# ligands for a docking run',
    'CCO ethanol',
    'c1ccccc1 benzene',
    '[Na+].[Cl-] salt',
    '',
  ].join('\n');

  it('keeps the lines that parse and reports the line that does not', () => {
    const { records } = parseSmilesList(text);
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ name: 'ethanol', formula: 'C2H6O', line: 2 });
    expect(records[1]).toMatchObject({ name: 'benzene', formula: 'C6H6', line: 3 });
    expect(records[2].error).toMatch(/Line 4: .*"Na" is outside the organic subset/);
  });

  it('describes a graph in one line, for a refusal or a CLI report', () => {
    expect(describeSmilesGraph(parseSmiles('c1ccccc1')))
      .toBe('C6H6 · 6 atoms · 6 bonds · charge 0');
  });
});

describe('SMILES in the structure importer — refused as a geometry, by name', () => {
  it('refuses a .smi list with what it read, not "unrecognised"', () => {
    // The message used to be "carries no coordinates" and nothing else; it now
    // says which molecule it read and why the app cannot use it (#148).
    expect(() => parseStructure('CCO\nc1ccccc1\n', { filename: 'ligands.smi' }))
      .toThrow(/no coordinates/);
    expect(() => parseStructure('CCO\nc1ccccc1\n', { filename: 'ligands.smi' }))
      .toThrow(/2 structures; the first is C2H6O/);
  });

  it('refuses a .smiles file by naming the molecule and the remedy', () => {
    let message = '';
    try {
      parseStructure('c1ccccc1\n', { filename: 'benzene.smiles' });
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain('C6H6 · 6 atoms · 6 bonds · charge 0');
    expect(message).toContain('no coordinates');
    expect(message).toContain('geometry.dimension');
    // The remedy is an embedder, and the message names real ones.
    expect(message).toMatch(/--gen3d|RDKit|crest/);
  });

  it('names the unsupported token when the SMILES is outside the subset', () => {
    expect(() => parseStructure('[Na+].[Cl-]', { filename: 'salt.smiles' }))
      .toThrow(/could not be read as SMILES: "Na" is outside the organic subset/);
  });

  it('refuses through parseStructureRecords too, so a picker cannot offer it', () => {
    expect(() => parseStructureRecords('CCO\n', { filename: 'ligands.smi' })).toThrow(/no coordinates/);
  });
});

describe('ncs smiles', () => {
  it('prints the graph of a string as a formula line', async () => {
    const result = await ncs(['smiles', 'c1ccccc1']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('C6H6 · 6 atoms · 6 bonds · charge 0 · multiplicity 1');
  });

  it('prints the graph as JSON with atoms, bonds and hydrogens', async () => {
    const result = await ncs(['smiles', 'CC(=O)[O-]', '--json']);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.records[0]).toMatchObject({ formula: 'C2H3O2', charge: -1, multiplicity: 1 });
    expect(payload.records[0].bonds).toEqual([{ a: 1, b: 2, order: 1 }, { a: 2, b: 3, order: 2 }, { a: 2, b: 4, order: 1 }]);
    expect(payload.note).toMatch(/no coordinates/);
  });

  it('reads a .smi file and exits 0 when every line parses', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ncs-smiles-'));
    const file = path.join(dir, 'ligands.smi');
    await writeFile(file, 'CCO ethanol\nc1ccccc1 benzene\n', 'utf8');
    const result = await ncs(['smiles', file, '--json', '--out', path.join(dir, 'graph.json')]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(await readFile(path.join(dir, 'graph.json'), 'utf8'));
    expect(payload.records.map((record) => record.name)).toEqual(['ethanol', 'benzene']);
  });

  it('exits 2 and names the token for a string outside the subset', async () => {
    const result = await ncs(['smiles', 'C[C@H](O)C']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Stereochemistry \(@\) is not supported/);
    expect(result.stderr).toMatch(/"ok": false/);
    expect(result.stderr).toMatch(/"code": "smiles-invalid"/);
  });
});
