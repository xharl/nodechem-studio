import { describe, expect, it } from 'vitest';
import { largestDeviations, superimpose } from '../src/shared/superpose.js';

const water = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.9572, y: 0, z: 0 },
  { element: 'H', x: -0.239, y: 0.927, z: 0 },
];

const rigid = (atoms, { angle = Math.PI / 3, shift = { x: 3, y: -2, z: 1 } } = {}) => atoms.map((atom) => ({
  element: atom.element,
  x: Math.cos(angle) * atom.x - Math.sin(angle) * atom.y + shift.x,
  y: Math.sin(angle) * atom.x + Math.cos(angle) * atom.y + shift.y,
  z: atom.z + shift.z,
}));

describe('superposition', () => {
  it('gives zero RMSD for a structure against itself', () => {
    const result = superimpose(water, water);
    expect(result.rmsd).toBeCloseTo(0, 12);
    expect(result.atoms).toBe(3);
  });

  it('recovers a rigid rotation and translation exactly', () => {
    const result = superimpose(water, rigid(water));
    expect(result.rmsd).toBeLessThan(1e-9);
    expect(result.atoms).toBe(3);
    expect(result.elements).toEqual(['O', 'H', 'H']);
  });

  it('reports a real RMSD for a distorted structure, not zero', () => {
    const distorted = water.map((atom, index) => ({ ...atom, x: atom.x + 0.01 * (index + 1) }));
    const result = superimpose(water, distorted);
    expect(result.rmsd).toBeGreaterThan(0.001);
    expect(result.rmsd).toBeLessThan(0.05);
  });

  it('refuses structures with different atom counts', () => {
    expect(() => superimpose(water, water.slice(0, 2))).toThrow(/same atom count/);
  });

  it('refuses structures whose atom order does not match', () => {
    const swapped = [water[1], water[2], water[0]];
    expect(() => superimpose(water, swapped)).toThrow(/same order/);
  });

  it('names the atoms that deviate most', () => {
    const distorted = water.map((atom, index) => (index === 1 ? { ...atom, x: atom.x + 0.4 } : atom));
    const result = superimpose(water, distorted);
    const worst = largestDeviations(water, result.aligned, { limit: 1 });
    expect(worst).toHaveLength(1);
    expect(worst[0].index).toBe(2);
    expect(worst[0].element).toBe('H');
  });
});
