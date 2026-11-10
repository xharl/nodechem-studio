import { afterEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ObabelRunner } from '../electron/runner/obabelRunner.js';

/**
 * A search that dies from a signal leaves `exitCode` null, and `Number(null)` is
 * 0 — so the queue used to see a "successful" search that produced nothing and
 * report "no scored conformers". The runner must carry the status out.
 */

const roots = [];
const onWindows = process.platform === 'win32';

async function crashStub() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'obabel-signal-'));
  roots.push(base);
  const exe = path.join(base, 'obabel');
  await fsp.writeFile(exe, [
    '#!/bin/sh',
    'if [ "$1" = "-V" ]; then echo "Open Babel 9.9.9 -- fake build"; exit 0; fi',
    'kill -SEGV $$',
  ].join('\n'), 'utf8');
  await fsp.chmod(exe, 0o755);
  await fsp.writeFile(path.join(base, 'ensemble.xyz'), '4\nx\nC 0 0 0\nC 1.5 0 0\nC 2.1 1.4 0\nC 3.6 1.4 0\n', 'utf8');
  return { base, exe };
}

afterEach(async () => {
  while (roots.length) {
    const dir = roots.pop();
    // eslint-disable-next-line no-await-in-loop
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe.skipIf(onWindows)('a signalled Open Babel search', () => {
  it('is reported as a signal, not as an empty ensemble with exit code null', async () => {
    const { base, exe } = await crashStub();
    const result = await new ObabelRunner().run({
      executable: exe,
      argv: ['ensemble.xyz', '-O', 'obabel_conformers.xyz', '--conformer', '--nconf', '3'],
      cwd: base,
      ff: 'mmff94',
    });
    expect(result.searchSignal).toBe('SIGSEGV');
    expect(result.searchExitCode).toBeNull();
    expect(result.ensembleText).toBe('');
  });
});
