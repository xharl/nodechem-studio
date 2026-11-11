import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyGeometryHandoff, applyGeometryHandoffFor, readUpstreamGeometry } from '../electron/runner/geometryHandoff.js';
import { buildPsi4Input } from '../src/shared/engines/psi4.js';
import { buildOrcaInput } from '../src/shared/engines/orca.js';
import { buildXtbInput } from '../src/shared/engines/xtb.js';

const INPUT = [
  '%Chk=sp.chk',
  '#p B3LYP/def2TZVP EmpiricalDispersion=GD3BJ SP',
  '',
  'Single point',
  '',
  '0 1',
  'O    0.000000    0.000000    0.000000',
  'H    0.960000    0.000000    0.000000',
  'H   -0.240000    0.930000    0.000000',
  '',
  '',
].join('\n');

const workdirs = [];
const runDirWith = (record) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ncs-handoff-'));
  workdirs.push(dir);
  writeFileSync(path.join(dir, 'run.json'), JSON.stringify(record), 'utf8');
  return dir;
};

afterEach(() => {
  for (const dir of workdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('geometry hand-off across engines', () => {
  it('reads the parsed final geometry from the finished run, not the input echo', async () => {
    const dir = runDirWith({
      parsed: {
        finalGeometry: {
          source: 'xtbopt.xyz',
          atoms: [
            { element: 'O', x: 0.11, y: -0.22, z: 0.33 },
            { element: 'H', x: 1.02, y: 0.05, z: 0.01 },
            { element: 'H', x: -0.19, y: 0.88, z: 0.07 },
          ],
        },
      },
    });
    const atoms = await readUpstreamGeometry(dir);
    expect(atoms).toHaveLength(3);
    const next = applyGeometryHandoff(INPUT, atoms);
    // The optimised numbers replaced the planned ones.
    expect(next).toMatch(/O\s+0\.110000/);
    expect(next).not.toContain('0.960000');
    // The route is untouched.
    expect(next).toContain('B3LYP/def2TZVP EmpiricalDispersion=GD3BJ SP');
  });

  it('returns null when the run recorded no geometry', async () => {
    const dir = runDirWith({ parsed: { finalEnergy: { hartree: -5.07 } } });
    expect(await readUpstreamGeometry(dir)).toBeNull();
  });

  it('rejects a malformed geometry rather than handing over NaNs', async () => {
    const dir = runDirWith({ parsed: { finalGeometry: { atoms: [{ element: 'O', x: 'nope' }] } } });
    expect(await readUpstreamGeometry(dir)).toBeNull();
  });

  it('returns null for a missing run folder', async () => {
    expect(await readUpstreamGeometry(path.join(tmpdir(), 'definitely-not-a-run-folder'))).toBeNull();
    expect(await readUpstreamGeometry('')).toBeNull();
  });
});

/**
 * Issue 326 — the hand-off used to be dropped for Psi4, ORCA and xTB.
 *
 * `applyGeometryHandoffFor` returned the deck unchanged for those three, the task
 * ran the *planned* geometry, and the queue recorded a `geometryHandoff` of N
 * atoms anyway. These tests build each deck with the real builder, hand over a
 * geometry displaced by an "optimisation", and assert the deck changed.
 */
describe('every engine takes the handed-over geometry (issue 326)', () => {
  const PLANNED = {
    charge: 0,
    multiplicity: 1,
    coords: [
      { element: 'C', x: 0, y: 0, z: 0 },
      { element: 'O', x: 1.43, y: 0, z: 0 },
      { element: 'H', x: -0.36, y: 1.02, z: 0 },
      { element: 'H', x: -0.36, y: -0.51, z: 0.88 },
    ],
  };
  const settings = { method: 'B3LYP', basis: 'def2-SVP', jobType: 'SP', charge: 0, multiplicity: 1 };

  /** The geometry xTB actually produced in the issue's reproduction. */
  const OPTIMISED = [
    { element: 'C', x: 0.017298, y: 0.012945, z: 0.0 },
    { element: 'O', x: 1.430053, y: -0.015428, z: 0.0 },
    { element: 'H', x: -0.380311, y: 1.0279, z: 0.0 },
    { element: 'H', x: -0.350849, y: -0.507883, z: 0.888095 },
  ];

  it('rewrites a Psi4 molecule block and keeps the rest of the deck', () => {
    const text = buildPsi4Input({ molecule: PLANNED, settings, inputName: 'sp.dat' }).inputText;
    expect(text).toContain('  1.430000');

    const next = applyGeometryHandoffFor('psi4', text, OPTIMISED);
    expect(next).not.toBe(text);
    // The numbers are the optimised ones, and 1.430000 is gone.
    expect(next).toContain('1.430053');
    expect(next).not.toContain('1.430000');
    // Charge/multiplicity and the closing brace survive, and nothing else moved.
    expect(next).toContain('molecule {');
    expect(next).toMatch(/^0 1$/m);
    expect(next.split('}').length).toBe(text.split('}').length);
    expect(next.split('molecule {').length).toBe(text.split('molecule {').length);
  });

  it('keeps Psi4 fragment separators where they were', () => {
    const dimer = {
      charge: 0,
      multiplicity: 1,
      coords: [
        { element: 'O', x: 0, y: 0, z: 0, fragment: 1 },
        { element: 'H', x: 0.96, y: 0, z: 0.02, fragment: 1 },
        { element: 'O', x: 3.2, y: 0, z: 0, fragment: 2 },
        { element: 'H', x: 4.16, y: 0, z: 0.02, fragment: 2 },
      ],
    };
    const text = buildPsi4Input({ molecule: dimer, settings: { ...settings, method: 'SAPT0' }, inputName: 'sapt.dat' }).inputText;
    const body = text.slice(text.indexOf('molecule {'));
    expect(body).toContain('--');

    const moved = dimer.coords.map((atom) => ({ ...atom, y: atom.y + 0.01 }));
    const next = applyGeometryHandoffFor('psi4', text, moved);
    expect(next.split('\n').filter((line) => line.trim() === '--')).toHaveLength(1);
    // The separation stays between atom 2 and atom 3, with the monomer's own
    // charge line still on the far side of it.
    const rows = next.slice(next.indexOf('molecule {')).split('\n');
    const marker = rows.findIndex((line) => line.trim() === '--');
    expect(rows[marker - 1]).toMatch(/H/);
    expect(rows[marker + 1]).toBe('0 1');
    expect(rows[marker + 2]).toMatch(/O/);
  });

  it('rewrites an ORCA * xyz block', () => {
    const text = buildOrcaInput({ molecule: PLANNED, settings, inputName: 'sp.inp' }).inputText;
    expect(text).toMatch(/^\* xyz 0 1$/m);
    expect(text).toContain('1.430000');

    const next = applyGeometryHandoffFor('orca', text, OPTIMISED);
    expect(next).toContain('1.430053');
    expect(next).not.toContain('1.430000');
    // The header and the closing `*` are untouched.
    expect(next).toMatch(/^\* xyz 0 1$/m);
    expect(next.split('\n').filter((line) => line.trim() === '*')).toHaveLength(text.split('\n').filter((line) => line.trim() === '*').length);
  });

  it('rewrites an xTB .xyz deck, keeping the comment line', () => {
    const text = buildXtbInput({ molecule: PLANNED, settings, inputName: 'task.xyz' }).inputText;
    const lines = text.split('\n');
    expect(lines[0].trim()).toBe('4');

    const next = applyGeometryHandoffFor('xtb', text, OPTIMISED);
    const nextLines = next.split('\n');
    expect(nextLines[0].trim()).toBe('4');
    expect(nextLines[1]).toBe(lines[1]);
    expect(nextLines[2]).toContain('0.017298');
    expect(next).not.toContain('1.430000');
  });

  it('refuses a deck it cannot rewrite instead of returning it unchanged', () => {
    // No molecule block, no `* xyz`, and a Gaussian route without atoms.
    expect(() => applyGeometryHandoffFor('psi4', 'set basis def2-svp\n', OPTIMISED)).toThrow(/no `molecule \{` block/);
    expect(() => applyGeometryHandoffFor('orca', '! B3LYP def2-SVP\n', OPTIMISED)).toThrow(/no `\* xyz` block/);
    expect(() => applyGeometryHandoffFor('gaussian', '#p B3LYP/def2SVP SP\n', OPTIMISED)).toThrow();
    // An unknown engine is a refusal too, never a silent pass-through.
    expect(() => applyGeometryHandoffFor('nwchem', 'anything', OPTIMISED)).toThrow(/No geometry rewrite/);
  });

  it('rejects a geometry with a bad atom instead of writing it', () => {
    const text = buildOrcaInput({ molecule: PLANNED, settings, inputName: 'sp.inp' }).inputText;
    expect(() => applyGeometryHandoffFor('orca', text, [{ element: 'C', x: 'nope', y: 0, z: 0 }]))
      .toThrow(/Atom 1 x is not a number/);
    expect(() => applyGeometryHandoffFor('orca', text, [])).toThrow(/No atoms were supplied/);
  });
});
