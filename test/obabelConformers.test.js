import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OBABEL_MMFF_ELEMENTS,
  obabelCoverageRefusal,
  obabelEnsembleText,
  obabelForceFieldKeyword,
  obabelScoreArgv,
  obabelSearchArgv,
  parseObabelScoredEnsemble,
  parseObabelSearchLog,
  untypableElements,
} from '../src/shared/obabelConformers.js';
import { conformerTableCaption, parseMultiXyz, rankEnsemble } from '../src/shared/conformers.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/obabel/${name}`, import.meta.url), 'utf8');

describe('Open Babel invariants', () => {
  it('asks for an energy-scored genetic-algorithm search, not an RMSD-diverse one', () => {
    const argv = obabelSearchArgv({ inputName: 'input.xyz', nconf: 25, ff: 'mmff94' });
    expect(argv).toEqual([
      'input.xyz',
      '-O', 'obabel_conformers.xyz',
      '--conformer',
      '--nconf', '25',
      '--ff', 'MMFF94',
      '--score', 'energy',
      '--writeconformers',
    ]);
    // RMSD diversity would return shapes chosen for being different, which is
    // not what a conformer distribution is.
    expect(argv).not.toContain('rmsd');
  });

  it('keeps the static variant a separate spelling', () => {
    expect(obabelForceFieldKeyword('mmff94s')).toBe('MMFF94s');
    expect(obabelSearchArgv({ ff: 'mmff94s' })).toContain('MMFF94s');
  });

  it('refuses a force field it does not run', () => {
    expect(() => obabelSearchArgv({ ff: 'gaff' })).toThrow(/not one this app runs/);
    expect(() => obabelScoreArgv({ ff: 'gaff' })).toThrow(/not one this app runs/);
  });

  it('bounds --nconf to a real integer range', () => {
    expect(() => obabelSearchArgv({ nconf: 0 })).toThrow(/between 1 and 1000/);
    expect(() => obabelSearchArgv({ nconf: 1001 })).toThrow(/between 1 and 1000/);
    expect(() => obabelSearchArgv({ nconf: 2.5 })).toThrow(/between 1 and 1000/);
  });

  it('evaluates the energies in a second pass', () => {
    expect(obabelScoreArgv({ ff: 'mmff94' })).toEqual([
      'obabel_conformers.xyz', '-O', 'obabel_scored.xyz',
      '--energy', '--ff', 'MMFF94', '--append', 'Energy',
    ]);
  });
});

describe('MMFF94 coverage', () => {
  it('covers the elements the docs list', () => {
    expect(OBABEL_MMFF_ELEMENTS).toEqual(['H', 'C', 'N', 'O', 'F', 'Si', 'P', 'S', 'Cl', 'Br', 'I']);
  });

  it('names the atoms it cannot describe instead of silently leaving them untyped', () => {
    const atoms = [{ element: 'C' }, { element: 'Se' }, { element: 'se' }, { element: 'H' }];
    expect(untypableElements(atoms)).toEqual(['Se']);
    expect(obabelCoverageRefusal(atoms)).toMatch(/no parameters for Se/);
    expect(obabelCoverageRefusal([{ element: 'C' }, { element: 'O' }])).toBe('');
  });
});

describe('the real 3.1.0 search log', () => {
  it('reads what the search actually printed', () => {
    const log = parseObabelSearchLog(fixture('hexane-search.log'));
    expect(log.initialCount).toBe(6);
    expect(log.attempts).toBe(31);
    expect(log.duplicates).toBe(22);
    expect(log.failedFilter).toBe(4);
    expect(log.stated).toBe(true);
    // The GA prints the best energy per generation, never one per conformer.
    expect(log.generations.length).toBeGreaterThan(0);
    expect(log.generations[0]).toEqual({ generation: 1, energyKcal: -5.44312 });
  });

  it('returns nulls rather than guessing when a log says nothing', () => {
    const log = parseObabelSearchLog('1 molecule converted\n');
    expect(log.initialCount).toBeNull();
    expect(log.attempts).toBeNull();
    expect(log.generations).toEqual([]);
    expect(log.stated).toBe(false);
  });
});

describe('the scored ensemble', () => {
  it('reads one MMFF94 energy per conformer, including positive values', () => {
    const parsed = parseObabelScoredEnsemble(fixture('hexane-scored.xyz'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.frames).toHaveLength(6);
    for (const frame of parsed.frames) expect(frame.atoms).toHaveLength(20);
    expect(parsed.frames.map((frame) => frame.energyKcal)).toEqual([
      -5.44311, -2.91903, -2.91877, -2.90244, -2.88537, -2.88136,
    ]);
    // The lowest conformer is the first one here, which is what an energy
    // search is for — the GA returns the final generation ranked by energy.
    expect(Math.min(...parsed.frames.map((frame) => frame.energyKcal))).toBe(-5.44311);
  });

  it('refuses a frame whose force field could not type it', () => {
    const broken = fixture('hexane-scored.xyz').replace('hex.xyz -2.91903', 'hex.xyz');
    const parsed = parseObabelScoredEnsemble(broken);
    expect(parsed.errors[0].message).toMatch(/without an MMFF94 energy/);
  });

  it('writes an ensemble whose comments carry provenance and no energy token', () => {
    const parsed = parseObabelScoredEnsemble(fixture('hexane-scored.xyz'));
    const text = obabelEnsembleText(parsed.frames, { version: '3.1.0', ff: 'mmff94' });
    const reparsed = parseMultiXyz(text);
    expect(reparsed.errors).toEqual([]);
    expect(reparsed.frames).toHaveLength(6);
    // No frame may carry a number the app would read as a Hartree total.
    for (const frame of reparsed.frames) expect(frame.energyEh).toBeNull();
    expect(reparsed.frames[0].comment).toContain('Open Babel 3.1.0');
    expect(reparsed.frames[0].comment).toContain('MMFF94');
  });

  it('says in the caption that the numbers are force-field, not QM', () => {
    const caption = conformerTableCaption({ generator: 'obabel', energyUnit: 'kcal/mol', energyMethod: 'MMFF94' });
    expect(caption).toContain('MMFF94');
    expect(caption).toContain('force-field energies, not QM');
    expect(caption).not.toContain('torsional grid');
  });

  it('ranks the ensemble in the unit it declares', () => {
    const parsed = parseObabelScoredEnsemble(fixture('hexane-scored.xyz'));
    const ranked = rankEnsemble({
      frames: parsed.frames.map((frame) => ({ ...frame, energyEh: frame.energyKcal })),
      energyUnit: 'kcal/mol',
      energyMethod: 'MMFF94',
      energyWindowKcal: 10,
      rmsdThreshold: 0.5,
      maxConformers: 20,
    });
    expect(ranked.error).toBeNull();
    expect(ranked.energyUnit).toBe('kcal/mol');
    expect(ranked.members).toHaveLength(6);
    expect(ranked.members[0].relativeKcal).toBeCloseTo(0, 10);
    // ΔE is measured against the lowest member in kcal/mol, not converted to Hartree.
    expect(ranked.members[1].relativeKcal).toBeCloseTo(2.52408, 5);
    expect(ranked.members[0].energyMethod).toBe('MMFF94');
  });
});
