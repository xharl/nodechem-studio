import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * Issue #257: a prepare record has three distinct convergence states.
 * `converged: null` means the converter never ran (dry run); `false` means an
 * MM relaxation ran and hit its iteration cap; `true` means it converged.
 * They must never collapse to the same sentence in the queue log, the card
 * footer or the inspector.
 */

describe('prepare tri-state wording (#257)', () => {
  let app;
  let prepareSummaryLine;
  let prepareConvergenceText;

  beforeAll(async () => {
    const prepare = await import('../src/shared/prepare.js');
    prepareSummaryLine = prepare.prepareSummaryLine;
    prepareConvergenceText = prepare.prepareConvergenceText;
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
    });
    app = await import('../src/renderer/app.js');
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const base = {
    kind: 'relax',
    converter: 'openbabel',
    forceField: 'MMFF94',
    atomCount: 84,
  };
  const dryRun = {
    ...base,
    energyKcal: null,
    converged: null,
    reason: 'dry-run (converter not run)',
    iterations: 0,
  };
  const converged = {
    ...base,
    energyKcal: 1.234,
    converged: true,
    reason: 'max-force-below-tolerance',
    iterations: 12,
  };
  const capped = {
    ...base,
    energyKcal: null,
    converged: false,
    reason: 'iteration-cap',
    iterations: 500,
  };

  const prepareNode = (output) => ({
    id: 'prep',
    type: 'prepare',
    title: 'Prepare structure',
    state: 'ready',
    x: 0,
    y: 0,
    settings: { kind: 'relax', converter: 'openbabel', forceField: 'MMFF94', charge: 0, multiplicity: 1 },
    output,
  });

  it('renders three different summary strings', () => {
    const lines = [dryRun, capped, converged].map((output) => prepareSummaryLine(output));
    expect(new Set(lines).size).toBe(3);
    expect(lines[0]).toBe('dry run · converter not run (geometry unchanged)');
    expect(lines[1]).toContain('not converged (500 steps)');
    expect(lines[2]).toContain('converged');
    expect(lines[2]).not.toContain('not converged');
    expect(lines[2]).toContain('1.234 kcal/mol');
  });

  it('never claims convergence for a dry run', () => {
    const line = prepareSummaryLine(dryRun);
    expect(line).not.toMatch(/converged/i);
    expect(line).not.toContain('relaxed');
    expect(prepareConvergenceText(dryRun)).toBe('not run (dry run)');
    expect(prepareConvergenceText(dryRun)).not.toMatch(/^no\b/);
  });

  it('names the iteration count when a real relaxation hit the cap', () => {
    expect(prepareSummaryLine(capped)).toBe('relaxed · openbabel · not converged (500 steps)');
    expect(prepareConvergenceText(capped)).toBe('no · 500 steps · iteration-cap');
  });

  it('keeps the null-without-dry-marker record silent about convergence', () => {
    const unknown = { ...base, converged: null, reason: '', iterations: 0, energyKcal: null };
    expect(prepareSummaryLine(unknown)).toBe('relaxed · openbabel');
    expect(prepareConvergenceText(unknown)).toBe('not reported');
  });

  it('renders the same three states in the inspector header and Result card', () => {
    const dryHtml = app.prepareInspector(prepareNode(dryRun));
    expect(dryHtml).toContain('dry run · converter not run (geometry unchanged)');
    expect(dryHtml).toContain('<span>Converged</span><code>not run (dry run)</code>');
    expect(dryHtml).not.toContain('not converged');

    const convergedHtml = app.prepareInspector(prepareNode(converged));
    expect(convergedHtml).toContain('relaxed · openbabel · 1.234 kcal/mol · converged');
    expect(convergedHtml).toContain('<span>Converged</span><code>yes</code>');

    const cappedHtml = app.prepareInspector(prepareNode(capped));
    expect(cappedHtml).toContain('relaxed · openbabel · not converged (500 steps)');
    expect(cappedHtml).toContain('<span>Converged</span><code>no · 500 steps · iteration-cap</code>');

    expect(new Set([dryHtml, convergedHtml, cappedHtml]).size).toBe(3);
  });

  it('uses the same summary on the prepare card footer', () => {
    expect(app.nodeFoot(prepareNode(dryRun))).toEqual({
      left: 'dry run · converter not run (geometry unchanged)',
      right: '84 atoms',
    });
    expect(app.nodeFoot(prepareNode(capped)).left).toContain('not converged (500 steps)');
    expect(app.nodeFoot(prepareNode(converged)).left).toContain('converged');
  });
});
