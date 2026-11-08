/**
 * A projected isosurface, drawn as vector polygons.
 *
 * This is the report's version of the 3D viewport: no WebGL, no raster — the
 * same triangles the app renders become filled paths, so the picture prints and
 * scales, and the document stays script-free.
 *
 * Honest approximations, all stated in the caption:
 *   - orthographic projection from a fixed isometric angle (the report has no
 *     interaction, so a stated viewpoint is enough);
 *   - flat shading from the vertex normals, quantised into a few bands per lobe
 *     and grouped into one path per band (fewer elements, much smaller file);
 *   - painter's algorithm at band granularity — a convex lobe occludes
 *     correctly, and a shape that folds behind itself may swap two bands.
 */

import {
  PALETTE, escapeXml, figureFrame, figureResult, fmtNum, round,
} from './primitives.js';

const LIGHT = (() => {
  const v = [0.35, 0.55, 0.75];
  const length = Math.hypot(...v);
  return v.map((component) => component / length);
})();

/** Rotation that shows three faces of the bounding box, in radians. */
const YAW = (35 * Math.PI) / 180;
const PITCH = (20 * Math.PI) / 180;

function rotate([x, y, z]) {
  const cosY = Math.cos(YAW);
  const sinY = Math.sin(YAW);
  const x1 = x * cosY + z * sinY;
  const z1 = -x * sinY + z * cosY;
  const cosP = Math.cos(PITCH);
  const sinP = Math.sin(PITCH);
  const y1 = y * cosP - z1 * sinP;
  const z2 = y * sinP + z1 * cosP;
  return [x1, y1, z2];
}

function shadeOf(normal, sign) {
  const view = rotate(normal);
  const dot = Math.abs(view[0] * LIGHT[0] + view[1] * LIGHT[1] + view[2] * LIGHT[2]);
  // Five bands: enough to read as a surface, few enough that the fill is one
  // path per band rather than one element per triangle.
  const band = Math.min(4, Math.floor(dot * 5));
  const base = sign < 0 ? [192, 57, 43] : [47, 95, 208];
  const lift = 0.42 + band * 0.13;
  const mixed = base.map((channel) => Math.round(channel + (255 - channel) * (lift - 0.42) * 0.85));
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * @param {object} input
 * @param {Array<{positions: ArrayLike<number>, normals: ArrayLike<number>, sign?: number}>} input.meshes
 * @param {number} [input.iso]     the isovalue the meshes were extracted at
 * @param {number} [input.maxTriangles] hard cap; beyond it the figure refuses
 */
export function surfaceFigure({
  meshes = [], iso = null, field = 'isosurface', units = 'au', title = null,
  width = 320, height = 300, maxTriangles = 6000,
} = {}) {
  const list = (Array.isArray(meshes) ? meshes : []).filter((mesh) => mesh
    && mesh.positions && mesh.positions.length >= 9 && Number(mesh.positions.length / 9) >= 1);
  if (list.length === 0) return null;
  const triangleCount = list.reduce((sum, mesh) => sum + Math.floor(mesh.positions.length / 9), 0);
  if (triangleCount > maxTriangles) return null;

  // Fit: one scale for both lobes so they keep their relative size.
  let minX = Infinity; let minY = Infinity; let minZ = Infinity;
  let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
  const projected = list.map((mesh) => {
    const count = Math.floor(mesh.positions.length / 9);
    const points = new Array(count);
    for (let triangle = 0; triangle < count; triangle += 1) {
      const vertices = [0, 1, 2].map((corner) => {
        const offset = triangle * 9 + corner * 3;
        const p = rotate([mesh.positions[offset], mesh.positions[offset + 1], mesh.positions[offset + 2]]);
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
        minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
        return p;
      });
      const normalOffset = triangle * 9;
      const normal = [0, 1, 2].map((axis) => (
        (mesh.normals?.[normalOffset + axis] ?? 0)
        + (mesh.normals?.[normalOffset + 3 + axis] ?? 0)
        + (mesh.normals?.[normalOffset + 6 + axis] ?? 0)
      ) / 3);
      points[triangle] = { vertices, normal, depth: (vertices[0][2] + vertices[1][2] + vertices[2][2]) / 3 };
    }
    return { sign: Number(mesh.sign ?? 1), points };
  });

  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const pad = 16;
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
  const offsetX = pad + ((width - pad * 2) - spanX * scale) / 2;
  const offsetY = pad + ((height - pad * 2) - spanY * scale) / 2;
  const project = (p) => [
    offsetX + (p[0] - minX) * scale,
    // SVG y grows downward; the model's +y is up.
    offsetY + (maxY - p[1]) * scale,
  ];

  const bands = new Map();
  for (const mesh of projected) {
    for (const triangle of mesh.points) {
      const colour = shadeOf(triangle.normal, mesh.sign);
      const entry = bands.get(colour) || { colour, triangles: [], depth: 0 };
      entry.triangles.push({ triangle, sign: mesh.sign });
      entry.depth += triangle.depth;
      bands.set(colour, entry);
    }
  }

  const ordered = [...bands.values()]
    .map((band) => ({ ...band, depth: band.depth / band.triangles.length }))
    .sort((a, b) => a.depth - b.depth);

  const parts = ordered.map((band) => {
    const d = band.triangles.map(({ triangle }) => {
      const [a, b, c] = triangle.vertices.map(project);
      return `M${round(a[0], 1)},${round(a[1], 1)}L${round(b[0], 1)},${round(b[1], 1)}L${round(c[0], 1)},${round(c[1], 1)}Z`;
    }).join('');
    return `<path d="${d}" fill="${band.colour}" stroke="none"/>`;
  });

  const isoText = Number.isFinite(Number(iso)) ? `iso ${fmtNum(iso, 3)} ${units}` : 'isosurface';
  const caption = `${title || field} · ${isoText} · ${triangleCount} triangles, both lobes`
    + ' · orthographic projection, flat shading, vector copy of the 3D viewport';

  return figureResult({
    kind: 'surface',
    svg: figureFrame({
      width,
      height,
      title: caption,
      desc: `${field} at ${isoText}, projected from a fixed isometric angle; positive and negative lobes in different colours.`,
      body: parts.join(''),
      className: 'figure-surface',
    }),
    width,
    height,
    caption,
    params: { triangles: triangleCount, iso, lobes: list.length },
  });
}

export { escapeXml, PALETTE };
