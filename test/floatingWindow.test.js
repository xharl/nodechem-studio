import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  FLOATING_HEADER_HEIGHT,
  FLOATING_MARGIN,
  clampFloatingRect,
  readFloatingRect,
} from '../src/shared/floatingWindow.js';

const read = (relative) => fs.readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');

describe('floating-window geometry', () => {
  it('keeps a normal rectangle where the user left it', () => {
    const rect = clampFloatingRect(
      { x: 420, y: 130, width: 640, height: 480 },
      { width: 1600, height: 900 },
    );
    expect(rect).toEqual({ x: 420, y: 130, width: 640, height: 480 });
  });

  it('restores an off-screen position fully inside the viewport', () => {
    const rect = clampFloatingRect(
      { x: 5000, y: -400, width: 640, height: 480 },
      { width: 1280, height: 720 },
    );
    expect(rect.x).toBe(1280 - 640 - FLOATING_MARGIN);
    expect(rect.y).toBe(FLOATING_MARGIN);
    expect(rect.x + rect.width).toBeLessThanOrEqual(1280 - FLOATING_MARGIN);
    expect(rect.y + FLOATING_HEADER_HEIGHT).toBeLessThanOrEqual(720);
  });

  it('shrinks a window wider or taller than the new display', () => {
    const rect = clampFloatingRect(
      { x: 0, y: 0, width: 2000, height: 1400 },
      { width: 1024, height: 768 },
    );
    expect(rect.width).toBe(1024 - FLOATING_MARGIN * 2);
    expect(rect.height).toBe(768 - FLOATING_MARGIN * 2);
    expect(rect.x).toBe(FLOATING_MARGIN);
    expect(rect.y).toBe(FLOATING_MARGIN);
  });

  it('still leaves the header reachable when the window is taller than the screen', () => {
    const rect = clampFloatingRect(
      { x: 10, y: 700, width: 500, height: 700 },
      { width: 900, height: 600 },
    );
    expect(rect.y).toBeLessThanOrEqual(600 - FLOATING_HEADER_HEIGHT - FLOATING_MARGIN);
    expect(rect.y).toBeGreaterThanOrEqual(FLOATING_MARGIN);
  });

  it('rejects a stored value that is not four finite numbers', () => {
    expect(readFloatingRect(null)).toBeNull();
    expect(readFloatingRect({ x: 1, y: 2, width: 3 })).toBeNull();
    expect(readFloatingRect({ x: 1, y: 2, width: 3, height: Number.NaN })).toBeNull();
    expect(readFloatingRect({ x: '1', y: '2', width: '3', height: '4' }))
      .toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });
});

describe('run console window wiring', () => {
  it('uses its own geometry key, a dock action and a resize handle', () => {
    expect(read('src/renderer/app.js')).toContain("nodechem-studio.run-console-pos");
    expect(read('index.html')).toContain('data-action="dock-run-console"');
    expect(read('src/renderer/styles.css')).toContain('.run-console.is-floating');
  });
});
