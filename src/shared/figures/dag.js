/**
 * The execution graph, drawn.
 *
 * The report has a table of blocks; this figure is the same information as a
 * picture — what ran in parallel, what waited, what failed. Layout is computed
 * from the edges (column = longest path from a root), so the figure never
 * depends on canvas coordinates the queue does not record.
 */

import {
  PALETTE, escapeXml, figureFrame, figureResult, round,
} from './primitives.js';

const STATUS_COLOUR = {
  passed: PALETTE.ok,
  completed: PALETTE.ok,
  running: PALETTE.curve,
  queued: PALETTE.muted,
  review: PALETTE.warn,
  'needs-review': PALETTE.warn,
  blocked: PALETTE.bad,
  failed: PALETTE.bad,
  cancelled: PALETTE.muted,
  skipped: PALETTE.axis,
};

/**
 * @param {object} input
 * @param {Array<{id:string, label:string, status?:string}>} input.nodes
 * @param {Array<{from:string, to:string}>} input.edges
 */
export function flowGraphFigure({ nodes = [], edges = [], title = 'Execution graph', width = 560, height = null } = {}) {
  const list = (Array.isArray(nodes) ? nodes : []).filter((node) => node && node.id !== undefined);
  if (list.length === 0) return null;
  const linkList = (Array.isArray(edges) ? edges : [])
    .filter((edge) => edge && list.some((node) => node.id === edge.from) && list.some((node) => node.id === edge.to));

  // Longest-path layering; cycles cannot happen in a plan, but a defensive cap
  // keeps a malformed queue from hanging the report.
  const depth = new Map(list.map((node) => [node.id, 0]));
  for (let pass = 0; pass < list.length; pass += 1) {
    let changed = false;
    for (const edge of linkList) {
      const next = depth.get(edge.from) + 1;
      if (next > (depth.get(edge.to) ?? 0) && next < list.length) {
        depth.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const columns = [];
  for (const node of list) {
    const column = depth.get(node.id) ?? 0;
    if (!columns[column]) columns[column] = [];
    columns[column].push(node);
  }

  const boxW = 116;
  const boxH = 30;
  const gapX = 46;
  const gapY = 12;
  const pad = 12;
  const rows = Math.max(...columns.map((column) => (column ? column.length : 0)), 1);
  const computedHeight = pad * 2 + rows * boxH + (rows - 1) * gapY;
  const computedWidth = pad * 2 + columns.length * boxW + (columns.length - 1) * gapX;
  const w = Math.max(width, computedWidth);
  const h = height ?? Math.max(120, computedHeight);

  const position = new Map();
  columns.forEach((column, columnIndex) => {
    if (!column) return;
    const blockHeight = column.length * boxH + (column.length - 1) * gapY;
    const top = pad + (h - pad * 2 - blockHeight) / 2;
    column.forEach((node, rowIndex) => {
      position.set(node.id, {
        x: pad + columnIndex * (boxW + gapX),
        y: top + rowIndex * (boxH + gapY),
      });
    });
  });

  const parts = [];
  for (const edge of linkList) {
    const from = position.get(edge.from);
    const to = position.get(edge.to);
    if (!from || !to) continue;
    const x1 = from.x + boxW;
    const y1 = from.y + boxH / 2;
    const x2 = to.x;
    const y2 = to.y + boxH / 2;
    const midX = (x1 + x2) / 2;
    parts.push(`<path d="M${round(x1)},${round(y1)}L${round(midX)},${round(y1)}L${round(midX)},${round(y2)}L${round(x2)},${round(y2)}"`
      + ` fill="none" stroke="${PALETTE.axis}" stroke-width="1" marker-end="url(#arrow)"/>`);
  }

  for (const node of list) {
    const spot = position.get(node.id);
    if (!spot) continue;
    const status = String(node.status || '').toLowerCase();
    const colour = STATUS_COLOUR[status] || PALETTE.axis;
    const label = String(node.label ?? node.id);
    const short = label.length > 16 ? `${label.slice(0, 15)}…` : label;
    parts.push(`<rect x="${round(spot.x)}" y="${round(spot.y)}" width="${boxW}" height="${boxH}" rx="4"`
      + ` fill="#ffffff" stroke="${colour}" stroke-width="1.4"/>`);
    parts.push(`<rect x="${round(spot.x)}" y="${round(spot.y)}" width="3" height="${boxH}" rx="1.5" fill="${colour}"/>`);
    parts.push(`<text x="${round(spot.x + 9)}" y="${round(spot.y + 13)}" font-size="8.5" fill="${PALETTE.ink}">`
      + `${escapeXml(short)}</text>`);
    parts.push(`<text x="${round(spot.x + 9)}" y="${round(spot.y + 24)}" font-size="7.5" fill="${PALETTE.muted}">`
      + `${escapeXml(status || 'no status')}</text>`);
  }

  const counts = new Map();
  for (const node of list) {
    const status = String(node.status || 'unknown').toLowerCase();
    counts.set(status, (counts.get(status) || 0) + 1);
  }
  const summary = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([status, count]) => `${count} ${status}`).join(' · ');
  const caption = `${title} · ${list.length} blocks · ${summary}`;

  const body = `<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">`
    + `<path d="M0,0L8,4L0,8z" fill="${PALETTE.axis}"/></marker></defs>${parts.join('')}`;

  return figureResult({
    kind: 'graph',
    svg: figureFrame({
      width: w, height: h, title: caption,
      desc: `Execution graph: ${summary}. Arrows point from a block to the blocks that waited on it.`,
      body, className: 'figure-graph',
    }),
    width: w, height: h, caption,
    params: { nodes: list.length, edges: linkList.length, columns: columns.length },
  });
}
