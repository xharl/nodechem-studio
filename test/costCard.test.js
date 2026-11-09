/**
 * Issue 143 — the surfaces say the estimate, and say "no estimate" when there
 * is none. The renderer is an Electron module, so the pure formatting is
 * imported with a stubbed document (the pattern the inspector tests use) and
 * the wiring is asserted against the shell that ships.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';

const appSource = readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

describe('cost estimate surfaces', () => {
  let app;

  beforeAll(async () => {
    vi.stubGlobal('window', {
      desktop: null,
      innerWidth: 1440,
      innerHeight: 900,
      addEventListener: () => {},
    });
    vi.stubGlobal('document', {
      readyState: 'loading',
      addEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      documentElement: { getAttribute: () => null, setAttribute: () => {}, style: {} },
    });
    app = await import('../src/renderer/app.js');
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('shows a range, the cores and the confidence with its point count', () => {
    const text = app.costCardText({
      procs: 4,
      wallSeconds: { low: 1.2, likely: 1.4, high: 1.8 },
      confidence: 'low',
      calibrationPoints: 3,
      timeout: { limitSeconds: 3600, exceeds: false },
      exceedsOvernight: false,
      basis: [],
    });
    expect(text).toContain('≈ 1.2 s–1.8 s');
    expect(text).toContain('4 cores');
    expect(text).toContain('low confidence (3 points)');
  });

  it('says the queue will stop a block at its limit', () => {
    const text = app.costCardText({
      procs: 8,
      wallSeconds: { low: 7200, likely: 9000, high: 12000 },
      confidence: 'low',
      calibrationPoints: 1,
      timeout: { limitSeconds: 3600, exceeds: true },
      exceedsOvernight: true,
      basis: [],
    });
    expect(text).toContain('overnight (8 h)');
    expect(text).toContain('will stop it at the 1 h limit');
  });

  it('renders a refusal as a sentence, never as zero minutes', () => {
    const text = app.costCardText({
      notEstimated: 'unknown engine "mopac"; no timing measurement covers it',
      basis: ['unknown engine'],
    });
    expect(text).toBe('no estimate: unknown engine "mopac"; no timing measurement covers it');
    expect(text).not.toMatch(/\b0\b/);
  });

  it('formats durations at the precision an estimate deserves', () => {
    expect(app.formatCostDuration(1.6)).toBe('1.6 s');
    expect(app.formatCostDuration(45)).toBe('45 s');
    expect(app.formatCostDuration(600)).toBe('10 min');
    expect(app.formatCostDuration(3 * 3600)).toBe('3 h');
    expect(app.formatCostDuration(2.5 * 86400)).toBe('2.5 d');
  });
});

describe('cost estimate wiring', () => {
  it('has a Setup line beside concurrency and timeout', () => {
    expect(shell).toContain('id="run-cost-estimate"');
    const setup = shell.slice(shell.indexOf('id="run-max-parallel"'), shell.indexOf('run-cost-estimate'));
    expect(setup).toContain('id="run-timeout"');
    expect(appSource).toContain('updateCostEstimate()');
  });

  it('puts the estimate in the block card\'s result slot', () => {
    expect(appSource).toContain('data-cost="${esc(costCardText(cost))}"');
    expect(appSource).toContain('costEntryForNode(node)');
    expect(appSource).toContain("import { estimateCost } from '../shared/costEstimate.js'");
  });
});
