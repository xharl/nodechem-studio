import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import {
  DEFAULT_TAUTOMER_OPTIONS,
  TAUTOMER_PROTOCOL,
  TautomerEnumerationError,
  normalizeTautomerOptions,
  normalizeTautomerResponse,
  tautomerOrigin,
  tautomerRequest,
  tautomerSpread,
  tautomerSummary,
} from '../src/shared/tautomers.js';
import { parseMultiXyz } from '../src/shared/conformers.js';

/**
 * Issue #226: the fixture is real RDKit output, committed with its provenance
 * (see `provenance` inside the JSON). These tests pin the enumeration itself —
 * the tautomer set of acetylacetone — and the protocol checks that stop a
 * broken enumerator from becoming an "empty" ensemble.
 */

const fixtureUrl = new URL('./fixtures/tautomers/acetylacetone.json', import.meta.url);
const xyzUrl = new URL('./fixtures/tautomers/acetylacetone.xyz', import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
const xyz = readFileSync(xyzUrl, 'utf8');

/** The five acetylacetone tautomers RDKit 2026.09.1 enumerates, in its order. */
const EXPECTED_SMILES = [
  'C=C(O)C=C(C)O',
  'C=C(O)CC(=C)O',
  'C=C(O)CC(C)=O',
  'CC(=O)C=C(C)O',
  'CC(=O)CC(C)=O',
];

const atomsOf = () => parseMultiXyz(xyz).frames[0].atoms;

describe('the committed RDKit fixture (#226)', () => {
  it('records what produced it, not just the answer', () => {
    expect(fixture.provenance.generatedBy).toBe('scripts/tautomer-enumerator.py');
    expect(fixture.provenance.program).toBe('RDKit');
    expect(fixture.provenance.version).toBe(fixture.version);
    expect(fixture.provenance.ruleset).toBe('rdkit-default');
    expect(fixture.provenance.inputFile).toBe('acetylacetone.xyz');
    const digest = createHash('sha256').update(readFileSync(xyzUrl)).digest('hex');
    expect(fixture.provenance.inputSha256).toBe(digest);
    expect(fixture.provenance.options).toEqual(fixture.options);
  });

  it('is the input geometry the request would send', () => {
    const atoms = atomsOf();
    expect(atoms).toHaveLength(15);
    expect(fixture.input.atomCount).toBe(15);
    expect(fixture.input.formula).toBe('C5H8O2');
    expect(fixture.input.smiles).toBe('CC(=O)CC(C)=O');
    expect(atoms.map((atom) => atom.element)).toEqual(
      fixture.candidates[0].atoms.map((atom) => atom.element),
    );
  });

  it('enumerates the known acetylacetone tautomer set', () => {
    const result = normalizeTautomerResponse(fixture, { maxCandidates: 16 });
    expect(result.candidates).toHaveLength(5);
    expect(result.candidates.map((candidate) => candidate.smiles)).toEqual(EXPECTED_SMILES);
    expect(result.candidates.map((candidate) => candidate.label)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    for (const candidate of result.candidates) {
      expect(candidate.formula).toBe('C5H8O2');
      expect(candidate.atoms).toHaveLength(15);
      expect(candidate.geometry.source).toBe('input');
      expect(candidate.geometry.relaxation).toBe('UFF');
      expect(candidate.atoms.every((atom) => Number.isFinite(atom.x) && Number.isFinite(atom.z))).toBe(true);
    }
    // The keto form is one candidate, not the only one, and the enols are
    // different molecules — the whole point of the mode.
    expect(new Set(result.candidates.map((candidate) => candidate.smiles)).size).toBe(5);
    expect(result.version).toBe(fixture.version);
    expect(result.ruleset).toBe('rdkit-default');
    expect(result.truncated).toBe(false);
  });

  it('keeps the geometry distinguishable per candidate', () => {
    const result = normalizeTautomerResponse(fixture, { maxCandidates: 16 });
    const first = result.candidates[0].atoms.map((atom) => `${atom.element}:${atom.x},${atom.y},${atom.z}`).join('|');
    const last = result.candidates[4].atoms.map((atom) => `${atom.element}:${atom.x},${atom.y},${atom.z}`).join('|');
    expect(first).not.toBe(last);
  });
});

describe('the request the runner sends', () => {
  it('carries XYZ, charge, multiplicity, title and the option set', () => {
    const request = tautomerRequest({
      title: 'acetylacetone',
      charge: 0,
      multiplicity: 1,
      atoms: atomsOf(),
      options: { maxCandidates: 8 },
    });
    expect(request.protocol).toBe(TAUTOMER_PROTOCOL);
    expect(request.atoms).toHaveLength(15);
    expect(request.options).toEqual({ ...DEFAULT_TAUTOMER_OPTIONS, maxCandidates: 8 });
    // pH is deliberately absent: protonation-state enumeration is out of scope.
    expect('pH' in request.options).toBe(false);
  });

  it('refuses an empty structure and an unknown ruleset', () => {
    expect(() => tautomerRequest({ atoms: [] })).toThrow(TautomerEnumerationError);
    expect(() => normalizeTautomerOptions({ ruleset: 'chembl' })).toThrow(/not implemented/);
  });
});

describe('the summary a tautomer block stores', () => {
  const result = normalizeTautomerResponse(fixture, { maxCandidates: 16 });
  const summary = tautomerSummary({
    result,
    charge: 0,
    multiplicity: 1,
    group: '',
    sourceSha256: fixture.provenance.inputSha256,
  });

  it('is an ensemble of distinct molecules, not conformers', () => {
    expect(summary.produces).toBe('tautomers');
    expect(summary.generator).toBe('rdkit');
    expect(summary.count).toBe(5);
    expect(summary.total).toBe(5);
    expect(summary.tautomers).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(summary.protomers).toEqual([]);
    expect(summary.members.every((member) => member.kept)).toBe(true);
    expect(summary.pruned).toEqual({ energy: 0, rmsd: 0, count: 0 });
  });

  it('assigns no energy and no population, and says why', () => {
    for (const member of summary.members) {
      expect(member.energyEh).toBeNull();
      expect(member.relativeKcal).toBeNull();
      expect(member.population).toBeNull();
      expect(member.rmsdToLowest).toBeNull();
      expect(member.smiles).toMatch(/C5H8O2|O/);
    }
    expect(summary.spreadKcal).toBeNull();
    expect(summary.mixedEnergies).toBe(false);
    expect(summary.warnings.map((warning) => warning.id)).toContain('tautomer-distinct-molecules');
    expect(summary.warnings[0].message).toMatch(/no Boltzmann population/i);
  });

  it('records the enumerator, its version, the ruleset and every option', () => {
    expect(summary.origin.program).toBe('RDKit');
    expect(summary.origin.version).toBe(fixture.version);
    expect(summary.origin.ruleset).toBe('rdkit-default');
    expect(summary.origin.protocol).toBe(TAUTOMER_PROTOCOL);
    expect(summary.origin.options.maxCandidates).toBe(16);
    expect(summary.origin.options.maxTransforms).toBe(1000);
    expect(summary.origin.sourceSha256).toBe(fixture.provenance.inputSha256);
    expect(summary.origin.method).toBe('TautomerEnumerator · rdkit-default');
  });

  it('needs an explicit choice for a single run, but fans out as a set', () => {
    // Five candidates and no chosen member: a lone downstream run would be an
    // arbitrary pick, so the summary says so. Fan-out ignores this on purpose.
    expect(summary.selectedId).toBe('');
    expect(summary.selected).toBeNull();
    expect(summary.requiresSelection).toBe(true);
    const chosen = tautomerSummary({ result, selectedId: 'c3' });
    expect(chosen.selectedId).toBe('c3');
    expect(chosen.selected.tautomer).toBe('t3');
    expect(chosen.requiresSelection).toBe(false);
  });

  it('flags a truncated enumeration', () => {
    const capped = normalizeTautomerResponse(fixture, { maxCandidates: 16 });
    const truncated = tautomerSummary({ result: { ...capped, truncated: true } });
    expect(truncated.truncated).toBe(true);
    expect(truncated.warnings.map((warning) => warning.id)).toContain('tautomer-truncated');
  });

  it('origin carries no ruleset for a non-tautomer origin', () => {
    const origin = tautomerOrigin(result, { sourceSha256: '' });
    expect(origin.ruleset).toBe('rdkit-default');
    // A conformer origin built elsewhere has none of these keys; this one does,
    // and the schema only requires them for a tautomer summary.
    expect(Object.keys(origin).sort()).toEqual(
      ['method', 'options', 'program', 'protocol', 'ruleset', 'sourceSha256', 'version'],
    );
  });
});

describe('refusals — never an empty set', () => {
  const base = { ...fixture };

  it('refuses zero candidates with a code the queue records', () => {
    let error = null;
    try {
      normalizeTautomerResponse({ ...base, candidates: [] }, { maxCandidates: 16 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TautomerEnumerationError);
    expect(error.code).toBe('no-candidates');
    expect(error.message).toMatch(/refused rather than replaced by the input geometry/);
  });

  it('refuses another protocol', () => {
    expect(() => normalizeTautomerResponse({ ...base, protocol: 'nodechem-tautomers/2' }))
      .toThrow(/protocol/);
  });

  it('passes a sidecar refusal through with its own code', () => {
    let error = null;
    try {
      normalizeTautomerResponse({
        protocol: TAUTOMER_PROTOCOL,
        ok: false,
        error: { code: 'rdkit-missing', message: 'RDKit is not installed in this interpreter.' },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe('rdkit-missing');
    expect(error.message).toMatch(/not installed/);
  });

  it('refuses candidates that are the same molecule twice', () => {
    const candidates = [base.candidates[0], { ...base.candidates[1], smiles: base.candidates[0].smiles }];
    expect(() => normalizeTautomerResponse({ ...base, candidates }, { maxCandidates: 16 }))
      .toThrow(/same molecule/);
  });

  it('refuses candidates whose atom counts disagree', () => {
    const candidates = [base.candidates[0], { ...base.candidates[1], atoms: base.candidates[1].atoms.slice(0, 14) }];
    expect(() => normalizeTautomerResponse({ ...base, candidates }, { maxCandidates: 16 }))
      .toThrow(/atom count/);
  });

  it('refuses more candidates than the cap it was given', () => {
    expect(() => normalizeTautomerResponse(base, { maxCandidates: 3 })).toThrow(/cap of 3/);
  });

  it('refuses a ruleset this build cannot reproduce', () => {
    expect(() => normalizeTautomerResponse({ ...base, ruleset: 'openbabel' })).toThrow(/cannot reproduce/);
  });
});

describe('the spread across the candidate set', () => {
  it('is computed from the target-level energies', () => {
    const spread = tautomerSpread([
      { memberId: 'c1', energyHartree: -100.0 },
      { memberId: 'c2', energyHartree: -99.99 },
      { memberId: 'c3', energyHartree: -99.98 },
    ]);
    expect(spread.available).toBe(true);
    expect(spread.count).toBe(3);
    expect(spread.lowestMemberId).toBe('c1');
    expect(spread.highestMemberId).toBe('c3');
    // 0.02 Eh × 627.509474 kcal/mol
    expect(spread.kcal).toBeCloseTo(12.5502, 3);
  });

  it('is not reported when a candidate has no energy', () => {
    const spread = tautomerSpread([
      { memberId: 'c1', energyHartree: -100.0 },
      { memberId: 'c2', energyHartree: null },
    ]);
    expect(spread.available).toBe(false);
    expect(spread.reason).toMatch(/c2 has no final energy/);
  });

  it('is not reported for a single candidate', () => {
    expect(tautomerSpread([{ memberId: 'c1', energyHartree: -100 }]).available).toBe(false);
  });
});
