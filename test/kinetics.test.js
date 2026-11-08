import { describe, expect, it } from 'vitest';
import {
  arrheniusFit,
  buildKinetics,
  fragmentCount,
  kineticsSummary,
  kineticsSummaryLine,
  molecularityOf,
  temperatureTable,
  unitsForMolecularity,
} from '../src/shared/kinetics.js';

const kcal = (value) => ({ thermochemistry: { freeEnergyHartree: value / 627.5095 } });

describe('molecularity from the reaction definition', () => {
  it('reads one declared fragment as unimolecular and two as bimolecular', () => {
    expect(molecularityOf({ reactant: { fragments: ['CCO'] } })).toMatchObject({
      value: 1,
      units: 's⁻¹',
    });
    expect(molecularityOf({ reactant: { fragments: ['CC(=O)O', 'O'] } })).toMatchObject({
      value: 2,
      units: 'M⁻¹s⁻¹',
    });
  });

  it('counts atom fragment labels when no fragment strings are declared', () => {
    const reactant = { coords: [{ fragment: 1 }, { fragment: 1 }, { fragment: 2 }] };
    expect(molecularityOf({ reactant })).toMatchObject({ value: 2, basis: 'atom fragment labels' });
  });

  it('refuses to guess when the reactant block declares nothing', () => {
    const result = molecularityOf({ reactant: { coords: [] } });
    expect(result.value).toBeNull();
    expect(result.units).toBeNull();
    expect(result.reason).toMatch(/reactant block does not declare/);
  });

  it('does not take the transition-state fragment count as the reactant side', () => {
    const result = molecularityOf({
      reactant: { fragments: [] },
      transitionState: { fragments: ['A', 'B'] },
    });
    expect(result.value).toBeNull();
    expect(result.reason).toMatch(/reactant/);
  });

  it('names the unit for each supported order and refuses a third fragment', () => {
    expect(unitsForMolecularity(1)).toBe('s⁻¹');
    expect(unitsForMolecularity(2)).toBe('M⁻¹s⁻¹');
    expect(unitsForMolecularity(3)).toBeNull();
    expect(molecularityOf({ reactant: { fragments: ['A', 'B', 'C'] } })).toMatchObject({
      value: null,
    });
  });

  it('counts fragments on a project molecule', () => {
    expect(fragmentCount({ fragments: ['CCO'], coords: [] })).toBe(1);
    expect(fragmentCount({ fragments: [], coords: [{ fragment: 1 }, { fragment: 2 }] })).toBe(2);
    expect(fragmentCount({ fragments: [], coords: [{ element: 'O' }] })).toBe(1);
    expect(fragmentCount({})).toBeNull();
  });
});

describe('Eyring rate with units', () => {
  const unimolecular = buildKinetics({
    deltaGkcal: 20,
    temperatureK: 298.15,
    molecularity: { value: 1, basis: 'reactant fragments' },
  });

  it('computes k at the run temperature, in s⁻¹', () => {
    expect(unimolecular.available).toBe(true);
    expect(unimolecular.k).toBeCloseTo(0.01358815, 8);
    expect(unimolecular.units).toBe('s⁻¹');
    expect(unimolecular.kText).toBe('1.36 × 10⁻² s⁻¹');
  });

  it('reports the half-life of a first-order rate only', () => {
    expect(unimolecular.halfLifeSeconds).toBeCloseTo(Math.LN2 / 0.013588150039420967, 9);
    expect(unimolecular.halfLifeText).toBe('51.0 s');
    const bimolecular = buildKinetics({
      deltaGkcal: 20,
      temperatureK: 298.15,
      molecularity: { value: 2, basis: 'reactant fragments' },
    });
    expect(bimolecular.units).toBe('M⁻¹s⁻¹');
    expect(bimolecular.halfLifeSeconds).toBeNull();
    expect(bimolecular.halfLifeText).toBe('not applicable (bimolecular rate depends on concentration)');
  });

  it('prints the ΔG‡ it came from and every provenance field', () => {
    const report = buildKinetics({
      deltaGkcal: 20,
      deltaGLabel: 'G(TS) − G(reactant)',
      freeEnergyKey: 'Sum of electronic and thermal Free Energies',
      zpeIncluded: true,
      thermalIncluded: true,
      temperatureK: 298.15,
      molecularity: { value: 1, basis: 'reactant fragments' },
    });
    expect(report.deltaG.kcalPerMol).toBe(20);
    expect(report.provenance.deltaG.label).toBe('G(TS) − G(reactant)');
    expect(report.provenance.corrections).toMatchObject({ zpe: true, thermal: true });
    expect(report.provenance.temperature).toMatchObject({ kelvin: 298.15, assumed: false });
    expect(report.assumptions.join(' ')).toMatch(/transmission coefficient 1/i);
  });

  it('renders not reported, never zero, when eyringRate refuses', () => {
    const report = buildKinetics({
      deltaGkcal: Number.NaN,
      temperatureK: 298.15,
      molecularity: { value: 1, basis: 'reactant fragments' },
    });
    expect(report.available).toBe(false);
    expect(report.k).toBeNull();
    expect(report.kText).toBe('not reported');
    expect(report.kText).not.toContain('0');
    expect(report.refusal).toMatch(/ΔG‡/);
    expect(kineticsSummaryLine(report)).toContain('not reported');
  });

  it('labels a rate from an electronic-energy difference as an estimate', () => {
    const report = buildKinetics({
      deltaGkcal: 20,
      deltaGKind: 'electronic-energy',
      temperatureK: 298.15,
      molecularity: { value: 1, basis: 'reactant fragments' },
    });
    expect(report.kind).toBe('electronic-estimate');
    expect(report.label).toMatch(/electronic-energy estimate/);
    expect(report.warnings.join(' ')).toMatch(/no ZPE or thermal correction/i);
    expect(report.assumptions.join(' ')).not.toMatch(/ΔG‡ from the same thermochemistry/);
  });

  it('refuses a rate when the molecularity is not stated', () => {
    const report = buildKinetics({ deltaGkcal: 20, temperatureK: 298.15, molecularity: null });
    expect(report.available).toBe(false);
    expect(report.k).toBeNull();
    expect(report.units).toBeNull();
    expect(report.refusal).toMatch(/molecularity/);
  });

  it('says the run temperature was not recorded instead of pretending 298.15 K was it', () => {
    const report = buildKinetics({
      deltaGkcal: 20,
      molecularity: { value: 1, basis: 'reactant fragments' },
    });
    expect(report.temperatureK).toBe(298.15);
    expect(report.provenance.temperature).toMatchObject({ kelvin: 298.15, assumed: true });
    expect(report.provenance.temperature.statement).toMatch(/not recorded/);
  });
});

describe('temperature table', () => {
  it('uses 298.15 K and the run temperature when no list is given', () => {
    const table = temperatureTable({
      deltaGkcal: 20,
      temperatureK: 323.15,
      molecularity: { value: 1, basis: 'reactant fragments' },
    });
    expect(table.map((row) => row.temperatureK)).toEqual([298.15, 323.15]);
    expect(table[1].k).toBeGreaterThan(table[0].k);
  });

  it('does not repeat 298.15 K when it is the run temperature', () => {
    const table = temperatureTable({
      deltaGkcal: 20,
      temperatureK: 298.15,
      molecularity: { value: 1, basis: 'reactant fragments' },
    });
    expect(table).toHaveLength(1);
  });

  it('honours an explicit list and sorts it', () => {
    const table = temperatureTable({
      deltaGkcal: 20,
      temperatureK: 298.15,
      temperatures: [348.15, 273.15, 298.15, 323.15],
      molecularity: { value: 1, basis: 'reactant fragments' },
    });
    expect(table.map((row) => row.temperatureK)).toEqual([273.15, 298.15, 323.15, 348.15]);
    expect(table.every((row) => row.units === 's⁻¹')).toBe(true);
  });

  it('fits the Arrhenius line from the table when it has three points over 10 K', () => {
    const table = temperatureTable({
      deltaGkcal: 20,
      temperatures: [273.15, 298.15, 323.15, 348.15],
      molecularity: { value: 1, basis: 'reactant fragments' },
    });
    const fit = arrheniusFit(table);
    expect(fit.available).toBe(true);
    // A fixed ΔG‡ makes the apparent activation energy ΔG‡ + RT.
    expect(fit.eaKcalPerMol).toBeGreaterThan(20.4);
    expect(fit.eaKcalPerMol).toBeLessThan(20.8);
    expect(fit.rSquared).toBeGreaterThan(0.999);
  });

  it('refuses the fit with fewer than three points or a range under 10 K', () => {
    const two = temperatureTable({
      deltaGkcal: 20,
      temperatures: [298.15, 323.15],
      molecularity: { value: 1, basis: 'reactant fragments' },
    });
    expect(arrheniusFit(two)).toMatchObject({ available: false });
    expect(arrheniusFit(two).reason).toMatch(/three points/);

    const narrow = temperatureTable({
      deltaGkcal: 20,
      temperatures: [295.15, 298.15, 301.15],
      molecularity: { value: 1, basis: 'reactant fragments' },
    });
    const refused = arrheniusFit(narrow);
    expect(refused.available).toBe(false);
    expect(refused.reason).toMatch(/10 K/);
  });
});

describe('rendered kinetics line', () => {
  it('prints k, its unit, the temperature and the barrier', () => {
    const line = kineticsSummaryLine(buildKinetics({
      deltaGkcal: 20,
      deltaGLabel: 'G(TS) − G(reactant)',
      temperatureK: 298.15,
      molecularity: { value: 1, basis: 'reactant fragments' },
    }));
    expect(line).toBe(
      'k = 1.36 × 10⁻² s⁻¹ at 298.15 K — ΔG‡ = 20.00 kcal mol⁻¹ from G(TS) − G(reactant), unimolecular TST.',
    );
  });
});

describe('CLI kinetics summary', () => {
  const project = {
    molecule: { fragments: ['CCO'], coords: [] },
    datasets: [{
      id: 'ds1',
      records: [{
        id: 'rec-bimolecular',
        label: 'A + B',
        molecule: { fragments: ['CC(=O)O', 'O'], coords: [] },
      }],
    }],
  };

  const queue = {
    id: 'q1',
    reactions: {
      irc: {
        available: true,
        kcalPerMol: 20,
        temperatureK: 298.15,
        scheme: 'ΔG‡ = G(TS) − G(reactant), both from frequency calculations at the same level of theory',
        transitionStateNodeId: 'ts',
        reactantNodeId: 'r',
      },
    },
    tasks: [
      { nodeId: 'ts', status: 'completed', runId: 'run-ts' },
      { nodeId: 'r', status: 'completed', runId: 'run-r' },
      { nodeId: 'irc', status: 'completed', runId: 'run-irc', reaction: { transitionStateNodeId: 'ts', reactantNodeId: 'r' } },
    ],
  };

  const runRecords = {
    'run-ts': {
      engine: 'gaussian',
      parsed: { thermochemistry: { freeEnergyHartree: -100, temperatureK: 298.15 } },
    },
    'run-r': {
      engine: 'gaussian',
      parsed: { thermochemistry: { freeEnergyHartree: -100.02, temperatureK: 298.15 } },
    },
  };

  it('reports k, units and molecularity for a unimolecular project', () => {
    const [entry] = kineticsSummary({ project, queue, runRecords });
    expect(entry.nodeId).toBe('irc');
    expect(entry.k).toBeCloseTo(0.01358815, 8);
    expect(entry.units).toBe('s⁻¹');
    expect(entry.molecularity).toBe(1);
    expect(entry.table).toHaveLength(1);
  });

  it('derives the bimolecular unit from the reactant record, not the project default', () => {
    const bimolecularQueue = {
      ...queue,
      tasks: queue.tasks.map((task) => (task.nodeId === 'r' ? { ...task, record: { id: 'rec-bimolecular' } } : task)),
    };
    const [entry] = kineticsSummary({ project, queue: bimolecularQueue, runRecords });
    expect(entry.molecularity).toBe(2);
    expect(entry.units).toBe('M⁻¹s⁻¹');
  });

  it('keeps a refusal when the reaction has no free energies', () => {
    const empty = { ...queue, reactions: { irc: { available: false, reason: 'A ΔG‡ needs a free energy for both the transition state and the reactant; the reactant has none.' } } };
    const [entry] = kineticsSummary({ project, queue: empty, runRecords });
    expect(entry.available).toBe(false);
    expect(entry.k).toBeNull();
    expect(entry.kText).toBe('not reported');
  });

  it('returns an empty list when the queue has no reaction paths', () => {
    expect(kineticsSummary({ project, queue: { tasks: [] }, runRecords })).toEqual([]);
  });
});
