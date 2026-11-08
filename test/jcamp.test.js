import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JcampError, isJcampDx, readJcampDx } from '../src/shared/jcamp.js';
import { importSpectrumText, sameAxisUnits } from '../src/shared/spectrumImport.js';
import { writeJcampDx } from '../src/shared/converters/jcampDx.js';
import { spectrumFromParsed } from '../src/shared/converters/index.js';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { ramanSectionHtml } from '../src/renderer/resultsView.js';

const fixture = (name) => readFileSync(`test/fixtures/jcamp/${name}`, 'utf8');
const real = (name) => readFileSync(`test/fixtures/real/${name}`, 'utf8');

/**
 * Every fixture in test/fixtures/jcamp is hand-written for these tests. None of
 * them came off an instrument: a real .jdx would carry an OWNER line and a
 * provenance this repository cannot claim.
 */
const factors = fixture('xydata-factors.jdx');
const difdup = fixture('xydata-difdup.jdx');
const pairs = fixture('xypoints.jdx');

function file(...lines) {
  return `${lines.join('\n')}\n`;
}

const header = (...extra) => [
  '##TITLE= refused',
  '##JCAMP-DX=5.00',
  '##DATA TYPE=INFRARED SPECTRUM',
  '##ORIGIN= synthetic fixture for the JCAMP reader tests',
  '##XUNITS=1/CM',
  '##YUNITS=ARBITRARY UNITS',
  '##XFACTOR=1',
  '##YFACTOR=1',
  ...extra,
];

/** Relative comparison with a floor, so a near-zero value is not a special case. */
function expectSame(actual, expected, relative) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(Math.abs(expected), 1) * relative);
}

describe('jcamp-dx reader — ##XYDATA in X++(Y..Y)', () => {
  const spectrum = readJcampDx(factors);

  it('counts the points it delivered, not the ones the header promises', () => {
    expect(spectrum.npoints).toBe(6);
    expect(spectrum.points).toHaveLength(6);
    expect(spectrum.declaredNpoints).toBe(6);
    expect(spectrum.rows).toBe(6);
    expect(spectrum.skipped).toBe(0);
  });

  it('reconstructs x from the line-leading value and ##XFACTOR', () => {
    const xs = spectrum.points.map((point) => point.x);
    expect(xs).toEqual([4000, 4000.5, 4001, 4001.5, 4002, 4002.5]);
    expect(spectrum.minX).toBe(4000);
    expect(spectrum.maxX).toBe(4002.5);
    expect(spectrum.xFactor).toBe(0.5);
  });

  it('applies ##YFACTOR to every y value', () => {
    expect(spectrum.points.map((point) => point.y)).toEqual([20, 40, 60, 80, 100, 120]);
    expect(spectrum.minY).toBe(20);
    expect(spectrum.maxY).toBe(120);
    expect(spectrum.yFactor).toBe(2);
  });

  it('carries the declared units instead of assuming them', () => {
    expect(spectrum.xUnits).toBe('1/CM');
    expect(spectrum.yUnits).toBe('ARBITRARY UNITS');
    expect(spectrum.xUnitsUnknown).toBe(false);
    expect(spectrum.dataType).toBe('INFRARED SPECTRUM');
    expect(spectrum.title).toContain('synthetic X++(Y..Y)');
  });

  it('states the axis form and the compression it read', () => {
    expect(spectrum.axis).toBe('X++(Y..Y)');
    expect(spectrum.compression).toBe('affn');
  });
});

describe('jcamp-dx reader — DIF and DUP markers', () => {
  const spectrum = readJcampDx(difdup);

  it('expands SQZ, DIF and DUP to the values the file encodes', () => {
    // A000 = +1000 absolute; J000/J/J/J = differences; % = zero difference;
    // U = repeat the previous value three times, itself included; ?7 and ?-10
    // are the numeric difference form.
    expect(spectrum.points.map((point) => point.y))
      .toEqual([1000, 2000, 2001, 2002, 2003, 2003, 2003, 2003, 2010, 2000]);
  });

  it('keeps the x axis across a line boundary that starts with a difference', () => {
    expect(spectrum.points.map((point) => point.x)).toEqual([1600, 1601, 1602, 1603, 1604, 1605, 1606, 1607, 1608, 1609]);
    expect(spectrum.npoints).toBe(10);
  });

  it('names every compression form it met', () => {
    expect(spectrum.compression).toBe('affn+sqz+dif+dup');
  });

  it('reads a `?` marker without a pseudo-digit anywhere in the line', () => {
    const text = file(
      ...header('##NPOINTS=3', '##FIRSTX=100', '##LASTX=102'),
      '##XYDATA= (X++(Y..Y))',
      '100 10 ?5 ?-5',
      '##END=',
    );
    expect(readJcampDx(text).points.map((point) => point.y)).toEqual([10, 15, 10]);
    expect(readJcampDx(text).compression).toBe('affn+dif');
  });
});

describe('jcamp-dx reader — ##XYPOINTS', () => {
  const spectrum = readJcampDx(pairs);

  it('reads (x, y) pairs and scales both axes by their factors', () => {
    expect(spectrum.points).toEqual([
      { x: 100, y: 1 },
      { x: 200, y: 2 },
      { x: 300, y: 3 },
      { x: 400, y: 4 },
    ]);
    expect(spectrum.xFactor).toBe(10);
    expect(spectrum.yFactor).toBe(0.5);
    expect(spectrum.axis).toBe('XYPOINTS');
    expect(spectrum.compression).toBe('affn');
  });

  it('returns the shape the comparison surface already consumes', () => {
    expect(spectrum).toMatchObject({
      format: 'jcamp-dx', rows: 4, skipped: 0, npoints: 4, declaredNpoints: 4, minX: 100, maxX: 400, minY: 1, maxY: 4,
    });
    expect(spectrum.notes).toEqual([]);
  });

  it('reads ##XYDATA declared as (XY..XY) through the same pair parser', () => {
    const text = file(
      ...header('##NPOINTS=2', '##FIRSTX=10', '##LASTX=20'),
      '##XYDATA= (XY..XY)',
      '10, 1\n20, 2',
      '##END=',
    );
    const spectrum = readJcampDx(text);
    expect(spectrum.points).toEqual([{ x: 10, y: 1 }, { x: 20, y: 2 }]);
    expect(spectrum.axis).toBe('XY..XY');
  });
});

describe('jcamp-dx reader — round-trip against this repository’s writer', () => {
  const water = parseGaussianOutput(real('g16-h2o-raman.out'));
  const td = parseGaussianOutput(real('g16-dvb-td.out'));

  function roundTrip(parsed, kind, title) {
    const source = spectrumFromParsed(parsed, kind);
    // The writer sorts by x before it writes, so the series to compare against
    // is the sorted one — the UV curve is built from long to short wavelength.
    const expected = [...source.points].sort((a, b) => a.x - b.x);
    const text = writeJcampDx({
      title,
      dataType: source.dataType,
      xUnits: source.xUnits,
      yUnits: source.yUnits,
      points: source.points,
    });
    return { source: { ...source, points: expected }, text, back: readJcampDx(text) };
  }

  it('reads a Raman .jdx the writer produced back to the same points', () => {
    const { source, text, back } = roundTrip(water, 'raman', 'round-trip raman');
    expect(text).toContain('##XYPOINTS= (XY..XY)');
    expect(back.points).toHaveLength(source.points.length);
    back.points.forEach((point, index) => {
      expectSame(point.x, source.points[index].x, 1e-9);
      expectSame(point.y, source.points[index].y, 1e-7);
    });
    expect(back.xUnits).toBe(source.xUnits);
    expect(back.yUnits).toBe(source.yUnits);
    expect(back.dataType).toBe(source.dataType);
    expect(back.title).toBe('round-trip raman');
    expect(back.compression).toBe('affn');
  });

  it('reads a 240-point UV .jdx across its wrapped pair lines', () => {
    const { source, back } = roundTrip(td, 'uv', 'round-trip uv');
    expect(back.npoints).toBe(240);
    expect(back.declaredNpoints).toBe(240);
    expect(back.points).toHaveLength(240);
    back.points.forEach((point, index) => {
      expectSame(point.x, source.points[index].x, 1e-9);
      expectSame(point.y, source.points[index].y, 1e-7);
    });
    expect(back.maxX - back.minX).toBeGreaterThan(0);
  });
});

describe('jcamp-dx reader — refusals name the section', () => {
  const refusal = (text) => {
    try {
      readJcampDx(text);
    } catch (error) {
      return error;
    }
    throw new Error('the reader accepted a file it should have refused');
  };

  it('refuses a ##RADATA-only file as peaks, not points', () => {
    const error = refusal(file(
      ...header('##NPOINTS=2'),
      '##RADATA= (XY..XY)',
      '100, 2; 200, 4',
      '##END=',
    ));
    expect(error).toBeInstanceOf(JcampError);
    expect(error.message).toContain('##RADATA');
    expect(error.message).toMatch(/peaks, not points/);
  });

  it('refuses a ##PEAK TABLE-only file as peaks, not points', () => {
    const error = refusal(file(
      '##TITLE= peaks', '##JCAMP-DX=4.24', '##DATA TYPE=MASS SPECTRUM',
      '##XUNITS=M/Z', '##YUNITS=RELATIVE ABUNDANCE',
      '##PEAK TABLE= (XY..XY)', '18, 100; 28, 40', '##END=',
    ));
    expect(error.message).toContain('##PEAK TABLE');
    expect(error.message).toMatch(/peaks, not points/);
  });

  it('refuses ##NTUPLES as a multi-block file', () => {
    const error = refusal(file(
      '##TITLE= blocks', '##JCAMP-DX=5.00', '##DATA TYPE=NMR SPECTRUM',
      '##NTUPLES= 2 BLOCKS', '##PAGE= block 1',
      '##XYDATA= (X++(Y..Y))', '100 1 2 3', '##END=',
    ));
    expect(error.message).toContain('##NTUPLES');
    expect(error.message).toMatch(/multi-block/);
  });

  it('refuses a ##DATA TABLE file rather than guessing at its columns', () => {
    const error = refusal(file(
      ...header('##NPOINTS=3', '##FIRSTX=100', '##LASTX=102'),
      '##DATA TABLE= (X++(R..R))',
      '100 1 2 3',
      '##END=',
    ));
    expect(error.message).toContain('##DATA TABLE');
    expect(error.message).toMatch(/not implemented/);
  });

  it('refuses an XYDATA form it does not implement, quoting the form', () => {
    const error = refusal(file(
      ...header('##NPOINTS=3', '##FIRSTX=100', '##LASTX=102'),
      '##XYDATA= (X++(R..R))',
      '100 1 2 3',
      '##END=',
    ));
    expect(error.message).toContain('##XYDATA');
    expect(error.message).toContain('(X++(R..R))');
    expect(error.message).toMatch(/does not implement/);
  });

  it('refuses a compression marker it does not implement, quoting the character and line', () => {
    const error = refusal(file(
      ...header('##NPOINTS=3', '##FIRSTX=100', '##LASTX=102'),
      '##XYDATA= (X++(Y..Y))',
      '100 10 20',
      '101 30 #40',
      '##END=',
    ));
    expect(error.message).toContain('data line 2');
    expect(error.message).toContain('"#"');
    expect(error.message).toMatch(/compression/);
  });

  it('refuses when ##NPOINTS and the delivered count disagree, naming both', () => {
    const error = refusal(file(
      ...header('##NPOINTS=6', '##FIRSTX=100', '##LASTX=105'),
      '##XYDATA= (X++(Y..Y))',
      '100 1 2 3 4 5',
      '##END=',
    ));
    expect(error.message).toContain('##NPOINTS says 6');
    expect(error.message).toContain('delivered 5 points');
  });

  it('refuses when ##FIRSTX disagrees with the first delivered point, naming both', () => {
    const error = refusal(file(
      ...header('##NPOINTS=3', '##FIRSTX=4000', '##LASTX=4002'),
      '##XYDATA= (X++(Y..Y))',
      '3999 1 2 3',
      '##END=',
    ));
    expect(error.message).toContain('##FIRSTX says 4000');
    expect(error.message).toContain('starts at 3999');
  });

  it('refuses when ##LASTX disagrees with the last delivered point, naming both', () => {
    const error = refusal(file(
      ...header('##NPOINTS=3', '##FIRSTX=4000', '##LASTX=4002.5'),
      '##XYDATA= (X++(Y..Y))',
      '4000 1 2 3',
      '##END=',
    ));
    expect(error.message).toContain('##LASTX says 4002.5');
    expect(error.message).toContain('ends at 4002');
  });

  it('refuses a data line whose x breaks the grid instead of assuming even spacing', () => {
    const error = refusal(file(
      ...header('##NPOINTS=4', '##FIRSTX=4000', '##LASTX=4003'),
      '##XYDATA= (X++(Y..Y))',
      '4000 1 2',
      '4003 3 4',
      '##END=',
    ));
    expect(error.message).toContain('data line 2 starts at x = 4003');
    expect(error.message).toContain('the next x at 4002');
    expect(error.message).toMatch(/will not invent the step/);
  });

  it('refuses a file with no data section at all', () => {
    const error = refusal(file('##TITLE= empty', '##JCAMP-DX=5.00', '##END='));
    expect(error.message).toContain('no data section');
    expect(error.message).toContain('##XYDATA');
    expect(error.message).toContain('##XYPOINTS');
  });

  it('refuses an ##XYDATA section that carries no data lines', () => {
    const error = refusal(file(
      ...header('##NPOINTS=0'),
      '##XYDATA= (X++(Y..Y))',
      '##END=',
    ));
    expect(error.message).toContain('##XYDATA');
    expect(error.message).toMatch(/no points/);
  });

  it('refuses a ##XYPOINTS block with an odd number of numbers', () => {
    const error = refusal(file(
      ...header('##NPOINTS=1', '##FIRSTX=10', '##LASTX=10'),
      '##XYPOINTS= (XY..XY)',
      '10, 1; 20',
      '##END=',
    ));
    expect(error.message).toContain('##XYPOINTS');
    expect(error.message).toContain('3 numbers');
    expect(error.message).toMatch(/whole number of \(x, y\) pairs/);
  });
});

describe('jcamp-dx reader — units are carried, never invented', () => {
  it('marks absent ##XUNITS as unknown and says so', () => {
    const text = file(
      '##TITLE= no units', '##JCAMP-DX=5.00', '##DATA TYPE=INFRARED SPECTRUM',
      '##ORIGIN= synthetic fixture for the JCAMP reader tests',
      '##XFACTOR=1', '##YFACTOR=1', '##NPOINTS=3', '##FIRSTX=100', '##LASTX=102',
      '##XYDATA= (X++(Y..Y))',
      '100 1 2 3',
      '##END=',
    );
    const spectrum = readJcampDx(text);
    expect(spectrum.xUnits).toBeNull();
    expect(spectrum.yUnits).toBeNull();
    expect(spectrum.xUnitsUnknown).toBe(true);
    expect(spectrum.yUnitsUnknown).toBe(true);
    expect(spectrum.notes.join(' ')).toContain('##XUNITS is absent');
    expect(spectrum.notes.join(' ')).toContain('##YUNITS is absent');
  });

  it('does not invent ##NPOINTS when the header omits it', () => {
    const text = file(
      '##TITLE= no count', '##JCAMP-DX=5.00', '##DATA TYPE=INFRARED SPECTRUM',
      '##XUNITS=1/CM', '##YUNITS=ARBITRARY UNITS',
      '##XFACTOR=1', '##YFACTOR=1', '##FIRSTX=100', '##LASTX=102',
      '##XYDATA= (X++(Y..Y))',
      '100 1 2 3',
      '##END=',
    );
    const spectrum = readJcampDx(text);
    expect(spectrum.declaredNpoints).toBeNull();
    expect(spectrum.npoints).toBe(3);
    expect(spectrum.notes.join(' ')).toContain('##NPOINTS is absent');
  });

  it('reorders a descending axis for plotting and says that it did', () => {
    // A descending axis keeps a positive factor: ##FIRSTX above ##LASTX is what
    // says which way the stored x runs.
    const text = file(
      '##TITLE= descending', '##JCAMP-DX=5.00', '##DATA TYPE=INFRARED SPECTRUM',
      '##XUNITS=1/CM', '##YUNITS=ARBITRARY UNITS',
      '##XFACTOR=1', '##YFACTOR=1', '##NPOINTS=3', '##FIRSTX=102', '##LASTX=100',
      '##XYDATA= (X++(Y..Y))',
      '102 1 2 3',
      '##END=',
    );
    const spectrum = readJcampDx(text);
    expect(spectrum.points.map((point) => point.x)).toEqual([100, 101, 102]);
    expect(spectrum.points.map((point) => point.y)).toEqual([3, 2, 1]);
    expect(spectrum.notes.join(' ')).toMatch(/descending/);
  });

  it('refuses an axis that is neither increasing nor decreasing', () => {
    const text = file(
      ...header('##NPOINTS=3', '##FIRSTX=100', '##LASTX=100.5'),
      '##XYPOINTS= (XY..XY)',
      '100, 1; 101, 2; 100.5, 3',
      '##END=',
    );
    expect(() => readJcampDx(text)).toThrow(/neither increasing nor decreasing/);
  });
});

describe('the spectrum import path', () => {
  it('recognises a JCAMP-DX file by its header', () => {
    expect(isJcampDx('##TITLE= x\n##JCAMP-DX=5.00\n')).toBe(true);
    expect(isJcampDx(pairs)).toBe(true);
    expect(isJcampDx('1800 2.5\n1600 1.1\n')).toBe(false);
    expect(isJcampDx('')).toBe(false);
  });

  it('dispatches a .jdx to the reader and a two-column dump to the overlay parser', () => {
    const jcamp = importSpectrumText(factors);
    expect(jcamp.format).toBe('jcamp-dx');
    expect(jcamp.xUnits).toBe('1/CM');
    expect(jcamp.points).toHaveLength(6);

    const dump = importSpectrumText('1800 2.5\n1600 1.1\n');
    expect(dump.format).toBeUndefined();
    expect(dump.points).toEqual([{ x: 1600, y: 1.1 }, { x: 1800, y: 2.5 }]);
    expect(dump.rows).toBe(2);

    expect(importSpectrumText('energy\nonly one column\n')).toBeNull();
  });

  it('surfaces a refusal instead of an empty overlay', () => {
    expect(() => importSpectrumText(factors.replace('##XUNITS=1/CM', '##NTUPLES= 2 BLOCKS')))
      .toThrow(/##NTUPLES/);
  });

  it('compares units by quantity, and says unknown when a side declares none', () => {
    expect(sameAxisUnits('1/CM', 'cm-1')).toBe(true);
    expect(sameAxisUnits('1/CM', 'CM^-1')).toBe(true);
    expect(sameAxisUnits('NM', '1/CM')).toBe(false);
    expect(sameAxisUnits(null, '1/CM')).toBeNull();
    expect(sameAxisUnits('ARBITRARY', 'ARBITRARY')).toBeNull();
  });

  it('overlays an imported .jdx on the Raman figure through the same shape', () => {
    const parsed = parseGaussianOutput(real('g16-h2o-raman.out'));
    const html = ramanSectionHtml(parsed.raman, {
      measured: readJcampDx(pairs),
      overlayName: 'imported.jdx',
      overlayNote: 'Imported 4 points from XYPOINTS in 1/CM.',
    });
    expect(html).toContain('class="spectrum-curve is-overlay"');
    expect(html).toContain('measured series “imported.jdx”');
    expect(html).toContain('Imported 4 points from XYPOINTS in 1/CM.');
  });
});
