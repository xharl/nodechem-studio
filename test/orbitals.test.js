import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  HARTREE_TO_EV,
  descriptorsOf,
  frontierOf,
  parseOrbitalBlocks,
  parseOrbitals,
} from '../src/shared/orbitals.js';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { routeFor } from '../src/shared/gaussianInput.js';
import { runValidityChecks } from '../src/shared/validityChecks.js';
import { runRow } from '../src/shared/datasetExport.js';
import { resultsPanelHtml } from '../src/renderer/resultsView.js';

const real = (name) => readFileSync(`test/fixtures/real/${name}`, 'utf8');

/**
 * The numbers below were read out of the fixture files, not out of the parser:
 * the HOMO is the last `occ. eigenvalues` value and the LUMO the first
 * `virt. eigenvalues` one, multiplied by the CODATA hartree.
 */

describe('frontier orbitals from a closed-shell log', () => {
  const parsed = parseOrbitals(real('g16-dvb-sp.out'));

  it('finds the last eigenvalue block and reports a match', () => {
    expect(parsed.matched).toBe(true);
    expect(parsed.openShell).toBe(false);
    expect(parsed.beta).toBeNull();
  });

  it('reads HOMO and LUMO in hartree', () => {
    expect(parsed.alpha.homoHartree).toBeCloseTo(-0.15308, 5);
    expect(parsed.alpha.lumoHartree).toBeCloseTo(0.03742, 5);
  });

  it('converts them to eV with the CODATA hartree', () => {
    expect(parsed.alpha.homoEv).toBeCloseTo(-0.15308 * HARTREE_TO_EV, 5);
    expect(parsed.alpha.lumoEv).toBeCloseTo(0.03742 * HARTREE_TO_EV, 5);
  });

  it('derives the gap, IP and EA from the two orbital energies', () => {
    expect(parsed.alpha.gapEv).toBeCloseTo(5.183769, 5);
    expect(parsed.alpha.ipEv).toBeCloseTo(4.165519, 5);
    expect(parsed.alpha.eaEv).toBeCloseTo(-1.01825, 5);
  });

  it('derives the Koopmans descriptors', () => {
    expect(parsed.alpha.muEv).toBeCloseTo(1.573634, 5);
    expect(parsed.alpha.chiEv).toBeCloseTo(-1.573634, 5);
    expect(parsed.alpha.etaEv).toBeCloseTo(2.591885, 5);
    expect(parsed.alpha.softnessPerEv).toBeCloseTo(0.38582, 5);
    expect(parsed.alpha.electrophilicityEv).toBeCloseTo(0.477708, 5);
  });
});

describe('frontier orbitals from an open-shell log', () => {
  const parsed = parseOrbitals(real('g09-dvb-un-sp.log'));

  it('keeps the alpha and beta manifolds apart', () => {
    expect(parsed.openShell).toBe(true);
    expect(parsed.alpha.spin).toBe('alpha');
    expect(parsed.beta.spin).toBe('beta');
  });

  it('reports each manifold’s own frontier pair', () => {
    // Alpha: the 35th occupied and the first virtual of the alpha list.
    expect(parsed.alpha.homoHartree).toBeCloseTo(-0.36976, 5);
    expect(parsed.alpha.lumoHartree).toBeCloseTo(-0.1775, 5);
    // Beta: fewer occupied orbitals in this doublet, so a different LUMO.
    expect(parsed.beta.homoHartree).toBeCloseTo(-0.38882, 5);
    expect(parsed.beta.lumoHartree).toBeCloseTo(-0.30053, 5);
    expect(parsed.beta.gapEv).toBeCloseTo(2.402493, 5);
  });

  it('does not average the two gaps into one number', () => {
    expect(parsed.alpha.gapEv).not.toBeCloseTo(parsed.beta.gapEv, 2);
    expect(parsed.gapEv).toBe(parsed.alpha.gapEv);
  });
});

describe('a log without the Pop=Full print', () => {
  it('reports matched: false instead of a zero gap', () => {
    const parsed = parseOrbitals(real('g09-water-cis.log'));
    expect(parsed.matched).toBe(false);
    expect(parsed.alpha).toBeNull();
    expect(parsed.gapEv).toBeNull();
    expect(parsed.reason).toMatch(/no orbital eigenvalues/);
  });
});

describe('block handling', () => {
  it('joins eigenvalues wrapped over several lines', () => {
    const text = [
      ' Alpha  occ. eigenvalues --   -0.50000   -0.40000',
      ' Alpha  occ. eigenvalues --   -0.30000',
      ' Alpha virt. eigenvalues --    0.10000    0.20000',
    ].join('\n');
    const [block] = parseOrbitalBlocks(text);
    expect(block.alpha.occupied).toEqual([-0.5, -0.4, -0.3]);
    expect(block.alpha.virtual).toEqual([0.1, 0.2]);
  });

  it('takes the last block when the spectrum is printed twice', () => {
    const text = [
      ' Alpha  occ. eigenvalues --   -0.50000',
      ' Alpha virt. eigenvalues --    0.10000',
      ' Population analysis using the SCF density.',
      ' Alpha  occ. eigenvalues --   -0.45000',
      ' Alpha virt. eigenvalues --    0.15000',
    ].join('\n');
    expect(parseOrbitalBlocks(text)).toHaveLength(2);
    expect(parseOrbitals(text).alpha.gapEv).toBeCloseTo(0.6 * HARTREE_TO_EV, 4);
  });

  it('ignores a fragment of a block with no virtual orbitals', () => {
    const text = ' Alpha  occ. eigenvalues --   -0.50000';
    expect(parseOrbitalBlocks(text)).toEqual([]);
  });

  it('returns null descriptors for a missing frontier pair', () => {
    expect(frontierOf({ occupied: [], virtual: [] })).toBeNull();
    expect(descriptorsOf(null)).toBeNull();
  });
});

describe('the route asks for the print', () => {
  it('emits Pop=Full when orbital descriptors are requested', () => {
    expect(routeFor({ method: 'B3LYP', basis: '6-31G(d)', jobType: 'SP', orbitals: true }))
      .toContain('Pop=Full');
  });

  it('leaves an unrequested block without a population keyword', () => {
    expect(routeFor({ method: 'B3LYP', basis: '6-31G(d)', jobType: 'SP' })).not.toContain('Pop=');
  });

  it('refuses to combine Full with another population analysis', () => {
    expect(() => routeFor({
      method: 'B3LYP', basis: '6-31G(d)', jobType: 'SP', orbitals: true, population: 'NBO',
    })).toThrow(/need Pop=Full, .*also asks for Pop=NBO/);
  });

  it('accepts an explicit Full and does not duplicate the keyword', () => {
    const route = routeFor({ method: 'B3LYP', basis: '6-31G(d)', jobType: 'SP', orbitals: true, population: 'Full' });
    expect(route.match(/Pop=/g)).toHaveLength(1);
  });
});

describe('the pre-run check says the same thing as the route builder', () => {
  const molecule = { coords: [], charge: 0, multiplicity: 1 };
  const finding = (settings) => runValidityChecks({ settings, molecule }, { phase: 'pre' })
    .findings.find((item) => item.id === 'orbital-descriptors');

  it('passes when the block only asks for the orbitals', () => {
    expect(finding({ orbitals: true, population: '', jobType: 'SP' }).status).toBe('pass');
  });

  it('fails when another population analysis is also set', () => {
    const result = finding({ orbitals: true, population: 'NBO', jobType: 'SP' });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Pop=Full');
  });

  it('is a pass when the feature is off', () => {
    expect(finding({ jobType: 'SP' }).status).toBe('pass');
  });
});

describe('the parsed output and the dataset row', () => {
  const parsed = parseGaussianOutput(real('g16-dvb-sp.out'));
  const row = runRow({ id: 'r1', parsed });

  it('is exposed on the parsed output', () => {
    expect(parsed.orbitals.matched).toBe(true);
    expect(parsed.orbitals.alpha.gapEv).toBeCloseTo(5.183769, 5);
  });

  it('reaches the dataset export as numbers', () => {
    expect(row.homoEv).toBeCloseTo(-4.165519, 5);
    expect(row.lumoEv).toBeCloseTo(1.01825, 5);
    expect(row.gapEv).toBeCloseTo(5.183769, 5);
    expect(row.hardnessEv).toBeCloseTo(2.591885, 5);
  });

  it('leaves the cells empty when the log has no orbital print', () => {
    const empty = runRow({ id: 'r2', parsed: parseGaussianOutput(real('g09-water-cis.log')) });
    expect(empty.gapEv).toBeNull();
    expect(empty.homoEv).toBeNull();
  });
});

describe('the results panel card', () => {
  const record = (parsed) => ({
    id: 'r1',
    engine: 'gaussian',
    title: 'Frontier orbitals',
    dryRun: false,
    truncated: false,
    parsed,
    gates: { overall: 'pass', validity: { overall: 'pass' } },
    provenance: { kind: 'calculation', method: { functional: 'B3LYP', basis: '6-31G(d)' } },
  });

  it('renders HOMO, LUMO, the gap and the descriptors', () => {
    const html = resultsPanelHtml(record(parseGaussianOutput(real('g16-dvb-sp.out'))));
    expect(html).toContain('data-field="orbitals"');
    expect(html).toContain('Frontier orbitals');
    expect(html).toContain('5.184'); // gap in eV
    expect(html).toContain('Koopmans');
  });

  it('renders both manifolds for an open-shell run', () => {
    const html = resultsPanelHtml(record(parseGaussianOutput(real('g09-dvb-un-sp.log'))));
    expect(html).toContain('data-field="orbitals"');
    expect(html).toContain('Beta');
    expect(html).toContain('alpha and beta manifolds apart');
  });

  it('renders no card when the log carries no eigenvalue print', () => {
    const html = resultsPanelHtml(record(parseGaussianOutput(real('g09-water-cis.log'))));
    expect(html).not.toContain('data-field="orbitals"');
  });
});
