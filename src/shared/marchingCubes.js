/**
 * An isosurface from a scalar field, as a triangle soup with analytic normals.
 *
 * ## Why there is no 256-row triangle table here
 *
 * The classic Paul Bourke implementation ships two constants: `edgeTable` (12
 * bits per case, which edges are cut) and `triTable` (up to 15 triangle indices
 * per case, 256 rows). Hand-copying 256 rows is the single most common way to
 * ship a marching-cubes routine with a silent hole in it — the table is data,
 * so a typo is invisible until a surface has a gap, and a gap is not a
 * chemistry error a reviewer can spot in a picture.
 *
 * This module therefore *derives* the same topology from the cube's own face
 * graph, which is the same construction Bourke's tables encode:
 *
 * 1. classify the eight corners against the isovalue;
 * 2. on each of the twelve edges with one inside and one outside corner, place
 *    a vertex by linear interpolation;
 * 3. on each of the six faces, connect the cut edges. A face with two cuts gets
 *    one segment; a face with four cuts (corners alternating in/out) gets two,
 *    each paired around an *inside* corner, which is the standard unambiguous
 *    resolution;
 * 4. the segments form closed cycles inside the cell; each cycle is fanned into
 *    triangles.
 *
 * The result is closed by construction: every segment that is not a fan chord
 * lies in a cell face, and the neighbouring cell places the identical segment
 * on the identical two vertices (same edge, same interpolated position). The
 * test asserts that property directly — every mesh edge is shared by exactly
 * two triangles — so the guarantee is checked, not claimed.
 *
 * ## Normals
 *
 * Normals come from the **gradient of the scalar field** by central
 * differences, interpolated along the edge and transformed from grid indices to
 * Å, never from the triangle geometry. Two reasons: a geometric normal is
 * faceted and jumps at cell boundaries, and the sign of a gradient is the one
 * thing that makes a ± lobe read correctly.
 *
 * Sign convention. `extractSurface(field, iso)` encloses the region
 * `{f > iso}` when `iso >= 0` and `{f < iso}` when `iso < 0`, and the normals
 * point *away* from that region. For an orbital that is exactly the phase:
 * `extractSurface(field, +0.02)` is the positive lobe (normals outward from
 * the enclosed density), `extractSurface(field, -0.02)` the negative one. For a
 * non-negative field (a density, or a synthetic sphere `R − r` at iso 0) the
 * natural call is `iso >= 0` and the normals point outward.
 *
 * ## Grids
 *
 * The grid must be orthogonal (axis-aligned or rotated): the gradient transform
 * below divides by |a_k|² and needs the axes to be perpendicular. A skewed cube
 * (a hexagonal cell) is refused by name rather than meshed with a wrong normal.
 */

export class MarchingCubesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MarchingCubesError';
  }
}

/** Corner offsets, in the order the edge and face tables use. */
const CORNERS = Object.freeze([
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
]);

/** The twelve edges as corner pairs. */
const EDGES = Object.freeze([
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
]);

const EDGE_INDEX = new Map(EDGES.map(([a, b], index) => [`${Math.min(a, b)}-${Math.max(a, b)}`, index]));

/** The six faces as four cyclic corners (winding does not matter here). */
const FACES = Object.freeze([
  [0, 3, 2, 1],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [3, 7, 6, 2],
  [0, 4, 7, 3],
  [1, 2, 6, 5],
]);

function edgeBetween(a, b) {
  const key = a < b ? `${a}-${b}` : `${b}-${a}`;
  const index = EDGE_INDEX.get(key);
  if (index === undefined) throw new MarchingCubesError(`corners ${a} and ${b} are not joined by an edge.`);
  return index;
}

function axesOf(field) {
  if (Array.isArray(field.axes) && field.axes.length === 3 && field.axes.every((axis) => Array.isArray(axis) && axis.length === 3)) {
    return field.axes.map((axis) => axis.map(Number));
  }
  const step = Number(field.step ?? field.spacing);
  if (!Number.isFinite(step) || step <= 0) {
    throw new MarchingCubesError('the field has neither axes nor a positive step.');
  }
  return [[step, 0, 0], [0, step, 0], [0, 0, step]];
}

/**
 * Check that the three axes are mutually perpendicular, and return the
 * reciprocal-squared lengths the gradient transform needs.
 */
function orthogonalScale(axes) {
  const lengths = axes.map((axis) => Math.hypot(...axis));
  for (let a = 0; a < 3; a += 1) {
    if (!(lengths[a] > 0)) throw new MarchingCubesError('a grid axis has zero length.');
    for (let b = a + 1; b < 3; b += 1) {
      const dot = axes[a][0] * axes[b][0] + axes[a][1] * axes[b][1] + axes[a][2] * axes[b][2];
      if (Math.abs(dot) > 1e-6 * lengths[a] * lengths[b]) {
        throw new MarchingCubesError(
          'the isosurface needs an orthogonal grid, but two of this grid\'s axes are not perpendicular; '
          + 'the gradient normals would be wrong in a way no picture shows.',
        );
      }
    }
  }
  return axes.map((axis, index) => axis.map((component) => component / lengths[index] ** 2));
}

/** Value at a node, or `null` outside the grid (one-sided differences). */
function valueAt(values, dims, i, j, k) {
  const [nx, ny, nz] = dims;
  if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return null;
  return values[i + nx * (j + ny * k)];
}

/**
 * Gradient in Å⁻¹ at node (i, j, k), by central differences with one-sided
 * differences at the boundary. Returns `[gx, gy, gz]`.
 */
function nodeGradient(values, dims, i, j, k, scale) {
  const component = (axis) => {
    const forward = valueAt(values, dims, i + (axis === 0 ? 1 : 0), j + (axis === 1 ? 1 : 0), k + (axis === 2 ? 1 : 0));
    const backward = valueAt(values, dims, i - (axis === 0 ? 1 : 0), j - (axis === 1 ? 1 : 0), k - (axis === 2 ? 1 : 0));
    if (forward === null) return backward === null ? 0 : values[i + dims[0] * (j + dims[1] * k)] - backward;
    if (backward === null) return forward - values[i + dims[0] * (j + dims[1] * k)];
    return (forward - backward) / 2;
  };
  const g = [component(0), component(1), component(2)];
  return [
    g[0] * scale[0][0] + g[1] * scale[1][0] + g[2] * scale[2][0],
    g[0] * scale[0][1] + g[1] * scale[1][1] + g[2] * scale[2][1],
    g[0] * scale[0][2] + g[1] * scale[1][2] + g[2] * scale[2][2],
  ];
}

/**
 * Extract the isosurface of `field` at `iso`.
 *
 * @param {object} field `{ values, dims, origin, axes | step }` — the shape
 *   `volume.js` produces and `parseCube` can be adapted to.
 * @param {number} iso the isovalue; zero is allowed for a field that is
 *   positive inside and negative outside (a sphere, a mask), not for an orbital
 *   whose two lobes meet at zero.
 * @param {{maxTriangles?: number, onProgress?: (done: number, total: number) => void}} [options]
 * @returns {{positions: Float32Array, normals: Float32Array, triangleCount: number,
 *   vertexCount: number, iso: number, sign: number, cells: number,
 *   bounds: {min: number[], max: number[]}, units: object}}
 */
export function extractSurface(field, iso, { maxTriangles = 1_500_000, onProgress = null } = {}) {
  if (!field || !Array.isArray(field.dims) || !field.values) {
    throw new MarchingCubesError('extractSurface needs a field with dims and values (see volume.js).');
  }
  const level = Number(iso);
  if (!Number.isFinite(level)) throw new MarchingCubesError('the isovalue must be a finite number.');
  const limit = Number(maxTriangles);
  if (!Number.isFinite(limit) || limit < 1) throw new MarchingCubesError('maxTriangles must be at least 1.');

  const dims = field.dims.map(Number);
  const [nx, ny, nz] = dims;
  if (dims.some((count) => !Number.isInteger(count) || count < 2)) {
    throw new MarchingCubesError(`a surface needs at least 2 points on every axis; this grid is ${dims.join('×')}.`);
  }
  const values = field.values;
  if (values.length !== nx * ny * nz) {
    throw new MarchingCubesError(`the field holds ${values.length} values for a ${dims.join('×')} grid.`);
  }
  const origin = (field.origin ?? [0, 0, 0]).map(Number);
  const axes = axesOf(field);
  const scale = orthogonalScale(axes);
  // iso > 0 : the enclosed region is {f > iso}; iso < 0 : {f < iso}.
  const sign = level >= 0 ? 1 : -1;
  const inside = (value) => (sign > 0 ? value > level : value < level);

  const positions = [];
  const normals = [];
  let triangles = 0;
  let cells = 0;
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];

  const corner = CORNERS.map(([di, dj, dk]) => [di, dj, dk]);
  const cellValues = new Float64Array(8);
  const cellInside = new Uint8Array(8);
  const cellPoint = new Array(8).fill(null).map(() => [0, 0, 0]);

  const gridPoint = (i, j, k, out) => {
    out[0] = origin[0] + axes[0][0] * i + axes[1][0] * j + axes[2][0] * k;
    out[1] = origin[1] + axes[0][1] * i + axes[1][1] * j + axes[2][1] * k;
    out[2] = origin[2] + axes[0][2] * i + axes[1][2] * j + axes[2][2] * k;
    return out;
  };

  // Vertex scratch, indexed by *edge number*: position and normal of the
  // crossing on that edge, and −1 when the edge is not cut.
  const edgeNormal = new Float64Array(36);
  const edgeVertex = new Int32Array(12).fill(-1);
  let vertexCount = 0;
  // Positions live in one array shared by the face walk and the fan.
  const localPositions = new Float64Array(36);

  for (let k = 0; k < nz - 1; k += 1) {
    for (let j = 0; j < ny - 1; j += 1) {
      for (let i = 0; i < nx - 1; i += 1) {
        // Fast reject: nothing to do unless the isosurface passes through.
        let low = Infinity;
        let high = -Infinity;
        for (let c = 0; c < 8; c += 1) {
          const [di, dj, dk] = corner[c];
          const value = values[(i + di) + nx * ((j + dj) + ny * (k + dk))];
          cellValues[c] = value;
          cellInside[c] = inside(value) ? 1 : 0;
          if (value < low) low = value;
          if (value > high) high = value;
        }
        if (low > level || high < level) continue;
        let mask = 0;
        for (let c = 0; c < 8; c += 1) if (cellInside[c]) mask |= 1 << c;
        if (mask === 0 || mask === 255) continue;
        cells += 1;

        edgeVertex.fill(-1);
        for (let e = 0; e < 12; e += 1) {
          const [a, b] = EDGES[e];
          if (cellInside[a] === cellInside[b]) continue;
          const va = cellValues[a];
          const vb = cellValues[b];
          const span = vb - va;
          let t = span === 0 ? 0.5 : (level - va) / span;
          if (!Number.isFinite(t)) t = 0.5;
          if (t < 0) t = 0;
          if (t > 1) t = 1;
          const pa = gridPoint(i + corner[a][0], j + corner[a][1], k + corner[a][2], cellPoint[a]);
          const q = gridPoint(i + corner[b][0], j + corner[b][1], k + corner[b][2], [0, 0, 0]);
          localPositions[e * 3] = pa[0] + (q[0] - pa[0]) * t;
          localPositions[e * 3 + 1] = pa[1] + (q[1] - pa[1]) * t;
          localPositions[e * 3 + 2] = pa[2] + (q[2] - pa[2]) * t;

          const ga = nodeGradient(values, dims, i + corner[a][0], j + corner[a][1], k + corner[a][2], scale);
          const gb = nodeGradient(values, dims, i + corner[b][0], j + corner[b][1], k + corner[b][2], scale);
          let nx0 = ga[0] + (gb[0] - ga[0]) * t;
          let ny0 = ga[1] + (gb[1] - ga[1]) * t;
          let nz0 = ga[2] + (gb[2] - ga[2]) * t;
          // Point away from the enclosed region.
          nx0 *= -sign;
          ny0 *= -sign;
          nz0 *= -sign;
          const length = Math.hypot(nx0, ny0, nz0);
          if (length > 0) {
            nx0 /= length;
            ny0 /= length;
            nz0 /= length;
          } else {
            // A flat spot at the isovalue: keep a unit normal rather than a
            // zero vector, which would render as an unlit black triangle.
            nx0 = 0;
            ny0 = 0;
            nz0 = 1;
          }
          edgeNormal[e * 3] = nx0;
          edgeNormal[e * 3 + 1] = ny0;
          edgeNormal[e * 3 + 2] = nz0;
          edgeVertex[e] = e;
        }

        // Face walk: build the segments, then the cycles.
        const adjacency = new Map();
        const connect = (a, b) => {
          if (!adjacency.has(a)) adjacency.set(a, []);
          if (!adjacency.has(b)) adjacency.set(b, []);
          adjacency.get(a).push(b);
          adjacency.get(b).push(a);
        };
        for (const face of FACES) {
          const cuts = [];
          for (let at = 0; at < 4; at += 1) {
            const a = face[at];
            const b = face[(at + 1) % 4];
            const e = edgeBetween(a, b);
            cuts.push(edgeVertex[e] === -1 ? -1 : e);
          }
          const present = cuts.filter((value) => value !== -1);
          if (present.length === 2) {
            connect(present[0], present[1]);
          } else if (present.length === 4) {
            // Alternating corners: pair each cut with the one around an inside
            // corner, i.e. inset the two inside corners from each other.
            for (let at = 0; at < 4; at += 1) {
              if (!cellInside[face[at]]) continue;
              const previous = cuts[(at + 3) % 4];
              const next = cuts[at];
              if (previous !== -1 && next !== -1) connect(previous, next);
            }
          }
        }

        // Walk the segments into cycles. Every vertex here has degree 2.
        const visited = new Set();
        for (const start of adjacency.keys()) {
          if (visited.has(start)) continue;
          const cycle = [];
          let previous = -1;
          let current = start;
          while (current !== -1 && !visited.has(current)) {
            visited.add(current);
            cycle.push(current);
            const neighbours = adjacency.get(current) || [];
            const next = neighbours.find((candidate) => candidate !== previous);
            previous = current;
            current = next === undefined ? -1 : next;
          }
          if (cycle.length < 3) continue;
          // Fan from the first vertex, with the winding chosen so that the
          // geometric normal agrees with the field gradient at that vertex —
          // otherwise the STL and the GL front faces disagree with the phase.
          const v0 = cycle[0];
          const ax = localPositions[v0 * 3];
          const ay = localPositions[v0 * 3 + 1];
          const az = localPositions[v0 * 3 + 2];
          const nx0 = edgeNormal[v0 * 3];
          const ny0 = edgeNormal[v0 * 3 + 1];
          const nz0 = edgeNormal[v0 * 3 + 2];
          for (let at = 1; at < cycle.length - 1; at += 1) {
            let b = cycle[at];
            let c = cycle[at + 1];
            const bx0 = localPositions[b * 3] - ax;
            const by0 = localPositions[b * 3 + 1] - ay;
            const bz0 = localPositions[b * 3 + 2] - az;
            const cx0 = localPositions[c * 3] - ax;
            const cy0 = localPositions[c * 3 + 1] - ay;
            const cz0 = localPositions[c * 3 + 2] - az;
            const gx = by0 * cz0 - bz0 * cy0;
            const gy = bz0 * cx0 - bx0 * cz0;
            const gz = bx0 * cy0 - by0 * cx0;
            if (Math.hypot(gx, gy, gz) < 1e-12) continue;
            if (gx * nx0 + gy * ny0 + gz * nz0 < 0) {
              const swap = b;
              b = c;
              c = swap;
            }
            for (const id of [v0, b, c]) {
              positions.push(localPositions[id * 3], localPositions[id * 3 + 1], localPositions[id * 3 + 2]);
              normals.push(edgeNormal[id * 3], edgeNormal[id * 3 + 1], edgeNormal[id * 3 + 2]);
              for (let axis = 0; axis < 3; axis += 1) {
                const value = localPositions[id * 3 + axis];
                if (value < min[axis]) min[axis] = value;
                if (value > max[axis]) max[axis] = value;
              }
            }
            triangles += 1;
            vertexCount += 3;
          }
        }

        if (triangles > limit) {
          throw new MarchingCubesError(
            `the isosurface reached ${triangles} triangles, above the ${limit} limit; `
            + 'raise the isovalue or coarsen the grid.',
          );
        }
      }
    }
    if (onProgress) onProgress(k + 1, nz - 1);
  }

  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    triangleCount: triangles,
    vertexCount,
    iso: level,
    sign,
    cells,
    bounds: triangles === 0
      ? { min: [0, 0, 0], max: [0, 0, 0] }
      : { min, max },
    units: { coordinates: 'angstrom' },
  };
}

/**
 * Binary STL from a mesh: 80-byte header, `uint32` triangle count, then 50
 * bytes per triangle (facet normal, three vertices, `uint16` attribute).
 *
 * Facet normals are the geometric ones — that is what the format stores — and
 * they are oriented by the mesh's winding, which `extractSurface` already made
 * agree with the field gradient. Written without a DOM or a Buffer so it works
 * in a worker and in Node.
 *
 * @returns {ArrayBuffer}
 */
export function toStlBinary(mesh, { header = 'NodeChem Studio isosurface' } = {}) {
  if (!mesh || !mesh.positions || !Number.isInteger(mesh.triangleCount)) {
    throw new MarchingCubesError('toStlBinary needs a mesh from extractSurface.');
  }
  const triangles = mesh.triangleCount;
  if (mesh.positions.length !== triangles * 9) {
    throw new MarchingCubesError(
      `the mesh has ${mesh.positions.length / 9} triangles of positions but claims ${triangles}.`,
    );
  }
  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const label = String(header ?? '').slice(0, 79);
  for (let at = 0; at < label.length; at += 1) bytes[at] = label.charCodeAt(at) & 0x7f;
  view.setUint32(80, triangles, true);
  const { positions } = mesh;
  let offset = 84;
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const base = triangle * 9;
    const ax = positions[base];
    const ay = positions[base + 1];
    const az = positions[base + 2];
    const bx = positions[base + 3];
    const by = positions[base + 4];
    const bz = positions[base + 5];
    const cx = positions[base + 6];
    const cy = positions[base + 7];
    const cz = positions[base + 8];
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    view.setFloat32(offset, nx, true);
    view.setFloat32(offset + 4, ny, true);
    view.setFloat32(offset + 8, nz, true);
    view.setFloat32(offset + 12, ax, true);
    view.setFloat32(offset + 16, ay, true);
    view.setFloat32(offset + 20, az, true);
    view.setFloat32(offset + 24, bx, true);
    view.setFloat32(offset + 28, by, true);
    view.setFloat32(offset + 32, bz, true);
    view.setFloat32(offset + 36, cx, true);
    view.setFloat32(offset + 40, cy, true);
    view.setFloat32(offset + 44, cz, true);
    view.setUint16(offset + 48, 0, true);
    offset += 50;
  }
  return buffer;
}

/** Signed volume enclosed by a closed mesh, in Å³ (a check, not a promise). */
export function meshVolume(mesh) {
  if (!mesh?.positions) throw new MarchingCubesError('meshVolume needs a mesh from extractSurface.');
  const { positions } = mesh;
  let volume = 0;
  for (let base = 0; base < positions.length; base += 9) {
    const ax = positions[base];
    const ay = positions[base + 1];
    const az = positions[base + 2];
    const bx = positions[base + 3];
    const by = positions[base + 4];
    const bz = positions[base + 5];
    const cx = positions[base + 6];
    const cy = positions[base + 7];
    const cz = positions[base + 8];
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return volume;
}
