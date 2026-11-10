import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseOrcaOutput } from '../src/shared/engines/orca.js';
import {
  GAUSS_PER_MHZ_GE_20023,
  ORCA_COUPLING_INDEXING,
  parseOrcaGTensor,
  parseOrcaHyperfine,
  parseOrcaSpinSpin,
} from '../src/shared/engines/orcaProperties.js';
import { GAUSS_PER_MHZ, mhzToGauss } from '../src/shared/epr.js';
import { resultsPanelHtml } from '../src/renderer/resultsView.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';
import { validateRecord } from '../schemas/record-schema.js';

/**
 * Issue 222 — ORCA hyperfine and spin-spin couplings.
 *
 * Both fixtures are verbatim public ORCA logs under `test/fixtures/real-public/`;
 * their PROVENANCE.md files name the source, licence, SHA-256 and the lines the
 * tests read. No number below was invented: every expected value is a literal
 * from the line named in the comment beside it.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NH2_PATH = `${ROOT}/test/fixtures/real-public/orca-6.0-nh2-hyperfine/NH2_A.out`;
const DVB_PATH = `${ROOT}/test/fixtures/real-public/orca-5.0-dvb-spin-spin/dvb_coupling_nmr.out`;
const NH2_TEXT = readFileSync(NH2_PATH, 'utf8');
const DVB_TEXT = readFileSync(DVB_PATH, 'utf8');

const nh2 = parseOrcaOutput(NH2_TEXT);
const dvb = parseOrcaOutput(DVB_TEXT);

const recordFor = (parsed, id) => ({
  id,
  title: id,
  status: 'completed',
  engine: 'orca',
  parsed,
  gates: { overall: 'pass', validity: { overall: 'pass' } },
  provenance: { kind: 'calculation', method: { functional: 'B3LYP', basis: 'EPR-III' } },
});

const queueFor = (runId, nodeId) => ({
  id: `q-${nodeId}`,
  projectName: 'ORCA properties',
  status: 'completed',
  createdAt: '2026-11-09T01:00:00.000Z',
  finishedAt: '2026-11-09T01:10:00.000Z',
  tasks: [{ nodeId, title: nodeId, type: 'calculate', status: 'passed', runId }],
});

describe('ORCA hyperfine couplings (issue 222)', () => {
  it('reads the three nuclei, their isotopes and the printed A(iso) values', () => {
    // NH2_A.out lines 1105, 1159, 1213: `Nucleus   0N/1H/2H : A : Isotope= ...`
    // and lines 1123, 1177, 1231: `A(Tot) ... A(iso)=`.
    expect(nh2.epr.status).toBe('open-shell');
    expect(nh2.epr.hyperfine).toHaveLength(3);
    const [n, h1, h2] = nh2.epr.hyperfine;
    expect(n).toMatchObject({
      atom: 1,
      orcaIndex: 0,
      element: 'N',
      massNumber: 14,
      nuclearSpin: 1,
      status: 'reported',
      naturalIsotope: true,
    });
    expect(n.aIsoMhz).toBeCloseTo(28.4976, 4);
    expect(h1.aIsoMhz).toBeCloseTo(-61.6134, 4);
    expect(h2.aIsoMhz).toBeCloseTo(-61.5964, 4);
    // ORCA numbers the nuclei from 0; `atom` is index + 1 so it matches the
    // rest of the record, and `orcaIndex` keeps the log's own number.
    expect(nh2.epr.hyperfine.map((row) => row.orcaIndex)).toEqual([0, 1, 2]);
    expect(nh2.epr.hyperfine.map((row) => row.atom)).toEqual([1, 2, 3]);
  });

  it('keeps the printed sign and the SAI convention instead of normalising either', () => {
    // Both protons print a negative A(iso); the value is carried as printed.
    expect(nh2.epr.hyperfine[1].aIsoMhz).toBeLessThan(0);
    expect(nh2.epr.hyperfine[2].aIsoMhz).toBeLessThan(0);
    expect(nh2.epr.hyperfineMethod).toMatch(/SAI/);
    expect(nh2.epr.hyperfineMethod).toMatch(/sign as printed/);
    expect(nh2.epr.hyperfineCaveat).toMatch(/not a density-only Fermi-contact/i);
  });

  it('keeps the dipolar components and the full total tensor in MHz and gauss', () => {
    // NH2_A.out line 1118: `A(SD) -43.8380 -44.9167 88.7547`; line 1113–1115
    // is the 3×3 `Total HFC matrix`.
    const n = nh2.epr.hyperfine[0];
    expect(n.aSdMHz).toEqual([-43.838, -44.9167, 88.7547]);
    expect(n.aSdGauss[0]).toBeCloseTo(mhzToGauss(-43.838), 10);
    expect(n.aTensorMHz[0][0]).toBeCloseTo(-15.7051, 4);
    expect(n.aTensorMHz[1][1]).toBeCloseTo(-16.0228, 4);
    expect(n.aTensorMHz[2][2]).toBeCloseTo(117.2206, 4);
    expect(n.aTensorGauss[2][2]).toBeCloseTo(mhzToGauss(117.2206), 10);
    expect(n.aFcMHz).toBeCloseTo(28.4749, 4);
    expect(n.aOrbDiaMHz).toEqual([0.1898, -0.1127, -0.0089]);
    expect(n.aTotPrincipalMHz).toEqual([-15.1734, -16.5545, 117.2206]);
  });

  it('converts MHz to gauss with g_e = 2.0023 and says the log has no gauss column', () => {
    const row = nh2.epr.hyperfine[1];
    expect(row.aIsoGauss).toBeCloseTo(row.aIsoMhz * GAUSS_PER_MHZ, 10);
    // g_e = 2.0023 and 2.00231930436256 differ only in the fifth decimal; the
    // conversion factor differs by 9.6e-6 relative, which is stated, not hidden.
    expect(GAUSS_PER_MHZ).toBeCloseTo(GAUSS_PER_MHZ_GE_20023, 5);
    const check = nh2.epr.hyperfineVerification.gaussConversion;
    expect(check.checkedAgainstLog).toBe(false);
    expect(check.reason).toMatch(/no gauss column/i);
    expect(check.relativeDifference).toBeLessThan(2e-5);
    expect(check.gElectronRequested).toBe(2.0023);
  });

  it('checks A(iso) against the trace of the printed matrix and A(Tot) against the term sum', () => {
    const verification = nh2.epr.hyperfineVerification;
    // Line 1123: A(iso) 28.4976 vs trace/3 = 28.49757; the difference is the
    // log's 4-decimal print precision.
    expect(verification.traceVsPrintedIso.nucleiCompared).toBe(3);
    expect(verification.traceVsPrintedIso.worstDeviationMHz).toBeLessThan(2e-4);
    expect(verification.decompositionVsTotal.componentsCompared).toBe(9);
    expect(verification.decompositionVsTotal.worstDeviationMHz).toBeLessThan(2e-4);
    expect(verification.traceVsPrintedIso.statement).toMatch(/worst/);
  });

  it('refuses the g-tensor by name when the run printed none', () => {
    // Line 1025: `g-Tensor (aka g-matrix) ... NO`.
    expect(nh2.epr.gTensor.status).toBe('refused');
    expect(nh2.epr.gTensor.message).toMatch(/printed no g-tensor/);
    expect(nh2.epr.gTensor).not.toHaveProperty('value');
    expect(nh2.epr.gTensor).not.toHaveProperty('matrix');
  });

  it('leaves the EPR section absent when the run printed no hyperfine block', () => {
    const without = NH2_TEXT.replace(
      'Hyperfine couplings                     ... YES (   3 nuclei)',
      'Hyperfine couplings                     ... NO (   0 nuclei)',
    );
    expect(without).not.toBe(NH2_TEXT);
    const parsed = parseOrcaOutput(without);
    expect(parsed.epr).toBeUndefined();
  });

  it('refuses a section that says YES but does not print the declared nuclei', () => {
    // Remove the N block's `Nucleus 0N : A` line only; the EPR properties line
    // still declares three nuclei, so a two-row table would be a partial lie.
    const without = NH2_TEXT.replace(
      /\s*Nucleus\s+0N\s*:\s*A\s*:\s*Isotope=.*\r?\n/,
      '\n',
    );
    expect(without).not.toBe(NH2_TEXT);
    const parsed = parseOrcaOutput(without);
    expect(parsed.epr.status).toBe('unavailable');
    expect(parsed.epr.reason).toMatch(/declares 3 hyperfine nuclei, but 2/);
    expect(parsed.epr.hyperfine).toEqual([]);
  });

  it('refuses a section absent under a YES properties line, naming the missing block', () => {
    const cut = NH2_TEXT.indexOf('ELECTRIC AND MAGNETIC HYPERFINE STRUCTURE');
    expect(cut).toBeGreaterThan(0);
    const parsed = parseOrcaOutput(NH2_TEXT.slice(0, cut));
    expect(parsed.epr.status).toBe('unavailable');
    expect(parsed.epr.reason).toMatch(/no "ELECTRIC AND MAGNETIC HYPERFINE STRUCTURE" section/);
  });

  it('reads a g-tensor when one is printed', () => {
    // Transcribed from the ORCA 6 manual's documented output
    // (https://orca-manual.mpi-muelheim.mpg.de/contents/spectroscopyproperties/epr.html),
    // not a committed fixture: there is no public ORCA 6 g-tensor log in the
    // corpus this issue names. This proves the reader's line shape; the
    // fixture above is the evidence for every logged number.
    const manual = [
      'g-Tensor (aka g-matrix)                 ... YES',
      '-------------------',
      'ELECTRONIC G-MATRIX',
      '-------------------',
      'The g-matrix:',
      '2.0104321   -0.0031354   -0.0000000',
      '-0.0031354    2.0081968   -0.0000000',
      '-0.0000000   -0.0000000    2.0021275',
      'Breakdown of the contributions',
      'gel          2.0023193    2.0023193    2.0023193',
      'g(tot)       2.0021275    2.0059858    2.0126431 iso=  2.0069188',
    ].join('\n');
    const gTensor = parseOrcaGTensor(manual);
    expect(gTensor.status).toBe('reported');
    expect(gTensor.gIso).toBeCloseTo(2.0069188, 7);
    expect(gTensor.matrix[0][0]).toBeCloseTo(2.0104321, 7);
    expect(gTensor.matrix[1][1]).toBeCloseTo(2.0081968, 7);
    expect(gTensor.matrix[2][2]).toBeCloseTo(2.0021275, 7);
  });

  it('returns null rather than an empty object when no hyperfine line exists', () => {
    expect(parseOrcaHyperfine('ORCA TERMINATED NORMALLY')).toBeNull();
    expect(parseOrcaGTensor('ORCA TERMINATED NORMALLY')).toBeNull();
  });

  it('keeps the canonical energy record intact', () => {
    expect(nh2.status).toBe('completed');
    expect(nh2.program).toMatchObject({ name: 'ORCA', version: '6.0.0' });
    expect(nh2.finalEnergy.hartree).toBeCloseTo(-55.875432645868, 10);
    expect(nh2.terminationCode).toBe('normal');
  });
});

describe('ORCA spin-spin couplings (issue 222)', () => {
  it('reads the 20 nuclei and all 190 summary pairs in the ORCA shape', () => {
    // dvb_coupling_nmr.out line 10348: `SUMMARY OF ISOTOPIC COUPLING CONSTANTS (Hz)`;
    // lines 10350–10421 are the four six-column blocks.
    expect(dvb.nmr).toBeDefined();
    const couplings = dvb.nmr.couplings;
    expect(couplings.atoms).toBe(20);
    expect(couplings.pairs).toHaveLength(190);
    expect(couplings.complete).toBe(true);
    expect(couplings.verified).toBe(true);
    expect(couplings.units).toBe('Hz');
    expect(couplings.matrix).toHaveLength(400);
  });

  it('pins the printed J values and keeps the matrix symmetric', () => {
    // Lines 10351–10352: J(0,1) = 9.451. Line 10353: J(0,2) = 45.356.
    // Line 10357: J(2,6) = 133.670. Line 10423: J(18,19) = 0.082.
    const couplings = dvb.nmr.couplings;
    const at = (i, j) => couplings.matrix[i * couplings.atoms + j];
    expect(at(0, 1)).toBe(9.451);
    expect(at(0, 2)).toBe(45.356);
    expect(at(2, 6)).toBe(133.67);
    expect(at(18, 19)).toBe(0.082);
    for (let i = 0; i < 20; i += 1) {
      for (let j = 0; j < 20; j += 1) expect(at(i, j)).toBe(at(j, i));
    }
  });

  it('states the 0-based ORCA indexing explicitly, so no consumer shifts a pair', () => {
    const couplings = dvb.nmr.couplings;
    expect(couplings.indexing).toBe(ORCA_COUPLING_INDEXING);
    expect(couplings.indexing).toMatch(/numbers nuclei from 0 in input order/);
    expect(couplings.indexing).toMatch(/geometry\.atoms\[k\]/);
    expect(couplings.indexing).toMatch(/Gaussian tables in this app are 1-based/);
    // Pairs are 0-based too: the first pair is nuclei 0 and 1, not 1 and 2.
    expect(couplings.pairs[0]).toEqual({ i: 0, j: 1, hz: 9.451, k: null });
    expect(couplings.elements[0]).toBe('C');
    expect(couplings.elements[6]).toBe('H');
  });

  it('leaves K null and says the log prints no reduced K table', () => {
    const couplings = dvb.nmr.couplings;
    expect(couplings.kMatrix).toBeNull();
    expect(couplings.kUnits).toMatch(/not printed/);
    expect(couplings.kUnits).toMatch(/no reduced K table/);
    expect(couplings.pairs.every((pair) => pair.k === null)).toBe(true);
  });

  it('cross-checks the summary against the per-pair isotropic values and the gn constants', () => {
    const verification = dvb.nmr.couplings.verification;
    // The same J is printed twice: in the summary and in each pair block's
    // `Total … iso=` row. All 190 agree at the log's print precision.
    expect(verification.pairBlockCrossCheck.pairsCompared).toBe(190);
    expect(verification.pairBlockCrossCheck.worstDeviationHz).toBe(0);
    expect(verification.symmetry.pairsCompared).toBe(190);
    expect(verification.symmetry.worstDeviationHz).toBe(0);
    // `( 13C gnA = 1.405 …)` against the isotope table's 1.4048236.
    expect(verification.gNConstants.printed).toBe(true);
    expect(verification.gNConstants.comparisons).toBe(380);
    expect(verification.gNConstants.worstRelativeDeviation).toBeLessThan(2e-4);
    expect(verification.kRelation.checked).toBe(false);
    expect(verification.kRelation.reason).toMatch(/no reduced K table/);
  });

  it('leaves the NMR section absent when the run asked for no couplings', () => {
    // NH2_A.out line 1035: `Spin-spin couplings ... NO (   0 nuclei,    0 pairs)`.
    expect(nh2.nmr).toBeUndefined();
    expect(parseOrcaSpinSpin('ORCA TERMINATED NORMALLY')).toBeNull();
  });

  it('refuses a requested table that is not present instead of returning a zero matrix', () => {
    // Keep the `NMR spin-spin couplings ... 1` request but drop the summary.
    const cut = DVB_TEXT.indexOf('SUMMARY OF ISOTROPIC COUPLING CONSTANTS');
    expect(cut).toBeGreaterThan(0);
    const parsed = parseOrcaOutput(DVB_TEXT.slice(0, cut));
    expect(parsed.nmr).toBeDefined();
    expect(parsed.nmr.couplings).toBeNull();
    expect(parsed.nmr.couplingsError).toMatch(/SUMMARY OF ISOTROPIC COUPLING CONSTANTS/);
    const html = resultsPanelHtml(recordFor(parsed, 'run-orca-truncated'));
    expect(html).toContain('data-field="nmr-couplings-absent"');
    expect(html).toContain('could not be read');
    expect(html).not.toContain('data-field="nmr-couplings"');
  });

  it('refuses a summary header with no rows, naming the missing row line', () => {
    const lines = DVB_TEXT.split(/\r\n|\n|\r/);
    const start = lines.findIndex((line) => /SUMMARY OF ISOTROPIC COUPLING CONSTANTS/.test(line));
    expect(start).toBeGreaterThan(0);
    const broken = lines.slice(0, start + 2).join('\n');
    const parsed = parseOrcaSpinSpin(broken);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/no column header or numeric row/);
  });
});

describe('ORCA couplings in the cards and the report (issue 222)', () => {
  it('renders the hyperfine table without a population table', () => {
    const html = resultsPanelHtml(recordFor(nh2, 'run-orca-epr'));
    expect(html).toContain('data-field="epr-hyperfine-table"');
    expect(html).toContain('Isotropic hyperfine coupling A(iso)');
    expect(html).toContain('28.50');
    expect(html).toContain('-61.61');
    expect(html).toContain('data-field="epr-hyperfine-source"');
    expect(html).not.toContain('data-field="epr-population-table"');
    expect(html).toContain('printed no g-tensor');
  });

  it('renders the ORCA J table with 0-based names and no shielding table', () => {
    const html = resultsPanelHtml(recordFor(dvb, 'run-orca-nmr'));
    expect(html).toContain('data-field="nmr-couplings"');
    expect(html).toContain('C0–C1');
    expect(html).toContain('9.451000');
    expect(html).toContain('numbers nuclei from 0 in input order');
    expect(html).toContain('no reduced K table');
    expect(html).not.toContain('data-field="nmr-shieldings"');
  });

  it('prints the hyperfine rows in the workflow report', () => {
    const record = recordFor(nh2, 'run-orca-epr');
    const html = workflowReportHtml(buildWorkflowReport(queueFor('run-orca-epr', 'epr'), {
      'run-orca-epr': record,
    }));
    expect(html).toContain('data-field="epr-hyperfine"');
    expect(html).toContain('28.50');
    expect(html).toContain('-61.61');
    expect(html).not.toContain('data-field="epr-populations"');
  });

  it('prints the ORCA coupling pairs in the workflow report', () => {
    const record = recordFor(dvb, 'run-orca-nmr');
    const html = workflowReportHtml(buildWorkflowReport(queueFor('run-orca-nmr', 'nmr'), {
      'run-orca-nmr': record,
    }));
    expect(html).toContain('data-field="nmr-couplings"');
    expect(html).toContain('C0–C1');
    expect(html).toContain('numbers nuclei from 0 in input order');
  });

  it('survives a JSON round trip and both record schemas', () => {
    const base = JSON.parse(readFileSync(
      `${ROOT}/test/fixtures/run-record/gaussian-dry-run.json`,
      'utf8',
    ));
    base.parsed = { ...(base.parsed || {}), epr: nh2.epr, nmr: dvb.nmr };
    const reopened = JSON.parse(JSON.stringify(base));
    expect(reopened.parsed.epr.hyperfine[0].aIsoMhz).toBeCloseTo(28.4976, 4);
    expect(reopened.parsed.nmr.couplings.matrix).toHaveLength(400);
    expect(reopened.parsed.nmr.couplings.kMatrix).toBeNull();
    expect(validateRecord(reopened, { version: 1 }).errors).toEqual([]);
    expect(validateRecord(reopened, { version: 2 }).errors).toEqual([]);
  });
});
