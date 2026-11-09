import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseCube } from '../src/shared/cubeFile.js';
import { parseFchk } from '../src/shared/fchk.js';
import { parseMolden } from '../src/shared/molden.js';
import { evaluateOrbital, fieldOfValues, gridFor } from '../src/shared/volume.js';
import { convertWavefunctionFile } from '../src/shared/converters/index.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';
import { FIGURE_LEVELS, normaliseFigureLevel } from '../src/shared/report.js';
import { basisOf, cubeTextForField, orbitalList } from '../src/renderer/wavefunctionViewport.js';
import { createSurfaceViewer } from '../src/renderer/surfaceViewer.js';
import { parseExportChoice } from '../src/renderer/runConverter.js';

/**
 * Issue 187: three capabilities that existed in the codebase and could not be
 * reached from the window. Each test here is the acceptance criterion from the
 * issue, not a proxy for it:
 *
 * 1. a field from a finished record is written as a cube and read back by the
 *    app's own reader with the same dims, step and range;
 * 2. the Molden converter the Export-as dropdown calls produces a file the
 *    Molden reader accepts — one round trip;
 * 3. the same queue generates a report with and without figures when the figure
 *    set changes, and the default output is byte-identical to before the choice.
 *
 * The two remaining capabilities (diff/merge, QCSchema and the .ncsr cache) are
 * deliberately CLI-only; `test/cliOnlyCommands.test.js` keeps them documented.
 */

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** Relative difference, because the cube format keeps six significant digits. */
const relDiff = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-300);

/** A finished record as the wavefunction card sees one: the parsed checkpoint. */
function finishedRecord() {
  const parsed = parseFchk(read('../test/fixtures/fchk/dvb-g16-b3lyp-sto3g.fchk'));
  return { id: 'dvb-homo', status: 'completed', parsed };
}

/** The card's own path: basis from the record, MO list from the record, one grid. */
function fieldFromRecord(record) {
  const basis = basisOf(record);
  expect(basis?.shells?.length, 'the fixture record must carry a basis').toBeGreaterThan(0);
  const orbitals = orbitalList(record.parsed);
  const occupied = orbitals.filter((orbital) => orbital.occupation > 0);
  const homo = occupied[occupied.length - 1];
  expect(homo, 'the fixture record must carry occupied MOs').toBeTruthy();
  const grid = gridFor(record.parsed.atoms, { spacing: 0.9, padding: 1.5 });
  const values = evaluateOrbital({
    shells: basis.shells,
    coefficients: homo.coefficients,
    cartesianOrder: basis.cartesianOrder,
    atoms: record.parsed.atoms,
    grid,
  });
  const field = fieldOfValues({
    kind: 'orbital',
    label: 'MO HOMO',
    grid: { ...grid, atoms: record.parsed.atoms },
    values,
    signed: true,
    unit: 'a.u.',
  });
  return { field, atoms: record.parsed.atoms };
}

describe('Write cube… on the wavefunction card', () => {
  it('writes a cube the app reader loads back to the same dims, step and range', () => {
    const record = finishedRecord();
    const { field, atoms } = fieldFromRecord(record);

    const text = cubeTextForField(field, { atoms, title: 'MO HOMO from dvb-homo' });
    const back = parseCube(text);

    expect(back.dims).toEqual(field.dims);
    // The step is per axis; a field written from a basis has one scalar step
    // and the writer turns it into [[s,0,0],[0,s,0],[0,0,s]].
    expect(back.spacing).toHaveLength(3);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(back.spacing[axis]).toBeCloseTo(field.step, 9);
      expect(back.axes[axis][axis]).toBeCloseTo(field.step, 9);
    }
    expect(back.atoms).toHaveLength(atoms.length);
    expect(back.units.coordinates).toBe('angstrom');
    expect(relDiff(back.stats.min, field.stats.min)).toBeLessThan(1e-5);
    expect(relDiff(back.stats.max, field.stats.max)).toBeLessThan(1e-5);
    // The range is the field's own, not a rescaled one.
    expect(back.stats.min).toBeLessThan(0);
    expect(back.stats.max).toBeGreaterThan(0);
  });

  it('refuses to write when there is no evaluated field', () => {
    expect(() => cubeTextForField(null)).toThrow(/no evaluated field/i);
  });

  it('puts the action beside Save PNG/STL, disabled until a field exists', () => {
    const made = [];
    const make = (tag) => {
      const node = {
        tagName: tag,
        className: '',
        textContent: '',
        hidden: false,
        dataset: {},
        attributes: {},
        children: [],
        disabled: false,
        style: {},
        append(...kids) { node.children.push(...kids.filter(Boolean)); },
        replaceChildren(...kids) { node.children = kids.filter(Boolean); },
        setAttribute(name, value) { node.attributes[name] = String(value); },
        getAttribute(name) { return node.attributes[name] ?? null; },
        addEventListener() {},
        getContext() { return null; },
      };
      made.push(node);
      return node;
    };
    const doc = { createElement: make, defaultView: { devicePixelRatio: 1 } };
    const host = make('div');

    const viewer = createSurfaceViewer(host, { doc, onWriteCube: () => {} });
    const button = made.find((node) => node.textContent === 'Write cube…');
    expect(button, 'Write cube… is not on the card').toBeTruthy();
    expect(button.disabled).toBe(true);
    expect(button.dataset.role).toBe('surface-write-cube');

    viewer.setCubeAvailable(true);
    expect(button.disabled).toBe(false);

    // A viewer mounted without a writer keeps the two picture exports only.
    made.length = 0;
    createSurfaceViewer(host, { doc });
    expect(made.some((node) => node.textContent === 'Write cube…')).toBe(false);
  });
});

describe('Export as… → Molden', () => {
  it('round-trips a checkpoint through the converter the dropdown calls', () => {
    const fchk = parseFchk(read('../test/fixtures/fchk/dvb-g16-b3lyp-sto3g.fchk'));
    const converted = convertWavefunctionFile(
      read('../test/fixtures/fchk/dvb-g16-b3lyp-sto3g.fchk'),
      'molden',
      { title: 'dvb', filename: 'dvb.fchk' },
    );

    expect(converted.format).toBe('molden');
    expect(converted.extension).toBe('molden');
    const back = parseMolden(converted.text);
    expect(back.numberOfAtoms).toBe(fchk.numberOfAtoms);
    expect(back.atomicNumbers).toEqual(fchk.atomicNumbers);
    expect(back.numberOfBasisFunctions).toBe(fchk.numberOfBasisFunctions);
    expect(back.orbitals.length).toBeGreaterThan(0);
    // One coefficient, to show the MO block was read back and not just skipped.
    const first = back.orbitals[0].coefficients[0];
    const expected = fchk.alphaMOCoefficients?.[0];
    if (Number.isFinite(expected)) expect(relDiff(first, expected)).toBeLessThan(1e-5);
  });

  it('is the format the dropdown offers and the action accepts', () => {
    expect(read('../index.html')).toMatch(/<option value="molden">/);
    expect(parseExportChoice('molden')).toEqual({ format: 'molden', spectrum: null });
  });
});

/** A queue with one frequency record, so `basic` has something to draw. */
function reportFixture() {
  const record = {
    id: 'run-freq',
    status: 'completed',
    engine: 'gaussian',
    parsed: {
      normalModesMeta: { frequencies: [1500, 3000, 3700], irIntensities: [30, 10, 55] },
      orbitals: { manifolds: { alpha: { occupied: [-0.62, -0.5], virtual: [-0.05, 0.02] }, beta: null } },
    },
  };
  const queue = {
    id: 'q-figures',
    flowId: 'main',
    projectName: 'Figure fixture',
    status: 'completed',
    createdAt: '2026-11-08T12:00:00.000Z',
    finishedAt: '2026-11-08T12:10:00.000Z',
    tasks: [
      { nodeId: 'freq', runId: 'run-freq', title: 'Frequency block', status: 'completed' },
    ],
  };
  return { queue, records: { 'run-freq': record } };
}

const figureCount = (html) => (html.match(/<figure class="fig"/g) || []).length;

describe('the Report… figure set', () => {
  it('offers exactly the CLI levels', () => {
    expect([...FIGURE_LEVELS]).toEqual(['basic', 'surfaces', 'none']);
    expect(normaliseFigureLevel('surfaces')).toBe('surfaces');
    expect(normaliseFigureLevel('NONE')).toBe('none');
    expect(normaliseFigureLevel('everything')).toBe('basic');
    expect(normaliseFigureLevel(undefined)).toBe('basic');
  });

  it('generates figures for basic and none of them for none, from the same queue', () => {
    const { queue, records } = reportFixture();
    const options = { generatedAt: '2026-11-08T12:00:00.000Z', appVersion: 'test' };
    const basic = workflowReportHtml(buildWorkflowReport(queue, records, { ...options, figureLevel: 'basic' }));
    const none = workflowReportHtml(buildWorkflowReport(queue, records, { ...options, figureLevel: 'none' }));
    expect(figureCount(basic)).toBeGreaterThan(0);
    expect(figureCount(none)).toBe(0);
  });

  it('leaves the default report byte-identical to the one written before the choice', () => {
    const { queue, records } = reportFixture();
    const options = { generatedAt: '2026-11-08T12:00:00.000Z', appVersion: 'test' };
    // The window's old call: no figure keys at all.
    const before = workflowReportHtml(buildWorkflowReport(queue, records, options));
    // What the window sends when the select is left at `basic`.
    const after = workflowReportHtml(buildWorkflowReport(queue, records, {
      ...options,
      figureLevel: normaliseFigureLevel('basic'),
      volumes: null,
      surfaces: null,
    }));
    expect(after).toBe(before);
  });

  it('puts the select beside Report… and sends its value with the queue id', () => {
    const html = read('../index.html');
    expect(html).toMatch(/<select id="report-figures"/);
    for (const level of ['basic', 'surfaces', 'none']) {
      expect(html).toMatch(new RegExp(`<option value="${level}"[^>]*>${level}</option>`));
    }
    // The select's default must be the old behaviour, so an untouched window
    // writes the report it always did.
    expect(html).toMatch(/<option value="basic" selected>basic<\/option>/);
    expect(read('../src/renderer/app.js')).toContain("exportWorkflowReport(state.queue.id, figures)");
  });
});
