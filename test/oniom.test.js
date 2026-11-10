import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { parseOniom } from '../src/shared/oniom.js';
import { resultsPanelHtml } from '../src/renderer/resultsView.js';

const fixture = fs.readFileSync(new URL('./fixtures/real/g09-oniom-ir.log', import.meta.url), 'utf8');

function recordFor(parsed) {
  return {
    id: '20261110-120000-oniom',
    status: 'completed',
    engine: 'gaussian',
    title: 'ONIOM frequency',
    dryRun: false,
    inputName: 'oniom.gjf',
    outputName: 'oniom.log',
    outputSource: 'file',
    truncated: false,
    outputBytes: { size: fixture.length, bytesRead: fixture.length, truncated: false, windows: [] },
    inputSha256: 'a'.repeat(64),
    outputSha256: 'b'.repeat(64),
    app: { version: '0.5.0', commit: 'test' },
    provenance: { kind: 'calculation' },
    task: {},
    parsed,
  };
}

describe('ONIOM parsing (issue 67)', () => {
  it('reads the real ONIOM(B3LYP/6-31G(d):PM6) frequency log', () => {
    const parsed = parseGaussianOutput(fixture);
    expect(parsed.status).toBe('completed');
    expect(parsed.program).toMatchObject({ name: 'Gaussian', version: '09', revision: 'C.01' });
    expect(parsed.finalEnergy).toEqual({
      hartree: -1361.740341759642,
      source: 'oniom-extrapolated',
    });
    expect(parsed.oniom).toMatchObject({
      blocks: 1,
      layers: { high: 'B3LYP/6-31G(d)', low: 'pm6' },
      layerCounts: { total: 74, high: 54, low: 20 },
      reconstructionOk: true,
      units: 'hartree',
    });
    expect(parsed.oniom.gridpoints).toHaveLength(3);
    expect(parsed.oniom.gridpoints.map((point) => point.energyHartree)).toEqual([
      0.346273670054,
      -1361.792785320875,
      0.398717231287,
    ]);
    expect(parsed.oniom.cuts).toHaveLength(6);
    expect(parsed.oniom.cuts[0]).toMatchObject({
      highElement: 'C', linkElement: 'H', linkAtom: 9,
      lowElement: 'C', lowAtom: 10,
    });
    expect(parsed.oniom.charges).toMatchObject({
      'low-real': { charge: 0, multiplicity: 1 },
      'high-model': { charge: 0, multiplicity: 1 },
      'low-model': { charge: 0, multiplicity: 1 },
    });
    expect(parsed.oniom.dipole).toMatchObject({ total: 9.6259, units: 'debye' });
  });

  it('returns null for a log with no ONIOM evidence', () => {
    expect(parseOniom('#p hf/6-31g(d)\n\nwater\n')).toBeNull();
  });

  it('shows the extrapolated energy, gridpoints and cuts in the results panel', () => {
    const parsed = parseGaussianOutput(fixture);
    const html = resultsPanelHtml(recordFor(parsed), {});
    expect(html).toContain('data-field="oniom-route"');
    expect(html).toContain('extrapolated ONIOM energy');
    expect(html).toContain('data-field="oniom-gridpoints"');
    expect(html).toContain('data-field="oniom-cuts"');
    expect(html).toContain('High layer · model');
    expect(html).toContain('C / C 10');
    expect(html).toContain('adds up');
    expect(html).toContain('74 atoms');
    expect(html).toContain('54');
    expect(html).toContain('20');
    expect(html).toContain('B3LYP/6-31G(d)');
  });
});
