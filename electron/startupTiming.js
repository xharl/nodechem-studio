/**
 * Startup phase timing (issue 375).
 *
 * Main and renderer are different processes with different `performance.now()`
 * origins. A mark is stored as milliseconds since this process started, and the
 * renderer's first frame is placed on the same timeline by adding its
 * `timeOrigin` (a Unix epoch) to its own mark and subtracting this clock's
 * origin. No wall-clock arithmetic is mixed in after the origin is captured.
 *
 * The clock is injectable so the conversion is testable without Electron.
 */
export function createStartupClock({ now = () => performance.now(), origin } = {}) {
  const startedAt = Number.isFinite(Number(origin))
    ? Number(origin)
    : (Number(performance.timeOrigin) || Date.now());
  const marks = [];
  let renderer = null;

  const round = (value) => Math.round(Number(value) * 10) / 10;
  const elapsed = () => round(now());

  function mark(phase) {
    if (typeof phase !== 'string' || !phase) return;
    marks.push({ phase, at: elapsed() });
    // A pathological loop must not grow the diagnostics payload without bound.
    if (marks.length > 40) marks.shift();
  }

  function snapshot() {
    const phases = {};
    for (const entry of marks) phases[entry.phase] = entry.at;
    return {
      startedAt: new Date(startedAt).toISOString(),
      elapsedMs: elapsed(),
      phases,
      ...(renderer ? { renderer } : {}),
    };
  }

  function logLine() {
    const current = snapshot();
    const phases = Object.entries(current.phases)
      .map(([phase, at]) => `${phase} ${(at / 1000).toFixed(2)}s`)
      .join(' · ');
    const paint = Number(current.renderer?.firstPaintMs);
    return `[startup] ${phases}${Number.isFinite(paint) ? ` · first-paint ${(paint / 1000).toFixed(2)}s` : ''}`;
  }

  /** Diagnostics section; labels are fixed, so it carries no user paths. */
  function markdown() {
    const current = snapshot();
    const phases = Object.entries(current.phases);
    if (phases.length === 0) return '';
    const lines = [
      '',
      '## Startup timing',
      'Measured on the monotonic clock from the start of the main process.',
      '',
      ...phases.map(([phase, at]) => `- ${phase}: ${(at / 1000).toFixed(2)} s`),
    ];
    const paint = current.renderer?.firstPaintMs;
    if (Number.isFinite(Number(paint))) {
      lines.push(`- First paint (visible canvas): ${(paint / 1000).toFixed(2)} s`);
    }
    lines.push('');
    return lines.join('\n');
  }

  /**
   * Place the renderer's first frame on this clock. Returns false for a
   * malformed payload: timing is diagnostics, so it should never throw back at
   * the renderer or take the launch down.
   */
  function recordRenderer(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const timeOrigin = Number(payload.timeOrigin);
    const firstPaint = Number(payload.firstPaintMs);
    const domReady = Number(payload.domReadyMs);
    const script = Number(payload.scriptMs);
    if (!Number.isFinite(timeOrigin) || !Number.isFinite(firstPaint)) return false;
    const place = (navigationMs) => round(timeOrigin + navigationMs - startedAt);
    renderer = {
      scriptMs: Number.isFinite(script) ? place(script) : null,
      domReadyMs: Number.isFinite(domReady) ? place(domReady) : null,
      firstPaintMs: place(firstPaint),
      fromNavigationMs: round(firstPaint),
    };
    mark('renderer-first-paint');
    return true;
  }

  return { mark, snapshot, logLine, markdown, recordRenderer };
}
