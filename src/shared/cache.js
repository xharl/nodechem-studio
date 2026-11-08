/**
 * Run cache: parsed results as typed arrays instead of text (#99 follow-up).
 *
 * Everything the app shows is parsed out of a text log every time it is asked
 * for it. For a small molecule that is milliseconds; for a `.cube` it is tens
 * of megabytes of ASCII, a regex pass over every line, and a float parse per
 * value. The numbers themselves are a few megabytes of `Float32Array`.
 *
 * This container is deliberately not a zip, a JSON dump or an NPZ:
 *
 *   magic       8 bytes  "NCSR" + version
 *   headerLen   4 bytes  little-endian uint32
 *   header      JSON     meta + a section table (name, dtype, shape, offset,
 *                        length)
 *   payload     binary   each section 8-byte aligned
 *
 * No dependency, no compression, no per-value formatting. Reading a section is
 * a slice plus a typed-array view, which is the whole point: the cost of a
 * reload stops depending on how many numbers the file holds.
 *
 * What the format does **not** claim: it is a cache of parsed values, not a
 * replacement for the log. Provenance lives in the run record, and a cache
 * without its log is a picture without its source.
 */

export const CACHE_MAGIC = 'NCSR';
export const CACHE_VERSION = 1;
export const HEADER_PREFIX_BYTES = 12;
const ALIGN = 8;

export const DTYPES = Object.freeze({
  f32: { bytes: 4, ArrayType: Float32Array },
  f64: { bytes: 8, ArrayType: Float64Array },
  i32: { bytes: 4, ArrayType: Int32Array },
  u8: { bytes: 1, ArrayType: Uint8Array },
  utf8: { bytes: 1, ArrayType: Uint8Array },
});

export class CacheError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CacheError';
  }
}

function align(value) {
  return Math.ceil(value / ALIGN) * ALIGN;
}

function encodeSection(section, index) {
  const dtype = DTYPES[section?.dtype];
  if (!dtype) {
    throw new CacheError(`section ${index} ("${section?.name}") has unknown dtype "${section?.dtype}".`);
  }
  const name = String(section?.name || '').trim();
  if (!name) throw new CacheError(`section ${index} has no name.`);
  const shape = Array.isArray(section.shape) ? section.shape.map(Number) : [];
  if (section.dtype === 'utf8') {
    if (typeof section.data !== 'string') throw new CacheError(`section "${name}" is utf8 but its data is not a string.`);
    const bytes = Buffer.from(section.data, 'utf8');
    return { name, dtype: 'utf8', shape, bytes };
  }
  const list = section?.data;
  if (!ArrayBuffer.isView(list) && !Array.isArray(list)) {
    throw new CacheError(`section "${name}" needs a typed array or a plain array.`);
  }
  const values = list instanceof dtype.ArrayType ? list : dtype.ArrayType.from(list);
  const expected = shape.reduce((product, size) => product * size, 1);
  if (shape.length > 0 && values.length !== expected) {
    throw new CacheError(`section "${name}" declares shape ${shape.join('x')} (${expected} values) but holds ${values.length}.`);
  }
  const bytes = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
  return { name, dtype: section.dtype, shape: shape.length ? shape : [values.length], bytes };
}

/**
 * @param {{meta: object, sections: Array<{name: string, dtype: string, shape?: number[], data: any}>}} cache
 * @returns {Buffer}
 */
export function writeCache({ meta = {}, sections = [] } = {}) {
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new CacheError('a cache needs at least one section.');
  }
  const encoded = sections.map(encodeSection);
  const seen = new Set();
  for (const section of encoded) {
    if (seen.has(section.name)) throw new CacheError(`two sections are named "${section.name}".`);
    seen.add(section.name);
  }

  const table = [];
  let offset = 0;
  for (const section of encoded) {
    table.push({ name: section.name, dtype: section.dtype, shape: section.shape, offset, length: section.bytes.length });
    offset = align(offset + section.bytes.length);
  }

  const header = Buffer.from(JSON.stringify({
    format: CACHE_MAGIC,
    version: CACHE_VERSION,
    createdAt: new Date().toISOString(),
    meta,
    sections: table,
  }), 'utf8');

  const prefix = Buffer.alloc(HEADER_PREFIX_BYTES);
  prefix.write(CACHE_MAGIC, 0, 'latin1');
  prefix.writeUInt8(CACHE_VERSION, 4);
  prefix.writeUInt32LE(header.length, 8);

  const payload = Buffer.alloc(offset);
  encoded.forEach((section, index) => section.bytes.copy(payload, table[index].offset));

  return Buffer.concat([prefix, header, payload]);
}

/**
 * Read a cache. Every structural problem is named: a wrong magic, a version
 * this reader does not know, a header longer than the file, a section that
 * points past its end. Nothing is returned partially.
 */
export function readCache(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length < HEADER_PREFIX_BYTES) {
    throw new CacheError(`not a cache: ${bytes.length} bytes is shorter than the ${HEADER_PREFIX_BYTES}-byte header.`);
  }
  const magic = bytes.toString('latin1', 0, 4);
  if (magic !== CACHE_MAGIC) {
    throw new CacheError(`not a cache: expected magic "${CACHE_MAGIC}", found "${magic}".`);
  }
  const version = bytes.readUInt8(4);
  if (version !== CACHE_VERSION) {
    throw new CacheError(`cache version ${version} is not supported by this reader (it reads version ${CACHE_VERSION}).`);
  }
  const headerLength = bytes.readUInt32LE(8);
  const headerEnd = HEADER_PREFIX_BYTES + headerLength;
  if (headerEnd > bytes.length) {
    throw new CacheError(`truncated cache: the header claims ${headerLength} bytes but the file ends after ${bytes.length - HEADER_PREFIX_BYTES}.`);
  }
  let header;
  try {
    header = JSON.parse(bytes.toString('utf8', HEADER_PREFIX_BYTES, headerEnd));
  } catch (error) {
    throw new CacheError(`corrupt header: ${error.message}`);
  }
  if (!Array.isArray(header.sections)) throw new CacheError('corrupt header: no section table.');

  const sections = new Map();
  header.sections.forEach((entry, index) => {
    const dtype = DTYPES[entry?.dtype];
    if (!dtype) throw new CacheError(`section ${index} ("${entry?.name}") has unknown dtype "${entry?.dtype}".`);
    const start = headerEnd + Number(entry.offset);
    const end = start + Number(entry.length);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < headerEnd || end > bytes.length) {
      throw new CacheError(`section "${entry?.name}" points outside the file.`);
    }
    const slice = bytes.subarray(start, end);
    if (entry.dtype === 'utf8') {
      sections.set(entry.name, slice.toString('utf8'));
      return;
    }
    // Copy into an aligned buffer: the file's byte offset is not the only
    // alignment that matters, the Buffer's own offset inside its pool is.
    const copy = new Uint8Array(slice.length);
    copy.set(slice);
    sections.set(entry.name, new dtype.ArrayType(copy.buffer));
  });

  return { meta: header.meta ?? {}, createdAt: header.createdAt ?? null, version, sections };
}

export function cacheInfo(buffer) {
  const cache = readCache(buffer);
  return {
    version: cache.version,
    createdAt: cache.createdAt,
    meta: cache.meta,
    sections: [...cache.sections.entries()].map(([name, data]) => ({
      name,
      dtype: typeof data === 'string' ? 'utf8' : data.constructor.name,
      length: typeof data === 'string' ? data.length : data.length,
    })),
  };
}

/**
 * Frames of a parsed run, packed as one coordinate block plus a symbol table.
 *
 * Coordinates go to `f32`: they come out of a log with six decimals in
 * angstroms, and the viewer draws them 1e-5 apart at best. Energies stay `f64`
 * — they are compared to microhartree elsewhere, and the same file should not
 * be the reason two analyses disagree.
 */
export function cacheFromParsed(parsed) {
  const steps = parsed?.trajectory?.steps;
  const frames = Array.isArray(steps) && steps.length
    ? steps.map((step) => ({ atoms: step.atoms, energyHartree: step.energyHartree, step: step.index }))
    : null;
  if (!frames) throw new CacheError('this record has no trajectory to cache.');

  const symbols = [];
  const indexOf = new Map();
  const atomCount = frames[0].atoms.length;
  for (const frame of frames) {
    if (frame.atoms.length !== atomCount) {
      throw new CacheError(`frame ${frame.step ?? '?'} has ${frame.atoms.length} atoms where the first has ${atomCount}.`);
    }
    for (const atom of frame.atoms) {
      const element = String(atom?.element || '').trim();
      if (!element) throw new CacheError('an atom in the trajectory has no element symbol.');
      if (!indexOf.has(element)) {
        indexOf.set(element, symbols.length);
        symbols.push(element);
      }
    }
  }

  const coords = new Float32Array(frames.length * atomCount * 3);
  const species = new Uint8Array(frames.length * atomCount);
  const energies = new Float64Array(frames.length);
  const stepsOut = new Int32Array(frames.length);

  frames.forEach((frame, frameIndex) => {
    if (Number.isFinite(frame.energyHartree)) energies[frameIndex] = frame.energyHartree;
    else energies[frameIndex] = Number.NaN; // "not reported", not zero
    stepsOut[frameIndex] = Number.isInteger(frame.step) ? frame.step : frameIndex + 1;
    frame.atoms.forEach((atom, atomIndex) => {
      const base = (frameIndex * atomCount + atomIndex) * 3;
      coords[base] = atom.x;
      coords[base + 1] = atom.y;
      coords[base + 2] = atom.z;
      species[frameIndex * atomCount + atomIndex] = indexOf.get(String(atom.element).trim());
    });
  });

  return {
    meta: {
      kind: 'trajectory',
      frames: frames.length,
      atoms: atomCount,
      symbols,
      program: parsed?.program?.name ?? null,
      revision: parsed?.program?.revision ?? null,
    },
    sections: [
      { name: 'coords', dtype: 'f32', shape: [frames.length, atomCount, 3], data: coords },
      { name: 'species', dtype: 'u8', shape: [frames.length, atomCount], data: species },
      { name: 'energy_hartree', dtype: 'f64', shape: [frames.length], data: energies },
      { name: 'step', dtype: 'i32', shape: [frames.length], data: stepsOut },
    ],
  };
}

/** Frames back out of a cached trajectory, in the shape the viewers take. */
export function framesFromCache(cache) {
  const coords = cache?.sections?.get('coords');
  const species = cache?.sections?.get('species');
  const energies = cache?.sections?.get('energy_hartree');
  const steps = cache?.sections?.get('step');
  const symbols = cache?.meta?.symbols;
  if (!coords || !species || !Array.isArray(symbols)) {
    throw new CacheError('this cache is not a trajectory: it has no coordinates or symbol table.');
  }
  const frames = Number(cache.meta?.frames);
  const atoms = Number(cache.meta?.atoms);
  const out = [];
  for (let frame = 0; frame < frames; frame += 1) {
    const list = [];
    for (let atom = 0; atom < atoms; atom += 1) {
      const base = (frame * atoms + atom) * 3;
      list.push({ element: symbols[species[frame * atoms + atom]], x: coords[base], y: coords[base + 1], z: coords[base + 2] });
    }
    out.push({
      atoms: list,
      step: steps ? steps[frame] : frame + 1,
      energyHartree: energies && Number.isFinite(energies[frame]) ? energies[frame] : null,
    });
  }
  return out;
}

/**
 * A cube as a cache section: the volumetric values become one `f32` block and
 * everything needed to place them on the grid stays in `meta`.
 */
export function cacheFromCube(cube, { precision = 'f64' } = {}) {
  const values = cube?.values;
  const hasValues = ArrayBuffer.isView(values) || Array.isArray(values);
  if (!cube || !hasValues || values.length === 0) {
    throw new CacheError('this cube holds no values to cache.');
  }
  const dims = cube.dims || cube.shape;
  if (!Array.isArray(dims) || dims.length !== 3) throw new CacheError('a cube cache needs three grid dimensions.');
  const expected = dims[0] * dims[1] * dims[2];
  if (cube.values.length !== expected) {
    throw new CacheError(`the cube declares ${dims.join('x')} (${expected} points) but holds ${cube.values.length}.`);
  }
  // `f64` is the default because a cube read back from the cache must give the
  // same numbers as the cube it came from: a density or an orbital amplitude
  // rounded to single precision would move an isosurface. Ask for `f32` when
  // the cache exists only to be drawn.
  if (precision !== 'f64' && precision !== 'f32') {
    throw new CacheError(`unknown cube cache precision "${precision}"; use f64 or f32.`);
  }
  return {
    meta: {
      kind: 'cube',
      dims: dims.map(Number),
      origin: cube.origin ?? null,
      axes: cube.axes ?? null,
      spacing: cube.spacing ?? null,
      atoms: cube.atoms ?? null,
      units: cube.units ?? null,
      precision,
    },
    sections: [
      { name: 'values', dtype: precision, shape: dims.map(Number), data: cube.values },
    ],
  };
}
