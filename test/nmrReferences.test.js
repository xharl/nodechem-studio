import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REFERENCE_MODES,
  SHIPPED_REFERENCES,
  levelLabel,
  loadNmrReferences,
  lookupReference,
  shiftFor,
  validateReference,
} from '../src/shared/nmrReferences.js';

/**
 * These entries exist only inside this test: the shipped dataset is empty and
 * must stay that way until a reference shielding has been computed for a level
 * and cited. Nothing here is presented as a real reference.
 */
const entry = (overrides = {}) => ({
  level: { method: 'B3LYP', basis: 'sto-3g' },
  nucleus: '13C',
  mode: 'single',
  sigmaRef: 190.5,
  citation: 'Hypothetical entry used by test/nmrReferences.test.js, 2026.',
  retrievedAt: '2026-11-08',
  ...overrides,
});

const dataFile = JSON.parse(readFileSync(
  fileURLToPath(new URL('../src/data/nmrReferences.json', import.meta.url)),
  'utf8',
));

describe('shipped reference dataset', () => {
  it('is empty on purpose and says that adding an entry needs a citation', () => {
    expect(SHIPPED_REFERENCES.entries).toEqual([]);
    expect(dataFile.entries).toEqual([]);
    expect(dataFile.$comment).toMatch(/requires a citation/i);
    expect(dataFile.note).toMatch(/Empty on purpose/i);
  });

  it('gives no shift at all without a reference for the level', () => {
    const result = shiftFor({
      level: { method: 'B3LYP', basis: 'STO-3G' },
      nucleus: '13C',
      sigma: 114.088,
    });
    expect(result).toEqual({
      delta: null,
      mode: null,
      citation: null,
      reason: 'no reference for B3LYP/STO-3G',
      source: null,
    });
  });

  it('lists the two supported modes', () => {
    expect(REFERENCE_MODES).toEqual(['single', 'linear']);
  });
});

describe('single-reference mode', () => {
  const references = loadNmrReferences({ entries: [entry()] });

  it('subtracts the reference shielding and returns its citation', () => {
    const result = shiftFor({
      level: { method: 'B3LYP', basis: 'sto-3g' },
      nucleus: '13C',
      sigma: 114.088,
      references,
    });
    expect(result.delta).toBeCloseTo(76.412, 6);
    expect(result.mode).toBe('single');
    expect(result.citation).toBe(entry().citation);
    expect(result.reason).toBeNull();
    expect(result.level).toBe('B3LYP/sto-3g');
    expect(result.source).toContain('reference: σ_ref = 190.5 ppm at B3LYP/sto-3g');
    expect(result.source).toContain(entry().citation);
  });

  it('accepts a bare array and a level label split into method and basis', () => {
    expect(loadNmrReferences([entry()]).entries).toHaveLength(1);
    expect(levelLabel({ method: 'B3LYP', basis: 'sto-3g' })).toBe('B3LYP/sto-3g');
    expect(levelLabel({ method: 'B3LYP' })).toBeNull();
  });
});

describe('linear mode', () => {
  const references = loadNmrReferences([
    entry({ nucleus: '1H', mode: 'linear', a: -1.05, b: 31.9, sigmaRef: undefined }),
  ]);

  it('applies δ = a·σ + b and keeps the citation', () => {
    const result = shiftFor({
      level: { method: 'B3LYP', basis: 'sto-3g' },
      nucleus: '1H',
      sigma: 25.5,
      references,
    });
    expect(result.delta).toBeCloseTo(-1.05 * 25.5 + 31.9, 9);
    expect(result.mode).toBe('linear');
    expect(result.citation).toMatch(/Hypothetical entry/);
  });

  it('refuses a linear entry without both coefficients', () => {
    expect(validateReference(entry({ mode: 'linear', a: '1' })).errors).toEqual([
      'linear mode needs a finite a',
      'linear mode needs a finite b',
    ]);
    expect(() => loadNmrReferences([entry({ mode: 'linear', a: '1' })])).toThrow(/linear mode needs a finite b/);
  });
});

describe('an absent level or nucleus', () => {
  const references = loadNmrReferences([entry()]);

  it('returns null for a different level, never another level’s numbers', () => {
    expect(lookupReference({
      level: { method: 'B3LYP', basis: 'def2-TZVP' },
      nucleus: '13C',
      references,
    })).toBeNull();
    const result = shiftFor({
      level: { method: 'B3LYP', basis: 'def2-TZVP' },
      nucleus: '13C',
      sigma: 114.088,
      references,
    });
    expect(result.delta).toBeNull();
    expect(result.reason).toBe('no reference for B3LYP/def2-TZVP');
  });

  it('returns null for a nucleus the entry does not cover', () => {
    expect(lookupReference({
      level: { method: 'B3LYP', basis: 'sto-3g' },
      nucleus: '1H',
      references,
    })).toBeNull();
  });

  it('matches case and surrounding whitespace in the level, and isotopologues by element', () => {
    expect(lookupReference({
      level: { method: ' b3lyp ', basis: 'STO-3G' },
      nucleus: 'C',
      references,
    })).not.toBeNull();
  });
});

describe('refusals', () => {
  it('refuses an entry without a citation, naming it', () => {
    const withoutCitation = { ...entry(), id: 'carbon-b3lyp-sto3g' };
    delete withoutCitation.citation;
    expect(validateReference(withoutCitation).errors).toContain('missing citation');
    expect(() => loadNmrReferences([withoutCitation])).toThrow(/carbon-b3lyp-sto3g/);
    expect(() => loadNmrReferences([withoutCitation])).toThrow(/missing citation/);
  });

  it('names an uncited entry by nucleus and level when it has no id', () => {
    expect(() => loadNmrReferences([entry({ citation: '   ' })])).toThrow(/"13C at B3LYP\/sto-3g"/);
  });

  it('refuses a missing retrievedAt, a bad mode and an unsupported nucleus', () => {
    const noDate = { ...entry(), id: 'no-date' };
    delete noDate.retrievedAt;
    expect(() => loadNmrReferences([noDate])).toThrow(/no-date.*retrievedAt/);
    expect(validateReference(entry({ mode: 'quadratic' })).errors[0])
      .toBe('mode "quadratic" is not one of single, linear');
    expect(() => loadNmrReferences([entry({ nucleus: '7Li' })])).toThrow(/7Li.*not one this app reads/);
  });

  it('refuses a numeric string where the dataset needs a number', () => {
    expect(validateReference(entry({ sigmaRef: '190.5' })).errors).toContain('single mode needs a finite sigmaRef');
  });

  it('refuses two entries for the same nucleus at the same level', () => {
    expect(() => loadNmrReferences([entry({ nucleus: '13C' }), entry({ nucleus: 'C' })]))
      .toThrow(/duplicate reference for C at B3LYP\/sto-3g/);
  });

  it('refuses a dataset with no entries[] array', () => {
    expect(() => loadNmrReferences({})).toThrow(/no entries\[\] array/);
  });
});

describe('no path subtracts a default reference', () => {
  const references = loadNmrReferences([entry()]);

  it('treats null and an empty string as absent, never as σ = 0', () => {
    for (const sigma of [null, undefined, '', '   ']) {
      const result = shiftFor({
        level: { method: 'B3LYP', basis: 'sto-3g' },
        nucleus: '13C',
        sigma,
        references,
      });
      expect(result.delta).toBeNull();
      expect(result.reason).toBe('no shielding for 13C at B3LYP/sto-3g');
    }
  });

  it('reports a missing level before anything else', () => {
    expect(shiftFor({ nucleus: '13C', sigma: 114.088 }).reason).toBe('no level of theory given');
  });
});

describe('an explicit reference the caller states', () => {
  const level = { method: 'B3LYP', basis: 'sto-3g' };
  const stated = {
    ppm: 31.9,
    provenance: 'TMS, B3LYP/sto-3g, gas phase — run in this project, 2026-11-08',
  };

  it('subtracts a stated σ_ref and prints it with its provenance', () => {
    const result = shiftFor({ level, nucleus: '1H', sigma: 25.5, reference: stated });
    // 31.9 − 25.5 = 6.4 ppm; the reference ships with no dataset entry.
    expect(result.delta).toBeCloseTo(6.4, 12);
    expect(result.mode).toBe('single');
    expect(result.reason).toBeNull();
    expect(result.source).toBe(`reference: σ_ref = 31.9 ppm — ${stated.provenance}`);
  });

  it('refuses a stated σ_ref that states no provenance, naming what is missing', () => {
    for (const provenance of ['', '   ', undefined, null]) {
      const result = shiftFor({
        level, nucleus: '1H', sigma: 25.5, reference: { ppm: 31.9, provenance },
      });
      expect(result.delta).toBeNull();
      expect(result.reason).toMatch(/no stated provenance/);
      expect(result.source).toBeNull();
    }
  });

  it('refuses a reference at another level rather than borrowing the number', () => {
    const result = shiftFor({
      level,
      nucleus: '13C',
      sigma: 114.088,
      reference: { ...stated, level: { method: 'B3LYP', basis: 'def2-TZVP' } },
    });
    expect(result.delta).toBeNull();
    expect(result.reason).toBe('the reference is at B3LYP/def2-TZVP, the run is at B3LYP/sto-3g');
  });

  it('accepts a matching stated level and keeps it in the source line', () => {
    const result = shiftFor({
      level,
      nucleus: '13C',
      sigma: 114.088,
      reference: { ...stated, ppm: 190.5, level },
    });
    expect(result.delta).toBeCloseTo(76.412, 6);
    expect(result.source).toContain('σ_ref = 190.5 ppm at B3LYP/sto-3g');
  });

  it('refuses a non-finite σ_ref and still reports a missing shielding first', () => {
    expect(shiftFor({ level, sigma: 25.5, reference: { ppm: '', provenance: 'x' } }).reason)
      .toBe('the reference has no finite σ_ref');
    const noShielding = shiftFor({ level, sigma: null, reference: stated });
    expect(noShielding.delta).toBeNull();
    expect(noShielding.reason).toBe('no shielding for the nucleus at B3LYP/sto-3g');
  });
});

