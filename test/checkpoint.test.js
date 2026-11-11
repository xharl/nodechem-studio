import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stageCheckpoint } from '../electron/runner/checkpoint.js';
import { rmrf } from './helpers/tempCleanup.js';

const roots = [];

async function tempDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-checkpoint-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.map((dir) => rmrf(dir)));
  roots.length = 0;
});

describe('stageCheckpoint', () => {
  it('copies a non-empty upstream checkpoint into the run folder', async () => {
    const source = await tempDir();
    const target = await tempDir();
    await fsp.writeFile(path.join(source, 'r_opt.chk'), 'binary-checkpoint-content', 'utf8');

    const result = await stageCheckpoint({
      sourceRunDir: source,
      checkpoint: 'r_opt.chk',
      sourceRunId: 'upstream-run',
      targetDir: target,
    });

    expect(result).toMatchObject({ file: 'r_opt.chk', kind: 'copy', sourceRunId: 'upstream-run' });
    expect(result.bytes).toBe(Buffer.byteLength('binary-checkpoint-content'));
    expect(await fsp.readFile(path.join(target, 'r_opt.chk'), 'utf8')).toBe('binary-checkpoint-content');
  });

  it('fails a real run when the upstream checkpoint is missing', async () => {
    const source = await tempDir();
    const target = await tempDir();
    await expect(stageCheckpoint({
      sourceRunDir: source,
      checkpoint: 'r_opt.chk',
      targetDir: target,
    })).rejects.toThrow(/does not exist/);
  });

  it('fails a real run when the upstream checkpoint is empty', async () => {
    const source = await tempDir();
    const target = await tempDir();
    await fsp.writeFile(path.join(source, 'r_opt.chk'), '');
    await expect(stageCheckpoint({
      sourceRunDir: source,
      checkpoint: 'r_opt.chk',
      targetDir: target,
    })).rejects.toThrow(/is empty \(corrupt checkpoint\)/);
  });

  it('stages a labelled fixture in dry run when no checkpoint exists', async () => {
    const target = await tempDir();
    const result = await stageCheckpoint({
      sourceRunDir: '',
      checkpoint: 'r_opt.chk',
      targetDir: target,
      dryRun: true,
    });
    expect(result.kind).toBe('fixture');
    const text = await fsp.readFile(path.join(target, 'r_opt.chk'), 'utf8');
    expect(text.startsWith('FIXTURE CHECKPOINT')).toBe(true);
    expect(text).toContain('not a Gaussian checkpoint');
  });

  it('refuses an unsafe checkpoint name', async () => {
    const target = await tempDir();
    for (const name of ['../escape.chk', 'r opt.chk', 'r_opt.out', '']) {
      await expect(stageCheckpoint({ checkpoint: name, targetDir: target, dryRun: true }))
        .rejects.toThrow(/safe \.chk basename/);
    }
  });

  it('requires an upstream run folder outside a dry run', async () => {
    const target = await tempDir();
    await expect(stageCheckpoint({ checkpoint: 'r_opt.chk', targetDir: target, dryRun: false }))
      .rejects.toThrow(/no upstream run folder/);
  });

  it('copies an xTB restart artifact when the engine declares it', async () => {
    const source = await tempDir();
    const target = await tempDir();
    await fsp.writeFile(path.join(source, 'xtbrestart'), 'xTB restart data', 'utf8');

    const result = await stageCheckpoint({
      sourceRunDir: source,
      checkpoint: 'xtbrestart',
      sourceRunId: 'upstream-run',
      targetDir: target,
      engine: 'xtb',
    });

    expect(result).toMatchObject({ file: 'xtbrestart', kind: 'copy', sourceRunId: 'upstream-run' });
    expect(await fsp.readFile(path.join(target, 'xtbrestart'), 'utf8')).toBe('xTB restart data');
  });

  it('labels a dry-run xTB fixture as a restart file, not a Gaussian checkpoint', async () => {
    const target = await tempDir();
    const result = await stageCheckpoint({
      sourceRunDir: '',
      checkpoint: 'xtbrestart',
      targetDir: target,
      dryRun: true,
      engine: 'xtb',
    });
    expect(result.kind).toBe('fixture');
    const text = await fsp.readFile(path.join(target, 'xtbrestart'), 'utf8');
    expect(text.startsWith('FIXTURE CHECKPOINT')).toBe(true);
    expect(text).toContain('not an xTB restart file');
    expect(text).not.toContain('Gaussian checkpoint');
  });

  it('copies an ORCA .gbw restart file', async () => {
    const source = await tempDir();
    const target = await tempDir();
    await fsp.writeFile(path.join(source, 'water.gbw'), 'ORCA wavefunction data', 'utf8');

    const result = await stageCheckpoint({
      sourceRunDir: source,
      checkpoint: 'water.gbw',
      sourceRunId: 'upstream-run',
      targetDir: target,
      engine: 'orca',
    });

    expect(result).toMatchObject({ file: 'water.gbw', kind: 'copy' });
    expect(await fsp.readFile(path.join(target, 'water.gbw'), 'utf8')).toBe('ORCA wavefunction data');
  });

  it('labels a dry-run ORCA fixture as a .gbw, not a Gaussian checkpoint', async () => {
    const target = await tempDir();
    const result = await stageCheckpoint({
      sourceRunDir: '', checkpoint: 'water.gbw', targetDir: target, dryRun: true, engine: 'orca',
    });
    const text = await fsp.readFile(path.join(target, 'water.gbw'), 'utf8');
    expect(result.kind).toBe('fixture');
    expect(text).toContain('not an ORCA .gbw file');
    expect(text).not.toContain('Gaussian checkpoint');
  });

  it('refuses a Gaussian .chk name on an ORCA edge', async () => {
    const target = await tempDir();
    await expect(stageCheckpoint({
      checkpoint: 'water.chk', targetDir: target, dryRun: true, engine: 'orca',
    })).rejects.toThrow(/safe .gbw basename/);
  });

  it('still refuses an unsafe xTB artifact name', async () => {
    const target = await tempDir();
    for (const name of ['../xtbrestart', 'xtb restart', '..', '.', '']) {
      await expect(stageCheckpoint({ checkpoint: name, targetDir: target, dryRun: true, engine: 'xtb' }))
        .rejects.toThrow(/safe restart-artifact basename/);
    }
  });
});
