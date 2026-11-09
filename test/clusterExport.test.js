import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { buildGaussianInput, DEMO_WATER, outputNameFor } from '../src/shared/gaussianInput.js';
import { defaultSettings } from '../src/shared/projectSchema.js';
import { planClusterExport } from '../src/shared/clusterExport.js';

/**
 * Task fixtures mirror what `buildWorkflowTasks()` in the renderer produces:
 * the exact `.gjf` text is already built, and the planner must stage it
 * byte-for-byte.
 */
function calcTask(nodeId, settingsOverrides = {}, extra = {}) {
  const settings = defaultSettings(settingsOverrides);
  const inputName = `${nodeId}.gjf`;
  const oldCheckpoint = extra.oldCheckpoint || extra.checkpointFrom?.checkpoint || '';
  const inputText = buildGaussianInput({
    title: extra.title || `Task ${nodeId}`,
    settings: { ...settings, charge: 0, multiplicity: 1 },
    molecule: { charge: 0, multiplicity: 1, coords: DEMO_WATER },
    inputName,
    oldCheckpoint,
  });
  return {
    nodeId,
    type: 'calculate',
    title: extra.title || `Task ${nodeId}`,
    kind: 'Calc',
    executable: true,
    inputName,
    outputName: outputNameFor(inputName),
    inputText,
    gates: {
      expectedImaginary: null,
      minMagnitude: 50,
      requireOptimization: false,
      requireFrequency: false,
      requireThermochemistry: false,
      requireFinalEnergy: false,
      ...(extra.gates || {}),
    },
    checkpointName: settings.checkpoint || `${nodeId}.chk`,
    checkpointFrom: extra.checkpointFrom || null,
  };
}

const controlTask = (nodeId, type, title) => ({
  nodeId,
  type,
  title,
  kind: type === 'condition' ? 'If' : 'Loop',
  executable: false,
});

function fileNamed(plan, name) {
  const file = plan.files.find((entry) => entry.name === name);
  if (!file) throw new Error(`missing file ${name}`);
  return file.content;
}

function slurmProject() {
  const tasks = [
    calcTask('opt', { jobType: 'Opt', memory: '8', memoryUnit: 'GB', nproc: '4', checkpoint: 'opt.chk' }),
    calcTask('freq', { jobType: 'Freq', nproc: '4', checkpoint: 'freq.chk' }, {
      checkpointFrom: { nodeId: 'opt', checkpoint: 'opt.chk' },
    }),
    controlTask('cond', 'condition', 'True saddle?'),
    calcTask('sp', { jobType: 'SP', nproc: '2', memory: '500', memoryUnit: 'MB' }),
    controlTask('retry', 'loop', 'Re-guess TS'),
  ];
  const edges = [
    { from: 'opt', to: 'freq', type: 'checkpoint' },
    { from: 'freq', to: 'cond', type: 'dependency' },
    { from: 'cond', to: 'sp', type: 'branch', branch: 'true' },
    { from: 'cond', to: 'retry', type: 'branch', branch: 'false' },
    { from: 'retry', to: 'opt', type: 'loop' },
  ];
  return { tasks, edges };
}

describe('planClusterExport — file set and staged inputs', () => {
  it('writes one scheduler script per calculation node and stages the exact input text', () => {
    const { tasks, edges } = slurmProject();
    const plan = planClusterExport({
      format: 'slurm',
      projectName: 'Cluster test',
      tasks,
      edges,
      createdAt: '2026-11-07T12:00:00.000Z',
    });

    const scriptNames = plan.files.filter((file) => file.name.endsWith('.slurm')).map((file) => file.name);
    expect(scriptNames.sort()).toEqual(['freq.slurm', 'opt.slurm', 'sp.slurm']);

    for (const task of tasks.filter((entry) => entry.type === 'calculate')) {
      expect(fileNamed(plan, task.inputName)).toBe(task.inputText);
    }
    expect(fileNamed(plan, 'manifest.json')).toContain('"kind": "nodechem-studio-cluster-export"');
    expect(fileNamed(plan, 'README.txt')).toContain('Licence');
    expect(fileNamed(plan, 'submit-all.sh')).toContain('sbatch');
  });

  it('refuses to export a plan that contains a conformer block', () => {
    const { tasks, edges } = slurmProject();
    const withConformers = [
      { nodeId: 'conf', type: 'generate', title: 'Conformer ensemble', executable: false },
      ...tasks,
    ];
    expect(() => planClusterExport({ format: 'slurm', tasks: withConformers, edges }))
      .toThrow(/does not include Generate blocks.*Conformer ensemble/);
  });

  it('does not export control-flow nodes as jobs', () => {
    const { tasks, edges } = slurmProject();
    const plan = planClusterExport({ format: 'slurm', tasks, edges });
    const names = plan.files.map((file) => file.name);
    expect(names).not.toContain('cond.slurm');
    expect(names).not.toContain('retry.slurm');
    expect(names).not.toContain('cond.gjf');
    expect(names).not.toContain('retry.gjf');
  });

  it('refuses a project with no calculation blocks', () => {
    expect(() => planClusterExport({
      format: 'slurm',
      tasks: [controlTask('cond', 'condition', 'Only control')],
      edges: [],
    })).toThrow(/no calculation blocks/i);
  });

  it('refuses a cyclic graph instead of emitting a deadlock', () => {
    const tasks = [calcTask('a'), calcTask('b')];
    const edges = [
      { from: 'a', to: 'b', type: 'dependency' },
      { from: 'b', to: 'a', type: 'dependency' },
    ];
    expect(() => planClusterExport({ format: 'slurm', tasks, edges })).toThrow(/cycle/i);
  });
});

describe('planClusterExport — scheduler resources and scratch', () => {
  it('maps %NProcShared and %Mem to SLURM directives and sets scratch to $TMPDIR', () => {
    const { tasks, edges } = slurmProject();
    const plan = planClusterExport({ format: 'slurm', tasks, edges });
    const script = fileNamed(plan, 'opt.slurm');
    expect(script).toContain('#SBATCH --job-name=gn-opt');
    expect(script).toContain('#SBATCH --cpus-per-task=4');
    expect(script).toContain('#SBATCH --mem=8G');
    expect(script).toContain('export GAUSS_SCRDIR="${TMPDIR:-/tmp}"');
    expect(script).toContain('mkdir -p "$GAUSS_SCRDIR"');
    expect(script).toContain('"${G16_EXE:-g16}" "opt.gjf"');

    const spScript = fileNamed(plan, 'sp.slurm');
    expect(spScript).toContain('#SBATCH --cpus-per-task=2');
    expect(spScript).toContain('#SBATCH --mem=500M');
  });

  it('maps %NProcShared to ppn for PBS', () => {
    const { tasks, edges } = slurmProject();
    const plan = planClusterExport({ format: 'pbs', tasks, edges });
    const script = fileNamed(plan, 'freq.pbs');
    expect(script).toContain('#PBS -N gn-freq');
    expect(script).toContain('#PBS -l nodes=1:ppn=4');
    expect(script).toContain('#PBS -l mem=4gb');
    expect(fileNamed(plan, 'opt.pbs')).toContain('#PBS -l mem=8gb');
    expect(script).toContain('export GAUSS_SCRDIR="${TMPDIR:-/tmp}"');
    expect(script).toContain('cd "${PBS_O_WORKDIR:?PBS_O_WORKDIR is not set}"');
    expect(script).toContain('"${G16_EXE:-g16}" "freq.gjf"');
  });

  it('converts %Mem in MW to megabytes (64-bit words)', () => {
    const tasks = [calcTask('mw', { memory: '2', memoryUnit: 'MW', nproc: '1' })];
    const slurm = planClusterExport({ format: 'slurm', tasks, edges: [] });
    expect(fileNamed(slurm, 'mw.slurm')).toContain('#SBATCH --mem=16M');
    const pbs = planClusterExport({ format: 'pbs', tasks, edges: [] });
    expect(fileNamed(pbs, 'mw.pbs')).toContain('#PBS -l mem=16mb');
  });

  it('fails loudly when the staged input dropped %NProcShared', () => {
    const task = calcTask('broken');
    task.inputText = task.inputText.replace(/^%NProcShared=.*$/m, '');
    expect(() => planClusterExport({ format: 'slurm', tasks: [task], edges: [] }))
      .toThrow(/%NProcShared/);
  });
});

describe('planClusterExport — dependency mapping', () => {
  it('mirrors graph and checkpoint edges in the manifest and submit-all wrapper', () => {
    const { tasks, edges } = slurmProject();
    const plan = planClusterExport({
      format: 'slurm',
      tasks,
      edges,
      createdAt: '2026-11-07T12:00:00.000Z',
    });
    const byId = new Map(plan.manifest.nodes.map((node) => [node.nodeId, node]));
    expect(byId.get('opt').dependsOn).toEqual([]);
    expect(byId.get('freq').dependsOn).toEqual(['opt']);
    // The calc sits behind a condition node: its nearest calculation ancestor
    // still becomes a dependency, so it cannot start while upstream is running.
    expect(byId.get('sp').dependsOn).toEqual(['freq']);
    // The staged downstream input keeps the explicit checkpoint hand-off.
    expect(fileNamed(plan, 'freq.gjf')).toContain('%OldChk=opt.chk');

    const submit = fileNamed(plan, 'submit-all.sh');
    expect(submit).toContain("GN_JOB['opt']=$(sbatch --parsable 'opt.slurm')");
    expect(submit).toContain("GN_JOB['freq']=$(sbatch --parsable --dependency=afterok:${GN_JOB['opt']%%;*} 'freq.slurm')");
    expect(submit).toContain("GN_JOB['sp']=$(sbatch --parsable --dependency=afterok:${GN_JOB['freq']%%;*} 'sp.slurm')");
    expect(submit.indexOf("GN_JOB['opt']")).toBeLessThan(submit.indexOf("GN_JOB['freq']"));
    expect(submit.indexOf("GN_JOB['freq']")).toBeLessThan(submit.indexOf("GN_JOB['sp']"));
    // The per-node script also documents its manual submission dependency.
    expect(fileNamed(plan, 'freq.slurm')).toContain('--dependency=afterok:');
    expect(fileNamed(plan, 'opt.slurm')).not.toContain('--dependency=afterok:');
  });

  it('mirrors the same dependencies for PBS with -W depend=afterok', () => {
    const { tasks, edges } = slurmProject();
    const plan = planClusterExport({ format: 'pbs', tasks, edges });
    const submit = fileNamed(plan, 'submit-all.sh');
    expect(submit).toContain("GN_JOB['freq']=$(qsub -W depend=afterok:${GN_JOB['opt']} 'freq.pbs')");
    expect(submit).toContain("GN_JOB['sp']=$(qsub -W depend=afterok:${GN_JOB['freq']} 'sp.pbs')");
  });

  it('treats a declared checkpoint hand-off as a dependency even without an edge', () => {
    const tasks = [
      calcTask('a', { checkpoint: 'a.chk' }),
      calcTask('b', { checkpoint: 'b.chk' }, { checkpointFrom: { nodeId: 'a', checkpoint: 'a.chk' } }),
    ];
    const plan = planClusterExport({ format: 'slurm', tasks, edges: [] });
    expect(plan.manifest.nodes.find((node) => node.nodeId === 'b').dependsOn).toEqual(['a']);
    expect(fileNamed(plan, 'submit-all.sh')).toContain("afterok:${GN_JOB['a']%%;*}");
  });

  it('rejects a checkpoint name mismatch like the local queue does', () => {
    const tasks = [
      calcTask('a', { checkpoint: 'a.chk' }),
      calcTask('b', { checkpoint: 'b.chk' }, { checkpointFrom: { nodeId: 'a', checkpoint: 'wrong.chk' } }),
    ];
    expect(() => planClusterExport({ format: 'slurm', tasks, edges: [] }))
      .toThrow(/Checkpoint mismatch/);
  });

  it('rejects a checkpoint hand-off from the node itself', () => {
    const tasks = [
      calcTask('a', { checkpoint: 'a.chk' }, { checkpointFrom: { nodeId: 'a', checkpoint: 'a.chk' } }),
    ];
    expect(() => planClusterExport({ format: 'slurm', tasks, edges: [] }))
      .toThrow(/itself/);
  });

  it('rejects two jobs that would write the same checkpoint file in one folder', () => {
    const tasks = [
      calcTask('a', { checkpoint: 'same.chk' }),
      calcTask('b', { checkpoint: 'same.chk' }),
    ];
    expect(() => planClusterExport({ format: 'slurm', tasks, edges: [] }))
      .toThrow(/written by both/);
  });
});

describe('planClusterExport — warnings and offline guarantee', () => {
  it('warns that condition and loop nodes cannot be scheduled', () => {
    const { tasks, edges } = slurmProject();
    const plan = planClusterExport({ format: 'slurm', tasks, edges });
    expect(plan.warnings.some((warning) => /Condition node/.test(warning) && /cond/.test(warning))).toBe(true);
    expect(plan.warnings.some((warning) => /Loop node/.test(warning) && /retry/.test(warning))).toBe(true);
    expect(plan.manifest.warnings).toEqual(plan.warnings);
  });

  it('emits no network primitives in any generated file', () => {
    const { tasks, edges } = slurmProject();
    for (const format of ['slurm', 'pbs']) {
      const plan = planClusterExport({ format, tasks, edges });
      for (const file of plan.files) {
        expect(file.content, file.name).not.toMatch(/\b(curl|wget|ssh|scp|rsync)\b/);
        expect(file.content, file.name).not.toMatch(/https?:\/\//);
      }
    }
  });

  it('keeps the shared module free of network and child-process imports', async () => {
    const source = await readFile(new URL('../src/shared/clusterExport.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"]node:(?:http|https|net|tls|dgram)['"]/);
    expect(source).not.toMatch(/child_process/);
    expect(source).not.toMatch(/\bfetch\(/);
  });
});
