/**
 * Figure primitives: the small vocabulary every figure in the app and the report
 * is built from.
 *
 * Rules that hold for every function here:
 *   - no DOM, no Node built-ins, no dependency: string in, string out, so the
 *     same call works in the renderer and in `ncs report`;
 *   - deterministic — the same input produces the same bytes, which is what
 *     lets a report carry a digest of its own figure;
 *   - accessible — every figure is `role="img"` with a `<title>` and `<desc>`;
 *   - self-contained — no external references of any kind, which the report
 *     tests assert on the generated document.
 */

/** Ink, grid and series colours; the same values the report stylesheet uses. */
export const PALETTE = Object.freeze({
  ink: '#1f2430',
  muted: '#5b6373',
  grid: '#e6e9ef',
  axis: '#9aa1ad',
  curve: '#2f5fd0',
  curveSoft: '#9db4ea',
  accent: '#b4541a',
  positive: '#2f5fd0',
  negative: '#c0392b',
  ok: '#1f7a4d',
  warn: '#b06f00',
  bad: '#b3261e',
});

/** Diverging ramp for signed fields (orbital phase, VCD): negative → positive. */
export const DIVERGING = Object.freeze([
  '#08306b', '#2171b5', '#6baed6', '#c6dbef', '#f7f7f7',
  '#fdd0a2', '#fd8d3c', '#e6550d', '#a63603',
]);

/** Sequential ramp for non-negative fields (density, activity). */
export const SEQUENTIAL = Object.freeze([
  '#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6',
  '#4292c6', '#2171b5', '#08519c', '#08306b',
]);

export function escapeXml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Rounded to `digits` decimals, without trailing zeros or a negative zero. */
export function round(value, digits = 1) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Number for a caption: fixed decimals, `—` when the value is not a number. */
export function fmtNum(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : '—';
}

/** Shortest sensible label for a tick of the given step. */
export function fmtTick(value, step) {
  if (!Number.isFinite(value)) return '';
  if (!Number.isFinite(step) || step === 0) return String(round(value, 3));
  const digits = Math.max(0, Math.min(6, Math.ceil(-Math.log10(Math.abs(step))) + 1));
  return value.toFixed(digits).replace(/\.0+$/, '');
}

/**
 * Ticks on a 1/2/5 × 10^k grid between `min` and `max`.
 * Returns `{ ticks, step }`; an empty range yields one tick at `min`.
 */
export function niceTicks(min, max, count = 5) {
  const low = Number.isFinite(min) ? min : 0;
  const high = Number.isFinite(max) ? max : low;
  if (!(high > low)) return { ticks: [low], step: 0 };
  const rawStep = (high - low) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const residual = rawStep / magnitude;
  const step = (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10) * magnitude;
  const first = Math.ceil(low / step - 1e-9) * step;
  const ticks = [];
  for (let value = first; value <= high + step * 1e-9; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }
  return { ticks, step };
}

/** Linear map from a data domain onto a pixel range. */
export function scaleLinear([d0, d1], [r0, r1]) {
  const span = d1 - d0;
  if (!Number.isFinite(span) || span === 0) return () => (r0 + r1) / 2;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

export const DEFAULT_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * The `<svg>` element around a figure body.
 *
 * `width`/`height` are the viewBox units; the element itself is fluid so the
 * same string works in a 300 px report column and a 900 px app panel.
 */
export function figureFrame({ width, height, title, desc = '', body, className = '' }) {
  const classes = ['figure-svg', className].filter(Boolean).join(' ');
  // No `xmlns`: these figures are embedded in HTML documents, where the SVG
  // namespace is implied, and a URL of any kind in the report is a thing the
  // self-containment tests forbid. A standalone .svg export adds it back.
  return `<svg viewBox="0 0 ${round(width, 2)} ${round(height, 2)}"`
    + ` class="${classes}" role="img" preserveAspectRatio="xMidYMid meet"`
    + ' font-family="' + DEFAULT_FONT + '">'
    + `<title>${escapeXml(title)}</title>`
    + (desc ? `<desc>${escapeXml(desc)}</desc>` : '')
    + body
    + '</svg>';
}

/**
 * Axes with ticks and labels.
 *
 * `orient` is `'x'` (baseline horizontal) or `'y'` (baseline vertical). Tick
 * positions are in pixels; labels are placed on the opposite side of `labelSide`
 * so a figure with a left axis and a bottom axis does not collide.
 */
export function axis({ orient, x1, y1, x2, y2, ticks = [], step = 0, label = '', tickLabel = true }) {
  const parts = [];
  parts.push(`<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}"`
    + ` stroke="${PALETTE.axis}" stroke-width="1"/>`);
  for (const tick of ticks) {
    if (orient === 'x') {
      parts.push(`<line x1="${round(tick.pos)}" y1="${round(y2)}" x2="${round(tick.pos)}" y2="${round(y2 + 4)}"`
        + ` stroke="${PALETTE.axis}" stroke-width="1"/>`);
      if (tickLabel) {
        parts.push(`<text x="${round(tick.pos)}" y="${round(y2 + 15)}" text-anchor="middle"`
          + ` font-size="9" fill="${PALETTE.muted}">${escapeXml(fmtTick(tick.value, step))}</text>`);
      }
    } else {
      parts.push(`<line x1="${round(x1 - 4)}" y1="${round(tick.pos)}" x2="${round(x1)}" y2="${round(tick.pos)}"`
        + ` stroke="${PALETTE.axis}" stroke-width="1"/>`);
      if (tickLabel) {
        parts.push(`<text x="${round(x1 - 7)}" y="${round(tick.pos + 3)}" text-anchor="end"`
          + ` font-size="9" fill="${PALETTE.muted}">${escapeXml(fmtTick(tick.value, step))}</text>`);
      }
    }
  }
  if (label) {
    if (orient === 'x') {
      parts.push(`<text x="${round((x1 + x2) / 2)}" y="${round(y2 + 28)}" text-anchor="middle"`
        + ` font-size="10" fill="${PALETTE.ink}">${escapeXml(label)}</text>`);
    } else {
      const cx = round(x1 - 34);
      const cy = round((y1 + y2) / 2);
      parts.push(`<text x="${cx}" y="${cy}" text-anchor="middle" font-size="10" fill="${PALETTE.ink}"`
        + ` transform="rotate(-90 ${cx} ${cy})">${escapeXml(label)}</text>`);
    }
  }
  return parts.join('');
}

/** Polyline path from `[x, y]` pairs, already in pixels. */
export function pathOf(points, digits = 2) {
  if (!Array.isArray(points) || points.length === 0) return '';
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${round(point[0], digits)},${round(point[1], digits)}`)
    .join(' ');
}

/**
 * The shared contract every figure returns.
 *
 * `params` is what a reader needs to judge the picture (isovalue, FWHM, grid,
 * N); the report prints it in the caption, so a figure cannot be read as
 * something it is not.
 */
export function figureResult({ kind, svg, width, height, caption, params = {} }) {
  return Object.freeze({
    kind,
    svg,
    width,
    height,
    caption: String(caption || ''),
    params: Object.freeze({ ...params }),
  });
}

/**
 * Content fingerprint of a figure (FNV-1a, 32-bit, hex).
 *
 * Not a security digest: it exists so the report can state that the picture it
 * shows is the picture it built, and so a test can pin one. A cryptographic
 * hash would need Node's crypto or a bundled SHA-256 and buys nothing here.
 */
export function contentHash(value) {
  let hash = 0x811c9dc5;
  const text = String(value ?? '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
