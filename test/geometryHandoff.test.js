import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyGeometryHandoff, readUpstreamGeometry } from '../electron/runner/geometryHandoff.js';

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
