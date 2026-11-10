import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunManager } from '../electron/runner/runManager.js';
import { Psi4Runner } from '../electron/runner/psi4Runner.js';

/**
 * Issue 283: Psi4 defaults its scratch to `/tmp`, which on a laptop is a
 * tmpfs of a few GiB. An 84-atom def2-TZVP job fills it and dies with
 * `WRITE failed … No space left on device`, and the run record said only
 * `termination: "No termination marker"`.
 *
 * The queue already created `runs/<id>/scratch`; these tests pin that the
 * child is told about it, and that a run which really does run out says so.
 */

const roots = [];

async function tempRoot() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-scratch-'));
  roots.push(base);
  return base;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

/** Poll until the run record leaves `running`; `start` returns before it settles. */
async function waitForRecord(runManager, runId, runDir, { timeout = 15000 } = {}) {
  const started = Date.now();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const record = JSON.parse(await fsp.readFile(path.join(runDir, 'run.json'), 'utf8'));
    if (record.status !== 'running' || Date.now() - started > timeout) return record;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const PSI4_INPUT = 'molecule {\n  O 0.0 0.0 0.1173\n  H 0.0 0.7572 -0.4692\n  H 0.0 -0.7572 -0.4692\n}\nset basis def2-svp\nenergy("hf")\n';

function payloadFor(dir, overrides = {}) {
  return {
    engine: 'psi4',
    title: 'psi4 scratch probe',
    inputText: PSI4_INPUT,
    inputName: 'probe.dat',
    outputName: 'probe.out',
    executable: path.join(dir, 'psi4'),
    dryRun: false,
    gates: {},
    ...overrides,
  };
}

describe('Psi4 scratch directory (issue 283)', () => {
  it('puts PSI_SCRATCH in the child environment and keeps the thread settings', () => {
    const env = Psi4Runner.environmentFor({
      threads: 2,
      scratchDir: '/runs/abc/scratch',
      env: { PATH: '/usr/bin', OMP_NUM_THREADS: '8' },
    });
    expect(env.PSI_SCRATCH).toBe('/runs/abc/scratch');
    expect(env.OMP_NUM_THREADS).toBe('2');
    expect(env.MKL_NUM_THREADS).toBe('2');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('leaves PSI_SCRATCH alone when no scratch was chosen', () => {
    const env = Psi4Runner.environmentFor({ threads: null, env: { PATH: '/usr/bin' } });
    expect(env.PSI_SCRATCH).toBeUndefined();
  });

  it('hands the runner the run\'s own scratch folder', async () => {
    const base = await tempRoot();
    const runsRoot = path.join(base, 'runs');
    await fsp.mkdir(runsRoot, { recursive: true });
    const exe = path.join(base, 'psi4');
    await fsp.writeFile(exe, '');
    const seen = [];
    const runner = () => ({
      cancel() {},
      async run(args) {
        seen.push(args);
        const text = 'Psi4 exited.\n';
        await fsp.writeFile(path.join(args.cwd, args.outputName), text, 'utf8');
        return {
          exitCode: 0,
          signal: null,
          cancelled: false,
          outputPath: path.join(args.cwd, args.outputName),
          outputText: text,
          stdout: '',
          stderr: '',
        };
      },
    });
    const runManager = new RunManager({ runsRoot, emit: () => {}, createRunner: runner });
    const { runId, runDir } = await runManager.start(payloadFor(base));
    // Let the run settle before the test ends: a record still being written
    // after `afterEach` removes the folder fails the job with ENOENT.
    await waitForRecord(runManager, runId, runDir);

    expect(seen).toHaveLength(1);
    expect(seen[0].scratchDir).toBe(path.join(runDir, 'scratch'));
    // The folder really exists, so Psi4 never has to create it.
    await expect(fsp.stat(path.join(runDir, 'scratch'))).resolves.toBeTruthy();
  });

  it('records a full scratch filesystem instead of "no termination marker"', async () => {
    const base = await tempRoot();
    const runsRoot = path.join(base, 'runs');
    await fsp.mkdir(runsRoot, { recursive: true });
    const exe = path.join(base, 'psi4');
    await fsp.writeFile(exe, '');
    const full = [
      'Psi4 started.',
      'Scratch directory: /tmp/',
      'Psi4 encountered an error: WRITE failed. Error description from the OS: No space left on device',
    ].join('\n');
    const runner = () => ({
      cancel() {},
      async run(args) {
        await fsp.writeFile(path.join(args.cwd, args.outputName), full, 'utf8');
        return {
          exitCode: 1,
          signal: null,
          cancelled: false,
          outputPath: path.join(args.cwd, args.outputName),
          outputText: full,
          stdout: '',
          stderr: '',
        };
      },
    });
    const runManager = new RunManager({ runsRoot, emit: () => {}, createRunner: runner });
    const { runId, runDir } = await runManager.start(payloadFor(base));
    // `start` returns when the run is launched; the record settles later.
    const record = await waitForRecord(runManager, runId, runDir);

    expect(record.status).not.toBe('completed');
    expect(record.scratch).toMatchObject({ exhausted: true });
    expect(record.scratch.dir).toBe(path.join(runDir, 'scratch'));
    // The reason travels in words as well as in the flag: the record used to say
    // only "No termination marker", which names neither the disk nor the folder.
    expect(record.scratch.note).toMatch(/ran out of space/);
    expect(record.scratch.note).toMatch(/No space left on device/);
    expect(record.error ?? '').not.toBe('No termination marker');
    expect(runId).toBeTruthy();
  });
});
