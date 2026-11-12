import { describe, expect, it } from 'vitest';

import {
  DESCRIPTORS,
  DESCRIPTOR_KEYS,
  DESCRIPTOR_SET_ID,
  descriptorRequest,
  descriptorRows,
  descriptorSummary,
  normalizeDescriptorResult,
} from '../src/shared/chemDescriptors.js';
import { CHEM_PROTOCOL } from '../src/shared/chemistry.js';

const atoms = [
  { element: 'C', x: 0, y: 0, z: 0 },
  { element: 'O', x: 1.2, y: 0, z: 0 },
];

const answer = (overrides = {}) => ({
  protocol: CHEM_PROTOCOL,
  op: 'descriptors',
  ok: true,
  program: 'RDKit',
  version: '2026.9.1',
  options: { descriptorSet: 'nodechem-1' },
  result: {
    identity: {
      smiles: 'CC(=O)Oc1ccccc1C(=O)O',
      inchiKey: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
      tautomerHash: 'hash',
      formula: 'C9H8O4',
      atomCount: 21,
      heavyAtomCount: 13,
    },
    descriptors: {
      formula: 'C9H8O4',
      exactMass: 180.0423,
      molWeight: 180.16,
      logP: 1.31,
      tpsa: 63.6,
      hbd: 1,
      hba: 4,
      rotatableBonds: 3,
      ringCount: 1,
      aromaticRingCount: 1,
      fsp3: 0.111,
      qed: 0.55,
      formalCharge: 0,
      inchiKey: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N',
      murckoScaffold: 'c1ccccc1',
    },
  },
  ...overrides,
});

describe('descriptor set nodechem-1 (ADR 0003 §3.1)', () => {
  it('has one definition per key and no duplicate label', () => {
    expect(DESCRIPTOR_SET_ID).toBe('nodechem-1');
    expect(new Set(DESCRIPTOR_KEYS).size).toBe(DESCRIPTOR_KEYS.length);
    expect(new Set(DESCRIPTORS.map((entry) => entry.label)).size).toBe(DESCRIPTORS.length);
    expect(DESCRIPTOR_KEYS).toContain('tpsa');
    expect(DESCRIPTOR_KEYS).toContain('inchiKey');
    expect(DESCRIPTOR_KEYS).toContain('murckoScaffold');
  });

  it('builds the descriptors request with the versioned set echoed', () => {
    const request = descriptorRequest({ molecule: { atoms } });
    expect(request.protocol).toBe(CHEM_PROTOCOL);
    expect(request.op).toBe('descriptors');
    expect(request.molecule.atoms).toHaveLength(2);
    expect(request.options).toEqual({});
  });

  it('normalises a recorded answer and keeps a missing descriptor null, never zero', () => {
    const recorded = answer();
    delete recorded.result.descriptors.qed;
    recorded.result.descriptors.tpsa = null;
    const result = normalizeDescriptorResult(recorded);
    expect(result.descriptors.formula).toBe('C9H8O4');
    expect(result.descriptors.qed).toBeNull();
    expect(result.descriptors.tpsa).toBeNull();
    expect(result.identity.formula).toBe('C9H8O4');
    expect(result.origin).toMatchObject({ program: 'RDKit', version: '2026.9.1', op: 'descriptors' });
  });

  it('refuses an answer without an identity instead of inventing one', () => {
    const recorded = answer();
    delete recorded.result.identity;
    expect(() => normalizeDescriptorResult(recorded)).toThrow(/no molecule identity/);
  });

  it('carries a sidecar refusal through with its code', () => {
    expect(() => normalizeDescriptorResult({
      protocol: CHEM_PROTOCOL,
      op: 'descriptors',
      ok: false,
      error: { code: 'coverage-refused', message: 'open shell' },
    })).toThrow(/open shell/);
  });

  it('renders ordered rows and a summary that names the set', () => {
    const result = normalizeDescriptorResult(answer());
    const rows = descriptorRows(result.descriptors);
    expect(rows.map((row) => row.key)).toEqual([...DESCRIPTOR_KEYS]);
    expect(rows.find((row) => row.key === 'tpsa').unit).toBe('Å²');
    expect(descriptorSummary(result)).toContain('nodechem-1');
    expect(descriptorSummary(result)).toContain('C9H8O4');
  });
});
