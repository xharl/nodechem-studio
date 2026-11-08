import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BATCH_IMPORT_LIMIT,
  parseRouteSummary,
  summarizeLog,
  summarizeLogs,
} from '../src/shared/logImport.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url)), 'utf8');

const coverage = read('synthetic-parser-coverage.out');
const optFreq = read('synthetic-opt-freq-multilink.out');
const errorLog = read('synthetic-error-termination.out');
const xtb = read('xtb/water-sp.out');

describe('route summary', () => {
  it('reads method, basis and the job keyword', () => {
    expect(parseRouteSummary('#p B3LYP/def2-SVP Opt EmpiricalDispersion=GD3BJ')).toEqual({
      method: 'B3LYP',
      basis: 'def2-SVP',
      jobType: 'Opt',
    });
  });

  it('prefers the more specific job keyword', () => {
    expect(parseRouteSummary('#p M06-2X/6-31G(d) Opt=TS CalcFC').jobType).toBe('Opt=TS');
    expect(parseRouteSummary('#p wB97X-D/def2-TZVP Opt Freq').jobType).toBe('Opt Freq');
  });

  it('returns nulls when there is no route', () => {
    expect(parseRouteSummary(null)).toEqual({ method: null, basis: null, jobType: null });
  });
});

describe('single log summary', () => {
  it('summarises a normal Gaussian log', () => {
    const row = summarizeLog(coverage, { name: 'coverage.out', bytes: coverage.length });
    expect(row.engine).toBe('gaussian');
    expect(row.status).toBe('completed');
    expect(row.method).toBeTruthy();
    expect(row.basis).toBeTruthy();
    expect(row.finalEnergyHartree).toBeLessThan(0);
    expect(row.errorCause).toBeNull();
  });

  it('summarises a failed Gaussian log with its cause', () => {
    const row = summarizeLog(errorLog, { name: 'bad.out' });
    expect(row.status).toBe('error');
    expect(row.errorCause).toMatch(/Convergence failure/);
  });

  it('summarises an xTB log and does not claim a Gaussian route', () => {
    const row = summarizeLog(xtb, { name: 'water.log' });
    expect(row.engine).toBe('xtb');
    expect(row.basis).toBeNull();
    expect(row.method).toBeTruthy();
    expect(['completed', 'error', 'incomplete']).toContain(row.status);
  });

  it('keeps an empty or unreadable file as a labelled row', () => {
    expect(summarizeLog('', { name: 'empty.log' }).status).toBe('unreadable');
    expect(summarizeLog('', { name: 'empty.log' }).errorCause).toMatch(/empty/i);
  });

  it('reads the multi-link optimisation/frequency log', () => {
    const row = summarizeLog(optFreq, { name: 'opt-freq.out' });
    expect(row.status).toBe('completed');
    expect(row.imaginaryCount).toBe(0);
    expect(row.scfCycles).toBeGreaterThan(0);
  });
});

describe('batch summary', () => {
  const summary = summarizeLogs([
    { name: 'b-fail.out', text: errorLog },
    { name: 'a-ok.out', text: coverage },
    { name: 'c-xtb.log', text: xtb },
    { name: 'd-empty.log', text: '' },
  ]);

  it('sorts rows by file name and counts each status', () => {
    expect(summary.rows.map((row) => row.name)).toEqual(['a-ok.out', 'b-fail.out', 'c-xtb.log', 'd-empty.log']);
    expect(summary.counts.total).toBe(4);
    expect(summary.counts.error).toBe(1);
    expect(summary.counts.unreadable).toBe(1);
  });

  it('bounds the number of rows', () => {
    const many = Array.from({ length: 5 }, (_, index) => ({ name: `f${index}.log`, text: '' }));
    expect(summarizeLogs(many).rows.length).toBe(5);
    expect(BATCH_IMPORT_LIMIT).toBeGreaterThan(0);
  });

  it('tolerates a missing list', () => {
    expect(summarizeLogs(null).rows).toEqual([]);
    expect(summarizeLogs(null).counts.total).toBe(0);
  });
});
