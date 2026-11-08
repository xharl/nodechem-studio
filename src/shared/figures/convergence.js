/**
 * Convergence and series figures: an optimisation, a scan, any x→y series with
 * an optional threshold. The final value and the stopping criterion are printed
 * in the caption, because "it converged" without the criterion is a claim.
 */

import {
  PALETTE, axis, escapeXml, figureFrame, figureResult, fmtNum, niceTicks, pathOf, round, scaleLinear,
} from './primitives.js';

/**
 * @param {object} input
 * @param {Array<{x:number,y:number}>} input.series
 * @param {number} [input.threshold]     horizontal line, e.g. a convergence criterion
 * @param {string} [input.thresholdLabel]
 */
export function convergenceFigure({
  series = [], threshold = null, thresholdLabel = '', xLabel = 'step', yLabel = 'E / Hartree',
  title = 'Convergence', width = 400, height = 160,
} = {}) {
  const points = (Array.isArray(series) ? series : [])
    .map((point, index) => ({ x: Number(point.x ?? index + 1), y: Number(point.y ?? point.value) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length === 0) return null;

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  // `null`, `undefined` and `''` all mean "no threshold": Number(null) is 0 and
  // a finite 0 would draw a line at the axis and claim a criterion nobody set.
  const thresholdValue = threshold === null || threshold === undefined || threshold === ''
    ? null
    : (Number.isFinite(Number(threshold)) ? Number(threshold) : null);
  const yLo = Math.min(...ys, thresholdValue ?? Infinity);
  const yHi = Math.max(...ys, thresholdValue ?? -Infinity);
  const span = Math.max(yHi - yLo, 1e-9);
  const padLeft = 58;
  const padRight = 14;
  const padTop = 14;
  const padBottom = 38;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const xMap = scaleLinear([Math.min(...xs), Math.max(...xs)], [padLeft, padLeft + plotW]);
  const yMap = scaleLinear([yLo - span * 0.1, yHi + span * 0.1], [padTop + plotH, padTop]);

  const parts = [];
  const { ticks, step } = niceTicks(Math.min(...xs), Math.max(...xs), 5);
  parts.push(axis({
    orient: 'x', x1: padLeft, y1: padTop + plotH, x2: padLeft + plotW, y2: padTop + plotH,
    ticks: ticks.map((value) => ({ value, pos: xMap(value) })), step, label: xLabel,
  }));
  const yTicks = niceTicks(yLo - span * 0.1, yHi + span * 0.1, 4);
  parts.push(axis({
    orient: 'y', x1: padLeft, y1: padTop, x2: padLeft, y2: padTop + plotH,
    ticks: yTicks.ticks.map((value) => ({ value, pos: yMap(value) })), step: yTicks.step, label: yLabel,
  }));

  if (thresholdValue !== null) {
    const y = yMap(thresholdValue);
    parts.push(`<line x1="${padLeft}" y1="${round(y)}" x2="${padLeft + plotW}" y2="${round(y)}"`
      + ` stroke="${PALETTE.accent}" stroke-width="0.8" stroke-dasharray="4 3"/>`);
    parts.push(`<text x="${padLeft + plotW}" y="${round(y - 3)}" text-anchor="end" font-size="8"`
      + ` fill="${PALETTE.accent}">${escapeXml(thresholdLabel || `threshold ${fmtNum(thresholdValue, 6)}`)}</text>`);
  }

  parts.push(`<path d="${pathOf(points.map((point) => [xMap(point.x), yMap(point.y)]))}" fill="none"`
    + ` stroke="${PALETTE.curve}" stroke-width="1.4" stroke-linejoin="round"/>`);
  const last = points[points.length - 1];
  parts.push(`<circle cx="${round(xMap(last.x))}" cy="${round(yMap(last.y))}" r="2.6" fill="${PALETTE.curve}"/>`);

  const first = points[0];
  const caption = `${title} · ${points.length} points · ${fmtNum(first.y, 6)} → ${fmtNum(last.y, 6)}`
    + (thresholdValue !== null ? ` · threshold ${fmtNum(thresholdValue, 6)}` : '');

  return figureResult({
    kind: 'convergence',
    svg: figureFrame({
      width, height, title: caption,
      desc: `${yLabel} against ${xLabel}; the marker is the final value.`,
      body: parts.join(''), className: 'figure-convergence',
    }),
    width, height, caption,
    params: { points: points.length, first: first.y, last: last.y, threshold: thresholdValue },
  });
}
