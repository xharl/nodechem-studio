import { describe, expect, it } from 'vitest';

import { defaultAppSettings, normalizeAppSettings } from '../src/shared/appSettings.js';
import {
  SETTINGS_PAGES,
  engineExecutableMap,
  localOverrides,
  runFieldSeed,
  settingsPageHtml,
} from '../src/renderer/settingsView.js';

const settingsWith = (overrides) => normalizeAppSettings(overrides).settings;

describe('Settings window pages (issue 252)', () => {
  it('offers the six topics from the issue in rail order', () => {
    expect(SETTINGS_PAGES.map((page) => page.id)).toEqual([
      'engines', 'tools', 'runs', 'appearance', 'projectDefaults', 'advanced',
    ]);
  });

  it('renders engine status, path and version together', () => {
    const draft = settingsWith({
      engines: { gaussian: '/opt/g16/g16' },
    });
    const html = settingsPageHtml({
      page: 'engines',
      draft,
      detection: {
        gaussian: { ok: true, path: '/opt/g16/g16' },
        xtb: { ok: false, path: null },
        tools: {},
        versions: { '/opt/g16/g16': 'Gaussian 16 Rev C.01' },
      },
    });
    expect(html).toContain('data-settings-field="engines.gaussian"');
    expect(html).toContain('/opt/g16/g16');
    expect(html).toContain('detected');
    expect(html).toContain('Gaussian 16 Rev C.01');
    expect(html).toContain('data-action="settings-detect"');
    expect(html).toContain('data-settings-browse="engine:gaussian"');
    // A missing engine says so rather than pretending it was found.
    expect(html).toContain('not found');
  });

  it('puts a refused path message next to its field', () => {
    const html = settingsPageHtml({
      page: 'tools',
      draft: defaultAppSettings(),
      errors: [{ field: 'tools.crest', message: 'CREST executable at /nope/crest does not exist.' }],
    });
    expect(html).toContain('data-settings-error="tools.crest"');
    expect(html).toContain('does not exist');
    expect(html).toContain('data-settings-field="tools.obabel"');
  });

  it('renders all project-default fields and the real advanced field', () => {
    const draft = defaultAppSettings();
    const defaults = settingsPageHtml({ page: 'projectDefaults', draft });
    for (const field of [
      'projectDefaults.engine', 'projectDefaults.method', 'projectDefaults.basis',
      'projectDefaults.memory', 'projectDefaults.memoryUnit', 'projectDefaults.nproc',
      'projectDefaults.xtbMethod', 'projectDefaults.xtbOptLevel',
    ]) {
      expect(defaults).toContain(`data-settings-field="${field}"`);
    }
    const advanced = settingsPageHtml({
      page: 'advanced',
      draft,
      settingsPath: '/home/x/.config/nodechem-studio/settings.json',
    });
    expect(advanced).toContain('data-settings-field="advanced.dataDir"');
    expect(advanced).toContain('/home/x/.config/nodechem-studio/settings.json');
    // No invented log-level or update-check control that nothing reads.
    expect(advanced).not.toContain('logLevel');
  });
});

describe('Settings seed precedence (issue 252)', () => {
  it('prefers a local per-run value over Settings, and Settings over blank', () => {
    const settings = settingsWith({
      tools: {
        crest: '/settings/crest',
        obabel: '/settings/obabel',
        scorer: '',
        multiwfn: '/settings/Multiwfn',
        tautomer: '/settings/python',
        tautomerScript: '/settings/tautomer.py',
        scratch: '/settings/scratch',
      },
      runs: { dryRun: false },
    });

    const fresh = runFieldSeed({ settings, saved: {} });
    expect(fresh).toEqual({
      crest: '/settings/crest',
      obabel: '/settings/obabel',
      scorer: '',
      multiwfn: '/settings/Multiwfn',
      tautomer: '/settings/python',
      tautomerScript: '/settings/tautomer.py',
      scratch: '/settings/scratch',
      dryRun: false,
    });

    const overridden = runFieldSeed({
      settings,
      saved: { crestExecutable: '/run/crest', dryRun: true },
    });
    expect(overridden.crest).toBe('/run/crest');
    expect(overridden.obabel).toBe('/settings/obabel');
    expect(overridden.dryRun).toBe(true);
  });

  it('builds an executable map from Settings, with a local override winning', () => {
    const settings = settingsWith({
      engines: { gaussian: '/settings/g16', xtb: '/settings/xtb' },
    });
    const map = engineExecutableMap(settings, { xtb: '/local/xtb' });
    expect(map).toEqual({ gaussian: '/settings/g16', xtb: '/local/xtb' });
    // A blank console field therefore still launches the configured engine.
    expect(map.gaussian).toBe('/settings/g16');
  });

  it('stores only values that differ from Settings', () => {
    const overrides = localOverrides(
      { gaussian: '/settings/g16', xtb: '/local/xtb', psi4: '', orca: '/settings/orca' },
      { gaussian: '/settings/g16', xtb: '/settings/other', psi4: '/settings/psi4', orca: '/settings/orca' },
      ['gaussian', 'xtb', 'psi4', 'orca'],
    );
    expect(overrides).toEqual({ xtb: '/local/xtb' });
  });
});
