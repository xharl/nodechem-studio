import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildPsi4Input, parsePsi4Output, psi4MethodBlock } from '../src/shared/engines/psi4.js';

const fixture = (name) => readFileSync(
  fileURLToPath(new URL(`./fixtures/real/psi4-mp2-freeze-core/${name}`, import.meta.url)), 'utf8',
);

/**
 * Core correlation (issue 174).
 *
 * Psi4 correlates every electron unless told otherwise, so every MP2/CCSD(T)
 * number this app produced was all-electron — 30 mEh away from the frozen-core
 * values the extrapolation literature is written in. The keyword exists
 * (`set freeze_core`); what was missing was a way to ask for it, and a refusal
 * when asking on a method that has no core to correlate.
 */

const WATER = {
  coords: [
    { element: 'O', x: 0, y: 0, z: 0.1173 },
    { element: 'H', x: 0, y: 0.757, z: -0.4692 },
    { element: 'H', x: 0, y: -0.757, z: -0.4692 },
  ],
  charge: 0,
  multiplicity: 1,
};

const build = (settings) => buildPsi4Input({
  settings: { jobType: 'SP', method: 'mp2', basis: 'cc-pvqz', reference: 'rhf', ...settings },
  molecule: WATER,
  inputName: 'mp2.dat',
});

describe('freeze_core in the Psi4 input', () => {
  it('writes nothing when the choice is auto, so existing projects do not move', () => {
    const built = build({});
    expect(built.inputText).not.toContain('freeze_core');
    expect(built.route).toBe('psi4 MP2/cc-pVQZ');
    // 'auto' is the same input as an absent field: no surprise change on open.
    expect(build({ freezeCore: 'auto' }).inputText).toBe(built.inputText);
  });

  it('writes set freeze_core true for a frozen-core run', () => {
    const built = build({ freezeCore: 'true' });
    expect(built.inputText).toContain('set freeze_core true');
    expect(built.route).toBe('psi4 MP2/cc-pVQZ (frozen core)');
    // The keyword belongs with the other SCF-level settings, before the call.
    expect(built.inputText.indexOf('set freeze_core true'))
      .toBeLessThan(built.inputText.indexOf("energy('mp2')"));
  });

  it('writes set freeze_core false for an explicitly all-electron run', () => {
    const built = build({ freezeCore: 'false', method: 'ccsd(t)' });
    expect(built.inputText).toContain('set freeze_core false');
    expect(built.route).toBe('psi4 CCSD(T)/cc-pVQZ (all-electron)');
  });

  it('accepts a boolean as well as the string, and one spelling only', () => {
    expect(build({ freezeCore: true }).inputText).toContain('set freeze_core true');
    expect(build({ freezeCore: false }).inputText).toContain('set freeze_core false');
    expect(() => build({ freezeCore: 'yes' })).toThrow(/auto, frozen or all-electron/i);
  });

  it('refuses the choice on a method with no correlation step', () => {
    expect(() => build({ method: 'b3lyp', freezeCore: 'true' }))
      .toThrow(/Freezing the core means excluding the 1s electrons .* B3LYP has no correlation step/i);
    expect(() => build({ method: 'sapt0', freezeCore: 'true' }))
      .toThrow(/has no correlation step/i);
    // But auto on a functional is fine: it writes nothing, so there is nothing to refuse.
    expect(() => build({ method: 'b3lyp', freezeCore: 'auto' })).not.toThrow();
  });
});

describe('freeze_core in the record', () => {
  it('names the choice for a correlated method, and the engine default when unset', () => {
    expect(psi4MethodBlock({ method: 'mp2', freezeCore: 'true' }).freezeCore).toBe('frozen core');
    expect(psi4MethodBlock({ method: 'mp2', freezeCore: 'false' }).freezeCore).toBe('all-electron');
    expect(psi4MethodBlock({ method: 'mp2' }).freezeCore).toBe('engine default');
  });

  it('records nothing for a method that cannot have the setting', () => {
    expect(psi4MethodBlock({ method: 'b3lyp' }).freezeCore).toBeNull();
    expect(psi4MethodBlock({ method: 'sapt0' }).freezeCore).toBeNull();
    expect(psi4MethodBlock({ method: 'td-b3lyp' }).freezeCore).toBeNull();
  });
});

describe('what the setting is worth, measured', () => {
  /**
   * Two real Psi4 1.11 runs of water/cc-pVQZ DF-MP2 that differ in one line
   * (`test/fixtures/real/psi4-mp2-freeze-core/README.md`). This is the issue's own
   * acceptance value, reproduced through the parser rather than read off a screen.
   */
  it('reads the frozen-core and all-electron totals apart', () => {
    const frozen = parsePsi4Output(fixture('frozen-core.log'));
    const allElectron = parsePsi4Output(fixture('all-electron.log'));

    expect(frozen.finalEnergy.hartree).toBeCloseTo(-76.3476092976907097, 9);
    expect(allElectron.finalEnergy.hartree).toBeCloseTo(-76.3780890602055536, 9);
    expect(frozen.finalEnergy.source).toBe('mp2');
    expect(allElectron.finalEnergy.source).toBe('mp2');

    const gapEh = frozen.finalEnergy.hartree - allElectron.finalEnergy.hartree;
    expect(gapEh * 1000).toBeCloseTo(30.48, 2);
  });

  it('does not mistake the SCS banner that sits between the two totals', () => {
    // 1.18 mEh from the frozen-core answer: close enough to look right, which is
    // exactly why #159 shipped a wrong number for a while.
    const frozen = parsePsi4Output(fixture('frozen-core.log')).finalEnergy.hartree;
    expect(frozen).not.toBeCloseTo(-76.3464255463388639, 6);
    expect(Math.abs(frozen - (-76.3464255463388639)) * 1000).toBeCloseTo(1.18, 2);
  });
});
