/**
 * Experimental spectrum overlay (#76).
 *
 * A simulated spectrum is only useful next to something measured. This reads a
 * two-column file (`shift intensity`, any common delimiter, optional header)
 * and scales it onto the simulated axis. The scale factor is returned so the
 * panel can state it: an overlay whose y axis was silently rescaled invites
 * the reader to compare heights that were never comparable.
 */

const SPLIT = /[,;\t]+|\s+/;

/**
 * @returns {{points: Array<{x: number, y: number}>, rows: number, skipped: number,
 *   minX: number|null, maxX: number|null, minY: number|null, maxY: number|null}|null}
 */
export function parseMeasuredSpectrum(text) {
  const lines = String(text || '').split(/\r\n|\n|\r/);
  const points = [];
  let skipped = 0;
  let rows = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const parts = trimmed.split(SPLIT).filter((part) => part !== '');
    if (parts.length < 2) {
      // A one-column line is either a header or a single-column dump; either
      // way it carries no (x, y) pair.
      if (trimmed !== '') skipped += 1;
      continue;
    }
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      skipped += 1;
      continue;
    }
    rows += 1;
    points.push({ x, y });
  }

  if (points.length === 0) return null;
  points.sort((a, b) => a.x - b.x);
  return {
    points,
    rows,
    skipped,
    minX: points[0].x,
    maxX: points[points.length - 1].x,
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

/**
 * Scale measured data onto a simulated curve.
 *
 * Both series are drawn on 0–1 after dividing by their own maximum, so height
 * comparison is meaningless unless the factor is stated — which is why it is
 * returned and printed. `mode: 'peak'` (default) matches strongest peaks.
 */
export function scaleToSpectrum(measured, { peakIntensity = 1, mode = 'peak' } = {}) {
  if (!measured || !Array.isArray(measured.points) || measured.points.length === 0) return null;
  const measuredMax = Math.max(...measured.points.map((point) => Math.abs(point.y)));
  const target = Number.isFinite(peakIntensity) && peakIntensity > 0 ? peakIntensity : 1;
  const factor = mode === 'peak' && measuredMax > 0 ? target / measuredMax : 1;
  return {
    scale: factor,
    mode,
    points: measured.points.map((point) => ({ x: point.x, y: point.y * factor })),
  };
}

/**
 * Polyline for a measured series, mapped onto an axis [minX, maxX] with the
 * intensity divided by `maxY` (the simulated maximum) so both share 0–1.
 */
export function overlayPolyline(series, { minX, maxX, maxY, width = 100, height = 100 } = {}) {
  if (!series || !Array.isArray(series.points) || series.points.length === 0) return '';
  const span = (maxX - minX) || 1;
  const ceiling = maxY > 0 ? maxY : 1;
  return series.points
    .map((point) => {
      const x = Math.min(width, Math.max(0, ((point.x - minX) / span) * width));
      const y = height - Math.min(1, Math.max(0, point.y / ceiling)) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}
