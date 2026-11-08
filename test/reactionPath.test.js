import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  eyringRate,
  parseIrcSummary,
  parseScanSummary,
  pathBarrier,
  profilePoints,
  profileSvg,
} from '../src/shared/reactionPath.js';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url)), 'utf8');

const ircText = read('real/irc-summary.log');
const relaxedText = read('real/scan-relaxed.log');
const unrelaxedText = read('real/scan-unrelaxed.log');

describe('IRC summary (real Gaussian 16 log)', () => {
  const irc = parseIrcSummary(ircText);

  it('reads the reference energy and every point', () => {
    expect(irc).not.toBeNull();
    expect(irc.kind).toBe('irc');
    expect(irc.referenceHartree).toBeCloseTo(-797.920071, 6);
    expect(irc.points).toHaveLength(19);
    expect(irc.pointCount).toBe(18);
    expect(irc.gradientCalculations).toBe(19);
    expect(irc.hessianCalculations).toBe(19);
  });

  it('keeps the printed relative energy and the recovered absolute energy', () => {
    const first = irc.points[0];
    expect(first.point).toBe(1);
    expect(first.relativeHartree).toBeCloseTo(-0.00005, 8);
    expect(first.energyHartree).toBeCloseTo(-797.920121, 6);
    expect(first.rxCoord).toBeCloseTo(-1.23078, 5);
    expect(irc.points.at(-1).rxCoord).toBeCloseTo(0.98454, 5);
  });

  it('reports the highest computed point as a potential-energy barrier', () => {
    const barrier = pathBarrier(irc);
    expect(barrier.kind).toBe('potential-energy');
    expect(barrier.points).toBe(19);
    expect(barrier.maxKcal).toBeGreaterThan(0);
    expect(barrier.maxKcal).toBeCloseTo(0.0314, 3);
  });

  it('returns null when the job printed no path', () => {
    expect(parseIrcSummary('nothing here')).toBeNull();
    expect(parseIrcSummary('')).toBeNull();
  });
});

describe('relaxed scan (real Gaussian 09 log)', () => {
  const scan = parseScanSummary(relaxedText);

  it('reads the parameter names and all eleven points across column groups', () => {
    expect(scan.kind).toBe('relaxed');
    expect(scan.parameterNames).toEqual(['R1', 'R2', 'A1', 'A2']);
    expect(scan.points).toHaveLength(11);
    expect(scan.pointCount).toBe(11);
    expect(scan.points[0].energyHartree).toBeCloseTo(-187.49666, 6);
    expect(scan.points[9].energyHartree).toBeCloseTo(-187.50211, 6);
  });

  it('keeps each point’s scanned parameters', () => {
    expect(scan.points[0].parameters.R1).toBeCloseTo(1.1, 6);
    expect(scan.points[10].parameters.R1).toBeCloseTo(1.11, 6);
    expect(scan.points[0].parameters.A2).toBeCloseTo(180, 6);
  });

  it('profiles relative to the lowest point', () => {
    const points = profilePoints(scan);
    expect(points[0].relativeKcal).toBeCloseTo(3.6396, 3);
    expect(Math.min(...points.map((point) => point.relativeKcal))).toBeCloseTo(0, 9);
  });
});

describe('unrelaxed scan (real Gaussian 16 log)', () => {
  const scan = parseScanSummary(unrelaxedText);

  it('reads the coordinate and SCF energy of every row', () => {
    expect(scan.kind).toBe('unrelaxed');
    expect(scan.parameterNames).toEqual(['D7']);
    expect(scan.points).toHaveLength(13);
    expect(scan.points[0].parameters.D7).toBeCloseTo(-180, 6);
    expect(scan.points[0].energyHartree).toBeCloseTo(-382.29428, 6);
    expect(scan.points[6].energyHartree).toBeCloseTo(-378.37701, 6);
  });

  it('finds the barrier at the eclipsed geometry', () => {
    const barrier = pathBarrier(scan);
    expect(barrier.point).toBe(7);
    expect(barrier.maxKcal).toBeCloseTo(2458.12, 1);
  });
});

describe('reaction records in a parsed output', () => {
  it('exposes the IRC and scan records at the root and null when absent', () => {
    const withIrc = parseGaussianOutput(ircText);
    expect(withIrc.reactionPath).not.toBeNull();
    expect(withIrc.scan).toBeNull();
    const plain = parseGaussianOutput(' Normal termination of Gaussian 16 at Thu Jan  1 00:00:00 2026.');
    expect(plain.reactionPath).toBeNull();
    expect(plain.scan).toBeNull();
  });
});

describe('helpers', () => {
  it('renders a self-contained profile figure', () => {
    const svg = profileSvg(parseScanSummary(relaxedText));
    expect(svg.startsWith('<figure')).toBe(true);
    expect(svg).toContain('<svg');
    expect(svg).toContain('spectrum-curve');
    expect(svg).not.toMatch(/<script|https?:\/\//i);
    expect(profileSvg(null)).toBe('');
  });

  it('computes an Eyring rate and refuses invalid input', () => {
    const rate = eyringRate({ deltaGkcal: 20, temperatureKelvin: 298.15 });
    // 20 kcal/mol at 298 K is a slow but not absurd unimolecular rate.
    expect(rate).toBeGreaterThan(1e-2);
    expect(rate).toBeLessThan(1);
    expect(eyringRate({ deltaGkcal: 0 })).toBeGreaterThan(1e12);
    expect(eyringRate({ deltaGkcal: Number.NaN })).toBeNull();
    expect(eyringRate({ deltaGkcal: 20, temperatureKelvin: 0 })).toBeNull();
  });
});
