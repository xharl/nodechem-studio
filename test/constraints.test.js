import { describe, it, expect } from 'vitest';
import {
  CONSTRAINT_KINDS,
  constraintAtomCount,
  describeConstraint,
  internalDegreesOfFreedom,
  measureConstraint,
  modRedundantLine,
  validateConstraints,
} from '../src/shared/constraints.js';
import { buildGaussianInput, jobKeywordWithConstraints } from '../src/shared/gaussianInput.js';
import { defaultSettings, validateProject } from '../src/shared/projectSchema.js';
import { checkTsForceConstants } from '../src/shared/tsForceConstants.js';

/**
 * Issue #93 — coordinate constraints.
 *
 * A constraint is a freeze on one internal coordinate, written into Gaussian's
 * ModRedundant section with the same 1-based indices as the geometry that is
 * actually in the file. The contract under test:
 *
 *   - the ModRedundant section follows the geometry and is named on the route;
 *   - the atom numbers are the ones in the written geometry, including a
 *     dataset record whose coordinates replace the project geometry (RFC 0001);
 *   - a stale or impossible constraint set is refused before the run, with the
 *     offending atom named.
 */

const METHANOL = [
  { element: 'C', x: -0.700, y: 0.000, z: 0.000 },
  { element: 'O', x: 0.700, y: 0.000, z: 0.000 },
  { element: 'H', x: 1.000, y: 0.900, z: 0.000 },
  { element: 'H', x: -1.100, y: 0.900, z: 0.600 },
  { element: 'H', x: -1.100, y: -0.900, z: 0.600 },
  { element: 'H', x: -1.100, y: 0.000, z: -1.000 },
];

const molecule = (coords = METHANOL) => ({ charge: 0, multiplicity: 1, coords });

function build(settings, overrides = {}) {
  return buildGaussianInput({
    title: 'Constrained optimisation',
    settings: defaultSettings({ dispersion: '', ...settings }),
    molecule: molecule(),
    inputName: 'constraint.gjf',
    ...overrides,
  });
}

describe('constraint vocabulary', () => {
  it('knows the four coordinate kinds and how many atoms each takes', () => {
    expect(CONSTRAINT_KINDS).toEqual(['bond', 'angle', 'dihedral', 'freeze']);
    expect(constraintAtomCount('bond')).toBe(2);
    expect(constraintAtomCount('angle')).toBe(3);
    expect(constraintAtomCount('dihedral')).toBe(4);
    expect(constraintAtomCount('freeze')).toBe(1);
  });

  it('names a constraint in chemical terms, not as an index tuple', () => {
    expect(describeConstraint({ kind: 'bond', atoms: [1, 2] }, METHANOL)).toBe('C1–O2 distance, 1.400 Å');
    expect(describeConstraint({ kind: 'bond', atoms: [1, 2], value: 1.8 }, METHANOL)).toBe('C1–O2 distance, 1.800 Å');
    expect(describeConstraint({ kind: 'angle', atoms: [1, 2, 3] }, METHANOL)).toBe('C1–O2–H3 angle, 108.4°');
    expect(describeConstraint({ kind: 'dihedral', atoms: [4, 1, 2, 3] }, METHANOL)).toMatch(/^H4–C1–O2–H3 dihedral, -?\d+\.\d°$/);
    expect(describeConstraint({ kind: 'freeze', atoms: [3] }, METHANOL)).toBe('H3 atom frozen');
  });

  it('measures a constraint from the written geometry', () => {
    expect(measureConstraint({ kind: 'bond', atoms: [1, 2] }, METHANOL)).toEqual({ value: 1.4, unit: 'Å' });
    expect(measureConstraint({ kind: 'angle', atoms: [1, 2, 3] }, METHANOL).unit).toBe('°');
    expect(measureConstraint({ kind: 'freeze', atoms: [3] }, METHANOL)).toBeNull();
  });

  it('writes the documented one-line ModRedundant syntax with 1-based indices', () => {
    expect(modRedundantLine({ kind: 'bond', atoms: [3, 7] })).toBe('B 3 7 F');
    expect(modRedundantLine({ kind: 'angle', atoms: [3, 7, 9] })).toBe('A 3 7 9 F');
    expect(modRedundantLine({ kind: 'dihedral', atoms: [3, 7, 9, 11] })).toBe('D 3 7 9 11 F');
    expect(modRedundantLine({ kind: 'freeze', atoms: [7] })).toBe('X 7 F');
  });
});

describe('ModRedundant section in the input', () => {
  it('adds no section and no route keyword when there is no constraint', () => {
    const text = build({ jobType: 'Opt' });
    expect(text).not.toMatch(/ModRedundant/);
    expect(text).not.toContain('B 1 2 F');
  });

  it('names ModRedundant on the route and appends every constraint after the geometry', () => {
    const text = build({
      jobType: 'Opt',
      constraints: [
        { kind: 'bond', atoms: [1, 2] },
        { kind: 'angle', atoms: [1, 2, 3] },
        { kind: 'dihedral', atoms: [1, 2, 3, 4] },
        { kind: 'freeze', atoms: [6] },
      ],
    });
    const route = text.split('\n').find((line) => line.startsWith('#p'));
    expect(route).toContain('ModRedundant');
    const lines = text.split('\n');
    const firstConstraint = lines.indexOf('B 1 2 F');
    expect(firstConstraint).toBeGreaterThan(0);
    // The section follows the last atom row, not the route and not a blank line
    // in the middle of the geometry.
    const lastAtom = lines.findIndex((line) => /^H\s+-1\.100000\s+0\.000000\s+-1\.000000/.test(line));
    expect(lastAtom).toBeGreaterThan(0);
    expect(firstConstraint).toBeGreaterThan(lastAtom);
    expect(lines.slice(firstConstraint, firstConstraint + 4)).toEqual([
      'B 1 2 F',
      'A 1 2 3 F',
      'D 1 2 3 4 F',
      'X 6 F',
    ]);
    // The molecule specification still ends at a blank line, and the section is
    // terminated by another one.
    expect(lines[lastAtom + 1]).toBe('');
    expect(lines[firstConstraint - 1]).toBe('');
    expect(lines.slice(firstConstraint + 4)).toEqual(['', '']);
    // The geometry keeps its two-character element column: a constrained input
    // differs from an unconstrained one only by the route keyword and section.
    expect(lines[lastAtom]).toMatch(/^H\s{2}/);
  });

  it('computes a Hessian for a constrained optimisation so a TS can ReadFC it', () => {
    const route = build({ jobType: 'Opt', constraints: [{ kind: 'bond', atoms: [1, 2] }] })
      .split('\n').find((line) => line.startsWith('#p'));
    expect(route).toContain('Opt=(CalcFC,ModRedundant)');
    // ...and never gains a second Opt keyword.
    expect(route.match(/\bOpt\b/g) || []).toHaveLength(1);
    expect(jobKeywordWithConstraints(defaultSettings({
      jobType: 'Opt', constraints: [{ kind: 'bond', atoms: [1, 2] }],
    }))).toBe('Opt=(CalcFC,ModRedundant)');
  });

  it('keeps the TS refusal grammar of Opt=TS and adds ModRedundant to the same keyword', () => {
    const route = build({
      jobType: 'Opt=TS',
      constraints: [{ kind: 'bond', atoms: [1, 2] }],
    }).split('\n').find((line) => line.startsWith('#p'));
    expect(route).toBe('#p B3LYP/def2SVP Opt=(TS,CalcFC,NoEigenTest,ModRedundant)');
  });

  it('refuses a constraint on a job type that has no ModRedundant section', () => {
    for (const jobType of ['SP', 'Freq', 'Scan', 'IRC']) {
      expect(() => build({ jobType, constraints: [{ kind: 'bond', atoms: [1, 2] }] }))
        .toThrow(/ModRedundant/);
    }
  });

  it('refuses a frozen coordinate inside a Scan job by name', () => {
    expect(() => build({ jobType: 'Scan', constraints: [{ kind: 'freeze', atoms: [1] }] }))
      .toThrow(/Scan/);
  });
});

describe('constraint validation', () => {
  const validate = (constraints, overrides = {}) => validateConstraints({
    constraints,
    atoms: METHANOL,
    jobType: 'Opt',
    forceConstants: 'CalcFC',
    ...overrides,
  });

  it('refuses an atom index beyond the written geometry and names it', () => {
    const { errors } = validate([{ kind: 'bond', atoms: [1, 9] }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('atom 9');
    expect(errors[0]).toContain('6 atoms');
    expect(() => build({ jobType: 'Opt', constraints: [{ kind: 'bond', atoms: [1, 9] }] }))
      .toThrow(/atom 9/);
  });

  it('refuses a zero index, because Gaussian numbers atoms from 1', () => {
    const { errors } = validate([{ kind: 'freeze', atoms: [0] }]);
    expect(errors[0]).toContain('1-based');
  });

  it('refuses a duplicate constraint, reading a bond the same way round either way', () => {
    const { errors } = validate([
      { kind: 'bond', atoms: [1, 2] },
      { kind: 'bond', atoms: [2, 1] },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/repeats/);
    expect(errors[0]).toContain('C1–O2 distance');
  });

  it('refuses a duplicate angle written with the two outer atoms swapped', () => {
    const { errors } = validate([
      { kind: 'angle', atoms: [1, 2, 3] },
      { kind: 'angle', atoms: [3, 2, 1] },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/repeats/);
  });

  it('refuses a declared value the geometry does not have, instead of freezing a different one', () => {
    const { errors } = validate([{ kind: 'bond', atoms: [1, 2], value: 1.8 }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('1.800');
    expect(errors[0]).toContain('1.400');
    expect(errors[0]).toMatch(/geometry/);
  });

  it('accepts a declared value that matches the geometry', () => {
    expect(validate([{ kind: 'bond', atoms: [1, 2], value: 1.4 }]).errors).toEqual([]);
  });

  it('refuses a constraint set that leaves no internal degree of freedom', () => {
    // 3N-6 for six atoms is twelve; freezing all six atoms removes eighteen.
    const frozen = [1, 2, 3, 4, 5, 6].map((atom) => ({ kind: 'freeze', atoms: [atom] }));
    const { errors } = validate(frozen);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/no internal degree of freedom/);
    expect(internalDegreesOfFreedom(4)).toBe(6);
    expect(internalDegreesOfFreedom(2)).toBe(1);
    expect(internalDegreesOfFreedom(1)).toBe(0);
  });

  it('warns when a constrained saddle search has no Hessian guess', () => {
    const { errors, warnings } = validate([{ kind: 'bond', atoms: [1, 2] }], {
      jobType: 'Opt=TS',
      forceConstants: 'default',
    });
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Hessian|CalcFC/);
  });

  it('refuses constraints on an engine that has no ModRedundant section', () => {
    const { errors } = validate([{ kind: 'bond', atoms: [1, 2] }], { engine: 'xtb' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Gaussian/);
  });

  it('counts constraints against the geometry it is handed, not a project-level one', () => {
    // RFC 0001: a dataset record's coordinates replace the project geometry, so
    // a three-atom record makes a constraint on atom 4 out of range.
    const record = METHANOL.slice(0, 3);
    expect(() => build({ jobType: 'Opt', constraints: [{ kind: 'freeze', atoms: [4] }] }, {
      molecule: { charge: 0, multiplicity: 1, coords: record },
    })).toThrow(/atom 4/);
  });

  it('lets a constrained CalcFC optimisation feed a ReadFC saddle search', () => {
    // The point of #93: a relaxed scan (or any constrained optimisation) that
    // computes a Hessian is a legitimate source for Opt=TS ReadFC.
    const upstream = {
      id: 'scan',
      title: 'Constrained scan',
      settings: defaultSettings({ jobType: 'Opt', constraints: [{ kind: 'bond', atoms: [1, 2] }] }),
    };
    const { errors } = checkTsForceConstants({
      settings: defaultSettings({ jobType: 'Opt=TS', forceConstants: 'ReadFC' }),
      upstream,
    });
    expect(errors).toEqual([]);
    // ...while an unconstrained Opt still writes no force constants.
    const unconstrained = { ...upstream, settings: defaultSettings({ jobType: 'Opt' }) };
    expect(checkTsForceConstants({
      settings: defaultSettings({ jobType: 'Opt=TS', forceConstants: 'ReadFC' }),
      upstream: unconstrained,
    }).errors).toHaveLength(1);
  });
});

describe('constraints in the project schema', () => {
  const project = (settings) => ({
    schemaVersion: 2,
    name: 'Constrained',
    molecule: { charge: 0, multiplicity: 1, fragments: [], coords: METHANOL, geometry: { source: 'imported', file: 'm.gjf', format: 'gjf' } },
    defaults: { engine: 'gaussian', method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: 4 },
    runner: { maxParallel: 1 },
    datasets: [],
    flows: [{
      id: 'main',
      title: 'Workflow',
      nodes: [{
        id: 'opt-1',
        type: 'calc',
        kind: 'Opt',
        title: 'Constrained optimisation',
        state: 'ready',
        x: 0,
        y: 0,
        settings: defaultSettings(settings),
        output: null,
        checkpointFrom: null,
      }],
      edges: [],
    }],
    reports: [],
    activeFlowId: 'main',
  });

  it('defaults to no constraints and no QST, so an old project keeps its text', () => {
    const settings = defaultSettings();
    expect(settings.constraints).toEqual([]);
    expect(settings.qst).toBeNull();
  });

  it('refuses an out-of-range index at validate time with a readable path', () => {
    const result = validateProject(project({ constraints: [{ kind: 'bond', atoms: [1, 9] }] }));
    expect(result.ok).toBe(false);
    const error = result.errors.find((entry) => entry.path.endsWith('settings.constraints[0]'));
    expect(error).toBeTruthy();
    expect(error.message).toContain('atom 9');
  });

  it('rejects a constraint whose atom count does not match its kind', () => {
    const result = validateProject(project({ constraints: [{ kind: 'bond', atoms: [1, 2, 3] }] }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((entry) => entry.message.includes('exactly 2 atom indices'))).toBe(true);
  });

  it('keeps constraints through save and load', () => {
    const constraints = [
      { kind: 'bond', atoms: [1, 2], value: 1.4 },
      { kind: 'freeze', atoms: [6], value: null },
    ];
    const result = validateProject(project({ constraints }));
    expect(result.ok).toBe(true);
    const node = result.project.flows[0].nodes[0];
    expect(node.settings.constraints).toEqual(constraints);
    // The canonical file carries them too, in key order.
    const saved = JSON.stringify(result.project);
    expect(saved).toContain('"constraints"');
  });
});
