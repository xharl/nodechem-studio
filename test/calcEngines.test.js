import { describe, expect, it } from 'vitest';

import { calcEnginesIn } from '../src/shared/workflowTasks.js';

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
