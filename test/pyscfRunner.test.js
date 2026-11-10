import { afterEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PyscfRunner } from '../electron/runner/pyscfRunner.js';

const roots = [];

async function tempRoot(prefix = 'gns-pyscf-runner-') {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

const record = {
  schema: 'nodechem.pyscf.v1',
  engine: 'pyscf',
  ok: true,
  energy: -75.96092810964097,
  converged: true,
  scfConverged: true,
  nIter: 9,
  method: 'HF',
  methodKey: 'hf',
  basis: 'def2-SVP',
  basisKey: 'def2-svp',
  jobType: 'SP',
  pyscfVersion: '2.15.0',
  geometry: [],
  moEnergies: [],
  frequencies: null,
  solvation: null,
  error: null,
};

async function fakePython(dir, body, name = 'python3') {
  const executable = path.join(dir, name);
  await fsp.writeFile(executable, `#!/bin/sh\n${body}\n`);
  await fsp.chmod(executable, 0o755);
  return executable;
}

describe('PySCF runner', () => {
  it('passes the deck as argv[0], captures stdout and reads the sidecar record', async () => {
    const root = await tempRoot();
    const cwd = path.join(root, 'run');
    await fsp.mkdir(cwd);
    await fsp.writeFile(path.join(cwd, 'job.py'), 'print("deck")\n');
    const json = JSON.stringify(record);
    const executable = await fakePython(root, [
      'deck="$1"',
      'printf "PySCF 2.15.0\\nNCS-PYSCF-RESULT-BEGIN\\n%s\\nNCS-PYSCF-RESULT-END\\n" \'' + json + '\'',
      'printf "%s" \'' + json + '\' > "${deck%.py}.json"',
    ].join('\n'));

    const seen = [];
    const result = await new PyscfRunner().run({
      executable,
      argv: ['job.py'],
      cwd,
      outputName: 'job.out',
      onOutput: (event) => seen.push(event.stream),
    });

    expect(result.exitCode).toBe(0);
    expect(result.outputText).toContain('PySCF 2.15.0');
    expect(result.outputText).toContain('NCS-PYSCF-RESULT-BEGIN');
    expect(JSON.parse(result.recordText)).toMatchObject({ schema: 'nodechem.pyscf.v1', energy: -75.96092810964097 });
    expect(result.recordFile).toBe('job.json');
    expect(result.outputSource).toBe('stdout');
    expect(seen).toContain('stdout');
    expect(await fsp.readFile(path.join(cwd, 'job.out'), 'utf8')).toBe(result.outputText);
  });

  it('completes the log from the sidecar when stdout lost the markers', async () => {
    const root = await tempRoot();
    const cwd = path.join(root, 'run');
    await fsp.mkdir(cwd);
    const executable = await fakePython(root, [
      'deck="$1"',
      'printf "quiet wrapper\\n"',
      'printf "%s" \'' + JSON.stringify(record) + '\' > "${deck%.py}.json"',
    ].join('\n'));

    const result = await new PyscfRunner().run({
      executable, argv: ['job.py'], cwd, outputName: 'job.out',
    });
    expect(result.outputText).toContain('quiet wrapper');
    expect(result.outputText).toContain('NCS-PYSCF-RESULT-BEGIN');
    expect(result.outputText).toContain('NCS-PYSCF-RESULT-END');
    expect(result.recordText).toContain('"schema":"nodechem.pyscf.v1"');
  });

  it('leaves a non-empty log a wrapper wrote', async () => {
    const root = await tempRoot();
    const cwd = path.join(root, 'run');
    await fsp.mkdir(cwd);
    await fsp.writeFile(path.join(cwd, 'job.out'), 'wrapper wrote this log\n');
    const executable = await fakePython(root, 'printf "short stdout\\n"');

    const result = await new PyscfRunner().run({
      executable, argv: ['job.py'], cwd, outputName: 'job.out',
    });
    expect(result.outputSource).toBe('file');
    expect(result.outputText).toBe('wrapper wrote this log\n');
  });

  it('rejects a missing deck argument and a missing executable by name', async () => {
    const root = await tempRoot();
    await expect(new PyscfRunner().run({ executable: '/bin/true', argv: [], cwd: root, outputName: 'x.out' }))
      .rejects.toThrow(/deck path is argv\[0\]/);
    await expect(new PyscfRunner().run({
      executable: path.join(root, 'not-python'), argv: ['x.py'], cwd: root, outputName: 'x.out',
    })).rejects.toThrow(/not-python/);
  });

  it('cancels a long deck and reports it as cancelled', async () => {
    const root = await tempRoot();
    const executable = await fakePython(root, 'sleep 30');
    const started = Date.now();
    const result = await new PyscfRunner().run({
      executable, argv: ['job.py'], cwd: root, outputName: 'job.out', timeoutMs: 150,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.cancelled).toBe(true);
    expect(result.signal).toBeTruthy();
  });

  it('sets thread variables for PySCF and validates the count', () => {
    const env = PyscfRunner.environmentFor({ threads: 4, env: { PATH: '/bin', OMP_NUM_THREADS: '2' } });
    expect(env.OMP_NUM_THREADS).toBe('4');
    expect(env.MKL_NUM_THREADS).toBe('4');
    expect(env.OPENBLAS_NUM_THREADS).toBe('4');
    expect(env.NUMEXPR_NUM_THREADS).toBe('4');
    expect(env.PYTHONUNBUFFERED).toBe('1');
    expect(env.PATH).toBe('/bin');
    expect(() => PyscfRunner.environmentFor({ threads: 'many' })).toThrow(/integer between 1 and 256/);
    expect(() => PyscfRunner.environmentFor({ threads: 0 })).toThrow(/integer between 1 and 256/);
  });
});
