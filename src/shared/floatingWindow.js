/**
 * Floating-window geometry shared by the renderer's draggable panels.
 *
 * The drag/resize listeners are DOM code, but the part that can lose a window
 * is arithmetic: a position saved on a 1600×900 display must be clamped to
 * something reachable on a 1280×720 one. That part is pure and tested here.
 */

export const FLOATING_MARGIN = 8;
export const FLOATING_MIN_WIDTH = 320;
export const FLOATING_MIN_HEIGHT = 220;
export const FLOATING_HEADER_HEIGHT = 56;

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Clamp a window rectangle to the visible work area.
 *
 * `headerHeight` is kept on-screen even when the body is taller than the
 * viewport, so a restored window always has a place to grab. A width/height
 * that would exceed the viewport is reduced to the work area rather than
 * pushed off-screen.
 */
export function clampFloatingRect(rect, viewport, {
  margin = FLOATING_MARGIN,
  minWidth = FLOATING_MIN_WIDTH,
  minHeight = FLOATING_MIN_HEIGHT,
  headerHeight = FLOATING_HEADER_HEIGHT,
} = {}) {
  const viewportWidth = Math.max(0, finite(viewport?.width, 0));
  const viewportHeight = Math.max(0, finite(viewport?.height, 0));
  const left = Math.max(0, margin);
  const availableWidth = Math.max(1, viewportWidth - left * 2);
  const availableHeight = Math.max(1, viewportHeight - left * 2);

  const width = clamp(finite(rect?.width, minWidth), Math.min(minWidth, availableWidth), availableWidth);
  const height = clamp(finite(rect?.height, minHeight), Math.min(minHeight, availableHeight), availableHeight);

  const maxX = Math.max(left, viewportWidth - width - left);
  // Keep the header reachable; the body may hang below the viewport.
  const maxY = Math.max(left, viewportHeight - Math.min(headerHeight, height) - left);

  return {
    x: clamp(finite(rect?.x, left), left, maxX),
    y: clamp(finite(rect?.y, left), left, maxY),
    width,
    height,
  };
}

/** A saved rectangle is usable only when all four members are finite. */
export function readFloatingRect(value) {
  if (!value || typeof value !== 'object') return null;
  if (!['x', 'y', 'width', 'height'].every((key) => Number.isFinite(Number(value[key])))) return null;
  return {
    x: Number(value.x),
    y: Number(value.y),
    width: Number(value.width),
    height: Number(value.height),
  };
}
