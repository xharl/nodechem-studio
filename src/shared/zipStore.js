/**
 * Store-only ZIP writer.
 *
 * A ZIP is used for one thing here: handing a folder of text files to a person
 * who may be on another OS. Artifacts are CSV, JSON, HTML and run records —
 * already small and already compressed by nothing — so deflating them would add
 * an implementation surface (a compressor) for no useful saving. Store-only
 * keeps this module dependency-free, auditable and deterministic: the same
 * entries produce the same bytes.
 *
 * It writes the three structures every reader needs — local file header,
 * central directory, end-of-central-directory — with UTF-8 names (general
 * purpose bit 11) and no extra fields or comments. It is not a general-purpose
 * archiver: no ZIP64, no encryption, no data descriptors.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

/** Version 2.0: the oldest version that defines the store method. */
const VERSION_NEEDED = 20;

/**
 * 1980-01-01 00:00 in DOS format. A fixed timestamp keeps the archive
 * reproducible; the manifest records the real generation time.
 */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * CRC-32 (IEEE 802.3), the checksum ZIP stores for every entry.
 * @param {Buffer|Uint8Array|string} input
 * @returns {number} unsigned 32-bit checksum
 */
export function crc32(input) {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input || []);
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A bundle name is one relative POSIX path. Anything that could resolve
 * outside the extraction directory, or that a Windows reader would interpret
 * differently, is refused instead of escaped.
 */
function checkName(name) {
  const raw = String(name ?? '');
  if (!raw) throw new Error('A ZIP entry needs a name.');
  if (raw.includes('\0')) throw new Error(`ZIP entry name "${raw}" contains a NUL byte.`);
  if (raw.includes('\\')) throw new Error(`ZIP entry name "${raw}" must use "/" as its separator.`);
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`ZIP entry name "${raw}" must be relative.`);
  }
  const segments = raw.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`ZIP entry name "${raw}" must not contain empty, "." or ".." segments.`);
  }
  return raw;
}

function entryBytes(entry) {
  const value = entry?.bytes;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new Error(`ZIP entry "${entry?.name || ''}" needs bytes (Buffer, Uint8Array or string).`);
}

/**
 * Build a store-only ZIP from `[{ name, bytes }]`.
 *
 * @param {Array<{name: string, bytes: Buffer|Uint8Array|string}>} entries
 * @returns {Buffer} the complete archive
 */
export function zipStore(entries = []) {
  const list = Array.isArray(entries) ? entries : [];
  const prepared = [];
  const names = new Set();
  for (const entry of list) {
    const name = checkName(entry?.name);
    if (names.has(name)) throw new Error(`ZIP entry name "${name}" appears twice.`);
    names.add(name);
    const bytes = entryBytes(entry);
    prepared.push({
      nameBytes: Buffer.from(name, 'utf8'),
      bytes,
      crc: crc32(bytes),
    });
  }

  const localSize = prepared.reduce((total, entry) => total + 30 + entry.nameBytes.length + entry.bytes.length, 0);
  const centralSize = prepared.reduce((total, entry) => total + 46 + entry.nameBytes.length, 0);
  const buffer = Buffer.alloc(localSize + centralSize + 22);
  let offset = 0;
  const central = [];

  for (const entry of prepared) {
    const localOffset = offset;
    buffer.writeUInt32LE(LOCAL_HEADER, offset);
    buffer.writeUInt16LE(VERSION_NEEDED, offset + 4);
    buffer.writeUInt16LE(0x0800, offset + 6); // UTF-8 names
    buffer.writeUInt16LE(0, offset + 8); // store
    buffer.writeUInt16LE(DOS_TIME, offset + 10);
    buffer.writeUInt16LE(DOS_DATE, offset + 12);
    buffer.writeUInt32LE(entry.crc, offset + 14);
    buffer.writeUInt32LE(entry.bytes.length, offset + 18);
    buffer.writeUInt32LE(entry.bytes.length, offset + 22);
    buffer.writeUInt16LE(entry.nameBytes.length, offset + 26);
    buffer.writeUInt16LE(0, offset + 28);
    entry.nameBytes.copy(buffer, offset + 30);
    entry.bytes.copy(buffer, offset + 30 + entry.nameBytes.length);
    offset += 30 + entry.nameBytes.length + entry.bytes.length;
    central.push({ ...entry, localOffset });
  }

  const centralOffset = offset;
  for (const entry of central) {
    buffer.writeUInt32LE(CENTRAL_HEADER, offset);
    buffer.writeUInt16LE(VERSION_NEEDED, offset + 4);
    buffer.writeUInt16LE(VERSION_NEEDED, offset + 6);
    buffer.writeUInt16LE(0x0800, offset + 8);
    buffer.writeUInt16LE(0, offset + 10);
    buffer.writeUInt16LE(DOS_TIME, offset + 12);
    buffer.writeUInt16LE(DOS_DATE, offset + 14);
    buffer.writeUInt32LE(entry.crc, offset + 16);
    buffer.writeUInt32LE(entry.bytes.length, offset + 20);
    buffer.writeUInt32LE(entry.bytes.length, offset + 24);
    buffer.writeUInt16LE(entry.nameBytes.length, offset + 28);
    buffer.writeUInt16LE(0, offset + 30); // extra length
    buffer.writeUInt16LE(0, offset + 32); // comment length
    buffer.writeUInt16LE(0, offset + 34); // disk number
    buffer.writeUInt16LE(0, offset + 36); // internal attributes
    buffer.writeUInt32LE(0, offset + 38); // external attributes
    buffer.writeUInt32LE(entry.localOffset, offset + 42);
    entry.nameBytes.copy(buffer, offset + 46);
    offset += 46 + entry.nameBytes.length;
  }

  buffer.writeUInt32LE(END_OF_CENTRAL, offset);
  buffer.writeUInt16LE(0, offset + 4); // this disk
  buffer.writeUInt16LE(0, offset + 6); // disk with the central directory
  buffer.writeUInt16LE(central.length, offset + 8);
  buffer.writeUInt16LE(central.length, offset + 10);
  buffer.writeUInt32LE(offset - centralOffset, offset + 12);
  buffer.writeUInt32LE(centralOffset, offset + 16);
  buffer.writeUInt16LE(0, offset + 20); // archive comment

  return buffer;
}
