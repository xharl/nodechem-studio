import { describe, expect, it } from 'vitest';

import {
  DIPOLE_AU_TO_DEBYE,
  POINT_DIPOLE_MIN_RATIO,
  POINT_DIPOLE_PREFACTOR_CM,
  davydovSplit,
  excitonCoupling,
  pointDipoleCoupling,
  pointDipoleValidity,
  transitionDipoleOf,
} from '../src/shared/exciton.js';

/**
 * Excitonic coupling, point-dipole form (issue 173, route A).
 *
 * The closed-form cases below are the acceptance criteria: the angle factor κ is
 * +2 for parallel dipoles head to tail, −1 for parallel stacked, 0 for
 * perpendicular, and J = 5030 · κ|μ₁||μ₂|/r³. Nothing here needs an engine, which
 * is the point — the arithmetic is checkable independently of any log.
 */

const D = (x, y, z) => ({ x, y, z });

describe('Kasha point-dipole coupling', () => {
  it('reproduces the closed form for parallel, head-to-tail dipoles', () => {
    // κ = 1 − 3 = −2: μ₁ and μ₂ both along r, head to tail.
    const result = pointDipoleCoupling({
      dipole1: D(1, 0, 0),
      dipole2: D(1, 0, 0),
      separationAngstrom: D(10, 0, 0),
    });
    expect(result.orientationFactor).toBeCloseTo(-2, 12);
    expect(result.couplingCm).toBeCloseTo(-5030.0 * 2 / 1000, 9);
    expect(result.couplingCm).toBeCloseTo(-10.06, 6);
    expect(result.distanceAngstrom).toBe(10);
    expect(result.units).toEqual({ coupling: 'cm^-1', distance: 'angstrom', dipole: 'debye' });
  });

  it('reproduces the closed form for parallel, stacked dipoles', () => {
    // κ = 1 − 0 = +1: both dipoles parallel, separation perpendicular to them.
    const result = pointDipoleCoupling({
      dipole1: D(0, 0, 1),
      dipole2: D(0, 0, 1),
      separationAngstrom: D(0, 8, 0),
    });
    expect(result.orientationFactor).toBeCloseTo(1, 12);
    expect(result.couplingCm).toBeCloseTo(5030.0 / 512, 9);
    expect(result.couplingCm).toBeCloseTo(9.82421875, 8);
  });

  it('gives zero for perpendicular dipoles in the head-to-tail arrangement', () => {
    const result = pointDipoleCoupling({
      dipole1: D(1, 0, 0),
      dipole2: D(0, 1, 0),
      separationAngstrom: D(10, 0, 0),
    });
    expect(result.orientationFactor).toBeCloseTo(0, 12);
    expect(result.couplingCm).toBeCloseTo(0, 12);
  });

  it('follows the inverse cube of the separation', () => {
    const at = (r) => pointDipoleCoupling({
      dipole1: D(1, 0, 0), dipole2: D(1, 0, 0), separationAngstrom: D(r, 0, 0),
    }).couplingCm;
    expect(at(10) / at(20)).toBeCloseTo(8, 9);
    expect(at(20) / at(40)).toBeCloseTo(8, 9);
  });

  it('scales with the product of the dipole magnitudes', () => {
    const one = pointDipoleCoupling({ dipole1: D(1, 0, 0), dipole2: D(1, 0, 0), separationAngstrom: D(10, 0, 0) });
    const other = pointDipoleCoupling({ dipole1: D(2, 0, 0), dipole2: D(3, 0, 0), separationAngstrom: D(10, 0, 0) });
    expect(other.couplingCm / one.couplingCm).toBeCloseTo(6, 9);
  });

  it('converts a dipole recorded in atomic units exactly once', () => {
    const inAu = transitionDipoleOf({ transitionDipoleAu: D(1, 0, 0) });
    expect(inAu.magnitudeDebye).toBeCloseTo(DIPOLE_AU_TO_DEBYE, 12);
    const viaAu = pointDipoleCoupling({
      dipole1: { transitionDipoleAu: D(1, 0, 0) },
      dipole2: { transitionDipoleAu: D(1, 0, 0) },
      separationAngstrom: D(10, 0, 0),
    });
    const viaDebye = pointDipoleCoupling({
      dipole1: D(DIPOLE_AU_TO_DEBYE, 0, 0),
      dipole2: D(DIPOLE_AU_TO_DEBYE, 0, 0),
      separationAngstrom: D(10, 0, 0),
    });
    expect(viaAu.couplingCm).toBeCloseTo(viaDebye.couplingCm, 9);
  });
});

describe('refusals', () => {
  it('refuses a state with no transition dipole rather than rebuilding it from f', () => {
    expect(() => pointDipoleCoupling({
      dipole1: { oscillatorStrength: 0.35 },
      dipole2: D(1, 0, 0),
      separationAngstrom: D(10, 0, 0),
    })).toThrow(/no transition dipole is recorded .*direction cannot be recovered from the oscillator strength/s);
  });

  it('refuses a zero dipole and a coincident pair', () => {
    expect(() => transitionDipoleOf({ transitionDipoleDebye: D(0, 0, 0) })).toThrow(/zero transition dipole/);
    expect(() => pointDipoleCoupling({
      dipole1: D(1, 0, 0), dipole2: D(1, 0, 0), separationAngstrom: D(0, 0, 0),
    })).toThrow(/undefined \(r = 0\)/);
  });

  it('refuses a malformed vector instead of treating a missing component as zero', () => {
    expect(() => pointDipoleCoupling({
      dipole1: D(1, 0), dipole2: D(1, 0, 0), separationAngstrom: D(10, 0, 0),
    })).toThrow(/three finite numbers/);
  });
});

describe('the split and its validity', () => {
  it('reports the Davydov split as 2|J| with the signed shift', () => {
    expect(davydovSplit(10.06)).toEqual({
      splitCm: 20.12,
      shiftCm: 10.06,
      lowerComponentCm: -10.06,
      upperComponentCm: 10.06,
    });
    expect(davydovSplit(-9.82421875).splitCm).toBeCloseTo(19.6484375, 9);
  });

  it('flags a pair that is too close for a point dipole, and says why', () => {
    const tight = pointDipoleValidity({ distanceAngstrom: 4.5, extentAngstrom: 4.0 });
    expect(tight.valid).toBe(false);
    expect(tight.ratio).toBeCloseTo(1.125, 9);
    expect(tight.note).toMatch(/not small compared with their separation/);

    const fine = pointDipoleValidity({ distanceAngstrom: 20, extentAngstrom: 4 });
    expect(fine.valid).toBe(true);
    expect(fine.threshold).toBe(POINT_DIPOLE_MIN_RATIO);
  });

  it('refuses to invent the chromophore extent', () => {
    expect(() => pointDipoleValidity({ distanceAngstrom: 10 }))
      .toThrow(/cannot be inferred from the atom count/);
  });

  it('passes the validity through, and states the approximation, in the combined report', () => {
    const report = excitonCoupling({
      state1: { transitionDipoleDebye: D(1, 0, 0) },
      state2: { transitionDipoleDebye: D(1, 0, 0) },
      separationAngstrom: D(10, 0, 0),
      extent1Angstrom: 3,
      extent2Angstrom: 2.5,
    });
    expect(report.couplingCm).toBeCloseTo(-10.06, 6);
    expect(report.splitCm).toBeCloseTo(20.12, 6);
    // 10 Å / 3 Å extent = 3.33 ≥ 3, so the point-dipole number is defensible.
    expect(report.validity.valid).toBe(true);
    expect(report.validity.ratio).toBeCloseTo(10 / 3, 9);
    expect(report.approximation).toMatch(/Charge-transfer character is not described/);
  });

  it('leaves validity absent when the extents are not supplied', () => {
    const report = excitonCoupling({
      state1: { transitionDipoleDebye: D(1, 0, 0) },
      state2: { transitionDipoleDebye: D(1, 0, 0) },
      separationAngstrom: D(10, 0, 0),
    });
    expect(report.validity).toBeNull();
    // The number is still reported — it is the *claim of validity* that is absent.
    expect(report.couplingCm).toBeCloseTo(-10.06, 6);
  });
});

describe('the constant', () => {
  it('is the point-dipole constant in cm^-1 per D^2/A^3, stated once', () => {
    expect(POINT_DIPOLE_PREFACTOR_CM).toBe(5030.0);
  });
});
