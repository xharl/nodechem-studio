import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OBABEL_MMFF_ELEMENTS,
  obabelCoverageRefusal,
  obabelEnsembleText,
  obabelForceFieldKeyword,
  obabelScoreArgv,
  obabelSearchArgv,
  obabelSearchFailure,
  obabelVersionRefusal,
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

  it('runs UFF as the third force field, and never GAFF', () => {
    // Issue #240: the block's `method` selects the field, and UFF is a real
    // Open Babel field with no charge-model caveat.
    expect(obabelForceFieldKeyword('UFF')).toBe('UFF');
    expect(obabelSearchArgv({ ff: 'UFF' })).toContain('UFF');
    expect(obabelScoreArgv({ ff: 'uff' })).toContain('UFF');
    expect(() => obabelSearchArgv({ ff: 'gaff' })).toThrow(/mmff94, mmff94s, uff/);
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

  it('checks coverage against the selected force field, not the program', () => {
    // Issue #240: UFF is parameterised across the periodic table; MMFF94 is not.
    const selenium = [{ element: 'C' }, { element: 'Se' }];
    expect(obabelCoverageRefusal(selenium, 'MMFF94')).toMatch(/MMFF94 has no parameters for Se/);
    expect(obabelCoverageRefusal(selenium, 'mmff94s')).toMatch(/MMFF94s has no parameters for Se/);
    expect(obabelCoverageRefusal(selenium, 'UFF')).toBe('');
  });
});

describe('issue #239: the Open Babel 3.2.x conformer crash', () => {
  it('refuses every 3.2.x spelling, naming the version and the workaround', () => {
    for (const version of ['3.2.0', '3.2.1', '3.2.1-1', '3.2', 'v3.2.1']) {
      const refusal = obabelVersionRefusal(version);
      expect(refusal).toMatch(/Open Babel 3\.2(?:\.\d+)? crashes in its conformer search/);
      expect(refusal).toContain('`--conformer`');
      expect(refusal).toMatch(/install 3\.1\.x or use the in-app UFF search/);
    }
    // The whole `-V` line is accepted too; the version token is what matters.
    expect(obabelVersionRefusal('Open Babel 3.2.1 -- Feb 17 2026'))
      .toMatch(/Open Babel 3\.2\.1 crashes/);
  });

  it('does not refuse 3.1.x, later series, or a version it cannot read', () => {
    for (const version of ['3.1.0', '3.1.1-2', '3.10.0', '2.4.1', '4.0.0', '', 'not a version']) {
      expect(obabelVersionRefusal(version)).toBe('');
    }
  });

  it('treats a signalled child as a failure even though exitCode is null', () => {
    const failure = obabelSearchFailure({ exitCode: null, signal: 'SIGSEGV' });
    expect(failure).toMatch(/ended with signal SIGSEGV/);
    expect(failure).toMatch(/not used/);
    // No exit code at all is still not a completed search.
    expect(obabelSearchFailure({ exitCode: null, signal: null })).toMatch(/without an exit code/);
    // A real zero is the only success.
    expect(obabelSearchFailure({ exitCode: 0, signal: null })).toBe('');
    expect(obabelSearchFailure({ exitCode: 1, signal: null })).toMatch(/exited with code 1/);
    // Cancellation and timeout have their own paths; they are not "completed".
    expect(obabelSearchFailure({ exitCode: null, signal: 'SIGTERM', cancelled: true })).toBe('');
    expect(obabelSearchFailure({ exitCode: null, signal: 'SIGTERM', timedOut: true })).toBe('');
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
