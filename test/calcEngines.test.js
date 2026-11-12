import { describe, expect, it } from 'vitest';

import { calcEnginesIn, planToolNeeds } from '../src/shared/workflowTasks.js';

/**
 * Issue 316 — which engines a plan launches.
 *
 * Preflight used to demand a Gaussian executable for every workflow because the
 * engine it checked came from the project default, not from the plan. The queue
 * already scoped its own check to the plan's engines; this function is now the
 * single answer both callers use.
 */
describe('calcEnginesIn (issue 316)', () => {
  const task = (overrides) => ({ type: 'calculate', executable: true, engine: 'gaussian', ...overrides });

  it('names only the engines a calculation block will launch', () => {
    expect(calcEnginesIn([
      task({ engine: 'psi4' }),
      task({ engine: 'orca' }),
      task({ engine: 'psi4' }),
    ])).toEqual(['psi4', 'orca']);
  });

  it('ignores blocks that launch no engine', () => {
    expect(calcEnginesIn([
      { type: 'generate', executable: false },
      { type: 'note' },
      task({ engine: 'psi4' }),
    ])).toEqual(['psi4']);
  });

  it('ignores a calculate block a scorer answers instead of an engine', () => {
    expect(calcEnginesIn([task({ engine: 'gaussian', scorer: { spec: 'ml:aimnet2' } })])).toEqual([]);
  });

  it('is empty for a flow with no calculation block', () => {
    expect(calcEnginesIn([])).toEqual([]);
    expect(calcEnginesIn(undefined)).toEqual([]);
  });

  it('falls back to gaussian for a block that names no engine', () => {
    expect(calcEnginesIn([task({ engine: undefined })])).toEqual(['gaussian']);
  });
});

/**
 * Issue 361 — which companion executables a plan spawns. The run console used
 * to seed every tool field from PATH, so a project with no tautomer block still
 * showed a Python interpreter as a configured requirement.
 */
describe('planToolNeeds (issue 361)', () => {
  it('names the generator a conformer block will spawn', () => {
    expect(planToolNeeds([{ type: 'generate', executable: true, generate: { generator: 'crest', produces: 'conformers' } }]))
      .toEqual(['crest']);
    expect(planToolNeeds([{ type: 'generate', executable: true, generate: { generator: 'obabel', produces: 'conformers' } }]))
      .toEqual(['obabel']);
  });

  it('asks for the tautomer sidecar, not a conformer generator', () => {
    expect(planToolNeeds([{ type: 'generate', executable: true, generate: { generator: 'rdkit', produces: 'tautomers' } }]))
      .toEqual(['tautomer']);
  });

  it('asks for nothing when the search runs in-app or is imported', () => {
    expect(planToolNeeds([{ type: 'generate', executable: true, generate: { generator: 'uff', produces: 'conformers' } }]))
      .toEqual([]);
    expect(planToolNeeds([{ type: 'generate', executable: true, generate: { source: 'imported', produces: 'conformers' } }]))
      .toEqual([]);
  });

  it('names the scorer a calculate block hands its structure to', () => {
    expect(planToolNeeds([{ type: 'calculate', executable: true, engine: 'gaussian', scorer: { spec: 'ml:aimnet2' } }]))
      .toEqual(['scorer']);
  });

  it('names Multiwfn only for a multiwfn analysis', () => {
    expect(planToolNeeds([{ type: 'analyse', analyse: { mode: 'multiwfn' } }])).toEqual(['multiwfn']);
    expect(planToolNeeds([{ type: 'analyse', analyse: { mode: 'chem' } }])).toEqual(['chem']);
    expect(planToolNeeds([{ type: 'analyse', analyse: { mode: 'dp4' } }])).toEqual([]);
    expect(planToolNeeds([{ type: 'analyse', analyse: { mode: 'arithmetic' } }])).toEqual([]);
  });

  it('returns one entry per tool, in a stable order', () => {
    const tasks = [
      { type: 'generate', executable: true, generate: { generator: 'crest' } },
      { type: 'analyse', analyse: { mode: 'multiwfn' } },
      { type: 'calculate', executable: true, engine: 'xtb', scorer: { spec: 'ml:aimnet2' } },
      { type: 'generate', executable: true, generate: { generator: 'crest' } },
    ];
    expect(planToolNeeds(tasks)).toEqual(['crest', 'scorer', 'multiwfn']);
    expect(planToolNeeds([])).toEqual([]);
    expect(planToolNeeds(undefined)).toEqual([]);
  });
});
