/**
 * ChemDraw binary .cdx reader (#221).
 *
 * The binary format is a tagged stream: a 22-byte header, a document object,
 * then nested objects and properties until two zero bytes close each object.
 * This reader walks that stream directly and returns the same record shape as
 * `cdxml.js`, so the two forms of one drawing become the same atoms and bonds
 * rather than two parsers that happen to agree on the easy cases.
 *
 * Scope is deliberately a **drawing import**, not a general CDX converter:
 * atoms, bonds, charge, isotope, fragment names and wedge/hash cues. Node
 * types, bond orders and malformed streams that this reader cannot reduce
 * without guessing are refused by name. The coordinates are page units,
 * y up, z = 0 — the document is a depiction, never a computed geometry.
 */

import { isElementSymbol } from './elements.js';

const HEADER_LENGTH = 22;
const MAGIC = 'VjCD0100';
const MAX_ATOMS = 20000;
const MAX_DEPTH = 64;

const TAG_OBJECT = 0x8000;
const OBJ_DOCUMENT = 0x8000;
const OBJ_PAGE = 0x8001;
const OBJ_FRAGMENT = 0x8003;
const OBJ_NODE = 0x8004;
const OBJ_BOND = 0x8005;

const PROP_NAME = 0x0008;
const PROP_2D_POSITION = 0x0200;
const PROP_NODE_TYPE = 0x0400;
const PROP_ELEMENT = 0x0402;
const PROP_ISOTOPE = 0x0420;
const PROP_CHARGE = 0x0421;
const PROP_BOND_ORDER = 0x0600;
const PROP_BOND_DISPLAY = 0x0601;
const PROP_BOND_BEGIN = 0x0604;
const PROP_BOND_END = 0x0605;

const ATOMIC_SYMBOL = new Map([
  ['H', 1], ['He', 2], ['Li', 3], ['Be', 4], ['B', 5], ['C', 6], ['N', 7],
  ['O', 8], ['F', 9], ['Ne', 10], ['Na', 11], ['Mg', 12], ['Al', 13], ['Si', 14],
  ['P', 15], ['S', 16], ['Cl', 17], ['Ar', 18], ['K', 19], ['Ca', 20],
  ['Sc', 21], ['Ti', 22], ['V', 23], ['Cr', 24], ['Mn', 25], ['Fe', 26],
  ['Co', 27], ['Ni', 28], ['Cu', 29], ['Zn', 30], ['Ga', 31], ['Ge', 32],
  ['As', 33], ['Se', 34], ['Br', 35], ['Kr', 36], ['Rb', 37], ['Sr', 38],
  ['Y', 39], ['Zr', 40], ['Nb', 41], ['Mo', 42], ['Tc', 43], ['Ru', 44],
  ['Rh', 45], ['Pd', 46], ['Ag', 47], ['Cd', 48], ['In', 49], ['Sn', 50],
  ['Sb', 51], ['Te', 52], ['I', 53], ['Xe', 54], ['Cs', 55], ['Ba', 56],
  ['La', 57], ['Ce', 58], ['Pr', 59], ['Nd', 60], ['Pm', 61], ['Sm', 62],
  ['Eu', 63], ['Gd', 64], ['Tb', 65], ['Dy', 66], ['Ho', 67], ['Er', 68],
  ['Tm', 69], ['Yb', 70], ['Lu', 71], ['Hf', 72], ['Ta', 73], ['W', 74],
  ['Re', 75], ['Os', 76], ['Ir', 77], ['Pt', 78], ['Au', 79], ['Hg', 80],
  ['Tl', 81], ['Pb', 82], ['Bi', 83], ['Po', 84], ['At', 85], ['Rn', 86],
  ['Fr', 87], ['Ra', 88], ['Ac', 89], ['Th', 90], ['Pa', 91], ['U', 92],
  ['Np', 93], ['Pu', 94], ['Am', 95], ['Cm', 96], ['Bk', 97], ['Cf', 98],
  ['Es', 99], ['Fm', 100], ['Md', 101], ['No', 102], ['Lr', 103], ['Rf', 104],
  ['Db', 105], ['Sg', 106], ['Bh', 107], ['Hs', 108], ['Mt', 109], ['Ds', 110],
  ['Rg', 111], ['Cn', 112], ['Nh', 113], ['Fl', 114], ['Mc', 115], ['Lv', 116],
  ['Ts', 117], ['Og', 118],
].map(([symbol, number]) => [number, symbol]));

export class CdxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CdxError';
  }
}

function bytesOf(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

export function isCdxDocument(input) {
  const bytes = bytesOf(input);
  if (!bytes || bytes.length < HEADER_LENGTH) return false;
  return MAGIC.split('').every((char, index) => bytes[index] === char.charCodeAt(0));
}

/** One stream cursor; every read is bounds-checked so a truncated file refuses. */
class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  need(count) {
    if (this.offset + count > this.bytes.length) {
      throw new CdxError(`The CDX ends at byte ${this.bytes.length}, inside a tag or value; the file is truncated.`);
    }
  }

  u8() {
    this.need(1);
    return this.bytes[this.offset++];
  }

  i8() {
    this.need(1);
    const value = this.bytes[this.offset];
    this.offset += 1;
    return value < 0x80 ? value : value - 0x100;
  }

  u16() {
    this.need(2);
    const value = this.bytes[this.offset] | (this.bytes[this.offset + 1] << 8);
    this.offset += 2;
    return value;
  }

  i16() {
    const value = this.u16();
    return value < 0x8000 ? value : value - 0x10000;
  }

  u32() {
    this.need(4);
    const value = (this.bytes[this.offset]
      | (this.bytes[this.offset + 1] << 8)
      | (this.bytes[this.offset + 2] << 16)
      | (this.bytes[this.offset + 3] << 24)) >>> 0;
    this.offset += 4;
    return value;
  }

  i32() {
    const value = this.u32();
    return value >= 0x80000000 ? value - 0x100000000 : value;
  }

  take(count) {
    this.need(count);
    const value = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return value;
  }
}

function readHeader(reader) {
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (reader.u8() !== MAGIC.charCodeAt(index)) {
      throw new CdxError('This is not a ChemDraw .cdx file: the eight-byte "VjCD0100" header is missing.');
    }
  }
  // Four signature bytes then ten reserved zero bytes in the revisions this
  // reader has seen; the specification describes a longer reserved area, so
  // only the documented signature is required here.
  reader.take(4);
  reader.take(10);
}

function readProperty(reader, tag) {
  let length = reader.u16();
  if (length === 0xffff) length = reader.u32();
  return { tag, data: reader.take(length) };
}

function readObjectBody(reader, tag, depth) {
  if (depth > MAX_DEPTH) throw new CdxError(`The CDX object nesting is deeper than ${MAX_DEPTH} levels.`);
  const id = reader.u32();
  const properties = new Map();
  const children = [];
  for (;;) {
    const next = reader.u16();
    if (next === 0) break;
    if ((next & TAG_OBJECT) !== 0) {
      children.push(readObjectBody(reader, next, depth + 1));
    } else {
      const property = readProperty(reader, next);
      properties.set(property.tag, property.data);
    }
  }
  return { tag, id, properties, children };
}

function readDocument(bytes) {
  const reader = new Reader(bytes);
  readHeader(reader);
  const tag = reader.u16();
  if (tag !== OBJ_DOCUMENT) {
    throw new CdxError('This .cdx uses the legacy document header; this reader only reads the modern '
      + 'document object, because the legacy layout is not documented well enough to parse without guessing.');
  }
  return readObjectBody(reader, tag, 0);
}

function descendants(object, tag, out = [], stopAtFragment = false) {
  for (const child of object.children) {
    if (child.tag === tag) out.push(child);
    if (stopAtFragment && child.tag === OBJ_FRAGMENT) continue;
    descendants(child, tag, out, stopAtFragment);
  }
  return out;
}

function allFragments(object) {
  return descendants(object, OBJ_FRAGMENT);
}

function u16Value(property) {
  if (!property || property.length < 2) return null;
  return property[0] | (property[1] << 8);
}

function i16Value(property) {
  const value = u16Value(property);
  return value === null ? null : (value < 0x8000 ? value : value - 0x10000);
}

function u32Value(property) {
  if (!property || property.length < 4) return null;
  return (property[0] | (property[1] << 8) | (property[2] << 16) | (property[3] << 24)) >>> 0;
}

function stringValue(property) {
  if (!property || property.length <= 2) return '';
  // CDXString starts with the number of style runs. A name written by ChemDraw
  // has none, so the bytes after that word are the text. A styled string would
  // need the font table, and this reader does not pretend to have it.
  const styleRuns = property[0] | (property[1] << 8);
  if (styleRuns !== 0) return '';
  let text = '';
  for (let index = 2; index < property.length; index += 1) {
    if (property[index] !== 0) text += String.fromCharCode(property[index]);
  }
  return text.trim();
}

function elementSymbol(number) {
  if (!number || number === 0) return 'C';
  const symbol = ATOMIC_SYMBOL.get(number);
  if (!symbol || !isElementSymbol(symbol)) return null;
  return symbol;
}

function bondOrder(property) {
  const raw = u16Value(property);
  if (raw === null) return { order: 1, aromatic: false };
  if (raw === 0x0001) return { order: 1, aromatic: false };
  if (raw === 0x0002) return { order: 2, aromatic: false };
  if (raw === 0x0004) return { order: 3, aromatic: false };
  if (raw === 0x0080) return { order: 1.5, aromatic: true };
  throw new CdxError(`bond order 0x${raw.toString(16)} is outside the bond orders this reader understands `
    + '(single, double, triple, aromatic).');
}

function bondCue(property) {
  const display = i16Value(property);
  if (display === 3) return { kind: 'hash', narrowEnd: 'begin' };
  if (display === 4) return { kind: 'hash', narrowEnd: 'end' };
  if (display === 6) return { kind: 'wedge', narrowEnd: 'begin' };
  if (display === 7) return { kind: 'wedge', narrowEnd: 'end' };
  return null;
}

function parseFragment(fragment, index, context) {
  const nodes = descendants(fragment, OBJ_NODE, [], true);
  if (nodes.length === 0) throw new CdxError('the fragment contains no node objects.');

  const atoms = [];
  const byId = new Map();
  const warnings = [];
  let totalCharge = 0;

  nodes.forEach((node, position) => {
    if (byId.has(node.id)) throw new CdxError(`node id ${node.id} appears twice in the fragment.`);
    const positionProperty = node.properties.get(PROP_2D_POSITION);
    if (!positionProperty || positionProperty.length < 8) {
      throw new CdxError(`node ${node.id} has no readable 2D position.`);
    }
    // CDX stores the pair as (vertical, horizontal), both signed 32-bit
    // 1/65536 page units. CDXML states the same point as "x y".
    const vertical = (positionProperty[0] | (positionProperty[1] << 8)
      | (positionProperty[2] << 16) | (positionProperty[3] << 24)) | 0;
    const horizontal = (positionProperty[4] | (positionProperty[5] << 8)
      | (positionProperty[6] << 16) | (positionProperty[7] << 24)) | 0;
    const x = horizontal / 65536;
    const y = vertical / 65536;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new CdxError(`node ${node.id} has a non-finite position.`);
    }

    const nodeType = u16Value(node.properties.get(PROP_NODE_TYPE));
    if (nodeType !== null && nodeType !== 0 && nodeType !== 1) {
      throw new CdxError(`node ${node.id} is a CDX node type ${nodeType}; this reader imports element nodes only.`);
    }
    const elementNumber = i16Value(node.properties.get(PROP_ELEMENT));
    const element = elementSymbol(elementNumber);
    if (!element) {
      throw new CdxError(`node ${node.id} declares atomic number ${elementNumber}, which is not a known element.`);
    }

    const charge = node.properties.has(PROP_CHARGE) ? node.properties.get(PROP_CHARGE)[0] : 0;
    const signedCharge = charge === undefined ? 0 : (charge < 0x80 ? charge : charge - 0x100);
    totalCharge += signedCharge;
    const isotope = i16Value(node.properties.get(PROP_ISOTOPE));
    byId.set(node.id, atoms.length + 1);
    atoms.push({
      element,
      x,
      y,
      z: 0,
      ...(isotope && isotope > 0 ? { isotope } : {}),
    });
  });

  const bonds = [];
  let aromatic = 0;
  let cues = 0;
  for (const bond of descendants(fragment, OBJ_BOND, [], true)) {
    const begin = u32Value(bond.properties.get(PROP_BOND_BEGIN));
    const end = u32Value(bond.properties.get(PROP_BOND_END));
    if (begin === null || end === null) {
      throw new CdxError(`bond ${bond.id} is missing its begin or end node.`);
    }
    const resolve = (id) => {
      if (byId.has(id)) return byId.get(id);
      if (context.owner.has(id)) {
        throw new CdxError(`bond ${bond.id} connects node ${begin} to node ${end}, but node ${id} belongs to `
          + `fragment ${context.owner.get(id) + 1}; a bond may not leave its fragment.`);
      }
      return null;
    };
    const a = resolve(begin);
    const b = resolve(end);
    if (a === null) throw new CdxError(`bond ${bond.id} points at node ${begin}, which is not in this fragment.`);
    if (b === null) throw new CdxError(`bond ${bond.id} points at node ${end}, which is not in this fragment.`);
    if (a === b) throw new CdxError(`bond ${bond.id} joins node ${begin} to itself.`);
    const parsed = bondOrder(bond.properties.get(PROP_BOND_ORDER));
    if (parsed.aromatic) aromatic += 1;
    const record = { a, b, order: parsed.order };
    const cue = bondCue(bond.properties.get(PROP_BOND_DISPLAY));
    if (cue) {
      record.stereo = { kind: cue.kind, narrowEnd: cue.narrowEnd === 'begin' ? a : b };
      cues += 1;
    }
    bonds.push(record);
  }

  const label = stringValue(fragment.properties.get(PROP_NAME));
  const fallback = context.fragmentCount === 1 ? context.documentName : '';
  const name = label || fallback || `${context.documentName || context.baseName || 'CDX'} fragment ${index + 1}`;
  if (aromatic > 0) warnings.push(`${aromatic} aromatic bond${aromatic === 1 ? '' : 's'} kept as order 1.5.`);
  if (cues > 0) {
    warnings.push(`${cues} wedge/hash bond${cues === 1 ? '' : 's'} recorded as a 2D drawing cue (narrow end stated); `
      + 'no R/S assignment is made.');
  }
  warnings.push('Coordinates are the 2D ChemDraw drawing (page units, y up, z = 0). This is a depiction, not a computed 3D structure.');

  return {
    atoms,
    bonds,
    charge: totalCharge,
    multiplicity: 1,
    name,
    fragmentLabel: label,
    warnings,
    geometry: {
      dimension: '2d',
      source: 'cdx-drawing',
      note: 'Page coordinates from the ChemDraw binary drawing (y up), z = 0. A drawing, never a computed structure.',
    },
  };
}

/**
 * Every fragment of a CDX document, in document order.
 *
 * Returns `{record}` or `{error}` entries. A fragment-local problem refuses
 * that fragment and leaves the rest readable, matching the CDXML reader.
 */
export function parseCdxRecords(input, { name = '' } = {}) {
  const bytes = bytesOf(input);
  if (!bytes) throw new CdxError('The CDX reader needs the file bytes, not a decoded string.');
  if (!isCdxDocument(bytes)) {
    throw new CdxError('This is not a ChemDraw .cdx file: the eight-byte "VjCD0100" header is missing.');
  }
  const document = readDocument(bytes);
  const fragments = allFragments(document);
  if (fragments.length === 0) {
    throw new CdxError('The CDX contains no fragment, so there is no structure to import.');
  }
  const documentName = stringValue(document.properties.get(PROP_NAME));
  const baseName = String(name || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  const owner = new Map();
  fragments.forEach((fragment, index) => {
    for (const node of descendants(fragment, OBJ_NODE, [], true)) {
      if (!owner.has(node.id)) owner.set(node.id, index);
    }
  });
  const context = { owner, fragmentCount: fragments.length, documentName, baseName };
  return fragments.map((fragment, index) => {
    try {
      return parseFragment(fragment, index, context);
    } catch (error) {
      return { error: `Fragment ${index + 1}: ${error.message}` };
    }
  });
}
