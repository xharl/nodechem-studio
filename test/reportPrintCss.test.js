import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  REPORT_STYLE,
  REPORT_PRINT_STYLE,
  buildWorkflowReport,
  buildCombinedReportHtml,
  workflowReportHtml,
} from '../src/shared/workflowReport.js';

/**
 * Issue #356: the report is the document a human prints, and until now the sheet
 * had no rules for that medium. These tests pin the two things that could go
 * wrong: the print block must be present and complete, and adding it must not
 * move a single byte of the screen sheet.
 */

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * sha256 of `REPORT_STYLE` as it stood before #356. The screen sheet is
 * deliberately frozen here: if this test fails, a print change has also changed
 * what a reader sees in the browser, which is a different task and needs its own
 * before/after. Re-pin the hash only when a screen change is intended.
 */
const SCREEN_SHEET_SHA256_BEFORE_356 = '7fc56ee4d301e749721eaff773b6d748b872078c9b47566da2516946c3d80d99';

const QUEUE = {
  id: 'q-print',
  projectName: 'Print fixture',
  status: 'completed',
  createdAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:10:00.000Z',
  tasks: [
    {
      nodeId: 'opt', title: 'Optimise reactant', type: 'calculate', status: 'completed',
      runId: 'run-opt', gateVerdict: 'pass',
    },
    {
      nodeId: 'freq', title: 'Reactant frequency', type: 'calculate', status: 'failed',
      runId: 'run-freq', gateVerdict: 'fail',
    },
    {
      nodeId: 'note', title: 'Note on the method', type: 'note', status: 'skipped',
    },
  ],
};

const RECORDS = {
  'run-opt': {
    dryRun: true,
    provenance: { jobType: 'Opt', method: { functional: 'B3LYP', basis: 'def2-SVP' } },
    parsed: { finalEnergy: { hartree: -76.4 } },
    gates: { overall: 'pass' },
  },
  'run-freq': {
    provenance: { jobType: 'Freq', method: { functional: 'B3LYP', basis: 'def2-SVP' } },
    parsed: { finalEnergy: { hartree: -76.399 }, frequencies: { imaginaryCount: 1 } },
    gates: { overall: 'fail' },
  },
};

const styleOf = (html) => html.slice(html.indexOf('<style>') + '<style>'.length, html.indexOf('</style>'));

describe('workflow report print stylesheet (#356)', () => {
  const html = workflowReportHtml(buildWorkflowReport(QUEUE, RECORDS, { appVersion: '0.5.1' }));
  const style = styleOf(html);

  it('emits an A4 @page rule and a @media print block', () => {
    expect(style).toContain('@page{size:A4;margin:16mm}');
    expect(style).toContain('@media print{');
    // The print rules are the tail of the sheet, after every screen rule.
    expect(style.indexOf('@page')).toBeGreaterThan(style.indexOf('footer{margin-top:32px'));
  });

  it('replaces the 1100 px screen measure with one that fits A4', () => {
    expect(style).toMatch(/@media print\{body\{[^}]*max-width:none/);
    expect(style).toMatch(/@media print\{body\{[^}]*margin:0/);
    // The screen measure is still there for the screen, untouched.
    expect(style).toContain('max-width:1100px');
  });

  it('keeps rows, figures and warnings whole across a page break', () => {
    expect(REPORT_PRINT_STYLE).toMatch(/tr,\.fig,\.warn[^{]*\{break-inside:avoid\}/);
    expect(REPORT_PRINT_STYLE).toContain('details{break-inside:avoid}');
    expect(REPORT_PRINT_STYLE).toMatch(/h1,h2,h3,h4\{break-after:avoid\}/);
    // A table that does span pages repeats its column headers.
    expect(REPORT_PRINT_STYLE).toContain('thead{display:table-header-group}');
  });

  it('forces exact colour on the elements whose fill carries meaning', () => {
    const rule = REPORT_PRINT_STYLE.match(/th,[^{]*\{-webkit-print-color-adjust:exact;print-color-adjust:exact\}/);
    expect(rule).not.toBeNull();
    for (const selector of ['.fixture', '.imported', '.warn', '.gates-pass', '.gates-fail', '.warn-text']) {
      expect(rule[0]).toContain(selector);
    }
    // Both the standard property and the Chromium/Safari alias are present.
    expect(REPORT_PRINT_STYLE).toContain('-webkit-print-color-adjust:exact');
  });

  it('hides no content — only the screen-only affordances are neutralised', () => {
    expect(REPORT_PRINT_STYLE).not.toMatch(/display\s*:\s*none/);
    expect(REPORT_PRINT_STYLE).not.toMatch(/visibility\s*:\s*hidden/);
    expect(REPORT_PRINT_STYLE).toContain('summary{cursor:default}');
    expect(REPORT_PRINT_STYLE).toContain('a{color:inherit;text-decoration:none}');
  });

  it('leaves the screen sheet byte-identical', () => {
    expect(sha256(REPORT_STYLE)).toBe(SCREEN_SHEET_SHA256_BEFORE_356);
    // No print-only construct leaked into the screen sheet.
    expect(REPORT_STYLE).not.toContain('@page');
    expect(REPORT_STYLE).not.toContain('@media');
    expect(REPORT_STYLE).not.toContain('break-inside');
    expect(REPORT_STYLE).not.toContain('break-after');
    expect(REPORT_STYLE).not.toContain('print-color-adjust');
    expect(REPORT_STYLE).not.toContain('max-width:none');
    // The emitted sheet is exactly the screen sheet with the print sheet appended.
    expect(style).toBe(REPORT_STYLE + REPORT_PRINT_STYLE);
    // …and the print block occurs once, so nothing else in the document moved.
    expect(html.split(REPORT_PRINT_STYLE)).toHaveLength(2);
    expect(html.replace(REPORT_PRINT_STYLE, '')).toBe(html.replace(`${REPORT_STYLE}${REPORT_PRINT_STYLE}`, REPORT_STYLE));
  });

  it('keeps the self-contained invariants after adding the print block', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//i);
    // Same model, same bytes, twice.
    expect(workflowReportHtml(buildWorkflowReport(QUEUE, RECORDS, { appVersion: '0.5.1' }))).toBe(html);
  });

  it('adds the print sheet to the combined project report too', () => {
    const combined = buildCombinedReportHtml([
      buildWorkflowReport(QUEUE, RECORDS, { appVersion: '0.5.1' }),
      buildWorkflowReport(QUEUE, RECORDS, { appVersion: '0.5.1' }),
    ], { title: 'Project report', generatedAt: '2026-01-01T00:00:00.000Z' });
    expect(styleOf(combined)).toBe(REPORT_STYLE + REPORT_PRINT_STYLE);
    expect(combined).toContain('@page{size:A4;margin:16mm}');
    expect(combined).toContain('@media print{');
  });

  it('still renders a 400-task report', () => {
    const tasks = Array.from({ length: 400 }, (_, index) => ({
      nodeId: `n${index}`,
      title: `Block ${index}`,
      type: 'calculate',
      status: index % 7 === 0 ? 'failed' : 'completed',
      gateVerdict: index % 7 === 0 ? 'fail' : 'pass',
      runId: `r${index}`,
    }));
    const records = Object.fromEntries(tasks
      .map((task, index) => [task.runId, {
        parsed: {
          finalEnergy: { hartree: -76.4 - index * 0.001 },
          frequencies: { imaginaryCount: index % 7 === 0 ? 1 : 0 },
        },
        gates: { overall: task.gateVerdict },
      }])
      .filter((_, index) => index % 10 === 0));

    const big = workflowReportHtml(buildWorkflowReport({
      id: 'q-400', projectName: 'Long queue', status: 'completed', tasks,
    }, records));

    expect(big.startsWith('<!doctype html>')).toBe(true);
    expect(big.trimEnd().endsWith('</html>')).toBe(true);
    expect(big).toContain('400 task(s)');
    // One table row per task, none dropped by the renderer.
    expect(big.match(/<tr data-node="/g)).toHaveLength(400);
    expect(big).toContain('@page{size:A4;margin:16mm}');
    expect(big).toContain('@media print{');
    expect(big).not.toMatch(/<script/i);
    expect(big).not.toMatch(/https?:\/\//i);
  });
});
