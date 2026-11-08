import { describe, expect, it } from 'vitest';
import {
  DEPROTONATION_UNIT,
  pkaCycle,
  pkaCycleLine,
  redoxCycle,
  redoxCycleLine,
  referenceAcid,
  referenceAcidIds,
  referenceCouple,
  referenceCoupleIds,
} from '../src/shared/pka.js';

const species = (label, hartree) => ({ label, thermochemistry: { freeEnergyHartree: hartree } });

describe('shipped reference-acid library', () => {
  it('ships entries, each with a citable source', () => {
    expect(referenceAcidIds().length).toBeGreaterThanOrEqual(6);
    for (const id of referenceAcidIds()) {
      const entry = referenceAcid(id);
      expect(entry.id).toBe(id);
      expect(typeof entry.name).toBe('string');
      expect(entry.name.length).toBeGreaterThan(2);
      expect(entry.formula.length).toBeGreaterThan(0);
      expect(entry.conjugateBase.length).toBeGreaterThan(0);
      expect(entry.source.citation.length).toBeGreaterThan(20);
      expect(entry.source.citation).toMatch(/\d{4}|IUPAC|CRC|NIST/);
      expect(entry.solvent.length).toBeGreaterThan(2);
      expect(entry.temperatureK).toBeGreaterThanOrEqual(273);
      expect(entry.temperatureK).toBeLessThanOrEqual(323);
      expect(Number.isFinite(entry.ionicStrength)).toBe(true);
    }
  });

  it('keeps every pKa in a physically plausible range for a Brønsted acid', () => {
    for (const id of referenceAcidIds()) {
      const { pKa } = referenceAcid(id);
      expect(pKa, id).toBeGreaterThan(-2);
      expect(pKa, id).toBeLessThan(20);
    }
  });

  it('returns null for an unknown reference instead of inventing one', () => {
    expect(referenceAcid('unobtainium-acid')).toBeNull();
  });

  it('ships reference couples with an explicit potential and citation', () => {
    expect(referenceCoupleIds()).toContain('she');
    for (const id of referenceCoupleIds()) {
      const couple = referenceCouple(id);
      expect(Number.isFinite(couple.e0V)).toBe(true);
      expect(couple.source.citation.length).toBeGreaterThan(20);
      expect(couple.solvent.length).toBeGreaterThan(2);
      expect(couple.temperatureK).toBeGreaterThanOrEqual(273);
    }
  });
});

describe('pKa from a deprotonation cycle', () => {
  const cycle = {
    acid: species('acetic acid', -100),
    conjugateBase: species('acetate', -99.98),
    referenceAcid: species('reference acid', -90),
    referenceBase: species('reference base', -89.99),
    referenceId: 'acetic-acid',
    solvent: 'water',
    temperatureK: 298.15,
  };

  it('reports ΔG_deprot, pKa and the cited reference', () => {
    const result = pkaCycle(cycle);
    expect(result.available).toBe(true);
    expect(result.deltaGDeprotonationKcal).toBeCloseTo(12.5502, 3);
    expect(result.deltaGReferenceKcal).toBeCloseTo(6.2751, 3);
    expect(result.pKa).toBeCloseTo(4.76 + 6.2751 / 1.364, 2);
    expect(result.pKaText).toBe(result.pKa.toFixed(2));
    expect(result.reference.id).toBe('acetic-acid');
    expect(result.reference.citation).toMatch(/CRC|IUPAC|J\./);
  });

  it('names the 1.364 kcal mol⁻¹ per pKa unit conversion', () => {
    const result = pkaCycle(cycle);
    expect(result.unit.value).toBe(DEPROTONATION_UNIT);
    expect(result.unit.value).toBe(1.364);
    expect(result.unit.name).toMatch(/1\.364/);
    expect(result.unit.meaning).toMatch(/2\.303 RT/);
    expect(pkaCycleLine(result)).toContain('1.364 kcal mol⁻¹ per pKa unit');
  });

  it('refuses, and names the missing block, when a free energy is absent', () => {
    const result = pkaCycle({ ...cycle, conjugateBase: { label: 'acetate', thermochemistry: {} } });
    expect(result.available).toBe(false);
    expect(result.pKa).toBeNull();
    expect(result.pKaText).toBe('not reported');
    expect(result.missing).toContain('the conjugate base free energy');
    expect(result.refusal).toMatch(/not computable/);
    expect(result.refusal).toMatch(/conjugate base/);
  });

  it('refuses an unknown reference acid by name', () => {
    const result = pkaCycle({ ...cycle, referenceId: 'unobtainium-acid' });
    expect(result.available).toBe(false);
    expect(result.refusal).toMatch(/reference acid/i);
  });

  it('refuses a cycle whose solvent does not match the reference entry', () => {
    const result = pkaCycle({ ...cycle, solvent: 'acetonitrile' });
    expect(result.available).toBe(false);
    expect(result.refusal).toMatch(/solvent/);
  });
});

describe('redox potential from a thermodynamic cycle', () => {
  const cycle = {
    oxidized: { label: 'Ox+', charge: 1, thermochemistry: { freeEnergyHartree: -100 } },
    reduced: { label: 'Red', charge: 0, thermochemistry: { freeEnergyHartree: -100.02 } },
    reference: {
      coupleId: 'ag-agcl',
      oxidized: species('Ag+', -90),
      reduced: species('Ag', -90.01),
    },
    solvent: 'water',
    temperatureK: 298.15,
  };

  it('uses E° = E°(reference) + [ΔG(ref) − ΔG(sample)]/nF', () => {
    const result = redoxCycle(cycle);
    expect(result.available).toBe(true);
    expect(result.electrons).toBe(1);
    expect(result.deltaGKcalPerMol).toBeCloseTo(-12.5502, 3);
    expect(result.e0V).toBeCloseTo(0.197 + (12.5502 - 6.2751) / 23.0605, 3);
    expect(result.e0Text).toBe(`${result.e0V.toFixed(3)} V`);
    expect(result.reference.id).toBe('ag-agcl');
    expect(result.faraday.value).toBeCloseTo(23.0605, 4);
  });

  it('states the SHE offset and the reference couple explicitly', () => {
    const result = redoxCycle(cycle);
    expect(result.sheOffsetV).toBeCloseTo(0.197, 3);
    expect(result.scheme).toMatch(/E°\(reference\)/);
    expect(result.scheme).toMatch(/nF/);
    expect(redoxCycleLine(result)).toContain('vs SHE');
  });

  it('derives n from the charges and refuses when they do not fix it', () => {
    expect(redoxCycle(cycle).electrons).toBe(1);
    const noCharges = redoxCycle({
      ...cycle,
      oxidized: { ...cycle.oxidized, charge: null },
      reduced: { ...cycle.reduced, charge: null },
    });
    expect(noCharges.available).toBe(false);
    expect(noCharges.refusal).toMatch(/electron count/);
  });

  it('refuses when the reference couple has no computed free energies', () => {
    const result = redoxCycle({
      ...cycle,
      reference: { coupleId: 'ag-agcl', oxidized: species('Ag+', null), reduced: species('Ag', null) },
    });
    expect(result.available).toBe(false);
    expect(result.e0V).toBeNull();
    expect(result.refusal).toMatch(/reference couple/);
  });

  it('refuses a solvent mismatch and an unknown couple', () => {
    expect(redoxCycle({ ...cycle, solvent: 'acetonitrile' }).refusal).toMatch(/solvent/);
    expect(redoxCycle({ ...cycle, reference: { ...cycle.reference, coupleId: 'nope' } }).refusal)
      .toMatch(/reference couple/i);
  });
});
