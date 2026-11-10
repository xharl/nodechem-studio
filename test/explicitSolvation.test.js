import { describe, expect, it } from 'vitest';
import { buildSolventCluster, explicitSolventFor, EXPLICIT_SOLVENT_IDS } from '../src/shared/explicitSolvation.js';

const water = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.96, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.93, z: 0 },
];

describe('explicit solvent placement (#228)', () => {
  it('places a deterministic cluster with intact solvent molecules', () => {
    const first = buildSolventCluster({ solute: water, solvent: 'water', count: 5, seed: 42 });
    const second = buildSolventCluster({ solute: water, solvent: 'water', count: 5, seed: 42 });
    expect(first.atoms).toEqual(second.atoms);
    expect(first.atoms).toHaveLength(3 + 5 * 3);
    expect(first.formula).toBe('H2O · 5 H2O');
    expect(first.composition).toMatchObject({
      solventFormula: 'H2O', solventCount: 5, soluteAtoms: 3, solventAtoms: 3, totalAtoms: 18,
    });
    expect(first.method).toMatch(/no relaxation/);
    expect(first.limitation).toMatch(/not bulk solvent/i);
  });

  it('changes the placement when the seed changes and keeps atoms apart', () => {
    const first = buildSolventCluster({ solute: water, count: 4, seed: 1 });
    const second = buildSolventCluster({ solute: water, count: 4, seed: 2 });
    expect(first.atoms).not.toEqual(second.atoms);
    const centers = [];
    for (let offset = 3; offset < first.atoms.length; offset += 3) {
      const group = first.atoms.slice(offset, offset + 3);
      centers.push({
        x: group.reduce((sum, atom) => sum + atom.x, 0) / group.length,
        y: group.reduce((sum, atom) => sum + atom.y, 0) / group.length,
        z: group.reduce((sum, atom) => sum + atom.z, 0) / group.length,
      });
    }
    for (let i = 0; i < centers.length; i += 1) {
      for (let j = i + 1; j < centers.length; j += 1) {
        expect(Math.hypot(centers[i].x - centers[j].x, centers[i].y - centers[j].y, centers[i].z - centers[j].z))
          .toBeGreaterThanOrEqual(2.0 - 1e-9);
      }
    }
  });

  it('names the solvents it can place and refuses one it cannot', () => {
    expect(EXPLICIT_SOLVENT_IDS).toContain('water');
    expect(EXPLICIT_SOLVENT_IDS).toContain('methanol');
    expect(explicitSolventFor('Water').label).toBe('Water');
    expect(() => buildSolventCluster({ solute: water, solvent: 'benzene', count: 1 }))
      .toThrow(/No explicit solvent parameters for "benzene"/);
  });

  it('refuses a count, seed or shell outside the documented bounds', () => {
    expect(() => buildSolventCluster({ solute: water, count: 0 })).toThrow(/between 1 and 64/);
    expect(() => buildSolventCluster({ solute: water, seed: -1 })).toThrow(/Placement seed/);
    expect(() => buildSolventCluster({ solute: water, shellAngstrom: 0.5 })).toThrow(/shell thickness/);
  });
});
