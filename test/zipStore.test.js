import { describe, expect, it } from 'vitest';
import { crc32, zipStore } from '../src/shared/zipStore.js';

/**
 * Read an archive back through its end-of-central-directory record and central
 * directory. This is deliberately the reader a third-party tool would use, not
 * a second copy of the writer's assumptions: it proves the offsets and sizes in
 * the archive are self-consistent.
 */
function readArchive(buffer) {
  const eocd = buffer.length - 22;
  expect(buffer.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  expect(cdOffset + cdSize).toBe(eocd);

  const entries = [];
  let offset = cdOffset;
  for (let index = 0; index < count; index += 1) {
    expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressed = buffer.readUInt32LE(offset + 20);
    const uncompressed = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    expect(buffer.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    expect(buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8')).toBe(name);
    entries.push({
      name,
      flags,
      method,
      crc,
      compressed,
      uncompressed,
      bytes: buffer.subarray(dataStart, dataStart + compressed),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  expect(offset).toBe(eocd);
  return entries;
}

describe('crc32', () => {
  it('computes the standard CRC-32 of "123456789"', () => {
    expect(crc32('123456789')).toBe(0xcbf43926);
  });
});

describe('zipStore', () => {
  it('writes a store-only archive whose central directory describes every entry', () => {
    const archive = zipStore([
      { name: 'manifest.json', bytes: '{"ok":true}\n' },
      { name: 'reports/dataset.csv', bytes: 'run_id,status\nr1,completed\n' },
      { name: 'notes/ümlaut.txt', bytes: 'grüße' },
    ]);
    expect(Buffer.isBuffer(archive)).toBe(true);
    const entries = readArchive(archive);
    expect(entries.map((entry) => entry.name)).toEqual([
      'manifest.json',
      'reports/dataset.csv',
      'notes/ümlaut.txt',
    ]);
    for (const entry of entries) {
      expect(entry.method).toBe(0); // store
      expect(entry.flags & 0x0800).toBe(0x0800); // UTF-8 names
      expect(entry.compressed).toBe(entry.uncompressed);
      expect(entry.crc).toBe(crc32(entry.bytes));
    }
    expect(entries[2].bytes.toString('utf8')).toBe('grüße');
    expect(entries[1].bytes.toString('utf8')).toBe('run_id,status\nr1,completed\n');
  });

  it('is deterministic for the same entries', () => {
    const first = zipStore([{ name: 'a.txt', bytes: 'one' }, { name: 'b.txt', bytes: 'two' }]);
    const second = zipStore([{ name: 'a.txt', bytes: 'one' }, { name: 'b.txt', bytes: 'two' }]);
    expect(first.equals(second)).toBe(true);
  });

  it('writes a valid empty archive', () => {
    const archive = zipStore([]);
    expect(archive.length).toBe(22);
    expect(readArchive(archive)).toEqual([]);
  });

  it('refuses names that could escape the extraction folder', () => {
    expect(() => zipStore([{ name: '../evil.txt', bytes: 'x' }])).toThrow(/\.\./);
    expect(() => zipStore([{ name: '/etc/passwd', bytes: 'x' }])).toThrow(/relative/i);
    expect(() => zipStore([{ name: 'C:/windows/x', bytes: 'x' }])).toThrow(/relative/i);
    expect(() => zipStore([{ name: 'a\\b.txt', bytes: 'x' }])).toThrow(/separator/);
    expect(() => zipStore([{ name: 'a//b.txt', bytes: 'x' }])).toThrow(/empty/);
    expect(() => zipStore([{ name: 'a/./b.txt', bytes: 'x' }])).toThrow(/empty, "\." or "\.\."/);
  });

  it('refuses duplicate names and missing bytes', () => {
    expect(() => zipStore([
      { name: 'a.txt', bytes: 'x' },
      { name: 'a.txt', bytes: 'y' },
    ])).toThrow(/twice/);
    expect(() => zipStore([{ name: 'a.txt' }])).toThrow(/bytes/);
    expect(() => zipStore([{ name: '', bytes: 'x' }])).toThrow(/name/);
  });
});
