import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parsePsi4Output } from '../src/shared/engines/psi4.js';

/**
 * Issue 159: an MP2 job reported the SCS-MP2 total.
 *
 * Psi4 1.11 prints an MP2 job's canonical total under a `DF-MP2 Energies` banner
 * and a spin-component-scaled total under a separate `DF-SCS-MP2 Energies`
 * banner whose line also says "Total Energy". The parser's last-match found the
 * scaled number, so an MP2 result was a different method's energy — 3.79 mEh on
 * water/def2-SVP, with a basis-dependent sign.
 *
 * The fixtures are real Psi4 1.11 logs; see `test/fixtures/psi4-energy/README.md`
 * for the provenance, the exact decks and the line numbers of every value
 * asserted here.
 */

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/psi4-energy/${name}`, import.meta.url)), 'utf8');

describe('Psi4 correlated energies', () => {
  it('reports the canonical MP2 total, not the SCS total', () => {
    const parsed = parsePsi4Output(fixture('mp2.log'));
    // mp2.log §322 — the DF-MP2 banner.
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-76.1644174279037287, 10);
    expect(parsed.finalEnergy.source).toBe('mp2');
    // mp2.log §331 — the SCS banner, which is what the bug reported.
    expect(parsed.finalEnergy.hartree).not.toBeCloseTo(-76.1606265225481280, 10);
    // The SCF block also carries a bare `Total Energy =`; the result must not be
    // that either (mp2.log §238).
    expect(parsed.finalEnergy.hartree).not.toBeCloseTo(-75.9609364137418623, 10);
  });

  it('labels a CCSD result as CCSD and not as the CCSD(T) or MP2 number', () => {
    const parsed = parsePsi4Output(fixture('ccsd.log'));
    // ccsd.log §485.
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-76.173908391493654, 10);
    expect(parsed.finalEnergy.source).toBe('ccsd');
    // §479 (MP2) and §237 (SCF) are the wrong numbers for this job.
    expect(parsed.finalEnergy.hartree).not.toBeCloseTo(-76.164558850575290, 6);
    expect(parsed.finalEnergy.hartree).not.toBeCloseTo(-75.9609364137418623, 6);
  });

  it('reports the CCSD(T) total when the job asked for it', () => {
    const parsed = parsePsi4Output(fixture('ccsdt.log'));
    // ccsdt.log §511.
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-76.176912084901602, 10);
    expect(parsed.finalEnergy.source).toBe('ccsd(t)');
    // The same log's CCSD line (§485) is a different, lower level of theory.
    expect(parsed.finalEnergy.hartree).not.toBeCloseTo(-76.173908391493654, 8);
  });

  it('keeps the older `Total CCSD energy (file100)` spelling working', () => {
    // Psi4 1.9 and earlier print the file tag between the words and the sign.
    const legacy = [
      '  SCF energy       (wfn)                    =  -75.960936413741862',
      '    Total CCSD energy   (file100)            =  -76.173908391493654',
      '*** Psi4 exiting successfully. Buy a developer a beer!',
    ].join('\n');
    const parsed = parsePsi4Output(legacy);
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-76.173908391493654, 10);
    expect(parsed.finalEnergy.source).toBe('ccsd');
  });

  it('still reads a plain SCF single point from its own line', () => {
    const scf = [
      '  @DF-RHF Final Energy:   -75.96093641374186',
      '    Total Energy =                        -75.9609364137418623',
      '*** Psi4 exiting successfully. Buy a developer a beer!',
    ].join('\n');
    const parsed = parsePsi4Output(scf);
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-75.9609364137418623, 10);
    expect(parsed.finalEnergy.source).toBe('total-energy');
  });
});

describe('Psi4 method and basis lookup', () => {
  it('accepts the label the inspector writes, the key, and the ASCII spelling', async () => {
    const { psi4MethodFor, psi4BasisFor } = await import('../src/shared/engines/psi4.js');
    for (const spelling of ['ωB97X-D', 'wB97X-D', 'wb97x-d', 'WB97X-D']) {
      expect(psi4MethodFor({ method: spelling }).fn).toBe('wb97x-d');
    }
    // A label whose key differs only in case still resolves, and an unknown
    // method still fails while naming the request.
    expect(psi4MethodFor({ method: 'b3lyp' }).fn).toBe('b3lyp');
    expect(() => psi4MethodFor({ method: 'B3LYP-D3' })).toThrow(/cannot run method "B3LYP-D3"/);
    expect(psi4BasisFor({ basis: 'def2-TZVP' }).psi4).toBe('def2-tzvp');
    expect(psi4BasisFor({ basis: 'def2-tzvp' }).psi4).toBe('def2-tzvp');
  });
});
