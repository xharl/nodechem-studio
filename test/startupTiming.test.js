import { describe, expect, it } from 'vitest';
import { createStartupClock } from '../electron/startupTiming.js';

/**
 * Issue 375: the launch table is the measurement the startup acceptance refers
 * to. These tests pin the clock conversion (renderer navigation time -> main
 * process time), the bounded mark list, and the diagnostics rendering, without
 * needing Electron.
 */
function clockAt(times, origin = 1000) {
  let index = 0;
  return createStartupClock({
    origin,
    now: () => times[Math.min(index++, times.length - 1)],
  });
}

describe('startup phase timing', () => {
  it('records marks in milliseconds since the process origin', () => {
    const clock = clockAt([0, 10.4, 2050.6]);
    clock.mark('app-ready');
    clock.mark('settings-read');
    const snapshot = clock.snapshot();
    expect(snapshot.startedAt).toBe(new Date(1000).toISOString());
    expect(snapshot.phases['app-ready']).toBe(0);
    expect(snapshot.phases['settings-read']).toBe(10.4);
    expect(snapshot.elapsedMs).toBe(2050.6);
  });

  it('places the renderer first paint on the main-process clock', () => {
    // Main started at epoch 1000. The renderer navigation began at 1200 and
    // painted at 350 ms into its own timeline => 550 ms after main started.
    const clock = clockAt([900]);
    expect(clock.recordRenderer({
      timeOrigin: 1200,
      domReadyMs: 50,
      firstPaintMs: 350,
    })).toBe(true);
    const snapshot = clock.snapshot();
    expect(snapshot.renderer.firstPaintMs).toBe(550);
    expect(snapshot.renderer.domReadyMs).toBe(250);
    expect(snapshot.renderer.fromNavigationMs).toBe(350);
    expect(snapshot.phases['renderer-first-paint']).toBe(900);
  });

  it('ignores a malformed renderer mark instead of throwing', () => {
    const clock = clockAt([5]);
    expect(clock.recordRenderer(null)).toBe(false);
    expect(clock.recordRenderer({ timeOrigin: 'x', firstPaintMs: 1 })).toBe(false);
    expect(clock.recordRenderer({ timeOrigin: 1000 })).toBe(false);
    expect(clock.snapshot().renderer).toBeUndefined();
  });

  it('keeps the mark list bounded', () => {
    const clock = clockAt([1]);
    for (let i = 0; i < 60; i += 1) clock.mark(`phase-${i}`);
    const phases = Object.keys(clock.snapshot().phases);
    expect(phases).toHaveLength(40);
    expect(phases[0]).toBe('phase-20');
    expect(phases.at(-1)).toBe('phase-59');
  });

  it('renders the table and the one-line log', () => {
    const clock = clockAt([0, 1200, 2400, 2400]);
    clock.mark('app-ready');
    clock.mark('did-finish-load');
    clock.recordRenderer({ timeOrigin: 1000, domReadyMs: 100, firstPaintMs: 2400 });
    const log = clock.logLine();
    expect(log).toContain('[startup]');
    expect(log).toContain('app-ready 0.00s');
    expect(log).toContain('first-paint 2.40s');
    const markdown = clock.markdown();
    expect(markdown).toContain('## Startup timing');
    expect(markdown).toContain('- app-ready: 0.00 s');
    expect(markdown).toContain('- First paint (visible canvas): 2.40 s');
  });
});
