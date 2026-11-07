import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stageCheckpoint } from '../electron/runner/checkpoint.js';

const roots = [];

async function tempDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-checkpoint-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
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
});
