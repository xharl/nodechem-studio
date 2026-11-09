import { describe, it, expect } from 'vitest';
import { buildGaussianInput } from '../src/shared/gaussianInput.js';
import {
  qstKindFor,
  qstRequiredStructures,
  qstStructuresFor,
  validateQst,
} from '../src/shared/constraints.js';
import { defaultSettings, stringifyProject, validateProject } from '../src/shared/projectSchema.js';

/**
 * Issue #93 — QST2 / QST3.
 *
 * Gaussian reads one title + molecule specification per structure, in the order
 * reactant, product, initial TS, and requires the atoms to appear in the same
 * order in every structure. This suite pins:
 *
 *   - the extra structure sections and the route keyword;
 *   - the three honest refusals (missing structure, atom count, atom order);
 *   - that the extra geometries travel in the project file, so `ncs build-input`
 *     emits exactly what the app emits.
 */

const REACTANT = [
  { element: 'C', x: -0.700, y: 0.000, z: 0.000 },
  { element: 'O', x: 0.700, y: 0.000, z: 0.000 },
  { element: 'H', x: 1.000, y: 0.900, z: 0.000 },
  { element: 'H', x: -1.100, y: 0.900, z: 0.600 },
];

const PRODUCT = [
  { element: 'C', x: -0.700, y: 0.000, z: 0.000 },
  { element: 'O', x: 1.100, y: 0.000, z: 0.000 },
  { element: 'H', x: 1.700, y: 0.400, z: 0.000 },
  { element: 'H', x: -1.500, y: 0.100, z: -0.500 },
];

const TS_GUESS = [
  { element: 'C', x: -0.700, y: 0.000, z: 0.000 },
  { element: 'O', x: 0.900, y: 0.000, z: 0.000 },
  { element: 'H', x: 1.500, y: 0.700, z: 0.000 },
  { element: 'H', x: -1.300, y: 0.800, z: 0.500 },
];

const molecule = (coords = REACTANT) => ({ charge: 0, multiplicity: 1, coords });

const structure = (label, atoms) => ({ label, source: 'copy', nodeId: '', path: '', atoms });

function build(settings, overrides = {}) {
  return buildGaussianInput({
    title: 'QST search',
    settings: defaultSettings({ dispersion: '', ...settings }),
    molecule: molecule(),
    inputName: 'qst.gjf',
    ...overrides,
  });
}

describe('QST vocabulary', () => {
  it('maps only Opt=QST2 and Opt=QST3 to a search kind', () => {
    expect(qstKindFor('Opt=QST2')).toBe('QST2');
    expect(qstKindFor('Opt=QST3')).toBe('QST3');
    expect(qstKindFor('Opt=TS')).toBeNull();
    expect(qstKindFor('Opt')).toBeNull();
  });

  it('needs one extra structure for QST2 and two for QST3', () => {
    expect(qstRequiredStructures('Opt=QST2')).toBe(1);
    expect(qstRequiredStructures('Opt=QST3')).toBe(2);
    expect(qstRequiredStructures('Opt')).toBe(0);
  });

  it('returns the stored structures in order, and nothing when QST is off', () => {
    const settings = defaultSettings({
      jobType: 'Opt=QST2',
      qst: { structures: [structure('product', PRODUCT)] },
    });
    expect(qstStructuresFor(settings)).toHaveLength(1);
    expect(qstStructuresFor(defaultSettings())).toEqual([]);
  });
});

describe('QST input text', () => {
  it('writes a second title and molecule specification for Opt=QST2', () => {
    const text = build({
      jobType: 'Opt=QST2',
      qst: { structures: [structure('product', PRODUCT)] },
    });
    const route = text.split('\n').find((line) => line.startsWith('#p'));
    expect(route).toContain('Opt=QST2');
    // QST2 must not be combined with the TS option.
    expect(route).not.toMatch(/\bTS\b/);
    const sections = text.split('\n\n').filter((block) => block.trim() !== '');
    // route / title / geometry / second title / second geometry
    expect(sections).toHaveLength(5);
    expect(sections[0]).toMatch(/^%Mem=/);
    expect(sections[1]).toBe('QST search');
    expect(sections[2]).toMatch(/^0 1\nC/);
    expect(sections[3]).toBe('QST search — structure 2 (product)');
    expect(sections[4]).toMatch(/^0 1\nC\s+-0\.700000/);
    expect(sections[4].split('\n')).toHaveLength(5);
  });

  it('writes three structures for Opt=QST3 in reactant, product, TS order', () => {
    const text = build({
      jobType: 'Opt=QST3',
      qst: { structures: [structure('product', PRODUCT), structure('TS guess', TS_GUESS)] },
    });
    const route = text.split('\n').find((line) => line.startsWith('#p'));
    expect(route).toContain('Opt=QST3');
    const titles = text.split('\n').filter((line) => line.startsWith('QST search — structure'));
    expect(titles).toEqual([
      'QST search — structure 2 (product)',
      'QST search — structure 3 (TS guess)',
    ]);
    const lines = text.split('\n');
    expect(lines.filter((line) => line === '0 1')).toHaveLength(3);
    // The product's O is at x = 1.100, the TS guess's at 0.900: order is kept.
    expect(lines.some((line) => /^O\s+1\.100000/.test(line))).toBe(true);
    expect(lines.some((line) => /^O\s+0\.900000/.test(line))).toBe(true);
  });

  it('writes the ModRedundant section after every structure when constrained', () => {
    const text = build({
      jobType: 'Opt=QST2',
      constraints: [{ kind: 'bond', atoms: [1, 2] }],
      qst: { structures: [structure('product', PRODUCT)] },
    });
    const route = text.split('\n').find((line) => line.startsWith('#p'));
    expect(route).toBe('#p B3LYP/def2SVP Opt=(QST2,ModRedundant)');
    expect(text.split('\n').filter((line) => line === 'B 1 2 F')).toHaveLength(2);
  });

  it('keeps a legacy route when no QST structure is named', () => {
    const text = build({ jobType: 'Opt' }, { title: 'Optimisation' });
    expect(text).not.toContain('structure 2');
    expect(text).not.toMatch(/QST/);
  });
});

describe('QST refusals', () => {
  it('refuses Opt=QST2 without the second structure', () => {
    expect(() => build({ jobType: 'Opt=QST2' })).toThrow(/needs a second structure/);
  });

  it('refuses Opt=QST3 with only one extra structure', () => {
    expect(() => build({
      jobType: 'Opt=QST3',
      qst: { structures: [structure('product', PRODUCT)] },
    })).toThrow(/needs 2 extra structures|needs a third structure/);
  });

  it('refuses structures left on a block that is not a QST job', () => {
    expect(() => build({
      jobType: 'Opt',
      qst: { structures: [structure('product', PRODUCT)] },
    })).toThrow(/QST2|QST3/);
  });

  it('refuses an atom count that differs from the block geometry', () => {
    expect(() => build({
      jobType: 'Opt=QST2',
      qst: { structures: [structure('product', PRODUCT.slice(0, 3))] },
    })).toThrow(/4 atoms.*3 atoms|3 atoms.*4 atoms/);
  });

  it('refuses an atom order mismatch and names the first mismatching index', () => {
    const reordered = PRODUCT.map((atom) => ({ ...atom }));
    [reordered[1], reordered[2]] = [reordered[2], reordered[1]];
    expect(() => build({
      jobType: 'Opt=QST2',
      qst: { structures: [structure('product', reordered)] },
    })).toThrow(/atom 2.*H.*O|atom 2/i);
  });

  it('does not reorder anything: the error is the only outcome', () => {
    const reordered = PRODUCT.map((atom) => ({ ...atom }));
    [reordered[0], reordered[3]] = [reordered[3], reordered[0]];
    expect(() => build({
      jobType: 'Opt=QST3',
      qst: { structures: [structure('product', reordered), structure('TS guess', TS_GUESS)] },
    })).toThrow(/atom 1/);
  });

  it('refuses a checkpoint hand-off, which would replace the reactant structure', () => {
    expect(() => build(
      { jobType: 'Opt=QST2', qst: { structures: [structure('product', PRODUCT)] } },
      { oldCheckpoint: 'reactant.chk' },
    )).toThrow(/Geom=Check|hand-off/);
  });

  it('reports the same refusals through the pure validator', () => {
    const { errors } = validateQst({
      jobType: 'Opt=QST2',
      atoms: REACTANT,
      qst: { structures: [structure('product', PRODUCT.slice(0, 3))] },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/atom count|4 atoms/);
  });
});

describe('QST in the project file', () => {
  const project = (settings, coords = REACTANT) => ({
    schemaVersion: 3,
    name: 'QST',
    molecule: {
      charge: 0,
      multiplicity: 1,
      fragments: [],
      coords,
      geometry: { source: 'imported', file: 'reactant.gjf', format: 'gjf' },
    },
    defaults: { engine: 'gaussian', method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: 4 },
    runner: { maxParallel: 1 },
    datasets: [],
    flows: [{
      id: 'main',
      title: 'Workflow',
      nodes: [{
        id: 'qst-1',
        type: 'calculate',
        kind: 'TS',
        title: 'QST2 search',
        state: 'ready',
        x: 0,
        y: 0,
        settings: defaultSettings(settings),
        output: null,
        checkpointFrom: null,
      }],
      edges: [],
    }],
    reports: [],
    activeFlowId: 'main',
  });

  it('keeps the referenced structures through a save and reload', () => {
    const settings = {
      jobType: 'Opt=QST2',
      qst: { structures: [structure('product', PRODUCT)] },
    };
    const first = validateProject(project(settings));
    expect(first.ok).toBe(true);
    const saved = stringifyProject(first.project);
    expect(saved.text).toContain('"qst"');
    expect(saved.text).toContain('"product"');
    const reloaded = validateProject(JSON.parse(saved.text));
    expect(reloaded.ok).toBe(true);
    expect(reloaded.project.flows[0].nodes[0].settings.qst).toEqual(first.project.flows[0].nodes[0].settings.qst);
  });

  it('refuses a QST block whose structure does not match the project geometry', () => {
    const result = validateProject(project({
      jobType: 'Opt=QST2',
      qst: { structures: [structure('product', PRODUCT.slice(0, 3))] },
    }), REACTANT);
    expect(result.ok).toBe(false);
    expect(result.errors.some((entry) => entry.path.endsWith('settings.qst.structures[0]'))).toBe(true);
  });

  it('emits exactly what the app would emit for the same saved file', () => {
    const settings = {
      jobType: 'Opt=QST2',
      qst: { structures: [structure('product', PRODUCT)] },
    };
    const result = validateProject(project(settings));
    const node = result.project.flows[0].nodes[0];
    const fromApp = buildGaussianInput({
      title: node.title,
      settings: node.settings,
      molecule: result.project.molecule,
      inputName: 'qst_1.gjf',
    });
    const fromSaved = buildGaussianInput({
      title: node.title,
      settings: validateProject(JSON.parse(stringifyProject(result.project).text)).project.flows[0].nodes[0].settings,
      molecule: result.project.molecule,
      inputName: 'qst_1.gjf',
    });
    expect(fromSaved).toBe(fromApp);
  });
});
