import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  couplingAt,
  elementForNucleus,
  nmrPolyline,
  nmrShifts,
  nmrSpectrum,
  parseCouplings,
  parseShieldings,
} from '../src/shared/nmr.js';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { buildGaussianInput } from '../src/shared/gaussianInput.js';
import { jobKeywordFor } from '../src/shared/tsForceConstants.js';
import { nmrSectionHtml, resultsPanelHtml } from '../src/renderer/resultsView.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';
import { validateRecord } from '../schemas/record-schema.js';

const nmrText = readFileSync(
  fileURLToPath(new URL('./fixtures/real/g09-dvb-nmr.log', import.meta.url)),
  'utf8',
);

describe('NMR shielding parser (real Gaussian 09 log)', () => {
  const parsed = parseShieldings(nmrText);

  it('reads the gauge, the method and every atom', () => {
    expect(parsed).not.toBeNull();
    expect(parsed.gauge).toBe('GIAO');
    expect(parsed.method).toBe('SCF');
    expect(parsed.count).toBe(20);
    expect(parsed.atoms).toHaveLength(20);
  });

  it('keeps isotropic, anisotropy and the tensor eigenvalues', () => {
    const first = parsed.atoms[0];
    expect(first).toMatchObject({ index: 1, element: 'C' });
    expect(first.isotropic).toBeCloseTo(114.088, 3);
    expect(first.anisotropy).toBeCloseTo(147.6438, 4);
    expect(first.eigenvalues).toEqual([48.6622, 81.0847, 212.5172]);
    expect(parsed.atoms.at(-1)).toMatchObject({ index: 20, element: 'H' });
    expect(parsed.atoms.at(-1).isotropic).toBeCloseTo(27.098, 3);
  });

  it('returns null when the job printed no shielding block', () => {
    expect(parseShieldings('')).toBeNull();
    expect(parseShieldings(' Normal termination of Gaussian 16')).toBeNull();
  });
});

describe('spin-spin couplings (real Gaussian 09 NMR=(SpinSpin) log)', () => {
  const couplings = parseCouplings(nmrText);
  const hz = (i, j) => couplingAt(couplings, i, j);
  const reduced = (i, j) => couplings.kMatrix[(i - 1) * couplings.atoms + (j - 1)];

  it('reads both totals for all 20 nuclei and records units and sign convention', () => {
    expect(couplings).not.toBeNull();
    expect(couplings.atoms).toBe(20);
    // 20·19/2: the log prints every pair, so nothing is absent in this fixture.
    expect(couplings.pairs).toHaveLength(190);
    expect(couplings.verified).toBe(true);
    expect(couplings.complete).toBe(true);
    expect(couplings.problems).toEqual([]);
    expect(couplings.units).toBe('Hz');
    expect(couplings.kUnits).toMatch(/reduced K/);
    expect(couplings.convention).toMatch(/sign as printed, never normalised/);
  });

  it('keeps the J values exactly as the log prints them', () => {
    // Line 1164: `     2  0.926067D+01  0.000000D+00`
    expect(hz(2, 1)).toBe(9.26067);
    // Line 1165: `     3  0.451042D+02 -0.666100D+01  0.000000D+00`
    expect(hz(3, 1)).toBe(45.1042);
    expect(hz(3, 2)).toBe(-6.661);
    // Line 1167: `     5 -0.678025D+01  0.456666D+02  0.464173D+02 -0.605372D+01  0.000000D+00`
    expect(hz(5, 3)).toBe(46.4173);
    // Line 1169, row 7 of the first chunk: `     7 -0.367044D+01  0.558159D+01  0.133415D+03 ...`
    expect(hz(7, 3)).toBe(133.415);
  });

  it('keeps the reduced K table as printed, with no K-to-J conversion', () => {
    // Line 1110: `     3  0.228547D+02 -0.337518D+01  0.000000D+00`
    expect(reduced(3, 1)).toBe(22.8547);
    expect(reduced(3, 2)).toBe(-3.37518);
    // Line 1112, row 7: `     7 -0.467757D+00  0.711311D+00  0.170023D+02 ...`
    expect(reduced(7, 3)).toBe(17.0023);
    // Same pair, two printed quantities: the factor is the two nuclei's
    // magnetic moments, not a constant this module may invent.
    expect(hz(7, 3) / reduced(7, 3)).toBeCloseTo(7.8469, 4);
  });

  it('shows the K/J factor depends only on the pair of elements', () => {
    const elements = parseShieldings(nmrText).atoms;
    const elementOf = (atom) => elements[atom - 1].element;
    const groups = new Map();
    for (const pair of couplings.pairs) {
      if (pair.k === 0) continue;
      const key = [elementOf(pair.i), elementOf(pair.j)].sort().join('-');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(pair.hz / pair.k);
    }
    expect([...groups.keys()].sort()).toEqual(['C-C', 'C-H', 'H-H']);
    for (const ratios of groups.values()) {
      const min = Math.min(...ratios);
      const max = Math.max(...ratios);
      expect((max - min) / min).toBeLessThan(1e-4);
    }
  });

  it('fills the matrix symmetrically and keeps the printed zero diagonal', () => {
    expect(couplings.matrix).toBeInstanceOf(Float64Array);
    expect(couplings.matrix).toHaveLength(20 * 20);
    for (let row = 1; row <= 20; row += 1) {
      expect(couplingAt(couplings, row, row)).toBe(0);
      for (let column = 1; column <= 20; column += 1) {
        expect(couplingAt(couplings, row, column)).toBe(couplingAt(couplings, column, row));
      }
    }
    expect(couplingAt(couplings, 0, 1)).toBeNull();
    expect(couplingAt(couplings, 21, 1)).toBeNull();
  });

  it('returns null when the job printed no coupling table', () => {
    expect(parseCouplings('')).toBeNull();
    expect(parseCouplings(' Normal termination of Gaussian 16')).toBeNull();
  });

  it('leaves J absent, not zero, when the log stops before the J table', () => {
    const lines = nmrText.split(/\r\n|\n|\r/);
    const jHeader = lines.findIndex((line) => /coupling J \(Hz\)/.test(line));
    const truncated = parseCouplings(lines.slice(0, jHeader).join('\n'));
    expect(truncated).not.toBeNull();
    expect(truncated.atoms).toBe(20);
    expect(truncated.pairs).toHaveLength(190);
    expect(truncated.matrix).toBeNull();
    expect(truncated.complete).toBe(false);
    expect(truncated.pairs.every((pair) => pair.hz === null)).toBe(true);
    expect(truncated.pairs.every((pair) => pair.k !== null)).toBe(true);
    expect(truncated.pairs.some((pair) => pair.hz === 0)).toBe(false);
    expect(couplingAt(truncated, 2, 1)).toBeNull();
  });

  it('returns null when the head ends before either table', () => {
    const lines = nmrText.split(/\r\n|\n|\r/);
    expect(parseCouplings(lines.slice(0, 1000).join('\n'))).toBeNull();
  });

  it('keeps a hole in the table absent and withdraws `verified`', () => {
    const lines = nmrText.split(/\r\n|\n|\r/);
    // 0-based 1163 is line 1164: the J row for nucleus 2.
    lines.splice(1163, 1);
    const holed = parseCouplings(lines.join('\n'));
    expect(holed.verified).toBe(false);
    expect(holed.complete).toBe(false);
    expect(holed.problems.join(' ')).toMatch(/no row for nucleus 2/);
    expect(Number.isNaN(holed.matrix[(2 - 1) * 20 + (1 - 1)])).toBe(true);
    expect(Number.isNaN(holed.matrix[(1 - 1) * 20 + (2 - 1)])).toBe(true);
    expect(couplingAt(holed, 2, 1)).toBeNull();
  });
});

describe('shifts and referencing', () => {
  const atoms = [
    { index: 1, element: 'C', isotropic: 114.088, anisotropy: 147.6 },
    { index: 2, element: 'C', isotropic: 128.4236, anisotropy: 100 },
    { index: 3, element: 'H', isotropic: 25.5, anisotropy: 5 },
  ];

  it('produces no shift without a reference', () => {
    const shifted = nmrShifts(atoms);
    expect(shifted.map((atom) => atom.shiftPpm)).toEqual([null, null, null]);
  });

  it('uses the IUPAC convention σ_ref − σ_iso', () => {
    const shifted = nmrShifts(atoms, { referencePpm: 190 });
    expect(shifted[0].shiftPpm).toBeCloseTo(75.912, 6);
    expect(shifted[1].shiftPpm).toBeCloseTo(61.5764, 4);
  });

  it('maps a nucleus label to its element', () => {
    expect(elementForNucleus('13C')).toBe('C');
    expect(elementForNucleus('1H')).toBe('H');
    expect(elementForNucleus('7Li')).toBeNull();
  });
});

describe('simulated spectrum', () => {
  const parsed = parseShieldings(nmrText);

  it('selects the requested nucleus and keeps one peak per atom', () => {
    const carbon = nmrSpectrum({ atoms: parsed.atoms, nucleus: '13C', referencePpm: 190, fwhmPpm: 2 });
    expect(carbon.peaks).toHaveLength(10);
    expect(carbon.units).toBe('ppm shift');
    expect(carbon.peaks[0].value).toBeLessThan(carbon.peaks.at(-1).value);
    const proton = nmrSpectrum({ atoms: parsed.atoms, nucleus: '1H' });
    expect(proton.peaks).toHaveLength(10);
  });

  it('states absolute shielding when no reference is set', () => {
    const spectrum = nmrSpectrum({ atoms: parsed.atoms, nucleus: '13C' });
    expect(spectrum.referencePpm).toBeNull();
    expect(spectrum.units).toBe('ppm shielding (absolute)');
    expect(spectrum.peaks.every((peak) => peak.shiftPpm === null)).toBe(true);
  });

  it('broadens with the stated FWHM and normalises the curve', () => {
    const narrow = nmrSpectrum({ atoms: parsed.atoms, nucleus: '13C', referencePpm: 190, fwhmPpm: 0.2 });
    const wide = nmrSpectrum({ atoms: parsed.atoms, nucleus: '13C', referencePpm: 190, fwhmPpm: 4 });
    expect(narrow.fwhmPpm).toBeCloseTo(0.2, 6);
    expect(wide.maxPpm - wide.minPpm).toBeGreaterThan(narrow.maxPpm - narrow.minPpm);
    expect(Math.max(...wide.curve.map((point) => point.intensity))).toBeCloseTo(1, 6);
    expect(nmrPolyline(wide).split(' ')).toHaveLength(wide.curve.length);
  });

  it('returns null when the nucleus is absent', () => {
    expect(nmrSpectrum({ atoms: parsed.atoms, nucleus: '31P' })).toBeNull();
  });
});

describe('NMR job type and route', () => {
  it('emits the NMR keyword', () => {
    expect(jobKeywordFor({ jobType: 'NMR' })).toBe('NMR');
    const text = buildGaussianInput({
      settings: { functional: 'B3LYP', basis: 'def2-SVP', jobType: 'NMR' },
      molecule: { charge: 0, multiplicity: 1, coords: [{ element: 'C', x: 0, y: 0, z: 0 }] },
      inputName: 'nmr.gjf',
    });
    expect(text).toMatch(/^#p B3LYP\/def2SVP NMR$/m);
  });

  it('parses the NMR block into the run summary', () => {
    const parsed = parseGaussianOutput(nmrText);
    expect(parsed.nmr).not.toBeNull();
    expect(parsed.nmr.count).toBe(20);
    expect(parsed.reactionPath).toBeNull();
    expect(parsed.scan).toBeNull();
  });
});

describe('results panel', () => {
  const record = (parsed) => ({
    id: '20261108-010000-nmr001',
    status: 'completed',
    engine: 'gaussian',
    title: 'NMR',
    dryRun: false,
    truncated: false,
    parsed,
    gates: { overall: 'pass', validity: { overall: 'pass' } },
    provenance: { kind: 'calculation', method: { functional: 'B3LYP', basis: 'STO-3G' } },
  });

  it('renders the shielding table, the controls and the convention', () => {
    const html = resultsPanelHtml(record(parseGaussianOutput(nmrText)));
    expect(html).toContain('data-field="nmr-shieldings"');
    expect(html).toContain('data-field="nmr-spectrum"');
    expect(html).toContain('data-nmr-reference');
    expect(html).toContain('data-nmr-fwhm');
    expect(html).toContain('GIAO');
    expect(html).toContain('no reference set (absolute shielding)');
    expect(html).toContain('not reported');
  });

  it('renders nothing when the job has no shielding block', () => {
    const html = resultsPanelHtml(record(parseGaussianOutput(' Normal termination of Gaussian 16')));
    expect(html).not.toContain('data-field="nmr-shieldings"');
  });
});

describe('couplings in the parsed run record', () => {
  const nmr = parseGaussianOutput(nmrText).nmr;
  const couplings = nmr.couplings;
  const at = (i, j) => couplings.matrix[(i - 1) * couplings.atoms + (j - 1)];

  it('rides in the NMR block as printed pairs and JSON-safe matrices', () => {
    expect(couplings).not.toBeNull();
    expect(couplings.atoms).toBe(20);
    expect(couplings.pairs).toHaveLength(190);
    expect(couplings.matrix).toBeInstanceOf(Array);
    expect(couplings.matrix).toHaveLength(20 * 20);
    expect(couplings.kMatrix).toHaveLength(20 * 20);
    expect(couplings.matrix.every((value) => typeof value === 'number')).toBe(true);
  });

  it('pins the J values read out of the log, symmetrically', () => {
    // Same printed rows the parser tests pin; here they come through run.json's
    // shape (plain arrays) rather than the Float64Array.
    expect(at(2, 1)).toBe(9.26067);
    expect(at(3, 2)).toBe(-6.661);
    expect(at(7, 3)).toBe(133.415);
    expect(at(10, 9)).toBe(-0.116474);
    for (let i = 1; i <= 20; i += 1) {
      for (let j = 1; j <= 20; j += 1) {
        expect(at(i, j)).toBe(at(j, i));
      }
    }
  });

  it('states the units, the sign convention and how the atom numbers map', () => {
    expect(couplings.units).toBe('Hz');
    expect(couplings.convention).toMatch(/sign as printed, never normalised/);
    expect(couplings.indexing).toMatch(/numbers nuclei from 1 in input order/);
    expect(couplings.indexing).toMatch(/atoms\[n − 1\]/);
    expect(couplings.matrixOrder).toBe('row-major, atoms × atoms, J in Hz');
  });

  it('survives a JSON round trip and both record schemas', () => {
    const base = JSON.parse(readFileSync(
      fileURLToPath(new URL('./fixtures/run-record/gaussian-dry-run.json', import.meta.url)),
      'utf8',
    ));
    base.parsed = { ...(base.parsed || {}), nmr };
    const reopened = JSON.parse(JSON.stringify(base));
    expect(validateRecord(reopened, { version: 1 }).errors).toEqual([]);
    expect(validateRecord(reopened, { version: 2 }).errors).toEqual([]);
    expect(reopened.parsed.nmr.couplings.pairs[0]).toEqual({ i: 2, j: 1, hz: 9.26067, k: 4.69245 });
    expect(reopened.parsed.nmr.couplings.matrix).toHaveLength(400);
  });

  it('keeps a recorded reference in the record and validates it', () => {
    const base = JSON.parse(readFileSync(
      fileURLToPath(new URL('./fixtures/run-record/gaussian-dry-run.json', import.meta.url)),
      'utf8',
    ));
    base.parsed = {
      ...(base.parsed || {}),
      nmr: {
        ...nmr,
        reference: {
          ppm: 31.9,
          provenance: 'TMS, B3LYP/sto-3g, gas phase — run in this project',
          level: { method: 'B3LYP', basis: 'sto-3g' },
        },
      },
    };
    const reopened = JSON.parse(JSON.stringify(base));
    expect(validateRecord(reopened, { version: 1 }).errors).toEqual([]);
    expect(reopened.parsed.nmr.reference.provenance).toMatch(/TMS/);
  });

  it('reports a log without a coupling table as null, never a zero matrix', () => {
    const lines = nmrText.split(/\r\n|\n|\r/);
    const start = lines.findIndex((line) => /Total nuclear spin-spin coupling K \(Hz\)/.test(line));
    const parsed = parseGaussianOutput(lines.slice(0, start).join('\n'));
    expect(parsed.nmr).not.toBeNull();
    expect(parsed.nmr.atoms).toHaveLength(20);
    expect(parsed.nmr.couplings).toBeNull();
    const html = resultsPanelHtml({
      id: 'run-1',
      status: 'completed',
      engine: 'gaussian',
      parsed,
      gates: { overall: 'pass' },
      provenance: { kind: 'calculation', method: { functional: 'B3LYP', basis: 'STO-3G' } },
    });
    expect(html).toContain('data-field="nmr-couplings-absent"');
    expect(html).not.toContain('data-field="nmr-couplings"');
  });
});

describe('NMR card: coupling table and the source column', () => {
  const parsed = parseGaussianOutput(nmrText);
  const record = {
    id: '20261108-010000-nmr001',
    status: 'completed',
    engine: 'gaussian',
    parsed,
    gates: { overall: 'pass', validity: { overall: 'pass' } },
    provenance: { kind: 'calculation', method: { functional: 'B3LYP', basis: 'STO-3G' } },
  };

  it('draws every printed pair with element+index names and the units', () => {
    const html = resultsPanelHtml(record);
    expect(html).toContain('data-field="nmr-couplings"');
    expect(html).toContain('data-coupling="2,1"');
    expect(html).toContain('C2–C1');
    expect(html).toContain('9.260670');
    expect(html).toContain('J / Hz');
    expect(html).toContain('K (reduced)');
    expect(html).toContain('All 190 pairs printed for 20 nuclei.');
  });

  it('prints a source for every shielding row and no shift without a reference', () => {
    const html = resultsPanelHtml(record);
    expect(html.match(/data-field="nmr-source"/g)).toHaveLength(10);
    expect(html).toContain('no shift — no reference for B3LYP/STO-3G');
    expect(html).toContain('data-field="nmr-reference-reason"');
  });

  it('computes a shift, by hand, once σ_ref and its provenance are stated', () => {
    const section = nmrSectionHtml(parsed.nmr, {
      nucleus: '13C',
      referencePpm: 190.5,
      referenceProvenance: 'TMS, B3LYP/sto-3g, gas phase — run in this project',
      fwhmPpm: 1,
      level: { method: 'B3LYP', basis: 'sto-3g' },
      programLabel: 'Gaussian 09 D.01',
    });
    // σ_ref − σ_iso = 190.5 − 114.088 = 76.412 ppm for C1.
    expect(section).toContain('76.4120');
    expect(section).toContain('reference: σ_ref = 190.5 ppm — TMS, B3LYP/sto-3g, gas phase');
    expect(section).toContain('data-field="nmr-source"');
    expect(section).not.toContain('data-field="nmr-reference-reason"');
  });

  it('refuses a σ_ref with no provenance instead of printing a shift', () => {
    const section = nmrSectionHtml(parsed.nmr, {
      nucleus: '13C',
      referencePpm: 190.5,
      referenceProvenance: '   ',
      level: { method: 'B3LYP', basis: 'sto-3g' },
    });
    expect(section).not.toContain('76.4120');
    expect(section).toContain('no stated provenance');
    expect(section).toContain('δ not reported');
  });
});

describe('workflow report NMR section', () => {
  const nmr = parseGaussianOutput(nmrText).nmr;
  const withReference = {
    ...nmr,
    reference: {
      ppm: 31.9,
      provenance: 'TMS, B3LYP/sto-3g, gas phase — run in this project',
      level: { method: 'B3LYP', basis: 'sto-3g' },
    },
    program: undefined,
  };
  const record = {
    id: 'run-nmr',
    title: 'DVB NMR',
    status: 'completed',
    provenance: { method: { functional: 'B3LYP', basis: 'sto-3g' } },
    parsed: {
      program: { name: 'Gaussian', version: '09', revision: 'D.01' },
      nmr: withReference,
    },
  };
  const queue = {
    id: 'q-nmr',
    projectName: 'NMR',
    status: 'completed',
    createdAt: '2026-11-09T01:00:00.000Z',
    finishedAt: '2026-11-09T01:10:00.000Z',
    tasks: [{ nodeId: 'nmr', title: 'DVB NMR', type: 'calculate', status: 'passed', runId: 'run-nmr' }],
  };

  it('prints the coupling pairs, the units, the level and the reference provenance', () => {
    const html = workflowReportHtml(buildWorkflowReport(queue, { 'run-nmr': record }));
    expect(html).toContain('data-field="nmr-couplings"');
    expect(html).toContain('C2–C1');
    expect(html).toContain('J in Hz');
    expect(html).toContain('B3LYP/sto-3g');
    expect(html).toContain('Reference: σ_ref = 31.9 ppm — TMS, B3LYP/sto-3g, gas phase');
  });

  it('says δ is not reported when the record carries no reference', () => {
    const html = workflowReportHtml(buildWorkflowReport(queue, {
      'run-nmr': { ...record, parsed: { ...record.parsed, nmr: { ...nmr, program: undefined } } },
    }));
    expect(html).toContain('No reference was recorded with this run');
    expect(html).toContain('no shift — no reference for B3LYP/sto-3g');
  });
});
