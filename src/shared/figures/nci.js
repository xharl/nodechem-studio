/**
 * The NCI plot: reduced density gradient s against sign(λ₂)·ρ (issue 59).
 *
 * The picture is the standard NCI scatter plot, drawn as a **2D histogram**: the
 * `binColumns × binRows` cells hold the number of grid points that fell in each
 * (sign(λ₂)ρ, s) cell, and each non-empty cell is a `<rect>` shaded by a
 * sequential ramp. That is stated in the caption and in `desc`, because a
 * scatter of a million tiny marks would claim a resolution the source grid does
 * not have, and would bloat the self-contained report.
 *
 * Everything the picture depends on is in the caption: the grid (counts, spacing,
 * padding), the s isosurface value drawn as a line, the plot cutoffs, the number
 * of points plotted and how many the cutoffs removed, and the method for λ₂.
 */

import {
  PALETTE, SEQUENTIAL, axis, figureFrame, figureResult, fmtNum, niceTicks, round, scaleLinear,
} from './primitives.js';
import { NCI_METHOD, NCI_RHO_CUTOFF, NCI_S_ISOVALUE, NCI_S_MAX } from '../nci.js';

/** Colour index for a bin count, on a log scale (a few cells hold most points). */
function shadeIndex(count, peak) {
  if (!(count > 0)) return -1;
  const ratio = Math.log1p(count) / Math.log1p(Math.max(peak, 1));
  return Math.max(0, Math.min(SEQUENTIAL.length - 1, Math.round(ratio * (SEQUENTIAL.length - 1))));
}

/**
 * @param {object} analysis result of `nciAnalysis`
 * @param {object} [options]
 * @param {number} [options.binColumns] histogram cells across sign(λ₂)ρ
 * @param {number} [options.binRows]    histogram cells along s
 */
export function nciFigure(analysis, {
  title = 'NCI: reduced density gradient against sign(λ₂)ρ',
  width = 460,
  height = 320,
  binColumns = 180,
  binRows = 140,
  sIsovalue = NCI_S_ISOVALUE,
} = {}) {
  if (!analysis || analysis.ok === false || !analysis.points || !(analysis.points.count > 0)) return null;
  const { points, grid, counts, parameters } = analysis;
  const sMax = Number(parameters?.sMax ?? NCI_S_MAX);
  const rhoCutoff = Number(parameters?.rhoCutoff ?? NCI_RHO_CUTOFF);
  // Symmetric about zero and bounded by the density cutoff the points were
  // taken under: the sign of λ₂ is the axis's meaning, and an asymmetric axis
  // would make an attractive contact look like a repulsive one. Using the
  // cutoff (rather than the data extent, which can sit a rounding error inside
  // it) also gives the axis round tick values.
  const half = Number.isFinite(rhoCutoff) && rhoCutoff > 0 ? rhoCutoff : NCI_RHO_CUTOFF;
  const xDomain = [-half, half];

  const padLeft = 58;
  const padRight = 16;
  const padTop = 16;
  const padBottom = 46;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const xMap = scaleLinear(xDomain, [padLeft, padLeft + plotW]);
  const yMap = scaleLinear([0, sMax], [padTop + plotH, padTop]);

  const columns = Math.max(2, Math.floor(binColumns));
  const rows = Math.max(2, Math.floor(binRows));
  const bins = new Int32Array(columns * rows);
  let peak = 0;
  for (let index = 0; index < points.count; index += 1) {
    const x = points.x[index];
    const s = points.s[index];
    if (!(x >= xDomain[0] && x <= xDomain[1] && s >= 0 && s <= sMax)) continue;
    const column = Math.min(columns - 1, Math.floor(((x - xDomain[0]) / (xDomain[1] - xDomain[0])) * columns));
    const row = Math.min(rows - 1, Math.floor((s / sMax) * rows));
    const at = column + columns * row;
    bins[at] += 1;
    if (bins[at] > peak) peak = bins[at];
  }

  const cellW = plotW / columns;
  const cellH = plotH / rows;
  const parts = [];
  // Runs of equal-shade cells in a row become one rect: the file stays small
  // and the picture is identical.
  for (let row = 0; row < rows; row += 1) {
    let runStart = -1;
    let runShade = -2;
    for (let column = 0; column <= columns; column += 1) {
      const shade = column < columns ? shadeIndex(bins[column + columns * row], peak) : -2;
      if (shade !== runShade) {
        if (runShade >= 0 && runStart >= 0) {
          const x = padLeft + runStart * cellW;
          const y = padTop + plotH - (row + 1) * cellH;
          parts.push(`<rect x="${round(x, 2)}" y="${round(y, 2)}" width="${round((column - runStart) * cellW + 0.3, 2)}"` +
            ` height="${round(cellH + 0.3, 2)}" fill="${SEQUENTIAL[runShade]}" stroke="none"/>`);
        }
        runStart = column;
        runShade = shade;
      }
    }
  }

  parts.push(`<line x1="${round(xMap(0), 2)}" y1="${padTop}" x2="${round(xMap(0), 2)}" y2="${padTop + plotH}"` +
    ` stroke="${PALETTE.axis}" stroke-width="0.6" stroke-dasharray="2 3"/>`);

  const xTicks = niceTicks(xDomain[0], xDomain[1], 5);
  parts.push(axis({
    orient: 'x',
    x1: padLeft, y1: padTop + plotH, x2: padLeft + plotW, y2: padTop + plotH,
    ticks: xTicks.ticks.map((value) => ({ value, pos: xMap(value) })),
    step: xTicks.step,
    label: 'sign(λ₂)·ρ  (e/bohr³)   ← attractive · repulsive →',
  }));
  const yTicks = niceTicks(0, sMax, 4);
  parts.push(axis({
    orient: 'y',
    x1: padLeft, y1: padTop, x2: padLeft, y2: padTop + plotH,
    ticks: yTicks.ticks.map((value) => ({ value, pos: yMap(value) })),
    step: yTicks.step,
    label: 'reduced density gradient s',
  }));

  // The s isosurface value, drawn where it is: a caption that named 0.5 without
  // marking it would leave the reader guessing which feature the surface takes.
  const isoY = yMap(sIsovalue);
  parts.push(`<line x1="${padLeft}" y1="${round(isoY, 2)}" x2="${padLeft + plotW}" y2="${round(isoY, 2)}"` +
    ` stroke="${PALETTE.accent}" stroke-width="0.8" stroke-dasharray="4 3"/>`);
  parts.push(`<text x="${padLeft + plotW}" y="${round(isoY - 3, 2)}" text-anchor="end" font-size="8"` +
    ` fill="${PALETTE.accent}">s = ${fmtNum(sIsovalue, 2)} isosurface</text>`);
  // And when nothing reaches it, the figure says so inside itself, not only in
  // the caption: a dashed line with a void under it otherwise reads as a
  // feature the plot failed to draw.
  if (!(counts.belowIsovalue > 0)) {
    parts.push(`<text x="${padLeft + 4}" y="${round(isoY + 11, 2)}" font-size="8" fill="${PALETTE.muted}">` +
      `no point at or below s = ${fmtNum(sIsovalue, 2)}: lowest s = ${fmtNum(analysis.range?.sMin, 3)}` +
      `</text>`);
  }

  const gridNote = `${counts.gridPoints} grid points (${grid.counts.join('×')} at ${grid.spacingBohr} bohr, ` +
    `padding ${grid.paddingBohr} bohr)`;
  const cutoffNote = `plotted ${counts.plotted}: s ≤ ${fmtNum(parameters.sMax, 2)}, ρ ≤ ${fmtNum(parameters.rhoCutoff, 3)} ` +
    `e/bohr³ (${counts.excludedByDensity} removed by the density cutoff, ${counts.excludedByGradient} by the s cutoff)`;
  const signNote = `${counts.attractive} points with λ₂ < 0 (attractive), ${counts.repulsive} with λ₂ > 0 (repulsive)`;
  // When nothing reaches the isosurface the caption says so with the number; a
  // reader must not infer a feature from a line with nothing under it.
  const isoNote = counts.belowIsovalue > 0
    ? `${counts.belowIsovalue} points at or below s = ${fmtNum(sIsovalue, 2)}`
    : `no point reaches s = ${fmtNum(sIsovalue, 2)} inside the cutoffs (lowest s = ${fmtNum(analysis.range?.sMin, 3)}` +
      `${Number.isFinite(analysis.range?.sMinAt) ? ` at sign(λ₂)ρ = ${fmtNum(analysis.range.sMinAt, 4)}` : ''})`;
  const caption = `${title} · ${gridNote} · ${cutoffNote} · ${signNote} · s = ${fmtNum(sIsovalue, 2)} isosurface `
    + `· ${isoNote} · λ₂ from the analytic Hessian of ρ (Jacobi eigendecomposition; no finite difference) · `
    + `${columns}×${rows} histogram of the points`;
  return figureResult({
    kind: 'nci',
    svg: figureFrame({
      width,
      height,
      title: caption,
      desc: `Reduced density gradient s = |∇ρ|/(2(3π²)^(1/3)ρ^(4/3)) against sign(λ₂)ρ, as a ${columns}×${rows} `
        + `2D histogram of ${counts.plotted} of ${counts.gridPoints} grid points (${grid.counts.join('×')} at `
        + `${grid.spacingBohr} bohr, padding ${grid.paddingBohr} bohr). Density cutoff ρ ≤ ${fmtNum(parameters.rhoCutoff, 3)} `
        + `e/bohr³, s cutoff ${fmtNum(parameters.sMax, 2)}; the dashed horizontal line is the s = ${fmtNum(sIsovalue, 2)} `
        + `isosurface value. λ₂ is the middle eigenvalue of the analytic Hessian of ρ.`,
      body: parts.join(''),
      className: 'figure-nci',
    }),
    width,
    height,
    caption,
    params: Object.freeze({
      plotted: counts.plotted,
      gridPoints: counts.gridPoints,
      grid: grid.note,
      spacingBohr: grid.spacingBohr,
      sIsovalue,
      sMax: parameters.sMax,
      rhoCutoff: parameters.rhoCutoff,
      bins: `${columns}×${rows}`,
      method: NCI_METHOD,
    }),
  });
}
