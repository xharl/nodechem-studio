import { describe, expect, it } from 'vitest';

import { defaultSettings, validateProject } from '../src/shared/projectSchema.js';

/**
 * A settings key can be listed in `SETTINGS_KEYS` — silencing the unknown-key
 * warning — and still be dropped on save, because the warning list and the
 * normaliser are two different places. Two features shipped in exactly that
 * state: issue 174's core-correlation choice and issue 173's transition-dipole
 * opt-in. The block ran without the setting the user made, and nothing said so.
 *
 * This is the same defect class as issue 181 (the inspector list, the engine's
 * job types and the validator's enum were three separate truths), so it gets the
 * same treatment: a test that would fail if the key stopped surviving a save.
 */

const projectWith = (settings) => ({
  schemaVersion: 3,
  name: 'settings persistence',
  molecule: {
    smiles: '',
    charge: 0,
    multiplicity: 1,
    fragments: [],
    coords: [
      { element: 'O', x: 0, y: 0, z: 0 },
      { element: 'H', x: 0.9572, y: 0, z: 0 },
      { element: 'H', x: -0.24, y: 0.927, z: 0 },
    ],
    geometry: { source: 'demo', file: '', format: '' },
  },
  defaults: { method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: '4' },
  runner: { maxParallel: 1 },
  datasets: [],
  flows: [{
    id: 'main',
    title: 'persistence',
    nodes: [{
      id: 'sp',
      type: 'calculate',
      kind: 'SP',
      title: 'Single point',
      state: 'ready',
      x: 0,
      y: 0,
      settings,
      output: null,
      checkpointFrom: null,
    }],
    edges: [],
  }],
  reports: [],
  activeFlowId: 'main',
});

const roundTrip = (settings) => {
  const result = validateProject(projectWith(settings));
  expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
  return result.project.nodes[0].settings;
};

describe('an optional settings key survives save and reload', () => {
  it('keeps the core-correlation choice (issue 174)', () => {
    for (const value of ['auto', 'true', 'false']) {
      const saved = roundTrip({ ...defaultSettings({ engine: 'psi4', jobType: 'SP', method: 'MP2' }), freezeCore: value });
      expect(saved.freezeCore).toBe(value);
    }
  });

  it('keeps the transition-dipole opt-in (issue 173)', () => {
    for (const value of [true, false]) {
      const saved = roundTrip({ ...defaultSettings({ engine: 'psi4', jobType: 'TD-DFT' }), recordTransitionDipoles: value });
      expect(saved.recordTransitionDipoles).toBe(value);
    }
  });

  it('keeps the per-block wall-clock limit (issue 177)', () => {
    const saved = roundTrip({ ...defaultSettings({ jobType: 'SP' }), timeoutSeconds: 900 });
    expect(saved.timeoutSeconds).toBe(900);
  });

  it('refuses a malformed choice rather than dropping it', () => {
    const bad = validateProject(projectWith({
      ...defaultSettings({ engine: 'psi4', jobType: 'SP', method: 'MP2' }),
      freezeCore: 'all-electron',
    }));
    expect(bad.errors.some((error) => error.path.endsWith('settings.freezeCore'))).toBe(true);
  });

  it('writes no key at all when the caller never set one', () => {
    const saved = roundTrip(defaultSettings({ engine: 'psi4', jobType: 'TD-DFT' }));
    expect('freezeCore' in saved).toBe(false);
    expect('recordTransitionDipoles' in saved).toBe(false);
    expect('timeoutSeconds' in saved).toBe(false);
  });
});
