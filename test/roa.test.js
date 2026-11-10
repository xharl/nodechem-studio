import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { attachRoa, parseRoaIntensities, roaSpectrum } from '../src/shared/roa.js';
import { buildGaussianInput, routeFor } from '../src/shared/gaussianInput.js';
import { defaultSettings, validateProject } from '../src/shared/projectSchema.js';
import { roaSectionHtml } from '../src/renderer/resultsView.js';

const fixture = fs.readFileSync(new URL('./fixtures/real/g09-formaldehyde-roa.out', import.meta.url), 'utf8');

function project(settings = {}) {
  return {
    schemaVersion: 3,
    name: 'ROA test',
    molecule: {
      charge: 0,
      multiplicity: 1,
      fragments: [],
      coords: [
        { element: 'O', x: 0, y: 0, z: 0 },
        { element: 'H', x: 0.96, y: 0, z: 0 },
        { element: 'H', x: -0.24, y: 0.93, z: 0 },
      ],
      geometry: { source: 'imported', file: 'water.xyz', format: 'xyz' },
    },
    defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
    nodes: [{
      id: 'freq', type: 'calculate', title: 'Frequency', state: 'ready', x: 0, y: 0,
      settings: defaultSettings({ jobType: 'Freq', ...settings }), output: null, checkpointFrom: null,
    }],
    edges: [],
  };
}

describe('ROA parsing (#127)', () => {
  it('reads the real G09 formaldehyde ROA section and its three geometries', () => {
    const parsed = parseGaussianOutput(fixture);
    expect(parsed.program).toMatchObject({ name: 'Gaussian', version: '09', revision: 'E.01' });
    expect(parsed.roa).toHaveLength(6);
    expect(parsed.roaMeta).toMatchObject({
      units: '10⁴ K',
      invariantUnits: '10⁴ Å⁵ amu⁻¹',
      incidentWavenumber: 18796.99,
      release: null,
      geometries: {
        roa1: 'ICPu/SCPu(180)',
        roa2: 'ICPd/SCPd(90)',
        roa3: 'DCPI(180)',
        rc180: 'degree of circularity',
      },
    });
    // Every ROA row in this fixture is zero because formaldehyde is achiral:
    // the fixture proves the layout, not the sign. Zero is still a parsed row,
    // so the record must not collapse to null.
    expect(parsed.roa.every((mode) => mode.roa1 === 0 && mode.roa2 === 0 && mode.roa3 === 0)).toBe(true);
    expect(parsed.roa.map((mode) => mode.rc180)).toEqual([0.714, 0.714, 0.266, -0.398, -0.341, 0.714]);
  });

  it('keeps absent ROA rows null and refuses a job with no ROA rows', () => {
    const none = parseRoaIntensities('  Frequencies -- 1 2 3');
    expect(none).toBeNull();
    const modes = attachRoa([{ wavenumber: 1 }, { wavenumber: 2 }], null);
    expect(modes[0]).toMatchObject({ roa1: null, roa2: null, roa3: null, rc180: null });
  });

  it('builds a signed spectrum for a chosen geometry and keeps the sign', () => {
    const text = [
      ' Raman1;ROA1;CID1 =ICPu/SCPu(180), Raman2;ROA2;CID2 =ICPd/SCPd(90)',
      ' Raman3;ROA3;CID3 =DCPI(180) RC180 = degree of circularity',
      ' Incident light (cm**-1):   18796.99',
      ' ROA1   Fr= 1--       1.000                 -2.000',
      ' ROA2   Fr= 1--      -3.000                  4.000',
      ' ROA3   Fr= 1--       5.000                 -6.000',
      ' RC180  Fr= 1--       0.100                 -0.200',
    ].join('\n');
    const table = parseRoaIntensities(text);
    expect(table.roa1).toEqual([1, -2]);
    const modes = attachRoa([{ wavenumber: 100 }, { wavenumber: 200 }], table);
    const spectrum = roaSpectrum(modes, { geometry: 'roa1', fwhmCm: 10 });
    expect(spectrum.signed).toBe(true);
    expect(spectrum.geometryLabel).toBe('ICPu/SCPu(180)');
    expect(spectrum.peaks.map((peak) => peak.intensity)).toEqual([1, -2]);
    expect(spectrum.counts).toEqual({ total: 2, positive: 1, negative: 1 });
    expect(spectrum.curve.some((point) => point.intensity < 0)).toBe(true);
    expect(() => roaSpectrum(modes, { geometry: 'nope' })).toThrow(/Unknown ROA geometry/);
  });
});

describe('ROA input builder (#127)', () => {
  it('writes Freq=ROA and the combined Raman/VCD/ROA form', () => {
    expect(routeFor(defaultSettings({ jobType: 'Freq', roa: true }))).toContain('Freq=ROA');
    expect(routeFor(defaultSettings({ jobType: 'Opt Freq', roa: true }))).toContain('Opt Freq=ROA');
    expect(routeFor(defaultSettings({ jobType: 'Freq', raman: true, vcd: true, roa: true })))
      .toContain('Freq=(Raman,VCD,ROA)');
  });

  it('refuses ROA on a job that has no frequency section', () => {
    expect(() => buildGaussianInput({ settings: defaultSettings({ jobType: 'SP', roa: true }), coords: [] }))
      .toThrow(/ROA intensities need a frequency job/);
  });

  it('round-trips the roa setting in a project', () => {
    const validated = validateProject(project({ roa: true }));
    expect(validated.ok).toBe(true);
    expect(validated.project.nodes[0].settings.roa).toBe(true);
    const reloaded = validateProject(JSON.parse(JSON.stringify(validated.project)));
    expect(reloaded.ok).toBe(true);
    expect(reloaded.project.nodes[0].settings.roa).toBe(true);
  });
});

describe('ROA results card (#127)', () => {
  it('shows the geometry selector, the units and the per-mode table', () => {
    const parsed = parseGaussianOutput(fixture);
    const html = roaSectionHtml(parsed.roa, { geometry: 'roa1', fwhmCm: 12, meta: parsed.roaMeta });
    expect(html).toContain('data-field="roa-spectrum"');
    expect(html).toContain('data-field="roa-modes"');
    expect(html).toContain('ICPu/SCPu(180)');
    expect(html).toContain('10⁴ K');
    expect(html).toContain('RC180');
    expect(html).toContain('incident light 18796.99 cm⁻¹');
  });
});
