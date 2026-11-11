import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readOutputFile } from '../electron/runner/gaussianRunner.js';
import { rmrf } from './helpers/tempCleanup.js';

const roots = [];

async function workspace() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nodechem-studio-read-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.map((root) => rmrf(root)));
  roots.length = 0;
});

describe('runner output reading', () => {
  it('reads a small file whole and records the full byte range', async () => {
    const root = await workspace();
    const file = path.join(root, 'synthetic-small.log');
    const text = [' FIXTURE OUTPUT — synthetic, not a Gaussian calculation', ' Normal termination of Gaussian 16'].join('\n');
    await fsp.writeFile(file, text, 'utf8');

    const read = await readOutputFile(file);
    expect(read.truncated).toBe(false);
    expect(read.text).toBe(text);
    expect(read.byteRange).toEqual({
      size: Buffer.byteLength(text),
      bytesRead: Buffer.byteLength(text),
      truncated: false,
      windows: [{
        name: 'full',
        start: 0,
        end: Buffer.byteLength(text),
        bytes: Buffer.byteLength(text),
        supplied: ['termination'],
      }],
    });

    // A file exactly at the cap is still complete.
    const atCap = await readOutputFile(file, { maxBytes: Buffer.byteLength(text) });
    expect(atCap.truncated).toBe(false);
    expect(atCap.text).toBe(text);
  });

  it('reads two windows and drops the partial lines at their edges', async () => {
    const root = await workspace();
    const file = path.join(root, 'synthetic-window.log');
    const lines = [
      ' FIXTURE OUTPUT — synthetic, not a Gaussian calculation',
      ' Entering Gaussian System, Link 0=g16',
      ' #P HF/STO-3G SP',
    ];
    for (let index = 0; index < 200; index += 1) {
      lines.push(` padding line ${String(index).padStart(4, '0')} ${'x'.repeat(60)}`);
    }
    lines.push(' SCF Done:  E(RHF) =  -75.000000000     A.U. after    5 cycles');
    lines.push(' Normal termination of Gaussian 16');
    const text = `${lines.join('\n')}\n`;
    await fsp.writeFile(file, text, 'utf8');

    const read = await readOutputFile(file, { maxBytes: 4096, headBytes: 1024, tailBytes: 1024 });
    expect(read.truncated).toBe(true);

    const [head, tail] = read.byteRange.windows;
    expect(head).toMatchObject({ name: 'head', start: 0, end: 1024, bytes: 1024 });
    expect(tail).toMatchObject({ name: 'tail', end: Buffer.byteLength(text), bytes: 1024 });
    expect(tail.start).toBeGreaterThan(head.end);
    expect(read.byteRange.size).toBe(Buffer.byteLength(text));
    expect(read.byteRange.bytesRead).toBe(2048);
    expect(read.byteRange.bytesRead).toBeLessThan(read.byteRange.size);
    expect(read.byteRange.truncated).toBe(true);

    expect(read.text).toContain('Entering Gaussian System');
    expect(read.text).toContain('Normal termination of Gaussian 16');
    expect(read.text).not.toContain('padding line 0100');

    // Every line the parser receives is a whole line from the file.
    const original = new Set(lines);
    for (const line of read.text.split('\n')) {
      if (line === '') continue;
      expect(original.has(line)).toBe(true);
    }

    expect(head.supplied).toEqual(expect.arrayContaining(['banner', 'route']));
    expect(tail.supplied).toEqual(expect.arrayContaining(['scf', 'termination']));
  });
});
