/**
 * Agreement figure: computed against reference, with the y = x line and the
 * error statistics a reader would compute anyway. The N and the units are in the
 * caption — a correlation without its sample size is decoration.
 */

import {
  PALETTE, axis, escapeXml, figureFrame, figureResult, fmtNum, niceTicks, round, scaleLinear,
} from './primitives.js';

/**
 * @param {object} input
 * @param {Array<{computed:number, reference:number, label?:string}>} input.points
 * @param {string} [input.units]  printed on both axes and in the caption
 */
export function correlationFigure({
  points = [], units = '', title = 'Computed vs reference', xLabel = null, yLabel = null,
  width = 300, height = 260,
} = {}) {
  const usable = (Array.isArray(points) ? points : [])
    .map((point) => ({
      computed: Number(point.computed),
      reference: Number(point.reference),
      label: point.label ?? null,
    }))
    .filter((point) => Number.isFinite(point.computed) && Number.isFinite(point.reference));
  if (usable.length === 0) return null;

  const values = usable.flatMap((point) => [point.computed, point.reference]);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = Math.max(hi - lo, 1e-9);
  const padLeft = 50;
  const padRight = 14;
  const padTop = 14;
  const padBottom = 40;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  // A square plot keeps a 45° line at 45°: the visual claim of agreement is only
  // honest if the two axes have the same scale.
  const side = Math.min(plotW, plotH);
  const xMap = scaleLinear([lo - span * 0.08, hi + span * 0.08], [padLeft, padLeft + side]);
  const yMap = scaleLinear([lo - span * 0.08, hi + span * 0.08], [padTop + side, padTop]);

  const parts = [];
  const ticks = niceTicks(lo - span * 0.08, hi + span * 0.08, 4);
  parts.push(axis({
    orient: 'x', x1: padLeft, y1: padTop + side, x2: padLeft + side, y2: padTop + side,
    ticks: ticks.ticks.map((value) => ({ value, pos: xMap(value) })), step: ticks.step,
    label: xLabel || (units ? `reference / ${units}` : 'reference'),
  }));
  parts.push(axis({
    orient: 'y', x1: padLeft, y1: padTop, x2: padLeft, y2: padTop + side,
    ticks: ticks.ticks.map((value) => ({ value, pos: yMap(value) })), step: ticks.step,
    label: yLabel || (units ? `computed / ${units}` : 'computed'),
  }));

  parts.push(`<line x1="${round(xMap(lo))}" y1="${round(yMap(lo))}" x2="${round(xMap(hi))}" y2="${round(yMap(hi))}"`
    + ` stroke="${PALETTE.axis}" stroke-width="0.9" stroke-dasharray="3 3"/>`);
  parts.push(`<text x="${round(xMap(hi) - 2)}" y="${round(yMap(hi) + 10)}" text-anchor="end" font-size="8"`
    + ` fill="${PALETTE.muted}">y = x</text>`);

  for (const point of usable) {
    parts.push(`<circle cx="${round(xMap(point.reference))}" cy="${round(yMap(point.computed))}" r="2.4"`
      + ` fill="${PALETTE.curve}" fill-opacity="0.85"/>`);
  }

  const errors = usable.map((point) => point.computed - point.reference);
  const mean = errors.reduce((sum, value) => sum + value, 0) / errors.length;
  const rms = Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / errors.length);
  const maxAbs = Math.max(...errors.map((value) => Math.abs(value)));
  const stats = `N = ${usable.length} · mean error ${fmtNum(mean, 3)} · RMS ${fmtNum(rms, 3)}`
    + ` · largest |error| ${fmtNum(maxAbs, 3)}${units ? ` ${units}` : ''}`;
  const caption = `${title} · ${stats}`;

  return figureResult({
    kind: 'correlation',
    svg: figureFrame({
      width, height, title: caption,
      desc: `Scatter of computed against reference values on equal axes, with the y = x line. ${stats}`,
      body: parts.join(''), className: 'figure-correlation',
    }),
    width, height, caption,
    params: { points: usable.length, mean, rms, maxAbs, units },
  });
}

export { escapeXml };
