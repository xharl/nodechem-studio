import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ASSIGNMENT_QUANTITIES,
  SPECTRUM_MATCH_METRIC,
  assignmentPanelHtml,
  assignmentProvenance,
  boltzmannSpectrum,
  memberFromRecord,
  rankCandidates,
  spectrumMatch,
  withSpectrumAssignment,
} from '../src/shared/spectrumAssignment.js';
import { boltzmannWeights } from '../src/shared/conformers.js';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { importMeasuredSpectrum } from '../src/shared/spectrumImport.js';
import { spectrumAssignmentCardHtml } from '../src/renderer/resultsView.js';
import { spectrumAssignmentSectionHtml } from '../src/shared/workflowReport.js';

const readFixture = (name) => fs.readFileSync(
  fileURLToPath(new URL(`./fixtures/measured/${name}`, import.meta.url)),
  'utf8',
);

/** A synthetic measured trace sampled from a computed curve (cm⁻¹). */
function traceFrom(spectrum, { source = 'synthetic measured trace' } = {}) {
  return {
    source,
    sha256: '0'.repeat(64),
    axis: 'wavenumber',
    units: { x: 'cm⁻¹', y: 'not declared' },
    points: spectrum.curve.map((point) => ({ x: point.wavenumber, y: point.intensity })),
  };
}

/** The first text of a `data-field` occurrence, for comparing two surfaces. */
function fieldText(html, name) {
  const match = String(html).match(new RegExp(`data-field="${name}"[^>]*>([^<]+)<`));
  return match ? match[1] : null;
}

const fieldTexts = (html, name) => [...String(html).matchAll(
  new RegExp(`data-field="${name}"[^>]*>([^<]+)<`, 'g'),
)].map((match) => match[1]);

const vcdMembers = () => {
  const weights = boltzmannWeights([0, 0.4], 298.15);
  return [
    {
      id: 'c1',
      population: weights[0],
      modes: [
        { wavenumber: 1000, rotationalStrength: 40 },
        { wavenumber: 1100, rotationalStrength: -20 },
      ],
    },
    {
      id: 'c2',
      population: weights[1],
      modes: [
        { wavenumber: 1010, rotationalStrength: 30 },
        { wavenumber: 1090, rotationalStrength: 10 },
      ],
    },
  ];
};

describe('Boltzmann averaging within one candidate', () => {
  it('builds the curve as the hand-computed population-weighted stick sum', () => {
    const members = vcdMembers();
    const fwhmCm = 20;
    const points = 41;
    const result = boltzmannSpectrum(members, { quantity: 'vcd', fwhmCm, points, temperatureK: 298.15 });

    expect(result.available).toBe(true);
    expect(result.quantity).toBe('vcd');
    expect(result.signed).toBe(true);
    expect(result.populations).toEqual([
      { id: 'c1', population: members[0].population, source: 'stored population' },
      { id: 'c2', population: members[1].population, source: 'stored population' },
    ]);
    expect(result.populations[0].population + result.populations[1].population).toBeCloseTo(1, 12);
    expect(result.curve).toHaveLength(points);

    // The peak table carries both the printed strength and the weighted one, so
    // the arithmetic below can be read off the result.
    const peak1000 = result.peaks.find((peak) => peak.wavenumber === 1000);
    expect(peak1000.weightedStrength).toBeCloseTo(members[0].population * 40, 12);
    const peak1010 = result.peaks.find((peak) => peak.wavenumber === 1010);
    expect(peak1010.weightedStrength).toBeCloseTo(members[1].population * 30, 12);

    const half = fwhmCm / 2;
    const weighted = [
      [members[0].population * 40, 1000],
      [members[0].population * -20, 1100],
      [members[1].population * 30, 1010],
      [members[1].population * 10, 1090],
    ];
    const strongest = Math.max(...weighted.map(([strength]) => Math.abs(strength)));
    for (const point of result.curve) {
      const expected = weighted.reduce((sum, [strength, wavenumber]) => {
        const delta = point.wavenumber - wavenumber;
        return sum + (strength * half * half) / (delta * delta + half * half);
      }, 0) / strongest;
      expect(point.intensity, `at ${point.wavenumber.toFixed(3)} cm⁻¹`).toBeCloseTo(expected, 12);
    }
    // One literal number, independent of the loop: at the strongest stick the
    // weighted sum is the self term plus the tails of the other three.
    const at1000 = result.curve.reduce((best, point) => (
      Math.abs(point.wavenumber - 1000) < Math.abs(best.wavenumber - 1000) ? point : best
    ));
    expect(at1000.intensity).toBeCloseTo(1.1948, 4);
  });

  it('refuses by name when a member carries no strengths, instead of averaging the others', () => {
    const members = vcdMembers();
    members[1] = { id: 'c2', population: members[1].population, modes: [{ wavenumber: 1010 }] };
    const result = boltzmannSpectrum(members, { quantity: 'vcd' });
    expect(result.available).toBe(false);
    expect(result.code).toBe('member-without-strengths');
    expect(result.memberId).toBe('c2');
    expect(result.reason).toContain('c2');
    expect(result.reason).toContain('VCD rotational strength');
    expect(result.reason).toMatch(/refusing to average/i);

    const noIr = vcdMembers().map((member, index) => ({
      ...member,
      modes: member.modes.map((mode) => ({
        wavenumber: mode.wavenumber,
        ...(index === 0 ? { irIntensity: 10 } : {}),
      })),
    }));
    const irResult = boltzmannSpectrum(noIr, { quantity: 'ir' });
    expect(irResult.available).toBe(false);
    expect(irResult.reason).toContain('c2');
    expect(irResult.reason).toContain('IR intensity');
  });

  it('refuses a missing stored population rather than renormalising over the rest', () => {
    const members = vcdMembers();
    members[1] = { ...members[1], population: null };
    const result = boltzmannSpectrum(members, { quantity: 'vcd' });
    expect(result.available).toBe(false);
    expect(result.code).toBe('member-without-population');
    expect(result.reason).toContain('c2');
  });

  it('reads the mode shapes the Gaussian parser already produces', () => {
    const parsed = parseGaussianOutput(fs.readFileSync(
      fileURLToPath(new URL('./fixtures/real/g16-propyleneoxide-vcd.out', import.meta.url)),
      'utf8',
    ));
    const record = { id: 'run-vcd', parsed, conformer: { id: 'c1', population: 1 } };
    const vcd = memberFromRecord(record, 'vcd');
    expect(vcd.modes.length).toBeGreaterThan(0);
    expect(vcd.modes.some((mode) => Number.isFinite(mode.rotationalStrength))).toBe(true);
    expect(boltzmannSpectrum([vcd], { quantity: 'vcd' }).available).toBe(true);

    const ir = memberFromRecord(record, 'ir');
    expect(ir.modes.length).toBeGreaterThan(0);
    expect(ir.modes.some((mode) => Number.isFinite(mode.irIntensity))).toBe(true);
    expect(boltzmannSpectrum([ir], { quantity: 'ir' }).available).toBe(true);
  });

  it('averages Raman from the same mode shape and keeps raw wavenumbers when a scale factor applies', () => {
    const members = [
      { id: 'r1', population: 0.6, modes: [{ wavenumber: 400, ramanActivity: 20 }, { wavenumber: 800, ramanActivity: 5 }] },
      { id: 'r2', population: 0.4, modes: [{ wavenumber: 410, ramanActivity: 10 }, { wavenumber: 790, ramanActivity: 8 }] },
    ];
    const result = boltzmannSpectrum(members, {
      quantity: 'raman',
      fwhmCm: 20,
      scale: { applied: true, factor: 0.96, mode: 'auto', source: 'Merrick 2007', tableVersion: '1.0.0' },
    });
    expect(result.available).toBe(true);
    expect(result.units).toBe(ASSIGNMENT_QUANTITIES.raman.units);
    expect(result.peaks.find((peak) => peak.memberId === 'r1').wavenumber).toBeCloseTo(384, 9);
    expect(result.peaks.find((peak) => peak.memberId === 'r1').wavenumberRaw).toBe(400);
    expect(result.scaling.applied).toBe(true);
    expect(result.scaling.factor).toBe(0.96);
  });
});

describe('Comparison with a measured trace', () => {
  it('scores a measured trace imported from the two-column fixture and ranks the generating candidate first', () => {
    const measured = importMeasuredSpectrum({
      name: 'ir-two-bands-synthetic.csv',
      text: readFixture('ir-two-bands-synthetic.csv'),
    });
    expect(measured.axis).toBe('wavenumber');
    expect(measured.points.length).toBeGreaterThan(20);

    const generating = {
      id: 'gen',
      label: 'generating candidate',
      kind: 'conformer-set',
      members: [
        {
          id: 'g1',
          population: 0.7,
          modes: [
            { wavenumber: 1580, irIntensity: 1.0 },
            { wavenumber: 1650, irIntensity: 0.4 },
          ],
        },
        {
          id: 'g2',
          population: 0.3,
          modes: [
            { wavenumber: 1580, irIntensity: 0.8 },
            { wavenumber: 1650, irIntensity: 0.9 },
          ],
        },
      ],
    };
    const near = {
      id: 'near',
      label: 'near miss',
      kind: 'stereoisomer',
      members: [{
        id: 'n1',
        population: null,
        modes: [
          { wavenumber: 1592, irIntensity: 1.0 },
          { wavenumber: 1664, irIntensity: 0.5 },
        ],
      }],
    };
    const decoy = {
      id: 'decoy',
      label: 'decoy',
      kind: 'tautomer',
      members: [{
        id: 'd1',
        population: null,
        modes: [
          { wavenumber: 1540, irIntensity: 1.0 },
          { wavenumber: 1690, irIntensity: 0.5 },
        ],
      }],
    };

    const result = rankCandidates({
      candidates: [generating, near, decoy],
      measured,
      quantity: 'ir',
      fwhmCm: 20,
      toleranceCm: 30,
    });

    expect(result.available).toBe(true);
    expect(result.quantity).toBe('ir');
    expect(result.ranking).toEqual(['gen', 'near', 'decoy']);
    expect(result.leader.id).toBe('gen');
    expect(result.runnerUp.id).toBe('near');
    expect(result.margin.combined).toBeGreaterThan(0.05);
    expect(result.candidates[0].comparison.cosine).toBeCloseTo(1, 3);
    expect(result.candidates[0].comparison.bandScore).toBeGreaterThan(0.99);
    expect(result.candidates[0].comparison.combined).toBeGreaterThan(result.candidates[2].comparison.combined);
    expect(result.candidates[0].comparison.scale.factor).toBeGreaterThan(0);
    expect(result.metric).toEqual(SPECTRUM_MATCH_METRIC);
    expect(result.provenance.metric.version).toBe(1);

    const html = assignmentPanelHtml(result);
    expect(html).toContain('is supported by the measurement');
    expect(html).toContain('data-field="assignment-curve"');
    expect(html).toContain('Computed (solid) and measured (dashed)');
    expect(fieldText(html, 'assignment-leader-score')).toBe(result.leader.comparison.combined.toFixed(4));
    expect(fieldText(html, 'assignment-margin')).toBe(result.margin.combined.toFixed(4));
    expect(fieldText(html, 'assignment-metric')).toBe(`${SPECTRUM_MATCH_METRIC.id}/${SPECTRUM_MATCH_METRIC.version}`);
  });

  it('refuses a wavelength trace by name instead of converting nm to cm⁻¹', () => {
    const measured = importMeasuredSpectrum({
      name: 'absorbance-known-peak.csv',
      text: readFixture('absorbance-known-peak.csv'),
    });
    expect(measured.axis).toBe('wavelength');
    const result = rankCandidates({
      candidates: [
        { id: 'a', kind: 'conformer-set', members: [{ id: 'a1', population: 1, modes: [{ wavenumber: 400, irIntensity: 1 }] }] },
        { id: 'b', kind: 'conformer-set', members: [{ id: 'b1', population: 1, modes: [{ wavenumber: 420, irIntensity: 1 }] }] },
      ],
      measured,
      quantity: 'ir',
    });
    expect(result.available).toBe(false);
    expect(result.code).toBe('measured-axis');
    expect(result.reason).toMatch(/nm to cm⁻¹/);
  });

  it('scores a VCD band of the opposite sign as zero', () => {
    const positive = boltzmannSpectrum([
      { id: 'p', population: 1, modes: [{ wavenumber: 1250, rotationalStrength: 30 }] },
    ], { quantity: 'vcd', fwhmCm: 16 });
    const negative = boltzmannSpectrum([
      { id: 'n', population: 1, modes: [{ wavenumber: 1250, rotationalStrength: -30 }] },
    ], { quantity: 'vcd', fwhmCm: 16 });
    const measured = traceFrom(positive, { source: 'synthetic VCD trace' });
    const same = spectrumMatch(positive, measured, { toleranceCm: 20 });
    const opposite = spectrumMatch(negative, measured, { toleranceCm: 20 });
    expect(same.bandScore).toBeGreaterThan(0.9);
    expect(opposite.bandScore).toBe(0);
    expect(opposite.bands[0].signMatch).toBe(false);
    expect(opposite.bands[0].score).toBe(0);
  });
});

describe('Ranking tautomers and stereoisomers', () => {
  it('ranks tautomer candidates separately and never merges their populations', () => {
    const tautA = boltzmannSpectrum([
      { id: 'a1', population: null, modes: [{ wavenumber: 1600, irIntensity: 1 }] },
    ], { quantity: 'ir', fwhmCm: 20 });
    const measured = traceFrom(tautA, { source: 'synthetic tautomer trace' });
    const result = rankCandidates({
      candidates: [
        {
          id: 'taut-A',
          label: '2-pyridone',
          kind: 'tautomer',
          members: [{ id: 'a1', population: null, modes: [{ wavenumber: 1600, irIntensity: 1 }] }],
        },
        {
          id: 'taut-B',
          label: '2-hydroxypyridine',
          kind: 'tautomer',
          members: [{ id: 'b1', population: null, modes: [{ wavenumber: 1680, irIntensity: 1 }] }],
        },
      ],
      measured,
      quantity: 'ir',
      fwhmCm: 20,
    });

    expect(result.available).toBe(true);
    expect(result.candidates.map((candidate) => candidate.kind)).toEqual(['tautomer', 'tautomer']);
    expect(result.ranking).toEqual(['taut-A', 'taut-B']);
    expect(result.averaging).toMatch(/within each candidate only/i);
    expect(result.crossCandidateAveraging).toBe('refused');
    expect(result.provenance.populations).toHaveLength(2);
    expect(result.provenance.populations.map((entry) => entry.candidateId)).toEqual(['taut-A', 'taut-B']);
    expect(result.provenance.populations[0].members.map((member) => member.id)).toEqual(['a1']);
    expect(result.provenance.populations[1].members.map((member) => member.id)).toEqual(['b1']);
    expect(result.candidates[1].spectrum.peaks.every((peak) => peak.memberId === 'b1')).toBe(true);
    expect(result.candidates[0].populations[0].source).toBe('single member, no population stored');

    const html = assignmentPanelHtml(result);
    expect(html).toContain('ranked, never merged');
    expect(html).toContain('2-pyridone');
    expect(html).toContain('2-hydroxypyridine');
  });

  it('keeps a stereoisomer a separate candidate with its own members', () => {
    const measured = traceFrom(boltzmannSpectrum([
      { id: 's1', population: 1, modes: [{ wavenumber: 900, irIntensity: 1 }] },
    ], { quantity: 'ir', fwhmCm: 20 }));
    const result = rankCandidates({
      candidates: [
        {
          id: 'R',
          label: 'R',
          kind: 'stereoisomer',
          members: [
            { id: 'R1', population: 0.6, modes: [{ wavenumber: 900, irIntensity: 1 }] },
            { id: 'R2', population: 0.4, modes: [{ wavenumber: 905, irIntensity: 1 }] },
          ],
        },
        {
          id: 'S',
          label: 'S',
          kind: 'stereoisomer',
          members: [
            { id: 'S1', population: 0.5, modes: [{ wavenumber: 940, irIntensity: 1 }] },
            { id: 'S2', population: 0.5, modes: [{ wavenumber: 945, irIntensity: 1 }] },
          ],
        },
      ],
      measured,
      quantity: 'ir',
      fwhmCm: 20,
    });
    expect(result.ranking).toEqual(['R', 'S']);
    expect(result.candidates[0].populations.map((entry) => entry.id)).toEqual(['R1', 'R2']);
    expect(result.candidates[1].populations.map((entry) => entry.id)).toEqual(['S1', 'S2']);
    expect(result.provenance.leader.id).toBe('R');
  });
});

describe('One result, two surfaces', () => {
  const result = (() => {
    const generating = {
      id: 'gen',
      label: 'generating candidate',
      kind: 'conformer-set',
      members: [{ id: 'g1', population: 1, modes: [{ wavenumber: 1580, irIntensity: 1 }, { wavenumber: 1650, irIntensity: 0.6 }] }],
    };
    const decoy = {
      id: 'decoy',
      label: 'decoy',
      kind: 'tautomer',
      members: [{ id: 'd1', population: null, modes: [{ wavenumber: 1540, irIntensity: 1 }, { wavenumber: 1690, irIntensity: 0.5 }] }],
    };
    const measured = importMeasuredSpectrum({
      name: 'ir-two-bands-synthetic.csv',
      text: readFixture('ir-two-bands-synthetic.csv'),
    });
    return rankCandidates({ candidates: [generating, decoy], measured, quantity: 'ir', fwhmCm: 20 });
  })();

  it('prints the same numbers in the results card and the report', () => {
    const record = withSpectrumAssignment({ id: 'run-1', title: 'Assignment', provenance: { kind: 'calculation' } }, result);
    const cardHtml = spectrumAssignmentCardHtml(record);
    const reportHtml = spectrumAssignmentSectionHtml([{ title: 'Assignment', result }]);

    expect(cardHtml).toContain('Spectrum assignment');
    expect(reportHtml).toContain('Spectrum assignment');
    for (const field of ['assignment-leader-score', 'assignment-margin', 'assignment-metric']) {
      expect(fieldText(cardHtml, field)).toBe(fieldText(reportHtml, field));
    }
    expect(fieldText(cardHtml, 'assignment-leader-score')).toBe(result.leader.comparison.combined.toFixed(4));
    expect(fieldTexts(cardHtml, 'assignment-combined')).toEqual(fieldTexts(reportHtml, 'assignment-combined'));
    expect(fieldTexts(cardHtml, 'assignment-scale-factor')).toEqual(fieldTexts(reportHtml, 'assignment-scale-factor'));
  });

  it('records populations, FWHM, scale factors and the metric version in provenance', () => {
    const record = withSpectrumAssignment({ id: 'run-1', provenance: { kind: 'calculation' } }, result);
    const provenance = record.provenance.spectrumAssignment;
    expect(provenance.kind).toBe('spectrum-assignment');
    expect(provenance.fwhmCm).toBe(20);
    expect(provenance.metric).toEqual(SPECTRUM_MATCH_METRIC);
    expect(provenance.metric.version).toBe(1);
    expect(provenance.populations[0]).toMatchObject({
      candidateId: 'gen',
      kind: 'conformer-set',
      members: [{ id: 'g1', population: 1, source: 'stored population' }],
    });
    expect(provenance.scaleFactors[0].factor).toBe(result.candidates[0].comparison.scale.factor);
    expect(provenance.measured.source).toBe('ir-two-bands-synthetic.csv');
    expect(provenance.crossCandidateAveraging).toBe('refused');
    expect(assignmentProvenance(result)).toEqual(provenance);
  });

  it('renders a refusal as a sentence rather than an empty table', () => {
    const refused = assignmentProvenance({ available: false, code: 'member-without-strengths', reason: 'member c2 carries no VCD rotational strength' });
    expect(refused.available).toBe(false);
    const html = assignmentPanelHtml({ available: false, code: 'member-without-strengths', reason: 'member c2 carries no VCD rotational strength' });
    expect(html).toContain('Spectrum assignment not computed');
    expect(html).toContain('member c2');
  });
});
