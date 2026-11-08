import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';

/**
 * What a real Gaussian 16 **A.03** (Windows) log looks like.
 *
 * These two files came out of this app: the routes were written by the builder,
 * run by G16 A.03 on a licensed Windows box, and parsed by the record reader.
 * They are the corpus the older fixtures could not be — `g16-dvb-ir.out` carries
 * both a G09-shaped displacement table and a G16 one, so a parser tuned to the
 * G09 half passes the suite while failing on every real G16 frequency job.
 */
const OPtFREQ = readFileSync('test/fixtures/real/g16-a03-water-optfreq.out', 'utf8');
const SP = readFileSync('test/fixtures/real/g16-a03-water-sp.out', 'utf8');

describe('Gaussian 16 A.03 — real logs produced by this app', () => {
  it('reads the single-point energy and the termination', () => {
    const parsed = parseGaussianOutput(SP);
    expect(parsed.program.name).toBe('Gaussian');
    expect(parsed.program.version).toBe('16');
    expect(parsed.program.revision).toBe('A.03');
    expect(parsed.termination).toBe('Normal termination of Gaussian');
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-76.4093047918, 9);
    expect(parsed.scf.cycles).toBe(9);
  });

  it('keeps every atom of every optimisation frame', () => {
    const parsed = parseGaussianOutput(OPtFREQ);
    expect(parsed.trajectory.count).toBe(5);
    for (const step of parsed.trajectory.steps) {
      expect(step.atoms).toHaveLength(3);
      expect(step.atoms[0].element).toBe('O');
      expect(step.atoms.map((atom) => atom.element)).toEqual(['O', 'H', 'H']);
    }
    // A frame that starts at the second atom is the signature of the old
    // `cursor += 2` skip: O and the first H were missing.
    expect(parsed.trajectory.steps[0].atoms[2].x).toBeCloseTo(0, 3);
  });

  it('reads the G16 displacement table (`Atom AN …`) and its intensities', () => {
    const parsed = parseGaussianOutput(OPtFREQ);
    expect(parsed.normalModesMeta.modeCount).toBe(3);
    expect(parsed.normalModesMeta.atomCount).toBe(3);
    expect(parsed.normalModesMeta.incomplete).toBe(0);
    expect(parsed.normalModesMeta.irIntensities[0]).toBeCloseTo(75.6976, 4);
    expect(parsed.frequencies.count).toBe(3);
    expect(parsed.frequencies.imaginaryCount).toBe(0);
  });

  it('does not double the mode list when a log prints both layouts', () => {
    // The older fixture contains the same 54 modes twice, once in each shape.
    const hybrid = parseGaussianOutput(readFileSync('test/fixtures/real/g16-dvb-ir.out', 'utf8'));
    expect(hybrid.normalModesMeta.modeCount).toBe(54);
    expect(hybrid.normalModesMeta.atomCount).toBe(20);
  });
});
