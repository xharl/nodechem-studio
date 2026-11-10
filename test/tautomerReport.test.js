import { describe, expect, it } from 'vitest';

import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';

/**
 * Issue #226 — the report has to show the energy spread across the candidate
 * set, and it must not average across tautomers. These tests build the report
 * from a fanned-out queue record: three candidates, three single-point runs at
 * the same level, three final energies.
 */

const HARTREE_KCAL = 627.5094740631;

const memberTask = (id, tautomer, smiles, runId) => ({
  nodeId: `sp~${id}`,
  title: `Single point — ${id} (${tautomer})`,
  type: 'calculate',
  kind: 'SP',
  status: 'passed',
  attempts: 1,
  gateVerdict: 'pass',
  runId,
  runDir: `/runs/${runId}`,
  conformer: {
    nodeId: 'gen',
    title: 'Tautomers of acetylacetone',
    id,
    relativeKcal: null,
    population: null,
    protomer: '',
    produces: 'tautomers',
    tautomer,
    smiles,
  },
  fanOut: { conformerId: 'gen', memberId: id },
});

const record = (runId, hartree) => ({
  id: runId,
  engine: 'gaussian',
  dryRun: false,
  provenance: { jobType: 'SP', method: { functional: 'B3LYP', basis: 'def2-SVP' } },
  parsed: { finalEnergy: { hartree } },
  gates: { overall: 'pass', validity: { overall: 'pass' } },
});

const M1 = memberTask('c1', 't1', 'C=C(O)C=C(C)O', 'run-c1');
const M2 = memberTask('c2', 't2', 'C=C(O)CC(=O)C', 'run-c2');
const M3 = memberTask('c3', 't3', 'CC(=O)CC(C)=O', 'run-c3');

const queue = {
  id: 'q-tautomers',
  projectName: 'Tautomer spread',
  status: 'completed',
  tasks: [
    {
      nodeId: 'gen',
      title: 'Tautomers of acetylacetone',
      type: 'generate',
      kind: 'Generate',
      status: 'completed',
      generate: { produces: 'tautomers', generator: 'rdkit', maxConformers: 16, tautomerRuleset: 'rdkit-default' },
    },
    M1,
    M2,
    M3,
  ],
};

const records = {
  'run-c1': record('run-c1', -100.0),
  'run-c2': record('run-c2', -99.996),
  'run-c3': record('run-c3', -99.992),
};

describe('tautomer spread in the workflow report (#226)', () => {
  const model = buildWorkflowReport(queue, records, { generatedAt: '2026-11-09T00:00:00.000Z' });
  const ensemble = model.conformers[0];

  it('models the candidate set as tautomers and keeps every label', () => {
    expect(model.conformers).toHaveLength(1);
    expect(ensemble.produces).toBe('tautomers');
    expect(ensemble.comparable).toBe(true);
    expect(ensemble.members.map((member) => member.tautomer)).toEqual(['t1', 't2', 't3']);
    expect(ensemble.tautomerLabels).toEqual(['t1', 't2', 't3']);
    expect(ensemble.members.map((member) => member.smiles)).toEqual([
      'C=C(O)C=C(C)O', 'C=C(O)CC(=O)C', 'CC(=O)CC(C)=O',
    ]);
    // No search-level ΔE exists for an enumerated candidate.
    expect(ensemble.members.every((member) => member.relativeKcalSearch === null)).toBe(true);
    expect(ensemble.members.every((member) => member.population === null)).toBe(true);
  });

  it('reports the spread across the candidate set, from the target-level runs', () => {
    expect(ensemble.tautomerSpread.available).toBe(true);
    expect(ensemble.tautomerSpread.count).toBe(3);
    expect(ensemble.tautomerSpread.kcal).toBeCloseTo(0.008 * HARTREE_KCAL, 6);
    expect(ensemble.tautomerSpread.lowestMemberId).toBe('c1');
    expect(ensemble.tautomerSpread.highestMemberId).toBe('c3');
    expect(ensemble.spreadKcalTarget).toBeCloseTo(0.008 * HARTREE_KCAL, 6);
  });

  it('never Boltzmann-averages across tautomers', () => {
    expect(ensemble.ensemble.available).toBe(false);
    expect(ensemble.ensemble.reason).toMatch(/tautomer candidates/);
    expect(ensemble.ensemble.reason).toMatch(/not ensemble-averaged/);
  });

  it('prints the spread and the refusal to average', () => {
    const html = workflowReportHtml(model);
    expect(html).toContain('Tautomer candidates at the target level');
    expect(html).toContain('Energy spread across the candidate set');
    expect(html).toContain('5.02 kcal/mol');
    expect(html).toContain('C=C(O)C=C(C)O');
    expect(html).toContain('tautomer candidates — distinct molecules');
    expect(html).toContain('Tautomer candidates (3): t1, t2, t3');
    // No "ensemble-averaged" block for a tautomer set, and no population table.
    expect(html).not.toContain('data-field="ensemble-observables"');
    expect(html).not.toContain('Conformer ensemble at the target level');
  });

  it('refuses the spread when one candidate has no final energy', () => {
    const partial = buildWorkflowReport(queue, {
      'run-c1': record('run-c1', -100.0),
      'run-c2': { ...record('run-c2', -99.996), parsed: {} },
      'run-c3': record('run-c3', -99.992),
    });
    const partialEnsemble = partial.conformers[0];
    expect(partialEnsemble.tautomerSpread.available).toBe(false);
    expect(partialEnsemble.tautomerSpread.reason).toMatch(/c2/);
    const html = workflowReportHtml(partial);
    expect(html).toContain('Spread across the candidate set: not reported');
  });

  it('leaves a conformer ensemble untouched', () => {
    const conformerQueue = {
      ...queue,
      tasks: queue.tasks.map((task) => (task.type === 'calculate'
        ? {
          ...task,
          conformer: {
            ...task.conformer,
            produces: undefined,
            tautomer: undefined,
            smiles: undefined,
            relativeKcal: 0,
            population: 0.5,
          },
          fanOut: { conformerId: 'conf', memberId: task.conformer.id },
        }
        : task)),
    };
    const conformerModel = buildWorkflowReport(conformerQueue, records);
    const conformers = conformerModel.conformers[0];
    expect(conformers.produces).toBe('conformers');
    expect(conformers.tautomerSpread).toBeNull();
    expect(conformers.tautomerLabels).toEqual([]);
    const html = workflowReportHtml(conformerModel);
    expect(html).toContain('Conformer ensemble at the target level');
    expect(html).not.toContain('Energy spread across the candidate set');
  });
});
