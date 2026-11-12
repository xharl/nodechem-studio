import { describe, expect, it } from 'vitest';

import { validateProject } from '../src/shared/projectSchema.js';

/**
 * ADR 0003 §3.1 — the project schema accepts a descriptors block, and still
 * refuses an unknown mode. The block declares no inputs, so an unwired one is a
 * warning (the planner refuses it by name), never a saved project that lies
 * about having something to read.
 */
function project(analyse) {
  return {
    schemaVersion: 3,
    name: 'chem schema',
    molecule: {
      charge: 0,
      multiplicity: 1,
      fragments: [],
      coords: [
        { element: 'O', x: 0, y: 0, z: 0 },
        { element: 'H', x: 0.96, y: 0, z: 0 },
      ],
      geometry: { source: 'imported', file: 'w.xyz', format: 'xyz' },
    },
    defaults: {
      method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4', engine: 'gaussian',
    },
    runner: { maxParallel: 1 },
    nodes: [{ id: 'a1', type: 'analyse', title: 'Descriptors', x: 0, y: 0, analyse }],
    edges: [],
    reports: [],
  };
}

describe('analyse mode chem in the project schema (ADR 0003 §3.1)', () => {
  it('accepts a descriptors block and normalises the pinned op', () => {
    const result = validateProject(project({ mode: 'chem', chem: { op: 'descriptors' } }));
    expect(result.errors).toEqual([]);
    expect(result.project.nodes[0].analyse).toEqual({ mode: 'chem', chem: { op: 'descriptors' } });
    expect(result.warnings.some((warning) => /no record input wired/.test(warning.message))).toBe(true);
  });

  it('refuses an unknown mode and an unknown chem op', () => {
    const badMode = validateProject(project({ mode: 'vibrate' }));
    expect(badMode.errors.some((error) => /analyse\.mode/.test(error.path))).toBe(true);

    const badOp = validateProject(project({ mode: 'chem', chem: { op: 'similarity' } }));
    expect(badOp.errors.some((error) => /analyse\.chem\.op/.test(error.path))).toBe(true);
  });

  it('refuses field inputs on a descriptors block', () => {
    const result = validateProject(project({
      mode: 'chem',
      chem: { op: 'descriptors' },
      inputs: [{ name: 'x', field: 'tpsa', source: 'a1' }],
    }));
    expect(result.errors.some((error) => /analyse\.inputs/.test(error.path))).toBe(true);
  });
});
