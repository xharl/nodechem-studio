import { describe, expect, it } from 'vitest';
import {
  DOMINANT_POPULATION,
  NOT_MEASURED,
  conformerUncertainty,
  eyringFactorPerKcal,
  methodSpread,
  rateUncertainty,
  whatWouldChange,
} from '../src/shared/uncertainty.js';
import { HARTREE_KCAL, KB_KCAL, boltzmannWeights } from '../src/shared/conformers.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';

/** A kcal/mol offset expressed in Hartree, so fixtures read as energies. */
const H = (kcal) => kcal / HARTREE_KCAL;

const T = 298.15;

describe('#229 method spread: measured, or not measured', () => {
  it('says not measured with a single rung, and never invents a spread', () => {
    const result = methodSpread([
      { id: 'sp', label: 'B3LYP/def2-SVP', method: 'B3LYP', basis: 'def2-SVP', energyHartree: -76.4 },
    ], { toleranceKcal: 3 });
    expect(result.measured).toBe(false);
    expect(result.spreadKcal).toBeNull();
    expect(result.rungs).toBe(1);
    expect(result.text.startsWith(NOT_MEASURED)).toBe(true);
    expect(result.text).toMatch(/a method spread needs at least two/);
    expect(result.entries).toHaveLength(1);
    // No mean, no literature number: the only energy in the result is the one rung's.
    expect(Object.hasOwn(result, 'mean')).toBe(false);
    expect(result.entries[0].relativeKcalPerMol).toBeUndefined();
  });

  it('is not measured when two rungs were declared but only one carried an energy', () => {
    const result = methodSpread([
      { id: 'r1', label: 'Rung 1', energyHartree: -76.4 },
      { id: 'r2', label: 'Rung 2', energyHartree: null },
    ]);
    expect(result.measured).toBe(false);
    expect(result.spreadKcal).toBeNull();
    expect(result.text).toMatch(/2 rungs are declared, but only 1 carried a parsed energy/);
  });

  it('measures the spread across the rungs that ran, in kcal/mol', () => {
    const result = methodSpread([
      { id: 'r1', label: 'B3LYP/def2-SVP', method: 'B3LYP', basis: 'def2-SVP', energyHartree: -76.4 },
      { id: 'r2', label: 'PBE0/def2-TZVP', method: 'PBE0', basis: 'def2-TZVP', energyHartree: -76.4 - H(1.25) },
      { id: 'r3', label: 'MP2/def2-TZVP', method: 'MP2', basis: 'def2-TZVP', energyHartree: -76.4 + H(2.5) },
    ], { title: 'Ladder sp', toleranceKcal: 3 });

    expect(result.measured).toBe(true);
    expect(result.rungs).toBe(3);
    expect(result.spreadKcal).toBeCloseTo(3.75, 9);
    expect(result.toleranceKcal).toBe(3);
    expect(result.headroomKcal).toBeCloseTo(-0.75, 9);
    expect(result.lowest.label).toBe('PBE0/def2-TZVP');
    expect(result.highest.label).toBe('MP2/def2-TZVP');
    expect(result.entries.map((entry) => Number(entry.relativeKcalPerMol.toFixed(6)))).toEqual([1.25, 0, 3.75]);
    expect(result.text).toBe('measured spread 3.75 kcal/mol over 3 rungs (B3LYP/def2-SVP, PBE0/def2-TZVP, MP2/def2-TZVP), '
      + 'from PBE0/def2-TZVP to MP2/def2-TZVP.');
    // A spread is a range, not a mean: no averaged rung exists in the result.
    expect(Object.hasOwn(result, 'mean')).toBe(false);
  });

  it('reports a positive headroom when the spread is inside tolerance', () => {
    const result = methodSpread([
      { label: 'a', energyHartree: -76.4 },
      { label: 'b', energyHartree: -76.4 + H(1.2) },
    ], { toleranceKcal: 3 });
    expect(result.headroomKcal).toBeCloseTo(1.8, 9);
  });
});

describe('#229 conformer spread: lowest beside the Boltzmann value', () => {
  const members = (relativeKcal, populations) => relativeKcal.map((value, index) => ({
    id: `c${index + 1}`,
    relativeKcal: value,
    population: populations[index],
  }));

  it('shows the lowest member at zero and the weighted value above it', () => {
    const relative = [0, 1.0];
    const weights = boltzmannWeights(relative, T);
    const result = conformerUncertainty(members(relative, weights), { temperatureK: T, title: 'Ensemble' });

    expect(result.measured).toBe(true);
    expect(result.count).toBe(2);
    expect(result.lowest).toEqual({ id: 'c1', relativeKcal: 0 });
    expect(result.spreadKcal).toBeCloseTo(1, 9);
    expect(result.boltzmann.relativeKcal).toBeCloseTo(weights[1] * 1.0, 12);
    expect(result.boltzmann.relativeKcal).toBeGreaterThan(0);
    // The lowest value is not replaced: both are present and the lowest stays 0.
    expect(result.lowest.relativeKcal).toBe(0);
    expect(result.deltaKcal).toBe(result.boltzmann.relativeKcal);
    expect(result.populationSource).toBe('stored');
    expect(result.dominant.id).toBe('c1');
    expect(result.text).toMatch(/lowest c1 at 0\.00 kcal\/mol and Boltzmann-weighted 0\.16 kcal\/mol/);
    expect(result.text).toMatch(/at 298\.15 K/);
    expect(result.text).toMatch(/retained spread 1\.00 kcal\/mol over 2 conformers/);
  });

  it('computes weights from the relative energies only when no member carries a population', () => {
    const result = conformerUncertainty([
      { id: 'c1', relativeKcal: 0 },
      { id: 'c2', relativeKcal: 1 },
    ], { temperatureK: T });
    expect(result.populationSource).toBe('computed');
    expect(result.boltzmann.relativeKcal).toBeCloseTo(1 / (1 + Math.exp(1 / (KB_KCAL * T))), 12);
    expect(result.text).toMatch(/populations recomputed from the relative energies at 298\.15 K/);
  });

  it('refuses a half-recorded population table instead of re-normalising', () => {
    const result = conformerUncertainty([
      { id: 'c1', relativeKcal: 0, population: 0.7 },
      { id: 'c2', relativeKcal: 1, population: null },
    ], { temperatureK: T });
    expect(result.measured).toBe(false);
    expect(result.boltzmann).toBeNull();
    expect(result.text).toMatch(/never re-normalised/);
  });

  it('has no spread with one retained conformer but still prints both values', () => {
    const result = conformerUncertainty([{ id: 'c1', relativeKcal: 0, population: 1 }], { temperatureK: T });
    expect(result.measured).toBe(false);
    expect(result.spreadKcal).toBeNull();
    expect(result.lowest.relativeKcal).toBe(0);
    expect(result.boltzmann.relativeKcal).toBe(0);
    expect(result.text.startsWith(NOT_MEASURED)).toBe(true);
  });

  it('refuses a non-comparable group with the caller reason', () => {
    const result = conformerUncertainty([
      { id: 'c1', relativeKcal: 0, population: 0.6 },
      { id: 'c2', relativeKcal: 1, population: 0.4 },
    ], { temperatureK: T, refusalReason: 'more than one task per member, so the rows are not one retained ensemble' });
    expect(result.measured).toBe(false);
    expect(result.count).toBe(2);
    expect(result.boltzmann).toBeNull();
    expect(result.text).toBe('not measured — more than one task per member, so the rows are not one retained ensemble.');
  });

  it('flags a dominating member at the documented population', () => {
    const result = conformerUncertainty(members([0, 2], [0.97, 0.03]), { temperatureK: T });
    expect(result.dominant.population).toBe(0.97);
    expect(result.dominated).toBe(true);
    expect(DOMINANT_POPULATION).toBe(0.95);
  });
});

describe('#229 barrier error to rate factor', () => {
  it('propagates a 1 kcal/mol barrier error to the Eyring factor at 298.15 K', () => {
    const result = rateUncertainty({
      barrierKcal: 20,
      barrierErrorKcal: 1,
      temperatureK: T,
      molecularity: 1,
      errorSource: 'method ladder spread',
    });

    expect(result.measured).toBe(true);
    expect(result.temperatureK).toBe(T);
    expect(result.units).toBe('s⁻¹');
    expect(result.factor).toBeCloseTo(5.4076, 3);
    expect(result.factorText).toBe('5.41×');
    // The factor is the ratio of two eyringRate() calls, not a copied constant.
    expect(result.factor).toBeCloseTo(result.kFast / result.k, 12);
    expect(result.factor).toBeCloseTo(result.k / result.kSlow, 12);
    expect(result.kFast).toBeGreaterThan(result.k);
    expect(result.k).toBeGreaterThan(result.kSlow);
    expect(result.text).toMatch(/barrier 20\.00 ± 1\.00 kcal\/mol at 298\.15 K/);
    expect(result.text).toMatch(/a factor 5\.41 in k across the recorded error/);
    expect(result.text).toMatch(/source: method ladder spread/);
  });

  it('matches the closed-form exp(ΔE/RT) from the code constants', () => {
    const result = rateUncertainty({ barrierKcal: 15, barrierErrorKcal: 2, temperatureK: T, molecularity: 1 });
    const expected = Math.exp((2 * 4184) / (8.314462618 * T));
    expect(result.factor).toBeCloseTo(expected, 9);
    expect(eyringFactorPerKcal(T)).toBeCloseTo(Math.exp(4184 / (8.314462618 * T)), 9);
    expect(eyringFactorPerKcal(T)).toBeCloseTo(5.4076065, 6);
  });

  it('says not measured when the barrier carries no recorded error', () => {
    const result = rateUncertainty({ barrierKcal: 20, barrierErrorKcal: null, temperatureK: T, molecularity: 2 });
    expect(result.measured).toBe(false);
    expect(result.factor).toBeNull();
    expect(result.factorText).toBeNull();
    expect(result.units).toBe('M⁻¹s⁻¹');
    expect(result.text.startsWith(NOT_MEASURED)).toBe(true);
    expect(result.text).toMatch(/no barrier error was recorded/);
  });

  it('names the standard state when the temperature was not recorded', () => {
    const result = rateUncertainty({ barrierKcal: 20, barrierErrorKcal: 1, molecularity: 1 });
    expect(result.temperatureK).toBe(T);
    expect(result.temperatureAssumed).toBe(true);
    expect(result.text).toMatch(/the 298\.15 K standard state was used/);
  });

  it('refuses a missing barrier rather than printing a rate', () => {
    const result = rateUncertainty({ barrierKcal: null, barrierErrorKcal: 1, temperatureK: T });
    expect(result.measured).toBe(false);
    expect(result.text).toMatch(/the barrier is missing/);
  });
});

describe('#229 what would change the conclusion', () => {
  it('derives the headroom sentence from the measured spread and the tolerance', () => {
    const row = methodSpread([
      { label: 'a', energyHartree: -76.4 },
      { label: 'b', energyHartree: -76.4 + H(1.2) },
    ], { title: 'Ladder sp', toleranceKcal: 3 });
    const [statement] = whatWouldChange([row], { temperatureK: T });
    expect(statement.kind).toBe('method');
    expect(statement.text).toBe('Ladder sp passes with 1.80 kcal/mol of headroom against a 3.00 kcal/mol tolerance: '
      + 'a rung moving by more than 1.80 kcal/mol would change the verdict to fail.');
  });

  it('derives the rate sentence from the recorded barrier error', () => {
    const row = rateUncertainty({ barrierKcal: 20, barrierErrorKcal: 1, temperatureK: T, title: 'Path ts', molecularity: 1 });
    const [statement] = whatWouldChange([row], { temperatureK: T });
    expect(statement.kind).toBe('rate');
    expect(statement.text).toBe('A barrier error of ±1.00 kcal/mol is a factor 5.41 in k at 298.15 K: '
      + 'a conclusion that depends on a rate ratio smaller than 5.41 is not resolved by this barrier.');
  });

  it('says what would have to run when nothing was measured', () => {
    const row = methodSpread([{ label: 'a', energyHartree: -76.4 }], { title: 'Ladder sp' });
    const [statement] = whatWouldChange([row]);
    expect(statement.text).toMatch(/1 rung ran; a method spread needs at least two/);
    expect(statement.text).toMatch(/A second rung with a parsed energy at a different level of theory is what would make the claim testable/);
  });
});

/** A queue with one measured ladder, one fanned-out ensemble and one reaction path. */
function smokeQueue() {
  return {
    id: 'q-229',
    projectName: 'Uncertainty smoke',
    status: 'completed',
    tasks: [
      { nodeId: 'conf', title: 'Ensemble', type: 'generate', status: 'completed', generate: { temperature: 298.15 } },
      {
        nodeId: 'opt~c1', title: 'Ensemble — c1', type: 'calculate', kind: 'Opt', status: 'completed', runId: 'run-c1',
        conformer: { nodeId: 'conf', title: 'Ensemble', id: 'c1', relativeKcal: 0, population: 0.8 },
        fanOut: { conformerId: 'conf', memberId: 'c1' },
      },
      {
        nodeId: 'opt~c2', title: 'Ensemble — c2', type: 'calculate', kind: 'Opt', status: 'completed', runId: 'run-c2',
        conformer: { nodeId: 'conf', title: 'Ensemble', id: 'c2', relativeKcal: 1, population: 0.2 },
        fanOut: { conformerId: 'conf', memberId: 'c2' },
      },
      { nodeId: 'ts', title: 'Transition state', type: 'calculate', kind: 'Opt=TS', status: 'completed', runId: 'run-ts' },
      { nodeId: 'reactant', title: 'Reactant', type: 'calculate', kind: 'Opt', status: 'completed', runId: 'run-r' },
    ],
    ladders: {
      sp: {
        status: 'pass',
        toleranceKcal: 3,
        spreadKcal: 1.25,
        reason: 'Spread 1.25 kcal/mol is within the 3 kcal/mol tolerance.',
        entries: [
          { id: 'sp.r1', label: 'B3LYP', energyHartree: -76.4, relativeKcalPerMol: 0 },
          { id: 'sp.r2', label: 'PBE0', energyHartree: -76.4 + H(1.25), relativeKcalPerMol: 1.25 },
        ],
      },
    },
    reactions: {
      'ts': {
        available: true,
        kcalPerMol: 20,
        temperatureK: 298.15,
        scheme: 'ΔG‡ = G(TS) − G(reactant)',
        transitionStateNodeId: 'ts',
        reactantNodeId: 'reactant',
        barrierErrorKcal: 1,
        barrierErrorSource: 'method ladder spread',
      },
    },
  };
}

const SMOKE_RECORDS = {
  'run-c1': { parsed: { finalEnergy: { hartree: -76.4 } }, provenance: { method: { functional: 'B3LYP', basis: 'def2-SVP' } } },
  'run-c2': { parsed: { finalEnergy: { hartree: -76.4 + H(1) } }, provenance: { method: { functional: 'B3LYP', basis: 'def2-SVP' } } },
  'run-ts': { parsed: { finalEnergy: { hartree: -76.3 } }, provenance: { method: { functional: 'B3LYP', basis: 'def2-SVP' } } },
  'run-r': { parsed: { finalEnergy: { hartree: -76.5 } }, provenance: { method: { functional: 'B3LYP', basis: 'def2-SVP' } } },
};

describe('#229 the report section renders what was measured', () => {
  const model = buildWorkflowReport(smokeQueue(), SMOKE_RECORDS, { generatedAt: '2026-11-09T00:00:00.000Z' });
  const html = workflowReportHtml(model);

  it('builds one uncertainty row per ladder, ensemble and reaction path', () => {
    expect(model.uncertainty).toBeTruthy();
    expect(model.uncertainty.rows.map((row) => row.kind)).toEqual(['method', 'conformer', 'rate']);
    expect(model.uncertainty.measuredCount).toBe(3);
    expect(model.uncertainty.notMeasuredCount).toBe(0);
    expect(model.uncertainty.rows[0].spreadKcal).toBeCloseTo(1.25, 9);
    expect(model.uncertainty.rows[1].boltzmann.relativeKcal).toBeCloseTo(0.2, 9);
    expect(model.uncertainty.rows[2].factor).toBeCloseTo(5.4076, 3);
  });

  it('renders the section, both conformer values and the rate factor', () => {
    expect(html).toContain('Uncertainty — measured');
    expect(html).toContain('data-field="uncertainty"');
    expect(html).toContain('measured spread 1.25 kcal/mol');
    expect(html).toContain('lowest c1 at 0.00 kcal/mol');
    expect(html).toContain('Boltzmann-weighted 0.20 kcal/mol');
    expect(html).toContain('a factor 5.41 in k at 298.15 K');
    expect(html).toContain('What would change the conclusion');
    expect(html).toContain('a rung moving by more than 1.75 kcal/mol would change the verdict to fail');
  });

  it('prints not measured, with its reason, when no barrier error was recorded', () => {
    const queue = smokeQueue();
    delete queue.reactions.ts.barrierErrorKcal;
    delete queue.reactions.ts.barrierErrorSource;
    const without = buildWorkflowReport(queue, SMOKE_RECORDS);
    expect(without.uncertainty.rows[2].measured).toBe(false);
    expect(without.uncertainty.notMeasuredCount).toBe(1);
    const rendered = workflowReportHtml(without);
    expect(rendered).toContain('not measured — no barrier error was recorded with this barrier');
  });
});
