/**
 * A planar slice through a scalar field — the wavefunction figure that costs
 * almost nothing (a few kilobytes of paths) and prints crisply.
 *
 * Two layers that answer different questions:
 *   - the colour bands show *where* the field is large, cheaply;
 *   - the iso lines show *the shape* at exact values, which is what a reader
 *     checks against the number in the caption.
 *
 * The field is whatever the caller has: an orbital ψ (signed), an electron
 * density (non-negative), an ESP. The figure never decides which — it prints the
 * range and the field name it was given.
 */

import {
  DIVERGING, PALETTE, SEQUENTIAL, axis, escapeXml, figureFrame, figureResult, fmtNum, niceTicks, round, scaleLinear,
} from './primitives.js';

/**
 * @typedef {object} Volume
 * @property {ArrayLike<number>} values   flat array, x fastest then y then z
 * @property {[number,number,number]} origin  Å
 * @property {[number,number,number]} step    Å
 * @property {[number,number,number]} counts  grid points per axis
 */

/** Extracts one plane from a volume. `axis` is which coordinate is held fixed. */
export function sliceOf(volume, axis = 'z', index = null) {
  if (!volume || !volume.values || !Array.isArray(volume.counts)) return null;
  const counts = volume.counts.map(Number);
  if (counts.length !== 3 || counts.some((n) => !Number.isInteger(n) || n <= 0)) return null;
  const [nx, ny, nz] = counts;
  const origin = (volume.origin || [0, 0, 0]).map(Number);
  const step = (volume.step || [1, 1, 1]).map(Number);
  const axisIndex = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const held = index === null || index === undefined
    ? Math.floor(counts[axisIndex] / 2)
    : Math.max(0, Math.min(counts[axisIndex] - 1, Math.round(Number(index))));
  if (!Number.isFinite(held)) return null;

  let width;
  let height;
  let horizontal; // which volume axis runs along the slice's x
  let vertical;
  if (axisIndex === 0) { width = ny; height = nz; horizontal = 1; vertical = 2; }
  else if (axisIndex === 1) { width = nx; height = nz; horizontal = 0; vertical = 2; }
  else { width = nx; height = ny; horizontal = 0; vertical = 1; }

  const values = new Float64Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const ijk = [0, 0, 0];
      ijk[horizontal] = column;
      ijk[vertical] = height - 1 - row; // SVG y grows downward; the first row is the top
      ijk[axisIndex] = held;
      values[row * width + column] = Number(volume.values[(ijk[2] * ny + ijk[1]) * nx + ijk[0]]) || 0;
    }
  }

  const alongX = horizontal;
  const alongY = vertical;
  return {
    values,
    width,
    height,
    held,
    axis,
    xOrigin: origin[alongX],
    yOrigin: origin[alongY],
    xStep: step[alongX],
    yStep: step[alongY],
    planePositionA: origin[axisIndex] + step[axisIndex] * held,
    labels: { x: ['x', 'y', 'z'][alongX], y: ['x', 'y', 'z'][alongY] },
  };
}

/**
 * Marching squares: iso segments in grid coordinates as `[[x0,y0],[x1,y1]]`.
 * Cell corners are the usual (a=top-left, b=top-right, c=bottom-right,
 * d=bottom-left) so a contour between two cells joins without a seam.
 */
export function marchingSquares(values, width, height, iso) {
  const segments = [];
  const interpolate = (v0, v1) => {
    const denominator = v1 - v0;
    return denominator === 0 ? 0.5 : (iso - v0) / denominator;
  };
  for (let row = 0; row < height - 1; row += 1) {
    for (let column = 0; column < width - 1; column += 1) {
      const a = values[row * width + column];
      const b = values[row * width + column + 1];
      const c = values[(row + 1) * width + column + 1];
      const d = values[(row + 1) * width + column];
      let code = 0;
      if (a > iso) code |= 8;
      if (b > iso) code |= 4;
      if (c > iso) code |= 2;
      if (d > iso) code |= 1;
      if (code === 0 || code === 15) continue;
      const top = [column + interpolate(a, b), row];
      const right = [column + 1, row + interpolate(b, c)];
      const bottom = [column + interpolate(d, c), row + 1];
      const left = [column, row + interpolate(a, d)];
      const push = (from, to) => segments.push([from, to]);
      switch (code) {
        case 1: case 14: push(left, bottom); break;
        case 2: case 13: push(bottom, right); break;
        case 3: case 12: push(left, right); break;
        case 4: case 11: push(top, right); break;
        case 6: case 9: push(top, bottom); break;
        case 7: case 8: push(left, top); break;
        case 5: push(left, top); push(bottom, right); break;
        case 10: push(left, bottom); push(top, right); break;
        default: break;
      }
    }
  }
  return segments;
}

function bandColour(value, lo, hi, signed) {
  const ramp = signed ? DIVERGING : SEQUENTIAL;
  const span = hi - lo;
  const fraction = span === 0 ? 0.5 : (value - lo) / span;
  const index = Math.max(0, Math.min(ramp.length - 1, Math.round(fraction * (ramp.length - 1))));
  return ramp[index];
}

/**
 * @param {object} input
 * @param {ReturnType<typeof sliceOf>} input.slice
 * @param {number[]} [input.levels]  iso values to draw; defaults to ±1/4 and ±1/2 of the range
 * @param {string} [input.field]    "ψ(HOMO)", "electron density", "ESP" — printed, not guessed
 */
export function contourFigure({
  slice, levels = null, field = 'scalar field', units = 'au', signed = null, title = null,
  width = 300, height = 280, bands = 9,
} = {}) {
  if (!slice || !slice.values || slice.width < 2 || slice.height < 2) return null;
  const values = slice.values;
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const isSigned = signed === null ? lo < 0 && hi > 0 : Boolean(signed);
  const magnitude = Math.max(Math.abs(lo), Math.abs(hi));

  const padLeft = 42;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 40;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const xMap = (gridX) => padLeft + (gridX / Math.max(slice.width - 1, 1)) * plotW;
  const yMap = (gridY) => padTop + (gridY / Math.max(slice.height - 1, 1)) * plotH;

  const parts = [];

  // Colour bands, one rectangle per run of equal band on a row: for a smooth
  // field this is a few hundred rectangles instead of one per grid point.
  // The colour layer is sampled on a coarser grid than the contour lines: a
  // smooth field does not need one rectangle per vertex, and the size of a
  // report figure is a budget, not an accident.
  const bandCells = 56;
  const bandW = Math.max(2, Math.min(slice.width - 1, bandCells));
  const bandH = Math.max(2, Math.min(slice.height - 1, bandCells));
  const sampleAt = (column, row) => {
    const sx = Math.min(slice.width - 1, Math.round((column / bandW) * (slice.width - 1)));
    const sy = Math.min(slice.height - 1, Math.round((row / bandH) * (slice.height - 1)));
    return values[sy * slice.width + sx];
  };
  const cellW = plotW / bandW;
  const cellH = plotH / bandH;
  for (let row = 0; row < bandH; row += 1) {
    let runStart = 0;
    let runColour = null;
    for (let column = 0; column < bandW; column += 1) {
      const value = sampleAt(column, row);
      const colour = bandColour(value, -magnitude, magnitude, isSigned);
      if (runColour === null) { runColour = colour; runStart = column; }
      else if (colour !== runColour) {
        parts.push(`<rect x="${round(padLeft + cellW * runStart)}" y="${round(padTop + cellH * row)}"`
          + ` width="${round(cellW * (column - runStart) + 0.4)}" height="${round(cellH + 0.4)}"`
          + ` fill="${runColour}"/>`);
        runColour = colour;
        runStart = column;
      }
    }
    if (runColour !== null) {
      parts.push(`<rect x="${round(padLeft + cellW * runStart)}" y="${round(padTop + cellH * row)}"`
        + ` width="${round(cellW * (bandW - runStart) + 0.4)}" height="${round(cellH + 0.4)}"`
        + ` fill="${runColour}"/>`);
    }
  }

  const isoLevels = Array.isArray(levels) && levels.length > 0
    ? levels.map(Number).filter((value) => Number.isFinite(value))
    : (isSigned ? [-magnitude / 2, -magnitude / 4, magnitude / 4, magnitude / 2] : [magnitude / 4, magnitude / 2]);

  for (const iso of isoLevels) {
    const segments = marchingSquares(values, slice.width, slice.height, iso);
    if (segments.length === 0) continue;
    const d = segments
      .map(([from, to]) => `M${round(xMap(from[0]), 1)},${round(yMap(from[1]), 1)}`
        + `L${round(xMap(to[0]), 1)},${round(yMap(to[1]), 1)}`)
      .join('');
    const stroke = iso < 0 ? PALETTE.negative : PALETTE.ink;
    parts.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${Math.abs(iso) >= magnitude / 2 ? 0.9 : 0.55}"`
      + ` stroke-opacity="0.85"/>`);
  }

  const axisOriginX = slice.xOrigin;
  const axisSpanX = slice.xStep * (slice.width - 1);
  const xTicks = niceTicks(axisOriginX, axisOriginX + axisSpanX, 4);
  parts.push(axis({
    orient: 'x', x1: padLeft, y1: padTop + plotH, x2: padLeft + plotW, y2: padTop + plotH,
    ticks: xTicks.ticks.map((value) => ({ value, pos: xMap((value - axisOriginX) / slice.xStep) })),
    step: xTicks.step, label: `${slice.labels.x} / Å`,
  }));
  const yTicks = niceTicks(slice.yOrigin, slice.yOrigin + slice.yStep * (slice.height - 1), 4);
  parts.push(axis({
    orient: 'y', x1: padLeft, y1: padTop, x2: padLeft, y2: padTop + plotH,
    ticks: yTicks.ticks.map((value) => ({
      value, pos: yMap(slice.height - 1 - (value - slice.yOrigin) / slice.yStep),
    })),
    step: yTicks.step, label: `${slice.labels.y} / Å`,
  }));

  const planeText = `${slice.axis.toUpperCase()} = ${fmtNum(slice.planePositionA, 2)} Å`;
  const caption = `${title || field} · ${slice.labels.x}${slice.labels.y} plane, ${planeText}`
    + ` · ${slice.width}×${slice.height} grid · range ${fmtNum(lo, 3)}…${fmtNum(hi, 3)} ${units}`
    + ` · iso lines at ${isoLevels.map((value) => fmtNum(value, 3)).join(', ')}`;

  return figureResult({
    kind: 'contour',
    svg: figureFrame({
      width, height, title: caption,
      desc: `${field} on the ${slice.labels.x}${slice.labels.y} plane at ${planeText}. Colour bands show magnitude; lines mark fixed iso values.`,
      body: parts.join(''), className: 'figure-contour',
    }),
    width, height, caption,
    params: { field, axis: slice.axis, held: slice.held, min: lo, max: hi, isoLevels, units },
  });
}

export { escapeXml };
