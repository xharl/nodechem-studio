import { describe, expect, it } from 'vitest';

import { JOB_TYPES, defaultSettings, validateProject } from '../src/shared/projectSchema.js';
import { listEngines } from '../src/shared/engines/registry.js';
import { PSI4_JOB_TYPES } from '../src/shared/engines/psi4.js';

/**
 * Issue 181: an engine job type that is selectable and runnable but missing from
 * `JOB_TYPES` produces a project that can be started and never saved — the
 * validator is the only list that matters, and it is not the list the inspector
 * reads. TD-DFT shipped in that state (issue 166): the block ran, entering
 * Psi4's Davidson solver, and Save refused with the enum message.
 *
 * The two lists are now held together here, so adding an engine job type without
 * registering it fails a test instead of failing a user's save.
 */

const engineJobTypes = () => {
  const seen = new Map();
  for (const entry of listEngines()) {
    const id = entry.id ?? entry.engineId ?? '(unnamed engine)';
    const list = Array.isArray(entry?.jobTypes) ? entry.jobTypes : [];
    for (const jobType of list) {
      if (!seen.has(jobType)) seen.set(jobType, []);
      seen.get(jobType).push(id);
    }
  }
  return seen;
};

describe('issue 181 — the schema enum covers every engine job type', () => {
  it('every job type an engine offers is in JOB_TYPES', () => {
    const missing = [...engineJobTypes().entries()]
      .filter(([jobType]) => !JOB_TYPES.includes(jobType))
      .map(([jobType, engines]) => `${jobType} (${engines.join(', ')})`);
    expect(missing, `engine job types missing from JOB_TYPES: ${missing.join('; ')}`).toEqual([]);
  });

  it('carries TD-DFT, which Psi4 offers and the validator used to refuse', () => {
    expect(PSI4_JOB_TYPES).toContain('TD-DFT');
    expect(JOB_TYPES).toContain('TD-DFT');
  });

  it('does not carry duplicate entries', () => {
    expect(new Set(JOB_TYPES).size).toBe(JOB_TYPES.length);
  });

  it('saves and reloads a Psi4 TD-DFT block', () => {
    // The reproduction from the issue, through the same validator Save uses.
    const result = validateProject({
      schemaVersion: 3,
      name: 'TD-DFT save',
      molecule: {
        smiles: '', charge: 0, multiplicity: 1, fragments: [], coords: [],
        geometry: { source: 'demo', file: '', format: '' },
      },
      defaults: { method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: '4' },
      runner: { maxParallel: 1 },
      datasets: [],
      flows: [{
        id: 'main',
        title: 'TD-DFT',
        nodes: [{
          id: 'td', type: 'calculate', kind: 'SP', title: 'Excited states', state: 'ready', x: 0, y: 0,
          settings: defaultSettings({ engine: 'psi4', jobType: 'TD-DFT', tdStates: 12 }),
          output: null,
          checkpointFrom: null,
        }],
        edges: [],
      }],
      reports: [],
      activeFlowId: 'main',
    });

    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    expect(result.project.nodes[0].settings.jobType).toBe('TD-DFT');
    expect(result.project.nodes[0].settings.engine).toBe('psi4');
  });
});
