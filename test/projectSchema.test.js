import { describe, it, expect } from 'vitest';
import {
  JOB_TYPES,
  MAX_PROJECT_BYTES,
  SCHEMA_VERSION,
  defaultGates,
  defaultSettings,
  kindForJob,
  parseProjectText,
  stringifyProject,
  summarizeErrors,
  validateProject,
} from '../src/shared/projectSchema.js';

/**
 * In schema v2 an error path names the flow (`flows[0].nodes[0].title`); the
 * block-local suffix is what a test should assert, so a flow rename cannot
 * silently weaken the check.
 */
const hasErrorAt = (result, suffix) => result.errors.some((error) => error.path === suffix || error.path.endsWith(`.${suffix}`));

/** The exact v0.1 project object seeded by src/renderer/app.js (no schemaVersion). */
function legacyProject() {
  const settings = (overrides = {}) => ({
    jobType: 'Opt',
    method: 'B3LYP',
    basis: '6-31G(d)',
    memory: '4',
    memoryUnit: 'GB',
    nproc: '4',
    checkpoint: '',
    charge: 0,
    multiplicity: 1,
    dispersion: '',
    scf: '',
    grid: '',
    population: '',
    verbosity: '',
    solvation: false,
    solvationModel: 'PCM',
    solvent: 'Water',
    customKeywords: '',
    ircDirection: 'forward',
    gates: defaultGates(),
    ...overrides,
    gates: defaultGates(overrides.gates || {}),
  });
  const calc = (id, kind, title, x, y, options = {}) => ({
    id,
    type: 'calc',
    kind,
    title,
    state: options.state || 'ready',
    x,
    y,
    settings: settings(options.settings || {}),
    output: options.output || null,
    checkpointFrom: options.checkpointFrom || null,
  });
  return {
    name: 'Diels–Alder TS verification',
    molecule: {
      smiles: 'C=CC=C.C=C',
      charge: 0,
      multiplicity: 1,
      fragments: ['C=CC=C', 'C=C'],
    },
    defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
    nodes: [
      calc('r-opt', 'Opt', 'Reactant optimization', 10, 40, {
        state: 'passed',
        output: { file: 'r_opt.log', size: '1.8 MB' },
        settings: { checkpoint: 'r_opt.chk' },
      }),
      calc('r-freq', 'Freq', 'Reactant frequency', 10, 250, {
        state: 'passed',
        output: { file: 'r_freq.log', size: '2.4 MB' },
        settings: { jobType: 'Freq', checkpoint: 'r_freq.chk', gates: { thermo: true, imaginary: 0 } },
      }),
      calc('ts-opt', 'TS', 'TS guess optimization', 290, 40, {
        state: 'passed',
        output: { file: 'ts_opt.log', size: '2.1 MB' },
        settings: { jobType: 'Opt=TS', checkpoint: 'ts_opt.chk' },
      }),
      calc('ts-freq', 'Freq', 'TS frequency', 290, 250, {
        state: 'review',
        checkpointFrom: 'ts-opt',
        settings: {
          jobType: 'Freq',
          checkpoint: 'ts_freq.chk',
          gates: { thermo: true, imaginary: 1, minMagnitude: 50 },
        },
      }),
      {
        id: 'cond',
        type: 'condition',
        kind: 'If',
        title: 'True saddle?',
        state: 'review',
        x: 570,
        y: 250,
        condition: {
          expression: 'imaginaryCount == 1\nand abs(nu) >= 50',
          unknown: 'block-both',
          notes: 'Evaluated from the parsed frequency block, not from the job exit status.',
        },
      },
      calc('irc', 'IRC', 'IRC verification', 850, 110, {
        state: 'blocked',
        settings: { jobType: 'IRC', ircDirection: 'both' },
      }),
      {
        id: 'retry',
        type: 'loop',
        kind: 'Loop',
        title: 'Re-guess TS',
        state: 'ready',
        x: 850,
        y: 370,
        loop: { maxAttempts: 3, mode: 'retry', target: 'ts-opt', until: 'condition is false' },
      },
    ],
    edges: [
      { from: 'r-opt', to: 'r-freq', type: 'dependency', fromPort: 'bottom', toPort: 'top' },
      { from: 'r-opt', to: 'ts-opt', type: 'dependency', fromPort: 'right', toPort: 'left' },
      { from: 'ts-opt', to: 'ts-freq', type: 'checkpoint', fromPort: 'bottom', toPort: 'top' },
      { from: 'ts-freq', to: 'cond', type: 'dependency', fromPort: 'right', toPort: 'left' },
      { from: 'cond', to: 'irc', type: 'branch', branch: 'true', fromPort: 'true', toPort: 'left' },
      { from: 'cond', to: 'retry', type: 'branch', branch: 'false', fromPort: 'false', toPort: 'left' },
      { from: 'retry', to: 'ts-opt', type: 'loop', fromPort: 'bottom', toPort: 'bottomIn' },
    ],
  };
}

/** A minimal valid v1 project with exactly one node of the given kind. */
function projectWithNode(node) {
  const base = validateProject(legacyProject()).project;
  return {
    ...base,
    nodes: [node],
    edges: [],
  };
}

function calcNode(overrides = {}) {
  return {
    id: 'calc-1',
    type: 'calc',
    kind: 'Opt',
    title: 'Optimization',
    state: 'ready',
    x: 10,
    y: 40,
    settings: defaultSettings(),
    output: null,
    checkpointFrom: null,
    ...overrides,
  };
}

describe('project schema v1 — legacy migration', () => {
  it('accepts the seeded v0.1 project and stamps the current schemaVersion', () => {
    const result = validateProject(legacyProject());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.migrated).toBe(true);
    expect(result.schemaVersion).toBe(0);
    expect(result.project.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.project.nodes).toHaveLength(7);
    expect(result.project.edges).toHaveLength(7);
  });

  it('preserves chemistry-relevant fields through migration', () => {
    const { project } = validateProject(legacyProject());
    const tsFreq = project.nodes.find((node) => node.id === 'ts-freq');
    expect(tsFreq.checkpointFrom).toBe('ts-opt');
    expect(tsFreq.settings.jobType).toBe('Freq');
    expect(tsFreq.settings.method).toBe('B3LYP');
    expect(tsFreq.settings.basis).toBe('6-31G(d)');
    expect(tsFreq.settings.dispersion).toBe('');
    expect(tsFreq.settings.gates).toEqual({
      termination: true,
      scf: true,
      imaginary: 1,
      minMagnitude: 50,
      thermo: true,
      finalEnergy: false,
    });
    expect(tsFreq.output).toBeNull();
    const rFreq = project.nodes.find((node) => node.id === 'r-freq');
    expect(rFreq.output).toEqual({ file: 'r_freq.log', size: '2.4 MB' });
    const condition = project.nodes.find((node) => node.id === 'cond');
    expect(condition.condition.expression).toContain('imaginaryCount == 1');
    const loop = project.nodes.find((node) => node.id === 'retry');
    expect(loop.loop).toEqual({
      maxAttempts: 3,
      mode: 'retry',
      target: 'ts-opt',
      until: 'condition is false',
    });
  });

  it('treats an explicit schemaVersion 0 as legacy', () => {
    const result = validateProject({ ...legacyProject(), schemaVersion: 0 });
    expect(result.ok).toBe(true);
    expect(result.migrated).toBe(true);
  });

  it('fills missing v0.1 fields with documented defaults instead of failing', () => {
    const raw = legacyProject();
    delete raw.defaults;
    delete raw.molecule.fragments;
    raw.nodes[1].settings = { jobType: 'Freq' };
    const result = validateProject(raw);
    expect(result.ok).toBe(true);
    expect(result.project.defaults).toEqual({
      engine: 'gaussian',
      method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: 4,
    });
    expect(result.project.molecule.fragments).toEqual([]);
    expect(result.project.nodes[1].settings.checkpoint).toBe('');
    expect(result.project.nodes[1].settings.gates.thermo).toBe(false);
  });

  it('reports dropped legacy keys as warnings, not errors', () => {
    const raw = legacyProject();
    raw.legacyOnlyField = { keep: false };
    const result = validateProject(raw);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => warning.path === 'legacyOnlyField')).toBe(true);
  });
});

describe('project schema v1 — versioning', () => {
  it('rejects a project from a newer schema version with a clear message', () => {
    const raw = { ...legacyProject(), schemaVersion: SCHEMA_VERSION + 1 };
    const result = validateProject(raw);
    expect(result.ok).toBe(false);
    expect(result.project).toBeNull();
    const error = result.errors.find((item) => item.path === 'schemaVersion');
    expect(error.message).toContain(`version ${SCHEMA_VERSION + 1}`);
    expect(error.message).toContain('Update NodeChem Studio');
  });

  it('rejects a non-integer schema version', () => {
    const result = validateProject({ ...legacyProject(), schemaVersion: 'one' });
    expect(result.ok).toBe(false);
    expect(result.errors[0].path).toBe('schemaVersion');
  });

  it('rejects a JSON array or scalar as a project', () => {
    for (const value of [[], 'project', 42, null]) {
      const result = validateProject(value);
      expect(result.ok).toBe(false);
      expect(result.project).toBeNull();
    }
  });
});

describe('project schema v1 — canonical serialization', () => {
  it('is byte-stable across a save/reopen round-trip', () => {
    const first = stringifyProject(legacyProject());
    expect(first.ok).toBe(true);
    expect(first.text.startsWith(`{\n  "schemaVersion": ${SCHEMA_VERSION},`)).toBe(true);
    expect(first.text.endsWith('\n')).toBe(true);

    const reopened = parseProjectText(first.text);
    expect(reopened.ok).toBe(true);
    expect(reopened.migrated).toBe(false);
    expect(reopened.errors).toEqual([]);

    const second = stringifyProject(reopened.project);
    expect(second.text).toBe(first.text);
  });

  it('normalizes numbers and strings once, then leaves them alone', () => {
    const raw = legacyProject();
    raw.defaults.nproc = '8';
    raw.nodes[0].settings.memory = 16;
    const once = validateProject(raw).project;
    const twice = validateProject(once).project;
    expect(once.defaults.nproc).toBe(8);
    expect(once.nodes[0].settings.memory).toBe('16');
    expect(twice).toEqual(once);
  });

  it('does not mutate the caller object', () => {
    const raw = legacyProject();
    const snapshot = JSON.parse(JSON.stringify(raw));
    validateProject(raw);
    expect(raw).toEqual(snapshot);
  });

  it('round-trips one node of every kind', () => {
    const nodes = [
      calcNode(),
      {
        id: 'cond-1', type: 'condition', kind: 'If', title: 'Condition', state: 'ready', x: 300, y: 40,
        condition: { expression: 'scf.converged == true', unknown: 'block-both', notes: '' },
      },
      {
        id: 'loop-1', type: 'loop', kind: 'Loop', title: 'Retry loop', state: 'ready', x: 300, y: 200,
        loop: { maxAttempts: 3, mode: 'for-each', target: '', until: 'condition is false' },
      },
      {
        id: 'merge-1', type: 'merge', kind: 'Merge', title: 'Join branches', state: 'ready', x: 600, y: 40,
        merge: { policy: 'any', notes: '' },
      },
      {
        id: 'out-1', type: 'output', kind: 'Output', title: 'Project output', state: 'ready', x: 600, y: 200,
        output: { kind: 'zip', path: 'project.zip', include: 'records', bundle: 'project.zip', manifest: true, notes: '' },
      },
      {
        id: 'note-1', type: 'note', kind: 'Note', title: 'Note', state: 'ready', x: 600, y: 360,
        note: { text: 'Remember the checkpoint hand-off.' },
      },
    ];
    for (const node of nodes) {
      const project = projectWithNode(node);
      const result = validateProject(project);
      expect(result.ok, `${node.type}: ${summarizeErrors(result.errors)}`).toBe(true);
      const text = stringifyProject(result.project).text;
      expect(stringifyProject(parseProjectText(text).project).text).toBe(text);
    }
  });
});

describe('project schema v1 — graph validation', () => {
  it('rejects duplicate node ids', () => {
    const raw = legacyProject();
    raw.nodes.push({ ...raw.nodes[0] });
    const result = validateProject(raw);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.message.includes('duplicate node id'))).toBe(true);
  });

  it('rejects ids that are not safe file stems', () => {
    const raw = legacyProject();
    raw.nodes[0].id = 'bad id/../x';
    const result = validateProject(raw);
    expect(result.ok).toBe(false);
    expect(hasErrorAt(result, 'nodes[0].id')).toBe(true);
  });

  it('rejects edges to unknown nodes and self edges', () => {
    const raw = legacyProject();
    raw.edges.push({ from: 'r-opt', to: 'ghost', type: 'dependency' });
    raw.edges.push({ from: 'r-opt', to: 'r-opt', type: 'dependency' });
    const result = validateProject(raw);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.message.includes('unknown node "ghost"'))).toBe(true);
    expect(result.errors.some((error) => error.message.includes('must not connect a node to itself'))).toBe(true);
  });

  it('requires a branch value on branch edges and rejects duplicates', () => {
    const raw = legacyProject();
    raw.edges = [
      { from: 'r-opt', to: 'r-freq', type: 'branch' },
      { from: 'r-opt', to: 'ts-opt', type: 'dependency' },
      { from: 'r-opt', to: 'ts-opt', type: 'dependency' },
    ];
    const result = validateProject(raw);
    expect(result.ok).toBe(false);
    expect(hasErrorAt(result, 'edges[0].branch')).toBe(true);
    expect(result.errors.some((error) => error.message.includes('duplicates the dependency connection'))).toBe(true);
  });

  it('rejects a checkpoint hand-off that points at a non-calculation node', () => {
    const raw = legacyProject();
    raw.nodes.find((node) => node.id === 'ts-freq').checkpointFrom = 'cond';
    const result = validateProject(raw);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.message.includes('must reference a calculation node'))).toBe(true);
  });

  it('rejects a loop target that is not a calculation node', () => {
    const raw = legacyProject();
    raw.nodes.find((node) => node.id === 'retry').loop.target = 'cond';
    const result = validateProject(raw);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.message.includes('must target a calculation node'))).toBe(true);
  });

  it('rejects coordinates that are not finite numbers', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 'left', 1e9]) {
      const raw = legacyProject();
      raw.nodes[0].x = value;
      const result = validateProject(raw);
      expect(result.ok, `x=${value}`).toBe(false);
      expect(hasErrorAt(result, 'nodes[0].x')).toBe(true);
    }
  });

  it('enforces the node and connection caps', () => {
    const raw = legacyProject();
    raw.nodes = Array.from({ length: 2001 }, (_, index) => ({ ...raw.nodes[0], id: `n-${index}` }));
    const result = validateProject(raw);
    expect(result.ok).toBe(false);
    expect(hasErrorAt(result, 'nodes')).toBe(true);
  });
});

describe('project schema v1 — settings and gates', () => {
  const cases = [
    ['nproc', 0, 'must be an integer between 1 and 1024'],
    ['memory', '0', 'must be a number between 1 and 1048576'],
    ['memoryUnit', 'TB', 'must be one of'],
    ['checkpoint', 'ts opt.chk', 'must be a safe file name ending in .chk'],
    ['jobType', 'Opt=QST2', 'must be one of'],
    ['charge', 11, 'must be an integer between -10 and 10'],
    ['multiplicity', 0, 'must be an integer between 1 and 10'],
    ['solvationModel', 'COSMO', 'must be one of'],
    ['ircDirection', 'sideways', 'must be one of'],
    ['customKeywords', 42, 'must be a string'],
  ];

  for (const [field, value, message] of cases) {
    it(`rejects an invalid ${field}`, () => {
      const raw = legacyProject();
      raw.nodes[0].settings[field] = value;
      const result = validateProject(raw);
      expect(result.ok).toBe(false);
      expect(result.errors.some((error) => error.message.includes(message))).toBe(true);
    });
  }

  it('rejects negative or non-boolean gate values', () => {
    const raw = legacyProject();
    raw.nodes[1].settings.gates.imaginary = -1;
    raw.nodes[1].settings.gates.termination = 'yes';
    raw.nodes[1].settings.gates.minMagnitude = -5;
    const result = validateProject(raw);
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.path)).toEqual(expect.arrayContaining([
      'nodes[1].settings.gates.imaginary',
      'nodes[1].settings.gates.termination',
      'nodes[1].settings.gates.minMagnitude',
    ]));
  });

  it('allows a null imaginary gate (not evaluated)', () => {
    const raw = legacyProject();
    raw.nodes[0].settings.gates.imaginary = null;
    const result = validateProject(raw);
    expect(result.ok).toBe(true);
    expect(result.project.nodes[0].settings.gates.imaginary).toBeNull();
  });

  it('validates molecule fragments and output bundle names', () => {
    const badFragments = legacyProject();
    badFragments.molecule.fragments = 'C=CC=C';
    expect(validateProject(badFragments).ok).toBe(false);

    const noFragments = legacyProject();
    noFragments.molecule.fragments = Array.from({ length: 65 }, () => 'C');
    expect(validateProject(noFragments).ok).toBe(false);

    const badBundle = validateProject(projectWithNode({
      id: 'out-1', type: 'output', kind: 'Output', title: 'Project output', state: 'ready', x: 0, y: 0,
      output: { kind: 'zip', path: '../../escape.zip', include: 'records', bundle: '../../escape.zip', manifest: true, notes: '' },
    }));
    expect(badBundle.ok).toBe(false);
    expect(hasErrorAt(badBundle, 'nodes[0].output.bundle')).toBe(true);
  });
});

describe('project schema v1 — v1 files are strict', () => {
  it('rejects a v1 node missing a required field', () => {
    const project = projectWithNode(calcNode());
    delete project.nodes[0].title;
    const result = validateProject(project);
    expect(result.ok).toBe(false);
    expect(hasErrorAt(result, 'nodes[0].title')).toBe(true);
  });

  it('rejects a v1 node with an unknown node type', () => {
    const project = projectWithNode(calcNode({ type: 'shortcut' }));
    const result = validateProject(project);
    expect(result.ok).toBe(false);
    expect(hasErrorAt(result, 'nodes[0].type')).toBe(true);
  });

  it('rejects an unknown node state', () => {
    const project = projectWithNode(calcNode({ state: 'exploded' }));
    const result = validateProject(project);
    expect(result.ok).toBe(false);
    expect(hasErrorAt(result, 'nodes[0].state')).toBe(true);
  });

  it('warns about unknown fields but still validates', () => {
    const project = projectWithNode(calcNode());
    project.nodes[0].annotation = 'from a future build';
    const result = validateProject(project);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => warning.path === 'nodes[0].annotation'
      || warning.path.endsWith('.nodes[0].annotation'))).toBe(true);
  });
});

describe('project text parsing', () => {
  it('reports malformed JSON with the parser message', () => {
    const result = parseProjectText('{"name": "broken", ');
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain('Invalid JSON');
  });

  it('accepts a UTF-8 BOM', () => {
    const text = `\uFEFF${JSON.stringify(legacyProject())}`;
    const result = parseProjectText(text);
    expect(result.ok).toBe(true);
    expect(result.project.nodes).toHaveLength(7);
  });

  it('rejects files above the size cap before parsing', () => {
    const result = parseProjectText(' '.repeat(MAX_PROJECT_BYTES + 1));
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain('limit is 8 MB');
  });

  it('rejects non-string input', () => {
    expect(parseProjectText(Buffer.from('{}')).ok).toBe(false);
  });
});

describe('schema helpers', () => {
  it('exposes defaults consistent with the renderer', () => {
    expect(defaultSettings()).toMatchObject({
      jobType: 'Opt', method: 'B3LYP', basis: 'def2-SVP', dispersion: 'GD3BJ',
      memory: '4', memoryUnit: 'GB', nproc: '4',
    });
    expect(defaultGates()).toEqual({
      termination: true, scf: true, imaginary: null, minMagnitude: 50, thermo: false, finalEnergy: false,
    });
    expect(defaultSettings({ gates: { imaginary: 1 } }).gates.imaginary).toBe(1);
  });

  it('maps job types to short node kinds', () => {
    expect(kindForJob('Opt Freq')).toBe('O+F');
    expect(kindForJob('Opt=TS')).toBe('TS');
    expect(kindForJob('G4')).toBe('Composite');
    expect(kindForJob('unknown')).toBe('SP');
  });

  it('offers composite job types without a method/basis placeholder', () => {
    expect(JOB_TYPES).toEqual(expect.arrayContaining(['CBS-QB3', 'G4', 'G4(MP2)']));
    const settings = defaultSettings({ jobType: 'G4' });
    expect(settings.method).toBe('');
    expect(settings.basis).toBe('');
    expect(settings.dispersion).toBe('');
    expect(settings.counterpoise).toBe(0);
    expect(settings.counterpoiseChargeStates).toEqual([]);
  });

  it('summarizes errors with paths and a remainder count', () => {
    const errors = [
      { path: 'nodes[0].id', message: 'bad' },
      { path: 'edges[1].to', message: 'missing' },
      { path: '', message: 'top' },
      { path: 'x', message: 'y' },
    ];
    const summary = summarizeErrors(errors, 2);
    expect(summary).toBe('nodes[0].id: bad · edges[1].to: missing · +2 more');
    expect(summarizeErrors([])).toBe('Unknown validation error.');
  });
});

describe('project molecule geometry', () => {
  const imported = () => {
    const project = validateProject(legacyProject()).project;
    project.molecule.coords = [
      { element: 'O', x: 0, y: 0, z: 0.1173 },
      { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
      { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
    ];
    project.molecule.geometry = { source: 'imported', file: 'water.xyz', format: 'xyz' };
    return project;
  };

  it('migrates v0.1 projects to the demo geometry', () => {
    const { project } = validateProject(legacyProject());
    expect(project.molecule.coords).toEqual([]);
    expect(project.molecule.geometry).toEqual({ source: 'demo', file: '', format: '' });
  });

  it('round-trips imported coordinates byte-stably', () => {
    const result = validateProject(imported());
    expect(result.ok).toBe(true);
    expect(result.project.molecule.coords).toHaveLength(3);
    expect(result.project.molecule.geometry.source).toBe('imported');
    const text = stringifyProject(result.project).text;
    expect(stringifyProject(parseProjectText(text).project).text).toBe(text);
  });

  it('rejects an unknown element symbol in a stored geometry', () => {
    const project = imported();
    project.molecule.coords[0].element = 'Xx';
    const result = validateProject(project);
    expect(result.ok).toBe(false);
    expect(hasErrorAt(result, 'molecule.coords[0].element')).toBe(true);
  });

  it('rejects imported geometry with no atoms', () => {
    const project = validateProject(legacyProject()).project;
    project.molecule.geometry = { source: 'imported', file: 'x.xyz', format: 'xyz' };
    const result = validateProject(project);
    expect(result.ok).toBe(false);
    expect(hasErrorAt(result, 'molecule.coords')).toBe(true);
  });

  it('rejects a coordinate outside the finite range', () => {
    const project = imported();
    project.molecule.coords[1].y = 1e9;
    const result = validateProject(project);
    expect(result.ok).toBe(false);
    expect(hasErrorAt(result, 'molecule.coords[1].y')).toBe(true);
  });

  it('accepts manual geometry with atoms', () => {
    const project = imported();
    project.molecule.geometry = { source: 'manual', file: '', format: '' };
    expect(validateProject(project).ok).toBe(true);
  });
});

describe('project schema v1 — engine-specific solvation models (#102)', () => {
  /** One xTB calc block whose settings start from the real factory. */
  const xtbProject = (settings = {}) => {
    const project = projectWithNode(calcNode({
      settings: defaultSettings({
        jobType: 'SP', method: '', basis: '', engine: 'xtb',
        solvation: true, solvationModel: 'ALPB',
        ...settings,
      }),
    }));
    project.defaults.engine = 'xtb';
    return project;
  };

  it('round-trips ALPB and GBSA through stringifyProject and parseProjectText', () => {
    for (const model of ['ALPB', 'GBSA']) {
      const saved = stringifyProject(xtbProject({ solvationModel: model }));
      expect(saved.ok, summarizeErrors(saved.errors)).toBe(true);
      expect(saved.text).toContain(`"solvationModel": "${model}"`);
      const reopened = parseProjectText(saved.text);
      expect(reopened.ok).toBe(true);
      expect(reopened.project.nodes[0].settings.solvationModel).toBe(model);
      expect(reopened.project.nodes[0].settings.solvation).toBe(true);
    }
  });

  it('rejects a Gaussian solvation model on an xTB block with a precise message', () => {
    const result = validateProject(xtbProject({ solvationModel: 'PCM' }));
    expect(result.ok).toBe(false);
    const error = result.errors.find((item) => item.path === 'nodes[0].settings.solvationModel'
      || item.path.endsWith('.nodes[0].settings.solvationModel'));
    expect(error).toBeDefined();
    expect(error.message).toContain('"PCM"');
    expect(error.message).toContain('Gaussian-only');
    expect(error.message).toContain('xTB accepts ALPB or GBSA');
  });

  it('defaults an xTB block with no model to ALPB', () => {
    const settings = defaultSettings({ jobType: 'SP', method: '', basis: '', engine: 'xtb', solvation: true });
    delete settings.solvationModel;
    const project = projectWithNode(calcNode({ settings }));
    project.defaults.engine = 'xtb';
    const result = validateProject(project);
    expect(result.ok).toBe(true);
    expect(result.project.nodes[0].settings.solvationModel).toBe('ALPB');
  });

  it('keeps an empty model readable on an xTB block', () => {
    const result = validateProject(xtbProject({ solvation: false, solvationModel: '' }));
    expect(result.ok).toBe(true);
    expect(result.project.nodes[0].settings.solvationModel).toBe('');
  });

  it('tolerates the legacy PCM placeholder while solvation is off, but not once it is on', () => {
    // defaultSettings() has always written PCM; the renderer only rewrites it
    // when solvation is toggled, so pre-#102 xTB projects carry it on blocks
    // that never enabled solvation. It is inert there and must stay readable.
    const off = validateProject(xtbProject({ solvation: false, solvationModel: 'PCM' }));
    expect(off.ok, summarizeErrors(off.errors)).toBe(true);
    expect(off.project.nodes[0].settings.solvationModel).toBe('PCM');

    const on = validateProject(xtbProject({ solvation: true, solvationModel: 'PCM' }));
    expect(on.ok).toBe(false);
  });

  it('resolves the engine from defaults.engine when the block inherits it', () => {
    const project = xtbProject({ engine: '' });
    expect(validateProject(project).ok).toBe(true);
    project.nodes[0].settings.solvationModel = 'PCM';
    expect(validateProject(project).ok).toBe(false);
  });

  it('honours a per-block xTB override in a Gaussian project', () => {
    const project = projectWithNode(calcNode({
      settings: defaultSettings({
        jobType: 'SP', engine: 'xtb', solvation: true, solvationModel: 'ALPB',
      }),
    }));
    expect(project.defaults.engine).toBe('gaussian');
    expect(validateProject(project).ok).toBe(true);
    project.nodes[0].settings.solvationModel = 'PCM';
    expect(validateProject(project).ok).toBe(false);
  });

  it('keeps the Gaussian list for ALPB and for a project with no engine set', () => {
    const alpb = validateProject(projectWithNode(calcNode({
      settings: defaultSettings({ solvation: true, solvationModel: 'ALPB' }),
    })));
    expect(alpb.ok).toBe(false);
    expect(alpb.errors.some((error) => error.message === 'must be one of: PCM, SMD, CPCM.')).toBe(true);

    // No `defaults.engine` at all is the historical file shape: Gaussian, as before.
    const legacy = legacyProject();
    delete legacy.defaults.engine;
    legacy.nodes[0].settings.solvationModel = 'ALPB';
    const result = validateProject(legacy);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path === 'nodes[0].settings.solvationModel'
      && error.message === 'must be one of: PCM, SMD, CPCM.')).toBe(true);
  });
});
