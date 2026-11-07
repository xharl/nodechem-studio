import { describe, it, expect } from 'vitest';
import {
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
  it('accepts the seeded v0.1 project and stamps schemaVersion 1', () => {
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
      method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: 4,
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
    expect(error.message).toContain('Update Gaussian Node Studio');
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
    expect(first.text.startsWith('{\n  "schemaVersion": 1,')).toBe(true);
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
        output: { bundle: 'project.zip', manifest: true, notes: '' },
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
    expect(result.errors.some((error) => error.path === 'nodes[0].id')).toBe(true);
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
    expect(result.errors.some((error) => error.path === 'edges[0].branch')).toBe(true);
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
      expect(result.errors.some((error) => error.path === 'nodes[0].x')).toBe(true);
    }
  });

  it('enforces the node and connection caps', () => {
    const raw = legacyProject();
    raw.nodes = Array.from({ length: 2001 }, (_, index) => ({ ...raw.nodes[0], id: `n-${index}` }));
    const result = validateProject(raw);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path === 'nodes')).toBe(true);
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
      output: { bundle: '../../escape.zip', manifest: true, notes: '' },
    }));
    expect(badBundle.ok).toBe(false);
    expect(badBundle.errors.some((error) => error.path === 'nodes[0].output.bundle')).toBe(true);
  });
});

describe('project schema v1 — v1 files are strict', () => {
  it('rejects a v1 node missing a required field', () => {
    const project = projectWithNode(calcNode());
    delete project.nodes[0].title;
    const result = validateProject(project);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path === 'nodes[0].title')).toBe(true);
  });

  it('rejects a v1 node with an unknown node type', () => {
    const project = projectWithNode(calcNode({ type: 'shortcut' }));
    const result = validateProject(project);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path === 'nodes[0].type')).toBe(true);
  });

  it('rejects an unknown node state', () => {
    const project = projectWithNode(calcNode({ state: 'exploded' }));
    const result = validateProject(project);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path === 'nodes[0].state')).toBe(true);
  });

  it('warns about unknown fields but still validates', () => {
    const project = projectWithNode(calcNode());
    project.nodes[0].annotation = 'from a future build';
    const result = validateProject(project);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => warning.path === 'nodes[0].annotation')).toBe(true);
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
      jobType: 'Opt', method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4',
    });
    expect(defaultGates()).toEqual({
      termination: true, scf: true, imaginary: null, minMagnitude: 50, thermo: false, finalEnergy: false,
    });
    expect(defaultSettings({ gates: { imaginary: 1 } }).gates.imaginary).toBe(1);
  });

  it('maps job types to short node kinds', () => {
    expect(kindForJob('Opt Freq')).toBe('O+F');
    expect(kindForJob('Opt=TS')).toBe('TS');
    expect(kindForJob('unknown')).toBe('SP');
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
