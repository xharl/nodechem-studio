import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { buildWorkflowTasks } from '../src/shared/workflowTasks.js';
import { validateProject } from '../src/shared/projectSchema.js';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'bin', 'ncs.js');
const example = (name) => path.join(root, 'examples', name);

async function ncs(args, options = {}) {
  try {
    const result = await run(process.execPath, [cli, ...args], { cwd: root, ...options });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
    };
  }
}

describe('shared task builder', () => {
  it('turns an example project into runnable tasks', () => {
    const project = validateProject(JSON.parse(readFileSync(example('single-point.ncs'), 'utf8'))).project;
    const tasks = buildWorkflowTasks(project);
    expect(tasks.length).toBeGreaterThan(0);
    const calc = tasks.find((task) => task.executable);
    expect(calc).toMatchObject({ engine: 'gaussian', type: 'calc' });
    expect(calc.inputText).toMatch(/^#p B3LYP\//m);
    expect(calc.inputName).toMatch(/\.gjf$/);
    expect(calc.gates).toHaveProperty('requireFinalEnergy');
  });

  it('keeps control-flow nodes as non-executable tasks', () => {
    const project = validateProject(JSON.parse(readFileSync(example('opt-freq.ncs'), 'utf8'))).project;
    const tasks = buildWorkflowTasks(project);
    for (const task of tasks.filter((entry) => entry.type !== 'calc')) {
      expect(task.executable).toBe(false);
    }
  });
});

describe('ncs validate', () => {
  it('accepts every shipped example with exit 0 and JSON', async () => {
    for (const name of ['single-point.ncs', 'opt-freq.ncs', 'ts-search.ncs']) {
      const result = await ncs(['validate', example(name)]);
      expect(result.code, name).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.ok).toBe(true);
      expect(Array.isArray(payload.errors)).toBe(true);
    }
  });

  it('rejects an invalid project with exit 2', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ncs-cli-'));
    const file = path.join(dir, 'broken.ncs');
    const project = JSON.parse(await readFile(example('single-point.ncs'), 'utf8'));
    for (const node of project.nodes) {
      if (node.type === 'calc') node.settings.jobType = 'BOGUS';
    }
    await writeFile(file, JSON.stringify(project), 'utf8');
    const result = await ncs(['validate', file]);
    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.errors[0].path).toMatch(/jobType/);
  });
});

describe('ncs build-input', () => {
  it('writes the input the app would write', async () => {
    const project = JSON.parse(await readFile(example('single-point.ncs'), 'utf8'));
    const nodeId = project.nodes.find((node) => node.type === 'calc').id;
    const result = await ncs(['build-input', example('single-point.ncs'), '--node', nodeId]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^%Mem=/);
    expect(result.stdout).toMatch(/^#p B3LYP\/def2SVP SP/m);
    expect(result.stdout).toContain('O      0.000000');
  });
});

describe('ncs run', () => {
  it('runs the queue in dry-run mode and writes the app\'s run folders', async () => {
    const out = await mkdtemp(path.join(tmpdir(), 'ncs-run-'));
    const result = await ncs(['run', example('opt-freq.ncs'), '--out', out, '--dry-run'], { timeout: 120000 });
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.status).toBe('completed');
    expect(summary.runs.length).toBeGreaterThan(0);
    for (const entry of summary.runs) {
      expect(entry.gates).toBe('pass');
      const record = JSON.parse(await readFile(path.join(entry.runDir, 'run.json'), 'utf8'));
      expect(record.status).toBe('completed');
      expect(record.provenance.kind).toBe('fixture');
    }
  }, 120000);

  it('exits 3 when a gate fails and 4 when the engine cannot run', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ncs-gate-'));
    const project = JSON.parse(await readFile(example('opt-freq.ncs'), 'utf8'));
    const freq = project.nodes.find((node) => node.type === 'calc' && /Freq/.test(node.settings.jobType));
    freq.settings.gates = { ...freq.settings.gates, imaginary: 2 };
    const file = path.join(dir, 'bad-gate.ncs');
    await writeFile(file, JSON.stringify(project), 'utf8');
    const gate = await ncs(['run', file, '--out', path.join(dir, 'run'), '--dry-run'], { timeout: 120000 });
    expect(gate.code).toBe(3);
    expect(JSON.parse(gate.stdout).runs.some((entry) => entry.gates === 'fail')).toBe(true);

    const engine = await ncs(
      ['run', example('single-point.ncs'), '--out', path.join(dir, 'engine'), '--executable', '/nonexistent/g16'],
      { timeout: 120000 },
    );
    expect(engine.code).toBe(4);
    expect(engine.stderr).toMatch(/not found/i);
  }, 180000);
});

describe('ncs diff and ncs merge', () => {
  async function divergent(edit) {
    const dir = await mkdtemp(path.join(tmpdir(), 'ncs-merge-'));
    const base = JSON.parse(await readFile(example('opt-freq.ncs'), 'utf8'));
    const ours = JSON.parse(JSON.stringify(base));
    const theirs = JSON.parse(JSON.stringify(base));
    edit(ours, theirs);
    const files = {};
    for (const [name, project] of [['base', base], ['ours', ours], ['theirs', theirs]]) {
      files[name] = path.join(dir, `${name}.ncs`);
      await writeFile(files[name], JSON.stringify(project), 'utf8');
    }
    return { dir, files };
  }

  it('reports structural changes between two projects', async () => {
    const { files } = await divergent((ours, theirs) => {
      ours.nodes[0].title = 'Renamed by us';
      theirs.nodes.push({ ...theirs.nodes[0], id: 'extra', title: 'Extra' });
    });
    const result = await ncs(['diff', files.ours, files.theirs, '--json']);
    expect(result.code).toBe(0);
    const diff = JSON.parse(result.stdout);
    expect(diff.nodes.added).toEqual(['extra']);
    expect(diff.nodes.changed).toHaveLength(1);
    expect(diff.nodes.changed[0].fields[0]).toMatchObject({ field: 'title', before: 'Renamed by us' });
  });

  it('merges non-overlapping edits and writes a valid project', async () => {
    const { dir, files } = await divergent((ours, theirs) => {
      ours.nodes[0].title = 'Renamed by us';
      const calc = theirs.nodes.find((node) => node.type === 'calc');
      calc.settings.method = 'M06-2X';
    });
    const out = path.join(dir, 'merged.ncs');
    const result = await ncs(['merge', files.base, files.ours, files.theirs, '--out', out]);
    expect(result.code).toBe(0);
    const merged = JSON.parse(await readFile(out, 'utf8'));
    // Schema v2 writes `flows[]`; the top-level nodes array is an in-memory alias.
    expect(merged.flows[0].nodes[0].title).toBe('Renamed by us');
    expect(merged.flows[0].nodes.some((node) => node.settings?.method === 'M06-2X')).toBe(true);
    expect(validateProject(merged).ok).toBe(true);
  });

  it('refuses overlapping edits with exit 5 and writes nothing', async () => {
    const { dir, files } = await divergent((ours, theirs) => {
      ours.nodes[0].title = 'One';
      theirs.nodes[0].title = 'Two';
    });
    const out = path.join(dir, 'merged.ncs');
    const result = await ncs(['merge', files.base, files.ours, files.theirs, '--out', out]);
    expect(result.code).toBe(5);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.conflicts[0].path).toBe(`${report.conflicts[0].id}.title`);
    await expect(readFile(out, 'utf8')).rejects.toThrow();
  });
});

describe('method ladders end to end', () => {
  it('runs one task per rung and writes a single ladder gate', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ncs-ladder-'));
    const project = JSON.parse(await readFile(example('single-point.ncs'), 'utf8'));
    const calc = project.nodes.find((node) => node.type === 'calc');
    calc.settings = {
      ...calc.settings,
      ladder: {
        enabled: true,
        toleranceKcal: 3,
        rungs: [
          { label: 'B3LYP', method: 'B3LYP', basis: calc.settings.basis },
          { label: 'PBE0', method: 'PBE0', basis: calc.settings.basis },
          { label: 'M06-2X', method: 'M06-2X', basis: calc.settings.basis },
        ],
      },
    };
    const file = path.join(dir, 'ladder.ncs');
    await writeFile(file, JSON.stringify(project), 'utf8');

    const out = path.join(dir, 'out');
    const result = await ncs(['run', file, '--out', out, '--dry-run'], { timeout: 180000 });
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.runs.map((run) => run.nodeId).sort()).toEqual([`${calc.id}.r1`, `${calc.id}.r2`, `${calc.id}.r3`]);

    const queueFile = path.join(out, 'queues', summary.queueId, 'queue.json');
    const queue = JSON.parse(await readFile(queueFile, 'utf8'));
    const ladderId = Object.keys(queue.ladders)[0];
    expect(ladderId).toBe(calc.id);
    expect(queue.ladders[ladderId].status).toBe('pass');
    expect(queue.ladders[ladderId].entries).toHaveLength(3);
    expect(queue.ladders[ladderId].entries[0].label).toBe('B3LYP');
    expect(queue.ladders[ladderId].toleranceKcal).toBe(3);
  }, 180000);
});
