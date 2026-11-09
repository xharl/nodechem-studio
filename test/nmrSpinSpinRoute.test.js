import { describe, expect, it } from 'vitest';

import { routeFor } from '../src/shared/gaussianInput.js';
import { defaultSettings, validateProject } from '../src/shared/projectSchema.js';
import { jobKeywordFor } from '../src/shared/tsForceConstants.js';

/**
 * Issue 147: the spin-spin coupling tables only exist if the route asks for
 * them. A Gaussian NMR job writes `NMR` by default and `NMR=SpinSpin` when the
 * couplings are wanted; without this setting the results card could only report
 * that nothing was requested, which is honest but useless.
 *
 * The key is opt-in and absent by default: an NMR block saved before this
 * control existed must still write exactly `NMR`.
 */

const projectWith = (settings) => ({
  schemaVersion: 3,
  name: 'nmr couplings',
  molecule: {
    smiles: '',
    charge: 0,
    multiplicity: 1,
    fragments: [],
    coords: [
      { element: 'C', x: 0, y: 0, z: 0 },
      { element: 'H', x: 1.089, y: 0, z: 0 },
    ],
    geometry: { source: 'demo', file: '', format: '' },
  },
  defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
  runner: { maxParallel: 1 },
  datasets: [],
  flows: [{
    id: 'main',
    title: 'nmr',
    nodes: [{
      id: 'nmr',
      type: 'calculate',
      kind: 'SP',
      title: 'Shieldings',
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

describe('NMR spin-spin couplings on the route (issue 147)', () => {
  it('writes the bare keyword when the setting is off', () => {
    expect(jobKeywordFor({ jobType: 'NMR' })).toBe('NMR');
    expect(jobKeywordFor({ jobType: 'NMR', nmrSpinSpin: false })).toBe('NMR');
  });

  it('adds SpinSpin only when asked', () => {
    expect(jobKeywordFor({ jobType: 'NMR', nmrSpinSpin: true })).toBe('NMR=SpinSpin');
    const route = routeFor({ ...defaultSettings({ jobType: 'NMR' }), nmrSpinSpin: true });
    expect(route).toContain('NMR=SpinSpin');
    expect(route).not.toMatch(/\bNMR\b(?!\=SpinSpin)/);
  });

  it('survives a save, and is absent when never set', () => {
    const on = validateProject(projectWith({ ...defaultSettings({ jobType: 'NMR' }), nmrSpinSpin: true }));
    expect(on.errors).toEqual([]);
    expect(on.project.nodes[0].settings.nmrSpinSpin).toBe(true);

    const plain = validateProject(projectWith(defaultSettings({ jobType: 'NMR' })));
    expect(plain.errors).toEqual([]);
    expect('nmrSpinSpin' in plain.project.nodes[0].settings).toBe(false);
  });

  it('does not touch any other job type', () => {
    // A frequency job has no coupling table to print; the setting must not leak
    // a keyword into a route that cannot use it.
    const route = routeFor({ ...defaultSettings({ jobType: 'Freq' }), nmrSpinSpin: true });
    expect(route).not.toContain('SpinSpin');
  });
});
