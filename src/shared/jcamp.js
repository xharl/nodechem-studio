/**
 * JCAMP-DX reader for sampled spectra (#119).
 *
 * The app writes `.jdx` and could not read one, which made the comparison
 * surface one-way: a spectrum from a spectrometer, or from a colleague's
 * program, had nowhere to go. This module reads the two forms that carry a
 * sampled trace:
 *
 *   ##XYDATA= (X++(Y..Y))   an x value per line, then as many y values as fit
 *   ##XYPOINTS= (XY..XY)    explicit (x, y) pairs, no compression
 *
 * The first is where the format earns its reputation. `##XFACTOR` is the x
 * increment, `##YFACTOR` scales every intensity, and the y column may be
 * compressed with the pseudo-digits of JCAMP-DX Table 5: SQZ replaces a leading
 * digit and sign (`A000` = +1000), DIF replaces a difference (`J000` = +1000
 * relative to the previous y, `%` = no change), and DUP replaces a run of
 * identical values (`U` = that value three times including the first). The
 * numeric `?` marker is the same difference idea spelled out, and some files
 * begin a line with one, so it is read across line boundaries.
 *
 * What this reader will not do is guess:
 *
 * - x is reconstructed from the line-leading value scaled by `##XFACTOR`, and
 *   every following x on that line advances by exactly `##XFACTOR`. Each line's
 *   starting x is checked against that grid; a file whose x jumps is refused
 *   rather than resampled. `##FIRSTX`, `##LASTX` and `##NPOINTS` are then all
 *   checked against what was delivered, and a disagreement names both numbers.
 * - Units are carried, never invented. A file with no `##XUNITS` comes back
 *   with `xUnits: null` and a note saying so, because "1/CM" would be a claim
 *   the file did not make.
 * - Peaks are not points. `##RADATA` and `##PEAK TABLE` are refused by name:
 *   they summarise a spectrum, and a summary cannot be overlaid as a curve.
 *   `##NTUPLES` is refused because it holds more than one spectrum, and
 *   `##DATA TABLE` because its columns are an assignment, not a trace.
 *
 * The returned shape is deliberately the one the results panel already feeds
 * to `scaleToSpectrum`/`overlayPolyline` (points, rows, skipped, min/max), with
 * the header fields added on top, so importing a `.jdx` needs no second branch
 * in the view.
 */

export class JcampError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JcampError';
  }
}

/** Table 5 of JCAMP-DX: the pseudo-digit blocks, in value order. */
const SQZ_POSITIVE = '@ABCDEFGHI';
const SQZ_NEGATIVE = 'abcdefghi';
const DIF_POSITIVE = '%JKLMNOPQR';
const DIF_NEGATIVE = 'jklmnopqr';
const DUP_COUNTS = 'STUVWXYZs';

/**
 * AFFN: an ASCII number. `E` is an exponent only here, inside a number; at the
 * start of a token it is the SQZ pseudo-digit for +5.
 */
const AFFN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/;
const REST = /^[0-9.]*/;

const DATA_LABELS = ['XYDATA', 'XYPOINTS', 'RADATA', 'PEAK TABLE', 'DATA TABLE', 'NTUPLES', 'PAGE'];

function stripComment(line) {
  const at = line.indexOf('$$');
  return at < 0 ? line : line.slice(0, at);
}

function textOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** A number for a message, without the binary noise that would hide the point. */
function numberText(value) {
  return Number.isFinite(value) ? String(Number(value.toPrecision(12))) : String(value);
}

/**
 * Two axis positions are the same when they agree to 1e-6 relative, with an
 * absolute floor so a trace near zero is not judged against zero tolerance.
 */
function samePosition(a, b) {
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-6 + 1e-9;
}

/**
 * Split the document into the flat label map and one section per label. A
 * section's `lines` are the lines that follow it up to the next `##` label.
 */
function parseDocument(text) {
  const entries = new Map();
  const sections = new Map();
  let active = null;
  for (const line of String(text).split(/\r\n|\n|\r/)) {
    if (line.startsWith('##')) {
      active = null;
      const equals = line.indexOf('=');
      if (equals < 0) continue;
      const label = line.slice(2, equals).trim().toUpperCase();
      if (!label) continue;
      const value = stripComment(line.slice(equals + 1)).trim();
      entries.set(label, value);
      const section = { form: value, lines: [] };
      sections.set(label, section);
      if (DATA_LABELS.includes(label)) active = section;
      continue;
    }
    if (active) active.lines.push(line);
  }
  return { entries, sections };
}

function numberFrom(entries, label) {
  const raw = entries.get(label);
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new JcampError(`##${label} is not a finite number (${JSON.stringify(raw)}).`);
  }
  return value;
}

function countFrom(entries) {
  const raw = entries.get('NPOINTS');
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new JcampError(`##NPOINTS is not a whole number of points (${JSON.stringify(raw)}).`);
  }
  return value;
}

function factorFrom(entries, label) {
  const value = numberFrom(entries, label);
  if (value === null) return 1;
  if (value === 0) {
    throw new JcampError(`##${label} is zero, which would collapse the axis; a factor must be non-zero.`);
  }
  return value;
}

/** `(X++(Y..Y))` → `X++(Y..Y)`; the comparison is on the form, not its spacing. */
function normaliseForm(value) {
  const text = String(value || '').replace(/\s+/g, '').toUpperCase();
  return text.startsWith('(') && text.endsWith(')') ? text.slice(1, -1) : text;
}

function formLabel(kind) {
  if (kind === 'sqz') return 'SQZ';
  if (kind === 'dif') return 'DIF';
  return 'DUP';
}

function pseudoAt(character) {
  let at = SQZ_POSITIVE.indexOf(character);
  if (at >= 0) return { form: 'sqz', digit: at, sign: 1 };
  at = SQZ_NEGATIVE.indexOf(character);
  if (at >= 0) return { form: 'sqz', digit: at + 1, sign: -1 };
  at = DIF_POSITIVE.indexOf(character);
  if (at >= 0) return { form: 'dif', digit: at, sign: 1 };
  at = DIF_NEGATIVE.indexOf(character);
  if (at >= 0) return { form: 'dif', digit: at + 1, sign: -1 };
  return null;
}

/**
 * Tokens of one data line. Whitespace, commas and semicolons separate values;
 * a pseudo-digit also separates, which is how `A000B000B001` is three values
 * and not one.
 */
function tokensOf(line, lineNumber) {
  const tokens = [];
  let index = 0;
  while (index < line.length) {
    const character = line[index];
    if (character === ' ' || character === '\t' || character === ',' || character === ';') {
      index += 1;
      continue;
    }
    if (character === '?') {
      const number = AFFN.exec(line.slice(index + 1));
      const text = line.slice(index, number ? index + 1 + number[0].length : index + 1);
      tokens.push({ kind: 'dif', value: number ? Number(number[0]) : 0, text });
      index += text.length;
      continue;
    }
    const duplicate = DUP_COUNTS.indexOf(character);
    if (duplicate >= 0) {
      tokens.push({ kind: 'dup', count: duplicate + 1, text: character });
      index += 1;
      continue;
    }
    const pseudo = pseudoAt(character);
    if (pseudo) {
      const rest = REST.exec(line.slice(index + 1))[0];
      const value = Number(`${pseudo.sign < 0 ? '-' : '+'}${pseudo.digit}${rest}`);
      if (!Number.isFinite(value)) {
        throw new JcampError(`data line ${lineNumber} carries a ${formLabel(pseudo.form)} value that is not a number (${JSON.stringify(line.slice(index, index + 1 + rest.length))}).`);
      }
      tokens.push({ kind: pseudo.form, value, text: line.slice(index, index + 1 + rest.length) });
      index += 1 + rest.length;
      continue;
    }
    const number = AFFN.exec(line.slice(index));
    if (number) {
      tokens.push({ kind: 'value', value: Number(number[0]), text: number[0] });
      index += number[0].length;
      continue;
    }
    throw new JcampError(`data line ${lineNumber} contains ${JSON.stringify(character)}, which is not a number and not a compression marker this reader implements.`);
  }
  return tokens;
}

/**
 * Expand the y tokens of one line into stored values. `previous` is the last
 * stored y of the file, so a difference on the first token of a line continues
 * the previous line rather than restarting the trace.
 */
function expandValues(tokens, previous, forms, lineNumber) {
  const values = [];
  let last = previous;
  for (const token of tokens) {
    if (token.kind === 'value') {
      last = token.value;
      values.push(last);
      continue;
    }
    if (token.kind === 'sqz') {
      forms.add('sqz');
      last = token.value;
      values.push(last);
      continue;
    }
    if (token.kind === 'dif') {
      if (last === null) {
        throw new JcampError(`data line ${lineNumber} starts with the difference marker ${JSON.stringify(token.text)}, but there is no preceding y value to difference from.`);
      }
      forms.add('dif');
      last += token.value;
      values.push(last);
      continue;
    }
    if (last === null) {
      throw new JcampError(`data line ${lineNumber} starts with the duplicate marker ${JSON.stringify(token.text)}, but there is no preceding y value to repeat.`);
    }
    forms.add('dup');
    for (let copy = 1; copy < token.count; copy += 1) values.push(last);
  }
  return values;
}

/**
 * 1 = ascending, -1 = descending, 0 = flat or a single point. A contradiction
 * is reported with the point number, because a spectrum's axis is monotonic by
 * construction and anything else is a mis-parse worth refusing.
 */
function orderingOf(points) {
  let direction = 0;
  for (let index = 1; index < points.length; index += 1) {
    const delta = points[index].x - points[index - 1].x;
    if (delta === 0) continue;
    const step = delta > 0 ? 1 : -1;
    if (direction === 0) direction = step;
    else if (direction !== step) return { direction: 0, contradiction: index };
  }
  return { direction, contradiction: -1 };
}

function checkAgainstHeader(points, { declared, firstX, lastX }) {
  if (declared !== null && points.length !== declared) {
    throw new JcampError(`##NPOINTS says ${declared} but the data block delivered ${points.length} points.`);
  }
  if (firstX !== null && !samePosition(points[0].x, firstX)) {
    throw new JcampError(`##FIRSTX says ${numberText(firstX)} but the data block starts at ${numberText(points[0].x)}.`);
  }
  const last = points[points.length - 1];
  if (lastX !== null && !samePosition(last.x, lastX)) {
    throw new JcampError(`##LASTX says ${numberText(lastX)} but the data block ends at ${numberText(last.x)}.`);
  }
}

function readXppYy(section, { declared, firstX, lastX, label }, xFactor, yFactor) {
  const points = [];
  const forms = new Set(['affn']);
  let previousY = null;
  let expectedStoredX = null;
  let lineNumber = 0;
  // On a descending axis the stored x decreases by one per point; the sign is
  // the one the header declares, and is checked against the next line rather
  // than assumed.
  const direction = (firstX !== null && lastX !== null && lastX < firstX) ? -1 : 1;

  for (const raw of section.lines) {
    const line = stripComment(raw).trim();
    if (line === '') continue;
    lineNumber += 1;
    const tokens = tokensOf(line, lineNumber);
    if (tokens.length === 0) continue;

    const [xToken, ...yTokens] = tokens;
    if (xToken.kind !== 'value') {
      throw new JcampError(`data line ${lineNumber} starts with ${JSON.stringify(xToken.text)}, which is ${formLabel(xToken.kind)}-compressed; an x value must be a plain number scaled by ##XFACTOR.`);
    }
    if (yTokens.length === 0) {
      throw new JcampError(`data line ${lineNumber} carries an x value and no y values.`);
    }

    const storedX = xToken.value;
    if (expectedStoredX !== null && !samePosition(storedX, expectedStoredX)) {
      throw new JcampError(`data line ${lineNumber} starts at x = ${numberText(storedX * xFactor)}, but the preceding points put the next x at ${numberText(expectedStoredX * xFactor)}; the file is not on the even grid ##XFACTOR declares, and this reader will not invent the step.`);
    }

    const values = expandValues(yTokens, previousY, forms, lineNumber);
    if (values.length === 0) continue;
    previousY = values[values.length - 1];
    values.forEach((value, offset) => {
      points.push({ x: (storedX + direction * offset) * xFactor, y: value * yFactor });
    });
    expectedStoredX = storedX + direction * values.length;
  }

  if (points.length === 0) throw new JcampError(`##${label} is present but carries no points.`);
  checkAgainstHeader(points, { declared, firstX, lastX });
  return { points, forms };
}

function readPairs(section, { declared, firstX, lastX, label }, xFactor, yFactor) {
  const numbers = [];
  let lineNumber = 0;
  for (const raw of section.lines) {
    const line = stripComment(raw).trim();
    if (line === '') continue;
    lineNumber += 1;
    for (const token of tokensOf(line, lineNumber)) {
      if (token.kind !== 'value') {
        throw new JcampError(`data line ${lineNumber} carries ${JSON.stringify(token.text)}, a ${formLabel(token.kind)} marker; the paired form is plain numbers only.`);
      }
      numbers.push(token.value);
    }
  }
  if (numbers.length === 0) {
    throw new JcampError(`##${label} is present but carries no points.`);
  }
  if (numbers.length % 2 === 1) {
    throw new JcampError(`##${label} delivered ${numbers.length} numbers, which is not a whole number of (x, y) pairs.`);
  }
  const points = [];
  for (let index = 0; index < numbers.length; index += 2) {
    points.push({ x: numbers[index] * xFactor, y: numbers[index + 1] * yFactor });
  }
  checkAgainstHeader(points, { declared, firstX, lastX });
  return { points, forms: new Set(['affn']) };
}

function boundsOf(points) {
  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, maxX, minY, maxY };
}

/** True when the text looks like JCAMP-DX rather than a two-column dump. */
export function isJcampDx(text) {
  return /^[ \t]*##[^=\n]+=/m.test(String(text ?? ''));
}

/**
 * @param {string} text a JCAMP-DX document
 * @returns {object} the spectrum shape the results panel consumes, plus the
 *   header fields the file declared and the compression forms it used
 */
export function readJcampDx(text) {
  const source = String(text ?? '');
  if (source.trim() === '') {
    throw new JcampError('the file is empty: there is no JCAMP-DX header to read.');
  }
  const { entries, sections } = parseDocument(source);
  const sectionForm = (label) => sections.get(label)?.form ?? '';

  if (entries.has('NTUPLES')) {
    throw new JcampError('##NTUPLES declares a multi-block file: its ##PAGE blocks hold several spectra and this reader returns one. Split the block you need into its own file.');
  }

  const xFactor = factorFrom(entries, 'XFACTOR');
  const yFactor = factorFrom(entries, 'YFACTOR');
  const declared = countFrom(entries);
  const firstX = numberFrom(entries, 'FIRSTX');
  const lastX = numberFrom(entries, 'LASTX');
  const notes = [];

  const xUnits = textOrNull(entries.get('XUNITS'));
  const yUnits = textOrNull(entries.get('YUNITS'));
  if (xUnits === null) notes.push('##XUNITS is absent: the x axis carries no declared units.');
  if (yUnits === null) notes.push('##YUNITS is absent: the y axis carries no declared units.');
  if (declared === null) notes.push('##NPOINTS is absent: the point count was derived from the data.');

  let points;
  let axis;
  let forms;

  if (entries.has('XYDATA')) {
    const declaredForm = sectionForm('XYDATA');
    const form = normaliseForm(declaredForm);
    if (form === '' || form === 'X++(Y..Y)') {
      axis = 'X++(Y..Y)';
      if (form === '') notes.push('##XYDATA declares no form; it was read as (X++(Y..Y)).');
      ({ points, forms } = readXppYy(sections.get('XYDATA'), { declared, firstX, lastX, label: 'XYDATA' }, xFactor, yFactor));
    } else if (form === 'XY..XY') {
      axis = 'XY..XY';
      ({ points, forms } = readPairs(sections.get('XYDATA'), { declared, firstX, lastX, label: 'XYDATA' }, xFactor, yFactor));
    } else {
      throw new JcampError(`##XYDATA declares the form "${declaredForm}", which this reader does not implement; it reads (X++(Y..Y)) and (XY..XY).`);
    }
  } else if (entries.has('XYPOINTS')) {
    axis = 'XYPOINTS';
    ({ points, forms } = readPairs(sections.get('XYPOINTS'), { declared, firstX, lastX, label: 'XYPOINTS' }, xFactor, yFactor));
  } else if (entries.has('RADATA')) {
    throw new JcampError('this file\'s only data section is ##RADATA, which holds peaks or other derived rows rather than a sampled trace: it carries peaks, not points. This reader reads ##XYDATA (X++(Y..Y)) and ##XYPOINTS (XY..XY).');
  } else if (entries.has('PEAK TABLE')) {
    throw new JcampError('this file\'s only data section is ##PEAK TABLE, which lists peaks, not points: a peak table is a summary of a spectrum and cannot be overlaid as a curve. This reader reads ##XYDATA (X++(Y..Y)) and ##XYPOINTS (XY..XY).');
  } else if (entries.has('DATA TABLE')) {
    throw new JcampError('##DATA TABLE is not implemented: its columns are an assignment rather than a sampled trace. This reader reads ##XYDATA (X++(Y..Y)) and ##XYPOINTS (XY..XY).');
  } else {
    throw new JcampError('no data section: this file carries neither ##XYDATA nor ##XYPOINTS.');
  }

  if ((axis === 'X++(Y..Y)' || axis === 'XY..XY' || axis === 'XYPOINTS') && entries.has('PEAK TABLE')) {
    notes.push('The file also carries a ##PEAK TABLE; it was not read, because peaks are derived from the point list.');
  }

  const ordering = orderingOf(points);
  if (ordering.contradiction > 0) {
    const index = ordering.contradiction;
    throw new JcampError(`the x values are neither increasing nor decreasing (x = ${numberText(points[index].x)} follows x = ${numberText(points[index - 1].x)} at point ${index + 1}); a sampled axis must be monotonic.`);
  }
  let ordered = points;
  if (ordering.direction < 0) {
    ordered = [...points].sort((a, b) => a.x - b.x);
    notes.push('The file lists its points in descending x; they were reordered ascending for plotting. Values are unchanged.');
  }

  const bounds = boundsOf(ordered);
  return {
    format: 'jcamp-dx',
    title: textOrNull(entries.get('TITLE')),
    dataType: textOrNull(entries.get('DATA TYPE')),
    origin: textOrNull(entries.get('ORIGIN')),
    owner: textOrNull(entries.get('OWNER')),
    date: textOrNull(entries.get('DATE')),
    xUnits,
    yUnits,
    xUnitsUnknown: xUnits === null,
    yUnitsUnknown: yUnits === null,
    axis,
    compression: [...forms].join('+'),
    xFactor,
    yFactor,
    declaredNpoints: declared,
    npoints: ordered.length,
    points: ordered,
    rows: ordered.length,
    skipped: 0,
    ...bounds,
    notes,
  };
}
