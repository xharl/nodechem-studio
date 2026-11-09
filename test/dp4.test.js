import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DP4_BANK, DP4_KB_KCAL, DP4_VARIANT_LABELS, DP4_VARIANTS, DP4_PARAMETER_CLASSES,
  dp4Level, dp4Levels, dp4NucleusProbability, dp4Probabilities, dp4UnscaledClass,
  dp4Verdict, studentTCdf, studentTProbability,
} from '../src/shared/dp4.js';

/**
 * Issue 165: DP4/DP4+ probabilities over candidate structures.
 *
 * The parameter bank is data, not arithmetic — so the first block checks that a
 * level that is not in the bank is refused by name rather than approximated,
 * and that the numbers read from it are the ones the source workbook holds.
 *
 * The reproduction block is a *reproduction of the reference procedure*: the
 * fixture is the example study shipped with dp4plus_app 2.2.3 (MIT), and the
 * expected percentages come from an independent transcription of that
 * package's recipe (`dp4_module.py` + `correlation_module.py`) run over the
 * same shieldings. The package publishes no numeric table for this study — its
 * manual only states that isomer 01 is the correct structure — so the test also
 * asserts that the correct structure wins. Every check here is offline: the
 * bank and the fixture are committed.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/dp4/example-nmr-only.json'), 'utf8'));

/** The reference transcription's percentages for the shipped example study. */
const REFERENCE = Object.freeze({
  uns: [99.774629, 0.225371],
  sca: [99.648320, 0.351680],
  full: [99.999203, 0.000797],
});

function runExample(variant, extra = {}) {
  return dp4Probabilities({
    candidates: fixture.candidates,
    experimental: fixture.experimental,
    level: fixture.level,
    solvation: fixture.level.solvation,
    solvent: fixture.level.solvent,
    variant,
    ...extra,
  });
}

/** A minimal two-candidate problem with one carbon and one proton each. */
function toyProblem({
  shieldingA = { C: 100, H: 20 },
  shieldingB = { C: 110, H: 21 },
  experimental = [{ index: 1, nucleus: 'C', shift: 60 }, { index: 2, nucleus: 'H', shift: 2 }],
  assignments = [[1], [2]],
  level = { method: 'B3LYP', basis: '6-31G(d)' },
} = {}) {
  const build = (id, shielding) => ({
    id,
    title: `candidate ${id}`,
    conformers: [{
      energyHartree: -100,
      shieldings: [
        { index: 1, element: 'C', isotropic: shielding.C },
        { index: 2, element: 'H', isotropic: shielding.H },
      ],
    }],
    assignments,
  });
  return {
    candidates: [build('a', shieldingA), build('b', shieldingB)],
    experimental,
    assignments,
    level,
    solvation: 'gas',
  };
}

describe('dp4 — the parameter bank is data, and a missing level is absent', () => {
  it('records where every number came from', () => {
    expect(DP4_BANK.package).toBe('dp4plus_app');
    expect(DP4_BANK.version).toBe('2.2.3');
    expect(DP4_BANK.license).toBe('MIT');
    expect(DP4_BANK.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(DP4_BANK.workbookSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries the 24 DP4+ levels (12 functional/basis pairs, gas and PCM)', () => {
    const levels = dp4Levels();
    expect(levels).toHaveLength(24);
    expect(new Set(levels.map((entry) => entry.id)).size).toBe(12);
    for (const entry of levels) {
      expect(DP4_PARAMETER_CLASSES.every((key) => Number.isFinite(entry.parameters[key]?.df))).toBe(true);
    }
  });

  it('returns the fit and the standard the workbook holds for a level', () => {
    const resolved = dp4Level({ level: 'mPW1PW91/6-31+G(d,p)', solvation: 'PCM', solvent: 'CHCl3' });
    expect(resolved.ok).toBe(true);
    expect(resolved.level.id).toBe('mPW1PW91/6-31+G(d,p)');
    expect(resolved.level.standard).toEqual({ C: 196.609475, H: 31.55999166666666 });
    // Cell values from data_base_QM.xlsx sheet 'mPW1PW91.6-31+G(d,p).PCM'.
    expect(resolved.level.parameters.Csp3).toEqual({ df: 6.26933, mean: 2.90851, scale: 1.60002 });
    expect(resolved.level.parameters.Hsca).toEqual({ df: 3.89349, mean: 0, scale: 0.104352 });
  });

  it('refuses a level it does not carry, naming it', () => {
    const resolved = dp4Level({ level: 'B3LYP/cc-pVTZ', solvation: 'gas' });
    expect(resolved.ok).toBe(false);
    expect(resolved.code).toBe('level-not-in-bank');
    expect(resolved.reason).toContain('B3LYP/cc-pVTZ');
    expect(resolved.reason).toContain('not estimated');
  });

  it('refuses a solvation model or solvent it does not carry, instead of guessing one', () => {
    expect(dp4Level({ level: 'B3LYP/6-31G(d)', solvation: '' }).code).toBe('solvation-missing');
    expect(dp4Level({ level: 'B3LYP/6-31G(d)', solvation: 'PCM', solvent: 'toluene' }).code).toBe('solvent-not-in-bank');
    // A PCM fit exists for every level, but it needs the solvent to pick the
    // standard's shielding: the same level in CHCl3 and in DMSO is two tables.
    expect(dp4Level({ level: 'B3LYP/6-31G(d)', solvation: 'PCM' }).code).toBe('solvent-missing');
    expect(dp4Level({ level: 'B3LYP/6-31G(d)', solvation: 'PCM', solvent: 'CHCl3' }).ok).toBe(true);
  });

  it('does not ship a level it did not transcribe', () => {
    // The QM workbook has exactly these 24 fits; MM/xTB/Custom banks are not
    // part of this file and must therefore not resolve.
    const ids = dp4Levels().map((entry) => entry.id);
    expect(ids).not.toContain('MMFF94');
    expect(dp4Level({ level: 'GFN2-xTB', solvation: 'gas' }).ok).toBe(false);
  });
});

describe('dp4 — the t distribution', () => {
  it('matches the published two-tailed t table', () => {
    // 95 % two-tailed critical values: t = 2.228 (df 10), 2.086 (df 20), 12.706 (df 1).
    expect(studentTCdf(2.228, 10)).toBeCloseTo(0.975, 4);
    expect(studentTCdf(2.086, 20)).toBeCloseTo(0.975, 4);
    expect(studentTCdf(12.706, 1)).toBeCloseTo(0.975, 4);
    expect(studentTCdf(1.812, 10)).toBeCloseTo(0.95, 4);
  });

  it('gives a nucleus with zero error the maximum single-nucleus score, 0.5', () => {
    expect(studentTProbability(0, 6.26933)).toBeCloseTo(0.5, 12);
    expect(dp4NucleusProbability(2.90851, { df: 6.26933, mean: 2.90851, scale: 1.60002 })).toBeCloseTo(0.5, 12);
  });

  it('falls off with the standardised error', () => {
    const parameters = { df: 6.26933, mean: 0, scale: 1.60002 };
    const values = [0, 1, 2, 4, 8].map((error) => dp4NucleusProbability(error, parameters));
    for (let index = 1; index < values.length; index += 1) expect(values[index]).toBeLessThan(values[index - 1]);
    expect(values[0]).toBeCloseTo(0.5, 10);
  });

  it('returns null for a fit that cannot produce a probability', () => {
    expect(dp4NucleusProbability(1, { df: 0, mean: 0, scale: 1 })).toBeNull();
    expect(dp4NucleusProbability(1, { df: 5, mean: 0, scale: 0 })).toBeNull();
  });

  it('classifies a nucleus by element and hybridisation', () => {
    expect(dp4UnscaledClass('C', true)).toBe('Csp2');
    expect(dp4UnscaledClass('C', false)).toBe('Csp3');
    expect(dp4UnscaledClass('H', true)).toBe('Hsp2');
    expect(dp4UnscaledClass('H', false)).toBe('Hsp3');
    expect(dp4UnscaledClass('N', false)).toBeNull();
  });
});

describe('dp4 — reproduction of the reference package’s own example study', () => {
  it('reads the fixture it was given', () => {
    expect(fixture.candidates.map((candidate) => candidate.conformers.length)).toEqual([15, 25]);
    expect(fixture.experimental).toHaveLength(27);
  });

  for (const variant of DP4_VARIANTS) {
    it(`reproduces the reference percentages for variant ${variant}`, () => {
      const result = runExample(variant);
      expect(result.available, result.reason ?? '').toBe(true);
      expect(result.candidates.map((candidate) => candidate.id)).toEqual(['01', '02']);
      result.candidates.forEach((candidate, index) => {
        // 0.001 percentage point — far tighter than the 0.1 pp the issue asks for.
        expect(candidate.percent).toBeCloseTo(REFERENCE[variant][index], 3);
      });
      expect(result.checks.sumOfProbabilities).toBeCloseTo(1, 12);
    });
  }

  it('picks the structure the example manual calls correct', () => {
    const result = runExample('full');
    const [first] = result.candidates;
    expect(first.id).toBe('01');
    expect(first.percent).toBeGreaterThan(99);
  });

  it('records the level, the standard, the distribution and the nuclei it used', () => {
    const result = runExample('full');
    expect(result.level.label).toBe('mPW1PW91/6-31+G(d,p) PCM/CHCl3');
    expect(result.level.standard).toEqual({ C: 196.609475, H: 31.55999166666666 });
    expect(result.errorDistribution.family).toBe('student-t');
    expect(result.errorDistribution.classes.Csp3.df).toBe(6.26933);
    expect(result.experimental.carbon).toBe(12);
    expect(result.experimental.hydrogen).toBe(15);
    expect(result.nucleiCompared).toBe(27 * 2);
    expect(result.temperatureK).toBe(298.15);
    expect(result.variantLabel).toBe(DP4_VARIANT_LABELS.full);
  });

  it('reports every variant side by side, unnormalised by the choice', () => {
    const result = runExample('uns');
    expect(result.variant).toBe('uns');
    expect(result.candidates[0].percentages.full).toBeCloseTo(REFERENCE.full[0], 3);
    expect(result.candidates[0].percentages.sca).toBeCloseTo(REFERENCE.sca[0], 3);
  });

  it('orders the diastereotopic pairs it was given', () => {
    const result = runExample('full');
    expect(result.candidates[0].diastereotopicLabels).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('dp4 — Boltzmann weighting over the conformer ensemble', () => {
  it('weights two conformers with hand-checked arithmetic', () => {
    // ΔE = RT at 298.15 K → w = 1/(1+e^-1) and e^-1/(1+e^-1), with RT taken
    // from the same kB the conformer module uses.
    const deltaKcal = DP4_KB_KCAL * 298.15;
    const w1 = 1 / (1 + Math.exp(-deltaKcal / (DP4_KB_KCAL * 298.15)));
    const w2 = Math.exp(-1) / (1 + Math.exp(-1));
    expect(w1 + w2).toBeCloseTo(1, 12);
    const result = dp4Probabilities({
      candidates: [{
        id: 'a',
        conformers: [
          { energyKcal: 0, shieldings: [{ index: 1, element: 'C', isotropic: 100 }, { index: 2, element: 'H', isotropic: 20 }] },
          { energyKcal: deltaKcal, shieldings: [{ index: 1, element: 'C', isotropic: 110 }, { index: 2, element: 'H', isotropic: 22 }] },
        ],
        assignments: [[1], [2]],
      }, {
        id: 'b',
        conformers: [{ energyKcal: 0, shieldings: [{ index: 1, element: 'C', isotropic: 90 }, { index: 2, element: 'H', isotropic: 19 }] }],
        assignments: [[1], [2]],
      }],
      experimental: [{ index: 1, nucleus: 'C', shift: 60 }, { index: 2, nucleus: 'H', shift: 2 }],
      level: 'B3LYP/6-31G(d)',
      solvation: 'gas',
    });
    expect(result.available).toBe(true);
    const [first] = result.candidates.filter((candidate) => candidate.id === 'a');
    expect(first.weights.source).toBe('computed');
    expect(first.weights.members[0]).toBeCloseTo(w1, 10);
    expect(first.weights.members[1]).toBeCloseTo(w2, 10);
    // The averaged shielding is w1·100 + w2·110, and the unscaled shift follows
    // from the standard's shielding at that level.
    const expectedShielding = w1 * 100 + w2 * 110;
    const carbon = first.nuclei.find((nucleus) => nucleus.element === 'C');
    expect(carbon.shielding).toBeCloseTo(expectedShielding, 10);
    expect(carbon.computed).toBeCloseTo(result.level.standard.C - expectedShielding, 10);
  });

  it('accepts a plain array of shieldings, whose position is the atom number', () => {
    // The same problem written two ways must give the same answer: the object
    // form is what `parseShieldings` returns, the array form is what a compact
    // fixture or an exported table looks like.
    const objects = toyProblem();
    const arrays = toyProblem();
    for (const candidate of arrays.candidates) {
      candidate.conformers[0].shieldings = candidate.conformers[0].shieldings.map((atom) => atom.isotropic);
    }
    const a = dp4Probabilities(objects);
    const b = dp4Probabilities(arrays);
    expect(b.available).toBe(true);
    expect(b.candidates.map((candidate) => candidate.percent))
      .toEqual(a.candidates.map((candidate) => candidate.percent));
  });

  it('uses a stored population as the block recorded it, without re-deriving it', () => {
    const result = dp4Probabilities({
      candidates: [{
        id: 'a',
        conformers: [
          { population: 0.9, shieldings: [{ index: 1, element: 'C', isotropic: 100 }, { index: 2, element: 'H', isotropic: 20 }] },
          { population: 0.1, shieldings: [{ index: 1, element: 'C', isotropic: 110 }, { index: 2, element: 'H', isotropic: 22 }] },
        ],
        assignments: [[1], [2]],
      }, {
        id: 'b',
        conformers: [{ population: 1, shieldings: [{ index: 1, element: 'C', isotropic: 90 }, { index: 2, element: 'H', isotropic: 19 }] }],
        assignments: [[1], [2]],
      }],
      experimental: [{ index: 1, nucleus: 'C', shift: 60 }, { index: 2, nucleus: 'H', shift: 2 }],
      level: 'B3LYP/6-31G(d)',
      solvation: 'gas',
    });
    const [first] = result.candidates.filter((candidate) => candidate.id === 'a');
    expect(first.weights.source).toBe('stored');
    expect(first.nuclei.find((nucleus) => nucleus.element === 'C').shielding).toBeCloseTo(101, 10);
  });

  it('refuses an ensemble whose stored populations do not sum to one', () => {
    const result = dp4Probabilities({
      candidates: [{
        id: 'a',
        conformers: [
          { population: 0.9, shieldings: [{ index: 1, element: 'C', isotropic: 100 }, { index: 2, element: 'H', isotropic: 20 }] },
          { population: 0.4, shieldings: [{ index: 1, element: 'C', isotropic: 110 }, { index: 2, element: 'H', isotropic: 22 }] },
        ],
        assignments: [[1], [2]],
      }, {
        id: 'b',
        conformers: [{ population: 1, shieldings: [{ index: 1, element: 'C', isotropic: 90 }, { index: 2, element: 'H', isotropic: 19 }] }],
        assignments: [[1], [2]],
      }],
      experimental: [{ index: 1, nucleus: 'C', shift: 60 }, { index: 2, nucleus: 'H', shift: 2 }],
      level: 'B3LYP/6-31G(d)',
      solvation: 'gas',
    });
    expect(result.available).toBe(false);
    expect(result.code).toBe('weights-unavailable');
    expect(result.reason).toContain('sum to');
  });

  it('refuses a candidate with neither a population nor an energy', () => {
    const problem = toyProblem();
    delete problem.candidates[0].conformers[0].energyHartree;
    const result = dp4Probabilities(problem);
    expect(result.available).toBe(false);
    expect(result.code).toBe('weights-unavailable');
    expect(result.reason).toContain('neither a retained population nor an energy');
  });
});

describe('dp4 — consistency checks on a self-computed case', () => {
  it('sums the probabilities of three candidates to one', () => {
    const problem = toyProblem();
    problem.candidates.push({
      id: 'c',
      conformers: [{ energyHartree: -100, shieldings: [{ index: 1, element: 'C', isotropic: 105 }, { index: 2, element: 'H', isotropic: 20.5 }] }],
      assignments: [[1], [2]],
    });
    const result = dp4Probabilities(problem);
    expect(result.available).toBe(true);
    expect(result.candidates).toHaveLength(3);
    expect(result.checks.sumOfProbabilities).toBeCloseTo(1, 12);
    expect(result.candidates.reduce((sum, candidate) => sum + candidate.percent, 0)).toBeCloseTo(100, 8);
  });

  it('gives a candidate that matches the experiment exactly the largest share', () => {
    // The standard's shielding at B3LYP/6-31G(d) gas phase is 189.7149 (C) and
    // 32.18261666666666 (H); a candidate whose shifts equal the measurement
    // exactly has zero error on both nuclei, and 0.5 is the most a nucleus can
    // score — so the other candidate cannot win.
    const exact = { C: 189.7149 - 60, H: 32.18261666666666 - 2 };
    const problem = toyProblem({ shieldingA: exact, shieldingB: { C: exact.C - 6, H: exact.H - 0.4 } });
    const result = dp4Probabilities(problem);
    expect(result.available).toBe(true);
    expect(result.candidates[0].id).toBe('a');
    expect(result.candidates[0].nuclei.every((nucleus) => Math.abs(nucleus.unscaledError) < 1e-9)).toBe(true);
    expect(result.candidates[0].percent).toBeGreaterThan(99.9);
    const zero = dp4Probabilities({ ...problem, variant: 'uns' });
    expect(zero.candidates[0].percent).toBeGreaterThan(99.9);
  });

  it('makes a deliberately corrupted candidate lose', () => {
    const exact = { C: 189.7149 - 60, H: 32.18261666666666 - 2 };
    const good = toyProblem({ shieldingA: exact, shieldingB: { C: exact.C + 4, H: exact.H + 0.3 } });
    const bad = toyProblem({ shieldingA: exact, shieldingB: { C: exact.C + 40, H: exact.H + 3 } });
    const goodResult = dp4Probabilities(good);
    const badResult = dp4Probabilities(bad);
    expect(badResult.candidates[0].id).toBe('a');
    expect(badResult.candidates[1].percent).toBeLessThan(goodResult.candidates[1].percent);
  });

  it('separates the variants and never calls one of them classic DP4', () => {
    const result = dp4Probabilities(toyProblem());
    expect(result.variantLabel).toContain('DP4+');
    expect(result.variantLabel).not.toContain('classic DP4');
    expect(result.variants.uns).toBe('DP4+ unscaled (not classic DP4)');
  });
});

describe('dp4 — the documented rule for a missing nucleus', () => {
  it('excludes the candidate and names the atom, rather than scoring it on fewer nuclei', () => {
    const problem = toyProblem();
    // Candidate b's second conformer has no atom 2.
    problem.candidates[1].conformers[0].shieldings = [{ index: 1, element: 'C', isotropic: 110 }];
    problem.candidates.push({
      id: 'c',
      conformers: [{ energyHartree: -100, shieldings: [{ index: 1, element: 'C', isotropic: 105 }, { index: 2, element: 'H', isotropic: 20.5 }] }],
      assignments: [[1], [2]],
    });
    const result = dp4Probabilities(problem);
    expect(result.available).toBe(true);
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(expect.arrayContaining(['a', 'c']));
    expect(result.candidates).toHaveLength(2);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0].candidateId).toBe('b');
    expect(result.excluded[0].code).toBe('missing-nucleus');
    expect(result.excluded[0].reason).toContain('atom 2');
    // The remaining candidates are still scored over the full 2 nuclei each.
    expect(result.checks.nucleiPerCandidate).toBe(2);
    expect(result.checks.sumOfProbabilities).toBeCloseTo(1, 12);
  });

  it('refuses when the exclusion leaves fewer than two candidates', () => {
    const problem = toyProblem();
    delete problem.candidates[1].conformers[0].shieldings[1];
    const result = dp4Probabilities(problem);
    expect(result.available).toBe(false);
    expect(result.code).toBe('fewer-than-two-scorable-candidates');
    expect(result.reason).toContain('b');
    expect(result.excluded[0].candidateId).toBe('b');
  });
});

describe('dp4 — preconditions refused by name', () => {
  it('refuses fewer than two candidates', () => {
    const problem = toyProblem();
    problem.candidates = problem.candidates.slice(0, 1);
    const result = dp4Probabilities(problem);
    expect(result.code).toBe('fewer-than-two-candidates');
    expect(result.reason).toContain('at least two');
  });

  it('refuses classic DP4 by name instead of reporting DP4+ under that label', () => {
    const result = dp4Probabilities({ ...toyProblem(), variant: 'dp4' });
    expect(result.code).toBe('classic-dp4-not-in-bank');
    expect(result.reason).toContain('Smith & Goodman 2010');
    expect(result.reason).toContain('never reported as DP4');
  });

  it('refuses an unknown variant', () => {
    expect(dp4Probabilities({ ...toyProblem(), variant: 'mmff' }).code).toBe('unknown-variant');
  });

  it('refuses candidates declared at different levels', () => {
    const problem = toyProblem();
    problem.candidates[1].level = 'B3LYP/6-311+G(d,p)';
    const result = dp4Probabilities(problem);
    expect(result.code).toBe('differing-levels');
    expect(result.reason).toContain('B3LYP/6-311+G(d,p)');
  });

  it('refuses a level the bank does not carry', () => {
    const result = dp4Probabilities({ ...toyProblem(), level: 'B3LYP/cc-pVTZ' });
    expect(result.code).toBe('level-not-in-bank');
  });

  it('refuses an empty or unmappable experimental list', () => {
    const noData = dp4Probabilities({ ...toyProblem(), experimental: [] });
    expect(noData.code).toBe('no-experimental-data');
    // One element is allowed and scores on that element alone; the counts say so.
    const protonOnlyProblem = toyProblem({
      experimental: [{ index: 1, nucleus: 'H', shift: 2 }],
      assignments: [[2]],
    });
    for (const candidate of protonOnlyProblem.candidates) candidate.assignments = [[2]];
    const protonOnly = dp4Probabilities(protonOnlyProblem);
    expect(protonOnly.available, protonOnly.reason ?? '').toBe(true);
    expect(protonOnly.experimental.carbon).toBe(0);
    expect(protonOnly.experimental.hydrogen).toBe(1);
    expect(protonOnly.checks.sumOfProbabilities).toBeCloseTo(1, 12);
    const wrongCountProblem = toyProblem();
    for (const candidate of wrongCountProblem.candidates) candidate.assignments = [[1]];
    const wrongCount = dp4Probabilities(wrongCountProblem);
    expect(wrongCount.code).toBe('assignment-incomplete');
  });

  it('refuses an assignment that reuses an atom across rows', () => {
    const problem = toyProblem({
      assignments: [[1], [1]],
      experimental: [{ index: 1, nucleus: 'C', shift: 60 }, { index: 2, nucleus: 'H', shift: 2 }],
    });
    const result = dp4Probabilities(problem);
    expect(result.code).toBe('assignment-not-one-to-one');
    expect(result.reason).toContain('atom 1');
  });

  it('refuses a nucleus this record cannot read', () => {
    const result = dp4Probabilities({
      ...toyProblem(),
      experimental: [{ index: 1, nucleus: '15N', shift: 20 }, { index: 2, nucleus: 'H', shift: 2 }],
    });
    expect(result.code).toBe('unknown-nucleus');
    expect(result.reason).toContain('15N');
  });

  it('refuses an invalid temperature', () => {
    expect(dp4Probabilities({ ...toyProblem(), temperature: 0 }).code).toBe('temperature-invalid');
  });
});

describe('dp4 — the verdict line', () => {
  it('names a winner when the margin is wider than five points', () => {
    const result = runExample('full');
    const verdict = dp4Verdict(result);
    expect(verdict.close).toBe(false);
    expect(verdict.text).toContain('isomer 01');
    expect(verdict.text).toContain('DP4+ full');
  });

  it('calls two candidates within five points inseparable', () => {
    const verdict = dp4Verdict({
      available: true,
      variantLabel: 'DP4+ full',
      candidates: [
        { id: 'a', title: 'A', percent: 52 },
        { id: 'b', title: 'B', percent: 48 },
      ],
    });
    expect(verdict.close).toBe(true);
    expect(verdict.text).toContain('do not separate');
  });

  it('returns null for a refused result', () => {
    expect(dp4Verdict({ available: false, code: 'x' })).toBeNull();
    expect(dp4Verdict(null)).toBeNull();
  });
});

describe('dp4 — the card and the report', () => {
  it('prints the probability table with the terms it was computed under', async () => {
    const { dp4PanelHtml } = await import('../src/shared/workflowReport.js');
    const result = runExample('full');
    const html = dp4PanelHtml(result, { tableClass: 'results-table' });
    expect(html).toContain('data-field="dp4-probabilities"');
    expect(html).toContain('isomer 01');
    expect(html).toContain('mPW1PW91/6-31+G(d,p)');
    expect(html).toContain('DP4+ full');
    expect(html).toContain('298.15 K');
    expect(html).toContain('Student-t');
    // The variant is named for what it is, and the note says what it is not.
    expect(html).toContain('not classic DP4');
    // The experimental data and the standard are both stated.
    expect(html).toContain('27 experimental shifts');
    expect(html).toContain('196.6095');
    // The bank's hash is printed so the numbers can be traced to the workbook.
    expect(html).toContain(DP4_BANK.workbookSha256.slice(0, 12));
  });

  it('prints a refusal instead of an empty table', async () => {
    const { dp4PanelHtml } = await import('../src/shared/workflowReport.js');
    const refused = dp4Probabilities({ ...toyProblem(), level: 'B3LYP/cc-pVTZ' });
    const html = dp4PanelHtml(refused);
    expect(html).toContain('DP4+ not computed');
    expect(html).toContain('B3LYP/cc-pVTZ');
    expect(html).not.toContain('dp4-probabilities');
  });

  it('renders inside the results panel only when the record carries the block', async () => {
    const { resultsPanelHtml } = await import('../src/renderer/resultsView.js');
    const result = runExample('full');
    const withBlock = resultsPanelHtml({ id: 'r1', status: 'completed', title: 'candidates', dp4: result });
    expect(withBlock).toContain('DP4+ probabilities');
    expect(withBlock).toContain('data-field="dp4-probabilities"');
    const without = resultsPanelHtml({ id: 'r2', status: 'completed', title: 'plain' });
    expect(without).not.toContain('DP4+ probabilities');
  });

  it('adds a DP4+ section to the workflow report when a record carries one', async () => {
    const { buildWorkflowReport, workflowReportHtml } = await import('../src/shared/workflowReport.js');
    const result = runExample('full');
    const queue = {
      id: 'q-dp4',
      projectName: 'DP4+ study',
      status: 'completed',
      createdAt: '2026-11-09T00:00:00.000Z',
      finishedAt: '2026-11-09T00:10:00.000Z',
      tasks: [{
        nodeId: 'dp4-1', type: 'calc', title: 'Candidate ranking', status: 'completed', runId: 'run-dp4',
      }],
    };
    const records = {
      'run-dp4': { id: 'run-dp4', status: 'completed', title: 'Candidate ranking', dp4: result },
    };
    const model = buildWorkflowReport(queue, records);
    expect(model.dp4).toHaveLength(1);
    const html = workflowReportHtml(model);
    expect(html).toContain('DP4+ probabilities');
    expect(html).toContain('data-field="dp4-probabilities"');
    expect(html).toContain('isomer 01');
  });

  it('leaves a report without DP4 unchanged', async () => {
    const { buildWorkflowReport, workflowReportHtml } = await import('../src/shared/workflowReport.js');
    const queue = { id: 'q-plain', status: 'completed', tasks: [] };
    const html = workflowReportHtml(buildWorkflowReport(queue, {}));
    expect(html).not.toContain('DP4+ probabilities');
  });
});
