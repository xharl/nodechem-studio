import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  CHEM_IMPLEMENTED_OPS,
  CHEM_OPS,
  CHEM_PROTOCOL,
  ChemError,
  MAX_CHEM_ATOMS,
  chemOrigin,
  chemRequest,
  normalizeChemMolecule,
  normalizeChemResponse,
  probeRequest,
} from '../src/shared/chemistry.js';

const molecule = {
  title: 'water',
  charge: 0,
  multiplicity: 1,
  atoms: [
    { element: 'O', x: 0, y: 0, z: 0 },
    { element: 'H', x: 0.96, y: 0, z: 0 },
    { element: 'H', x: -0.24, y: 0.93, z: 0 },
  ],
};

describe('chemistry protocol (ADR 0003 §2.1)', () => {
  it('speaks one protocol and admits the nine ops', () => {
    expect(CHEM_PROTOCOL).toBe('nodechem-chem/1');
    expect([...CHEM_OPS].sort()).toEqual([
      'conformers', 'depict', 'descriptors', 'embed3d', 'integrity',
      'probe', 'similarity', 'standardize', 'stereoisomers',
    ]);
    expect(CHEM_IMPLEMENTED_OPS).toContain('probe');
  });

  it('builds a probe request with no molecule', () => {
    expect(probeRequest()).toEqual({ protocol: CHEM_PROTOCOL, op: 'probe', options: {} });
  });

  it('refuses an unknown op before a process is spawned', () => {
    expect(() => chemRequest({ op: 'vibrate' })).toThrow(ChemError);
    try {
      chemRequest({ op: 'vibrate' });
    } catch (error) {
      expect(error.code).toBe('bad-op');
    }
  });

  it('refuses an admitted op this build does not implement', () => {
    const pending = CHEM_OPS.find((op) => !CHEM_IMPLEMENTED_OPS.includes(op));
    if (!pending) {
      expect([...CHEM_IMPLEMENTED_OPS].sort()).toEqual([...CHEM_OPS].sort());
      return;
    }
    try {
      chemRequest({ op: pending, molecule });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error.code).toBe('op-not-implemented');
    }
  });

  it('normalises a molecule and refuses a bad one', () => {
    const normalized = normalizeChemMolecule(molecule);
    expect(normalized.atoms).toHaveLength(3);
    expect(normalized.charge).toBe(0);
    expect(normalized.smiles).toBe('');
    expect(() => normalizeChemMolecule({ atoms: [] })).toThrow(/carries no atoms/);
    expect(() => normalizeChemMolecule({ atoms: [{ element: 'C', x: 0, y: 0, z: 'nope' }] }))
      .toThrow(/non-finite coordinate/);
    expect(() => normalizeChemMolecule({ atoms: molecule.atoms, charge: 99 })).toThrow(/charge/);
    const tooMany = { atoms: Array.from({ length: MAX_CHEM_ATOMS + 1 }, () => ({ element: 'C', x: 0, y: 0, z: 0 })) };
    expect(() => normalizeChemMolecule(tooMany)).toThrow(/limit is 1000/);
  });
});

describe('chemistry response envelope (ADR 0003 §2.3–§2.4)', () => {
  const success = {
    protocol: CHEM_PROTOCOL,
    op: 'probe',
    ok: true,
    program: 'RDKit',
    version: '2026.09.1',
    capabilities: { etkdgv4: true },
  };

  it('accepts a success and keeps the provenance fields', () => {
    const answer = normalizeChemResponse(success, { op: 'probe' });
    expect(answer.program).toBe('RDKit');
    expect(answer.version).toBe('2026.09.1');
    expect(answer.capabilities).toEqual({ etkdgv4: true });
    expect(answer.op).toBe('probe');
  });

  it('turns a refusal into a typed error carrying the code and the sentence', () => {
    try {
      normalizeChemResponse({
        protocol: CHEM_PROTOCOL,
        op: 'probe',
        ok: false,
        error: { code: 'capability-missing', message: 'ETKDGv4 is not exposed', detail: 'AllChem' },
      }, { op: 'probe' });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ChemError);
      expect(error.code).toBe('capability-missing');
      expect(error.message).toBe('ETKDGv4 is not exposed');
      expect(error.detail).toBe('AllChem');
    }
  });

  it('refuses a protocol mismatch, another op and an empty program', () => {
    expect(() => normalizeChemResponse({ ...success, protocol: 'nodechem-chem/9' }, { op: 'probe' }))
      .toThrow(/answered protocol/);
    expect(() => normalizeChemResponse(success, { op: 'descriptors' })).toThrow(/answered op/);
    expect(() => normalizeChemResponse({ ...success, program: '' }, { op: 'probe' }))
      .toThrow(/did not name the program/);
    expect(() => normalizeChemResponse({ ...success, version: '' }, { op: 'probe' }))
      .not.toThrow();
    expect(normalizeChemResponse({ ...success, version: '' }, { op: 'probe' }).version).toBe('unreported');
  });

  it('records an origin with program, version, op and protocol', () => {
    const origin = chemOrigin(
      { program: 'RDKit', version: '2026.9.1', op: 'descriptors' },
      { method: 'Crippen logP', sourceSha256: 'a'.repeat(64) },
    );
    expect(origin).toMatchObject({
      program: 'RDKit',
      version: '2026.9.1',
      method: 'Crippen logP',
      op: 'descriptors',
      protocol: CHEM_PROTOCOL,
      sourceSha256: 'a'.repeat(64),
    });
  });
});

describe('chemistry packaging (ADR 0003 §2.5)', () => {
  it('ships scripts/ as extraResources outside the asar', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.build.asar).toBe(true);
    expect(pkg.build.files).not.toContain('scripts/**/*');
    expect(pkg.build.extraResources).toEqual([
      { from: 'scripts', to: 'scripts', filter: ['**/*.py'] },
    ]);
  });
});
