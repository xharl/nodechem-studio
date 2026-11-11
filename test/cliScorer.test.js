import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

/**
 * Issue 309 — `rankBy` was unreachable from the CLI.
 *
 * The queue already honoured `options.scorerExecutable`, the run console had a
 * field for it, but `bin/ncs.js` never set it and `ncs run --help` listed no
 * flag, so an ML-ranked ensemble could only be run in the GUI. These tests run
 * the real CLI against a fake sidecar (a Node script, so the contract is
 * `spawn(executable, [--model id])` with no shell involved).
 */

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'bin', 'ncs.js');

// A POSIX-shebang sidecar cannot be spawned on windows-latest; the Windows
// package workflow runs this suite, so the two runtime tests are skipped there.
const onWindows = process.platform === 'win32';

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

const ENVIRONMENT = [
  '3',
  'conformer 1 energy=-76.400000',
  'O 0 0 0',
  'H 0.96 0 0',
  'H -0.24 0.93 0',
  '',
  '3',
  'conformer 2 energy=-76.395000',
  'O 0 0 0',
  'H 0.96 0 0',
  'H -0.24 1.70 0',
  '',
].join('\n');

/** A Node sidecar: reverses the incumbents, so ranking is observable. */
const SCORER = [
  '#!/usr/bin/env node',
  'let text = "";',
  'process.stdin.on("data", (chunk) => { text += chunk; });',
  'process.stdin.on("end", () => {',
  '  const request = JSON.parse(text);',
  '  const results = request.frames.map((frame, index) => ({ id: frame.id, energyEv: index === 0 ? -1 : -2 }));',
  '  process.stdout.write(JSON.stringify({',
  '    model: "aimnet2", version: "2.0.0", weightsSha256: "d".repeat(64),',
  '    dtype: "float32", device: "cpu", cutoffAngstrom: 5,',
  '    charge: request.charge, multiplicity: request.multiplicity, results,',
  '  }));',
  '});',
].join('\n');

function projectFor(ensemblePath) {
  return {
    schemaVersion: 3,
    name: 'CLI scorer',
    molecule: {
      charge: 0,
      multiplicity: 1,
      fragments: [],
      coords: [
        { element: 'O', x: 0, y: 0, z: 0 },
        { element: 'H', x: 0.96, y: 0, z: 0 },
        { element: 'H', x: -0.24, y: 0.93, z: 0 },
      ],
      geometry: { source: 'imported', file: 'w.xyz', format: 'xyz' },
    },
    defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
    nodes: [
      {
        id: 'ens',
        type: 'input',
        kind: 'Ensemble input',
        title: 'Imported',
        state: 'ready',
        x: 0,
        y: 0,
        input: {
          kind: 'ensemble',
          path: ensemblePath,
          format: 'xyz',
          energyUnit: 'hartree',
          energyMethod: 'GFN2-xTB',
          origin: { program: 'CREST', version: '3.0', method: 'GFN2-xTB' },
        },
      },
      {
        id: 'gen',
        type: 'generate',
        title: 'Ranked',
        state: 'ready',
        x: 200,
        y: 0,
        settings: { source: 'imported', rankBy: 'ml:aimnet2', rmsdThreshold: 0.01, energyWindowKcal: 100 },
        output: null,
      },
    ],
    edges: [{ id: 'e1', from: 'ens', to: 'gen', type: 'dependency' }],
  };
}

async function stage() {
  const base = await mkdtemp(path.join(tmpdir(), 'ncs-cli-scorer-'));
  const ensemblePath = path.join(base, 'ensemble.xyz');
  await writeFile(ensemblePath, ENVIRONMENT, 'utf8');
  const projectPath = path.join(base, 'project.ncs');
  await writeFile(projectPath, `${JSON.stringify(projectFor(ensemblePath), null, 2)}\n`, 'utf8');
  const scorerPath = path.join(base, 'aimnet2-scorer');
  await writeFile(scorerPath, SCORER, { mode: 0o755 });
  return { base, projectPath, scorerPath, outDir: path.join(base, 'out') };
}

describe('ncs run --scorer (issue 309)', () => {
  it('lists the flag in its usage', async () => {
    const result = await ncs(['--help']);
    expect(result.stdout).toContain('--scorer <path>');
  });
});

describe.skipIf(onWindows)('ncs run --scorer runtime (issue 309)', () => {
  it('ranks an imported ensemble with the sidecar the flag names', async () => {
    const { base, projectPath, scorerPath, outDir } = await stage();
    const result = await ncs(['run', projectPath, '--out', outDir, '--scorer', scorerPath], {
      timeout: 120000,
    });
    expect(result.stderr).not.toContain('queue did not start');
    expect(result.code, result.stderr).toBe(0);

    const queues = await readdir(path.join(outDir, 'queues'));
    expect(queues).toHaveLength(1);
    const queue = JSON.parse(await readFile(path.join(outDir, 'queues', queues[0], 'queue.json'), 'utf8'));
    const generated = queue.tasks.find((task) => task.nodeId === 'gen');
    expect(generated.error).toBeNull();
    expect(generated.status).toBe('completed');
    expect(generated.ensemble.scorer.model).toBe('aimnet2');
    // The sidecar put the second input frame lowest; the ranked ensemble keeps
    // that order, which is what proves the flagged binary actually ran.
    expect(generated.ensemble.members[0].scorer.energyEv).toBe(-2);
    expect(generated.ensemble.selected.id).toBe('c1');
    // The path travelled from the flag into the queue's options, not a default.
    expect(queue.options.scorerExecutable).toBe(scorerPath);
    expect(base).toBeTruthy();
  });

  it('names the flag when a block needs the sidecar and none was given', async () => {
    const { projectPath, outDir } = await stage();
    const result = await ncs(['run', projectPath, '--out', outDir], { timeout: 120000 });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('--scorer <path>');
    expect(result.stderr).toContain('rankBy');
  });
});
