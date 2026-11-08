/**
 * Reaction-coordinate / barrier figure.
 *
 * Stages arrive as absolute energies (Hartree, from run records). The figure
 * draws them as a step profile — each stage a level, each transition a vertical
 * connector — and labels every ΔE in kcal/mol. Nothing is interpolated: the line
 * between two stages is not a computed path, and the caption says so.
 */

import {
  PALETTE, axis, escapeXml, figureFrame, figureResult, fmtNum, niceTicks, pathOf, round, scaleLinear,
} from './primitives.js';

export const HARTREE_KCAL = 627.5094740631;

/**
 * @param {object} input
 * @param {Array<{label:string, energyEh:number, status?:string}>} input.stages  in reaction order
 */
export function reactionEnergyFigure({
  stages = [], title = 'Reaction energy profile', relative = true, width = 440, height = 190,
} = {}) {
  const usable = (Array.isArray(stages) ? stages : [])
    .map((stage, index) => ({
      label: String(stage.label ?? `stage ${index + 1}`),
      energyEh: Number(stage.energyEh),
      status: stage.status ?? null,
    }))
    .filter((stage) => Number.isFinite(stage.energyEh));
  if (usable.length < 2) return null;

  const reference = relative ? usable[0].energyEh : 0;
  const points = usable.map((stage) => ({ ...stage, energy: (stage.energyEh - reference) * HARTREE_KCAL }));
  const values = points.map((point) => point.energy);
  const lo = Math.min(...values, 0);
  const hi = Math.max(...values, 0);
  const span = Math.max(hi - lo, 1);
  const padTop = 18;
  const padBottom = 46;
  const padLeft = 52;
  const padRight = 16;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const yMap = scaleLinear([lo - span * 0.12, hi + span * 0.12], [padTop + plotH, padTop]);

  const slot = plotW / points.length;
  const lineHalf = slot * 0.34;

  const parts = [];
  const { ticks, step } = niceTicks(lo - span * 0.12, hi + span * 0.12, 4);
  parts.push(axis({
    orient: 'y', x1: padLeft, y1: padTop, x2: padLeft, y2: padTop + plotH,
    ticks: ticks.map((value) => ({ value, pos: yMap(value) })), step,
    label: relative ? 'ΔE / kcal mol⁻¹' : 'E / kcal mol⁻¹ (absolute)',
  }));

  const segments = [];
  points.forEach((point, index) => {
    const cx = padLeft + slot * (index + 0.5);
    const y = yMap(point.energy);
    const colour = point.status === 'failed' ? PALETTE.bad : PALETTE.ink;
    segments.push([cx - lineHalf, y]);
    segments.push([cx + lineHalf, y]);
    parts.push(`<line x1="${round(cx - lineHalf)}" y1="${round(y)}" x2="${round(cx + lineHalf)}" y2="${round(y)}"`
      + ` stroke="${colour}" stroke-width="${index === 0 || index === points.length - 1 ? 2.2 : 1.4}"/>`);
    parts.push(`<text x="${round(cx)}" y="${round(padTop + plotH + 18)}" text-anchor="middle"`
      + ` font-size="8.5" fill="${PALETTE.muted}">${escapeXml(point.label)}</text>`);
    parts.push(`<text x="${round(cx)}" y="${round(y - 5)}" text-anchor="middle"`
      + ` font-size="8" fill="${PALETTE.ink}">${escapeXml(fmtNum(point.energy, 1))}</text>`);
    if (index > 0) {
      const previous = points[index - 1];
      const delta = point.energy - previous.energy;
      const midX = padLeft + slot * index;
      parts.push(`<line x1="${round(midX)}" y1="${round(yMap(previous.energy))}" x2="${round(midX)}" y2="${round(y)}"`
        + ` stroke="${PALETTE.axis}" stroke-width="1" stroke-dasharray="3 2"/>`);
      parts.push(`<text x="${round(midX + 3)}" y="${round((yMap(previous.energy) + y) / 2)}"`
        + ` font-size="8" fill="${PALETTE.accent}">${escapeXml(`${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`)}</text>`);
    }
  });

  const barrier = hi - Math.min(...values);
  const caption = `${title} · ${points.length} stages${relative ? ' relative to the first' : ''}`
    + ` · highest point ${fmtNum(barrier, 1)} kcal/mol above the lowest`;

  return figureResult({
    kind: 'energy',
    svg: figureFrame({
      width, height, title: caption,
      desc: 'Step profile of stage energies; vertical dashed connectors are energy differences, not computed paths.',
      body: parts.join(''), className: 'figure-energy',
    }),
    width, height, caption,
    params: { stages: points.length, relative, referenceEh: reference, highestAboveLowestKcal: barrier },
  });
}

/** Convenience: energies in Hartree from a list of `{label, energyEh}`. */
export function stageEnergies(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry, index) => ({
      label: entry.label ?? `stage ${index + 1}`,
      energyEh: Number(entry.energyEh ?? entry.energy ?? entry.finalEnergyEh),
    }))
    .filter((entry) => Number.isFinite(entry.energyEh));
}

export { pathOf };
