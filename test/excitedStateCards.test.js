/**
 * Results cards for the excited-state work (#146): vertical emission, the NTO
 * chain, and the excited-state optimisation convergence report.
 *
 * The emission/NTO table values come from the REAL Gaussian 16 TD single-point
 * fixture. The optimisation text below is SYNTHETIC — no real `Opt TD` log
 * exists in this repository — and is used only to exercise the report card; the
 * card itself says the format is unverified.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { resultsPanelHtml } from '../src/renderer/resultsView.js';

const TD_TEXT = readFileSync(
  fileURLToPath(new URL('./fixtures/real/g16-dvb-td.out', import.meta.url)),
  'utf8',
);

const SYNTHETIC_ESOPT = [
  ' Entering Gaussian System, Link 0=g16',
  ' #p B3LYP/6-31G(d) Opt TD=(NStates=3,Root=1)',
  '',
  ' synthetic fixture — format only',
  '',
  ' 0 1',
  ' C  0.000000  0.000000  0.669500',
  ' C  0.000000  0.000000 -0.669500',
  '',
  ' Excitation energies and oscillator strengths:',
  ' Excited State   1:      Singlet-B1U     5.3351 eV  232.39 nm  f=0.1707  <S**2>=0.000',
  '      12 -> 15         0.70123',
  ' This state for optimization and/or second-order correction.',
  ' Total Energy, E(TD-HF/TD-DFT) =  -78.351205281',
  ' Excited State   2:      Singlet-B1U     5.3746 eV  230.68 nm  f=0.6779  <S**2>=0.000',
  ' Excited State   3:      Singlet-AG      6.2152 eV  199.49 nm  f=0.0000  <S**2>=0.000',
  '',
  ' Step number   1',
  '',
  ' Excitation energies and oscillator strengths:',
  ' Excited State   1:      Singlet-B1U     5.2104 eV  237.95 nm  f=0.1822  <S**2>=0.000',
  ' Excited State   2:      Singlet-B1U     5.3010 eV  233.88 nm  f=0.6600  <S**2>=0.000',
  ' Excited State   3:      Singlet-AG      6.1000 eV  203.26 nm  f=0.0000  <S**2>=0.000',
  '',
  ' Optimization completed.',
  '    -- Stationary point found.',
  '',
  ' Normal termination of Gaussian 16.',
].join('\n');

const SYNTHETIC_TRUNCATED = SYNTHETIC_ESOPT.slice(SYNTHETIC_ESOPT.indexOf(' Step number'));

const baseRecord = (parsed, overrides = {}) => ({
  id: 'run-1',
  status: 'completed',
  engine: 'gaussian',
  title: 'Excited state',
  parsed,
  gates: { overall: 'pass', gates: [] },
  ...overrides,
});

const EMISSION = {
  block: 'emission',
  sourceNodeId: 's1-opt',
  root: 1,
  quantity: 'vertical emission from the optimised excited state',
  geometryHandoff: 'checkpoint',
  sourceIsExcitedStateOptimization: true,
};

describe('vertical-emission card', () => {
  const parsed = parseGaussianOutput(TD_TEXT);

  it('prints λ_em, E and f with the exact vertical-emission label', () => {
    const html = resultsPanelHtml(baseRecord(parsed), { emission: EMISSION });
    expect(html).toContain('vertical emission from the optimised excited state');
    expect(html).toContain('data-field="emission-wavelength"');
    expect(html).toContain('232.39');
    expect(html).toContain('data-field="emission-energy"');
    expect(html).toContain('5.3351');
    expect(html).toContain('data-field="emission-oscillator-strength"');
    expect(html).toContain('0.1707');
  });

  it('states what it does not report', () => {
    const html = resultsPanelHtml(baseRecord(parsed), { emission: EMISSION });
    expect(html).toContain('fluorescence lifetime');
    expect(html).toContain('quantum yield');
    expect(html).toContain('Stokes shift');
    expect(html).toContain('experimental band maximum');
    expect(html).toContain('not</em> the adiabatic 0–0 energy');
  });

  it('says when a normal edge did not hand over an optimised geometry', () => {
    const html = resultsPanelHtml(baseRecord(parsed), {
      emission: { ...EMISSION, geometryHandoff: 'block-input' },
    });
    expect(html).toContain('No checkpoint edge supplies the geometry');
  });

  it('prints not reported with a reason when there is no TD table', () => {
    const empty = parseGaussianOutput(' Entering Gaussian System\n Normal termination of Gaussian 16\n');
    const html = resultsPanelHtml(baseRecord(empty), { emission: EMISSION });
    expect(html).toContain('not reported');
    expect(html).toContain('the output carries no excited-state table');
  });

  it('stays absent when the run is not an emission block', () => {
    expect(resultsPanelHtml(baseRecord(parsed))).not.toContain('data-field="emission-wavelength"');
  });
});

describe('NTO card', () => {
  it('shows the two-job chain and says the table is not parsed', () => {
    const html = resultsPanelHtml(baseRecord(parseGaussianOutput(TD_TEXT)), {
      nto: { sourceNodeId: 'td', transition: 1, states: 3 },
    });
    expect(html).toContain('Natural transition orbitals');
    expect(html).toContain('data-field="nto-first-route"');
    expect(html).toContain('Density=(Check,Transition=1)');
    expect(html).toContain('data-field="nto-second-route"');
    expect(html).toContain('Guess=Only Pop=NTO');
    expect(html).toContain('not parsed by this build');
    expect(html).toContain('not reported');
  });

  it('is not rendered for an ordinary run', () => {
    expect(resultsPanelHtml(baseRecord(parseGaussianOutput(TD_TEXT)))).not.toContain('Natural transition orbitals');
  });
});

describe('excited-state optimisation card', () => {
  const settings = { jobType: 'Opt', tdStates: 3, tdRoot: 1 };

  it('shows the root, its steps, the final table and the gate', () => {
    const parsed = parseGaussianOutput(SYNTHETIC_ESOPT);
    const html = resultsPanelHtml(baseRecord(parsed), { settings });
    expect(html).toContain('Excited-state optimisation');
    expect(html).toContain('data-field="esopt-root"');
    expect(html).toContain('data-field="esopt-converged"');
    expect(html).toContain('yes — Optimization completed');
    expect(html).toContain('data-field="esopt-steps"');
    expect(html).toContain('5.3351');
    expect(html).toContain('data-field="esopt-final-table"');
    expect(html).toContain('data-root-row="true"');
    expect(html).toContain('data-field="esopt-gate"');
    expect(html).toContain('pass');
  });

  it('says the build has not seen a real log for this job type', () => {
    const parsed = parseGaussianOutput(SYNTHETIC_ESOPT);
    const html = resultsPanelHtml(baseRecord(parsed), { settings });
    expect(html).toContain('this build has not seen a real log for this job type');
  });

  it('reports unknown, not failed, for a truncated optimisation log', () => {
    const parsed = parseGaussianOutput(SYNTHETIC_TRUNCATED);
    const html = resultsPanelHtml(baseRecord(parsed), { settings });
    expect(html).toContain('unknown');
    expect(html).toContain('partial');
  });

  it('says the convergence verdict is not reported when the log has no ladder', () => {
    const parsed = parseGaussianOutput(TD_TEXT);
    const html = resultsPanelHtml(baseRecord(parsed), { settings });
    expect(html).toContain('is not reported: the output carries no excited-state optimisation ladder');
    expect(html).toContain('this build has not seen a real log for this job type');
  });

  it('does not appear for a run that is not an excited-state optimisation', () => {
    const html = resultsPanelHtml(baseRecord(parseGaussianOutput(TD_TEXT)));
    expect(html).not.toContain('Excited-state optimisation');
  });
});
