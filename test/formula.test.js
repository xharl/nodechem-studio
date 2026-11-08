import { describe, expect, it } from 'vitest';
import { compositionOf, describeAtoms, formulaOf, massOf } from '../src/shared/formula.js';

const atom = (element) => ({ element, x: 0, y: 0, z: 0 });
const water = [atom('O'), atom('H'), atom('H')];
const ethanol = [atom('C'), atom('C'), atom('O'), atom('H'), atom('H'), atom('H'), atom('H'), atom('H'), atom('H')];
const ammonia = [atom('N'), atom('H'), atom('H'), atom('H')];

describe('formula and mass', () => {
  it('counts each element once per atom', () => {
    expect([...compositionOf(water)]).toEqual([['O', 1], ['H', 2]]);
    expect([...compositionOf([])]).toEqual([]);
  });

  it('uses Hill order: C, H, then alphabetical', () => {
    expect(formulaOf(ethanol)).toBe('C2H6O');
    expect(formulaOf(water)).toBe('H2O');
    // No carbon: hydrogen sorts alphabetically with the rest.
    expect(formulaOf(ammonia)).toBe('H3N');
    expect(formulaOf([atom('S'), atom('O'), atom('O'), atom('H'), atom('H')])).toBe('H2O2S');
  });

  it('sums standard atomic weights', () => {
    expect(massOf(water)).toBeCloseTo(18.015, 3);
    expect(massOf(ethanol)).toBeCloseTo(46.069, 3);
    expect(massOf([atom('Xx')])).toBeNull();
  });

  it('describes a set of atoms in one line', () => {
    expect(describeAtoms(water)).toBe('H2O · 18.02 u');
    expect(describeAtoms([])).toBe('no atoms');
    expect(describeAtoms([atom('Xx')])).toBe('Xx');
  });
});
