import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultSettings, parseProjectText, validateProject } from '../src/shared/projectSchema.js';
import { buildRunInput, buildWorkflowPlan, engineForNode } from '../src/shared/workflowTasks.js';
import { replaceInputGeometry } from '../src/shared/gaussianInput.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';

const WATER = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.96, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.93, z: 0 },
];

const calcNode = (id, overrides = {}) => ({
  id,
  type: 'calc',
  title: id,
  x: 0,
  y: 0,
  settings: defaultSettings({ jobType: 'Opt', ...overrides }),
});

const twoEngineProject = () => ({
  schemaVersion: 1,
  name: 'xtb then gaussian',
  defaults: { engine: 'gaussian', method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: 4 },
  molecule: { charge: 0, multiplicity: 1, coords: WATER, fragments: [], geometry: { kind: 'manual' } },
  nodes: [
    calcNode('pre-opt', { engine: 'xtb', xtbMethod: 'gfn2', xtbOptLevel: 'tight' }),
    calcNode('sp', { engine: 'gaussian', jobType: 'SP', method: 'B3LYP', basis: 'def2-TZVP', dispersion: 'GD3BJ' }),
  ],
  edges: [{ from: 'pre-opt', to: 'sp', type: 'checkpoint' }],
});

describe('per-block engines', () => {
  it('loads a project whose blocks name their own engine', () => {
    const result = validateProject(twoEngineProject());
    expect(result.ok).toBe(true);
    expect(result.project.nodes[0].settings.engine).toBe('xtb');
    expect(result.project.nodes[1].settings.engine).toBe('gaussian');
  });

  it('keeps an existing single-engine file unchanged: no stored engine means inherit', () => {
    const single = validateProject({ ...twoEngineProject(), nodes: [calcNode('opt')], edges: [] }).project;
    expect(single.nodes[0].settings.engine).toBe('');
    expect(engineForNode(single, single.nodes[0]).id).toBe('gaussian');
    // And the file it came from still round-trips through the parser.
    const text = JSON.stringify(single);
    expect(parseProjectText(text).ok).toBe(true);
  });

  it('builds each block with its own engine', () => {
    const project = validateProject(twoEngineProject()).project;
    const plan = buildWorkflowPlan(project);
    const byId = Object.fromEntries(plan.tasks.map((task) => [task.nodeId, task]));
    expect(byId['pre-opt'].engine).toBe('xtb');
    expect(byId['pre-opt'].inputName).toMatch(/\.xyz$/);
    expect(byId.sp.engine).toBe('gaussian');
    expect(byId.sp.inputName).toMatch(/\.gjf$/);
    // The Gaussian block was planned with the project geometry...
    expect(byId.sp.inputText).toContain('O ');
  });

  it('refuses a Gaussian-only setting on an xTB block at validation time', () => {
    const raw = twoEngineProject();
    // An Opt with excited states also names its root (#146); the xTB refusal is
    // what this test is about.
    raw.nodes[0].settings.tdStates = 5;
    raw.nodes[0].settings.tdRoot = 1;
    const project = validateProject(raw).project;
    expect(() => buildRunInput(project, project.nodes[0]))
      .toThrow(/TD-DFT states cannot be used on an xTB block/);
  });

  it('accepts the same setting on the Gaussian block', () => {
    const project = validateProject({
      ...twoEngineProject(),
      nodes: [calcNode('sp', { engine: 'gaussian', jobType: 'SP' })],
      edges: [],
    }).project;
    expect(() => buildRunInput(project, project.nodes[0])).not.toThrow();
  });
});

describe('geometry across an engine boundary', () => {
  const input = [
    '%Mem=4GB',
    '%NProcShared=4',
    '%Chk=sp.chk',
    '#p B3LYP/def2TZVP EmpiricalDispersion=GD3BJ SP',
    '',
    'Single point',
    '',
    '0 1',
    'O   0.000000 0.000000 0.000000',
    'H   0.960000 0.000000 0.000000',
    'H  -0.240000 0.930000 0.000000',
    '',
    '',
  ].join('\n');

  it('replaces the coordinates and keeps the route', () => {
    const optimised = [
      { element: 'O', x: 0.01, y: -0.02, z: 0.03 },
      { element: 'H', x: 0.97, y: 0.01, z: 0.02 },
      { element: 'H', x: -0.25, y: 0.94, z: -0.01 },
    ];
    const next = replaceInputGeometry(input, optimised);
    expect(next).toContain('B3LYP/def2TZVP EmpiricalDispersion=GD3BJ');
    expect(next).toMatch(/O\s+0\.010000/);
    expect(next).not.toContain('0.960000');
    expect(next.split('\n').filter((line) => /^[A-Z][a-z]?\s/.test(line))).toHaveLength(3);
  });

  it('refuses an input with no molecule specification instead of guessing', () => {
    expect(() => replaceInputGeometry('#p B3LYP/def2SVP SP\n\nTitle\n', WATER))
      .toThrow(/no charge\/multiplicity line/);
  });

  it('refuses an empty hand-off', () => {
    expect(() => replaceInputGeometry(input, [])).toThrow(/No atoms were supplied/);
  });
});

describe('the report names the hand-off', () => {
  it('records the engine and the geometry source per block', () => {
    const model = buildWorkflowReport({
      id: 'q',
      projectName: 'two engines',
      status: 'completed',
      tasks: [
        { nodeId: 'pre-opt', title: 'xTB pre-opt', status: 'completed', engine: 'xtb' },
        {
          nodeId: 'sp',
          title: 'DFT single point',
          status: 'completed',
          engine: 'gaussian',
          geometryHandoff: { from: 'pre-opt', fromEngine: 'xtb', toEngine: 'gaussian', atoms: 3 },
        },
      ],
    }, {});
    const html = workflowReportHtml(model);
    expect(html).toContain('xTB pre-opt');
    expect(html).toContain('geometry from pre-opt');
    expect(html).toContain('xtb → gaussian');
    expect(html).toContain('3 atoms');
  });
});
