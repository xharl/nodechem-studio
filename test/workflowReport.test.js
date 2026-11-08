import { describe, expect, it } from 'vitest';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';

const QUEUE = {
  id: 'q-20261108-0100',
  projectName: 'Diels–Alder TS',
  status: 'completed',
  createdAt: '2026-11-08T01:00:00.000Z',
  finishedAt: '2026-11-08T01:12:00.000Z',
  tasks: [
    {
      nodeId: 'opt',
      title: 'Optimise reactant',
      type: 'calc',
      kind: 'Opt',
      status: 'passed',
      attempts: 1,
      gateVerdict: 'pass',
      runId: 'run-opt',
      runDir: '/runs/run-opt',
    },
    {
      nodeId: 'freq',
      title: 'Reactant frequency',
      type: 'calc',
      kind: 'Freq',
      status: 'failed',
      attempts: 2,
      gateVerdict: 'fail',
      runId: 'run-freq',
      runDir: '/runs/run-freq',
      error: 'Imaginary mode present',
    },
    { nodeId: 'note', title: 'Note', type: 'note', status: 'skipped' },
  ],
};

const RECORDS = {
  'run-opt': {
    id: 'run-opt',
    engine: 'gaussian',
    dryRun: false,
    elapsedSeconds: 30,
    inputSha256: 'a'.repeat(64),
    outputSha256: 'b'.repeat(64),
    provenance: { jobType: 'Opt', method: { functional: 'B3LYP', basis: 'def2-SVP' } },
    parsed: {
      finalEnergy: { hartree: -76.4 },
      thermochemistry: { freeEnergyHartree: -76.3 },
      frequencies: { imaginaryCount: 0 },
      resources: { elapsedSeconds: 29.4 },
    },
    gates: { overall: 'pass', validity: { overall: 'pass' } },
  },
  'run-freq': {
    id: 'run-freq',
    engine: 'gaussian',
    dryRun: true,
    elapsedSeconds: 12,
    provenance: { jobType: 'Freq', method: { functional: 'B3LYP', basis: 'def2-SVP' } },
    parsed: {
      finalEnergy: { hartree: -76.4 },
      frequencies: { imaginaryCount: 1 },
    },
    gates: { overall: 'fail', validity: { overall: 'fail' } },
  },
};

describe('workflow report model', () => {
  const model = buildWorkflowReport(QUEUE, RECORDS, {
    generatedAt: '2026-11-08T02:00:00.000Z',
    appVersion: '0.2.1',
  });

  it('counts tasks and derives the overall verdict', () => {
    expect(model.counts.total).toBe(3);
    expect(model.counts.passed).toBe(1);
    expect(model.counts.failed).toBe(1);
    expect(model.counts.skipped).toBe(1);
    expect(model.verdict).toBe('fail');
  });

  it('joins each task to its run record', () => {
    const opt = model.tasks.find((row) => row.nodeId === 'opt');
    expect(opt.method).toBe('B3LYP');
    expect(opt.basis).toBe('def2-SVP');
    expect(opt.finalEnergyHartree).toBeCloseTo(-76.4, 6);
    expect(opt.gibbsHartree).toBeCloseTo(-76.3, 6);
    expect(opt.inputSha256).toBe('a'.repeat(64));
  });

  it('marks a fixture task and leaves a task without a record unreported', () => {
    expect(model.tasks.find((row) => row.nodeId === 'freq').dryRun).toBe(true);
    expect(model.fixtures).toBe(1);
    const note = model.tasks.find((row) => row.nodeId === 'note');
    expect(note.finalEnergyHartree).toBeNull();
    expect(note.method).toBeNull();
  });

  it('tolerates an empty or malformed queue', () => {
    expect(buildWorkflowReport(null).counts.total).toBe(0);
    expect(buildWorkflowReport({}).verdict).toBe('unknown');
    expect(buildWorkflowReport({ tasks: 'nope' }).tasks).toEqual([]);
  });
});

describe('workflow report HTML', () => {
  const model = buildWorkflowReport(QUEUE, RECORDS, { appVersion: '0.2.1' });
  const html = workflowReportHtml(model);

  it('is a self-contained document with no scripts or network calls', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).toContain('<style>');
  });

  it('states what ran, what came out and whether it holds', () => {
    expect(html).toContain('Optimise reactant');
    expect(html).toContain('Reactant frequency');
    expect(html).toContain('-76.40000000');
    expect(html).toContain('Gate verdict: <strong>fail</strong>');
    expect(html).toContain('Imaginary mode present');
    expect(html).toContain('FIXTURE');
    expect(html).toContain('1 task ran as a labelled fixture');
  });

  it('prints an unreported value as "not reported", never zero', () => {
    expect(html).toContain('not reported');
    // The note task has no run record: every numeric cell in its row is unreported.
    const noteRow = html.slice(html.indexOf('data-node="note"'), html.indexOf('</tr>', html.indexOf('data-node="note"')));
    expect(noteRow).toContain('not reported');
    expect(noteRow).not.toMatch(/>0</);
  });

  it('escapes project and task text', () => {
    const hostile = buildWorkflowReport({
      ...QUEUE,
      projectName: '<img onerror=x>',
      tasks: [{ nodeId: 'a', title: '<script>alert(1)</script>', status: 'passed' }],
    });
    const rendered = workflowReportHtml(hostile);
    expect(rendered).not.toContain('<img onerror=x>');
    expect(rendered).not.toContain('<script>alert(1)</script>');
    expect(rendered).toContain('&lt;img onerror=x&gt;');
  });

  it('embeds the methods paragraph when a generator is supplied', () => {
    const withMethods = workflowReportHtml(model, {
      methodsFor: (row) => (row.nodeId === 'opt' ? 'All calculations used B3LYP/def2-SVP.' : null),
    });
    expect(withMethods).toContain('All calculations used B3LYP/def2-SVP.');
    expect(withMethods).toContain('<details>');
    expect(workflowReportHtml(model)).not.toContain('<details>');
  });

  it('returns an empty string for a missing model', () => {
    expect(workflowReportHtml(null)).toBe('');
  });
});
