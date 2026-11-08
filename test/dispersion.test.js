import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { D4_FLOOR, dispersionSupport, revisionAtLeast } from '../src/shared/dispersion.js';
import { evaluateGates, parseGaussianOutput } from '../src/shared/gaussianOutput.js';

const fixture = (name) => parseGaussianOutput(readFileSync(
  fileURLToPath(new URL(`./fixtures/real/${name}`, import.meta.url)), 'utf8',
));

describe('revision comparison', () => {
  it('orders revisions by letter then number', () => {
    expect(revisionAtLeast('C.01', 'C.01')).toBe(true);
    expect(revisionAtLeast('C.02', 'C.01')).toBe(true);
    expect(revisionAtLeast('A.03', 'C.01')).toBe(false);
    expect(revisionAtLeast('D.01', 'C.01')).toBe(true);
    expect(revisionAtLeast('', 'C.01')).toBeNull();
  });

  it('states the floor once', () => {
    expect(D4_FLOOR).toEqual({ version: '16', revision: 'C.01' });
  });
});

describe('D4 support', () => {
  it('refuses Gaussian 16 rev. A.03 with the reason and the revision', () => {
    const check = dispersionSupport({ version: '16', revision: 'A.03' }, 'D4');
    expect(check.status).toBe('unsupported');
    expect(check.detail).toBe(
      'EmpiricalDispersion=D4 requires Gaussian 16 rev. C.01 or later; this output reports Gaussian 16 rev. A.03.',
    );
  });

  it('refuses Gaussian 09', () => {
    expect(dispersionSupport({ version: '09', revision: 'D.01' }, 'D4').status).toBe('unsupported');
  });

  it('accepts Gaussian 16 rev. C.01 and later', () => {
    expect(dispersionSupport({ version: '16', revision: 'C.01' }, 'D4').status).toBe('ok');
    expect(dispersionSupport({ version: '16', revision: 'D.01' }, 'D4').status).toBe('ok');
  });

  it('is unknown, never ok, when the version is not printed', () => {
    const check = dispersionSupport({ version: null }, 'D4');
    expect(check.status).toBe('unknown');
    expect(check.detail).toMatch(/does not state the Gaussian version/);
  });

  it('does not gate the corrections it cannot pin to a revision', () => {
    expect(dispersionSupport({ version: '09', revision: 'D.01' }, 'GD3BJ')).toEqual({ status: 'ok', detail: null });
  });
});

describe('the gate on a real log', () => {
  it('fails the run when D4 was requested from a revision that lacks it', () => {
    const gates = evaluateGates(fixture('g16-dvb-sp.out'), { dispersion: 'D4' });
    const gate = gates.gates.find((entry) => entry.name === 'Dispersion supported');
    expect(gate.result).toBe('fail');
    expect(gate.detail).toMatch(/rev\. A\.03/);
    expect(gates.overall).not.toBe('pass');
  });

  it('adds no gate when no dispersion was requested', () => {
    const gates = evaluateGates(fixture('g16-dvb-sp.out'), { dispersion: '' });
    expect(gates.gates.some((entry) => entry.name === 'Dispersion supported')).toBe(false);
  });
});
