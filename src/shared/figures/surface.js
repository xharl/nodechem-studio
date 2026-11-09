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
  PALETTE, DIVERGING, escapeXml, figureFrame, figureResult, fmtNum, round,
} from './primitives.js';
import { HARTREE_TO_KCAL } from '../esp.js';

const LIGHT = (() => {
  const v = [0.35, 0.55, 0.75];
  const length = Math.hypot(...v);
  return v.map((component) => component / length);
})();

/** Rotation that shows three faces of the bounding box, in radians. */
const YAW = (35 * Math.PI) / 180;
const PITCH = (20 * Math.PI) / 180;

const RAMP = DIVERGING;

/** Diverging colour for a value in `[min, max]`, quantised to the ramp's bins. */
export function divergingColour(value, min, max) {
  const span = max - min;
  const position = span > 0 && Number.isFinite(value)
    ? (Math.max(min, Math.min(max, value)) - min) / span
    : 0.5;
  return RAMP[Math.round(position * (RAMP.length - 1))];
}

/**
 * A diverging colour bar with numeric ticks, in the units the caller states.
 *
 * Drawn as one `<rect>` per ramp bin so the bar is exactly the discrete ramp the
 * surface uses — a smooth gradient would claim a resolution the picture does not
 * have. Ticks are labelled, because a colour without a number is decoration.
 */
export function colourLegend({
  x, y, width = 220, height = 10, min, max, ticks = [], label = '', note = '', notes = null,
}) {
  const parts = [];
  for (let bin = 0; bin < RAMP.length; bin += 1) {
    const left = x + (bin * width) / RAMP.length;
    const span = width / RAMP.length;
    parts.push(`<rect x="${round(left, 2)}" y="${round(y, 2)}" width="${round(span + 0.2, 2)}"`
      + ` height="${round(height, 2)}" fill="${RAMP[bin]}" stroke="none"/>`);
  }
  parts.push(`<rect x="${round(x, 2)}" y="${round(y, 2)}" width="${round(width, 2)}" height="${round(height, 2)}"`
    + ` fill="none" stroke="${PALETTE.axis}" stroke-width="0.7"/>`);
  for (const tick of ticks) {
    const span = max - min;
    const position = span > 0 ? (tick.value - min) / span : 0.5;
    const at = x + Math.max(0, Math.min(1, position)) * width;
    parts.push(`<line x1="${round(at, 2)}" y1="${round(y + height, 2)}" x2="${round(at, 2)}"`
      + ` y2="${round(y + height + 3, 2)}" stroke="${PALETTE.axis}" stroke-width="1"/>`);
    parts.push(`<text x="${round(at, 2)}" y="${round(y + height + 13, 2)}" text-anchor="middle"`
      + ` font-size="9" fill="${PALETTE.muted}">${escapeXml(tick.label)}</text>`);
  }
  if (label) {
    parts.push(`<text x="${round(x, 2)}" y="${round(y - 5, 2)}" font-size="9" fill="${PALETTE.ink}">`
      + `${escapeXml(label)}</text>`);
  }
  const lines = Array.isArray(notes) && notes.length ? notes : (note ? [note] : []);
  lines.forEach((line, index) => {
    parts.push(`<text x="${round(x, 2)}" y="${round(y + height + 27 + index * 11, 2)}" font-size="9"`
      + ` fill="${PALETTE.muted}">${escapeXml(line)}</text>`);
  });
  return parts.join('');
}

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
 * @param {(centroid: number[]) => number}|null [input.colourBy] colour each
 *   triangle by a scalar at its centroid (Å) instead of by phase
 * @param {{min: number, max: number}}|null [input.colourRange] the domain of
 *   `colourBy`; required with it, and printed in the legend
 * @param {object|null} [input.legend] `{ min, max, ticks, label, note }` drawn
 *   under the surface, in the units the caller states
 */
export function surfaceFigure({
  meshes = [], iso = null, field = 'isosurface', units = 'au', title = null,
  width = 320, height = 300, maxTriangles = 6000,
  colourBy = null, colourRange = null, legend = null, captionSuffix = '', descExtra = '',
} = {}) {
  const list = (Array.isArray(meshes) ? meshes : []).filter((mesh) => mesh
    && mesh.positions && mesh.positions.length >= 9 && Number(mesh.positions.length / 9) >= 1);
  if (list.length === 0) return null;
  const triangleCount = list.reduce((sum, mesh) => sum + Math.floor(mesh.positions.length / 9), 0);
  if (triangleCount > maxTriangles) return null;
  if (colourBy && (!colourRange || !Number.isFinite(colourRange.min) || !Number.isFinite(colourRange.max))) {
    throw new Error('a coloured surface needs a finite colourRange (min and max).');
  }
  // The legend needs room below the projection; the surface keeps its size.
  const legendLines = legend
    ? (Array.isArray(legend.notes) && legend.notes.length ? legend.notes.length : (legend.note ? 1 : 0))
    : 0;
  const legendHeight = legend ? 46 + 11 * Math.max(0, legendLines - 1) : 0;
  const bodyHeight = height;
  height += legendHeight;

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
      // The centroid is kept in the model's own frame: a colour is a property of
      // the molecule, not of the projection.
      const centroid = [0, 1, 2].map((axis) => (
        (mesh.positions[triangle * 9 + axis]
          + mesh.positions[triangle * 9 + 3 + axis]
          + mesh.positions[triangle * 9 + 6 + axis]) / 3
      ));
      const normalOffset = triangle * 9;
      const normal = [0, 1, 2].map((axis) => (
        (mesh.normals?.[normalOffset + axis] ?? 0)
        + (mesh.normals?.[normalOffset + 3 + axis] ?? 0)
        + (mesh.normals?.[normalOffset + 6 + axis] ?? 0)
      ) / 3);
      points[triangle] = {
        vertices,
        normal,
        centroid,
        depth: (vertices[0][2] + vertices[1][2] + vertices[2][2]) / 3,
      };
    }
    return { sign: Number(mesh.sign ?? 1), points };
  });

  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const pad = 16;
  const scale = Math.min((width - pad * 2) / spanX, (bodyHeight - pad * 2) / spanY);
  const offsetX = pad + ((width - pad * 2) - spanX * scale) / 2;
  const offsetY = pad + ((bodyHeight - pad * 2) - spanY * scale) / 2;
  const project = (p) => [
    offsetX + (p[0] - minX) * scale,
    // SVG y grows downward; the model's +y is up.
    offsetY + (maxY - p[1]) * scale,
  ];

  // A colour-mapped triangle keeps its shading: the value picks the hue (one
  // ramp bin) and the light picks the lightness, so a single-hue patch still
  // reads as a curved surface.
  const colourOfTriangle = (triangle, sign) => {
    if (!colourBy) return shadeOf(triangle.normal, sign);
    const base = divergingColour(colourBy(triangle.centroid), colourRange.min, colourRange.max);
    const view = rotate(triangle.normal);
    const dot = Math.abs(view[0] * LIGHT[0] + view[1] * LIGHT[1] + view[2] * LIGHT[2]);
    const band = Math.min(4, Math.floor(dot * 5));
    const lift = 0.16 * band;
    const rgb = [1, 3, 5].map((offset) => Math.round(
      Number.parseInt(base.slice(offset, offset + 2), 16) * (1 - lift) + 255 * lift * 0.9,
    ));
    return `#${rgb.map((channel) => Math.min(255, channel).toString(16).padStart(2, '0')).join('')}`;
  };

  const bands = new Map();
  for (const mesh of projected) {
    for (const triangle of mesh.points) {
      const colour = colourOfTriangle(triangle, mesh.sign);
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
  if (legend) {
    parts.push(colourLegend({
      x: 18,
      y: bodyHeight + 6,
      width: width - 36,
      min: legend.min ?? colourRange?.min ?? 0,
      max: legend.max ?? colourRange?.max ?? 1,
      ticks: legend.ticks ?? [],
      label: legend.label ?? '',
      note: legend.note ?? '',
      notes: legend.notes ?? null,
    }));
  }

  const isoText = Number.isFinite(Number(iso)) ? `iso ${fmtNum(iso, 3)} ${units}` : 'isosurface';
  const caption = `${title || field} · ${isoText} · ${triangleCount} triangles, both lobes`
    + `${captionSuffix}`
    + ' · orthographic projection, flat shading, vector copy of the 3D viewport';

  return figureResult({
    kind: 'surface',
    svg: figureFrame({
      width,
      height,
      title: caption,
      desc: `${field} at ${isoText}, projected from a fixed isometric angle; `
        + (colourBy
          ? `each triangle is coloured by the value at its centroid on the stated range. ${descExtra}`
          : 'positive and negative lobes in different colours.'),
      body: parts.join(''),
      className: colourBy ? 'figure-surface figure-esp' : 'figure-surface',
    }),
    width,
    height,
    caption,
    params: {
      triangles: triangleCount,
      iso,
      lobes: list.length,
      ...(colourBy ? { colourRange: { ...colourRange }, coloured: true } : {}),
    },
  });
}

/**
 * An isosurface coloured by a scalar per triangle — the electrostatic potential,
 * in practice (issue 164).
 *
 * `values` is one number per triangle, in the order the meshes were given (the
 * same order `extractSurface` returns). The legend is mandatory: the picture
 * states its range in the unit the caller names, and `note` carries the grid and
 * the method so a printed figure cannot be read as a claim without them.
 */
export function espSurfaceFigure({
  meshes = [], values = null, range = null, iso = null, grid = null, method = null,
  unitLabel = 'kcal/mol', title = 'ψ isosurface coloured by electrostatic potential',
  width = 400, height = 330, maxTriangles = 6000,
} = {}) {
  // Nothing to draw is not an error: the registry contract is that a figure
  // builder returns `null` for data it cannot use, and the caller prints the
  // reason. Data that is present but wrong (a NaN range, a value per triangle
  // missing) *is* an error, and throws.
  if (!Array.isArray(meshes) || meshes.length === 0 || !range || !values) return null;
  if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) {
    throw new Error('an ESP surface needs a finite range (min and max).');
  }
  if (typeof values.length !== 'number') {
    throw new Error('an ESP surface needs one value per triangle.');
  }
  const count = (Array.isArray(meshes) ? meshes : [])
    .reduce((sum, mesh) => sum + Math.floor((mesh?.positions?.length ?? 0) / 9), 0);
  if (values.length !== count && values.length !== 1) {
    throw new Error(`an ESP surface needs one value per triangle (${values.length} for ${count} triangles).`);
  }
  let cursor = 0;
  const colourBy = () => {
    const value = values.length === 1 ? values[0] : values[cursor];
    cursor += 1;
    return value;
  };
  const kcalMin = range.min * HARTREE_TO_KCAL;
  const kcalMax = range.max * HARTREE_TO_KCAL;
  const ticks = [kcalMin, 0, kcalMax]
    .filter((value, index, all) => all.indexOf(value) === index && Number.isFinite(value))
    .map((value) => ({ value: (value / HARTREE_TO_KCAL), label: `${value.toFixed(1)}` }));
  const note = [
    grid ? `grid ${grid}` : null,
    `range ${kcalMin.toFixed(1)} … ${kcalMax.toFixed(1)} kcal/mol `
      + `(${range.min.toFixed(4)} … ${range.max.toFixed(4)} hartree), ${range.scaledTo || 'symmetric about zero'}`,
  ].filter(Boolean).join(' · ');
  // Two short lines under the bar, not one 250-character one: a label that runs
  // off the figure is a label nobody reads.
  const legendNotes = [
    grid ? `grid ${grid}` : null,
    `${kcalMin.toFixed(1)} … ${kcalMax.toFixed(1)} kcal/mol = ${range.min.toFixed(4)} … `
      + `${range.max.toFixed(4)} hartree · ${range.scaledTo || 'symmetric about zero'}`,
  ].filter(Boolean);
  const captionSuffix = ` · coloured by V(r): ${kcalMin.toFixed(1)} … ${kcalMax.toFixed(1)} kcal/mol, `
    + `${range.min.toFixed(4)} … ${range.max.toFixed(4)} hartree`
    + `${grid ? `, on ${grid}` : ''}${method ? `, ${method}` : ''}`;
  return surfaceFigure({
    meshes,
    iso,
    field: 'electrostatic potential',
    units: 'au',
    title,
    width,
    height,
    maxTriangles,
    colourBy,
    colourRange: { min: range.min, max: range.max },
    legend: {
      min: range.min,
      max: range.max,
      ticks,
      label: `electrostatic potential (${unitLabel}); ${method ? 'analytic basis sum' : ''}`.trim(),
      notes: legendNotes,
    },
    captionSuffix,
    descExtra: note,
  });
}

export { escapeXml, PALETTE };
