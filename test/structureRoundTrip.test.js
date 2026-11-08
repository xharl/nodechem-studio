import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStructure } from '../src/shared/structureImport.js';
import { validateProject } from '../src/shared/projectSchema.js';
import { templateProject } from '../src/shared/templates.js';
import { buildRunInput } from '../src/shared/workflowTasks.js';

/**
 * Criterion 6 of #79: a geometry imported in any format must round-trip
 * through both engine input builders with the coordinates it was imported with.
 * The check is on the text the builders produce — the same bytes the runner
 * writes to disk — not on the in-memory atoms.
 */

function projectWithStructure(structure, engine) {
  const project = templateProject('opt-freq');
  project.molecule.coords = structure.atoms.map((atom) => ({ element: atom.element, x: atom.x, y: atom.y, z: atom.z }));
  project.molecule.geometry = { source: 'imported', file: 'fixture', format: structure.format };
  project.molecule.charge = structure.charge;
  project.molecule.multiplicity = structure.multiplicity;
  if (structure.bonds?.length) project.molecule.bonds = structure.bonds.map((bond) => ({ ...bond }));
  project.defaults.engine = engine;
  const node = project.nodes.find((item) => item.type === 'calc');
  // Charge and multiplicity are per-block settings; the molecule carries the
  // project-wide values the block snapshots.
  node.engine = engine;
  node.settings.engine = engine;
  node.settings.charge = structure.charge;
  node.settings.multiplicity = structure.multiplicity;
  return { project, node };
}

/** The atom lines of a Gaussian input: the last block of element + 3 numbers. */
function gaussianAtoms(inputText) {
  const lines = inputText.split(/\r\n|\n|\r/);
  const atoms = [];
  for (const line of lines) {
    const match = line.trim().match(/^([A-Z][a-z]?)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)$/);
    if (match) atoms.push({ element: match[1], x: Number(match[2]), y: Number(match[3]), z: Number(match[4]) });
  }
  return atoms;
}

/** xTB takes the same .xyz body: count line, comment, then element + 3 numbers. */
function xtbAtoms(inputText) {
  const lines = inputText.split(/\r\n|\n|\r/).filter((line) => line.trim() !== '');
  const count = Number(lines[0]);
  return lines.slice(2, 2 + count).map((line) => {
    const parts = line.trim().split(/\s+/);
    return { element: parts[0], x: Number(parts[1]), y: Number(parts[2]), z: Number(parts[3]) };
  });
}

const FIXTURES = [
  ['1crn.pdb', 'PDB'],
  ['rdkit-noxide.mol2', 'MOL2'],
  ['vina-1iep-ligand.pdbqt', 'PDBQT'],
  ['pubchem-5molecules.sdf', 'SDF'],
];

describe.each(FIXTURES)('%s round-trips through both engine builders', (file, label) => {
  const structure = parseStructure(readFileSync(`test/fixtures/structures/${file}`, 'utf8'), { filename: file });

  it('builds a Gaussian input whose coordinates match the import', () => {
    const { project, node } = projectWithStructure(structure, 'gaussian');
    expect(validateProject(project).errors).toEqual([]);
    const built = buildRunInput(project, node);
    const atoms = gaussianAtoms(built.inputText);
    expect(atoms).toHaveLength(structure.atoms.length);
    structure.atoms.forEach((atom, index) => {
      expect(atoms[index].element).toBe(atom.element);
      expect(atoms[index].x).toBeCloseTo(atom.x, 4);
      expect(atoms[index].y).toBeCloseTo(atom.y, 4);
      expect(atoms[index].z).toBeCloseTo(atom.z, 4);
    });
  });

  it('builds an xTB input whose coordinates match the import', () => {
    const { project, node } = projectWithStructure(structure, 'xtb');
    expect(validateProject(project).errors).toEqual([]);
    const built = buildRunInput(project, node);
    const atoms = xtbAtoms(built.inputText);
    expect(atoms).toHaveLength(structure.atoms.length);
    structure.atoms.forEach((atom, index) => {
      expect(atoms[index].element).toBe(atom.element);
      expect(atoms[index].x).toBeCloseTo(atom.x, 4);
      expect(atoms[index].y).toBeCloseTo(atom.y, 4);
      expect(atoms[index].z).toBeCloseTo(atom.z, 4);
    });
  });

  it(`carries the declared charge and multiplicity into the route (${label})`, () => {
    const { project, node } = projectWithStructure(structure, 'gaussian');
    const built = buildRunInput(project, node);
    expect(built.inputText).toContain(`${structure.charge} ${structure.multiplicity}`);
  });
});
