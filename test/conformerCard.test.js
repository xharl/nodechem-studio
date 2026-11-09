import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  conformerEnergyLabel,
  conformerOriginLabel,
  conformerOriginShort,
  conformerTableCaption,
} from '../src/shared/conformers.js';

/**
 * What the block actually says about an ensemble (#129, #130).
 *
 * The strings live in one place (`src/shared/conformers.js`) so the card, the
 * inspector and this test cannot drift apart: if the card ever prints a
 * kcal/mol ensemble as "Ha", or an imported ensemble as "computed here", one of
 * these assertions fails.
 */

const coords = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.96, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.93, z: 0 },
];

const member = (id, rank, extra = {}) => ({
  id, rank, energyEh: null, energyKcal: -120.4, energyUnit: 'kcal/mol', energyMethod: 'MMFF94',
  relativeKcal: rank === 1 ? 0 : 1.4, population: rank === 1 ? 0.94 : 0.06,
  rmsdToLowest: 0, protomer: '', kept: true, dropped: null, atoms: coords,
  ...extra,
});

const kcalEnsemble = (overrides = {}) => ({
  generator: 'import',
  method: '',
  energyUnit: 'kcal/mol',
  energyMethod: 'MMFF94',
  count: 2,
  total: 2,
  spreadKcal: 1.4,
  mixedEnergies: false,
  selectedId: 'c1',
  origin: { program: 'SyntheticGaussLike', version: '26.1 (test)', method: 'MMFF94/DLFF03 (test)', sourceSha256: 'abcdef0123456789'.repeat(4) },
  members: [member('c1', 1), member('c2', 2)],
  selected: member('c1', 1),
  ...overrides,
});

const crestEnsemble = (overrides = {}) => ({
  generator: 'crest',
  method: 'gfn2',
  energyUnit: 'hartree',
  energyMethod: 'GFN2-xTB',
  count: 2,
  total: 2,
  spreadKcal: 3.4,
  mixedEnergies: false,
  selectedId: 'c1',
  origin: { program: 'crest', version: '', method: 'gfn2', sourceSha256: '' },
  members: [member('c1', 1), member('c2', 2)],
  selected: member('c1', 1),
  ...overrides,
});

describe('an imported ensemble reads as imported, with its unit', () => {
  it('names the program, version, method and the file hash', () => {
    expect(conformerOriginLabel(kcalEnsemble())).toBe('imported · SyntheticGaussLike 26.1 (test) · MMFF94/DLFF03 (test) · sha256 abcdef012345…');
    expect(conformerOriginShort(kcalEnsemble())).toBe('imported · SyntheticGaussLike 26.1 (test)');
  });

  it('says the origin is not recorded rather than implying this app computed it', () => {
    const bare = kcalEnsemble({ origin: { program: '', version: '', method: '', sourceSha256: '' } });
    expect(conformerOriginLabel(bare)).toBe('imported · origin not recorded');
    expect(conformerOriginShort(bare)).toBe('imported · origin not recorded');
  });

  it('captions the table with kcal/mol and the method that produced it', () => {
    expect(conformerTableCaption(kcalEnsemble())).toBe('ΔE in kcal/mol · absolute energies in kcal/mol (MMFF94)');
    expect(conformerEnergyLabel(kcalEnsemble())).toBe('kcal/mol · MMFF94');
  });

  it('never labels a kcal/mol ensemble as Hartree', () => {
    const text = [conformerTableCaption(kcalEnsemble()), conformerEnergyLabel(kcalEnsemble())].join(' ');
    expect(text).not.toMatch(/\bHa\b/);
    expect(text).not.toContain('Eh');
  });
});

describe('a generated ensemble reads as computed here', () => {
  it('says CREST, and never "imported"', () => {
    expect(conformerOriginLabel(crestEnsemble())).toBe('computed here · CREST GFN2-xTB');
    expect(conformerOriginShort(crestEnsemble())).toBe('CREST GFN2-xTB');
    expect(conformerOriginLabel(crestEnsemble())).not.toMatch(/imported/);
  });

  it('captions the table as Hartree without pretending the members are in Eh', () => {
    // The table column is relative kcal/mol; the absolute energies are Hartree.
    expect(conformerTableCaption(crestEnsemble())).toBe('ΔE in kcal/mol · absolute energies in Hartree (GFN2-xTB)');
  });

  it('marks a dry-run fixture as a fixture', () => {
    const fixture = crestEnsemble({ generator: 'fixture', method: 'gfn2', origin: { program: 'fixture', version: '', method: 'gfn2', sourceSha256: '' } });
    expect(conformerOriginShort(fixture)).toBe('dry-run fixture');
    expect(conformerOriginLabel(fixture)).toMatch(/not a search/);
  });
});

describe('a mixed ensemble is flagged, not averaged', () => {
  const mixed = () => kcalEnsemble({
    mixedEnergies: true,
    spreadKcal: null,
    members: [
      { ...member('c1', 1), energyUnit: 'hartree', energyKcal: null, energyEh: -76.4, population: null },
      { ...member('c2', 2), population: null },
    ],
  });

  it('says so in the caption and in the card label', () => {
    expect(conformerTableCaption(mixed())).toBe('ΔE in kcal/mol · mixed energy units/methods — not averaged');
    expect(conformerEnergyLabel(mixed())).toBe('mixed units/methods — not averaged');
  });

  it('has no population to report', () => {
    expect(mixed().members.every((row) => row.population === null)).toBe(true);
  });
});

describe('a legacy ensemble with no unit still reads as Hartree', () => {
  it('defaults the caption to Hartree and never to kcal/mol absolute energies', () => {
    // A project saved before #130: no energyUnit, no energyMethod, no origin.
    const legacy = {
      generator: 'import', method: '', count: 1, total: 1, spreadKcal: null, selectedId: 'c1',
      members: [{ id: 'c1', rank: 1, energyEh: -76.4, relativeKcal: 0, population: 1, rmsdToLowest: 0, protomer: '', kept: true, dropped: null }],
      selected: { id: 'c1', energyEh: -76.4, relativeKcal: 0, population: 1, protomer: '' },
    };
    expect(conformerTableCaption(legacy)).toBe('ΔE in kcal/mol · absolute energies in Hartree');
    expect(conformerEnergyLabel(legacy)).toBe('Hartree · method not stated');
    expect(conformerOriginShort(legacy)).toBe('imported · origin not recorded');
  });
});

describe('the card prints the unit and keeps the origin out of the numbers', () => {
  let app;

  beforeAll(async () => {
    vi.stubGlobal('window', {
      desktop: null,
      innerWidth: 1440,
      innerHeight: 900,
      addEventListener: () => {},
    });
    vi.stubGlobal('document', {
      readyState: 'loading',
      addEventListener: () => {},
      querySelector: () => null,
    });
    app = await import('../src/renderer/app.js');
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const nodeFor = (output) => ({
    id: 'conf', type: 'generate', kind: 'Conformers', title: 'Conformer ensemble',
    state: 'ready', x: 0, y: 0, settings: { generator: output.generator }, output,
  });

  it('shows the unit and the method on the card result line', () => {
    app.state.project.nodes = [nodeFor(kcalEnsemble())];
    const facts = app.resultFacts(app.state.project.nodes[0]);
    expect(facts.main).toBe('2 of 2 kept · spread 1.40');
    expect(facts.sub).toBe('kcal/mol · MMFF94 · top 94.0%');
    expect(`${facts.main} ${facts.sub}`).not.toContain('Eh');
  });

  it('shows Hartree for a crest ensemble', () => {
    app.state.project.nodes = [nodeFor(crestEnsemble())];
    const facts = app.resultFacts(app.state.project.nodes[0]);
    expect(facts.sub).toBe('Hartree · GFN2-xTB · top 94.0%');
  });

  it('says "not averaged" instead of a population for a mixed ensemble', () => {
    const mixed = kcalEnsemble({
      mixedEnergies: true,
      spreadKcal: null,
      count: 1,
      members: [{ ...member('c1', 1), population: null }],
      selected: null,
    });
    app.state.project.nodes = [nodeFor(mixed)];
    const facts = app.resultFacts(app.state.project.nodes[0]);
    expect(facts.main).toBe('1 of 2 kept');
    expect(facts.sub).toBe('mixed units/methods — not averaged');
  });
});
