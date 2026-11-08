import { describe, expect, it } from 'vitest';
import {
  ECP_FIRST_ELEMENT,
  basisNameFor,
  ecpFromInput,
  ecpMissingMessage,
  ecpRequirement,
  needsEcp,
} from '../src/shared/ecp.js';
import { buildGaussianInput, routeFor } from '../src/shared/gaussianInput.js';
import { runValidityChecks } from '../src/shared/validityChecks.js';

const pdComplex = {
  charge: 0,
  multiplicity: 1,
  coords: [
    { element: 'Pd', x: 0, y: 0, z: 0 },
    { element: 'C', x: 1.9, y: 0, z: 0 },
    { element: 'O', x: 2.9, y: 0, z: 0.4 },
  ],
};

const settings = {
  functional: 'B3LYP',
  basis: 'def2-SVP',
  jobType: 'SP',
  dispersion: 'GD3BJ',
};

describe('ECP requirement', () => {
  it('knows where the all-electron def2 range ends', () => {
    expect(ECP_FIRST_ELEMENT).toBe(37);
    expect(needsEcp('def2-SVP', 36)).toBe(false);
    expect(needsEcp('def2-SVP', 46)).toBe(true);
  });

  it('treats a def2 basis as native for a heavy element', () => {
    // Gaussian 16 ships Def2SVP with its ECPs, so the route keyword carries the
    // potential and no GenECP card block is written. A real A.03 run rejected
    // the card block at link 301; the native keyword is the documented path.
    const requirement = ecpRequirement({ basis: 'def2-SVP', elements: ['Pd', 'C', 'O'] });
    expect(requirement.needed).toBe(false);
    expect(requirement.native).toBe(true);
    expect(requirement.blocks).toBe('');
    expect(basisNameFor('def2-SVP', requirement)).toBe('def2-SVP');
    expect(ecpRequirement({ basis: 'def2-TZVP', elements: ['I'] }).needed).toBe(false);
  });

  it('leaves a light-element job alone', () => {
    const requirement = ecpRequirement({ basis: 'def2-SVP', elements: ['C', 'H', 'O'] });
    expect(requirement.needed).toBe(false);
    expect(requirement.blocks).toBe('');
    expect(basisNameFor('def2-SVP', requirement)).toBe('def2-SVP');
  });

  it('has nothing to refuse for a native basis, even for tungsten', () => {
    const requirement = ecpRequirement({ basis: 'def2-SVP', elements: ['W'] });
    expect(requirement.needed).toBe(false);
    expect(requirement.missing).toEqual([]);
    expect(ecpMissingMessage(requirement)).toBeNull();
  });

  it('treats SDD as native too', () => {
    const requirement = ecpRequirement({ basis: 'SDD', elements: ['Pd'] });
    expect(requirement.needed).toBe(false);
    expect(requirement.native).toBe(true);
    expect(ecpRequirement({ basis: 'SDD', elements: ['W'] }).missing).toEqual([]);
  });

  it('does not claim ECP support for a basis it has no table for', () => {
    expect(ecpRequirement({ basis: '6-31G(d)', elements: ['Pd'] }).needed).toBe(false);
    expect(ecpRequirement({ basis: 'lanl2dz', elements: ['Pd'] }).needed).toBe(false);
  });
});

describe('input file', () => {
  it('writes a native def2 route for a Pd complex, with no card block', () => {
    const text = buildGaussianInput({ settings, molecule: pdComplex, inputName: 'pd.gjf' });
    expect(text).toMatch(/^#p B3LYP\/def2SVP SP EmpiricalDispersion=GD3BJ$/m);
    expect(text).not.toMatch(/GenECP|ECP|\*\*\*\*/);
    expect(text.trimEnd().endsWith('O      2.900000     0.000000     0.400000')).toBe(true);
  });

  it('writes the same bytes as before for a light-element job', () => {
    const text = buildGaussianInput({
      settings,
      molecule: { charge: 0, multiplicity: 1, coords: [{ element: 'O', x: 0, y: 0, z: 0 }] },
      inputName: 'o.gjf',
    });
    expect(text).toMatch(/^#p B3LYP\/def2SVP SP/m);
    expect(text).not.toMatch(/ECP|\*\*\*\*/);
    expect(text.endsWith('\n\n')).toBe(true);
  });

  it('writes a native SDD route for a Pd complex', () => {
    const text = buildGaussianInput({
      settings: { ...settings, basis: 'SDD' },
      molecule: pdComplex,
      inputName: 'pd-sdd.gjf',
    });
    expect(text).toMatch(/^#p B3LYP\/SDD SP/m);
    expect(text).not.toContain('PD-ECP');
  });

  it('writes tungsten with a native basis instead of demanding ECP data', () => {
    const text = buildGaussianInput({
      settings,
      molecule: { charge: 0, multiplicity: 1, coords: [{ element: 'W', x: 0, y: 0, z: 0 }] },
      inputName: 'w.gjf',
    });
    expect(text).toMatch(/^#p B3LYP\/def2SVP SP/m);
    expect(text).not.toMatch(/GenECP/);
  });

  it('lets routeFor take the emitted basis name without changing the rest', () => {
    expect(routeFor(settings)).toBe('#p B3LYP/def2SVP SP EmpiricalDispersion=GD3BJ');
    expect(routeFor(settings, { basisName: 'GenECP' })).toBe('#p B3LYP/GenECP SP EmpiricalDispersion=GD3BJ');
  });
});

describe('provenance', () => {
  it('records no ECP section for a native basis', () => {
    const text = buildGaussianInput({ settings, molecule: pdComplex, inputName: 'pd.gjf' });
    expect(ecpFromInput(text)).toBeNull();
  });

  it('records nothing for an input without an ECP section', () => {
    const text = buildGaussianInput({
      settings,
      molecule: { charge: 0, multiplicity: 1, coords: [{ element: 'C', x: 0, y: 0, z: 0 }] },
      inputName: 'c.gjf',
    });
    expect(ecpFromInput(text)).toBeNull();
  });
});

describe('validity check', () => {
  const check = (basis, element) => {
    const result = runValidityChecks(
      { settings: { method: 'B3LYP', basis }, molecule: { coords: [{ element, x: 0, y: 0, z: 0 }] } },
      { phase: 'pre', engine: 'gaussian' },
    );
    return result.findings.find((finding) => finding.id === 'method-basis-compatibility');
  };

  it('passes a Pd complex when the ECP data ships', () => {
    expect(check('def2-SVP', 'Pd').status).toBe('pass');
  });

  it('passes a heavy element on a native basis, whose ECPs ship with the program', () => {
    const finding = check('def2-SVP', 'W');
    expect(finding.status).toBe('pass');
  });

  it('still fails a light-only basis on a heavy element', () => {
    expect(check('6-31G(d)', 'Pd').status).toBe('fail');
  });
});
