/**
 * Measured spectrum overlay (issue 184).
 *
 * A figure that puts a measurement beside a calculation is a claim about which
 * file was drawn and where its peak sits, so these tests assert the peak's
 * position in the emitted SVG rather than a substring someone eyeballed: the
 * measured path's vertices are parsed back into data units through the affine
 * map implied by the path's first and last vertices.
 *
 * Everything here runs without an engine and without a browser: the import is a
 * pure function over bytes, and the figure is a string.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { broadenedSpectrum } from '../src/shared/spectrum.js';
import { fromUvVis } from '../src/shared/figures/spectra.js';
import { taskFigures } from '../src/shared/figures/report.js';
import {
  MEASURED_MIN_POINTS,
  SpectrumImportError,
  importMeasuredSpectrum,
  overlayFromRecord,
  placeMeasuredOverlay,
  sha256Hex,
  spectrumOverlayField,
} from '../src/shared/spectrumImport.js';
import { validateRecord, loadRecordSchema } from '../schemas/record-schema.js';
import { resultsPanelHtml } from '../src/renderer/resultsView.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'measured', 'absorbance-known-peak.csv');
const BASELINE = path.join(ROOT, 'test', 'fixtures', 'figures', 'uvvis-no-overlay.svg');

const fixtureBytes = () => new Uint8Array(fs.readFileSync(FIXTURE));

/** The synthetic TD-DFT table the baseline figure was built from. */
const STATES = [
  { index: 1, energyEv: 5.3351, wavelengthNm: 232.39, oscillatorStrength: 0.1707 },
  { index: 2, energyEv: 5.3746, wavelengthNm: 230.68, oscillatorStrength: 0.6779 },
  { index: 3, energyEv: 6.2152, wavelengthNm: 199.49, oscillatorStrength: 0.0 },
];

const computedFigure = (overlays = []) => fromUvVis(broadenedSpectrum(STATES, { fwhmEv: 0.3, samples: 60 }), { overlays });

/** Vertices of the measured path, in pixels, in the order they were plotted. */
function measuredVertices(svg) {
  const match = /<path class="spectrum-curve is-overlay"[^>]*\sd="([^"]+)"/.exec(svg);
  expect(match, 'the figure carries a measured path').not.toBeNull();
  return [...match[1].matchAll(/[ML]([-\d.]+),([-\d.]+)/g)]
    .map((entry) => ({ px: Number(entry[1]), py: Number(entry[2]) }));
}

/**
 * The x value of a vertex, recovered from the figure's own map: the path is
 * plotted in ascending x order, so the first and last vertices pin the affine
 * map from data units to pixels.
 */
function xOfVertex(vertices, index, { firstX, lastX }) {
  const first = vertices[0].px;
  const last = vertices[vertices.length - 1].px;
  const scale = (lastX - firstX) / (last - first);
  return firstX + (vertices[index].px - first) * scale;
}

function importFixture() {
  return importMeasuredSpectrum({ name: 'absorbance-known-peak.csv', bytes: fixtureBytes() });
}

describe('measured spectrum import — refusals are sentences, by name', () => {
  const text = (name, body) => importMeasuredSpectrum({ name, bytes: new Uint8Array(Buffer.from(body, 'utf8')) });

  it('refuses a JPEG by name and says there is no digitisation in this build', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    let error;
    try {
      importMeasuredSpectrum({ name: 'uv-vis-scan.jpeg', bytes: jpeg });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SpectrumImportError);
    expect(error.code).toBe('image');
    expect(error.message).toContain('uv-vis-scan.jpeg');
    expect(error.message).toMatch(/digitisation/);
    expect(error.message).toMatch(/image/);
  });

  it('refuses an image by extension even when the bytes are text', () => {
    expect(() => text('absorbance.png', 'wavelength_nm,intensity\n200,1\n')).toThrow(/absorbance\.png.*digitisation/);
  });

  it('refuses fewer than five points', () => {
    const body = ['wavelength_nm,intensity', '200,0.1', '210,0.4', '220,1.0', '230,0.2'].join('\n');
    let error;
    try {
      text('short.csv', body);
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe('too-few-points');
    expect(error.message).toMatch(new RegExp(`at least ${MEASURED_MIN_POINTS}`));
    expect(error.message).toContain('4 points');
  });

  it('refuses a non-monotonic x axis instead of sorting it', () => {
    const body = ['wavelength_nm,intensity', '200,0.1', '205,0.4', '210,1.0', '208,0.6', '220,0.2', '230,0.1'].join('\n');
    let error;
    try {
      text('turns.csv', body);
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe('non-monotonic');
    expect(error.message).toContain('turns.csv');
    expect(error.message).toMatch(/one direction/);
  });

  it('refuses a non-numeric cell, naming the line and the cell', () => {
    const body = ['wavelength_nm,intensity', '200,0.1', '210,0.4', '220,oops', '230,0.6', '240,0.2'].join('\n');
    expect(() => text('typo.csv', body)).toThrow(/“typo\.csv” line 4: “oops” is not a number/);
  });

  it('refuses a file with no header row instead of guessing its axis', () => {
    const body = ['200,0.1', '210,0.4', '220,1.0', '230,0.6', '240,0.2'].join('\n');
    let error;
    try {
      text('bare.csv', body);
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe('no-header');
    expect(error.message).toMatch(/wavelength_nm|wavenumber_cm-1/);
  });

  it('refuses a one-column file as missing a column', () => {
    let error;
    try {
      text('one.csv', 'wavelength_nm\n200\n210\n220\n230\n240\n');
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe('missing-columns');
    expect(error.message).toMatch(/needs two/);
  });

  it('refuses a file that declares both a wavelength and a wavenumber column', () => {
    const body = [
      'wavelength_nm,wavenumber_cm-1,intensity',
      '200,50000,0.1', '210,47619,0.4', '220,45454,1.0', '230,43478,0.6', '240,41666,0.2',
    ].join('\n');
    let error;
    try {
      text('both.csv', body);
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe('mixed-units');
    expect(error.message).toContain('nm');
    expect(error.message).toContain('cm⁻¹');
  });

  it('refuses an x column whose unit this import does not know', () => {
    expect(() => text('shift.csv', 'shift,intensity\n1,2\n2,3\n3,4\n4,5\n5,6\n')).toThrow(/does not name an x axis/);
  });
});

describe('measured spectrum import — the trace as given', () => {
  it('hashes the file bytes exactly as sha256sum does', () => {
    const bytes = fixtureBytes();
    const digest = sha256Hex(bytes);
    expect(digest).toBe('a780029af1586fc668f16ac0422f4d55ea884c5cfb6990ca023b7a76eff08912');
    expect(digest).toBe(createHash('sha256').update(Buffer.from(bytes)).digest('hex'));
    expect(importFixture().sha256).toBe(digest);
  });

  it('reads the units off the column name and keeps the values unchanged', () => {
    const imported = importFixture();
    expect(imported.columns).toEqual({ x: 'wavelength_nm', y: 'intensity' });
    expect(imported.units.x).toBe('nm');
    expect(imported.axis).toBe('wavelength');
    expect(imported.points[0]).toEqual({ x: 210, y: 0.02 });
    expect(imported.points).toHaveLength(10);
    expect(imported.notes).toEqual([]);
  });

  it('reads a TSV and orders a descending axis ascending without changing values', () => {
    const body = ['wavenumber_cm-1\tintensity', '4200\t0.1', '4100\t0.4', '4000\t1.0', '3900\t0.5', '3800\t0.2'].join('\n');
    const imported = importMeasuredSpectrum({ name: 'ir.tsv', bytes: new Uint8Array(Buffer.from(body, 'utf8')) });
    expect(imported.units.x).toBe('cm⁻¹');
    expect(imported.axis).toBe('wavenumber');
    expect(imported.order).toBe('descending');
    expect(imported.points.map((point) => point.x)).toEqual([3800, 3900, 4000, 4100, 4200]);
    expect(imported.notes[0]).toMatch(/ordered ascending/);
  });
});

describe('measured spectrum import — units are refused, not converted', () => {
  const wavenumbers = () => importMeasuredSpectrum({
    name: 'emission-cm.csv',
    bytes: new Uint8Array(Buffer.from(
      ['wavenumber_cm-1,intensity', '40000,0.1', '41000,0.4', '42000,1.0', '43000,0.6', '44000,0.2'].join('\n'),
      'utf8',
    )),
  });

  it('refuses a cm⁻¹ file on an nm axis, naming both units', () => {
    let error;
    try {
      placeMeasuredOverlay(wavenumbers(), { axis: 'wavelength' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SpectrumImportError);
    expect(error.code).toBe('unit-mismatch');
    expect(error.message).toContain('cm⁻¹');
    expect(error.message).toContain('nm');
    expect(error.message).toMatch(/refused/);
  });

  it('refuses an nm file on a wavenumber axis as well', () => {
    const nm = importFixture();
    expect(() => placeMeasuredOverlay({ ...nm, axis: 'wavelength' }, { axis: 'wavenumber' }))
      .toThrow(/nm axis and this figure's axis is cm⁻¹/);
  });

  it('plots an explicit reciprocal and states it in the note', () => {
    const placed = placeMeasuredOverlay(wavenumbers(), { axis: 'wavelength', allowReciprocal: true });
    const peak = placed.points.reduce((best, point) => (point.y > best.y ? point : best), placed.points[0]);
    expect(peak.x).toBeCloseTo(1e7 / 42000, 6);
    expect(placed.note).toMatch(/reciprocal/);
    expect(placed.note).toMatch(/no interpolation/);
  });
});

describe('measured spectrum figure — the peak is where the file says', () => {
  it('lands a known peak at the file\'s own x value', () => {
    const imported = importFixture();
    const measured = overlayFromRecord(spectrumOverlayField(imported));
    const placed = placeMeasuredOverlay(measured, { axis: 'wavelength' });
    const figure = computedFigure([{ ...measured, points: placed.points }]);
    const vertices = measuredVertices(figure.svg);
    const peak = vertices.reduce((best, vertex, index) => (vertex.py < vertices[best].py ? index : best), 0);
    const x = xOfVertex(vertices, peak, { firstX: 210, lastX: 248 });
    expect(x).toBeCloseTo(232, 1);
  });

  it('draws both traces on one scale, the measured one dashed and named', () => {
    const measured = { ...overlayFromRecord(spectrumOverlayField(importFixture())), label: 'absorbance-known-peak.csv' };
    const figure = computedFigure([measured]);
    expect(figure.svg).toContain('class="spectrum-curve is-overlay"');
    expect(figure.svg).toMatch(/stroke-dasharray="4 3"/);
    expect(figure.svg).toContain('measured: absorbance-known-peak.csv');
    // The computed curve is still drawn, in its own colour.
    expect(figure.svg).toContain('fill="none" stroke="#2f5fd0"');
    expect(figure.params.overlays).toBe(1);
    expect(figure.params.overlayHashes).toEqual(['a780029af1586fc668f16ac0422f4d55ea884c5cfb6990ca023b7a76eff08912']);
    // The measured trace is plotted as given: 10 vertices, one per file row.
    expect(measuredVertices(figure.svg)).toHaveLength(10);
  });

  it('carries the file name and the full hash in the caption', () => {
    const measured = overlayFromRecord(spectrumOverlayField(importFixture()));
    const figure = computedFigure([measured]);
    expect(figure.caption).toContain('absorbance-known-peak.csv');
    expect(figure.caption).toContain('a780029af1586fc668f16ac0422f4d55ea884c5cfb6990ca023b7a76eff08912');
    expect(figure.caption).toContain('measured');
    expect(figure.caption).toContain('FWHM 0.30 eV');
    expect(figure.caption).toContain('no resampling');
  });

  it('keeps the computed curve\'s method and FWHM labels beside the measured one', () => {
    const figure = computedFigure([overlayFromRecord(spectrumOverlayField(importFixture()))]);
    expect(figure.caption).toContain('oscillator strengths as computed');
    expect(figure.caption).toContain('Gaussian broadening, FWHM 0.30 eV');
    expect(figure.svg).toMatch(/<desc>[^<]*FWHM 0\.30 eV/);
  });

  it('plots a reciprocal cm⁻¹ trace with its peak in the right place and says so', () => {
    const wavenumbers = importMeasuredSpectrum({
      name: 'emission-cm.csv',
      bytes: new Uint8Array(Buffer.from(
        ['wavenumber_cm-1,intensity', '40000,0.1', '41000,0.4', '42000,1.0', '43000,0.6', '44000,0.2'].join('\n'),
        'utf8',
      )),
    });
    const placed = placeMeasuredOverlay(wavenumbers, { axis: 'wavelength', allowReciprocal: true });
    const figure = computedFigure([{ points: placed.points, label: 'emission-cm.csv', sha256: wavenumbers.sha256, note: placed.note }]);
    const vertices = measuredVertices(figure.svg);
    const peak = vertices.reduce((best, vertex, index) => (vertex.py < vertices[best].py ? index : best), 0);
    const xs = placed.points.map((point) => point.x);
    const x = xOfVertex(vertices, peak, { firstX: Math.min(...xs), lastX: Math.max(...xs) });
    expect(x).toBeCloseTo(1e7 / 42000, 0);
    expect(figure.caption).toMatch(/reciprocal/);
  });
});

describe('measured spectrum figure — the honest null', () => {
  it('is byte-identical to the pre-change figure when no overlay is configured', () => {
    const baseline = fs.readFileSync(BASELINE, 'utf8');
    const baselineCaption = fs.readFileSync(
      path.join(ROOT, 'test', 'fixtures', 'figures', 'uvvis-no-overlay.caption.txt'),
      'utf8',
    );
    expect(computedFigure().svg).toBe(baseline);
    expect(computedFigure().caption).toBe(baselineCaption);
    expect(computedFigure().params.overlays).toBe(0);
  });

  it('draws nothing, and says nothing, for an absent overlay', () => {
    const figure = computedFigure();
    expect(figure.svg).not.toContain('is-overlay');
    expect(figure.caption).not.toContain('measured');
    expect(figure.caption).toContain('UV-Vis (simulated)');
  });

  it('refuses to draw half a trace from a malformed record field', () => {
    expect(() => overlayFromRecord({ source: 'x.csv', sha256: 'abc', points: [{ x: 1, y: 1 }] }))
      .toThrow(/fewer than two points/);
  });

  it('widens the axis instead of clipping a trace outside the computed range', () => {
    const figure = computedFigure([{
      points: [{ x: 300, y: 1 }, { x: 310, y: 0.5 }, { x: 320, y: 0.2 }, { x: 340, y: 0.1 }, { x: 360, y: 0.05 }],
      label: 'wide.csv',
      sha256: 'f'.repeat(64),
    }]);
    expect(figure.params.range[1]).toBeGreaterThanOrEqual(360);
    expect(figure.caption).toMatch(/x axis widened/);
    expect(figure.caption).toContain('wide.csv');
  });
});

describe('measured spectrum record field', () => {
  const baseRecord = () => JSON.parse(fs.readFileSync(
    path.join(ROOT, 'test', 'fixtures', 'run-record', 'gaussian-dry-run.json'),
    'utf8',
  ));

  it('validates under v1 and v2 once the field is present', () => {
    const record = baseRecord();
    record.spectrumOverlay = spectrumOverlayField(importFixture());
    const v1 = validateRecord(record, { version: 1 });
    const v2 = validateRecord(record);
    expect(v1.errors).toEqual([]);
    expect(v2.errors).toEqual([]);
  });

  it('is optional: a record without it still validates under both versions', () => {
    const record = baseRecord();
    expect(record.spectrumOverlay).toBeUndefined();
    expect(validateRecord(record, { version: 1 }).errors).toEqual([]);
    expect(validateRecord(record).errors).toEqual([]);
  });

  it('declares the same field in both schemas and refuses a short digest', () => {
    const v1 = loadRecordSchema(1);
    const v2 = loadRecordSchema(2);
    expect(v1.properties.spectrumOverlay).toEqual(v2.$defs.runRecord.properties.spectrumOverlay);
    const record = baseRecord();
    record.spectrumOverlay = { ...spectrumOverlayField(importFixture()), sha256: 'abc' };
    const verdict = validateRecord(record, { version: 1 });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.some((error) => error.path === '/spectrumOverlay/sha256')).toBe(true);
  });

  it('survives a JSON round trip with the same hash and points', () => {
    const record = baseRecord();
    record.spectrumOverlay = spectrumOverlayField(importFixture());
    const reopened = JSON.parse(JSON.stringify(record));
    expect(reopened.spectrumOverlay.sha256).toBe(importFixture().sha256);
    expect(reopened.spectrumOverlay.points).toEqual(importFixture().points);
    const figure = computedFigure([overlayFromRecord(reopened.spectrumOverlay)]);
    expect(figure.caption).toContain(reopened.spectrumOverlay.sha256);
  });

  it('reaches the report figure through taskFigures()', () => {
    const record = baseRecord();
    record.parsed = {
      ...(record.parsed || {}),
      excitedStates: {
        count: 3,
        states: STATES.map((state) => ({ ...state, spin: 'Singlet', symmetry: 'B1U' })),
      },
    };
    record.spectrumOverlay = spectrumOverlayField(importFixture());
    const uvvis = taskFigures(record).find((entry) => entry.key === 'uvvis');
    expect(uvvis.figure).not.toBeNull();
    expect(uvvis.figure.svg).toContain('is-overlay');
    expect(uvvis.figure.caption).toContain('absorbance-known-peak.csv');
    expect(uvvis.figure.caption).toContain(record.spectrumOverlay.sha256);
  });
});

describe('measured spectrum card', () => {
  const record = () => JSON.parse(fs.readFileSync(
    path.join(ROOT, 'test', 'fixtures', 'run-record', 'gaussian-dry-run.json'),
    'utf8',
  ));

  const panelRecord = () => {
    const base = record();
    return {
      ...base,
      id: 'run-184',
      parsed: {
        ...(base.parsed || {}),
        excitedStates: {
          count: 3,
          states: STATES.map((state) => ({ ...state, spin: 'Singlet', symmetry: 'B1U' })),
        },
      },
    };
  };

  it('offers the import control and draws the recorded trace', () => {
    const base = panelRecord();
    base.spectrumOverlay = spectrumOverlayField(importFixture());
    const html = resultsPanelHtml(base);
    expect(html).toContain('data-spectrum-overlay');
    expect(html).toContain('is-overlay');
    expect(html).toContain('absorbance-known-peak.csv');
    expect(html).toContain(base.spectrumOverlay.sha256);
    expect(html).toContain('data-spectrum-overlay-clear');
  });

  it('prints the computed-only caption when no trace was imported', () => {
    const html = resultsPanelHtml(panelRecord());
    expect(html).toContain('data-spectrum-overlay');
    expect(html).toContain('This is a simulation, not a measured spectrum.');
    expect(html).not.toContain('is-overlay');
    expect(html).not.toContain('data-spectrum-overlay-clear');
  });
});
