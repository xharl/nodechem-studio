import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  DP4_COMPUTE_MODE,
  dp4CandidatesFromRuns,
  dp4DefinitionForFile,
  dp4Summary,
  evaluateDp4,
  validateDp4Definition,
} from '../src/shared/dp4Workflow.js';
import { defaultSettings, stringifyProject, validateProject } from '../src/shared/projectSchema.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';
import { resultsPanelHtml } from '../src/renderer/resultsView.js';

/**
 * Issue 165: DP4+ reachable end to end.
 *
 * `dp4.js` was merged and could not be reached: nothing created the `dp4` block
 * the card and the report read. These tests pin the whole path — the definition
 * a project saves, the plan that reads the candidate records, the queue that
 * writes `run.json`, the card and the report — and they pin the refusals at the
 * point where each one can first be caught: a level the bank does not carry is
 * a save-time error, not a run-time surprise.
 *
 * The numbers come from the committed example study
 * (`test/fixtures/dp4/example-nmr-only.json`, dp4plus_app 2.2.3, MIT). The
 * expected percentages are not re-derived here: `dp4.test.js` already holds the
 * module against the reference procedure, and this file asserts the *plumbing*
 * — that the same table arrives in the record, sums to one, and is rendered.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/dp4/example-nmr-only.json'), 'utf8'));
const LEVEL = `${fixture.level.method}/${fixture.level.basis}`;

const water = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.9572, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.927, z: 0 },
];

const molecule = () => ({
  smiles: '', charge: 0, multiplicity: 1, fragments: [], coords: water,
  geometry: { source: 'demo', file: '', format: '' },
});

const calc = (id, title = id) => ({
  id, type: 'calculate', kind: 'SP', title, state: 'ready', x: 0, y: 0,
  settings: defaultSettings({ jobType: 'SP' }), output: null,
});

/** The block's saved definition, from the fixture's own experiment. */
function dp4Definition(extra = {}) {
  return {
    level: LEVEL,
    solvation: fixture.level.solvation,
    solvent: fixture.level.solvent,
    variant: 'full',
    temperature: 298.15,
    experimental: fixture.experimental.map((row, index) => ({
      nucleus: row.nucleus,
      shift: row.shift,
      ...(row.sp2 ? { sp2: true } : {}),
      ...(row.exchange ? { exchange: row.exchange } : {}),
      atoms: fixture.candidates[0].assignments[index],
    })),
    candidateAssignments: Object.fromEntries(fixture.candidates.map((candidate) => [candidate.id, candidate.assignments])),
    ...extra,
  };
}

const dp4Node = (definition = dp4Definition(), extra = {}) => ({
  id: 'dp4', type: 'analyse', kind: 'Compute', title: 'DP4+ ranking', state: 'ready', x: 0, y: 0,
  analyse: { mode: DP4_COMPUTE_MODE, dp4: definition },
  ...extra,
});

function projectWith(nodes, edges, { datasets = [] } = {}) {
  return {
    schemaVersion: 3,
    name: 'DP4+ protocol',
    molecule: molecule(),
    defaults: { method: fixture.level.method, basis: fixture.level.basis, memory: '4', memoryUnit: 'GB', nproc: '4' },
    runner: { maxParallel: 1 },
    datasets,
    flows: [{ id: 'main', title: 'DP4+', nodes, edges }],
    reports: [],
    activeFlowId: 'main',
  };
}

function validated(raw) {
  const result = validateProject(raw);
  expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
  return result.project;
}

/** The project a user builds: one NMR block, one DP4+ block, one edge. */
function dp4Project(definition = dp4Definition()) {
  return validated(projectWith(
    [calc('nmr'), dp4Node(definition)],
    [{ from: 'nmr', to: 'dp4', type: 'dependency' }],
  ));
}

/**
 * One run record per conformer of the fixture study, keyed by task id the way
 * the plan and the queue key results: `<block>~<record>~<member>`.
 */
function resultRows({ drop = null } = {}) {
  const rows = new Map();
  for (const candidate of fixture.candidates) {
    for (const [index, conformer] of candidate.conformers.entries()) {
      const atoms = conformer.shieldings
        .map((isotropic, position) => ({ index: position + 1, isotropic }))
        .filter((atom) => !(drop && drop.candidateId === candidate.id && atom.index === drop.atom));
      rows.set(`nmr~${candidate.id}~c${index + 1}`, {
        parsed: {
          ...(Number.isFinite(conformer.energyHartree) ? { finalEnergy: { hartree: conformer.energyHartree } } : {}),
          nmr: { gauge: 'GIAO', method: 'mPW1PW91', count: atoms.length, atoms },
        },
        provenance: { method: { functional: fixture.level.method, basis: fixture.level.basis } },
      });
    }
  }
  return rows;
}

/** The same rows as the queue sees them: `{ source, recordId, memberId, run }`. */
function queueRows(options = {}) {
  return [...resultRows(options).entries()].map(([taskId, run]) => {
    const [source, recordId, memberId] = taskId.split('~');
    return { taskId, source, recordId, memberId, run };
  });
}

describe('issue 165 — the DP4+ definition is checked where it is written', () => {
  it('refuses a level the bank does not carry, by name, at save time', () => {
    const result = validateProject(projectWith(
      [calc('nmr'), dp4Node(dp4Definition({ level: 'GFN2-xTB/def2-TZVP' }))],
      [{ from: 'nmr', to: 'dp4', type: 'dependency' }],
    ));
    expect(result.ok).toBe(false);
    const problem = result.errors.find((entry) => entry.path.includes('analyse.dp4.level'));
    expect(problem).toBeDefined();
    // The bank's own sentence: it names the level and says it is not estimated.
    expect(problem.message).toContain('GFN2-xTB/def2-TZVP');
    expect(problem.message).toContain('not estimated');
    expect(problem.message).toContain('mPW1PW91/6-31+G(d,p)');
  });

  it('refuses classic DP4 as a variant rather than relabelling a DP4+ number', () => {
    const result = validateProject(projectWith(
      [calc('nmr'), dp4Node(dp4Definition({ variant: 'dp4' }))],
      [{ from: 'nmr', to: 'dp4', type: 'dependency' }],
    ));
    expect(result.ok).toBe(false);
    expect(result.errors.some((entry) => entry.path.endsWith('analyse.dp4.variant')
      && /classic DP4/.test(entry.message))).toBe(true);
  });

  it('refuses a measured shift with no atom assignment, by row', () => {
    const definition = dp4Definition();
    delete definition.experimental[0].atoms;
    const result = validateProject(projectWith(
      [calc('nmr'), dp4Node(definition)],
      [{ from: 'nmr', to: 'dp4', type: 'dependency' }],
    ));
    expect(result.ok).toBe(false);
    const problem = result.errors.find((entry) => entry.path.includes('experimental[0].atoms'));
    expect(problem).toBeDefined();
    expect(problem.message).toContain('at least one atom number');
  });

  it('refuses a measured shift in a unit DP4+ is not fitted in', () => {
    const definition = dp4Definition();
    definition.experimental[0].unit = 'Hz';
    const result = validateProject(projectWith(
      [calc('nmr'), dp4Node(definition)],
      [{ from: 'nmr', to: 'dp4', type: 'dependency' }],
    ));
    expect(result.ok).toBe(false);
    expect(result.errors.some((entry) => entry.path.includes('experimental[0].unit')
      && /ppm/.test(entry.message))).toBe(true);
  });

  it('saves the definition it validated, with the level and the variant named', () => {
    const project = dp4Project();
    const node = project.flows[0].nodes.find((item) => item.type === 'analyse');
    expect(node.analyse.mode).toBe('dp4');
    expect(node.analyse.dp4.level).toBe(LEVEL);
    expect(node.analyse.dp4.solvation).toBe('PCM');
    expect(node.analyse.dp4.solvent).toBe('CHCl3');
    expect(node.analyse.dp4.variant).toBe('full');
    expect(node.analyse.dp4.experimental).toHaveLength(fixture.experimental.length);
    expect(node.analyse.dp4.experimental[0].nucleus).toBe('13C');
    // No expression and no field inputs: a DP4+ block reads records, and a
    // stale expression would be a second, contradictory declaration.
    expect(node.analyse.expression).toBeUndefined();
    expect(node.analyse.inputs).toBeUndefined();
  });
});

describe('issue 165 — a project without the mode saves and plans byte for byte', () => {
  /**
   * The two files beside this test were written by `stringifyProject()` and
   * `buildWorkflowPlan()` on the commit before DP4+ mode existed. Adding a mode
   * to the compute block must not change one byte of a project that never uses
   * it — not an optional key, not a plan field, not a key order.
   */
  const baselineSave = fs.readFileSync(path.join(ROOT, 'test/fixtures/dp4/byte-identical/compute-save.json'), 'utf8');
  const baselinePlan = fs.readFileSync(path.join(ROOT, 'test/fixtures/dp4/byte-identical/compute-plan.json'), 'utf8');

  const arithmeticProject = () => ({
    schemaVersion: 3,
    name: 'Byte identity',
    molecule: molecule(),
    defaults: { method: 'MP2', basis: 'cc-pVQZ', memory: '4', memoryUnit: 'GB', nproc: '4' },
    runner: { maxParallel: 1 },
    datasets: [],
    flows: [{
      id: 'main',
      title: 'Byte identity',
      nodes: [
        calc('sp2'),
        calc('sp4'),
        {
          id: 'cbs', type: 'analyse', kind: 'Compute', title: 'CBS limit', state: 'ready', x: 0, y: 0,
          analyse: {
            expression: 'fit_cubic_inverse(E4, 4, E2, 2)',
            inputs: [
              { name: 'E4', field: 'finalEnergyHartree', source: 'sp4' },
              { name: 'E2', field: 'finalEnergyHartree', source: 'sp2' },
            ],
          },
        },
      ],
      edges: [
        { from: 'sp2', to: 'cbs', type: 'dependency' },
        { from: 'sp4', to: 'cbs', type: 'dependency' },
      ],
    }],
    reports: [],
    activeFlowId: 'main',
  });

  it('saves the same bytes as the expression-only contract', () => {
    const project = validated(arithmeticProject());
    expect(stringifyProject(project).text).toBe(baselineSave);
    expect(baselineSave).not.toContain('"mode"');
  });

  it('plans the same tasks as the expression-only contract', () => {
    const project = validated(arithmeticProject());
    expect(JSON.stringify(buildWorkflowPlan(project).tasks, null, 2)).toBe(baselinePlan);
  });

  it('still says an expression block with no inputs has none', () => {
    const project = validated(projectWith(
      [calc('sp2'), { ...calc('other'), id: 'sp2b' }, {
        id: 'bad', type: 'analyse', title: 'Bad', state: 'ready', x: 0, y: 0,
        analyse: { expression: '1 + 2' },
      }],
      [{ from: 'sp2', to: 'bad', type: 'dependency' }],
    ));
    expect(() => buildWorkflowPlan(project)).toThrow(/declares no inputs/);
  });
});

describe('issue 165 — the plan reads the candidate records', () => {
  it('plans one task, not one per record, and computes from the results it was given', () => {
    const project = dp4Project();
    const plan = buildWorkflowPlan(project, { results: resultRows() });
    const tasks = plan.tasks.filter((task) => task.type === 'analyse');
    expect(tasks).toHaveLength(1);
    const [task] = tasks;
    expect(task.analyse.mode).toBe('dp4');
    expect(task.analyse.status).toBe('computed');
    expect(task.analyse.candidates).toHaveLength(2);
    expect(task.analyse.checks.sumOfProbabilities).toBeCloseTo(1, 12);
    // The winning structure is the one the reference package's manual names.
    expect(task.analyse.candidates[0].id).toBe('01');
    expect(task.analyse.summary).toContain('DP4+');
    // The definition travels with the task so the queue can re-evaluate it.
    expect(task.analyse.dp4.level).toBe(LEVEL);
  });

  it('plans the block as waiting, never as a number, before the runs exist', () => {
    const task = buildWorkflowPlan(dp4Project()).tasks.find((item) => item.type === 'analyse');
    expect(task.analyse.status).toBe('pending');
    expect(task.analyse.value).toBeNull();
    expect(task.analyse.notComputed).toContain('waiting for the blocks wired into this DP4+ block');
  });

  it('refuses a block with no upstream block, naming what it needs', () => {
    const project = validated(projectWith([dp4Node()], []));
    expect(() => buildWorkflowPlan(project)).toThrow(/wire the blocks whose results it compares/);
  });

  it('keeps the definition and the probabilities apart from any engine value', () => {
    const task = buildWorkflowPlan(dp4Project(), { results: resultRows() })
      .tasks.find((item) => item.type === 'analyse');
    // No `parsed` block and no scalar value: a DP4+ result is a table, and it
    // must not enter an energy column.
    expect(task.parsed).toBeUndefined();
    expect(task.analyse.value).toBeNull();
    expect(task.analyse.candidates[0].nuclei.length).toBeGreaterThan(0);
  });
});

describe('issue 165 — a candidate missing a nucleus is excluded and named', () => {
  it('excludes the candidate, names the atom, and refuses the one-candidate remainder', () => {
    // Candidate 02 has no atom 46 in this copy of its shieldings; experimental
    // row 20 assigns atom 46, so 02 cannot be compared over the same nuclei.
    const result = evaluateDp4(dp4Definition(), { rows: queueRows({ drop: { candidateId: '02', atom: 46 } }) });
    // The exclusion is `dp4.js`'s own rule, not a second copy of it here: the
    // candidate is set aside with the atom named, and a comparison that would
    // leave one candidate is refused instead of reporting a 100 % "probability".
    expect(result.available).toBe(false);
    expect(result.code).toBe('fewer-than-two-scorable-candidates');
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0].candidateId).toBe('02');
    expect(result.excluded[0].code).toBe('missing-nucleus');
    expect(result.excluded[0].reason).toContain('atom 46');
    expect(result.reason).toContain('02');
    expect(result.reason).toContain('atom 46');
  });

  it('excludes one of three candidates and still reports the other two', () => {
    // A third candidate is the second structure's shieldings under another id —
    // the fixture ships two, and the point here is the exclusion, not a third
    // structure. Both remaining candidates keep their own assignments.
    const definition = dp4Definition();
    definition.candidateAssignments = {
      ...definition.candidateAssignments,
      '03': fixture.candidates[1].assignments,
    };
    const rows = [
      ...queueRows().filter((row) => row.recordId === '01'),
      ...queueRows({ drop: { candidateId: '02', atom: 46 } }).filter((row) => row.recordId === '02'),
      ...queueRows()
        .filter((row) => row.recordId === '02')
        .map((row) => ({ ...row, recordId: '03', taskId: row.taskId.replace('~02~', '~03~') })),
    ];
    const result = evaluateDp4(definition, { rows });
    expect(result.available).toBe(true);
    expect(result.excluded.map((entry) => entry.candidateId)).toEqual(['02']);
    expect(result.candidates.map((candidate) => candidate.id).sort()).toEqual(['01', '03']);
    expect(result.checks.sumOfProbabilities).toBeCloseTo(1, 12);
  });

  it('refuses a candidate whose run carries no shielding block, naming the run', () => {
    const rows = queueRows();
    rows[0] = { ...rows[0], run: { parsed: { finalEnergy: { hartree: -1140.6 } } } };
    const result = evaluateDp4(dp4Definition(), { rows });
    expect(result.available).toBe(false);
    expect(result.code).toBe('candidate-without-shieldings');
    expect(result.reason).toContain(rows[0].taskId);
    expect(result.reason).toContain('different ensemble');
  });
});

describe('issue 165 — the queue writes the DP4+ record', () => {
  let QueueManager;
  let RunManager;
  let roots = [];

  beforeAll(async () => {
    ({ QueueManager } = await import('../electron/runner/queue.js'));
    ({ RunManager } = await import('../electron/runner/runManager.js'));
  });

  afterAll(async () => {
    // A queue started in one of these tests can still be persisting when the
    // file ends, so the removal races the writer and fails with ENOTEMPTY. The
    // retries belong on the removal, not on a sleep: a settled directory is
    // removed on the first attempt and a busy one is retried with backoff.
    await Promise.all(roots.map((root) => fsp.rm(root, {
      recursive: true, force: true, maxRetries: 5, retryDelay: 50,
    })));
    roots = [];
  });

  const queueFor = async (rows, planTask) => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-dp4-'));
    roots.push(base);
    const queuesRoot = path.join(base, 'queues');
    const runsRoot = path.join(base, 'runs');
    await fsp.mkdir(runsRoot, { recursive: true });
    const manager = new QueueManager({
      queuesRoot,
      runManager: new RunManager({ runsRoot, emit: () => {} }),
      emit: () => {},
    });
    const tasks = [];
    const edges = [];
    for (const [taskId, run] of rows.entries()) {
      const dir = path.join(base, 'runs-src', taskId);
      // eslint-disable-next-line no-await-in-loop
      await fsp.mkdir(dir, { recursive: true });
      // eslint-disable-next-line no-await-in-loop
      await fsp.writeFile(path.join(dir, 'run.json'), JSON.stringify(run), 'utf8');
      tasks.push({
        nodeId: taskId, type: 'calculate', title: taskId, status: 'completed', runDir: dir,
        record: { id: taskId.split('~')[1], label: `record ${taskId.split('~')[1]}` },
      });
      edges.push({ from: taskId, to: planTask.nodeId, type: 'dependency' });
    }
    tasks.push(planTask);
    const queue = { id: 'q1', tasks, edges, status: 'running', options: {} };
    return { manager, queue, task: planTask };
  };

  it('writes a dp4 block whose probabilities sum to one', async () => {
    const project = dp4Project();
    const rows = resultRows();
    const planTask = buildWorkflowPlan(project, { results: rows }).tasks.find((task) => task.type === 'analyse');
    const { manager, queue, task } = await queueFor(rows, planTask);
    await manager.runAnalyse(queue, task);

    expect(task.status).toBe('completed');
    expect(task.dp4.available).toBe(true);
    const written = JSON.parse(await fsp.readFile(path.join(task.runDir, 'run.json'), 'utf8'));
    expect(written.kind).toBe('derived');
    expect(written.analyse.mode).toBe('dp4');
    expect(written.dp4.available).toBe(true);
    expect(written.dp4.candidates).toHaveLength(2);
    expect(written.dp4.candidates.reduce((sum, candidate) => sum + candidate.probability, 0)).toBeCloseTo(1, 12);
    expect(written.dp4.checks.sumOfProbabilities).toBeCloseTo(1, 12);
    expect(written.dp4.level.id).toBe(LEVEL);
    expect(written.dp4.bank.package).toBe('dp4plus_app');
    expect(written.dp4.citation.doi).toBe('10.1021/acs.joc.5b02396');
    // The record proves the level and the bank the numbers came from, and it
    // carries no engine parse: a probability is not a calculation result.
    expect(written.provenance.jobType).toBe('DP4+');
    expect(written.parsed).toBeUndefined();
    // The whole result survived JSON: every candidate keeps its nuclei.
    expect(written.dp4.candidates[0].nuclei.length).toBe(fixture.experimental.length);
  });

  it('writes the refusal down instead of failing silently', async () => {
    // A level the bank carries is changed after the fact: the queue must refuse
    // by name and still record why, not produce a blank task.
    const project = dp4Project();
    const rows = resultRows();
    const planTask = buildWorkflowPlan(project, { results: rows }).tasks.find((task) => task.type === 'analyse');
    planTask.analyse = { ...planTask.analyse, dp4: { ...planTask.analyse.dp4, level: 'B97D/6-31G(d)' } };
    const { manager, queue, task } = await queueFor(rows, planTask);
    await manager.runAnalyse(queue, task);

    expect(task.status).toBe('failed');
    expect(task.dp4.available).toBe(false);
    expect(task.dp4.code).toBe('level-not-in-bank');
    expect(task.reason).toContain('B97D/6-31G(d)');
    const written = JSON.parse(await fsp.readFile(path.join(task.runDir, 'run.json'), 'utf8'));
    expect(written.dp4.available).toBe(false);
    expect(written.dp4.reason).toContain('not estimated');
    expect(written.analyse.notComputed).toContain('B97D/6-31G(d)');
  });

  it('keeps the definition through the queue’s task sanitiser', async () => {
    // The queue's trust boundary rebuilds every task from the renderer payload;
    // a mode or a definition dropped there would turn the block into an
    // expression task with no inputs and fail it with the wrong sentence.
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-dp4-begin-'));
    roots.push(base);
    const queuesRoot = path.join(base, 'queues');
    const runsRoot = path.join(base, 'runs');
    await fsp.mkdir(runsRoot, { recursive: true });
    const manager = new QueueManager({
      queuesRoot,
      runManager: new RunManager({ runsRoot, emit: () => {} }),
      emit: () => {},
    });
    const planTask = buildWorkflowPlan(dp4Project()).tasks.find((task) => task.type === 'analyse');
    const started = await manager.start({
      projectName: 'DP4+', tasks: [planTask], edges: [], options: { executable: '', scratchDir: '' },
    });
    const queueId = started?.id ?? started?.queueId;
    const deadline = Date.now() + 10_000;
    let task = null;
    while (Date.now() < deadline) {
      const queue = manager.queues.get(queueId);
      task = queue?.tasks?.[0] || null;
      // eslint-disable-next-line no-await-in-loop
      if (task && task.status !== 'pending') break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(task).not.toBeNull();
    expect(task.analyse.mode).toBe('dp4');
    expect(task.analyse.dp4.level).toBe(LEVEL);
    expect(task.analyse.dp4.experimental).toHaveLength(fixture.experimental.length);
    // No upstream block produced a record, so the block is waiting — blocked,
    // not failed, and not computed as zero.
    expect(task.status).toBe('blocked');
    expect(task.dp4.status).toBe('pending');
    const stored = JSON.parse(await fsp.readFile(path.join(queuesRoot, queueId, 'queue.json'), 'utf8'));
    expect(stored.tasks[0].analyse.mode).toBe('dp4');
  });

  it('blocks, rather than refuses, when no upstream result has been written yet', async () => {
    const project = dp4Project();
    const planTask = buildWorkflowPlan(project).tasks.find((task) => task.type === 'analyse');
    const { manager, queue, task } = await queueFor(new Map(), planTask);
    // No upstream tasks at all: the block is waiting, not wrong.
    queue.edges = [];
    await manager.runAnalyse(queue, task);
    expect(task.status).toBe('blocked');
    expect(task.dp4.status).toBe('pending');
  });
});

describe('issue 165 — the card and the report show what was computed', () => {
  const computed = () => evaluateDp4(dp4Definition(), { rows: queueRows() });

  it('renders the probability table and the terms in the results card', () => {
    const result = computed();
    const html = resultsPanelHtml({
      id: 'dp4', title: 'DP4+ ranking', kind: 'derived',
      analyse: { mode: 'dp4', expression: result.expression, inputs: [], value: null, unit: null, notes: result.notes },
      dp4: result,
    });
    expect(html).toContain('data-field="dp4-probabilities"');
    expect(html).toContain('data-field="dp4-verdict"');
    expect(html).toContain('data-field="dp4-error-fit"');
    expect(html).toContain('<strong>01</strong>');
    expect(html).toContain('DP4+ full');
    expect(html).toContain('10.1021/acs.joc.5b02396');
    // The card does not print a scalar "value" for a probability table.
    expect(html).not.toContain('data-field="compute-value"');
  });

  it('renders a refusal where the table would be, with the reason', () => {
    const result = evaluateDp4({ ...dp4Definition(), level: 'B97D/6-31G(d)' }, { rows: queueRows() });
    expect(result.available).toBe(false);
    const html = resultsPanelHtml({
      id: 'dp4', title: 'DP4+ ranking', kind: 'derived',
      analyse: { mode: 'dp4', expression: result.expression, inputs: [], value: null, unit: null, notes: result.notes, notComputed: result.notComputed },
      dp4: result,
    });
    expect(html).toContain('data-field="dp4-refusal"');
    expect(html).toContain('B97D/6-31G(d)');
    expect(html).toContain('not estimated');
    expect(html).not.toContain('data-field="dp4-probabilities"');
  });

  it('reports the comparison in its own section, not as a derived scalar', () => {
    const result = computed();
    const queue = {
      id: 'q1', projectName: 'DP4+', status: 'completed',
      createdAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T01:00:00Z',
      tasks: [{
        nodeId: 'dp4', type: 'analyse', title: 'DP4+ ranking', kind: 'Compute', status: 'completed',
        analyse: { mode: 'dp4', expression: result.expression, inputs: [], value: null, unit: null, notes: result.notes, status: 'computed' },
        dp4: result,
      }],
      edges: [],
    };
    const model = buildWorkflowReport(queue, {});
    expect(model.dp4).toHaveLength(1);
    expect(model.dp4[0].result.available).toBe(true);
    // A DP4+ block is not listed as an uncomputed derived value.
    expect(model.derived).toHaveLength(0);
    const html = workflowReportHtml(model);
    expect(html).toContain('data-field="dp4-probabilities"');
    expect(html).toContain('DP4+');
  });

  it('reports a refused comparison by its reason', () => {
    const result = evaluateDp4({ ...dp4Definition(), variant: 'sca', level: 'B97D/6-31G(d)' }, { rows: queueRows() });
    const queue = {
      id: 'q1', projectName: 'DP4+', status: 'completed',
      createdAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T01:00:00Z',
      tasks: [{
        nodeId: 'dp4', type: 'analyse', title: 'DP4+ ranking', kind: 'Compute', status: 'failed',
        analyse: { mode: 'dp4', expression: result.expression, inputs: [], value: null, unit: null, notes: result.notes, status: 'refused' },
        dp4: result,
      }],
      edges: [],
    };
    const html = workflowReportHtml(buildWorkflowReport(queue, {}));
    expect(html).toContain('data-field="dp4-refusal"');
    expect(html).toContain('not estimated');
  });
});

describe('issue 165 — the definition helpers refuse rather than repair', () => {
  it('keeps an unmeasured shift NaN instead of turning it into 0.00 ppm', () => {
    const checked = validateDp4Definition(dp4Definition({ experimental: [{ nucleus: '13C', shift: null, atoms: [1] }] }));
    expect(checked.ok).toBe(false);
    expect(checked.definition.experimental[0].shift).toBeNaN();
  });

  it('canonicalises a nucleus label and keeps the atom list of each row', () => {
    const checked = validateDp4Definition({
      level: LEVEL,
      solvation: fixture.level.solvation,
      solvent: fixture.level.solvent,
      experimental: [{ nucleus: 'c', shift: 60, atoms: [4, 5] }],
    });
    expect(checked.ok, JSON.stringify(checked.errors)).toBe(true);
    expect(checked.definition.experimental[0].nucleus).toBe('13C');
    expect(checked.definition.experimental[0].atoms).toEqual([4, 5]);
    expect(dp4DefinitionForFile({ level: LEVEL, solvation: 'gas', experimental: [{ nucleus: 'h', shift: 3, atoms: [7] }] }).experimental[0].nucleus).toBe('1H');
  });

  it('names the two candidates and the two nuclei when the same atom is assigned twice', () => {
    const definition = dp4Definition();
    definition.candidateAssignments = { '01': definition.experimental.map(() => [2]), '02': fixture.candidates[1].assignments };
    const result = evaluateDp4(definition, { rows: queueRows() });
    expect(result.available).toBe(false);
    expect(result.code).toBe('assignment-not-one-to-one');
    expect(result.reason).toContain('atom 2');
  });

  it('uses the run’s own declared level to catch a comparison across two levels', () => {
    const rows = queueRows().map((row) => (row.recordId === '02'
      ? { ...row, run: { ...row.run, provenance: { method: { functional: 'B3LYP', basis: '6-31G(d)' } } } }
      : row));
    const result = evaluateDp4(dp4Definition(), { rows });
    expect(result.available).toBe(false);
    expect(result.code).toBe('differing-levels');
    expect(result.reason).toContain('B3LYP/6-31G(d)');
    expect(result.reason).toContain(LEVEL);
  });

  it('builds one candidate per record and one conformer per member', () => {
    const built = dp4CandidatesFromRuns(queueRows(), dp4Definition());
    expect(built.ok).toBe(true);
    expect(built.candidates.map((candidate) => candidate.id)).toEqual(['01', '02']);
    expect(built.candidates[0].conformers).toHaveLength(fixture.candidates[0].conformers.length);
    expect(built.candidates[0].conformers[0].shieldings.length).toBe(fixture.candidates[0].conformers[0].shieldings.length);
    expect(built.candidates[0].assignments).toHaveLength(fixture.experimental.length);
  });

  it('summarises a computed comparison with the verdict, not a second wording', () => {
    const result = evaluateDp4(dp4Definition(), { rows: queueRows() });
    expect(dp4Summary(result)).toContain('01 100.00 %');
    expect(dp4Summary({ available: false, reason: 'no upstream' })).toBe('no upstream');
  });
});
