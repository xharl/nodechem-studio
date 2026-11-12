import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import {
  SCALE_FACTOR_TABLE,
  SCALE_FACTOR_TABLE_VERSION,
  describeFrequencyScale,
  frequencyScaleProvenance,
  lookupScaleFactor,
  methodBasisFromRoute,
  normaliseFrequencyScaleSetting,
  parseFrequencyScaleSetting,
  resolveFrequencyScale,
  scaleFactorTable,
  scaleZeroPoint,
  scaledModeTable,
  scaledWavenumber,
} from '../src/shared/frequencyScaling.js';
import {
  buildThermochemistryReport,
} from '../src/shared/thermochemistry.js';
import { ramanSpectrum } from '../src/shared/raman.js';
import { vcdSpectrum } from '../src/shared/vcd.js';
import { thermochemistryPanelHtml } from '../src/renderer/thermochemistryView.js';
import { ramanSectionHtml, vcdSectionHtml } from '../src/renderer/resultsView.js';
import { defaultSettings, parseProjectText, stringifyProject, validateProject } from '../src/shared/projectSchema.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const waterText = read('./fixtures/real/g16-a03-water-optfreq.out');
const water = parseGaussianOutput(waterText);
const vcdParsed = parseGaussianOutput(read('./fixtures/real/g16-propyleneoxide-vcd.out'));

/** B3LYP/6-31G(d): 0.9613 in Merrick et al. 2007, Table 2. */
const B3LYP_FACTOR = 0.9613;

describe('frequency-scaling table', () => {
  it('is versioned and every entry names a real source', () => {
    expect(SCALE_FACTOR_TABLE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SCALE_FACTOR_TABLE.length).toBeGreaterThan(10);
    for (const entry of scaleFactorTable()) {
      expect(entry.key).toMatch(/^[a-z0-9()+,/.-]+$/);
      expect(entry.factor).toBeGreaterThan(0.8);
      expect(entry.factor).toBeLessThanOrEqual(1.05);
      expect(entry.source, `${entry.method}/${entry.basis} needs a citation`).toBeTruthy();
      expect(entry.url, `${entry.method}/${entry.basis} needs a source URL`).toBeTruthy();
    }
    const keys = scaleFactorTable().map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('looks B3LYP/6-31G(d) up to the Merrick 2007 value, with its DOI', () => {
    const hit = lookupScaleFactor('B3LYP', '6-31G(d)');
    expect(hit.found).toBe(true);
    expect(hit.factor).toBe(B3LYP_FACTOR);
    expect(hit.key).toBe('b3lyp/6-31g(d)');
    expect(hit.source).toContain('Merrick');
    expect(hit.doi).toBe('10.1021/jp073974n');
    expect(hit.tableVersion).toBe(SCALE_FACTOR_TABLE_VERSION);
  });

  it('canonicalises Gaussian spelling: RB3LYP, 6-31G*, PBE1PBE', () => {
    expect(lookupScaleFactor('RB3LYP', '6-31G*').factor).toBe(B3LYP_FACTOR);
    expect(lookupScaleFactor('B3-LYP', '6-31G(d)').factor).toBe(B3LYP_FACTOR);
    expect(lookupScaleFactor('PBE1PBE', '6-31G(d)').key).toBe('pbe0/6-31g(d)');
    expect(lookupScaleFactor('CCSD(T)', '6-31G(d)').factor).toBe(0.9603);
    expect(lookupScaleFactor('CCSDT', '6-31G(d)').factor).toBe(0.9603);
    expect(normaliseFrequencyScaleSetting('AUTO')).toBe('auto');
    expect(normaliseFrequencyScaleSetting('0.96130')).toBe('0.9613');
  });

  it('returns not-found for a pair it cannot cite, never a guessed factor', () => {
    const miss = lookupScaleFactor('B3LYP', 'def2-SVP');
    expect(miss.found).toBe(false);
    expect(miss.factor).toBeNull();
    expect(miss.source).toBeNull();
  });
});

describe('frequency-scaling resolution', () => {
  it('defaults to unscaled with no warning', () => {
    const resolution = resolveFrequencyScale({ setting: 'unscaled', method: 'B3LYP', basis: '6-31G(d)' });
    expect(resolution.mode).toBe('unscaled');
    expect(resolution.applied).toBe(false);
    expect(resolution.factor).toBe(1);
    expect(resolution.warnings).toEqual([]);
  });

  it('uses the table for auto, with the source attached', () => {
    const resolution = resolveFrequencyScale({ setting: 'auto', method: 'B3LYP', basis: '6-31G(d)' });
    expect(resolution.mode).toBe('auto');
    expect(resolution.applied).toBe(true);
    expect(resolution.factor).toBe(B3LYP_FACTOR);
    expect(resolution.source).toContain('Merrick');
    expect(resolution.warnings).toEqual([]);
  });

  it('offers an unknown pair unscaled with a warning naming it', () => {
    const resolution = resolveFrequencyScale({ setting: 'auto', method: 'B3LYP', basis: 'def2-SVP' });
    expect(resolution.mode).toBe('unknown');
    expect(resolution.applied).toBe(false);
    expect(resolution.factor).toBe(1);
    expect(resolution.warnings.join(' ')).toContain('no published factor');
    expect(resolution.warnings.join(' ')).toContain('B3LYP/def2-SVP');
    expect(resolution.warnings.join(' ')).toContain(SCALE_FACTOR_TABLE_VERSION);
    // A reopened record carries only the compact provenance block, so the
    // caption must still be able to name the pair from the stored key.
    expect(describeFrequencyScale(frequencyScaleProvenance(resolution))).toContain('b3lyp/def2-svp');
  });

  it('honours an explicit factor but says it carries no citation', () => {
    const resolution = resolveFrequencyScale({ setting: '0.95', method: 'B3LYP', basis: '6-31G(d)' });
    expect(resolution.mode).toBe('explicit');
    expect(resolution.applied).toBe(true);
    expect(resolution.factor).toBe(0.95);
    expect(resolution.source).toContain('explicit factor');
    expect(resolution.doi).toBeNull();
  });

  it('refuses an invalid setting instead of coercing it', () => {
    const parsed = parseFrequencyScaleSetting('fast');
    expect(parsed.mode).toBe('invalid');
    expect(normaliseFrequencyScaleSetting('fast')).toBeNull();
    const resolution = resolveFrequencyScale({ setting: 'fast', method: 'B3LYP', basis: '6-31G(d)' });
    expect(resolution.applied).toBe(false);
    expect(resolution.factor).toBe(1);
    expect(resolution.warnings.join(' ')).toContain('unscaled');
  });

  it('never scales an imported record, even with a known auto pair', () => {
    const resolution = resolveFrequencyScale({
      setting: 'auto', method: 'B3LYP', basis: '6-31G(d)', imported: true,
    });
    expect(resolution.mode).toBe('imported');
    expect(resolution.applied).toBe(false);
    expect(resolution.factor).toBe(1);
    expect(resolution.warnings.join(' ')).toContain('Imported record');
  });

  it('reads the level of theory from a Gaussian route, including ONIOM model layers', () => {
    expect(methodBasisFromRoute('#p B3LYP/6-31G(d) Opt Freq EmpiricalDispersion=GD3BJ'))
      .toEqual({ method: 'B3LYP', basis: '6-31G(d)', key: 'b3lyp/6-31g(d)' });
    expect(methodBasisFromRoute('# freq=roa hf/3-21g')).toEqual({ method: 'hf', basis: '3-21g', key: 'hf/3-21g' });
    expect(methodBasisFromRoute('#p oniom(B3LYP/6-31G(d):PM6) Freq').key).toBe('b3lyp/6-31g(d)');
    expect(methodBasisFromRoute('#p CBS-QB3')).toEqual({ method: null, basis: null, key: null });
  });
});

describe('frequency scaling at the derived boundary', () => {
  it('scales the real B3LYP/6-31G(d) water fixture to the published factor', () => {
    const report = buildThermochemistryReport(water, { frequencyScale: 'auto' });
    expect(report.scaling.applied).toBe(true);
    expect(report.scaling.factor).toBe(B3LYP_FACTOR);
    expect(report.scaling.source).toContain('Merrick');
    expect(report.scaling.tableVersion).toBe(SCALE_FACTOR_TABLE_VERSION);
    // Printed at four decimals by the log; asserted at the same precision from
    // the report's own scaled list.
    expect(report.scaling.frequencies.raw).toEqual([1713.6442, 3727.2775, 3848.8151]);
    expect(report.scaling.frequencies.scaled.map((value) => Number(value.toFixed(4))))
      .toEqual([1647.3262, 3583.0319, 3699.866]);
    // Derived ZPE = raw printed ZPE × factor.
    expect(report.zeroPoint.rawHartree).toBe(0.021164);
    expect(report.zeroPoint.scaledHartree).toBeCloseTo(0.021164 * B3LYP_FACTOR, 12);
    expect(report.zeroPoint.applied).toBe(true);
  });

  it('leaves the parsed record untouched while the derived values move', () => {
    const rawFrequencies = [...water.frequencies.values];
    const rawZpe = water.thermochemistry.zeroPointCorrectionHartree;
    const raw = buildThermochemistryReport(water, { frequencyScale: 'unscaled' });
    const scaled = buildThermochemistryReport(water, { frequencyScale: 'auto' });
    expect(water.frequencies.values).toEqual(rawFrequencies);
    expect(water.thermochemistry.zeroPointCorrectionHartree).toBe(rawZpe);
    expect(raw.scaling.applied).toBe(false);
    expect(raw.zeroPoint.scaledHartree).toBe(raw.zeroPoint.rawHartree);
    expect(scaled.zeroPoint.rawHartree).toBe(raw.zeroPoint.rawHartree);
    expect(scaled.zeroPoint.scaledHartree).not.toBe(raw.zeroPoint.scaledHartree);
    // The quasi-RRHO correction is recomputed from the scaled frequencies, so
    // choosing a factor changes the thermochemistry the panel shows.
    expect(scaled.lines[0].correctionKcalPerMol).not.toBe(raw.lines[0].correctionKcalPerMol);
  });

  it('uses a recorded decision instead of re-resolving the current setting', () => {
    const recorded = frequencyScaleProvenance(
      resolveFrequencyScale({ setting: 'auto', method: 'B3LYP', basis: '6-31G(d)' }),
    );
    const report = buildThermochemistryReport(water, {
      frequencyScale: 'unscaled',
      frequencyScaleResolution: recorded,
    });
    expect(report.scaling.mode).toBe('auto');
    expect(report.scaling.applied).toBe(true);
    expect(report.zeroPoint.scaledHartree).toBeCloseTo(0.021164 * B3LYP_FACTOR, 12);
  });

  it('does not scale an imported record and reports why', () => {
    const recorded = frequencyScaleProvenance(
      resolveFrequencyScale({ setting: 'auto', method: 'B3LYP', basis: '6-31G(d)' }),
    );
    const report = buildThermochemistryReport(water, {
      frequencyScale: 'auto',
      frequencyScaleResolution: recorded,
      imported: true,
    });
    expect(report.scaling.mode).toBe('imported');
    expect(report.scaling.applied).toBe(false);
    expect(report.zeroPoint.scaledHartree).toBe(report.zeroPoint.rawHartree);
    expect(report.warnings.join(' ')).toContain('Imported record');
  });

  it('applies an explicit factor to the derived ZPE', () => {
    const report = buildThermochemistryReport(water, { frequencyScale: '0.95' });
    expect(report.zeroPoint.scaledHartree).toBeCloseTo(0.021164 * 0.95, 12);
    expect(report.scaling.mode).toBe('explicit');
  });

  it('returns a mode table with both raw and scaled values, without mutating the input', () => {
    const modes = [{ wavenumber: 1000, rotationalStrength: 1 }];
    const resolution = resolveFrequencyScale({ setting: 'auto', method: 'B3LYP', basis: '6-31G(d)' });
    const scaled = scaledModeTable(modes, resolution);
    expect(scaled[0].wavenumberRaw).toBe(1000);
    expect(scaled[0].wavenumber).toBeCloseTo(961.3, 9);
    expect(modes[0].wavenumber).toBe(1000);
    expect(modes[0].wavenumberRaw).toBeUndefined();
    expect(scaledWavenumber(1000, resolution)).toBeCloseTo(961.3, 9);
    expect(scaleZeroPoint(0.02, resolution).scaledHartree).toBeCloseTo(0.019226, 9);
  });
});

describe('frequency scaling in the spectra', () => {
  const resolution = resolveFrequencyScale({ setting: 'auto', method: 'B3LYP', basis: '6-31G(d)' });

  it('moves VCD band positions but keeps the printed wavenumber', () => {
    const spectrum = vcdSpectrum(vcdParsed.vcd, { fwhmCm: 12, scale: resolution });
    expect(spectrum.scaling.applied).toBe(true);
    expect(spectrum.scaling.factor).toBe(B3LYP_FACTOR);
    const first = spectrum.peaks.find((peak) => peak.wavenumberRaw === 212.7138);
    expect(first.wavenumber).toBeCloseTo(212.7138 * B3LYP_FACTOR, 9);
    expect(first.wavenumber.toFixed(4)).toBe('204.4818');
    // Rotational strengths are not scaled: #350 excludes intensities.
    expect(first.rotationalStrength).toBe(3.9145);
    expect(vcdParsed.vcd[0].wavenumber).toBe(212.7138);
  });

  it('shows the raw and scaled values and the source on the VCD card', () => {
    const html = vcdSectionHtml(vcdParsed.vcd, { fwhmCm: 12, scale: resolution });
    expect(html).toContain('204.4818');
    expect(html).toContain('212.7138');
    expect(html).toContain('Raw / cm⁻¹');
    expect(html).toContain('×0.9613');
    expect(html).toContain('Merrick');
  });

  it('does the same for Raman, leaving the printed activity alone', () => {
    const modes = [{ wavenumber: 1000, ramanActivity: 12.5, depolarizationPlane: 0.3 }];
    const spectrum = ramanSpectrum(modes, { fwhmCm: 12, scale: resolution });
    expect(spectrum.peaks[0].wavenumber).toBeCloseTo(961.3, 9);
    expect(spectrum.peaks[0].wavenumberRaw).toBe(1000);
    expect(spectrum.peaks[0].ramanActivity).toBe(12.5);
    const html = ramanSectionHtml(modes, { fwhmCm: 12, scale: resolution });
    expect(html).toContain('961.3000');
    expect(html).toContain('1000.0000');
    expect(html).toContain('×0.9613');
  });

  it('leaves the spectrum unscaled when no factor applies', () => {
    const unscaled = vcdSpectrum(vcdParsed.vcd, { fwhmCm: 12 });
    expect(unscaled.scaling).toBeNull();
    expect(unscaled.peaks[0].wavenumber).toBe(212.7138);
    expect(unscaled.peaks[0].wavenumberRaw).toBe(212.7138);
  });
});

describe('frequency-scaling card and report', () => {
  it('prints raw, scaled and factor+source in the thermochemistry panel', () => {
    const report = buildThermochemistryReport(water, { frequencyScale: 'auto' });
    const html = thermochemistryPanelHtml(report);
    expect(html).toContain('ZPE correction');
    expect(html).toContain('0.021164');
    expect(html).toContain('0.020345');
    expect(html).toContain('×0.9613');
    expect(html).toContain('Merrick');
    expect(html).toContain('not re-derived');
  });

  it('lists the decision and both ZPEs in the workflow report', () => {
    const resolution = resolveFrequencyScale({ setting: 'auto', method: 'B3LYP', basis: '6-31G(d)' });
    const queue = {
      id: 'q-350',
      projectName: 'Scaling report',
      status: 'completed',
      tasks: [{
        nodeId: 'freq-1', title: 'Water frequency', type: 'calculate', status: 'completed', runId: 'run-1',
      }],
    };
    const record = {
      id: 'run-1',
      status: 'completed',
      provenance: {
        kind: 'calculation',
        jobType: 'Freq',
        method: { functional: 'B3LYP', basis: '6-31G(d)' },
        frequencyScale: frequencyScaleProvenance(resolution),
      },
      parsed: water,
      gates: { overall: 'pass' },
    };
    const model = buildWorkflowReport(queue, { 'run-1': record });
    expect(model.frequencyScaling).toBeTruthy();
    expect(model.frequencyScaling.applied).toBe(1);
    const row = model.frequencyScaling.entries[0];
    expect(row.factor).toBe(B3LYP_FACTOR);
    expect(row.zpeRawHartree).toBe(0.021164);
    expect(row.zpeScaledHartree).toBeCloseTo(0.021164 * B3LYP_FACTOR, 12);
    expect(row.source).toContain('Merrick');
    const html = workflowReportHtml(model);
    expect(html).toContain('Frequency scaling');
    expect(html).toContain('×0.9613');
    expect(html).toContain('0.021164');
    expect(html).toContain('0.020345');
    expect(html).toContain('Merrick');
  });

  it('prints an imported result as not scaled, with its own number', () => {
    const queue = {
      id: 'q-350-imported',
      projectName: 'Imported',
      status: 'completed',
      tasks: [{ nodeId: 'imp-1', title: 'Imported freq', type: 'calculate', status: 'completed', runId: 'imp-run' }],
    };
    const record = {
      schemaVersion: 2,
      kind: 'imported',
      id: 'imp-run',
      program: 'Spartan',
      version: '26',
      method: 'B3LYP',
      basis: '6-31G(d)',
      energy: -76.4,
      sourceSha256: 'a'.repeat(64),
      importedAt: '2026-01-01T00:00:00.000Z',
      parsed: { thermochemistry: { zeroPointCorrectionHartree: 0.021164 } },
    };
    const model = buildWorkflowReport(queue, { 'imp-run': record }, { includeImported: true });
    const row = model.frequencyScaling.entries[0];
    expect(row.mode).toBe('imported');
    expect(row.applied).toBe(false);
    expect(row.factor).toBeNull();
    expect(row.zpeScaledHartree).toBe(row.zpeRawHartree);
    const html = workflowReportHtml(model);
    expect(html).toContain('not applied');
    expect(html).toContain('imported — kept as its producer printed it');
  });

  it('is absent from a report whose records predate the setting', () => {
    const queue = {
      id: 'q-old', projectName: 'Old', status: 'completed',
      tasks: [{ nodeId: 'old-1', title: 'Old run', type: 'calculate', status: 'completed', runId: 'old-run' }],
    };
    const model = buildWorkflowReport(queue, {
      'old-run': { id: 'old-run', status: 'completed', provenance: { kind: 'calculation', jobType: 'Freq' }, parsed: {} },
    });
    expect(model.frequencyScaling).toBeUndefined();
    expect(workflowReportHtml(model)).not.toContain('Frequency scaling');
  });
});

describe('frequencyScale in the project schema', () => {
  const projectText = readFileSync(
    fileURLToPath(new URL('../examples/opt-freq.ncs', import.meta.url)),
    'utf8',
  );
  const freqNode = (project) => project.flows[0].nodes.find((node) => node.id === 'of-freq');

  it('has no serialised default; an absent key reads as unscaled', () => {
    expect(defaultSettings().frequencyScale).toBeUndefined();
    expect(parseFrequencyScaleSetting(undefined)).toEqual({ mode: 'unscaled', factor: 1, setting: 'unscaled' });
    const parsed = parseProjectText(projectText);
    expect(parsed.ok).toBe(true);
    // The example predates the setting, so it stays absent and byte-identical.
    expect(freqNode(parsed.project).settings.frequencyScale).toBeUndefined();
  });

  it('round-trips auto and an explicit factor byte-stably', () => {
    for (const value of ['auto', '0.9613']) {
      const parsed = parseProjectText(projectText);
      freqNode(parsed.project).settings.frequencyScale = value;
      const saved = stringifyProject(parsed.project).text;
      const reread = parseProjectText(saved);
      expect(reread.ok).toBe(true);
      expect(freqNode(reread.project).settings.frequencyScale).toBe(value);
      expect(stringifyProject(reread.project).text).toBe(saved);
    }
  });

  it('rejects a value that is not unscaled, auto or a factor in range', () => {
    const parsed = parseProjectText(projectText);
    freqNode(parsed.project).settings.frequencyScale = 'fast';
    const result = validateProject(parsed.project);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path.endsWith('settings.frequencyScale'))).toBe(true);
  });

  it('warns when a factor is set on a block with no frequency job', () => {
    const parsed = parseProjectText(projectText);
    const opt = parsed.project.flows[0].nodes.find((node) => node.id === 'of-opt');
    opt.settings.frequencyScale = 'auto';
    const result = validateProject(parsed.project);
    expect(result.warnings.some((warning) => warning.path.endsWith('settings.frequencyScale'))).toBe(true);
  });
});
