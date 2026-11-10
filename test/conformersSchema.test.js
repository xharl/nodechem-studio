import { describe, expect, it } from 'vitest';
import {
  parseProjectText,
  stringifyProject,
  validateProject,
} from '../src/shared/projectSchema.js';

const molecule = {
  charge: 0,
  multiplicity: 1,
  fragments: [],
  coords: [
    { element: 'O', x: 0, y: 0, z: 0 },
    { element: 'H', x: 0.96, y: 0, z: 0 },
    { element: 'H', x: -0.24, y: 0.93, z: 0 },
  ],
};

const project = (nodes, edges = []) => ({
  schemaVersion: 3,
  name: 'Conformer test',
  molecule: { ...molecule, geometry: { source: 'imported', file: 'water.xyz', format: 'xyz' } },
  defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
  nodes,
  edges,
});

const ensembleInput = (overrides = {}) => ({
  id: 'ens1',
  type: 'input',
  kind: 'Ensemble input',
  title: 'Imported ensemble',
  state: 'ready',
  x: 0,
  y: 0,
  input: {
    kind: 'ensemble',
    path: 'conf.xyz',
    format: 'xyz',
    energyUnit: 'hartree',
    energyMethod: '',
    origin: { program: '', version: '', method: '' },
  },
  ...overrides,
});

const conformersNode = (overrides = {}) => ({
  id: 'conf1',
  type: 'generate',
  title: 'Conformer ensemble',
  state: 'ready',
  x: 40,
  y: 60,
  settings: {},
  output: null,
  ...overrides,
});

describe('conformers node schema', () => {
  it('accepts a minimal conformer block and fills the documented defaults', () => {
    const result = validateProject(project([conformersNode()]));
    expect(result.ok).toBe(true);
    const node = result.project.nodes[0];
    expect(node.type).toBe('generate');
    expect(node.kind).toBe('Generate');
    expect(node.settings.source).toBe('search');
    expect(node.settings.generator).toBe('crest');
    expect(node.settings.method).toBe('gfn2');
    expect(node.settings.energyWindowKcal).toBe(10);
    expect(node.settings.rmsdThreshold).toBe(0.5);
    expect(node.settings.maxConformers).toBe(20);
    expect(node.settings.temperature).toBeCloseTo(298.15, 2);
    expect(node.settings.spreadThresholdKcal).toBe(2);
    expect(node.settings.selectedConformerId).toBe('');
  });

  it('rejects a selected id that is not a conformer id', () => {
    const result = validateProject(project([conformersNode({ settings: { selectedConformerId: 'second' } })]));
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /selectedConformerId/.test(error.path))).toBe(true);
  });

  it('accepts an ensemble input and wires it to an imported generate block', () => {
    const result = validateProject(project(
      [ensembleInput(), conformersNode({ settings: { source: 'imported' } })],
      [{ from: 'ens1', to: 'conf1', type: 'dependency' }],
    ));
    expect(result.ok).toBe(true);
    const input = result.project.nodes.find((node) => node.type === 'input');
    expect(input.kind).toBe('Ensemble input');
    expect(input.input.kind).toBe('ensemble');
    expect(result.project.nodes.find((node) => node.type === 'generate').settings.source).toBe('imported');
  });

  it('refuses an imported generate block with no ensemble input wired', () => {
    const result = validateProject(project([conformersNode({ settings: { source: 'imported' } })]));
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /settings\.source/.test(error.path))).toBe(true);
  });

  it('clamps settings into their documented ranges', () => {
    const result = validateProject(project([conformersNode({
      settings: { maxConformers: 5000, rmsdThreshold: 0, temperature: 0 },
    })]));
    expect(result.ok).toBe(false);
    const node = validateProject(project([conformersNode({
      settings: { maxConformers: 200, rmsdThreshold: 0.01, temperature: 1 },
    })])).project.nodes[0];
    expect(node.settings.maxConformers).toBe(200);
    expect(node.settings.rmsdThreshold).toBeCloseTo(0.01, 6);
    expect(node.settings.temperature).toBe(1);
  });

  it('round-trips an ensemble summary byte-stably', () => {
    const output = {
      generator: 'crest',
      method: 'gfn2',
      count: 2,
      total: 3,
      spreadKcal: 2.4,
      generatedAt: '2026-11-08T00:00:00.000Z',
      selectedId: 'c1',
      requiresSelection: false,
      autoSelected: true,
      protomers: [],
      pruned: { energy: 1, rmsd: 0, count: 0 },
      warnings: [{ id: 'conformer-spread', status: 'warn', message: 'Wide ensemble.' }],
      members: [
        { id: 'c1', rank: 1, energyEh: -76.4, relativeKcal: 0, population: 0.9, rmsdToLowest: 0, protomer: '', kept: true, dropped: null },
        { id: 'c2', rank: 2, energyEh: -76.396, relativeKcal: 2.4, population: 0.1, rmsdToLowest: 1.2, protomer: '', kept: true, dropped: null },
      ],
      selected: { id: 'c1', energyEh: -76.4, relativeKcal: 0, population: 0.9, protomer: '', atoms: molecule.coords },
    };
    const once = validateProject(project([conformersNode({ output })]));
    expect(once.ok).toBe(true);
    const text = stringifyProject(once.project).text;
    const twice = parseProjectText(text);
    expect(twice.ok).toBe(true);
    expect(stringifyProject(twice.project).text).toBe(text);
    expect(twice.project.nodes[0].output.selected.atoms).toHaveLength(3);
  });

  it('keeps the geometry of every kept member through a save and reload', () => {
    const output = {
      count: 2,
      total: 3,
      selectedId: 'c2',
      members: [
        { id: 'c1', rank: 1, energyEh: -76.4, relativeKcal: 0, population: 0.4, rmsdToLowest: 0, kept: true, dropped: null, atoms: molecule.coords },
        { id: 'c2', rank: 2, energyEh: -76.396, relativeKcal: 2.4, population: 0.6, rmsdToLowest: 0.8, kept: true, dropped: null, atoms: molecule.coords.map((atom, index) => (index === 1 ? { ...atom, x: 1.4 } : atom)) },
        { id: 'c3', rank: 3, energyEh: -76.39, relativeKcal: 6.2, population: 0, rmsdToLowest: 2.1, kept: false, dropped: 'energy', atoms: [] },
      ],
      selected: { id: 'c2', atoms: molecule.coords.map((atom, index) => (index === 1 ? { ...atom, x: 1.4 } : atom)) },
    };
    const once = validateProject(project([conformersNode({ output })]));
    expect(once.ok).toBe(true);
    const twice = parseProjectText(stringifyProject(once.project).text);
    expect(twice.ok).toBe(true);
    const reloaded = twice.project.nodes[0].output;
    expect(reloaded.members[1].atoms[1].x).toBeCloseTo(1.4, 6);
    expect(reloaded.members[0].atoms).toHaveLength(3);
    expect(reloaded.members[2].atoms).toEqual([]);
    expect(reloaded.selectedId).toBe('c2');
  });

  it('rejects an unknown element in the selected geometry', () => {
    const output = {
      count: 1,
      members: [],
      selected: { id: 'c1', atoms: [{ element: 'Xx', x: 0, y: 0, z: 0 }] },
    };
    const result = validateProject(project([conformersNode({ output })]));
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /selected\.atoms/.test(error.path))).toBe(true);
  });

  it('drops an unknown setting with a warning instead of crashing', () => {
    const result = validateProject(project([conformersNode({ settings: { crsestFlags: '--quick' } })]));
    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => /crsestFlags/.test(warning.path))).toBe(true);
  });

  it('defaults fan-out off, so a project written before the switch keeps loading', () => {
    const result = validateProject(project([conformersNode()]));
    expect(result.ok).toBe(true);
    expect(result.project.nodes[0].settings.fanOut).toBe(false);
    const text = stringifyProject(result.project).text;
    const reloaded = parseProjectText(text);
    expect(reloaded.ok).toBe(true);
    expect(reloaded.project.nodes[0].settings.fanOut).toBe(false);
  });

  it('keeps an explicit fan-out switch through a save and reload', () => {
    const result = validateProject(project([conformersNode({ settings: { fanOut: true } })]));
    expect(result.ok).toBe(true);
    expect(result.project.nodes[0].settings.fanOut).toBe(true);
    const text = stringifyProject(result.project).text;
    const reloaded = parseProjectText(text);
    expect(reloaded.project.nodes[0].settings.fanOut).toBe(true);
  });

  it('rejects a fan-out value that is not a boolean', () => {
    const result = validateProject(project([conformersNode({ settings: { fanOut: 'yes' } })]));
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /fanOut/.test(error.path))).toBe(true);
  });
});

describe('issue #240: the method belongs to the generator', () => {
  const cases = [
    { generator: 'crest', method: 'gfn2', ok: true, stored: 'gfn2' },
    { generator: 'crest', method: 'gfnff', ok: true, stored: 'gfnff' },
    { generator: 'crest', method: 'MMFF94', ok: false },
    { generator: 'uff', method: 'UFF', ok: true, stored: 'UFF' },
    // The pre-#240 placeholder is migrated, not refused.
    { generator: 'uff', method: 'gfn2', ok: true, stored: 'UFF' },
    { generator: 'uff', method: 'MMFF94', ok: false },
    { generator: 'obabel', method: 'MMFF94', ok: true, stored: 'MMFF94' },
    { generator: 'obabel', method: 'MMFF94s', ok: true, stored: 'MMFF94s' },
    { generator: 'obabel', method: 'mmff94s', ok: true, stored: 'MMFF94s' },
    { generator: 'obabel', method: 'UFF', ok: true, stored: 'UFF' },
    { generator: 'obabel', method: 'gfn2', ok: true, stored: 'MMFF94' },
    { generator: 'obabel', method: 'B3LYP', ok: false },
  ];
  for (const row of cases) {
    it(`${row.generator} + ${row.method} ${row.ok ? 'is accepted' : 'is refused'}`, () => {
      const result = validateProject(project([conformersNode({
        settings: { generator: row.generator, method: row.method },
      })]));
      expect(result.ok).toBe(row.ok);
      if (row.ok) {
        expect(result.project.nodes[0].settings.method).toBe(row.stored);
      } else {
        expect(result.errors.some((error) => /settings\.method/.test(error.path))).toBe(true);
        expect(result.errors.find((error) => /settings\.method/.test(error.path))?.message)
          .toMatch(new RegExp(`when generator is "${row.generator}"`));
      }
    });
  }

  it('records MMFF94 on an obabel block and stops writing the old ff alias', () => {
    const result = validateProject(project([conformersNode({
      settings: { generator: 'obabel', method: 'MMFF94', nconf: 12 },
    })]));
    expect(result.ok).toBe(true);
    const settings = result.project.nodes[0].settings;
    expect(settings.method).toBe('MMFF94');
    expect(settings.ff).toBeUndefined();
    // One name per fact: saving and reopening does not grow a second field.
    const twice = parseProjectText(stringifyProject(result.project).text);
    expect(twice.ok).toBe(true);
    expect(twice.project.nodes[0].settings.method).toBe('MMFF94');
    expect(twice.project.nodes[0].settings.ff).toBeUndefined();
  });

  it('migrates a pre-#240 obabel block from its ff value, without erroring', () => {
    const result = validateProject(project([conformersNode({
      settings: { generator: 'obabel', method: 'gfn2', ff: 'mmff94s', nconf: 8 },
    })]));
    expect(result.ok).toBe(true);
    const settings = result.project.nodes[0].settings;
    expect(settings.method).toBe('MMFF94s');
    expect(settings.ff).toBeUndefined();
  });

  it('gives an imported block no method, whatever the file says', () => {
    const result = validateProject(project(
      [ensembleInput(), conformersNode({ settings: { source: 'imported', method: 'MMFF94' } })],
      [{ from: 'ens1', to: 'conf1', type: 'dependency' }],
    ));
    expect(result.ok).toBe(true);
    expect(result.project.nodes.find((node) => node.type === 'generate').settings.method).toBe('');
  });
});
