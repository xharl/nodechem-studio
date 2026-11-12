import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { parseNormalModes } from '../src/shared/normalModes.js';
import { parseRamanActivities } from '../src/shared/raman.js';
import { parseVcdStrengths } from '../src/shared/vcd.js';
import { parseRoaIntensities } from '../src/shared/roa.js';
import { toLines } from '../src/shared/lines.js';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/real/${name}`, import.meta.url)), 'utf8');

/**
 * Record every `String.prototype.split` call a synchronous function makes.
 *
 * #368: the top-level parser must split the document once and hand lines to
 * every section reader. A reader that joins its input back into a string and
 * splits it again shows up here as a second split whose receiver is the whole
 * document, and a reader that re-splits a lines array shows up as any split at
 * all. The patch is restored in `finally`, so a failing assertion cannot leak
 * it into another test.
 */
function recordSplits(run) {
  const original = String.prototype.split;
  const calls = [];
  String.prototype.split = function split(...args) {
    calls.push({ receiver: this, args });
    return original.apply(this, args);
  };
  try {
    run();
  } finally {
    String.prototype.split = original;
  }
  return calls;
}

const parsers = [
  ['normal modes', parseNormalModes, 'g16-dvb-ir.out'],
  ['Raman activities', parseRamanActivities, 'g16-h2o-raman.out'],
  ['VCD strengths', parseVcdStrengths, 'g16-propyleneoxide-vcd.out'],
  ['ROA intensities', parseRoaIntensities, 'g09-formaldehyde-roa.out'],
];

describe('line input for the section parsers (#368)', () => {
  it('returns an already-split array by reference instead of copying it', () => {
    const lines = ['first', 'second'];
    expect(toLines(lines)).toBe(lines);
    expect(toLines('a\r\nb\nc\rd')).toEqual(['a', 'b', 'c', 'd']);
    expect(toLines(undefined)).toEqual(['']);
  });

  it.each(parsers)('%s reads the same record from a string and from lines', (label, parse, name) => {
    const text = fixture(name);
    const lines = toLines(text);
    const fromText = parse(text);
    const fromLines = parse(lines);
    expect(fromText).not.toBeNull();
    expect(fromLines).toEqual(fromText);
  });

  it.each(parsers)('%s does not split a lines array it was given', (label, parse, name) => {
    const lines = toLines(fixture(name));
    // Any split here is a re-split: the input is already at line granularity,
    // and these four readers have no sub-token of their own that needs one.
    expect(recordSplits(() => parse(lines))).toHaveLength(0);
  });
});

describe('one document split per Gaussian parse (#368)', () => {
  it.each([
    'g09-oniom-ir.log',
    'g16-dvb-sp.out',
    'g16-propyleneoxide-vcd.out',
  ])('splits %s exactly once', (name) => {
    const text = fixture(name);
    const calls = recordSplits(() => parseGaussianOutput(text));
    const documentSplits = calls.filter((call) => String(call.receiver) === text);
    expect(documentSplits).toHaveLength(1);
    expect(String(documentSplits[0].args[0])).toBe(String(/\r\n|\n|\r/));
  });
});
