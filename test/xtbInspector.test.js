import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildGaussianInput, methodBlockFor } from '../src/shared/gaussianInput.js';
import { defaultSettings } from '../src/shared/projectSchema.js';
import {
  XTB_SOLVENTS,
  buildXtbInput,
  xtbSolvationFromArgv,
} from '../src/shared/engines/xtb.js';
import { calcInspectorFieldIds, runSettingsFor } from '../src/renderer/inspectorFields.js';
import { XtbRunner } from '../electron/runner/xtbRunner.js';
import { RunManager } from '../electron/runner/runManager.js';

const WATER = [
  { element: 'O', x: 0, y: 0, z: 0.1173 },
  { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
  { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
];

const molecule = (overrides = {}) => ({ charge: 0, multiplicity: 1, coords: WATER, ...overrides });

const GAUSSIAN_OPT_FIELDS = [
  'job.title', 'job.jobType', 'job.optConvergence',
  'job.memory', 'job.memoryUnit', 'job.nproc', 'job.checkpoint',
  'method.routePreset', 'method.method', 'method.basis', 'method.dispersion',
  'method.scf', 'method.grid', 'method.population', 'method.verbosity',
  'method.tdStates', 'method.tdTriplets',
  'solvation.enabled', 'solvation.model', 'solvation.solvent',
  'molecule.charge', 'molecule.multiplicity',
  'gates.termination', 'gates.scf', 'gates.imaginary', 'gates.minMagnitude',
  'gates.thermo', 'gates.finalEnergy',
  'validity.checks', 'dependencies.inputs', 'dependencies.checkpointFrom',
  'output.view', 'keywords.custom',
];

const XTB_OPT_FIELDS = [
  'job.title', 'job.jobType',
  'xtb.hamiltonian', 'xtb.optLevel', 'xtb.threads',
  'solvation.enabled', 'solvation.model', 'solvation.solvent',
  'molecule.charge', 'molecule.multiplicity',
  'gates.termination', 'gates.scf', 'gates.imaginary', 'gates.minMagnitude',
  'gates.thermo', 'gates.finalEnergy',
  'dependencies.inputs', 'output.view',
];

describe('engine-aware calculation inspector', () => {
  it('shows xTB fields and none of the Gaussian checkpoint/resource fields', () => {
    const fields = calcInspectorFieldIds('xtb', { jobType: 'Opt' });
    expect(fields).toEqual(XTB_OPT_FIELDS);
    for (const hidden of [
      'job.memory', 'job.memoryUnit', 'job.nproc', 'job.checkpoint',
      'dependencies.checkpointFrom', 'method.method', 'method.basis',
    ]) {
      expect(fields).not.toContain(hidden);
    }
  });

  it('keeps the Gaussian inspector field set unchanged, field for field', () => {
    expect(calcInspectorFieldIds('gaussian', { jobType: 'Opt' })).toEqual(GAUSSIAN_OPT_FIELDS);
    // The conditional Gaussian-only fields still appear exactly where they did.
    expect(calcInspectorFieldIds('gaussian', { jobType: 'Opt=TS' })).toContain('job.forceConstants');
    expect(calcInspectorFieldIds('gaussian', { jobType: 'Opt=TS' })).toContain('job.optConvergence');
    expect(calcInspectorFieldIds('gaussian', { jobType: 'Freq' })).not.toContain('job.optConvergence');
    expect(calcInspectorFieldIds('gaussian', { jobType: 'Freq' })).not.toContain('job.forceConstants');
    expect(calcInspectorFieldIds('gaussian', { jobType: 'IRC' })).toContain('job.ircDirection');
  });

  it('offers xTB solvation controls but Gaussian PCM/SMD wording only to Gaussian', () => {
    const xtb = calcInspectorFieldIds('xtb', { jobType: 'SP' });
    expect(xtb).toContain('solvation.enabled');
    expect(xtb).toContain('solvation.model');
    expect(xtb).toContain('solvation.solvent');
    const gaussian = calcInspectorFieldIds('gaussian', { jobType: 'SP' });
    expect(gaussian).toContain('solvation.model');
  });
});

describe('rendered calculation inspector', () => {
  let app;
  let node;

  beforeAll(async () => {
    vi.stubGlobal('window', {
      desktop: null,
      innerWidth: 1440,
      innerHeight: 900,
      addEventListener: () => {},
    });
    vi.stubGlobal('document', {
      readyState: 'loading',
      addEventListener: () => {},
      querySelector: () => null,
    });
    app = await import('../src/renderer/app.js');
    node = app.state.project.nodes.find((item) => item.id === 'ts-freq');
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const nodeFields = (html) => [...html.matchAll(/data-node-field="([^"]+)"/g)].map((match) => match[1]);
  const renderFor = (engineId) => {
    const previous = app.state.project.defaults.engine;
    app.state.project.defaults.engine = engineId;
    try {
      return app.calcInspector(node);
    } finally {
      app.state.project.defaults.engine = previous;
    }
  };

  it('renders no Gaussian resource or checkpoint field for an xTB node', () => {
    expect(nodeFields(renderFor('xtb'))).toEqual([
      'title', 'jobType', 'xtbMethod', 'xtbOptLevel', 'xtbThreads',
      'solvation', 'solvationModel', 'solvent',
      'charge', 'multiplicity', 'imaginary', 'minMagnitude',
    ]);
  });

  it('renders the full Gaussian field set for the same node', () => {
    expect(nodeFields(renderFor('gaussian'))).toEqual([
      'title', 'jobType',
      'memory', 'memoryUnit', 'nproc', 'checkpoint',
      'routePreset', 'method', 'basis', 'dispersion', 'scf', 'grid', 'population', 'verbosity',
      'tdStates', 'tdTriplets',
      'solvation', 'solvationModel', 'solvent',
      'charge', 'multiplicity', 'imaginary', 'minMagnitude',
      'checkpointFrom', 'customKeywords',
    ]);
  });

  it('puts the xTB solvation choice in the rendered route preview, not PCM/SMD', () => {
    const original = {
      solvation: node.settings.solvation,
      solvationModel: node.settings.solvationModel,
      solvent: node.settings.solvent,
    };
    node.settings.solvation = true;
    node.settings.solvationModel = 'ALPB';
    node.settings.solvent = 'Water';
    try {
      const html = renderFor('xtb');
      // The input file is named from the node id, which is `ts-freq`.
      expect(html).toContain('xtb ts-freq.xyz --gfn 2 --hess --alpb water');
      expect(html).toContain('value="ALPB" selected');
      expect(html).toContain('value="Water" selected');
      expect(html).not.toContain('PCM');
      expect(html).not.toContain('SMD');
    } finally {
      Object.assign(node.settings, original);
    }
  });

  it('keeps Gaussian SMD wording and the SCRF route in the rendered inspector', () => {
    const original = {
      solvation: node.settings.solvation,
      solvationModel: node.settings.solvationModel,
      solvent: node.settings.solvent,
    };
    node.settings.solvation = true;
    node.settings.solvationModel = 'SMD';
    node.settings.solvent = 'Water';
    try {
      const html = renderFor('gaussian');
      expect(html).toContain('SCRF=(SMD,Solvent=Water)');
      expect(html).toContain('value="SMD" selected');
      expect(html).not.toContain('--alpb');
      expect(html).not.toContain('--gbsa');
    } finally {
      Object.assign(node.settings, original);
    }
  });
});

describe('xTB run payload', () => {
  it('drops every hidden Gaussian resource field and emits no Gaussian Link 0', () => {
    const settings = defaultSettings({
      jobType: 'SP',
      memory: '32',
      memoryUnit: 'GB',
      nproc: '16',
      checkpoint: 'leak.chk',
    });
    const payload = runSettingsFor('xtb', settings);

    expect(payload).not.toHaveProperty('memory');
    expect(payload).not.toHaveProperty('memoryUnit');
    expect(payload).not.toHaveProperty('nproc');
    expect(payload).not.toHaveProperty('checkpoint');

    const built = buildXtbInput({ settings: payload, molecule: molecule(), inputName: 'sp.xyz' });
    const invocation = built.argv.join(' ');
    expect(invocation).not.toMatch(/%mem|%chk|%nprocshared|\.chk/i);
    expect(invocation).not.toContain('--chk');
    expect(built.inputText).not.toContain('%');
  });

  it('keeps the Gaussian payload intact, including its resource fields', () => {
    const settings = defaultSettings({
      jobType: 'Opt',
      memory: '32',
      memoryUnit: 'GB',
      nproc: '16',
      checkpoint: 'keep.chk',
    });
    const payload = runSettingsFor('gaussian', settings);
    expect(payload).toEqual(settings);
    expect(payload.memory).toBe('32');
    expect(payload.nproc).toBe('16');
    expect(payload.checkpoint).toBe('keep.chk');
  });
});

describe('xTB implicit solvation', () => {
  it('emits --alpb with the xTB solvent identifier and a matching route', () => {
    const built = buildXtbInput({
      settings: { jobType: 'SP', solvation: true, solvationModel: 'ALPB', solvent: 'Water' },
      molecule: molecule(),
      inputName: 'water.xyz',
    });
    expect(built.argv.slice(-2)).toEqual(['--alpb', 'water']);
    expect(built.route).toBe('GFN2-xTB SP · ALPB water');
    expect(built.solvation).toEqual({ model: 'ALPB', solvent: 'water', state: 'default (gsolv)' });
  });

  it('emits --gbsa with the GBSA solvent identifier', () => {
    const built = buildXtbInput({
      settings: { jobType: 'Opt', solvation: true, solvationModel: 'GBSA', solvent: 'Water' },
      molecule: molecule(),
      inputName: 'water.xyz',
    });
    expect(built.argv.slice(-2)).toEqual(['--gbsa', 'h2o']);
    expect(built.route).toBe('GFN2-xTB Opt · GBSA h2o');
  });

  it('accepts a lower-case model name the way the builder always has', () => {
    const built = buildXtbInput({
      settings: { jobType: 'SP', solvation: true, solvationModel: 'alpb', solvent: 'THF' },
      molecule: molecule(),
      inputName: 'water.xyz',
    });
    expect(built.argv).toContain('--alpb');
    expect(built.argv).toContain(XTB_SOLVENTS.ALPB.THF);
  });

  it('keeps the solvation choice when building the run settings', () => {
    const settings = defaultSettings({
      jobType: 'SP',
      solvation: true,
      solvationModel: 'GBSA',
      solvent: 'THF',
    });
    const payload = runSettingsFor('xtb', settings);
    expect(payload.solvation).toBe(true);
    expect(payload.solvationModel).toBe('GBSA');
    expect(payload.solvent).toBe('THF');
  });

  it('refuses a solvent with no parameter for the selected model', () => {
    expect(() => buildXtbInput({
      settings: { jobType: 'SP', solvation: true, solvationModel: 'ALPB', solvent: 'Hexane' },
      molecule: molecule(),
      inputName: 'water.xyz',
    })).toThrow(/Solvent "Hexane" has no ALPB parameter/);

    expect(() => buildXtbInput({
      settings: { jobType: 'SP', solvation: true, solvationModel: 'GBSA', solvent: 'Hexane' },
      molecule: molecule(),
      inputName: 'water.xyz',
    })).toThrow(/Solvent "Hexane" has no GBSA parameter/);
  });

  it('refuses a Gaussian-only model instead of dropping it', () => {
    expect(() => buildXtbInput({
      settings: { jobType: 'SP', solvation: true, solvationModel: 'SMD', solvent: 'Water' },
      molecule: molecule(),
      inputName: 'water.xyz',
    })).toThrow(/xTB does not implement SMD/);
  });

  it('leaves Gaussian SMD/SCRF solvation untouched', () => {
    const settings = defaultSettings({
      jobType: 'SP',
      solvation: true,
      solvationModel: 'SMD',
      solvent: 'Water',
    });
    const text = buildGaussianInput({ title: 'synthetic route', settings, molecule: molecule(), inputName: 'g.gjf' });
    expect(text).toContain('SCRF=(SMD,Solvent=Water)');
    expect(text).not.toContain('--alpb');
    expect(text).not.toContain('--gbsa');
    expect(methodBlockFor(settings).solvation).toBe('SMD/Water');
  });
});

describe('xTB thread count', () => {
  it('maps the configured number to OMP_NUM_THREADS', () => {
    const env = XtbRunner.environmentFor({
      executable: '/opt/xtb/bin/xtb',
      threads: '6',
      env: { PATH: '/usr/bin' },
    });
    expect(env.OMP_NUM_THREADS).toBe('6');
  });

  it('inherits OMP_NUM_THREADS and otherwise defaults to one thread', () => {
    expect(XtbRunner.environmentFor({
      executable: '/opt/xtb/bin/xtb',
      env: { PATH: '/usr/bin', OMP_NUM_THREADS: '4' },
    }).OMP_NUM_THREADS).toBe('4');
    expect(XtbRunner.environmentFor({
      executable: '/opt/xtb/bin/xtb',
      env: { PATH: '/usr/bin' },
    }).OMP_NUM_THREADS).toBe('1');
  });

  it('refuses an invalid explicit thread count instead of ignoring it', () => {
    for (const value of ['0', '257', '2.5', 'many']) {
      expect(() => XtbRunner.threadsFor(value)).toThrow(/thread count must be an integer/);
    }
  });

  it('keeps the thread count in the xTB payload settings', () => {
    const settings = defaultSettings({ jobType: 'SP', xtbThreads: 6 });
    expect(runSettingsFor('xtb', settings).xtbThreads).toBe(6);
  });
});

describe('xTB solvation provenance', () => {
  const roots = [];
  afterEach(async () => {
    await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it('records the model and solvent in run.json without parsing argv later', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-xtb-inspector-'));
    roots.push(root);
    const manager = new RunManager({ runsRoot: root, emit: () => {} });
    const settings = defaultSettings({
      jobType: 'SP',
      solvation: true,
      solvationModel: 'ALPB',
      solvent: 'Water',
    });
    const built = buildXtbInput({ settings, molecule: molecule(), inputName: 'solv.xyz' });
    const done = new Promise((resolve) => {
      manager.onEvent((event) => {
        if (event.type === 'done') resolve(event);
      });
    });

    const started = await manager.start({
      title: 'solvated water',
      engine: 'xtb',
      argv: built.argv,
      inputText: built.inputText,
      inputName: built.inputName,
      outputName: built.outputName,
      settings,
      dryRun: true,
      gates: {},
    });
    await done;

    const runJson = JSON.parse(await fsp.readFile(path.join(started.runDir, 'run.json'), 'utf8'));
    expect(runJson.argv).toEqual(built.argv);
    expect(runJson.provenance.solvation).toEqual({ model: 'ALPB', solvent: 'water', flag: '--alpb' });
    expect(xtbSolvationFromArgv(built.argv)).toEqual({ model: 'ALPB', solvent: 'water', flag: '--alpb' });
    expect(xtbSolvationFromArgv(['gas.xyz', '--gfn', '2'])).toBeNull();
  });
});
