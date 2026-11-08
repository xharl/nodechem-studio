import { describe, expect, it } from 'vitest';
import {
  CORRELATION_EXPONENTS,
  HARTREE_TO_KCAL_PER_MOL,
  basisCardinality,
  cbsExtrapolate,
} from '../src/shared/cbs.js';

// Synthetic energies that obey the extrapolation form exactly:
//   E_SCF(X) = E_SCF (no basis dependence in this fixture)
//   E_corr(X) = E_corr,CBS + B X^-3
// so a correct two-point correlation extrapolation must recover E_corr,CBS.
const scfAt = () => -76;
const corrAt = (x) => -0.3 + 2.0 * x ** -3;
const totalAt = (x) => scfAt(x) + corrAt(x);

const rung = (label, basis, x, method = 'MP2') => ({
  label,
  method,
  basis,
  energyHartree: totalAt(x),
  scfEnergyHartree: scfAt(x),
});

describe('basis cardinal numbers', () => {
  it('reads the cardinal number from the families the extrapolation supports', () => {
    expect(basisCardinality('cc-pVTZ')).toMatchObject({ family: 'cc-pVXZ', x: 3 });
    expect(basisCardinality('cc-pVQZ')).toMatchObject({ family: 'cc-pVXZ', x: 4 });
    expect(basisCardinality('aug-cc-pVQZ')).toMatchObject({ family: 'aug-cc-pVXZ', x: 4 });
    expect(basisCardinality('def2-SVP')).toMatchObject({ family: 'def2', x: 2 });
    expect(basisCardinality('def2-TZVP')).toMatchObject({ family: 'def2', x: 3 });
    expect(basisCardinality('def2-QZVPP')).toMatchObject({ family: 'def2', x: 4 });
  });

  it('returns null for a basis with no cardinal number', () => {
    expect(basisCardinality('6-311G(d,p)')).toBeNull();
    expect(basisCardinality('LANL2DZ')).toBeNull();
    expect(basisCardinality('')).toBeNull();
    expect(basisCardinality(null)).toBeNull();
  });
});

describe('CBS extrapolation', () => {
  it('recovers the complete-basis-set limit from a two-rung ladder', () => {
    const result = cbsExtrapolate([
      rung('Rung 1', 'def2-TZVP', 3),
      rung('Rung 2', 'def2-QZVP', 4),
    ]);

    expect(result.available).toBe(true);
    expect(result.form).toMatch(/Helgaker two-point/);
    expect(result.form).toMatch(/correlation/);
    expect(result.exponents).toEqual({ correlation: CORRELATION_EXPONENTS.mp2 });
    expect(result.method).toBe('MP2');
    expect(result.scfHartree).toBeCloseTo(-76, 9);
    expect(result.scfSource).toMatch(/largest rung/);
    expect(result.scfSource).toMatch(/def2-QZVP/);
    expect(result.correlationCbsHartree).toBeCloseTo(-0.3, 9);
    expect(result.energyHartree).toBeCloseTo(-76.3, 9);
    expect(result.pair.lower.basis).toBe('def2-TZVP');
    expect(result.pair.upper.basis).toBe('def2-QZVP');
    expect(result.pair.lower.x).toBe(3);
    expect(result.pair.upper.x).toBe(4);
    expect(result.spread.kcal).toBeCloseTo(
      (totalAt(3) - totalAt(4)) * HARTREE_TO_KCAL_PER_MOL,
      6,
    );
    expect(result.spread.over).toMatch(/2 rungs/);
    expect(result.spread.over).toMatch(/def2-TZVP/);
  });

  it('refuses a single rung and names the rung that is missing', () => {
    const result = cbsExtrapolate([rung('Rung 1', 'def2-TZVP', 3)]);
    expect(result.available).toBe(false);
    expect(result.energyHartree).toBeNull();
    expect(result.reason).toMatch(/second rung is required/);
    expect(result.reason).toMatch(/Rung 1/);
    expect(result.reason).toMatch(/def2-TZVP/);
  });

  it('refuses rungs at the same cardinal number instead of dividing by zero', () => {
    const result = cbsExtrapolate([
      rung('Rung 1', 'def2-TZVP', 3),
      rung('Rung 2', 'def2-TZVPP', 3),
    ]);
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/same cardinal number/);
  });

  it('refuses rungs from different basis families and names both families', () => {
    const result = cbsExtrapolate([
      rung('Rung 1', 'def2-TZVP', 3),
      rung('Rung 2', 'cc-pVQZ', 4),
    ]);
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/different basis families/);
    expect(result.reason).toMatch(/def2/);
    expect(result.reason).toMatch(/cc-pVXZ/);
  });

  it('refuses rungs at different levels of theory', () => {
    const result = cbsExtrapolate([
      rung('Rung 1', 'def2-TZVP', 3, 'MP2'),
      rung('Rung 2', 'def2-QZVP', 4, 'CCSD(T)'),
    ]);
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/different methods/);
    expect(result.reason).toMatch(/MP2/);
    expect(result.reason).toMatch(/CCSD\(T\)/);
  });

  it('refuses a rung without an SCF energy, naming that rung', () => {
    const missingScf = rung('Rung 2', 'def2-QZVP', 4);
    delete missingScf.scfEnergyHartree;
    const result = cbsExtrapolate([rung('Rung 1', 'def2-TZVP', 3), missingScf]);
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/SCF energy/);
    expect(result.reason).toMatch(/Rung 2/);
    expect(result.reason).toMatch(/def2-QZVP/);
  });

  it('refuses a correlation method whose exponent is not defined', () => {
    const result = cbsExtrapolate([
      rung('Rung 1', 'def2-TZVP', 3, 'B3LYP'),
      rung('Rung 2', 'def2-QZVP', 4, 'B3LYP'),
    ]);
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/no correlation exponent/);
    expect(result.reason).toMatch(/B3LYP/);
  });

  it('uses the two highest rungs of a longer ladder and shows which pair it used', () => {
    const result = cbsExtrapolate([
      rung('Rung 1', 'cc-pVDZ', 2),
      rung('Rung 2', 'cc-pVTZ', 3),
      rung('Rung 3', 'cc-pVQZ', 4),
    ]);
    expect(result.available).toBe(true);
    expect(result.pair.lower.basis).toBe('cc-pVTZ');
    expect(result.pair.upper.basis).toBe('cc-pVQZ');
    expect(result.energyHartree).toBeCloseTo(-76.3, 9);
  });
});
