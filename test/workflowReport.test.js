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
      type: 'calculate',
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
      type: 'calculate',
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

describe('conformer fan-out in the report (#80)', () => {
  const queue = {
    id: 'q-fanout',
    projectName: 'Fan-out',
    status: 'completed',
    tasks: [
      {
        nodeId: 'opt~c1', title: 'Optimise — c1', type: 'calculate', kind: 'Opt', status: 'passed', runId: 'run-c1',
        conformer: { nodeId: 'conf', title: 'Conformer ensemble', id: 'c1', relativeKcal: 0, population: 0.94, protomer: '' },
        fanOut: { conformerId: 'conf', memberId: 'c1' },
      },
      {
        nodeId: 'opt~c2', title: 'Optimise — c2', type: 'calculate', kind: 'Opt', status: 'passed', runId: 'run-c2',
        conformer: { nodeId: 'conf', title: 'Conformer ensemble', id: 'c2', relativeKcal: 3.4, population: 0.06, protomer: '' },
        fanOut: { conformerId: 'conf', memberId: 'c2' },
      },
    ],
  };
  const records = {
    'run-c1': { parsed: { finalEnergy: { hartree: -76.4 } } },
    'run-c2': { parsed: { finalEnergy: { hartree: -76.3946 } } },
  };

  it('groups the members and recomputes ΔE at the target level', () => {
    const model = buildWorkflowReport(queue, records);
    expect(model.conformers).toHaveLength(1);
    const ensemble = model.conformers[0];
    expect(ensemble.id).toBe('conf');
    expect(ensemble.members.map((member) => member.memberId)).toEqual(['c1', 'c2']);
    expect(ensemble.members[0].relativeKcalTarget).toBeCloseTo(0, 6);
    // Search level said 3.40; the target level says what the runs actually found.
    expect(ensemble.members[1].relativeKcalSearch).toBeCloseTo(3.4, 6);
    expect(ensemble.members[1].relativeKcalTarget).toBeCloseTo(3.3886, 3);
    expect(ensemble.spreadKcalTarget).toBeCloseTo(3.3886, 3);
  });

  it('names the member in the task table and prints the target-level table', () => {
    const html = workflowReportHtml(buildWorkflowReport(queue, records));
    expect(html).toContain('member c1');
    expect(html).toContain('member c2');
    expect(html).toContain('Conformer ensemble at the target level');
    expect(html).toContain('ΔE search');
    expect(html).toContain('3.39');
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

describe('method sensitivity in the report (#96)', () => {
  const HARTREE_KCAL = 627.5094740631;
  const scfAt = () => -76;
  const corrAt = (x) => -0.3 + 2.0 * x ** -3;
  const totalAt = (x) => scfAt(x) + corrAt(x);

  const cbsQueue = () => ({
    id: 'q-cbs',
    projectName: 'CBS',
    status: 'completed',
    tasks: [
      { nodeId: 'sp.r1', title: 'MP2 — def2-TZVP', type: 'calculate', status: 'completed', runId: 'r1' },
      { nodeId: 'sp.r2', title: 'MP2 — def2-QZVP', type: 'calculate', status: 'completed', runId: 'r2' },
    ],
    ladders: {
      sp: {
        status: 'pass',
        toleranceKcal: 3,
        spreadKcal: (totalAt(3) - totalAt(4)) * HARTREE_KCAL,
        reason: 'Spread is within tolerance.',
        entries: [
          { id: 'sp.r1', label: 'Rung 1', energyHartree: totalAt(3), relativeKcalPerMol: 0 },
          { id: 'sp.r2', label: 'Rung 2', energyHartree: totalAt(4), relativeKcalPerMol: (totalAt(4) - totalAt(3)) * HARTREE_KCAL },
        ],
      },
    },
  });
  const cbsRecords = () => ({
    r1: {
      id: 'r1',
      provenance: { jobType: 'SP', method: { functional: 'MP2', basis: 'def2-TZVP' } },
      parsed: { finalEnergy: { hartree: totalAt(3) }, scf: { energyHartree: scfAt(3) } },
    },
    r2: {
      id: 'r2',
      provenance: { jobType: 'SP', method: { functional: 'MP2', basis: 'def2-QZVP' } },
      parsed: { finalEnergy: { hartree: totalAt(4) }, scf: { energyHartree: scfAt(4) } },
    },
  });

  it('computes a CBS estimate from the ladder and names the form, the exponents and the pair', () => {
    const model = buildWorkflowReport(cbsQueue(), cbsRecords());
    const ladder = model.ladders[0];
    expect(ladder.cbs.available).toBe(true);
    expect(ladder.cbs.form).toMatch(/Helgaker two-point/);
    expect(ladder.cbs.exponents).toEqual({ correlation: 3 });
    expect(ladder.cbs.energyHartree).toBeCloseTo(-76.3, 9);
    expect(ladder.cbs.pair.lower.basis).toBe('def2-TZVP');
    expect(ladder.cbs.pair.upper.basis).toBe('def2-QZVP');
    expect(ladder.entries.map((entry) => entry.method)).toEqual(['MP2', 'MP2']);
    expect(ladder.entries.map((entry) => entry.basis)).toEqual(['def2-TZVP', 'def2-QZVP']);

    const html = workflowReportHtml(model);
    expect(html).toContain('CBS estimate');
    expect(html).toContain('Helgaker two-point');
    expect(html).toContain('def2-TZVP → def2-QZVP');
    expect(html).toContain('-76.30000000');
    expect(html).toMatch(/spread [0-9.]+ kcal\/mol over 2 rungs/);
  });

  it('prints not reported and names the missing rung when the ladder has only one', () => {
    const queue = cbsQueue();
    queue.tasks = queue.tasks.slice(0, 1);
    queue.ladders.sp.entries = queue.ladders.sp.entries.slice(0, 1);
    queue.ladders.sp.status = 'unknown';
    const model = buildWorkflowReport(queue, cbsRecords());
    expect(model.ladders[0].cbs.available).toBe(false);
    expect(model.ladders[0].cbs.reason).toMatch(/second rung/);
    const html = workflowReportHtml(model);
    expect(html).toContain('CBS not reported');
    expect(html).toMatch(/second rung is required/);
  });

  const conformerQueue = () => ({
    id: 'q-ensemble',
    projectName: 'Ensemble',
    status: 'completed',
    tasks: [
      { nodeId: 'conf', title: 'Conformer ensemble', type: 'generate', status: 'completed', generate: { temperature: 298.15 } },
      {
        nodeId: 'opt~c1', title: 'Optimise — c1', type: 'calculate', status: 'completed', runId: 'run-c1',
        conformer: { nodeId: 'conf', title: 'Conformer ensemble', id: 'c1', relativeKcal: 0, population: 0.94, protomer: '' },
        fanOut: { conformerId: 'conf', memberId: 'c1' },
      },
      {
        nodeId: 'opt~c2', title: 'Optimise — c2', type: 'calculate', status: 'completed', runId: 'run-c2',
        conformer: { nodeId: 'conf', title: 'Conformer ensemble', id: 'c2', relativeKcal: 3.4, population: 0.06, protomer: '' },
        fanOut: { conformerId: 'conf', memberId: 'c2' },
      },
    ],
  });
  const conformerRecords = () => ({
    'run-c1': {
      parsed: { finalEnergy: { hartree: -76.4 }, orbitals: { alpha: { gapEv: 5.0 } } },
    },
    'run-c2': {
      parsed: { finalEnergy: { hartree: -76.3946 }, orbitals: { alpha: { gapEv: 4.6 } } },
    },
  });

  it('reports the Boltzmann population table and the ensemble-averaged observables with their spread', () => {
    const model = buildWorkflowReport(conformerQueue(), conformerRecords());
    const ensemble = model.conformers[0];
    expect(ensemble.members.map((member) => member.population)).toEqual([0.94, 0.06]);
    expect(ensemble.ensemble.available).toBe(true);
    expect(ensemble.ensemble.label).toBe('ensemble-averaged');
    expect(ensemble.ensemble.temperatureK).toBe(298.15);
    const energy = ensemble.ensemble.observables.find((entry) => entry.key === 'energyHartree');
    expect(energy.weightedMean).toBeCloseTo(0.94 * -76.4 + 0.06 * -76.3946, 10);
    expect(energy.spread).toBeCloseTo(0.0054, 10);
    expect(energy.over).toMatch(/2 retained conformers/);
    const gap = ensemble.ensemble.observables.find((entry) => entry.key === 'gapEv');
    expect(gap.weightedMean).toBeCloseTo(0.94 * 5.0 + 0.06 * 4.6, 10);
    expect(gap.unit).toBe('eV');

    const html = workflowReportHtml(model);
    expect(html).toContain('ensemble-averaged');
    expect(html).toContain('94%');
    expect(html).toContain('Population');
    expect(html).toMatch(/spread [0-9.]+ eV over 2 retained conformers/);
  });

  it('does not weight a group with a missing member energy', () => {
    const records = conformerRecords();
    records['run-c2'].parsed.finalEnergy.hartree = null;
    const model = buildWorkflowReport(conformerQueue(), records);
    expect(model.conformers[0].ensemble.available).toBe(false);
    expect(model.conformers[0].ensemble.reason).toMatch(/energy/);
    const html = workflowReportHtml(model);
    expect(html).toContain('not ensemble-averaged');
  });
});

describe('method ladders in the report', () => {
  it('prints one spread table per ladder and its verdict', async () => {
    const { buildWorkflowReport, workflowReportHtml } = await import('../src/shared/workflowReport.js');
    const queue = {
      id: 'q-ladder',
      projectName: 'Ladder',
      status: 'completed',
      createdAt: '2026-11-08T00:00:00Z',
      finishedAt: '2026-11-08T00:10:00Z',
      tasks: [{ nodeId: 'sp.r1', title: 'SP — B3LYP', status: 'completed', runId: 'r1' }],
      ladders: {
        sp: {
          status: 'fail',
          toleranceKcal: 3,
          spreadKcal: 12.551,
          reason: 'Spread 12.55 kcal/mol is above the 3 kcal/mol tolerance.',
          entries: [
            { id: 'sp.r1', label: 'B3LYP', energyHartree: -76.4, relativeKcalPerMol: 0 },
            { id: 'sp.r2', label: 'PBE0', energyHartree: -76.42, relativeKcalPerMol: 12.55 },
          ],
        },
      },
    };
    const model = buildWorkflowReport(queue, {});
    expect(model.ladders).toHaveLength(1);
    expect(model.ladders[0]).toMatchObject({ id: 'sp', status: 'fail', spreadKcal: 12.551 });
    const html = workflowReportHtml(model);
    expect(html).toContain('Method ladder — sp');
    expect(html).toContain('PBE0');
    expect(html).toContain('12.55');
    expect(html).toContain('gates-fail');
  });
});

/**
 * Issue #355: the queue writes `task.history` on every retry reset, and until
 * now the report dropped it — a block that failed twice and passed on the third
 * attempt printed a row identical to a first-try pass.
 */
describe('retry history in the report (#355)', () => {
  const retryQueue = () => ({
    id: 'q-retry',
    projectName: 'Retried deck',
    status: 'completed',
    createdAt: '2026-11-08T01:00:00.000Z',
    finishedAt: '2026-11-08T01:20:00.000Z',
    tasks: [
      {
        nodeId: 'opt-retry',
        title: 'Optimise TS',
        type: 'calculate',
        kind: 'Opt',
        status: 'completed',
        attempts: 3,
        gateVerdict: 'pass',
        runId: 'run-3',
        finishedAt: '2026-11-08T01:18:00.000Z',
        history: [
          { runId: 'run-1', status: 'failed', gateVerdict: 'fail', finishedAt: '2026-11-08T01:05:00.000Z' },
          { runId: 'run-2', status: 'needs-review', gateVerdict: 'unknown', finishedAt: '2026-11-08T01:11:00.000Z' },
        ],
      },
      {
        nodeId: 'sp-first',
        title: 'Single point',
        type: 'calculate',
        kind: 'SP',
        status: 'completed',
        attempts: 1,
        gateVerdict: 'pass',
        runId: 'run-sp',
        history: [],
      },
      // A v1 queue.json: the field does not exist, which is not evidence of a retry.
      {
        nodeId: 'freq-v1', title: 'Frequency (v1 record)', type: 'calculate', status: 'completed',
        attempts: 1, gateVerdict: 'pass',
      },
    ],
  });

  const records = () => ({
    'run-3': { parsed: { finalEnergy: { hartree: -76.4 } } },
    'run-1': { parsed: { finalEnergy: { hartree: -76.39 } } },
  });

  it('carries the queue history as copies and counts every attempt', () => {
    const queue = retryQueue();
    const model = buildWorkflowReport(queue, records());
    const retried = model.tasks.find((row) => row.nodeId === 'opt-retry');
    expect(retried.history).toHaveLength(2);
    expect(retried.history.map((entry) => entry.status)).toEqual(['failed', 'needs-review']);
    expect(retried.history.map((entry) => entry.runId)).toEqual(['run-1', 'run-2']);
    expect(retried.attemptCount).toBe(3);
    expect(model.retries).toMatchObject({ tasks: 1, extraAttempts: 2, withHistory: 1 });

    // The model holds copies: mutating the queue after the build changes nothing.
    queue.tasks[0].history[0].status = 'completed';
    queue.tasks[0].history.push({ runId: 'run-9', status: 'completed' });
    expect(retried.history.map((entry) => entry.status)).toEqual(['failed', 'needs-review']);
    expect(retried.history).toHaveLength(2);
  });

  it('renders both failed attempts and the final passing verdict for a third-try pass', () => {
    const html = workflowReportHtml(buildWorkflowReport(retryQueue(), records()));
    expect(html).toContain('<summary>3 attempts</summary>');
    // Three attempt rows: the two resets from `history` and the run in the table.
    expect(html.match(/<tr data-attempt="/g)).toHaveLength(3);
    expect(html).toContain('data-attempt="1"');
    expect(html).toContain('data-attempt="2"');
    expect(html).toContain('data-attempt="3"');
    // The earlier attempts keep the outcome the queue recorded for them.
    expect(html).toContain('<td>failed</td>');
    expect(html).toContain('<td>needs-review</td>');
    expect(html).toContain('<td class="mono">run-1</td>');
    expect(html).toContain('<td class="mono">run-2</td>');
    // The final attempt row carries the passing verdict, not the earlier failures.
    const finalRow = html.slice(html.indexOf('data-attempt="3"'), html.indexOf('</tr>', html.indexOf('data-attempt="3"')));
    expect(finalRow).toContain('completed');
    expect(finalRow).toContain('gates-pass');
    expect(finalRow).toContain('run-3');
    // The Attempts cell links to the list instead of just printing a bare number.
    expect(html).toContain('href="#attempts-opt-retry"');
    expect(html).toContain('3</a> <span class="sub">see history</span>');
  });

  it('leaves a first-try pass and a v1 record undecorated', () => {
    const model = buildWorkflowReport(retryQueue(), records());
    const first = model.tasks.find((row) => row.nodeId === 'sp-first');
    expect(first.attemptCount).toBe(1);
    expect(first.history).toEqual([]);
    const v1 = model.tasks.find((row) => row.nodeId === 'freq-v1');
    expect(v1.history).toBeNull();
    expect(v1.attemptCount).toBe(1);

    const html = workflowReportHtml(model);
    expect(html).not.toContain('attempts-sp-first');
    expect(html).not.toContain('attempts-freq-v1');
    expect(html.match(/<details/g)).toHaveLength(1);
    // The column is present for every row; only the retried row is a link.
    expect(html).toContain('<th>Attempts</th>');
    expect(html.match(/href="#attempts-/g)).toHaveLength(1);
  });

  it('states the retry count in the Outcome summary', () => {
    const html = workflowReportHtml(buildWorkflowReport(retryQueue(), records()));
    expect(html).toContain('data-field="retries"');
    expect(html).toContain('<strong>1</strong> task(s) needed more than one attempt (2 extra attempts recorded)');
  });

  it('counts a retried task with no history without inventing an attempt list', () => {
    const queue = retryQueue();
    delete queue.tasks[0].history;
    const model = buildWorkflowReport(queue, records());
    expect(model.tasks[0].history).toBeNull();
    expect(model.tasks[0].attemptCount).toBe(3);
    expect(model.retries).toMatchObject({ tasks: 1, extraAttempts: 2, withHistory: 0 });

    const html = workflowReportHtml(model);
    expect(html).not.toContain('<details');
    expect(html).toContain('history not recorded');
    expect(html).toContain('the queue recorded no attempt history for 1 of them');
  });

  it('keeps the queue bound of 20 attempts and says what it dropped', () => {
    const queue = retryQueue();
    queue.tasks[0].history = Array.from({ length: 25 }, (_, index) => ({
      runId: `run-${index + 1}`, status: 'failed', gateVerdict: 'fail', finishedAt: `2026-11-08T01:0${index}:00.000Z`,
    }));
    queue.tasks[0].attempts = 26;
    const model = buildWorkflowReport(queue, records());
    expect(model.tasks[0].history).toHaveLength(20);
    expect(model.tasks[0].historyTruncated).toBe(true);
    expect(model.tasks[0].attemptCount).toBe(26);

    const html = workflowReportHtml(model);
    expect(html).toContain('<summary>26 attempts</summary>');
    expect(html).toContain('The queue keeps the last 20 attempts; earlier attempts are not in this report.');
    expect(html).toContain('The queue counted 5 more attempt(s) than its history holds.');
  });

  it('escapes attempt text and stays self-contained and script-free', () => {
    const queue = retryQueue();
    queue.tasks[0].history = [
      { runId: '<script>alert(1)</script>', status: '<img onerror=x>', gateVerdict: 'fail', finishedAt: '" onmouseover="' },
      { runId: 'run-2', status: 'failed', gateVerdict: 'fail', finishedAt: '2026-11-08T01:11:00.000Z' },
    ];
    const html = workflowReportHtml(buildWorkflowReport(queue, records(), { figureLevel: 'none' }));
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img onerror=x>');
    expect(html).toContain('&lt;img onerror=x&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // `--figures none` keeps the attempt history: the retry record is not a figure.
    expect(html).toContain('<summary>3 attempts</summary>');
    expect(html).not.toContain('<figure class="fig"');
    // Self-contained: no network reference, and the stylesheet is inline.
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });
});

describe('partial parses in the workflow report (#353)', () => {
  const queueFor = (tasks) => ({
    id: 'q-partial',
    projectName: 'Windowed log',
    status: 'completed',
    tasks,
  });
  const completeRecord = () => ({
    provenance: { jobType: 'SP', method: { functional: 'B3LYP', basis: 'def2-SVP' } },
    parsed: { complete: true, finalEnergy: { hartree: -76.4 } },
    gates: { overall: 'pass' },
  });
  const task = {
    nodeId: 'sp', title: 'Single point', type: 'calculate', status: 'completed', runId: 'run-sp',
  };

  const triggers = [
    ['record.truncated === true', (record) => { record.truncated = true; }],
    ['parsed.complete === false', (record) => { record.parsed.complete = false; }],
    ['outputBytes.truncated === true', (record) => {
      record.outputBytes = { size: 5000000, bytesRead: 5000000, truncated: true };
    }],
    ['bytesRead < size', (record) => {
      record.outputBytes = { size: 5000000, bytesRead: 200000 };
    }],
  ];

  it.each(triggers)('marks the row and prints the caveat when %s', (_name, apply) => {
    const record = completeRecord();
    apply(record);
    const model = buildWorkflowReport(queueFor([task]), { 'run-sp': record });
    expect(model.partials).toBe(1);
    expect(model.recordCount).toBe(1);
    expect(model.tasks[0].partial).not.toBeNull();
    const html = workflowReportHtml(model);
    expect(html).toContain('data-partial="true"');
    expect(html).toContain('data-field="partial-badge"');
    expect(html).toContain('PARTIAL');
    expect(html).toMatch(/1 of 1 record was read from a window of the log; values may be missing or stale/);
    expect(html).toContain('Partial: <strong>Single point</strong>');
  });

  it('carries the byte window in the model and names it in the caveat', () => {
    const record = completeRecord();
    record.outputBytes = {
      size: 5000000,
      bytesRead: 200000,
      truncated: true,
      windows: [{ name: 'head' }, { name: 'tail' }],
    };
    const model = buildWorkflowReport(queueFor([task]), { 'run-sp': record });
    expect(model.tasks[0].partial).toEqual({
      bytesRead: 200000,
      size: 5000000,
      windows: ['head', 'tail'],
    });
    const html = workflowReportHtml(model);
    expect(html).toContain('200000 of 5000000 bytes (head + tail)');
  });

  it('prints no badge and no caveat when every record was read in full', () => {
    const model = buildWorkflowReport(queueFor([task]), { 'run-sp': completeRecord() });
    expect(model.partials).toBeUndefined();
    expect(model.recordCount).toBeUndefined();
    expect(model.tasks[0]).not.toHaveProperty('partial');
    const html = workflowReportHtml(model);
    expect(html).not.toContain('data-partial');
    expect(html).not.toContain('data-field="partial-note"');
    expect(html).not.toContain('PARTIAL');
    expect(html).not.toContain('window of the log');
    // The numbers themselves are unchanged.
    expect(html).toContain('-76.40000000');
  });

  it('does not change the numbers printed when a row becomes partial', () => {
    const completeHtml = workflowReportHtml(buildWorkflowReport(queueFor([task]), { 'run-sp': completeRecord() }));
    const partial = completeRecord();
    partial.outputBytes = { size: 5000000, bytesRead: 200000 };
    const partialHtml = workflowReportHtml(buildWorkflowReport(queueFor([task]), { 'run-sp': partial }));
    const numericCells = (html) => [...html.matchAll(/<td class="num">([\s\S]*?)<\/td>/g)].map((match) => match[1]);
    expect(numericCells(partialHtml)).toEqual(numericCells(completeHtml));
    expect(numericCells(partialHtml)).toContain('-76.40000000');
  });

  it('counts one caveat and marks only the windowed row in a mixed report', () => {
    const tasks = [
      { nodeId: 'r1', title: 'Complete', type: 'calculate', status: 'completed', runId: 'r1' },
      { nodeId: 'r2', title: 'Windowed', type: 'calculate', status: 'completed', runId: 'r2' },
    ];
    const records = {
      r1: completeRecord(),
      r2: { ...completeRecord(), outputBytes: { size: 5000000, bytesRead: 200000 } },
    };
    const model = buildWorkflowReport(queueFor(tasks), records);
    expect(model.partials).toBe(1);
    expect(model.recordCount).toBe(2);
    const html = workflowReportHtml(model);
    expect(html).toContain('1 of 2 records was read from a window of the log');
    const rowAt = (id) => html.slice(html.indexOf(`data-node="${id}"`), html.indexOf('</tr>', html.indexOf(`data-node="${id}"`)));
    expect(rowAt('r2')).toContain('PARTIAL');
    expect(rowAt('r1')).not.toContain('PARTIAL');
    expect(html).toContain('Partial: <strong>Windowed</strong>');
    expect(html).not.toContain('Partial: <strong>Complete</strong>');
  });

  it('does not call a windowed read partial when the parser says truncated: false', () => {
    const record = completeRecord();
    // A head+tail read covers the file without reading every byte; the parser's
    // explicit `false` is authoritative over `bytesRead < size`.
    record.outputBytes = { size: 5000000, bytesRead: 200000, truncated: false };
    const model = buildWorkflowReport(queueFor([task]), { 'run-sp': record });
    expect(model.partials).toBeUndefined();
    expect(workflowReportHtml(model)).not.toContain('PARTIAL');
  });

  it('escapes a task title named in the caveat', () => {
    const record = completeRecord();
    record.outputBytes = { size: 5000000, bytesRead: 200000 };
    const model = buildWorkflowReport(queueFor([{ ...task, title: '<img onerror=x>' }]), { 'run-sp': record });
    const html = workflowReportHtml(model);
    expect(html).not.toContain('<img onerror=x>');
    expect(html).toContain('&lt;img onerror=x&gt;');
  });
});
