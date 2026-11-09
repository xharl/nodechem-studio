/**
 * Dataset import for NodeChem Studio (RFC 0001).
 *
 * Pure module: text in, records out. No DOM, no filesystem, no Electron.
 *
 * A **dataset** is a named, ordered set of molecule records. Each record is
 * `{ id, label, charge, multiplicity, coords, enabled }`; `coords` is the
 * Cartesian geometry the record's runs start from. This app never invents a
 * geometry, so a file that carries no coordinates is refused with a readable
 * message rather than filled with a placeholder molecule.
 *
 * Formats:
 *   - SDF (one record per `$$$$` block, V2000 counts and atom block)
 *   - multi-XYZ (one record per frame; the comment line is the label)
 *   - CSV (header row; one atom per row, or repeated `x1,y1,z1,…` columns)
 *   - JSON (an array of records, or `{ records: [...] }`)
 *   - CDXML (one record per `<fragment>` of a ChemDraw drawing; the record is
 *     labelled from the fragment's own text, else `fragment N`, and carries
 *     `geometry.dimension = '2d'` because a drawing is not a geometry)
 *
 * Record ids become task-id segments (`opt~mol3`), so they are derived from
 * the label slug (or `m1…mN` when a label is missing) and made unique.
 * Bounds are the schema's: `LIMITS.records` records and `LIMITS.atoms` atoms
 * per record. A bad record is skipped and named in `errors`; a file with no
 * usable record returns none, and the caller refuses the import.
 */

import { isElementSymbol } from './elements.js';
import { RECORD_ID_RE } from './flows.js';
import { LIMITS } from './projectSchema.js';
import { parseStructureRecords } from './structureImport.js';

const MAX_COORD = 1e6;
const FORMATS = Object.freeze(['sdf', 'xyz', 'csv', 'json', 'cdxml']);

function oneLine(value, max) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function asNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'number' ? value : Number(String(value).trim().replace(/[Dd]/, 'E'));
  return Number.isFinite(number) ? number : null;
}

function asInteger(value) {
  const number = asNumber(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function normalizeElement(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

/**
 * A filesystem- and task-id-safe record id. Lower-case so the generated ids
 * (`acetylacetone-enol`) read like the task ids they become.
 */
export function slugifyRecordId(value) {
  const ascii = String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  let slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/[._-]{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 48);
  if (!slug) return '';
  if (!/^[a-z0-9]/.test(slug)) slug = `r-${slug}`.slice(0, 48);
  return slug;
}

function uniqueId(base, seen) {
  const seed = base || 'm1';
  let candidate = seed.slice(0, 60);
  let suffix = 2;
  while (seen.has(candidate)) {
    const tail = `-${suffix}`;
    candidate = `${seed.slice(0, 60 - tail.length)}${tail}`;
    suffix += 1;
  }
  seen.add(candidate);
  return candidate;
}

function emptyResult(format, message) {
  return { records: [], format, warnings: [], errors: [message] };
}

/* ── Record construction ──────────────────────────────────── */

/**
 * A record's stated topology, as the schema stores it: 1-based atom indices and
 * an order of 1, 1.5 (aromatic), 2 or 3. An entry that does not make sense for
 * this atom count is dropped rather than turned into a bond to a missing atom.
 */
function recordBonds(raw, atomCount) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const bonds = [];
  const seen = new Set();
  for (const entry of raw) {
    const a = asInteger(entry?.a);
    const b = asInteger(entry?.b);
    const order = asNumber(entry?.order ?? 1);
    if (a === null || b === null) continue;
    if (a < 1 || b < 1 || a > atomCount || b > atomCount || a === b) continue;
    if (![1, 1.5, 2, 3].includes(order)) continue;
    const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bonds.push({ a: Math.min(a, b), b: Math.max(a, b), order });
  }
  return bonds;
}

/**
 * Turn a raw record (from any parser) into the schema shape. Coordinates are
 * validated here so every format gets the same refusal message.
 */
function buildRecord(raw, index, seenIds) {
  const errors = [];
  const warnings = [];
  const prefix = `Record ${index + 1}`;
  const label = oneLine(raw?.label ?? raw?.name ?? raw?.title ?? '', 200);
  const requestedId = oneLine(raw?.id ?? '', 64);
  const base = RECORD_ID_RE.test(requestedId) ? requestedId : slugifyRecordId(requestedId || label);
  const id = uniqueId(base || `m${index + 1}`, seenIds);
  if (requestedId && requestedId !== id) {
    warnings.push(`${prefix}: id "${requestedId}" was normalised to "${id}".`);
  }

  const coordsRaw = raw?.coords ?? raw?.atoms ?? null;
  const coords = [];
  if (coordsRaw === undefined || coordsRaw === null) {
    errors.push(`${prefix}: no coordinates. A dataset record needs an atom block; this app never invents geometry.`);
  } else if (!Array.isArray(coordsRaw)) {
    errors.push(`${prefix}: coords must be an array of { element, x, y, z } atoms.`);
  } else if (coordsRaw.length === 0) {
    errors.push(`${prefix}: the coordinate list is empty.`);
  } else if (coordsRaw.length > LIMITS.atoms) {
    errors.push(`${prefix}: ${coordsRaw.length} atoms; the limit is ${LIMITS.atoms} per record.`);
  } else {
    coordsRaw.forEach((atom, atomIndex) => {
      if (!atom || typeof atom !== 'object' || Array.isArray(atom)) {
        errors.push(`${prefix}: atom ${atomIndex + 1} must be { element, x, y, z }.`);
        return;
      }
      const element = normalizeElement(atom.element ?? atom.symbol ?? atom.e);
      if (!isElementSymbol(element)) {
        errors.push(`${prefix}: atom ${atomIndex + 1} has an unknown element symbol "${String(atom.element ?? atom.symbol ?? atom.e ?? '')}".`);
        return;
      }
      const x = asNumber(atom.x);
      const y = asNumber(atom.y);
      const z = asNumber(atom.z);
      if (x === null || y === null || z === null
        || Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD || Math.abs(z) > MAX_COORD) {
        errors.push(`${prefix}: atom ${atomIndex + 1} (${element}) has a non-finite or out-of-range coordinate.`);
        return;
      }
      coords.push({ element, x, y, z });
    });
  }

  const charge = raw?.charge === undefined || raw?.charge === null || raw?.charge === '' ? 0 : asInteger(raw.charge);
  if (charge === null || charge < -10 || charge > 10) {
    errors.push(`${prefix}: charge must be an integer between -10 and 10.`);
  }
  const multiplicity = raw?.multiplicity === undefined || raw?.multiplicity === null || raw?.multiplicity === ''
    ? 1 : asInteger(raw.multiplicity);
  if (multiplicity === null || multiplicity < 1 || multiplicity > 10) {
    errors.push(`${prefix}: multiplicity must be an integer between 1 and 10.`);
  }

  if (errors.length > 0) return { record: null, errors, warnings };
  // Issue 139: a record from a drawing says so, so the run gate and the report
  // can describe it without re-reading the file. Anything that states no
  // dimension (every SDF, XYZ, CSV and JSON import) is left unchanged.
  const dimension = raw?.geometry?.dimension === '2d' || raw?.geometry?.dimension === '3d'
    ? raw.geometry.dimension
    : '';
  const bonds = recordBonds(raw?.bonds, coords.length);
  return {
    record: {
      id,
      label: label || id,
      charge,
      multiplicity,
      coords,
      ...(bonds.length ? { bonds } : {}),
      ...(dimension ? { geometry: { dimension } } : {}),
      enabled: raw?.enabled !== false,
    },
    errors,
    warnings,
  };
}

/* ── SDF ──────────────────────────────────────────────────── */

function atomFromMolLine(line) {
  const fixed = {
    x: line.slice(0, 10),
    y: line.slice(10, 20),
    z: line.slice(20, 30),
    element: line.slice(31, 34).trim(),
  };
  if (asNumber(fixed.x) !== null && fixed.element) return fixed;
  const parts = String(line).trim().split(/\s+/);
  if (parts.length < 4) return null;
  return { x: parts[0], y: parts[1], z: parts[2], element: parts[3] };
}

function parseSdfRecord(lines, index) {
  if (/V3000/i.test(lines.slice(0, 8).join('\n'))) {
    return { record: null, errors: [`Record ${index + 1}: V3000 SDF is not supported; save the file as V2000.`], warnings: [] };
  }
  let countsIndex = -1;
  // The counts line is normally line 4 (index 3); the scan starts after the
  // title and program lines so a numeric title cannot be mistaken for it.
  for (let cursor = 2; cursor < Math.min(lines.length, 7); cursor += 1) {
    if (/V2000/i.test(lines[cursor]) || /^\s*\d+\s+\d+/.test(lines[cursor])) {
      countsIndex = cursor;
      break;
    }
  }
  if (countsIndex < 0) {
    return { record: null, errors: [`Record ${index + 1}: no V2000 counts line was found.`], warnings: [] };
  }
  const counts = lines[countsIndex].trim().split(/\s+/);
  const atomCount = asInteger(counts[0]);
  const bondCount = asInteger(counts[1]) ?? 0;
  if (atomCount === null || atomCount <= 0) {
    return { record: null, errors: [`Record ${index + 1}: the counts line declares no atoms.`], warnings: [] };
  }
  if (atomCount > LIMITS.atoms) {
    return {
      record: null,
      errors: [`Record ${index + 1}: ${atomCount} atoms; the limit is ${LIMITS.atoms} per record.`],
      warnings: [],
    };
  }

  const coords = [];
  const errors = [];
  for (let atomIndex = 0; atomIndex < atomCount; atomIndex += 1) {
    const line = lines[countsIndex + 1 + atomIndex];
    if (line === undefined) {
      errors.push(`Record ${index + 1}: the block ends before atom ${atomIndex + 1}.`);
      break;
    }
    const atom = atomFromMolLine(line);
    if (!atom) {
      errors.push(`Record ${index + 1}: atom line ${atomIndex + 1} is malformed.`);
      break;
    }
    coords.push(atom);
  }

  // Formal charges are the one chemistry field an SDF actually states.
  let charge = 0;
  for (let cursor = countsIndex + 1 + atomCount + bondCount; cursor < lines.length; cursor += 1) {
    const match = lines[cursor].match(/^M\s+CHG\s+(.+)$/i);
    if (!match) continue;
    const tokens = match[1].trim().split(/\s+/);
    // `M  CHG  n  atom  charge  atom  charge …`; the first token is the count.
    for (let pair = 1; pair + 1 < tokens.length; pair += 2) {
      const value = asInteger(tokens[pair + 1]);
      if (value !== null) charge += value;
    }
  }

  const built = buildRecord({
    label: lines[0] || '',
    charge,
    multiplicity: 1,
    coords,
  }, index, new Set());
  const allErrors = [...errors, ...built.errors];
  return {
    record: allErrors.length ? null : built.record,
    errors: allErrors,
    warnings: built.warnings,
  };
}

function parseSdf(text) {
  const lines = text.split(/\r\n|\n|\r/);
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (/^\s*\$\$\$\$\s*$/.test(line)) {
      if (current.some((entry) => entry.trim())) blocks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.some((entry) => entry.trim())) blocks.push(current);
  if (blocks.length === 0) {
    return emptyResult('sdf', 'The SDF contains no records (no $$$$ terminator and no V2000 block).');
  }
  if (blocks.length > LIMITS.records) {
    return emptyResult('sdf', `The SDF contains ${blocks.length} records; the limit is ${LIMITS.records}.`);
  }

  const records = [];
  const warnings = [];
  const errors = [];
  const seen = new Set();
  blocks.forEach((block, index) => {
    const parsed = parseSdfRecord(block, index);
    warnings.push(...parsed.warnings);
    errors.push(...parsed.errors);
    if (parsed.record) {
      // Rebuild so ids are unique across records; parseSdfRecord validates.
      const { record, errors: idErrors, warnings: idWarnings } = buildRecord({
        label: parsed.record.label,
        charge: parsed.record.charge,
        multiplicity: parsed.record.multiplicity,
        coords: parsed.record.coords,
      }, index, seen);
      warnings.push(...idWarnings);
      errors.push(...idErrors);
      if (record) records.push(record);
    }
  });
  return { records, format: 'sdf', warnings, errors };
}

/* ── XYZ ──────────────────────────────────────────────────── */

function parseXyz(text) {
  const lines = text.split(/\r\n|\n|\r/);
  const records = [];
  const warnings = [];
  const errors = [];
  const seen = new Set();
  let cursor = 0;
  let frame = 0;
  while (cursor < lines.length) {
    while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
    if (cursor >= lines.length) break;
    if (frame >= LIMITS.records) {
      errors.push(`The file has more than ${LIMITS.records} frames; the limit is ${LIMITS.records}.`);
      break;
    }
    const atomCount = asInteger(lines[cursor]);
    if (atomCount === null || atomCount <= 0) {
      errors.push(`Frame ${frame + 1}: the frame must start with a positive atom count.`);
      break;
    }
    if (atomCount > LIMITS.atoms) {
      errors.push(`Frame ${frame + 1}: ${atomCount} atoms; the limit is ${LIMITS.atoms} per record.`);
      cursor += Math.min(atomCount + 2, lines.length - cursor);
      frame += 1;
      continue;
    }
    if (cursor + atomCount + 1 >= lines.length) {
      errors.push(`Frame ${frame + 1} declares ${atomCount} atoms but the file ends early.`);
      break;
    }
    const label = oneLine(lines[cursor + 1] || '', 200);
    const coords = [];
    let frameError = false;
    for (let atomIndex = 0; atomIndex < atomCount; atomIndex += 1) {
      const line = lines[cursor + 2 + atomIndex];
      const parts = String(line).trim().split(/\s+/);
      if (parts.length < 4) {
        errors.push(`Frame ${frame + 1}: atom line ${atomIndex + 1} needs an element and three coordinates.`);
        frameError = true;
        break;
      }
      coords.push({ element: parts[0], x: parts[1], y: parts[2], z: parts[3] });
    }
    if (frameError) {
      cursor += atomCount + 2;
      frame += 1;
      continue;
    }
    const built = buildRecord({ label, charge: 0, multiplicity: 1, coords }, frame, seen);
    errors.push(...built.errors);
    warnings.push(...built.warnings);
    if (built.record) records.push(built.record);
    cursor += atomCount + 2;
    frame += 1;
  }
  return { records, format: 'xyz', warnings, errors };
}

/* ── CSV ──────────────────────────────────────────────────── */

/** RFC 4180-style field split, enough for quoted labels with commas. */
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((value) => String(value).trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((value) => String(value).trim() !== '')) rows.push(row);
  return rows;
}

function columnIndex(header, names) {
  for (const name of names) {
    const index = header.indexOf(name);
    if (index >= 0) return index;
  }
  return -1;
}

function cell(row, index) {
  return index >= 0 && index < row.length ? row[index] : '';
}

function parseCsv(text) {
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ''));
  if (rows.length === 0) return emptyResult('csv', 'The CSV file is empty.');
  const header = rows[0].map((name) => String(name).trim().toLowerCase().replace(/\s+/g, ''));
  const body = rows.slice(1);
  if (body.length === 0) return emptyResult('csv', 'The CSV has a header but no data rows.');
  if (body.length > LIMITS.records * LIMITS.atoms) {
    return emptyResult('csv', 'The CSV has more rows than a dataset may hold.');
  }

  const repeated = header.some((name) => /^x\d+$/.test(name));
  const records = [];
  const warnings = [];
  const errors = [];
  const seen = new Set();

  if (repeated) {
    const groups = header
      .map((name) => (name.match(/^x(\d+)$/) || [])[1])
      .filter((suffix) => suffix && header.includes(`y${suffix}`) && header.includes(`z${suffix}`))
      .map(Number)
      .sort((a, b) => a - b);
    if (groups.length === 0) {
      return emptyResult('csv', 'The CSV repeats x columns but has no complete xN,yN,zN atom group.');
    }
    const idCol = columnIndex(header, ['id', 'record', 'name']);
    const labelCol = columnIndex(header, ['label', 'title', 'molecule']);
    const chargeCol = columnIndex(header, ['charge', 'q']);
    const multCol = columnIndex(header, ['multiplicity', 'mult', 'spin']);
    body.forEach((row, rowIndex) => {
      const coords = [];
      const rowErrors = [];
      for (const group of groups) {
        const elementCol = columnIndex(header, [`element${group}`, `symbol${group}`, `e${group}`]);
        const element = normalizeElement(cell(row, elementCol));
        if (!element) {
          rowErrors.push(`Record ${rowIndex + 1}: atom ${group} has no element${group}/symbol${group} column.`);
          break;
        }
        coords.push({
          element,
          x: cell(row, header.indexOf(`x${group}`)),
          y: cell(row, header.indexOf(`y${group}`)),
          z: cell(row, header.indexOf(`z${group}`)),
        });
      }
      const built = buildRecord({
        id: cell(row, idCol),
        label: cell(row, labelCol) || cell(row, idCol),
        charge: cell(row, chargeCol),
        multiplicity: cell(row, multCol),
        coords,
      }, rowIndex, seen);
      errors.push(...rowErrors, ...built.errors);
      warnings.push(...built.warnings);
      if (rowErrors.length === 0 && built.record) records.push(built.record);
    });
    return { records, format: 'csv', warnings, errors };
  }

  const xCol = columnIndex(header, ['x']);
  const yCol = columnIndex(header, ['y']);
  const zCol = columnIndex(header, ['z']);
  if (xCol < 0 || yCol < 0 || zCol < 0) {
    return emptyResult('csv', 'The CSV needs either x, y, z columns (one atom per row) or repeated x1, y1, z1,… columns (one record per row).');
  }
  const elementCol = columnIndex(header, ['element', 'symbol', 'e']);
  if (elementCol < 0) {
    return emptyResult('csv', 'The CSV has coordinates but no element column. Add an "element" (or "symbol") column so each atom has a chemical symbol.');
  }
  const idCol = columnIndex(header, ['id', 'record', 'name']);
  const labelCol = columnIndex(header, ['label', 'title', 'molecule']);
  const chargeCol = columnIndex(header, ['charge', 'q']);
  const multCol = columnIndex(header, ['multiplicity', 'mult', 'spin']);
  if (body.length > LIMITS.records * LIMITS.atoms) {
    return emptyResult('csv', 'The CSV has more atom rows than a dataset may hold.');
  }

  // One atom per row: rows sharing an id (or label) belong to one record.
  const order = [];
  const groups = new Map();
  body.forEach((row, rowIndex) => {
    const key = String(cell(row, idCol) || cell(row, labelCol) || 'record-1').trim();
    if (!groups.has(key)) {
      groups.set(key, { rows: [], charge: null, multiplicity: null, label: cell(row, labelCol) || key });
      order.push(key);
    }
    const group = groups.get(key);
    group.rows.push({ row, rowIndex });
    for (const [field, target] of [['charge', 'charge'], ['multiplicity', 'multiplicity']]) {
      const index = field === 'charge' ? chargeCol : multCol;
      const value = asInteger(cell(row, index));
      if (value === null) continue;
      if (group[target] === null) group[target] = value;
      else if (group[target] !== value) {
        warnings.push(`Record "${key}": ${field} differs between atom rows; ${group[target]} is used.`);
      }
    }
  });
  if (order.length > LIMITS.records) {
    return emptyResult('csv', `The CSV describes ${order.length} records; the limit is ${LIMITS.records}.`);
  }

  order.forEach((key, recordIndex) => {
    const group = groups.get(key);
    const coords = group.rows.map(({ row, rowIndex }) => {
      const element = normalizeElement(cell(row, elementCol));
      if (!element) {
        errors.push(`Record ${recordIndex + 1}: atom row ${rowIndex + 2} has no element.`);
      }
      return {
        element,
        x: cell(row, xCol),
        y: cell(row, yCol),
        z: cell(row, zCol),
      };
    });
    const built = buildRecord({
      id: key,
      label: group.label,
      charge: group.charge,
      multiplicity: group.multiplicity,
      coords,
    }, recordIndex, seen);
    errors.push(...built.errors);
    warnings.push(...built.warnings);
    if (built.record) records.push(built.record);
  });

  return { records, format: 'csv', warnings, errors };
}

/* ── JSON ─────────────────────────────────────────────────── */

function parseJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    return emptyResult('json', `The JSON could not be parsed: ${error.message}`);
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.records) ? parsed.records
      : Array.isArray(parsed?.dataset?.records) ? parsed.dataset.records
        : null;
  if (!list) {
    return emptyResult('json', 'A JSON dataset must be an array of records, or an object with a "records" array.');
  }
  if (list.length === 0) return emptyResult('json', 'The JSON records array is empty.');
  if (list.length > LIMITS.records) {
    return emptyResult('json', `The JSON contains ${list.length} records; the limit is ${LIMITS.records}.`);
  }

  const records = [];
  const warnings = [];
  const errors = [];
  const seen = new Set();
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`Record ${index + 1}: must be an object.`);
      return;
    }
    const built = buildRecord(entry, index, seen);
    errors.push(...built.errors);
    warnings.push(...built.warnings);
    if (built.record) records.push(built.record);
  });
  return { records, format: 'json', warnings, errors };
}

/* ── CDXML ────────────────────────────────────────────────── */

/**
 * A ChemDraw drawing as a dataset (issue 139).
 *
 * The drawing is read by the structure reader that already exists (`parseStructureRecords`
 * → `cdxml.js`), not by a second parser: one `<fragment>` becomes one record, in
 * document order, so a salt or a host–guest drawing imports as several records
 * instead of one merged molecule.
 *
 * Each record is labelled from the fragment's own text — its `Name` attribute,
 * or a text block drawn beside it — and from its **index** (`fragment 2`) only
 * when the drawing gave it none: a caption position is not a name, and inventing
 * one would make two drawings of the same scheme look like the same records.
 * Two fragments drawn with the same text keep that same label, and their ids are
 * made unique with a numeric suffix (`ligand`, `ligand-2`) — the label is what the
 * user drew, the id is what a task id has to be.
 *
 * Every record carries `geometry.dimension = '2d'`: page coordinates with z = 0,
 * a depiction. The run gate refuses such a record in a flow whose first block is
 * a frequency or a single point unless the user confirms it.
 */
function parseCdxml(text, filename) {
  let parsed;
  try {
    parsed = parseStructureRecords(text, { filename });
  } catch (error) {
    return emptyResult('cdxml', error.message);
  }
  if (parsed.format !== 'cdxml') {
    return emptyResult('cdxml', 'This file is not a CDXML drawing: no <CDXML> root element was found.');
  }
  if (parsed.records.length > LIMITS.records) {
    return emptyResult('cdxml', `The drawing contains ${parsed.records.length} fragments; the limit is ${LIMITS.records}.`);
  }

  const records = [];
  const warnings = [];
  const errors = [];
  const seen = new Set();
  parsed.records.forEach((entry, index) => {
    if (entry?.error) {
      // The reader already names the fragment ("Fragment 2: …"); one unreadable
      // fragment does not hide the ones that could be read.
      errors.push(entry.error);
      return;
    }
    const own = oneLine(entry.fragmentLabel || '', 200);
    const built = buildRecord({
      label: own || `fragment ${index + 1}`,
      charge: entry.charge,
      multiplicity: entry.multiplicity,
      coords: entry.atoms,
      bonds: entry.bonds,
      geometry: entry.geometry,
    }, index, seen);
    errors.push(...built.errors);
    for (const message of [...(entry.warnings || []), ...built.warnings]) {
      // The reader emits the same "this is a 2D drawing" note per fragment; one
      // copy is the statement, 660 copies are noise.
      if (!warnings.includes(message)) warnings.push(message);
    }
    if (built.record) records.push(built.record);
  });

  if (records.length === 0 && errors.length === 0) {
    errors.push('The CDXML contains no fragment with coordinates.');
  }
  return { records, format: 'cdxml', warnings, errors };
}

/* ── Format detection and public API ──────────────────────── */

function resolvedFormat(text, format, filename) {
  const explicit = String(format || '').trim().toLowerCase();
  if (explicit) return FORMATS.includes(explicit) ? explicit : '';
  const extension = String(filename || '').toLowerCase().split('.').pop();
  if (extension === 'cdxml') return 'cdxml';
  if (extension === 'sdf' || extension === 'sd' || extension === 'mol') return 'sdf';
  if (extension === 'xyz' || extension === 'trj') return 'xyz';
  if (extension === 'csv') return 'csv';
  if (extension === 'json') return 'json';

  const trimmed = text.trim();
  // A drawing may be pasted under any name; the root element is unambiguous and
  // is checked before the JSON/SDF tests so an XML declaration cannot be misread.
  if (/<cdxml[\s>/]/i.test(text.slice(0, 20000))) return 'cdxml';
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return 'json';
  if (text.includes('$$$$') || /V2000|V3000/.test(text)) return 'sdf';
  const lines = trimmed.split(/\r\n|\n|\r/);
  const first = lines[0] || '';
  if (first.includes(',') && /(^|,)\s*(x|element|label|id|charge)\s*(,|$)/i.test(first)) return 'csv';
  if (/^\s*\d+\s*$/.test(first) && lines.length > 2) return 'xyz';
  return '';
}

/**
 * Parse a dataset file into records.
 *
 * @param {string} text
 * @param {{format?: string, filename?: string}} [options]
 * @returns {{records: Array<object>, format: string, warnings: string[], errors: string[]}}
 */
export function parseDataset(text, { format = '', filename = '' } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    return emptyResult('', 'The dataset file is empty.');
  }
  const resolved = resolvedFormat(text, format, filename);
  if (!resolved) {
    return emptyResult('', 'Could not tell the dataset format. Use .sdf, .xyz, .csv, .json or .cdxml, or choose the format explicitly.');
  }

  let result;
  if (resolved === 'sdf') result = parseSdf(text);
  else if (resolved === 'xyz') result = parseXyz(text);
  else if (resolved === 'csv') result = parseCsv(text);
  else if (resolved === 'cdxml') result = parseCdxml(text, filename);
  else result = parseJson(text);

  if (result.records.length > LIMITS.records) {
    return emptyResult(resolved, `The file contains ${result.records.length} records; the limit is ${LIMITS.records}.`);
  }
  if (result.records.length === 0 && result.errors.length === 0) {
    result.errors.push('No record with coordinates was found. A dataset record needs at least one atom.');
  }
  return { ...result, format: resolved };
}
