import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDataset } from '../src/shared/datasetImport.js';
import { defaultSettings, validateProject } from '../src/shared/projectSchema.js';
import { buildWorkflowPlan, drawingGateFor } from '../src/shared/workflowTasks.js';

/**
 * Issue 139: a CDXML drawing imported straight into a dataset.
 *
 * One `<fragment>` is one dataset record; the record is labelled from the
 * fragment's own text, and from its index only when the drawing gave it none.
 * Every drawing record carries `geometry.dimension = '2d'`, and a flow whose
 * first block is a frequency or a single point refuses it until the user
 * confirms. The formats that existed before this change keep their record shape
 * byte for byte.
 */

const read = (name) => readFileSync(`test/fixtures/structures/cdxml/${name}`, 'utf8');

const water = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.96, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.93, z: 0 },
];

/** Two fragments drawn with no text of their own, so the index has to name them. */
const UNNAMED_TWO_FRAGMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<CDXML Name="unnamed pair">
  <page id="1">
    <fragment id="2">
      <n id="11" p="10.0 10.0"><t id="12" p="10.0 10.0"><s>O</s></t></n>
    </fragment>
    <fragment id="3">
      <n id="21" p="40.0 10.0"><t id="22" p="40.0 10.0"><s>S</s></t></n>
    </fragment>
  </page>
</CDXML>`;

/** Two fragments drawn with the same label: a real thing in a comparative scheme. */
const SAME_LABEL_TWO_FRAGMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<CDXML Name="collision">
  <page id="1">
    <fragment id="2" Name="ligand">
      <n id="11" p="10.0 10.0"><t id="12" p="10.0 10.0"><s>N</s></t></n>
    </fragment>
    <fragment id="3" Name="ligand">
      <n id="21" p="40.0 10.0"><t id="22" p="40.0 10.0"><s>O</s></t></n>
    </fragment>
  </page>
</CDXML>`;

/** An SDF of two records, the format that must not change shape. */
function sdfBlock(title, atoms) {
  const line = (atom) => `${atom.x.toFixed(4).padStart(10)}${atom.y.toFixed(4).padStart(10)}${atom.z.toFixed(4).padStart(10)} ${atom.element.padEnd(3)}0  0  0  0  0  0  0  0  0  0  0  0`;
  return [
    title,
    '  NodeChem',
    '',
    `${String(atoms.length).padStart(3)}  0  0  0  0  0            999 V2000`,
    ...atoms.map(line),
  ].join('\n') + '\n$$$$\n';
}

/* ── A project for the run gate ───────────────────────────── */

function rawProject(records, jobType, { second = null } = {}) {
  const nodes = [
    {
      id: 'in', type: 'input', kind: 'Input', title: 'Drawings', state: 'ready', x: 0, y: 0,
      input: { datasetId: 'drawings', recordFilter: { field: '', equals: '' } },
    },
    {
      id: 'first', type: 'calc', kind: 'Calc', title: jobType === 'Freq' ? 'Frequency' : 'Single point',
      state: 'ready', x: 200, y: 0, settings: defaultSettings({ jobType }), output: null, checkpointFrom: null,
    },
  ];
  const edges = [{ id: 'e1', from: 'in', to: 'first', type: 'dependency' }];
  if (second) {
    nodes.push({
      id: 'second', type: 'calc', kind: 'Calc', title: second.title, state: 'ready', x: 400, y: 0,
      settings: defaultSettings({ jobType: second.jobType }), output: null, checkpointFrom: null,
    });
    edges.push({ id: 'e2', from: 'first', to: 'second', type: second.edge || 'checkpoint' });
  }
  return {
    schemaVersion: 2,
    name: 'Drawings',
    molecule: {
      charge: 0,
      multiplicity: 1,
      fragments: [],
      geometry: { source: 'imported', file: 'water.xyz', format: 'xyz' },
      coords: water,
    },
    defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
    runner: { maxParallel: 1 },
    datasets: [{
      id: 'drawings',
      title: 'Drawings',
      source: { kind: 'file', path: 'salt.cdxml', format: 'cdxml' },
      fields: { label: '', charge: '', multiplicity: '' },
      records,
      notes: '',
    }],
    flows: [{ id: 'main', title: 'Main', nodes, edges }],
    reports: [],
    activeFlowId: 'main',
  };
}

function validated(raw) {
  const result = validateProject(raw);
  expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
  return result.project;
}

describe('datasetImport — CDXML is a dataset', () => {
  it('imports a two-fragment drawing as two records, with its labels and coordinates', () => {
    const result = parseDataset(read('salt.cdxml'), { filename: 'salt.cdxml' });

    expect(result.format).toBe('cdxml');
    expect(result.errors).toEqual([]);
    expect(result.records).toHaveLength(2);
    expect(result.records.map((record) => record.label)).toEqual(['sodium cation', 'chloride anion']);
    expect(result.records.map((record) => record.id)).toEqual(['sodium-cation', 'chloride-anion']);
    expect(result.records.map((record) => record.charge)).toEqual([1, -1]);
    // The drawing's own atoms, not a merged molecule and not a guess.
    expect(result.records[0].coords).toEqual([{ element: 'Na', x: 80, y: 100, z: 0 }]);
    expect(result.records[1].coords).toEqual([{ element: 'Cl', x: 140, y: 100, z: 0 }]);
  });

  it('names a fragment from the text drawn beside it', () => {
    const result = parseDataset(read('graphics.cdxml'), { filename: 'graphics.cdxml' });
    expect(result.records.map((record) => record.label)).toEqual(['ethanol']);
  });

  it('labels an unnamed fragment by its index instead of inventing a name', () => {
    const result = parseDataset(UNNAMED_TWO_FRAGMENTS, { filename: 'pair.cdxml' });
    expect(result.records.map((record) => record.label)).toEqual(['fragment 1', 'fragment 2']);
    expect(result.records.map((record) => record.id)).toEqual(['fragment-1', 'fragment-2']);
  });

  /**
   * Rule for a label collision: the label is what the drawing says, so both
   * records keep it — two analogues really are both "ligand". The *id* is what a
   * task id has to be able to name, so the second fragment's id gets a numeric
   * suffix (`ligand`, `ligand-2`), exactly as a repeated SDF title does.
   */
  it('keeps a repeated label and makes the second id unique', () => {
    const result = parseDataset(SAME_LABEL_TWO_FRAGMENTS, { filename: 'collision.cdxml' });
    expect(result.records.map((record) => record.label)).toEqual(['ligand', 'ligand']);
    expect(result.records.map((record) => record.id)).toEqual(['ligand', 'ligand-2']);
    // Both fragments are still there, with their own atoms.
    expect(result.records.map((record) => record.coords[0].element)).toEqual(['N', 'O']);
  });

  it('carries the stated topology as well as the coordinates', () => {
    const [benzene] = parseDataset(read('benzene.cdxml'), { filename: 'benzene.cdxml' }).records;
    expect(benzene.bonds).toHaveLength(6);
    expect(benzene.bonds.every((bond) => bond.order === 1.5)).toBe(true);
  });

  it('marks every drawing record as 2d', () => {
    const result = parseDataset(read('salt.cdxml'), { filename: 'salt.cdxml' });
    expect(result.records.map((record) => record.geometry)).toEqual([
      { dimension: '2d' },
      { dimension: '2d' },
    ]);
  });

  it('reads a drawing pasted under another name, from its root element', () => {
    const result = parseDataset(read('benzene.cdxml'), { filename: 'pasted.txt' });
    expect(result.format).toBe('cdxml');
    expect(result.records).toHaveLength(1);
  });

  it('refuses a file the drawing reader refuses, with its message', () => {
    const result = parseDataset(read('refuse-label.cdxml'), { filename: 'refuse-label.cdxml' });
    // The readable fragments still import; the unreadable one is named.
    expect(result.records.length).toBeGreaterThanOrEqual(0);
    expect(result.errors.join(' ')).toMatch(/Fragment \d+/);
  });
});

describe('datasetImport — the formats that came before are unchanged', () => {
  it('leaves an SDF record with no geometry key and the same key order', () => {
    const result = parseDataset(sdfBlock('water', water), { filename: 'water.sdf' });
    const [record] = result.records;
    expect(Object.keys(record)).toEqual(['id', 'label', 'charge', 'multiplicity', 'coords', 'enabled']);
    expect('geometry' in record).toBe(false);
    expect('bonds' in record).toBe(false);
  });

  it('writes a byte-identical dataset for an SDF import', () => {
    const result = parseDataset(sdfBlock('water', water), { filename: 'water.sdf' });
    expect(JSON.stringify(result.records)).toBe(JSON.stringify([{
      id: 'water',
      label: 'water',
      charge: 0,
      multiplicity: 1,
      coords: water,
      enabled: true,
    }]));
  });

  it('leaves a JSON import that states no dimension unchanged', () => {
    const text = JSON.stringify([{ id: 'water', label: 'Water', coords: water }]);
    const result = parseDataset(text, { filename: 'water.json' });
    expect(Object.keys(result.records[0])).toEqual(['id', 'label', 'charge', 'multiplicity', 'coords', 'enabled']);
  });
});

describe('issue 139 — the 2D drawing run gate', () => {
  const imported = () => parseDataset(read('salt.cdxml'), { filename: 'salt.cdxml' }).records;

  it('refuses a drawing record at the first frequency, naming the record and the block', () => {
    const project = validated(rawProject(imported(), 'Freq'));
    const plan = buildWorkflowPlan(project);
    const tasks = plan.tasks.filter((task) => task.type === 'calc');

    expect(tasks).toHaveLength(2);
    // Neither dropped nor run: the record keeps its task, refused.
    expect(tasks.map((task) => task.executable)).toEqual([false, false]);
    expect(tasks.map((task) => task.drawingRefusal.recordLabel)).toEqual(['sodium cation', 'chloride anion']);

    const [first] = tasks;
    expect(first.drawingRefusal.blockTitle).toBe('Frequency');
    expect(first.drawingRefusal.jobType).toBe('Freq');
    expect(first.drawingRefusal.recordId).toBe('sodium-cation');
    expect(first.drawingRefusal.datasetId).toBe('drawings');
    expect(first.drawingRefusal.message).toContain('sodium cation');
    expect(first.drawingRefusal.message).toContain('Frequency');
    expect(first.drawingRefusal.message).toContain('2D drawing');
    // The message is also what the queue would record if the plan were queued.
    expect(first.pendingInput.reason).toBe(first.drawingRefusal.message);
    expect(first.inputText).toBe('');
  });

  it('refuses the same record at a single point', () => {
    const project = validated(rawProject(imported(), 'SP'));
    const tasks = buildWorkflowPlan(project).tasks.filter((task) => task.type === 'calc');
    expect(tasks.map((task) => task.drawingRefusal?.jobType)).toEqual(['SP', 'SP']);
  });

  it('lets the record run once the user confirms it', () => {
    const records = imported().map((record) => ({ ...record, drawingConfirmed: true }));
    const project = validated(rawProject(records, 'Freq'));
    // The confirmation is part of the record the schema writes back.
    expect(project.datasets[0].records.map((record) => record.drawingConfirmed)).toEqual([true, true]);
    expect(project.datasets[0].records[0].geometry).toEqual({ dimension: '2d' });

    const tasks = buildWorkflowPlan(project).tasks.filter((task) => task.type === 'calc');
    expect(tasks.map((task) => task.executable)).toEqual([true, true]);
    expect(tasks.map((task) => task.drawingRefusal)).toEqual([undefined, undefined]);
    expect(tasks[0].inputText).toContain('sodium');
  });

  it('does not ask when the drawing is optimised first', () => {
    const project = validated(rawProject(imported(), 'Opt', {
      second: { title: 'Frequency after optimisation', jobType: 'Freq' },
    }));
    const tasks = buildWorkflowPlan(project).tasks.filter((task) => task.type === 'calc');
    expect(tasks.some((task) => task.drawingRefusal)).toBe(false);
  });

  it('asks only for the block that consumes the drawing, not for a checkpoint reader', () => {
    const project = validated(rawProject(imported(), 'Freq', {
      second: { title: 'Second frequency', jobType: 'Freq', edge: 'checkpoint' },
    }));
    const tasks = buildWorkflowPlan(project).tasks.filter((task) => task.type === 'calc');
    // The first frequency is refused for both records. The second reads a
    // checkpoint, so the drawing's own coordinates never reach it and it is not
    // asked; it fails later as blocked on the block that never ran.
    expect(tasks.filter((task) => task.drawingRefusal).map((task) => task.drawingRefusal.blockTitle))
      .toEqual(['Frequency', 'Frequency']);
    expect(tasks.filter((task) => task.title.startsWith('Second frequency')).map((task) => task.drawingRefusal))
      .toEqual([undefined, undefined]);
  });

  it('says nothing about a 3D record', () => {
    const records = [{ id: 'water', label: 'water', charge: 0, multiplicity: 1, coords: water, enabled: true }];
    const project = validated(rawProject(records, 'Freq'));
    const gate = drawingGateFor(project, project.flows[0].nodes[1], project.datasets[0].records[0]);
    expect(gate).toBeNull();
    expect(buildWorkflowPlan(project).tasks.filter((task) => task.type === 'calc')[0].executable).toBe(true);
  });
});
