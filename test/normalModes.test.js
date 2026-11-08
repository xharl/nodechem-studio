import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { animatableModes, parseNormalModes } from '../src/shared/normalModes.js';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { NO_MODES_NOTICE, describeModes, modeFrame } from '../src/renderer/structureViewer.js';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/real/${name}`, import.meta.url)), 'utf8');

describe('normal-mode parsing on a real frequency job', () => {
  const parsed = parseGaussianOutput(fixture('g16-dvb-ir.out'));

  it('reads every mode, every atom and no incomplete block', () => {
    // `frequencies` and `irIntensities` are the full printed table, index
    // aligned, so a converter can pair a mode with its intensity (#99).
    expect(parsed.normalModesMeta).toMatchObject({ modeCount: 54, incomplete: 0, atomCount: 20 });
    expect(parsed.normalModesMeta.frequencies).toHaveLength(54);
    expect(parsed.normalModesMeta.irIntensities).toHaveLength(54);
    expect(parsed.normalModes.frequencies).toHaveLength(54);
    expect(parsed.normalModes.displacements).toHaveLength(54);
    expect(parsed.normalModes.displacements[0]).toHaveLength(20);
  });

  it('keeps the printed frequencies in order', () => {
    const { frequencies } = parsed.normalModes;
    expect(frequencies.slice(0, 5)).toEqual([53.1981, 84.7415, 149.4005, 179.3403, 263.3734]);
    expect(frequencies[frequencies.length - 1]).toBeCloseTo(3548.332, 3);
  });

  it('does not collapse the three components into one number', () => {
    const mode = parsed.normalModes.displacements[0];
    const unique = new Set(mode.map((vector) => `${vector.x},${vector.y},${vector.z}`));
    expect(unique.size).toBeGreaterThanOrEqual(6);
    const peak = Math.max(...mode.map((vector) => Math.hypot(vector.x, vector.y, vector.z)));
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThan(1.5);
  });

  it('produces vectors the viewer accepts', () => {
    const modes = describeModes(parsed.normalModes, 20);
    expect(modes.available).toBe(true);
    expect(modes.frequencies).toHaveLength(54);
    expect(modes.atomCount).toBe(20);
  });

  it('moves the largest atom by exactly the stated amplitude', () => {
    const modes = describeModes(parsed.normalModes, 20);
    for (const amplitude of [0.2, 0.6, 1.0]) {
      const frame = modeFrame(modes, 0, Math.PI / 2, amplitude);
      const peak = Math.max(...frame.map((vector) => Math.hypot(vector.x, vector.y, vector.z)));
      expect(peak).toBeCloseTo(amplitude, 9);
    }
  });
});

describe('honest absence', () => {
  it('returns null for a job with no frequency analysis', () => {
    const parsed = parseGaussianOutput(fixture('g16-dvb-sp.out'));
    expect(parsed.normalModes).toBeNull();
    expect(parsed.normalModesMeta).toBeNull();
    expect(describeModes(null, 20).notice).toBe(NO_MODES_NOTICE);
  });

  it('drops a block whose rows do not cover every mode', () => {
    // A real Gaussian 16 A.03 log prints `Atom AN  X Y Z`, not the G09
    // `Coord Atom Element:` table, so the break has to happen in that shape.
    const complete = fixture('g16-a03-water-optfreq.out');
    const lines = complete.split('\n');
    const header = lines.findIndex((line) => /^\s*Atom\s+AN\b/.test(line));
    // Remove the displacement rows of the first block, leaving its frequencies.
    const broken = [...lines.slice(0, header + 1), ...lines.slice(header + 4)].join('\n');
    const parsed = parseNormalModes(broken);
    expect(parsed).not.toBeNull();
    expect(parsed.incomplete).toBeGreaterThan(0);
    // A log with one block loses every vector when that block is cut, so the
    // honest outcome is either "fewer animatable modes" or "none at all".
    const animatable = animatableModes(parsed);
    if (animatable) {
      expect(animatable.frequencies.length).toBeLessThan(parsed.modeCount);
    } else {
      expect(parsed.incomplete).toBe(parsed.modeCount);
    }
  });
});
