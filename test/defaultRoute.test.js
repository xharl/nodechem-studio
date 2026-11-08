import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildGaussianInput, DEMO_WATER, routeFor } from '../src/shared/gaussianInput.js';
import {
  SCHEMA_VERSION,
  defaultSettings,
  parseProjectText,
  stringifyProject,
} from '../src/shared/projectSchema.js';
import {
  LEGACY_ROUTE_PRESET,
  MODERN_ROUTE_PRESET,
  ROUTE_PRESETS,
  applyRoutePreset,
  defaultDispersionFor,
  dispersionForMethodChange,
  hasBuiltinDispersion,
  routePresetIdFor,
} from '../src/shared/routePresets.js';

const molecule = { charge: 0, multiplicity: 1, coords: DEMO_WATER };

/** The exact input the pre-change builder produced for B3LYP/6-31G(d), no dispersion. */
const LEGACY_INPUT = [
  '%Mem=4GB',
  '%NProcShared=4',
  '%Chk=legacy.chk',
  '#p B3LYP/6-31G(d) Opt',
  '',
  'Legacy reproduction',
  '',
  '0 1',
  'O      0.000000     0.000000     0.117300',
  'H      0.000000     0.757200    -0.469200',
  'H      0.000000    -0.757200    -0.469200',
  '',
  '',
].join('\n');

describe('issue #17 — modern default route', () => {
  it('gives a new project a dispersion-corrected first node', () => {
    const settings = defaultSettings({ checkpoint: 'first.chk' });
    expect(settings.method).toBe(MODERN_ROUTE_PRESET.method);
    expect(settings.basis).toBe(MODERN_ROUTE_PRESET.basis);
    expect(settings.dispersion).toBe('GD3BJ');
    expect(routeFor(settings)).toBe('#p B3LYP/def2SVP Opt EmpiricalDispersion=GD3BJ');

    const text = buildGaussianInput({
      title: 'New project',
      settings,
      molecule,
      inputName: 'first.gjf',
    });
    expect(text).toContain('#p B3LYP/def2SVP Opt EmpiricalDispersion=GD3BJ');

    // The add-block path copies the project's method/basis into defaultSettings.
    const added = defaultSettings({
      jobType: 'Opt',
      method: 'B3LYP',
      basis: 'def2-SVP',
      memory: '4',
      memoryUnit: 'GB',
      nproc: '4',
      checkpoint: 'block-8.chk',
    });
    expect(added.dispersion).toBe('GD3BJ');
  });

  it('defaults Dispersion to GD3BJ for a functional without built-in dispersion', () => {
    expect(hasBuiltinDispersion('B3LYP')).toBe(false);
    expect(hasBuiltinDispersion('PBE0')).toBe(false);
    expect(defaultDispersionFor('PBE0')).toBe('GD3BJ');
    expect(defaultSettings({ method: 'PBE0' }).dispersion).toBe('GD3BJ');
    expect(defaultSettings({ method: 'MP2' }).dispersion).toBe('GD3BJ');
    expect(routeFor(defaultSettings({ method: 'PBE0' })))
      .toContain('EmpiricalDispersion=GD3BJ');
  });

  it('does not double-correct a functional that already has dispersion', () => {
    expect(hasBuiltinDispersion('ωB97X-D')).toBe(true);
    expect(defaultSettings({ method: 'ωB97X-D' }).dispersion).toBe('');
    expect(routeFor(defaultSettings({ method: 'ωB97X-D' }))).toBe('#p ωB97X-D/def2SVP Opt');
    expect(dispersionForMethodChange('PBE0', '')).toBe('GD3BJ');
    expect(dispersionForMethodChange('ωB97X-D', 'GD3BJ')).toBe('');
    expect(dispersionForMethodChange('PBE0', 'GD3')).toBe('GD3');
  });

  it('lets an explicit dispersion override win over the computed default', () => {
    expect(defaultSettings({ method: 'PBE0', dispersion: '' }).dispersion).toBe('');
    expect(defaultSettings({ dispersion: 'GD3' }).dispersion).toBe('GD3');
  });
});

describe('issue #17 — legacy route preset', () => {
  it('is clearly labelled and still selectable', () => {
    expect(LEGACY_ROUTE_PRESET.label).toBe('Legacy (reproduce a paper)');
    expect(ROUTE_PRESETS.map((preset) => preset.id)).toEqual(['modern', 'legacy']);
    expect(routePresetIdFor({ method: 'B3LYP', basis: '6-31G(d)', dispersion: '' }))
      .toBe('legacy');
    expect(routePresetIdFor(defaultSettings())).toBe('modern');
    expect(routePresetIdFor({ method: 'PBE0', basis: 'def2-SVP', dispersion: 'GD3BJ' }))
      .toBe('');
  });

  it('restores B3LYP/6-31G(d) with no dispersion byte-identically', () => {
    const settings = applyRoutePreset(
      defaultSettings({ checkpoint: 'legacy.chk' }),
      LEGACY_ROUTE_PRESET.id,
    );
    expect(settings.method).toBe('B3LYP');
    expect(settings.basis).toBe('6-31G(d)');
    expect(settings.dispersion).toBe('');

    const text = buildGaussianInput({
      title: 'Legacy reproduction',
      settings,
      molecule,
      inputName: 'legacy.gjf',
    });
    expect(text).toBe(LEGACY_INPUT);
  });

  it('returns an unchanged copy for an unknown preset id', () => {
    const settings = defaultSettings();
    expect(applyRoutePreset(settings, 'not-a-preset')).toEqual(settings);
  });
});

describe('issue #17 — existing project files', () => {
  function savedLegacyProject() {
    return {
      schemaVersion: SCHEMA_VERSION,
      name: 'Legacy paper project',
      molecule: {
        smiles: 'O',
        charge: 0,
        multiplicity: 1,
        fragments: ['O'],
        coords: [],
        geometry: { source: 'demo', file: '', format: '' },
      },
      defaults: {
        method: 'B3LYP',
        basis: '6-31G(d)',
        memory: '4',
        memoryUnit: 'GB',
        nproc: '4',
      },
      nodes: [{
        id: 'legacy-opt',
        type: 'calc',
        kind: 'Opt',
        title: 'Legacy optimization',
        state: 'ready',
        x: 10,
        y: 40,
        settings: {
          ...defaultSettings(),
          jobType: 'Opt',
          method: 'B3LYP',
          basis: '6-31G(d)',
          dispersion: '',
          checkpoint: 'legacy_opt.chk',
        },
        output: null,
        checkpointFrom: null,
      }],
      edges: [],
    };
  }

  it('opens a saved file with its legacy route unchanged', () => {
    const saved = stringifyProject(savedLegacyProject());
    expect(saved.ok).toBe(true);
    expect(saved.errors).toEqual([]);

    const opened = parseProjectText(saved.text);
    expect(opened.ok).toBe(true);
    expect(opened.migrated).toBe(false);
    expect(opened.project.defaults).toEqual({
      engine: 'gaussian',
      method: 'B3LYP',
      basis: '6-31G(d)',
      memory: '4',
      memoryUnit: 'GB',
      nproc: 4,
    });

    const node = opened.project.nodes[0];
    expect(node.settings.method).toBe('B3LYP');
    expect(node.settings.basis).toBe('6-31G(d)');
    expect(node.settings.dispersion).toBe('');
    expect(routeFor(node.settings)).toBe('#p B3LYP/6-31G(d) Opt');

    // Saving it again must not rewrite the stored route.
    expect(stringifyProject(opened.project).text).toBe(saved.text);
  });
});

describe('issue #17 — documentation', () => {
  it('documents the default change and names the legacy preset', () => {
    // The route rationale lives in the engines page; the landing page links to it.
    const docs = ['../README.md', '../docs/guide/engines.md']
      .map((rel) => readFileSync(new URL(rel, import.meta.url), 'utf8'))
      .join('\n');
    expect(docs).toContain('B3LYP-D3(BJ)/def2-SVP');
    expect(docs).toContain('r²SCAN-3c');
    expect(docs).toContain('Legacy (reproduce a paper)');
    expect(docs).toContain('Existing project files are never rewritten on open');
  });
});
