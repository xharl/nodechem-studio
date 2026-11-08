import { describe, expect, it } from 'vitest';
import {
  MarchingCubesError,
  extractSurface,
  meshVolume,
  toStlBinary,
} from '../src/shared/marchingCubes.js';
import { evaluateOrbital, gridFor } from '../src/shared/volume.js';

/**
 * A synthetic field with a known answer: f = R − r is positive inside a sphere
 * of radius R, so the iso-0 surface is that sphere. Every property below has an
 * exact value to compare against, which is the only way to tell a correct mesh
 * from a plausible one.
 */
function sphereField({ radius = 2, step = 0.25, half = 3 } = {}) {
  const n = Math.round((2 * half) / step) + 1;
  const origin = [-half, -half, -half];
  const values = new Float32Array(n * n * n);
  for (let k = 0; k < n; k += 1) {
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const x = origin[0] + i * step;
        const y = origin[1] + j * step;
        const z = origin[2] + k * step;
        values[i + n * (j + n * k)] = radius - Math.hypot(x, y, z);
      }
    }
  }
  return { field: { values, dims: [n, n, n], origin, step }, radius, step };
}

/** Undirected edge → how many triangles use it. */
function edgeUse(mesh) {
  const key = (at) => `${mesh.positions[at].toFixed(4)},${mesh.positions[at + 1].toFixed(4)},${mesh.positions[at + 2].toFixed(4)}`;
  const counts = new Map();
  for (let triangle = 0; triangle < mesh.triangleCount; triangle += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const a = (triangle * 3 + corner) * 3;
      const b = (triangle * 3 + ((corner + 1) % 3)) * 3;
      const first = key(a);
      const second = key(b);
      const edge = first < second ? `${first}|${second}` : `${second}|${first}`;
      counts.set(edge, (counts.get(edge) ?? 0) + 1);
    }
  }
  return counts;
}

describe('a sphere', () => {
  const { field, radius, step } = sphereField();
  const mesh = extractSurface(field, 0);

  it('produces triangles, and enough of them to cover the sphere', () => {
    expect(mesh.triangleCount).toBeGreaterThan(1000);
    expect(mesh.positions.length).toBe(mesh.triangleCount * 9);
    expect(mesh.normals.length).toBe(mesh.positions.length);
    expect(mesh.vertexCount).toBe(mesh.triangleCount * 3);
  });

  it('puts every vertex within one cell of the analytic radius', () => {
    let worst = 0;
    for (let at = 0; at < mesh.positions.length; at += 3) {
      const r = Math.hypot(mesh.positions[at], mesh.positions[at + 1], mesh.positions[at + 2]);
      worst = Math.max(worst, Math.abs(r - radius));
    }
    expect(worst).toBeLessThan(step);
    // Linear interpolation on a 0.25 Å grid is far better than the bound.
    expect(worst).toBeLessThan(step / 8);
  });

  it('points the normals outward, from the gradient rather than the winding', () => {
    let outward = 0;
    for (let at = 0; at < mesh.normals.length; at += 3) {
      const dot = mesh.normals[at] * mesh.positions[at]
        + mesh.normals[at + 1] * mesh.positions[at + 1]
        + mesh.normals[at + 2] * mesh.positions[at + 2];
      if (dot > 0) outward += 1;
      // Unit length: a zero or unnormalised normal renders as a black facet.
      expect(Math.hypot(mesh.normals[at], mesh.normals[at + 1], mesh.normals[at + 2])).toBeCloseTo(1, 5);
    }
    expect(outward / mesh.vertexCount).toBeGreaterThanOrEqual(0.999);
  });

  it('is closed: every edge is shared by exactly two triangles', () => {
    const counts = edgeUse(mesh);
    expect(counts.size).toBe((mesh.triangleCount * 3) / 2);
    const strays = [...counts.values()].filter((count) => count !== 2);
    expect(strays).toEqual([]);
  });

  it('encloses the analytic volume to within a few per cent', () => {
    const analytic = (4 / 3) * Math.PI * radius ** 3;
    expect(meshVolume(mesh)).toBeGreaterThan(analytic * 0.97);
    expect(meshVolume(mesh)).toBeLessThan(analytic * 1.03);
  });

  it('reports the box the surface occupies', () => {
    expect(mesh.bounds.min[0]).toBeCloseTo(-radius, 1);
    expect(mesh.bounds.max[0]).toBeCloseTo(radius, 1);
    expect(mesh.iso).toBe(0);
    expect(mesh.sign).toBe(1);
  });
});

describe('a sign-changing field, as an orbital has', () => {
  const atoms = [{ element: 'H', x: 0, y: 0, z: 0 }];
  const grid = gridFor(atoms, { spacing: 0.2, padding: 2.4 });
  const values = evaluateOrbital({
    shells: [{ atom: 1, type: 1, primitives: [{ exponent: 0.8, s: 1 }] }],
    coefficients: [1, 0, 0],
    grid,
  });
  const field = {
    values,
    dims: grid.counts,
    origin: grid.origin,
    step: grid.step,
  };

  it('gives two separate closed lobes at ±isovalue', () => {
    const positive = extractSurface(field, 0.02);
    const negative = extractSurface(field, -0.02);
    expect(positive.triangleCount).toBeGreaterThan(0);
    expect(negative.triangleCount).toBeGreaterThan(0);
    for (const mesh of [positive, negative]) {
      const strays = [...edgeUse(mesh).values()].filter((count) => count !== 2);
      expect(strays).toEqual([]);
      // Unit normals everywhere, so the two phases render consistently.
      for (let at = 0; at < mesh.normals.length; at += 3) {
        expect(Math.hypot(mesh.normals[at], mesh.normals[at + 1], mesh.normals[at + 2])).toBeCloseTo(1, 5);
      }
    }
  });

  it('points the positive lobe\'s normals away from +x and the negative lobe\'s away from −x', () => {
    const positive = extractSurface(field, 0.02);
    const negative = extractSurface(field, -0.02);
    const centre = (mesh) => {
      const sum = [0, 0, 0];
      for (let at = 0; at < mesh.positions.length; at += 3) {
        for (let axis = 0; axis < 3; axis += 1) sum[axis] += mesh.positions[at + axis];
      }
      return sum.map((value) => value / (mesh.positions.length / 3));
    };
    const positiveCentre = centre(positive);
    const negativeCentre = centre(negative);
    expect(positiveCentre[0]).toBeGreaterThan(0.2);
    expect(negativeCentre[0]).toBeLessThan(-0.2);

    for (const [mesh, lobeCentre] of [[positive, positiveCentre], [negative, negativeCentre]]) {
      let outward = 0;
      for (let at = 0; at < mesh.positions.length; at += 3) {
        const dot = mesh.normals[at] * (mesh.positions[at] - lobeCentre[0])
          + mesh.normals[at + 1] * (mesh.positions[at + 1] - lobeCentre[1])
          + mesh.normals[at + 2] * (mesh.positions[at + 2] - lobeCentre[2]);
        if (dot > 0) outward += 1;
      }
      expect(outward / mesh.vertexCount).toBeGreaterThanOrEqual(0.99);
    }
  });

  it('has no surface at all when the isovalue is above the field maximum', () => {
    const empty = extractSurface(field, 10);
    expect(empty.triangleCount).toBe(0);
    expect(empty.positions).toHaveLength(0);
    expect(empty.bounds).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
  });
});

describe('binary STL', () => {
  const { field } = sphereField({ radius: 1.5, step: 0.3 });
  const mesh = extractSurface(field, 0);

  it('writes the 80-byte header, the count and 50 bytes per facet', () => {
    const buffer = toStlBinary(mesh, { header: 'unit test' });
    expect(buffer.byteLength).toBe(84 + mesh.triangleCount * 50);
    const view = new DataView(buffer);
    expect(view.getUint32(80, true)).toBe(mesh.triangleCount);
    expect(new Uint8Array(buffer).subarray(0, 9).reduce((text, byte) => text + String.fromCharCode(byte), ''))
      .toBe('unit test');
  });

  it('stores a unit facet normal and the three vertices', () => {
    const buffer = toStlBinary(mesh);
    const view = new DataView(buffer);
    const nx = view.getFloat32(84, true);
    const ny = view.getFloat32(88, true);
    const nz = view.getFloat32(92, true);
    expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
    expect(view.getFloat32(96, true)).toBeCloseTo(mesh.positions[0], 5);
    expect(view.getFloat32(100, true)).toBeCloseTo(mesh.positions[1], 5);
    expect(view.getFloat32(104, true)).toBeCloseTo(mesh.positions[2], 5);
  });
});

describe('refusals', () => {
  it('refuses a skewed grid instead of drawing wrong normals', () => {
    const field = {
      values: new Float32Array(27),
      dims: [3, 3, 3],
      origin: [0, 0, 0],
      axes: [[1, 0, 0], [0.5, 0.8, 0], [0, 0, 1]],
    };
    expect(() => extractSurface(field, 0)).toThrow(/needs an orthogonal grid/);
  });

  it('refuses a field whose values do not fill the grid', () => {
    expect(() => extractSurface({ values: new Float32Array(4), dims: [3, 3, 3], origin: [0, 0, 0], step: 1 }, 0))
      .toThrow(/holds 4 values/);
    expect(() => extractSurface({ values: new Float32Array(8), dims: [2, 2, 2], origin: [0, 0, 0] }, 0))
      .toThrow(/neither axes nor a positive step/);
    expect(() => extractSurface(null, 0)).toThrow(MarchingCubesError);
  });

  it('stops at the triangle limit and says what to change', () => {
    const { field } = sphereField({ radius: 2, step: 0.12 });
    expect(() => extractSurface(field, 0, { maxTriangles: 100 })).toThrow(
      /above the 100 limit; raise the isovalue or coarsen the grid/,
    );
  });

  it('refuses an isovalue that is not a number', () => {
    const { field } = sphereField({ radius: 1, step: 0.5, half: 2 });
    expect(() => extractSurface(field, Number.NaN)).toThrow(/finite number/);
  });
});
