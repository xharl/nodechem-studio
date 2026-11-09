import { describe, expect, it, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  conformerGroupLabel,
  conformerGroups,
  ensembleSummary,
  parseMultiXyz,
  rankEnsemble,
  withEnergies,
} from '../src/shared/conformers.js';
import {
  parseProjectText,
  stringifyProject,
  validateProject,
} from '../src/shared/projectSchema.js';
import { buildWorkflowPlan, conformerSearchTask } from '../src/shared/workflowTasks.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';

/**
 * #132: one conformer block models one ensemble, so a study with several
 * ensembles per system needs a way to say "these belong together" without a new
 * document type. `group` is that: a bounded token per block, never a chemical
 * claim, never a cross-block ranking, never an average.
 *
 * Every fixture is synthetic. Nothing here asserts that any two ensembles are
 * the same molecule — only that they say they belong to one study.
 */

const coords = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.96, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.93, z: 0 },
];

const molecule = {
  charge: 0,
  multiplicity: 1,
  fragments: [],
  coords,
  geometry: { source: 'imported', file: 'water.xyz', format: 'xyz' },
};

const project = (nodes, edges = []) => ({
  schemaVersion: 3,
  name: 'Conformer groups',
  molecule,
  defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
  nodes,
  edges,
});

const conformersNode = (id, settings = {}, output = null) => ({
  id, type: 'generate', title: `Ensemble ${id}`, state: 'ready', x: 0, y: 0, settings, output,
});

// ADR 0001: an imported ensemble is an input block plus a generate block.
const importedPair = (id, settings = {}, output = null, input = {}) => [
  {
    id: `ens-${id}`, type: 'input', kind: 'Ensemble input', title: `Input ${id}`, state: 'ready', x: -160, y: 0,
    input: {
      kind: 'ensemble', path: input.path || 'conf.xyz', format: 'xyz',
      energyUnit: input.energyUnit || 'hartree', energyMethod: input.energyMethod || '',
      origin: input.origin || { program: '', version: '', method: '' },
    },
  },
  conformersNode(id, { source: 'imported', ...settings }, output),
];
const importedEdge = (id) => [{ from: `ens-${id}`, to: id, type: 'dependency' }];

const summary = (overrides = {}) => ({
  generator: 'import',
  method: '',
  energyUnit: 'hartree',
  energyMethod: 'GFN2-xTB',
  count: 1,
  total: 1,
  spreadKcal: 0,
  generatedAt: '2026-11-08T00:00:00.000Z',
  selectedId: 'c1',
  requiresSelection: false,
  autoSelected: true,
  protomers: ['A'],
  pruned: { energy: 0, rmsd: 0, count: 0 },
  warnings: [],
  members: [{
    id: 'c1', rank: 1, energyEh: -76.4, relativeKcal: 0, population: 1,
    rmsdToLowest: 0, protomer: 'A', kept: true, dropped: null, atoms: coords,
  }],
  selected: { id: 'c1', energyEh: -76.4, relativeKcal: 0, population: 1, protomer: 'A', atoms: coords },
  ...overrides,
});

describe('#132 a group id round-trips through the schema', () => {
  it('defaults to empty so a project written before the field still opens', () => {
    const result = validateProject(project([conformersNode('conf1')]));
    expect(result.ok).toBe(true);
    expect(result.project.nodes[0].settings.group).toBe('');
    const reloaded = parseProjectText(stringifyProject(result.project).text);
    expect(reloaded.project.nodes[0].settings.group).toBe('');
  });

  it('stores a group id on the block and in the ensemble summary', () => {
    const result = validateProject(project(
      importedPair('conf1', { group: 'tautomer-study' }, summary({ group: 'tautomer-study' }), { path: 'a.xyz' }),
      importedEdge('conf1'),
    ));
    expect(result.ok).toBe(true);
    const reloaded = parseProjectText(stringifyProject(result.project).text);
    expect(reloaded.ok).toBe(true);
    const node = reloaded.project.nodes.find((entry) => entry.type === 'generate');
    expect(node.settings.group).toBe('tautomer-study');
    expect(node.output.group).toBe('tautomer-study');
  });

  it('refuses a group id that is not a plain bounded token, by name', () => {
    for (const bad of ['two words', ' leading', 'slash/here', 'x'.repeat(33), 42]) {
      const result = validateProject(project([conformersNode('conf1', { group: bad })]));
      expect(result.ok, `expected ${JSON.stringify(bad)} to be refused`).toBe(false);
      expect(result.errors.some((error) => /settings\.group/.test(error.path))).toBe(true);
    }
  });

  it('refuses a bad group in a stored ensemble too, naming the output path', () => {
    const result = validateProject(project([
      conformersNode('conf1', {}, summary({ group: 'not a token' })),
    ]));
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /output\.group/.test(error.path))).toBe(true);
  });

  it('keeps "no group" absent rather than storing a placeholder', () => {
    const result = validateProject(project([conformersNode('conf1', { group: '' })]));
    expect(result.ok).toBe(true);
    expect(result.project.nodes[0].settings.group).toBe('');
    expect('group' in result.project.nodes[0].settings ? result.project.nodes[0].settings.group : '').toBe('');
  });
});

describe('#132 the group is per block, never per member', () => {
  it('writes the block group onto the ensemble and leaves members without one', () => {
    const parsed = parseMultiXyz([
      '3', 'protomer=A energy=-76.400000',
      ...coords.map((atom) => `${atom.element} ${atom.x} ${atom.y} ${atom.z}`),
      '',
    ].join('\n'));
    expect(parsed.errors).toEqual([]);
    const ranked = rankEnsemble({ frames: withEnergies(parsed.frames, []).frames, rmsdThreshold: 0.05 });
    const withGroup = ensembleSummary(ranked, { generator: 'crest', method: 'gfn2', group: 'study-1' });
    expect(withGroup.group).toBe('study-1');
    expect(withGroup.members.every((member) => !('group' in member))).toBe(true);
    expect(withGroup.selected && 'group' in withGroup.selected).toBe(false);
  });

  it('cannot mix groups: a member that names a group is dropped, not merged', () => {
    const bad = summary({
      group: 'study-1',
      members: [
        { id: 'c1', rank: 1, energyEh: -76.4, relativeKcal: 0, population: 0.6, rmsdToLowest: 0, protomer: 'A', kept: true, dropped: null, atoms: coords, group: 'other-study' },
        { id: 'c2', rank: 2, energyEh: -76.39, relativeKcal: 0.6, population: 0.4, rmsdToLowest: 0.4, protomer: 'A', kept: true, dropped: null, atoms: coords },
      ],
    });
    const result = validateProject(project([conformersNode('conf1', { group: 'study-1' }, bad)]));
    expect(result.ok).toBe(true);
    const output = result.project.nodes[0].output;
    expect(output.group).toBe('study-1');
    expect(output.members).toHaveLength(2);
    expect(output.members.every((member) => !('group' in member))).toBe(true);
  });

  it('passes the block group into the task the queue receives', () => {
    const validated = validateProject(project([
      ...importedPair('conf1', { group: 'study-1' }, null, { path: 'conf.xyz' }),
    ], importedEdge('conf1'))).project;
    const task = conformerSearchTask(validated, validated.nodes.find((entry) => entry.type === 'generate'));
    expect(task.generate.group).toBe('study-1');
    const ungrouped = validateProject(project(
      importedPair('conf2', {}, null, { path: 'conf.xyz' }),
      importedEdge('conf2'),
    )).project;
    expect(conformerSearchTask(ungrouped, ungrouped.nodes.find((entry) => entry.type === 'generate')).generate.group).toBe('');
  });
});

describe('#132 the visible relationship', () => {
  const blocks = [
    { id: 'conf1', title: 'Ensemble A', group: 'study-1', protomers: ['A'] },
    { id: 'conf2', title: 'Ensemble B', group: 'study-1', protomers: ['B'] },
    { id: 'conf3', title: 'Ensemble C', group: '', protomers: [] },
  ];

  it('lists two blocks with the same group together', () => {
    const groups = conformerGroups(blocks);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('study-1');
    expect(groups[0].blocks.map((block) => block.id)).toEqual(['conf1', 'conf2']);
    expect(groups[0].blocks.map((block) => block.protomers)).toEqual([['A'], ['B']]);
  });

  it('omits a block without a group instead of listing it under a null group', () => {
    const groups = conformerGroups(blocks);
    expect(groups.map((entry) => entry.id)).toEqual(['study-1']);
    expect(groups.some((entry) => entry.id === '' || entry.id === 'null')).toBe(false);
    expect(groups.flatMap((entry) => entry.blocks.map((block) => block.id))).not.toContain('conf3');
  });

  it('prints group <id> and the count the flow shares', () => {
    expect(conformerGroupLabel('study-1', { blocks: 2 })).toBe('group study-1 · 2 blocks in this flow');
    expect(conformerGroupLabel('study-1', { blocks: 1 })).toBe('group study-1 · 1 block in this flow');
    expect(conformerGroupLabel('study-1', { blocks: 2, compact: true })).toBe('group study-1 · 2 blocks');
    // An absent group prints nothing at all, not "group null".
    expect(conformerGroupLabel('', { blocks: 0 })).toBe('');
    expect(conformerGroupLabel(null, { blocks: 3 })).toBe('');
  });
});

/** Two fanned-out ensembles in one flow, both under the same study id. */
const reportQueue = ({
  groupA = 'study-x',
  groupB = 'study-x',
  groupC = '',
  titleA = 'Ensemble A',
  titleB = 'Ensemble B',
  titleC = 'Ensemble C',
} = {}) => ({
  id: 'q-groups',
  projectName: 'Tautomer study',
  status: 'completed',
  tasks: [
    { nodeId: 'confA', title: titleA, type: 'generate', status: 'completed', generate: { temperature: 298.15, group: groupA } },
    { nodeId: 'confB', title: titleB, type: 'generate', status: 'completed', generate: { temperature: 298.15, group: groupB } },
    { nodeId: 'confC', title: titleC, type: 'generate', status: 'completed', generate: { temperature: 298.15, group: groupC } },
    {
      nodeId: 'optA~c1', title: `${titleA} — c1`, type: 'calculate', kind: 'Opt', status: 'passed', runId: 'run-a1',
      conformer: { nodeId: 'confA', title: titleA, id: 'c1', relativeKcal: 0, population: 0.9, protomer: 'A' },
      fanOut: { conformerId: 'confA', memberId: 'c1' },
    },
    {
      nodeId: 'optA~c2', title: `${titleA} — c2`, type: 'calculate', kind: 'Opt', status: 'passed', runId: 'run-a2',
      conformer: { nodeId: 'confA', title: titleA, id: 'c2', relativeKcal: 1.0, population: 0.1, protomer: 'A' },
      fanOut: { conformerId: 'confA', memberId: 'c2' },
    },
    {
      nodeId: 'optB~c1', title: `${titleB} — c1`, type: 'calculate', kind: 'Opt', status: 'passed', runId: 'run-b1',
      conformer: { nodeId: 'confB', title: titleB, id: 'c1', relativeKcal: 0, population: 0.8, protomer: 'B' },
      fanOut: { conformerId: 'confB', memberId: 'c1' },
    },
    {
      nodeId: 'optB~c2', title: `${titleB} — c2`, type: 'calculate', kind: 'Opt', status: 'passed', runId: 'run-b2',
      conformer: { nodeId: 'confB', title: titleB, id: 'c2', relativeKcal: 2.0, population: 0.2, protomer: 'B' },
      fanOut: { conformerId: 'confB', memberId: 'c2' },
    },
    {
      nodeId: 'optC~c1', title: `${titleC} — c1`, type: 'calculate', kind: 'Opt', status: 'passed', runId: 'run-c1',
      conformer: { nodeId: 'confC', title: titleC, id: 'c1', relativeKcal: 0, population: 1, protomer: '' },
      fanOut: { conformerId: 'confC', memberId: 'c1' },
    },
    {
      nodeId: 'optC~c2', title: `${titleC} — c2`, type: 'calculate', kind: 'Opt', status: 'passed', runId: 'run-c2',
      conformer: { nodeId: 'confC', title: titleC, id: 'c2', relativeKcal: 0.5, population: 0.3, protomer: '' },
      fanOut: { conformerId: 'confC', memberId: 'c2' },
    },
  ],
  records: {
    'run-a1': { parsed: { finalEnergy: { hartree: -76.4000 } }, provenance: { method: { functional: 'B3LYP', basis: 'def2-SVP' } } },
    'run-a2': { parsed: { finalEnergy: { hartree: -76.3980 } }, provenance: { method: { functional: 'B3LYP', basis: 'def2-SVP' } } },
    'run-b1': { parsed: { finalEnergy: { hartree: -76.3000 } }, provenance: { method: { functional: 'B3LYP', basis: 'def2-SVP' } } },
    'run-b2': { parsed: { finalEnergy: { hartree: -76.2900 } }, provenance: { method: { functional: 'B3LYP', basis: 'def2-SVP' } } },
    'run-c1': { parsed: { finalEnergy: { hartree: -76.2000 } }, provenance: { method: { functional: 'B3LYP', basis: 'def2-SVP' } } },
    'run-c2': { parsed: { finalEnergy: { hartree: -76.1990 } }, provenance: { method: { functional: 'B3LYP', basis: 'def2-SVP' } } },
  },
});

describe('#132 the report groups headings and keeps the numbers separate', () => {
  it('puts two grouped ensembles under one heading that names the group', () => {
    const { records, ...queue } = reportQueue();
    const html = workflowReportHtml(buildWorkflowReport(queue, records));
    const groupHeading = 'Conformer ensembles — group “study-x”';
    expect(html.split(groupHeading)).toHaveLength(2); // exactly one heading
    expect(html).toContain('2 blocks in this flow share the group id “study-x”, set by hand: they belong to the same study.');
    expect(html).toContain('A group is not a protomer or tautomer judgement');
    expect(html).toContain('not comparable without a proton reference');
    expect(html).toContain('nothing is averaged across the group');
    // Both ensembles are subsections under that one heading, in order.
    const groupAt = html.indexOf(groupHeading);
    const aAt = html.indexOf('Conformer ensemble at the target level — Ensemble A');
    const bAt = html.indexOf('Conformer ensemble at the target level — Ensemble B');
    expect(aAt).toBeGreaterThan(groupAt);
    expect(bAt).toBeGreaterThan(aAt);
    // The ungrouped block keeps its own section and is not swept into the group.
    const cAt = html.indexOf('Conformer ensemble at the target level — Ensemble C');
    expect(cAt).toBeGreaterThan(bAt);
    const groupSection = html.slice(groupAt, cAt);
    expect(groupSection).not.toContain('Ensemble C');
  });

  it("keeps each ensemble's own numbers, protomer label and level", () => {
    const { records, ...queue } = reportQueue();
    const html = workflowReportHtml(buildWorkflowReport(queue, records));
    const aAt = html.indexOf('Conformer ensemble at the target level — Ensemble A');
    const bAt = html.indexOf('Conformer ensemble at the target level — Ensemble B');
    const cAt = html.indexOf('Conformer ensemble at the target level — Ensemble C');
    const sectionA = html.slice(aAt, bAt);
    const sectionB = html.slice(bAt, cAt);
    // A's two members differ by 0.002 Ha ≈ 1.255 kcal/mol; B's by 0.010 ≈ 6.275.
    expect(sectionA).toContain('1.26');
    expect(sectionA).not.toContain('6.28');
    expect(sectionB).toContain('6.28');
    expect(sectionB).not.toContain('1.26');
    // Each subsection states its own protomer label and level, never the other's.
    expect(sectionA).toContain('Protomer label: A');
    expect(sectionA).not.toContain('Protomer label: B');
    expect(sectionB).toContain('Protomer label: B');
    expect(sectionA).toContain('target E in Hartree');
    expect(sectionA).toContain('level B3LYP/def2-SVP');
    expect(sectionB).toContain('level B3LYP/def2-SVP');
  });

  it('reports an ensemble with no protomer label as not recorded', () => {
    const { records, ...queue } = reportQueue();
    const html = workflowReportHtml(buildWorkflowReport(queue, records));
    const cAt = html.indexOf('Conformer ensemble at the target level — Ensemble C');
    const sectionC = html.slice(cAt);
    expect(sectionC).toContain('Protomer label: not recorded');
  });

  it('leaves two ungrouped ensembles as separate sections', () => {
    const { records, ...queue } = reportQueue({ groupA: '', groupB: '' });
    const html = workflowReportHtml(buildWorkflowReport(queue, records));
    expect(html).not.toContain('Conformer ensembles — group');
    expect(html.match(/Conformer ensemble at the target level/g)).toHaveLength(3);
  });

  it('does not group two blocks that carry different ids', () => {
    const { records, ...queue } = reportQueue({ groupA: 'study-x', groupB: 'study-y' });
    const html = workflowReportHtml(buildWorkflowReport(queue, records));
    expect(html).toContain('Conformer ensembles — group “study-x”');
    expect(html).toContain('Conformer ensembles — group “study-y”');
    expect(html).toContain('1 block in this flow share the group id “study-x”');
  });
});

describe('#132 the queue writes the group into conformers.json', () => {
  const roots = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
  });

  async function stack() {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ncs-group-'));
    roots.push(base);
    const runsRoot = path.join(base, 'runs');
    await fsp.mkdir(runsRoot, { recursive: true });
    const runManager = new RunManager({ runsRoot, emit: () => {} });
    const queueManager = new QueueManager({ queuesRoot: path.join(base, 'queues'), runManager, emit: () => {} });
    await queueManager.init();
    return { base, queueManager };
  }

  async function waitFor(check, timeout = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = await check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out waiting for the queue');
  }

  it('records the block group in the ensemble file the run leaves behind', async () => {
    const { base, queueManager } = await stack();
    const ensemblePath = path.join(base, 'synthetic.xyz');
    await fsp.writeFile(ensemblePath, [
      '3', 'conformer 1 energy=-76.400000 protomer=A',
      ...coords.map((atom) => `${atom.element} ${atom.x} ${atom.y} ${atom.z}`),
      '', '3', 'conformer 2 energy=-76.396000 protomer=A',
      ...coords.map((atom) => `${atom.element} ${atom.x} ${atom.y + 0.8} ${atom.z}`),
      '',
    ].join('\n'), 'utf8');
    const validated = validateProject(project(
      importedPair('conf', { rmsdThreshold: 0.05, group: 'study-1' }, null, { path: ensemblePath }),
      importedEdge('conf'),
    ));
    expect(validated.ok).toBe(true);
    const plan = buildWorkflowPlan(validated.project);
    const started = await queueManager.start({
      projectName: validated.project.name,
      tasks: plan.tasks,
      edges: plan.edges,
      options: { dryRun: false, executable: null, crestExecutable: '', scratchDir: '' },
    });
    const done = await waitFor(async () => {
      const queue = (await queueManager.list()).find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' ? queue : null;
    });
    const conformers = done.tasks.find((entry) => entry.nodeId === 'conf');
    expect(conformers.error).toBeNull();
    const written = JSON.parse(await fsp.readFile(path.join(conformers.runDir, 'conformers.json'), 'utf8'));
    expect(written.group).toBe('study-1');
    expect(written.members.some((member) => 'group' in member)).toBe(false);
    // The summary the project stores carries it too, so save/load keeps the link.
    expect(conformers.ensemble.group).toBe('study-1');
    const reloaded = parseProjectText(stringifyProject(project(
      importedPair('conf', { group: 'study-1' }, conformers.ensemble, { path: ensemblePath }),
      importedEdge('conf'),
    )).text);
    expect(reloaded.ok).toBe(true);
    expect(reloaded.project.nodes.find((entry) => entry.type === 'generate').output.group).toBe('study-1');
  });

  it('drops a hand-written queue group that is not a plain token instead of storing it', async () => {
    const { queueManager } = await stack();
    const started = await queueManager.start({
      projectName: 'bad group',
      tasks: [{
        nodeId: 'conf', type: 'generate', title: 'Ensemble', inputName: 'in.xyz',
        inputText: '3\nwater\nO 0 0 0\nH 0.96 0 0\nH -0.24 0.93 0\n',
        generate: { generator: 'crest', group: 'two words' },
      }],
      edges: [],
      options: { dryRun: true, executable: null, crestExecutable: '', scratchDir: '' },
    });
    const stored = (await queueManager.list()).find((entry) => entry.id === started.id);
    // Let the dry-run task finish before the temp folder is removed.
    await waitFor(async () => {
      const queue = (await queueManager.list()).find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' ? queue : null;
    });
    expect(stored.tasks[0].generate.group).toBe('');
  });
});
