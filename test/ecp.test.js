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

  it('requires an ECP for palladium with def2-SVP', () => {
    const requirement = ecpRequirement({ basis: 'def2-SVP', elements: ['Pd', 'C', 'O'] });
    expect(requirement.needed).toBe(true);
    expect(requirement.symbols).toEqual(['Pd']);
    expect(requirement.missing).toEqual([]);
    expect(requirement.blocks).toContain('Pd     0');
    expect(requirement.blocks).toContain('PD-ECP');
    expect(requirement.blocks).toContain('****');
    expect(requirement.library).toMatchObject({ name: 'Basis Set Exchange', basis: 'def2-SVP' });
    expect(requirement.library.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves a light-element job alone', () => {
    const requirement = ecpRequirement({ basis: 'def2-SVP', elements: ['C', 'H', 'O'] });
    expect(requirement.needed).toBe(false);
    expect(requirement.blocks).toBe('');
    expect(basisNameFor('def2-SVP', requirement)).toBe('def2-SVP');
  });

  it('reports an element whose ECP this build does not ship', () => {
    const requirement = ecpRequirement({ basis: 'def2-SVP', elements: ['W'] });
    expect(requirement.needed).toBe(true);
    expect(requirement.missing).toEqual(['W']);
    expect(requirement.blocks).toBe('');
    expect(ecpMissingMessage(requirement)).toMatch(/needs effective-core-potential data for W/);
    expect(ecpMissingMessage(requirement)).toMatch(/Basis Set Exchange/);
  });

  it('supports SDD for the same heavy elements, with its own library record', () => {
    const requirement = ecpRequirement({ basis: 'SDD', elements: ['Pd'] });
    expect(requirement.needed).toBe(true);
    expect(requirement.blocks).toContain('PD-ECP     4     28');
    expect(requirement.library).toMatchObject({ basis: 'SDD' });
    expect(ecpRequirement({ basis: 'SDD', elements: ['Pt'] }).blocks).toContain('PT-ECP     5     60');
    expect(ecpRequirement({ basis: 'SDD', elements: ['W'] }).missing).toEqual(['W']);
  });

  it('does not claim ECP support for a basis it has no table for', () => {
    expect(ecpRequirement({ basis: '6-31G(d)', elements: ['Pd'] }).needed).toBe(false);
    expect(ecpRequirement({ basis: 'lanl2dz', elements: ['Pd'] }).needed).toBe(false);
  });
});

describe('input file', () => {
  it('emits a GenECP route and the basis/ECP blocks for a Pd complex', () => {
    const text = buildGaussianInput({ settings, molecule: pdComplex, inputName: 'pd.gjf' });
    expect(text).toMatch(/^#p B3LYP\/GenECP SP EmpiricalDispersion=GD3BJ$/m);
    const [before, after] = text.split(/^Pd +0$/m);
    expect(after, 'the basis block must follow the molecule').toBeTruthy();
    expect(before.trimEnd().endsWith('O      2.900000     0.000000     0.400000')).toBe(true);
    expect(text).toContain('PD-ECP     3     28');
    expect(text).toContain('****');
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

  it('writes an SDD GenECP job for a Pd complex', () => {
    const text = buildGaussianInput({
      settings: { ...settings, basis: 'SDD' },
      molecule: pdComplex,
      inputName: 'pd-sdd.gjf',
    });
    expect(text).toMatch(/^#p B3LYP\/GenECP SP/m);
    expect(text).toContain('PD-ECP     4     28');
  });

  it('refuses an ECP basis with no data instead of writing a broken route', () => {
    expect(() => buildGaussianInput({
      settings,
      molecule: { charge: 0, multiplicity: 1, coords: [{ element: 'W', x: 0, y: 0, z: 0 }] },
      inputName: 'w.gjf',
    })).toThrow(/effective-core-potential data for W/);
  });

  it('lets routeFor take the emitted basis name without changing the rest', () => {
    expect(routeFor(settings)).toBe('#p B3LYP/def2SVP SP EmpiricalDispersion=GD3BJ');
    expect(routeFor(settings, { basisName: 'GenECP' })).toBe('#p B3LYP/GenECP SP EmpiricalDispersion=GD3BJ');
  });
});

describe('provenance', () => {
  it('reads the ECP library back from the written input', () => {
    const text = buildGaussianInput({ settings, molecule: pdComplex, inputName: 'pd.gjf' });
    const ecp = ecpFromInput(text);
    expect(ecp).toMatchObject({
      library: 'Basis Set Exchange',
      basis: 'def2-SVP',
      symbols: ['Pd'],
      elements: [46],
    });
    expect(ecp.sha256).toMatch(/^[0-9a-f]{64}$/);
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

  it('fails an element whose ECP data is not in the build', () => {
    const finding = check('def2-SVP', 'W');
    expect(finding.status).toBe('fail');
    expect(finding.message).toMatch(/ECP|effective-core-potential/i);
  });

  it('still fails a light-only basis on a heavy element', () => {
    expect(check('6-31G(d)', 'Pd').status).toBe('fail');
  });
});
