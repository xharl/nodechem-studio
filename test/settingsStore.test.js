import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultAppSettings } from '../src/shared/appSettings.js';
import {
  createSettingsStore,
  readSettingsFile,
  validateSettingsPaths,
} from '../electron/settingsStore.js';

const roots = [];

async function tempRoot() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ncs-settings-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('settings store (issue 252)', () => {
  it('returns defaults when the file is absent', async () => {
    const dir = await tempRoot();
    const store = createSettingsStore({ userDataDir: dir });
    const result = await store.get();
    expect(result.settings).toEqual(defaultAppSettings());
    expect(result.path).toBe(path.join(dir, 'settings.json'));
  });

  it('writes atomically and reads the same document back', async () => {
    const dir = await tempRoot();
    const store = createSettingsStore({ userDataDir: dir });
    const saved = await store.set({
      engines: { gaussian: '' },
      tools: { crest: '' },
      runs: { dryRun: false, timeoutSeconds: 900, maxParallel: 3 },
      appearance: { runConsoleDock: true },
      projectDefaults: { method: 'PBE0', nproc: 8 },
      advanced: { dataDir: '' },
    });
    expect(saved.ok, JSON.stringify(saved.errors)).toBe(true);
    expect(saved.settings.runs.maxParallel).toBe(3);

    const onDisk = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8'));
    expect(onDisk.schemaVersion).toBe(1);
    expect(onDisk.runs.timeoutSeconds).toBe(900);
    const files = await readdir(dir);
    expect(files.filter((name) => name.endsWith('.tmp'))).toEqual([]);

    // A second store (the next launch) sees the persisted values.
    const reopened = await createSettingsStore({ userDataDir: dir }).get();
    expect(reopened.settings.appearance.runConsoleDock).toBe(true);
    expect(reopened.settings.projectDefaults.method).toBe('PBE0');
  });

  it('falls back to defaults when the file is corrupt', async () => {
    const dir = await tempRoot();
    await writeFile(path.join(dir, 'settings.json'), '{ this is not json', 'utf8');
    const result = await readSettingsFile(path.join(dir, 'settings.json'));
    expect(result.corrupt).toBe(true);
    expect(result.settings).toEqual(defaultAppSettings());
    expect(result.errors[0].message).toMatch(/not valid JSON/);
  });

  it('refuses an unknown field without writing the file', async () => {
    const dir = await tempRoot();
    const store = createSettingsStore({ userDataDir: dir });
    const result = await store.set({ engines: { gaussian: '', secret: 'x' } });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.field === 'engines.secret')).toBe(true);
    await expect(readFile(path.join(dir, 'settings.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a non-executable engine path with the field and reason', async () => {
    const dir = await tempRoot();
    const store = createSettingsStore({ userDataDir: dir });
    const missing = path.join(dir, 'missing-g16');
    const result = await store.set({ engines: { gaussian: missing } });
    expect(result.ok).toBe(false);
    expect(result.errors[0].field).toBe('engines.gaussian');
    expect(result.errors[0].message).toContain(missing);
    expect(result.errors[0].message).toMatch(/does not exist/);
    await expect(readFile(path.join(dir, 'settings.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts an executable file and a blank optional tool', async () => {
    const dir = await tempRoot();
    const executable = path.join(dir, 'fake-g16');
    await writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(executable, 0o755);
    const store = createSettingsStore({ userDataDir: dir });
    const result = await store.set({
      engines: { gaussian: executable },
      tools: { crest: '', obabel: '' },
    });
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    expect(result.settings.engines.gaussian).toBe(executable);
  });

  it('checks a tautomer script as readable and scratch as a directory', async () => {
    const dir = await tempRoot();
    const script = path.join(dir, 'tautomer.py');
    await writeFile(script, 'print("ok")\n', 'utf8');
    const scratch = path.join(dir, 'scratch');
    await mkdir(scratch);
    const errors = await validateSettingsPaths({
      ...defaultAppSettings(),
      tools: { ...defaultAppSettings().tools, tautomerScript: script, scratch },
    });
    expect(errors).toEqual([]);

    const bad = await validateSettingsPaths({
      ...defaultAppSettings(),
      tools: { ...defaultAppSettings().tools, tautomerScript: dir, scratch: script },
    });
    expect(bad.map((error) => error.field)).toEqual(expect.arrayContaining([
      'tools.tautomerScript',
      'tools.scratch',
    ]));
  });
});
