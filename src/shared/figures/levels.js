/**
 * Orbital energy-level diagram.
 *
 * The figure exists to answer one question at a glance — where the frontier sits
 * and how large the gap is — so the HOMO/LUMO pair is annotated in eV and every
 * level keeps its source index and occupation. Energies are Hartree in the
 * record and eV on the axis; the conversion is stated in the caption.
 */

import {
  PALETTE, axis, escapeXml, figureFrame, figureResult, fmtNum, pathOf, round, scaleLinear,
} from './primitives.js';

export const HARTREE_EV = 27.211386245988;

function occupationOf(level) {
  const value = Number(level.occupation ?? level.occupancy ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/**
 * @param {object} input
 * @param {Array<{index?:number, label?:string, energyEv?:number, energyEh?:number, occupation?:number}>} input.alpha
 * @param {Array<object>} [input.beta]  spin-beta manifold, drawn as a second column
 */
export function orbitalLevelsFigure({ alpha = [], beta = [], title = 'Orbital energies', width = 320, height = 200 } = {}) {
  const toEv = (level) => {
    const ev = Number(level.energyEv);
    if (Number.isFinite(ev)) return ev;
    const eh = Number(level.energyEh);
    return Number.isFinite(eh) ? eh * HARTREE_EV : null;
  };
  const up = (Array.isArray(alpha) ? alpha : [])
    .map((level, index) => ({ ...level, index: level.index ?? index + 1, ev: toEv(level), occ: occupationOf(level) }))
    .filter((level) => level.ev !== null);
  const down = (Array.isArray(beta) ? beta : [])
    .map((level, index) => ({ ...level, index: level.index ?? index + 1, ev: toEv(level), occ: occupationOf(level) }))
    .filter((level) => level.ev !== null);
  const all = up.concat(down);
  if (all.length === 0) return null;

  const energies = all.map((level) => level.ev);
  const lo = Math.min(...energies);
  const hi = Math.max(...energies);
  const pad = Math.max((hi - lo) * 0.12, 0.5);
  const padLeft = 44;
  const padRight = 18;
  const padTop = 16;
  const padBottom = 34;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const yMap = scaleLinear([lo - pad, hi + pad], [padTop + plotH, padTop]);

  const columns = down.length > 0 ? 2 : 1;
  const columnW = plotW / columns;
  const halfWidth = Math.min(columnW * 0.32, 52);

  const parts = [];
  const { ticks, step } = (() => {
    const span = hi - lo + 2 * pad;
    const tickStep = span > 20 ? 10 : span > 8 ? 5 : 1;
    const first = Math.ceil((lo - pad) / tickStep) * tickStep;
    const list = [];
    for (let value = first; value <= hi + pad + 1e-9; value += tickStep) list.push(Number(value.toFixed(6)));
    return { ticks: list, step: tickStep };
  })();
  parts.push(axis({
    orient: 'y', x1: padLeft, y1: padTop, x2: padLeft, y2: padTop + plotH,
    ticks: ticks.map((value) => ({ value, pos: yMap(value) })), step, label: 'E / eV',
  }));

  function drawColumn(levels, centreX, polygonPath) {
    const sorted = levels.slice().sort((a, b) => a.ev - b.ev);
    // HOMO = highest level with occupation > 0; LUMO = lowest with occupation 0.
    const occupied = sorted.filter((level) => level.occ > 0);
    const virtual = sorted.filter((level) => level.occ <= 0);
    const homo = occupied.length ? occupied[occupied.length - 1] : null;
    const lumo = virtual.length ? virtual[0] : null;

    for (const level of sorted) {
      const y = yMap(level.ev);
      const isFrontier = level === homo || level === lumo;
      const colour = level.occ > 0 ? PALETTE.ink : PALETTE.muted;
      parts.push(`<line x1="${round(centreX - halfWidth)}" y1="${round(y)}" x2="${round(centreX + halfWidth)}" y2="${round(y)}"`
        + ` stroke="${colour}" stroke-width="${isFrontier ? 2 : 1}"`
        + `${level.occ <= 0 ? ' stroke-dasharray="4 3"' : ''}/>`);
      const arrows = Math.max(0, Math.min(2, Math.round(level.occ)));
      for (let arrow = 0; arrow < arrows; arrow += 1) {
        const ax = centreX - 6 + arrow * 12;
        parts.push(polygonPath(ax, y, colour));
      }
      if (isFrontier) {
        parts.push(`<text x="${round(centreX + halfWidth + 4)}" y="${round(y + 3)}" font-size="8"`
          + ` fill="${PALETTE.accent}">${escapeXml(level === homo ? 'HOMO' : 'LUMO')}</text>`);
      }
    }
    if (homo && lumo) {
      const yH = yMap(homo.ev);
      const yL = yMap(lumo.ev);
      const gap = lumo.ev - homo.ev;
      parts.push(`<line x1="${round(centreX - halfWidth - 10)}" y1="${round(yH)}"`
        + ` x2="${round(centreX - halfWidth - 10)}" y2="${round(yL)}"`
        + ` stroke="${PALETTE.accent}" stroke-width="0.8" stroke-dasharray="2 2"/>`);
      parts.push(`<text x="${round(centreX + halfWidth + 4)}" y="${round((yH + yL) / 2 + 3)}"`
        + ` font-size="8" fill="${PALETTE.accent}">${escapeXml(`gap ${gap.toFixed(2)} eV`)}</text>`);
    }
    return { homo, lumo };
  }

  // A small upward arrow whose tail sits on the level: occupation, not a vector.
  const arrow = (x, y, colour) => `<path d="${pathOf([[x - 3, y + 2], [x, y - 8], [x + 3, y + 2]])}"`
    + ` fill="${colour}" stroke="none"/>`;

  const result = drawColumn(up, padLeft + (columns === 2 ? columnW * 0.5 : plotW / 2), arrow);
  if (columns === 2) {
    parts.push(`<text x="${round(padLeft + columnW * 0.5)}" y="${round(padTop + plotH + 16)}" text-anchor="middle"`
      + ` font-size="9" fill="${PALETTE.muted}">α</text>`);
    drawColumn(down, padLeft + columnW * 1.5, arrow);
    parts.push(`<text x="${round(padLeft + columnW * 1.5)}" y="${round(padTop + plotH + 16)}" text-anchor="middle"`
      + ` font-size="9" fill="${PALETTE.muted}">β</text>`);
  }

  const gapText = result.homo && result.lumo
    ? ` · gap ${(result.lumo.ev - result.homo.ev).toFixed(2)} eV`
    : '';
  const caption = `${title} · ${all.length} levels${columns === 2 ? ' (α + β)' : ''}${gapText}`
    + ' · energies converted at 27.2114 eV/Hartree';

  return figureResult({
    kind: 'levels',
    svg: figureFrame({
      width, height, title: caption,
      desc: 'Orbital energies on a shared eV axis; solid levels are occupied, dashed empty, arrows show occupation.',
      body: parts.join(''), className: 'figure-levels',
    }),
    width, height, caption,
    params: { levels: all.length, hetero: down.length > 0, gapEv: result.homo && result.lumo ? result.lumo.ev - result.homo.ev : null },
  });
}

export { fmtNum };
