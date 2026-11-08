/**
 * CDXML (ChemDraw XML) reader (#120).
 *
 * CDXML is the documented XML form ChemDraw writes. A ChemDraw document is a
 * **2D drawing**, so this reader returns atoms as `{element, x, y, z: 0}` from
 * the page coordinates (y up, as CDXML states them) and says so on every
 * record: `geometry.dimension = '2d'`. It is a depiction, never a geometry a
 * calculation may start from.
 *
 * What is read, and in the document's own terms:
 * - `<fragment>` — one record per fragment, so a salt or a host–guest drawing
 *   imports as several records instead of one merged molecule.
 * - `<n p="x y">` — one atom. The element comes from the `<t>` label inside
 *   the node (`O`, `N`, `Cl`, `Na`, charged forms `N+`, `O-`, `NH4+`), then
 *   from an explicit `Element=` atomic number; an unlabelled node is carbon.
 *   A label that cannot be reduced to one element is refused **by name**.
 * - `<b B="…" E="…" Order="…">` — a bond. `Order="1.5"` stays aromatic (it is
 *   not rounded to single); any other order is refused by name. A bond whose
 *   `B`/`E` is not a node of its own fragment is refused.
 * - `Display="WedgeBegin|WedgeEnd|WedgedHashBegin|WedgedHashEnd"` — the narrow
 *   end is recorded as a tetrahedral **drawing cue**. No R/S is assigned, and
 *   nothing is inferred from it.
 * - `<fonttable>`, `<colortable>` are metadata and are skipped. Other page or
 *   fragment children (arrows, curves, TLC plates, schemes, text blocks) are
 *   counted and named in a warning rather than dropped in silence.
 *
 * No XML package is used: the format is regular enough for the small
 * tokenizer below, which does not validate, only reads.
 */

import { ELEMENTS, isElementSymbol } from './elements.js';

const MAX_NODES = 20000;

const ATOMIC_SYMBOL = new Map([...ELEMENTS].map(([symbol, number]) => [number, symbol]));

export class CdxmlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CdxmlError';
  }
}

/* ── XML tokenizer ────────────────────────────────────────── */

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(value) {
  return String(value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code)) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/** `cdxml:n` → `n`, so a namespace prefix never hides an element. */
function localName(name) {
  const text = String(name ?? '');
  const colon = text.indexOf(':');
  return (colon < 0 ? text : text.slice(colon + 1)).toLowerCase();
}

function findTagEnd(text, start) {
  let quote = '';
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return index;
  }
  return -1;
}

function parseAttributes(text) {
  const attributes = {};
  const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match = pattern.exec(text);
  while (match) {
    attributes[localName(match[1])] = decodeEntities(match[2] ?? match[3] ?? '');
    match = pattern.exec(text);
  }
  return attributes;
}

/**
 * A tolerant element tree: every node keeps an ordered `content` list of text
 * runs and child nodes, so `<t><s>NH</s><s>4</s><s>+</s></t>` reads as `NH4+`.
 */
function parseXml(text) {
  const document = { name: '#document', attributes: {}, content: [] };
  const stack = [document];
  const top = () => stack[stack.length - 1];
  let index = 0;
  let nodeCount = 0;

  while (index < text.length) {
    const open = text.indexOf('<', index);
    if (open < 0) {
      if (index < text.length) top().content.push(text.slice(index));
      break;
    }
    if (open > index) top().content.push(text.slice(index, open));

    if (text.startsWith('<?', open)) {
      const end = text.indexOf('?>', open + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      index = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open + 9);
      top().content.push(text.slice(open + 9, end < 0 ? text.length : end));
      index = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<!', open)) {
      // DOCTYPE, with an optional internal subset in brackets.
      let end = text.indexOf('>', open + 2);
      if (end < 0) break;
      const bracket = text.indexOf('[', open);
      if (bracket >= 0 && bracket < end) {
        const closeBracket = text.indexOf(']', bracket);
        const after = text.indexOf('>', closeBracket < 0 ? end : closeBracket);
        if (after >= 0) end = after;
      }
      index = end + 1;
      continue;
    }

    const close = findTagEnd(text, open);
    if (close < 0) throw new CdxmlError('The CDXML is not well-formed: a tag is never closed.');
    const raw = text.slice(open + 1, close).trim();
    const closing = raw.startsWith('/');
    const selfClosing = !closing && raw.endsWith('/');
    const body = raw.slice(closing ? 1 : 0, selfClosing ? raw.length - 1 : raw.length).trim();

    if (body) {
      const space = body.search(/\s/);
      const name = space < 0 ? body : body.slice(0, space);
      if (closing) {
        const tag = localName(name);
        let depth = stack.length - 1;
        while (depth > 0 && localName(stack[depth].name) !== tag) depth -= 1;
        if (depth > 0) stack.length = depth;
      } else {
        nodeCount += 1;
        if (nodeCount > MAX_NODES) {
          throw new CdxmlError(`The CDXML has more than ${MAX_NODES} elements, which is far beyond any drawing this reader imports.`);
        }
        const node = { name, attributes: space < 0 ? {} : parseAttributes(body.slice(space + 1)), content: [] };
        top().content.push(node);
        if (!selfClosing) stack.push(node);
      }
    }
    index = close + 1;
  }

  return document;
}

function elementChildren(node) {
  return node.content.filter((part) => typeof part !== 'string');
}

function childrenNamed(node, tag) {
  return elementChildren(node).filter((child) => localName(child.name) === tag);
}

function firstChildNamed(node, tag) {
  return elementChildren(node).find((child) => localName(child.name) === tag) ?? null;
}

/** Every `<n>` (or `<b>`) in a fragment, without descending into a nested fragment. */
function descendantsNamed(node, tag, out = []) {
  for (const child of elementChildren(node)) {
    const name = localName(child.name);
    if (name === 'fragment') continue;
    if (name === tag) out.push(child);
    else descendantsNamed(child, tag, out);
  }
  return out;
}

function textOf(node) {
  if (!node) return '';
  return node.content
    .map((part) => (typeof part === 'string' ? part : textOf(part)))
    .join('');
}

function collapse(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function number(value) {
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** `p="100.0 120.5"` → `{x, y}`; CDXML page units, y up. */
function point(value) {
  const parts = String(value ?? '').trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length < 2) return null;
  const x = number(parts[0]);
  const y = number(parts[1]);
  return x === null || y === null ? null : { x, y };
}

/* ── Labels ───────────────────────────────────────────────── */

/**
 * A ChemDraw atom label is one element plus optional hydrogens, isotope and
 * charge: `N`, `O`, `Cl`, `Na`, `N+`, `O-`, `NH4+`, `13C`, `D`. Anything else
 * (`CO2H`, `SO3H`, a stray word) is refused by name: guessing would either
 * invent an element or silently turn an oxygen label into carbon.
 */
function chargeSuffix(value) {
  const text = String(value ?? '').trim();
  if (!text) return 0;
  if (/^\++$/.test(text)) return text.length;
  if (/^-+$/.test(text)) return -text.length;
  const after = text.match(/^([+-])(\d+)$/);
  if (after) return (after[1] === '+' ? 1 : -1) * Number(after[2]);
  const before = text.match(/^(\d+)([+-])$/);
  if (before) return (before[2] === '+' ? 1 : -1) * Number(before[1]);
  return null;
}

function parseLabel(value) {
  const label = collapse(value);
  if (!label) return null;
  if (label === 'D') return { element: 'H', isotope: 2, charge: 0, hydrogens: 0 };
  if (label === 'T') return { element: 'H', isotope: 3, charge: 0, hydrogens: 0 };

  const match = label.match(/^(\d*)([A-Z][a-z]?)(?:H(\d*))?(.*)$/);
  if (!match) return null;
  const [, digits, symbol, hydrogenDigits, rest] = match;
  const charge = chargeSuffix(rest);
  if (charge === null || !isElementSymbol(symbol)) return null;
  const isotope = digits ? Number(digits) : 0;
  const hydrogens = hydrogenDigits === undefined
    ? 0
    : (hydrogenDigits === '' ? 1 : Number(hydrogenDigits));
  return {
    element: symbol,
    isotope: Number.isInteger(isotope) && isotope > 0 && isotope < 300 ? isotope : 0,
    charge,
    // Hydrogens in a label are implicit in the drawing; they are counted here
    // only so the label can be read, never added as atoms.
    hydrogens,
  };
}

/** `Element="8"` or `Element="O"` → the symbol, or '' when useless. */
function elementFromAttribute(value) {
  const text = collapse(value);
  if (!text) return '';
  if (/^\d+$/.test(text)) return ATOMIC_SYMBOL.get(Number(text)) ?? '';
  return isElementSymbol(text) ? text : '';
}

/* ── Fragment → record ────────────────────────────────────── */

const CHEMISTRY_TAGS = new Set(['fragment', 'n', 'b', 't']);
const STRUCTURAL_TAGS = new Set(['page', 'fonttable', 'colortable', 'cdxml']);

/** Counts element types this reader does not read, so the import can name them. */
function countIgnored(node, counts) {
  for (const child of elementChildren(node)) {
    const tag = localName(child.name);
    if (CHEMISTRY_TAGS.has(tag) || STRUCTURAL_TAGS.has(tag)) continue;
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
}

function ignoredSummary(counts) {
  if (counts.size === 0) return '';
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => `${tag} (${count})`);
  return `Ignored non-molecule element${parts.length === 1 ? '' : 's'} in the drawing: ${parts.join(', ')}.`;
}

function childLabel(node) {
  for (const child of elementChildren(node)) {
    if (localName(child.name) !== 't') continue;
    // ChemDraw styles a label as `<s>` runs (`N`, `+`, a superscript `4`), and
    // the whitespace between those tags is formatting, not part of the label.
    const runs = childrenNamed(child, 's');
    const text = runs.length > 0
      ? runs.map((run) => collapse(textOf(run))).join('')
      : collapse(textOf(child));
    if (text) return text;
  }
  return '';
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const DISPLAY_CUES = {
  wedgebegin: { kind: 'wedge', narrowEnd: 'begin' },
  wedgeend: { kind: 'wedge', narrowEnd: 'end' },
  wedgedhashbegin: { kind: 'hash', narrowEnd: 'begin' },
  wedgedhashend: { kind: 'hash', narrowEnd: 'end' },
};

const BOND_ORDERS = new Map([['1', 1], ['2', 2], ['3', 3], ['1.5', 1.5]]);

/**
 * One `<fragment>` → one raw record in the shape `finalize()` accepts. A
 * problem local to this fragment (an unreadable label, a bond leaving the
 * fragment) refuses this fragment and leaves the rest of the document
 * importable, because a drawing may hold several independent structures.
 */
function parseFragment(fragment, index, context) {
  const nodeElements = descendantsNamed(fragment, 'n');
  if (nodeElements.length === 0) throw new CdxmlError('the fragment contains no <n> nodes.');

  const atoms = [];
  const byId = new Map();
  const warnings = [];
  let totalCharge = 0;

  nodeElements.forEach((element, position) => {
    const id = collapse(element.attributes.id);
    if (!id) throw new CdxmlError(`node ${position + 1} has no id attribute, and bonds address nodes by id.`);
    if (byId.has(id)) throw new CdxmlError(`node id "${id}" appears twice in the fragment.`);
    const coordinates = point(element.attributes.p);
    if (!coordinates) throw new CdxmlError(`node "${id}" has no readable p="x y" coordinate.`);

    const label = childLabel(element);
    let parsed = null;
    if (label) {
      parsed = parseLabel(label);
      if (!parsed) {
        throw new CdxmlError(`node "${id}" is labelled "${label}", which this reader cannot reduce to one element. `
          + 'CDXML atom labels must be a single element with an optional charge (O, N+, Cl, Na+, NH4+); '
          + 'groups such as CO2H or SO3H are not expanded.');
      }
    }

    const declaredElement = elementFromAttribute(element.attributes.element);
    const elementSymbol = parsed ? parsed.element : (declaredElement || 'C');
    if (!isElementSymbol(elementSymbol)) {
      throw new CdxmlError(`node "${id}" declares Element="${collapse(element.attributes.element)}", which is not a known element.`);
    }
    if (parsed && declaredElement && declaredElement !== parsed.element) {
      warnings.push(`Node "${id}" is labelled "${label}" but declares Element="${collapse(element.attributes.element)}"; the label wins.`.trim());
    }

    const attributeCharge = Number.isInteger(Number(collapse(element.attributes.charge)))
      ? Number(collapse(element.attributes.charge))
      : 0;
    const labelCharge = parsed?.charge ?? 0;
    const charge = labelCharge || attributeCharge;
    if (labelCharge && attributeCharge && labelCharge !== attributeCharge) {
      warnings.push(`Node "${id}" states charge ${attributeCharge} but its label gives ${labelCharge}; the label wins.`);
    }
    totalCharge += charge;

    const attributeIsotope = Number.parseInt(collapse(element.attributes.isotope), 10);
    const isotope = parsed?.isotope || (Number.isInteger(attributeIsotope) ? attributeIsotope : 0);

    byId.set(id, atoms.length + 1);
    atoms.push({
      element: elementSymbol,
      x: coordinates.x,
      y: coordinates.y,
      z: 0,
      ...(isotope > 0 ? { isotope } : {}),
    });
  });

  const bonds = [];
  let aromatic = 0;
  let cues = 0;

  descendantsNamed(fragment, 'b').forEach((element) => {
    const rawA = collapse(element.attributes.b);
    const rawB = collapse(element.attributes.e);
    const bondId = collapse(element.attributes.id) || '?';
    if (!rawA || !rawB) throw new CdxmlError(`bond "${bondId}" is missing its B or E endpoint.`);

    const resolve = (id) => {
      if (byId.has(id)) return byId.get(id);
      if (context.owner.has(id)) {
        throw new CdxmlError(`bond "${bondId}" connects node "${rawA}" to node "${rawB}", `
          + `but node "${id}" belongs to fragment ${context.owner.get(id) + 1}; a bond may not leave its fragment.`);
      }
      return null;
    };
    const a = resolve(rawA);
    const b = resolve(rawB);
    if (a === null) throw new CdxmlError(`bond "${bondId}" points at node "${rawA}", which is not a node of this fragment.`);
    if (b === null) throw new CdxmlError(`bond "${bondId}" points at node "${rawB}", which is not a node of this fragment.`);
    if (a === b) throw new CdxmlError(`bond "${bondId}" joins node "${rawA}" to itself.`);

    const rawOrder = collapse(element.attributes.order) || '1';
    const order = BOND_ORDERS.get(rawOrder);
    if (order === undefined) {
      throw new CdxmlError(`bond "${bondId}" states Order="${rawOrder}"; this reader understands 1, 2, 3 and 1.5 (aromatic).`);
    }
    if (order === 1.5) aromatic += 1;

    const bond = { a, b, order };
    const display = collapse(element.attributes.display).toLowerCase();
    const cue = DISPLAY_CUES[display];
    if (cue) {
      // `WedgeBegin` means the narrow end sits on the Begin atom. That is all
      // the file states; R/S needs three-dimensional coordinates we do not have.
      bond.stereo = { kind: cue.kind, narrowEnd: cue.narrowEnd === 'begin' ? a : b };
      cues += 1;
    }
    bonds.push(bond);
  });

  let name = collapse(fragment.attributes.name);
  if (!name) name = context.caption(atoms);
  if (!name) {
    name = context.fragmentCount === 1 && context.documentName
      ? context.documentName
      : `${context.documentName || context.baseName || 'CDXML'} fragment ${index + 1}`;
  }

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
    warnings,
    geometry: {
      dimension: '2d',
      source: 'cdxml-drawing',
      note: 'Page coordinates from the ChemDraw drawing (y up), z = 0. A drawing, never a computed structure.',
    },
  };
}

/* ── Document ─────────────────────────────────────────────── */

export function isCdxmlDocument(text) {
  if (typeof text !== 'string') return false;
  return /<cdxml[\s>/]/i.test(text.slice(0, 20000));
}

/**
 * Every fragment of a CDXML document, in document order.
 *
 * Returns `{record}` or `{error}` entries: one unreadable fragment does not
 * hide the rest, and the error text names the fragment and the offending
 * attribute so a user can fix the drawing.
 */
export function parseCdxmlRecords(text, { name = '' } = {}) {
  const tree = parseXml(String(text ?? ''));
  const root = elementChildren(tree).find((child) => localName(child.name) === 'cdxml');
  if (!root) {
    throw new CdxmlError('This is not a CDXML document: no <CDXML> root element was found. '
      + 'A .cdx file is the proprietary binary form and is not read; save it from ChemDraw as CDXML.');
  }

  const documentName = collapse(root.attributes.name) || collapse(name);
  const containers = childrenNamed(root, 'page');
  const holder = containers.length > 0 ? containers : [root];

  const fragments = [];
  for (const container of holder) {
    for (const child of elementChildren(container)) {
      if (localName(child.name) === 'fragment') fragments.push({ fragment: child, page: container });
    }
  }
  if (fragments.length === 0) {
    throw new CdxmlError('This CDXML contains no <fragment>, so there is no structure to import.');
  }

  // Node ids are document-scoped in CDXML, which is exactly how a bond that
  // leaves its fragment is detected rather than silently accepted.
  const owner = new Map();
  fragments.forEach(({ fragment }, index) => {
    for (const node of descendantsNamed(fragment, 'n')) {
      const id = collapse(node.attributes.id);
      if (id && !owner.has(id)) owner.set(id, index);
    }
  });

  const ignored = new Map();
  for (const container of holder) countIgnored(container, ignored);
  for (const { fragment } of fragments) countIgnored(fragment, ignored);
  const ignoredNote = ignoredSummary(ignored);

  const baseName = collapse(name).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');

  /**
   * A page-level `<t>` close to the fragment's centroid is the drawing's own
   * caption ("sodium acetate"), so it names the record. "Nearby" is three
   * median bond lengths, or 30 page units for a single atom; a caption further
   * away belongs to something else and is left alone.
   */
  const caption = (page, atoms) => {
    if (!page) return '';
    const centroid = atoms.reduce((sum, atom) => ({ x: sum.x + atom.x, y: sum.y + atom.y }), { x: 0, y: 0 });
    centroid.x /= atoms.length;
    centroid.y /= atoms.length;
    const lengths = [];
    for (let first = 0; first < atoms.length; first += 1) {
      for (let second = first + 1; second < atoms.length; second += 1) {
        lengths.push(Math.hypot(atoms[first].x - atoms[second].x, atoms[first].y - atoms[second].y));
      }
    }
    const reach = Math.max(30, median(lengths) * 3);
    let best = null;
    for (const sibling of elementChildren(page)) {
      if (localName(sibling.name) !== 't') continue;
      const at = point(sibling.attributes.p);
      const label = collapse(textOf(sibling));
      if (!at || !label) continue;
      const distance = Math.hypot(at.x - centroid.x, at.y - centroid.y);
      if (distance > reach) continue;
      if (!best || distance < best.distance) best = { label, distance };
    }
    return best?.label ?? '';
  };

  const records = fragments.map(({ fragment, page }, index) => {
    try {
      const record = parseFragment(fragment, index, {
        owner,
        caption: (atoms) => caption(page, atoms),
        fragmentCount: fragments.length,
        documentName,
        baseName,
      });
      if (ignoredNote && index === 0) record.warnings.push(ignoredNote);
      return record;
    } catch (error) {
      return { error: `Fragment ${index + 1}: ${error.message}` };
    }
  });

  return records;
}
