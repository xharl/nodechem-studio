import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseValidationCases, validationMatrix } from '../src/shared/validationMatrix.js';

const root = path.resolve(__dirname, '..');
const pyscf = process.env.NCS_PYSCF_PYTHON || '';
const temporary = [];

afterEach(() => {
  while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true });
});

function workdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncs-validation-'));
  temporary.push(dir);
  return dir;
}

describe.skipIf(!pyscf)('live validation harness (#230)', () => {
  it('runs a PySCF ladder over a case and tabulates the result', () => {
    const dir = workdir();
    const stdout = execFileSync(process.execPath, [
      'bin/ncs.js', 'validation', 'test/fixtures/validation/live-water.json',
      '--run', '--executable', pyscf, '--work', dir, '--json',
    ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const matrix = JSON.parse(stdout);
    expect(matrix.cases).toHaveLength(1);
    expect(matrix.aggregate.n).toBe(2);
    expect(matrix.liveRuns).toHaveLength(2);
    expect(matrix.liveRuns.every((run) => run.status === 'computed')).toBe(true);
    expect(matrix.liveRuns[0].energyHartree).toBeLessThan(-70);
    expect(fs.existsSync(matrix.liveRuns[0].runDir)).toBe(true);
  });

  it('keeps a case without a molecule as not computed with a reason', () => {
    const dir = workdir();
    const cases = {
      schemaVersion: 1,
      cases: [{
        id: 'no-geometry',
        reference: -1,
        rungs: [
          { label: 'HF', method: 'HF', basis: 'STO-3G' },
          { label: 'B3LYP', method: 'B3LYP', basis: 'STO-3G' },
        ],
      }],
    };
    const file = path.join(dir, 'cases.json');
    fs.writeFileSync(file, JSON.stringify(cases));
    const stdout = execFileSync(process.execPath, [
      'bin/ncs.js', 'validation', file,
      '--run', '--executable', pyscf, '--work', path.join(dir, 'work'), '--json',
    ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const matrix = JSON.parse(stdout);
    expect(matrix.aggregate.n).toBe(0);
    expect(matrix.liveRuns.every((run) => run.status === 'not computed')).toBe(true);
    expect(matrix.liveRuns[0].reason).toMatch(/no molecule/);
  });
});

describe('validation case molecule preservation', () => {
  it('keeps an optional molecule on the parsed case', () => {
    const parsed = parseValidationCases({
      schemaVersion: 1,
      cases: [{
        id: 'water',
        reference: -76,
        molecule: { charge: 0, multiplicity: 1, coords: [{ element: 'O', x: 0, y: 0, z: 0 }] },
        rungs: [{ label: 'HF', energyHartree: -75 }, { label: 'DFT', energyHartree: -76 }],
      }],
    });
    expect(parsed.cases[0].molecule.coords).toHaveLength(1);
    const matrix = validationMatrix(parsed);
    expect(matrix.cases[0].spreadKcal).toBeCloseTo(627.5094740631, 4);
  });
});
