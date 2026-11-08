import { describe, expect, it } from 'vitest';

import {
  FIGURE_KINDS, contourFigure, convergenceFigure, correlationFigure, figure, flowGraphFigure,
  marchingSquares, orbitalLevelsFigure, reactionEnergyFigure, sliceOf, spectrumFigure,
} from '../src/shared/figures/index.js';
import { fromNmr, fromRaman, fromUvVis, fromVcd } from '../src/shared/figures/spectra.js';
import { niceTicks, scaleLinear } from '../src/shared/figures/primitives.js';
import { surfaceFigure } from '../src/shared/figures/surface.js';

/**
 * Figures are claims, so they are tested like claims: the same bytes twice, no
 * external reference, an accessible name, and the plot conventions a chemist
 * would notice if they were reversed.
 */

/**
 * A figure may name exactly one URL — the SVG namespace, which is an
 * identifier, not a fetch — and nothing else that could reach the network.
 */
const noExternal = (svg) => {
  expect(svg).not.toMatch(/<script/i);
  expect(svg).not.toMatch(/<img\b/i);
  expect(svg).not.toMatch(/\b(?:href|src)=/i);
  const withoutNamespace = svg.replace('xmlns="http://www.w3.org/2000/svg"', '');
  expect(withoutNamespace).not.toMatch(/https?:\/\//i);
  expect(svg).toContain('role="img"');
  expect(svg).toContain('<title>');
};

function syntheticVolume(n = 32) {
  const values = new Float64Array(n * n * n);
  for (let k = 0; k < n; k += 1) {
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const x = i - n / 2;
        const y = j - n / 2;
        const z = k - n / 2;
        values[(k * n + j) * n + i] = (x / 6) * Math.exp(-(x * x + y * y + z * z) / 120);
      }
    }
  }
  return { values, origin: [-4.8, -4.8, -4.8], step: [0.3, 0.3, 0.3], counts: [n, n, n] };
}

describe('figure primitives', () => {
  it('places ticks on a 1-2-5 grid inside the range', () => {
    const { ticks, step } = niceTicks(0, 10, 5);
    expect(step).toBe(2);
    expect(ticks).toEqual([0, 2, 4, 6, 8, 10]);
    const narrow = niceTicks(-76.42, -76.40, 4);
    expect(narrow.ticks.length).toBeGreaterThan(1);
    expect(narrow.ticks[0]).toBeGreaterThanOrEqual(-76.42);
  });

  it('maps a domain onto pixels in either direction', () => {
    const forward = scaleLinear([0, 10], [100, 200]);
    expect(forward(0)).toBe(100);
    expect(forward(10)).toBe(200);
    const reversed = scaleLinear([0, 10], [200, 100]);
    expect(reversed(0)).toBe(200);
  });
});

describe('spectrum figures', () => {
  it('is deterministic and self-contained', () => {
    const input = {
      kind: 'ir',
      curve: [{ x: 3200, y: 0.2 }, { x: 1600, y: 1 }],
      sticks: [{ x: 3200, height: 0.2 }, { x: 1600, height: 1, label: '1600' }],
      range: [4000, 400],
      fwhm: 'Lorentzian, FWHM 12 cm⁻¹',
    };
    const first = spectrumFigure(input);
    const second = spectrumFigure(input);
    expect(first.svg).toBe(second.svg);
    noExternal(first.svg);
    expect(first.caption).toContain('FWHM 12 cm⁻¹');
  });

  it('reads IR wavenumber from high to low, left to right', () => {
    const spec = spectrumFigure({
      kind: 'ir',
      curve: [],
      sticks: [{ x: 3000, height: 1 }, { x: 1000, height: 1 }],
      range: [4000, 400],
      fwhm: 'x',
    });
    // The sticks are the lines stroked in the soft series colour; their x is
    // the peak position, so a descending axis puts the 3000 cm⁻¹ stick left of
    // the 1000 cm⁻¹ one.
    const positions = [...spec.svg.matchAll(/<line x1="([\d.]+)"[^>]*stroke="#9db4ea"/g)]
      .map((match) => Number(match[1]));
    expect(positions).toHaveLength(2);
    expect(positions[0]).toBeLessThan(positions[1]);
  });

  it('draws a zero line and a negative lobe for a signed spectrum', () => {
    const spec = spectrumFigure({
      kind: 'vcd',
      curve: [{ x: 1500, y: -0.6 }, { x: 1200, y: 0.8 }],
      sticks: [{ x: 1500, height: -0.6 }, { x: 1200, height: 0.8 }],
      range: [1800, 900],
      fwhm: 'Lorentzian, FWHM 12 cm⁻¹',
    });
    expect(spec.svg).toContain('stroke-dasharray="3 3"');
    expect(spec.svg).toContain('#c0392b');
    expect(spec.params.signed).toBe(true);
  });

  it('adapts the existing UV-Vis, Raman, VCD and NMR spectrum objects', () => {
    const uv = fromUvVis({
      fwhmEv: 0.2,
      minWavelengthNm: 180,
      maxWavelengthNm: 320,
      points: [{ wavelengthNm: 320, relative: 0 }, { wavelengthNm: 220, relative: 1 }],
      states: [{ index: 1, wavelengthNm: 220, oscillatorStrength: 0.4 }],
    });
    expect(uv.caption).toContain('FWHM 0.20 eV');

    const raman = fromRaman({
      fwhmCm: 12, minCm: 900, maxCm: 1400, quantity: 'Raman activity',
      curve: [{ wavenumber: 900, intensity: 0 }, { wavenumber: 1400, intensity: 1 }],
      peaks: [{ wavenumber: 1400, ramanActivity: 10 }],
    });
    expect(raman).not.toBeNull();

    const vcd = fromVcd({
      fwhmCm: 12, minCm: 900, maxCm: 1800,
      curve: [{ wavenumber: 900, intensity: 0.2 }, { wavenumber: 1800, intensity: -0.9 }],
      peaks: [{ wavenumber: 1800, rotationalStrength: -12 }],
    });
    expect(vcd.caption).toContain('rotational strength');

    const nmr = fromNmr({
      nucleus: '1H', units: 'ppm shift', fwhmPpm: 0.1, minPpm: 0, maxPpm: 8,
      curve: [{ ppm: 0, intensity: 0 }, { ppm: 8, intensity: 1 }],
      peaks: [{ value: 7.2, element: 'H' }, { value: 3.4, element: 'H' }],
    });
    expect(nmr.caption).toContain('1H NMR');
  });
});

describe('orbital levels', () => {
  it('names the HOMO and LUMO and states the gap it computed', () => {
    const result = orbitalLevelsFigure({
      alpha: [
        { energyEv: -12.1, occupation: 2 },
        { energyEv: -10.4, occupation: 2 },
        { energyEv: -6.2, occupation: 0 },
        { energyEv: -1.1, occupation: 0 },
      ],
    });
    expect(result.svg).toContain('HOMO');
    expect(result.svg).toContain('LUMO');
    expect(result.caption).toContain('gap 4.20 eV');
    expect(result.params.gapEv).toBeCloseTo(4.2, 6);
    noExternal(result.svg);
  });

  it('converts Hartree input to eV rather than mixing units', () => {
    const result = orbitalLevelsFigure({
      alpha: [{ energyEh: -0.5, occupation: 2 }, { energyEh: -0.4, occupation: 0 }],
    });
    expect(result.caption).toContain('27.2114');
    expect(result.params.gapEv).toBeCloseTo(0.1 * 27.211386245988, 3);
  });

  it('returns null when no level has an energy', () => {
    expect(orbitalLevelsFigure({ alpha: [{ occupation: 2 }] })).toBeNull();
  });
});

describe('energy profile', () => {
  it('labels every stage and the barrier above the lowest point', () => {
    const result = reactionEnergyFigure({
      stages: [
        { label: 'R', energyEh: -76.4 },
        { label: 'TS1', energyEh: -76.36 },
        { label: 'P', energyEh: -76.42 },
      ],
    });
    expect(result.svg).toContain('TS1');
    expect(result.caption).toContain('3 stages');
    // 0.04 Eh above R and 0.06 Eh above P: the highest point is 0.06 Eh above
    // the lowest, which is 37.65 kcal/mol.
    expect(result.params.highestAboveLowestKcal).toBeCloseTo(0.06 * 627.5094740631, 3);
  });

  it('refuses a single stage', () => {
    expect(reactionEnergyFigure({ stages: [{ label: 'R', energyEh: -76.4 }] })).toBeNull();
  });
});

describe('convergence and correlation', () => {
  it('prints no threshold when none was given', () => {
    const result = convergenceFigure({ series: [{ x: 1, y: -76.40 }, { x: 2, y: -76.4189 }] });
    expect(result.caption).not.toContain('threshold');
  });

  it('draws the threshold it was given', () => {
    const result = convergenceFigure({
      series: [{ x: 1, y: -76.40 }, { x: 2, y: -76.4189 }], threshold: -76.4189,
    });
    expect(result.caption).toContain('threshold');
    expect(result.svg).toContain('stroke-dasharray="4 3"');
  });

  it('states N and the error statistics it computed', () => {
    const result = correlationFigure({
      points: [{ computed: 1.1, reference: 1.0 }, { computed: 2.0, reference: 2.0 }],
      units: 'eV',
    });
    expect(result.params.points).toBe(2);
    expect(result.params.rms).toBeCloseTo(Math.sqrt((0.01 + 0) / 2), 6);
    expect(result.caption).toContain('N = 2');
    expect(result.svg).toContain('y = x');
  });
});

describe('contour slice', () => {
  it('extracts a plane with the requested axis held', () => {
    const volume = syntheticVolume(16);
    const slice = sliceOf(volume, 'z', 8);
    expect(slice.width).toBe(16);
    expect(slice.height).toBe(16);
    expect(slice.labels).toEqual({ x: 'x', y: 'y' });
    expect(slice.planePositionA).toBeCloseTo(volume.origin[2] + volume.step[2] * 8, 6);
  });

  it('finds iso segments on a two-cell field', () => {
    // A 2×2 field with one corner above the iso: exactly two crossings.
    const segments = marchingSquares([1, 0, 0, 0], 2, 2, 0.5);
    expect(segments).toHaveLength(1);
    const ends = segments[0].map((point) => `${point[0]},${point[1]}`).sort();
    // Corner `a` (top left) is the only vertex above the iso, so the contour
    // crosses the top edge at (0.5, 0) and the left edge at (0, 0.5).
    expect(ends).toEqual(['0,0.5', '0.5,0']);
  });

  it('draws bands and iso lines with axes in Å and a bounded size', () => {
    const slice = sliceOf(syntheticVolume(40), 'z', 20);
    const result = contourFigure({ slice, field: 'ψ(HOMO)', units: 'au' });
    expect(result.svg).toContain('figure-contour');
    expect(result.svg).toMatch(/\/ Å/);
    expect(result.caption).toContain('range');
    expect(result.params.min).toBeLessThan(0);
    expect(result.params.max).toBeGreaterThan(0);
    expect(result.svg.length).toBeLessThan(120_000);
    noExternal(result.svg);
  });

  it('returns null for a degenerate slice', () => {
    expect(contourFigure({ slice: { values: new Float64Array(0), width: 0, height: 0 } })).toBeNull();
  });
});

describe('execution graph', () => {
  it('layer a chain left to right and name the statuses', () => {
    const result = flowGraphFigure({
      nodes: [
        { id: 'a', label: 'opt', status: 'passed' },
        { id: 'b', label: 'freq', status: 'passed' },
        { id: 'c', label: 'report', status: 'blocked' },
      ],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    });
    const xs = [...result.svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="116"/g)].map((m) => Number(m[1]));
    expect(xs).toHaveLength(3);
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    expect(result.caption).toContain('2 passed');
    expect(result.caption).toContain('1 blocked');
  });
});

describe('registry', () => {
  it('every advertised kind builds or returns null, never throws', () => {
    for (const kind of FIGURE_KINDS) {
      expect(() => figure(kind, {})).not.toThrow();
    }
  });

  it('rejects an unknown kind by name', () => {
    expect(() => figure('hologram', {})).toThrow(/unknown figure kind: hologram/);
  });
});

describe('projected isosurface', () => {
  /** A closed octahedron as two lobes, so both colours are exercised. */
  function octahedron(offset, sign) {
    const v = [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    ].map((p) => p.map((c) => c + offset));
    const faces = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
    const positions = new Float32Array(faces.length * 9);
    const normals = new Float32Array(faces.length * 9);
    faces.forEach((face, index) => {
      face.forEach((corner, slot) => {
        const p = v[corner];
        positions.set(p, index * 9 + slot * 3);
        normals.set(p.map((c) => c - offset), index * 9 + slot * 3);
      });
    });
    return { positions, normals, sign };
  }

  it('draws one path per shading band and both phases', () => {
    const result = surfaceFigure({
      meshes: [octahedron(0.5, 1), octahedron(-0.5, -1)],
      iso: 0.02,
    });
    expect(result).not.toBeNull();
    expect(result.params.triangles).toBe(16);
    const paths = result.svg.match(/<path d="/g) || [];
    expect(paths.length).toBeGreaterThan(0);
    // Positive lobes are blue, negative red: both must be present.
    expect(result.svg).toMatch(/fill="#[0-9a-f]{6}"/);
    expect(result.caption).toContain('iso 0.020 au');
    expect(result.caption).toContain('16 triangles');
    noExternal(result.svg);
  });

  it('is deterministic and refuses more triangles than it can draw', () => {
    const meshes = [octahedron(0, 1)];
    const a = surfaceFigure({ meshes });
    const b = surfaceFigure({ meshes });
    expect(a.svg).toBe(b.svg);
    expect(surfaceFigure({ meshes, maxTriangles: 4 })).toBeNull();
  });
});
