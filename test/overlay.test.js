import { describe, expect, it } from 'vitest';
import { overlayPolyline, parseMeasuredSpectrum, scaleToSpectrum } from '../src/shared/overlay.js';

const CSV = [
  'wavenumber,intensity',
  '1600,0.10',
  '1650,0.45',
  '1700,1.00',
  '1750,0.30',
  '',
].join('\n');

describe('measured spectrum import', () => {
  it('reads a two-column CSV with a header', () => {
    const measured = parseMeasuredSpectrum(CSV);
    expect(measured.rows).toBe(4);
    expect(measured.skipped).toBe(1);
    expect(measured.points[0]).toEqual({ x: 1600, y: 0.1 });
    expect(measured.maxY).toBe(1);
  });

  it('accepts tabs, semicolons, single spaces and comments', () => {
    const text = '# measured on the FTIR\n1600\t0.1\n1650;0.45\n1700 1.0\n';
    const measured = parseMeasuredSpectrum(text);
    expect(measured.rows).toBe(3);
    expect(measured.points.map((point) => point.x)).toEqual([1600, 1650, 1700]);
  });

  it('sorts an unordered dump by the x column', () => {
    const measured = parseMeasuredSpectrum('1800 2\n1600 1\n1700 1.5\n');
    expect(measured.points.map((point) => point.x)).toEqual([1600, 1700, 1800]);
  });

  it('returns null when no row carries a pair of numbers', () => {
    expect(parseMeasuredSpectrum('energy\nonly one column\n')).toBeNull();
    expect(parseMeasuredSpectrum('')).toBeNull();
  });
});

describe('overlay scaling', () => {
  const measured = parseMeasuredSpectrum(CSV);

  it('reports the factor it applied, rather than rescaling silently', () => {
    const scaled = scaleToSpectrum(measured, { peakIntensity: 1 });
    expect(scaled.scale).toBeCloseTo(1, 9);
    const tall = parseMeasuredSpectrum('1600 10\n1700 42\n');
    const rescaled = scaleToSpectrum(tall, { peakIntensity: 1 });
    expect(rescaled.scale).toBeCloseTo(1 / 42, 9);
    expect(Math.max(...rescaled.points.map((point) => point.y))).toBeCloseTo(1, 9);
  });

  it('draws inside the axis box it is given', () => {
    const scaled = scaleToSpectrum(measured, { peakIntensity: 1 });
    const points = overlayPolyline(scaled, { minX: 1500, maxX: 1900, maxY: 1 }).split(' ');
    expect(points).toHaveLength(4);
    for (const point of points) {
      const [x, y] = point.split(',').map(Number);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(100);
    }
  });

  it('clips points outside the axis instead of drawing off-canvas', () => {
    const wide = parseMeasuredSpectrum('100 5\n3000 9\n');
    const points = overlayPolyline(scaleToSpectrum(wide), { minX: 1500, maxX: 2000, maxY: 9 }).split(' ');
    for (const point of points) {
      const [x] = point.split(',').map(Number);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
    }
  });

  it('returns null for an empty series', () => {
    expect(scaleToSpectrum(null)).toBeNull();
    expect(overlayPolyline(null, { minX: 0, maxX: 1, maxY: 1 })).toBe('');
  });
});
