import { describe, expect, it } from 'vitest';
import {
  buildCombinedReportHtml,
  buildWorkflowReport,
  workflowReportHtml,
} from '../src/shared/workflowReport.js';

/** Two records of one flow: m1 completed, m2 lost its frequency block. */
const QUEUE = {
  id: 'q-records',
  projectName: 'Enol family',
  flowId: 'barrier',
  flowTitle: 'Proton transfer barrier',
  status: 'partial',
  createdAt: '2026-11-08T00:00:00.000Z',
  finishedAt: '2026-11-08T00:10:00.000Z',
  tasks: [
    {
      nodeId: 'opt~m1', recordId: 'm1', flowId: 'barrier', type: 'calc', title: 'Optimise — one',
      kind: 'Opt', status: 'completed', runId: 'run-opt-1', gateVerdict: 'pass',
      record: { id: 'm1', label: 'acetylacetone', charge: 0, multiplicity: 1 },
    },
    {
      nodeId: 'sp~m1', recordId: 'm1', flowId: 'barrier', type: 'calc', title: 'SP — one',
      kind: 'SP', status: 'completed', runId: 'run-sp-1', gateVerdict: 'pass',
      record: { id: 'm1', label: 'acetylacetone', charge: 0, multiplicity: 1 },
    },
    {
      nodeId: 'opt~m2', recordId: 'm2', flowId: 'barrier', type: 'calc', title: 'Optimise — two',
      kind: 'Opt', status: 'completed', runId: 'run-opt-2', gateVerdict: 'pass',
      record: { id: 'm2', label: 'ethyl acetoacetate', charge: -1, multiplicity: 2 },
    },
    {
      nodeId: 'sp~m2', recordId: 'm2', flowId: 'barrier', type: 'calc', title: 'SP — two',
      kind: 'SP', status: 'failed', runId: 'run-sp-2', gateVerdict: 'fail',
      error: ' Error termination via Lnk1e', record: { id: 'm2', label: 'ethyl acetoacetate', charge: -1, multiplicity: 2 },
    },
    { nodeId: 'out1', type: 'output', flowId: 'barrier', title: 'Barrier table', status: 'completed' },
  ],
};

const RECORDS = {
  'run-opt-1': {
    id: 'run-opt-1', status: 'completed', engine: 'gaussian',
    provenance: { jobType: 'Opt', method: { functional: 'B3LYP', basis: 'def2-SVP' } },
    parsed: { finalEnergy: { hartree: -76.42 } }, gates: { overall: 'pass', validity: { overall: 'pass' } },
  },
  'run-sp-1': {
    id: 'run-sp-1', status: 'completed', engine: 'gaussian',
    provenance: { jobType: 'SP', method: { functional: 'B3LYP', basis: 'def2-SVP' } },
    parsed: { finalEnergy: { hartree: -76.4 } }, gates: { overall: 'pass', validity: { overall: 'pass' } },
  },
  'run-opt-2': {
    id: 'run-opt-2', status: 'completed', engine: 'gaussian',
    provenance: { jobType: 'Opt', method: { functional: 'B3LYP', basis: 'def2-SVP' } },
    parsed: { finalEnergy: { hartree: -76.43 } }, gates: { overall: 'pass', validity: { overall: 'pass' } },
  },
  'run-sp-2': {
    id: 'run-sp-2', status: 'failed', engine: 'gaussian',
    provenance: { jobType: 'SP', method: { functional: 'M06-2X', basis: 'def2-TZVP' } },
    parsed: {}, gates: { overall: 'fail', validity: { overall: 'unknown' } },
  },
};

function model() {
  return buildWorkflowReport(QUEUE, RECORDS, { generatedAt: '2026-11-08T02:00:00.000Z', appVersion: 'cli' });
}

describe('record-grouped report model', () => {
  it('groups rows per record and keeps the v1 shape when there are none', () => {
    const report = model();
    expect(report.records.map((record) => record.id)).toEqual(['m1', 'm2']);
    const [one, two] = report.records;
    expect(one).toMatchObject({
      label: 'acetylacetone', charge: 0, multiplicity: 1, status: 'completed', gates: 'pass',
    });
    expect(two).toMatchObject({
      label: 'ethyl acetoacetate', charge: -1, multiplicity: 2, status: 'partial', gates: 'fail',
    });
    expect(two.failedTasks.map((task) => task.nodeId)).toEqual(['sp~m2']);
    expect(two.failedTasks[0].error).toContain('Error termination');
    expect(two.methods).toEqual(['B3LYP/def2-SVP', 'M06-2X/def2-TZVP']);

    const v1 = buildWorkflowReport({ id: 'q', tasks: [{ nodeId: 'a', title: 'A', status: 'completed' }] }, {});
    expect(v1.records).toEqual([]);
  });

  it('reports the final energy per record and ΔE against the first completed one', () => {
    const report = model();
    const [one, two] = report.records;
    expect(one.finalEnergyHartree).toBeCloseTo(-76.4, 8);
    expect(two.finalEnergyHartree).toBeCloseTo(-76.43, 8);
    expect(one.relativeKcal).toBeCloseTo(0, 6);
    // The second record has no failed *energy* block (its SP died), so the
    // last energy it reported is the optimisation's; ΔE is against m1's final SP.
    expect(two.relativeKcal).toBeCloseTo((-76.43 - -76.4) * 627.5094740631, 4);
  });

  it('uses recordInfo for a label the tasks do not carry', () => {
    const bare = {
      ...QUEUE,
      tasks: QUEUE.tasks.map(({ record, ...task }) => task),
    };
    const report = buildWorkflowReport(bare, RECORDS, {
      recordInfo: [
        { id: 'm1', label: 'labelled one', charge: 0, multiplicity: 1 },
        { id: 'm2', label: 'labelled two', charge: -1, multiplicity: 2 },
      ],
    });
    expect(report.records.map((record) => record.label)).toEqual(['labelled one', 'labelled two']);
  });
});

describe('record-grouped report HTML', () => {
  it('prints the comparison table and one section per record', () => {
    const html = workflowReportHtml(model());
    expect(html).toContain('<h2>Records</h2>');
    expect(html).toContain('id="record-barrier-m1"');
    expect(html).toContain('id="record-barrier-m2"');
    expect(html).toContain('Record — acetylacetone');
    expect(html).toContain('Records needing attention');
    expect(html).toContain('ethyl acetoacetate');
    expect(html).toContain('ΔE / kcal mol⁻¹');
    // Both records' task tables are present, not one merged table.
    expect(html.match(/data-node="opt~m1"/g)).toHaveLength(1);
    expect(html.match(/data-node="opt~m2"/g)).toHaveLength(1);
  });
});

describe('combined report', () => {
  const barrier = model();
  const solvation = buildWorkflowReport({
    id: 'q-solv',
    projectName: 'Enol family',
    flowId: 'solvation',
    flowTitle: 'Solvation',
    status: 'completed',
    tasks: [
      {
        nodeId: 'sp~m1', recordId: 'm1', flowId: 'solvation', type: 'calc', title: 'SP — one',
        status: 'completed', runId: 'run-solv-1', gateVerdict: 'pass',
        record: { id: 'm1', label: 'acetylacetone', charge: 0, multiplicity: 1 },
      },
    ],
  }, {
    'run-solv-1': { id: 'run-solv-1', parsed: { finalEnergy: { hartree: -76.5 } }, gates: { overall: 'pass' } },
  }, { generatedAt: '2026-11-08T02:00:00.000Z' });

  it('writes one document with an index and an anchor per flow', () => {
    const html = buildCombinedReportHtml([barrier, solvation], { title: 'Enol project', generatedAt: '2026-11-08T03:00:00.000Z' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).toContain('<title>Enol project</title>');
    expect(html).toContain('id="flow-barrier"');
    expect(html).toContain('id="flow-solvation"');
    expect(html).toContain('href="#flow-barrier"');
    expect(html).toContain('href="#flow-solvation"');
    expect(html).toContain('Proton transfer barrier');
    expect(html).toContain('Solvation');
  });

  it('names failed and partial records in the index instead of hiding them', () => {
    const html = buildCombinedReportHtml([barrier, solvation], { title: 'Enol project' });
    const index = html.slice(html.indexOf('<h2>Index</h2>'), html.indexOf('id="flow-barrier"'));
    expect(index).toContain('ethyl acetoacetate');
    expect(index).toContain('partial');
    expect(index).toContain('2 record(s): 1 completed, 1 needing attention');
  });

  it('tolerates an empty list', () => {
    const html = buildCombinedReportHtml([], { title: 'Empty' });
    expect(html).toContain('<h1>Empty</h1>');
    expect(html).not.toMatch(/<script/i);
  });
});
