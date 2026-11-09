/**
 * Issue 186 — the spin-state sweep is reachable and legible.
 *
 * The model and the planner half already existed; these tests are the wiring
 * test that was missing: the renderer's own control must write the key the
 * planner reads, the queue rows and cards must say what was expanded, the
 * result must name the lowest computed state without calling it a ground
 * state, and a state that failed must be reported rather than dropped.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';
import { stringifyProject, validateProject } from '../src/shared/projectSchema.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';
import { resultsPanelHtml } from '../src/renderer/resultsView.js';

const exampleText = readFileSync(new URL('../examples/single-point.ncs', import.meta.url), 'utf8');
const H = (kcal) => kcal / 627.5094740631;

function loadedProject(raw = exampleText) {
  return validateProject(JSON.parse(raw)).project;
}

function calcNode(project) {
  return project.nodes.find((node) => node.type === 'calc');
}

describe('the inspector asks for a sweep (issue 186)', () => {
  let app;

  beforeAll(async () => {
    vi.stubGlobal('window', {
      desktop: null,
      innerWidth: 1440,
      innerHeight: 900,
      addEventListener: () => {},
    });
    vi.stubGlobal('document', {
      readyState: 'loading',
      addEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      documentElement: { getAttribute: () => null, setAttribute: () => {}, style: {} },
    });
    app = await import('../src/renderer/app.js');
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const withProject = (project) => {
    app.state.project = project;
    app.state.queue = { id: null, status: 'idle', tasks: [], reason: null, spins: {} };
    return calcNode(project);
  };

  it('offers the control off by default and writes the key only when on', () => {
    const project = loadedProject();
    const node = withProject(project);
    expect(node.settings.spinSweep).toBeNull();

    const off = app.calcInspector(node);
    expect(off).toContain('data-node-field="spinSweepEnabled"');
    expect(off).toContain('up to 6 states');
    expect(off).not.toContain('data-spin-state=');

    app.updateNodeField(node, 'spinSweepEnabled', true);
    expect(node.settings.spinSweep).toEqual({ enabled: true, multiplicities: [1, 3] });

    const on = app.calcInspector(node);
    expect(on).toMatch(/data-spin-state="1"[^>]*checked/);
    expect(on).toMatch(/data-spin-state="3"[^>]*checked/);
    expect(on).toMatch(/data-spin-state="5"(?![^>]*checked)/);
    expect(on).toContain('one geometry');
  });

  it('writes nothing when the control is switched off again', () => {
    const before = stringifyProject(JSON.parse(exampleText)).text;
    const project = loadedProject();
    const node = withProject(project);
    app.updateNodeField(node, 'spinSweepEnabled', true);
    app.updateNodeField(node, 'spinSweepEnabled', false);
    expect(node.settings.spinSweep).toBeNull();
    const after = stringifyProject(project).text;
    expect(after).toBe(before);
  });

  it('offers only the parity an odd electron count allows, and names an impossible one', () => {
    const project = loadedProject();
    const node = withProject(project);
    node.settings.charge = 1; // 10-electron water, charge +1 → 9 electrons

    const info = app.spinMultiplicitiesForNode(node);
    expect(info.electrons).toBe(9);
    expect(info.values).toEqual([2, 4, 6, 8, 10, 12]);

    app.updateNodeField(node, 'spinSweepEnabled', true);
    expect(node.settings.spinSweep.multiplicities).toEqual([2, 4]);

    const html = app.calcInspector(node);
    expect(html).toMatch(/data-spin-state="2"[^>]*checked/);
    expect(html).not.toContain('data-spin-state="1"');

    // A stored sweep naming an odd multiplicity cannot run for an odd electron
    // count. It stays visible so it can be unticked, and the inspector names it.
    node.settings.spinSweep = { enabled: true, multiplicities: [1, 2] };
    const warned = app.calcInspector(node);
    expect(warned).toMatch(/data-spin-state="1"[^>]*checked/);
    expect(warned).toContain('multiplicity 1');
    expect(warned).toContain('9 electrons');
    expect(warned).toContain('not a ground-state determination');
  });
});

describe('the expansion is visible', () => {
  let app;

  beforeAll(async () => {
    app = await import('../src/renderer/app.js');
  });

  it('plans one task per multiplicity and names each state', () => {
    // The wiring test: the renderer's own control (not a hand-written settings
    // literal) must be what the planner reads.
    const project = loadedProject();
    app.state.project = project;
    const node = calcNode(project);
    app.updateNodeField(node, 'spinSweepEnabled', true);
    app.updateSpinSweepState(node, 5, true);
    expect(node.settings.spinSweep).toEqual({ enabled: true, multiplicities: [1, 3, 5] });

    const plan = buildWorkflowPlan(project);
    const states = plan.tasks.filter((task) => task.spin);
    expect(states.map((task) => task.nodeId)).toEqual(['sp-energy.m1', 'sp-energy.m3', 'sp-energy.m5']);
    expect(states.map((task) => task.settings.multiplicity)).toEqual([1, 3, 5]);
    expect(states.map((task) => task.title)).toEqual([
      'Single-point energy — multiplicity 1',
      'Single-point energy — multiplicity 3',
      'Single-point energy — multiplicity 5',
    ]);
  });

  it('names the multiplicity on the queue row', () => {
    expect(app.spinTaskMeta({ spin: { multiplicity: 3, index: 1, count: 3 } })).toBe('m3 · state 2/3');
    expect(app.spinTaskMeta({})).toBe('');

    const project = loadedProject();
    const node = calcNode(project);
    app.state.project = project;
    node.settings.spinSweep = { enabled: true, multiplicities: [1, 3, 5] };
    expect(app.spinSweepLabel(node)).toBe('spin states 1, 3, 5');
    expect(app.nodeFoot(node).left).toContain('spin states 1, 3, 5');
  });

  it('reports the lowest computed state on the block card', () => {
    const project = loadedProject();
    const node = calcNode(project);
    app.state.project = project;
    node.settings.spinSweep = { enabled: true, multiplicities: [1, 3, 5] };
    app.state.queue = {
      id: 'q',
      status: 'completed',
      tasks: [],
      spins: {
        'sp-energy': {
          available: true,
          groundMultiplicity: 3,
          rows: [
            { multiplicity: 1, energyHartree: -75.98, relativeKcalPerMol: 12 },
            { multiplicity: 3, energyHartree: -76, relativeKcalPerMol: 0 },
            { multiplicity: 5, energyHartree: null, relativeKcalPerMol: null },
          ],
        },
      },
    };
    const facts = app.resultFacts(node);
    expect(facts.main).toBe('m3 lowest computed');
    expect(facts.sub).toContain('2/3 states ran');
    expect(facts.sub).toContain('m5 no energy');
    expect(facts.tone).toBe('warn');
  });
});

describe('the comparison the user reads', () => {
  const sweep = {
    available: true,
    groundMultiplicity: 3,
    degenerate: false,
    reason: 'Ground state: multiplicity 3.',
    rows: [
      { nodeId: 'a.m1', multiplicity: 1, energyHartree: -76 + H(12), relativeKcalPerMol: 12, spinSquared: 0 },
      { nodeId: 'a.m3', multiplicity: 3, energyHartree: -76, relativeKcalPerMol: 0, spinSquared: 2.0123 },
      { nodeId: 'a.m5', multiplicity: 5, energyHartree: -76 + H(35), relativeKcalPerMol: 35, spinSquared: 6.04 },
    ],
  };
  const record = { id: 'r1', status: 'completed', title: 'Single-point energy', parsed: {}, gates: { overall: 'unknown', gates: [] } };

  it('names the lowest computed state and lists every state', () => {
    const html = resultsPanelHtml(record, { spinSweep: sweep });
    expect(html).toContain('Spin-state comparison');
    expect(html).toContain('m3');
    expect(html).toContain('lowest computed');
    expect(html).toContain('m1');
    expect(html).toContain('m5');
    expect(html).toContain('same geometry');
    expect(html).toContain('not a ground-state determination');
    expect(html).toContain('2.0123');
    expect(html).toContain('12.00');
    expect(html).not.toContain('Ground state: multiplicity');
  });

  it('reports a state that failed instead of dropping the row', () => {
    const failed = {
      ...sweep,
      groundMultiplicity: 3,
      rows: [sweep.rows[0], sweep.rows[1], { nodeId: 'a.m5', multiplicity: 5, energyHartree: null, relativeKcalPerMol: null, spinSquared: null }],
    };
    const states = [
      { multiplicity: 1, status: 'completed' },
      { multiplicity: 3, status: 'completed' },
      { multiplicity: 5, status: 'timed out', error: 'stopped at the limit' },
    ];
    const html = resultsPanelHtml(record, { spinSweep: failed, spinStates: states });
    expect(html).toContain('m5');
    expect(html).toContain('timed out');
    expect(html).toContain('stopped at the limit');
    expect(html).toContain('Not ranked');
    expect(html).toContain('lowest computed');
    // The failed state is still the third row of the table, and it says why.
    const table = html.split('data-field="spin-states"')[1] || '';
    expect((table.match(/<td>m\d+<\/td>/g) || []).length).toBe(3);
    expect(table).toContain('<td>m5</td><td>timed out</td>');
  });

  it('says nothing is ranked when no state reported an energy', () => {
    const none = { available: false, groundMultiplicity: null, rows: [{ multiplicity: 1, energyHartree: null }, { multiplicity: 3, energyHartree: null }] };
    const html = resultsPanelHtml(record, { spinSweep: none });
    expect(html).toContain('No state in this sweep reported a final energy');
  });

  it('renders nothing for a run outside a sweep', () => {
    expect(resultsPanelHtml(record, {})).not.toContain('Spin-state comparison');
  });
});

describe('the report states the limit of a single-geometry sweep', () => {
  const queue = {
    id: 'q-spin',
    projectName: 'Spin',
    status: 'completed',
    tasks: [
      { nodeId: 'a.m1', title: 'SP — multiplicity 1', status: 'completed', spin: { id: 'a', multiplicity: 1, index: 0, count: 3 } },
      { nodeId: 'a.m3', title: 'SP — multiplicity 3', status: 'completed', spin: { id: 'a', multiplicity: 3, index: 1, count: 3 } },
      { nodeId: 'a.m5', title: 'SP — multiplicity 5', status: 'failed', error: 'SCF did not converge', spin: { id: 'a', multiplicity: 5, index: 2, count: 3 } },
    ],
    spins: {
      a: {
        available: true,
        groundMultiplicity: 3,
        reason: 'Ground state: multiplicity 3.',
        rows: [
          { nodeId: 'a.m1', multiplicity: 1, energyHartree: -75.98, relativeKcalPerMol: 12, spinSquared: 0 },
          { nodeId: 'a.m3', multiplicity: 3, energyHartree: -76, relativeKcalPerMol: 0, spinSquared: 2.0123 },
          { nodeId: 'a.m5', multiplicity: 5, energyHartree: null, relativeKcalPerMol: null, spinSquared: null },
        ],
      },
    },
  };

  it('lists each multiplicity with its energy and marks the lowest computed', () => {
    const html = workflowReportHtml(buildWorkflowReport(queue, {}));
    expect(html).toContain('Spin-state sweep — a');
    expect(html).toContain('lowest computed');
    expect(html).toContain('same starting geometry');
    expect(html).toContain('single-geometry comparison');
    expect(html).toContain('12.00');
    expect(html).toContain('2.0123');
    expect(html).not.toContain('Ground state: multiplicity');
  });

  it('reports the failed state by name rather than omitting it', () => {
    const html = workflowReportHtml(buildWorkflowReport(queue, {}));
    expect(html).toContain('m5 failed');
    expect(html).toContain('SCF did not converge');
    expect(html).toContain('Not ranked');
  });
});
