import { describe, expect, it } from 'vitest';

import {
  SETTINGS_SCHEMA_VERSION,
  defaultAppSettings,
  defaultSettingsPath,
  mergeAppSettings,
  normalizeAppSettings,
  settingsPathFor,
} from '../src/shared/appSettings.js';

describe('app settings document (issue 252)', () => {
  it('round-trips the defaults through normalisation', () => {
    const defaults = defaultAppSettings();
    const result = normalizeAppSettings(defaults);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.settings).toEqual(defaults);
    expect(result.settings.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
  });

  it('fills a partial document without inventing machine paths', () => {
    const result = normalizeAppSettings({
      schemaVersion: 1,
      engines: { gaussian: '  /opt/g16/g16  ' },
      tools: { crest: '/usr/local/bin/crest' },
      runs: { dryRun: false, maxParallel: 4 },
    });
    expect(result.ok).toBe(true);
    expect(result.settings.engines.gaussian).toBe('/opt/g16/g16');
    expect(result.settings.engines.xtb).toBe('');
    expect(result.settings.tools.crest).toBe('/usr/local/bin/crest');
    expect(result.settings.tools.obabel).toBe('');
    expect(result.settings.runs.dryRun).toBe(false);
    expect(result.settings.runs.maxParallel).toBe(4);
  });

  it('merges a page patch without dropping sibling sections', () => {
    const base = mergeAppSettings(defaultAppSettings(), {
      engines: { psi4: '/opt/psi4/bin/psi4' },
      tools: { obabel: '/usr/bin/obabel' },
    });
    const next = mergeAppSettings(base, { runs: { maxParallel: 2 } });
    expect(next.engines.psi4).toBe('/opt/psi4/bin/psi4');
    expect(next.tools.obabel).toBe('/usr/bin/obabel');
    expect(next.runs.maxParallel).toBe(2);
    expect(next.runs.dryRun).toBe(true);
  });

  it('rejects an unknown section and field with the path in the reason', () => {
    const result = normalizeAppSettings({
      schemaVersion: 1,
      engines: { gaussian: '', bogus: '/tmp/x' },
      mystery: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'engines.bogus' }),
      expect.objectContaining({ field: 'mystery' }),
    ]));
  });

  it('rejects an invalid enum, number and type rather than coercing them', () => {
    const result = normalizeAppSettings({
      schemaVersion: 1,
      engines: { gaussian: 42 },
      runs: { dryRun: 'yes', maxParallel: 0, timeoutSeconds: 90000 },
      projectDefaults: { engine: 'gaussian', method: 'B3LYP', basis: 'def2-SVP', memory: '0', memoryUnit: 'TB', nproc: 0, xtbMethod: 'gfn9' },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.field)).toEqual(expect.arrayContaining([
      'engines.gaussian',
      'runs.dryRun',
      'runs.maxParallel',
      'runs.timeoutSeconds',
      'projectDefaults.memory',
      'projectDefaults.memoryUnit',
      'projectDefaults.nproc',
      'projectDefaults.xtbMethod',
    ]));
    // The fallback is still a complete document for rendering the form.
    expect(result.settings.engines.gaussian).toBe('');
    expect(result.settings.runs.maxParallel).toBe(1);
  });

  it('rejects a schema version this build does not understand', () => {
    const newer = normalizeAppSettings({ ...defaultAppSettings(), schemaVersion: 2 });
    expect(newer.ok).toBe(false);
    expect(newer.errors[0]).toMatchObject({ field: 'schemaVersion' });
    expect(newer.errors[0].message).toMatch(/newer/);
  });

  it('only accepts a non-negative integer timeout and a bounded parallelism', () => {
    const zero = normalizeAppSettings({ schemaVersion: 1, runs: { timeoutSeconds: 0, maxParallel: 1 } });
    expect(zero.ok).toBe(true);
    expect(zero.settings.runs.timeoutSeconds).toBe(0);
    const tooMany = normalizeAppSettings({ schemaVersion: 1, runs: { maxParallel: 65 } });
    expect(tooMany.ok).toBe(false);
  });

  it('builds a settings path under the user-data directory', () => {
    expect(settingsPathFor('/home/x/.config/nodechem-studio')).toBe('/home/x/.config/nodechem-studio/settings.json');
    expect(settingsPathFor('C:\\Users\\x\\AppData\\Roaming\\nodechem-studio\\')).toBe('C:\\Users\\x\\AppData\\Roaming\\nodechem-studio/settings.json');
  });

  it('mirrors the Electron user-data location for each platform', () => {
    expect(defaultSettingsPath({ platform: 'linux', env: { HOME: '/home/x' }, home: '/home/x' }))
      .toBe('/home/x/.config/nodechem-studio/settings.json');
    expect(defaultSettingsPath({ platform: 'linux', env: { HOME: '/home/x', XDG_CONFIG_HOME: '/cfg' }, home: '/home/x' }))
      .toBe('/cfg/nodechem-studio/settings.json');
    expect(defaultSettingsPath({ platform: 'darwin', env: {}, home: '/Users/x' }))
      .toBe('/Users/x/Library/Application Support/nodechem-studio/settings.json');
    expect(defaultSettingsPath({ platform: 'win32', env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, home: 'C:\\Users\\x' }))
      .toBe('C:\\Users\\x\\AppData\\Roaming/nodechem-studio/settings.json');
    expect(defaultSettingsPath({ platform: 'linux', env: { NCS_SETTINGS_PATH: '/tmp/ncs/settings.json' } }))
      .toBe('/tmp/ncs/settings.json');
  });
});
