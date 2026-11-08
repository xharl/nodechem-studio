import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CACHE_MAGIC,
  CACHE_VERSION,
  CacheError,
  cacheFromCube,
  cacheFromParsed,
  cacheInfo,
  framesFromCache,
  readCache,
  writeCache,
} from '../src/shared/cache.js';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { parseCube } from '../src/shared/cubeFile.js';

const real = (name) => readFileSync(`test/fixtures/real/${name}`, 'utf8');
const optimisation = parseGaussianOutput(real('g16-dvb-gopt.out'));

/** A legal 2x1x1 cube: two atoms, three grid rows, two values in bohr. */
const CUBE_TEXT = [
  'NodeChem test cube',
  'OUTER LOOP: X, MIDDLE LOOP: Y, INNER LOOP: Z',
  '   2   0.0 0.0 0.0',
  '   1   1.0   0.0   0.0   0.0',
  '   8   8.0   0.0   0.0   1.0',
  '   2   1.0   1.0   0.0   0.0',
  '   1   1.0   0.0   1.0   0.0',
  '   1   1.0   0.0   0.0   1.0',
  '0.125 -0.5',
].join('\n');

describe('the container itself', () => {
  it('round-trips every dtype it claims to hold', () => {
    const buffer = writeCache({
      meta: { note: 'typed arrays' },
      sections: [
        { name: 'f', dtype: 'f32', shape: [2], data: new Float32Array([1.5, -2.25]) },
        { name: 'd', dtype: 'f64', shape: [2], data: new Float64Array([Math.PI, 1e-12]) },
        { name: 'i', dtype: 'i32', shape: [1], data: new Int32Array([-7]) },
        { name: 'b', dtype: 'u8', shape: [3], data: new Uint8Array([0, 127, 255]) },
        { name: 'text', dtype: 'utf8', data: 'héllo' },
      ],
    });
    const cache = readCache(buffer);
    expect(cache.meta).toEqual({ note: 'typed arrays' });
    expect(Array.from(cache.sections.get('f'))).toEqual([1.5, -2.25]);
    expect(cache.sections.get('d')[0]).toBeCloseTo(Math.PI, 12);
    expect(cache.sections.get('d')[1]).toBeCloseTo(1e-12, 20);
    expect(cache.sections.get('i')[0]).toBe(-7);
    expect(Array.from(cache.sections.get('b'))).toEqual([0, 127, 255]);
    expect(cache.sections.get('text')).toBe('héllo');
    expect(cache.version).toBe(CACHE_VERSION);
  });

  it('starts with the magic bytes and states its version', () => {
    const buffer = writeCache({ sections: [{ name: 'x', dtype: 'u8', shape: [1], data: new Uint8Array([1]) }] });
    expect(buffer.toString('latin1', 0, 4)).toBe(CACHE_MAGIC);
    expect(buffer.readUInt8(4)).toBe(CACHE_VERSION);
  });

  it('refuses a section whose declared shape does not match its data', () => {
    expect(() => writeCache({
      sections: [{ name: 'x', dtype: 'f32', shape: [3], data: new Float32Array([1, 2]) }],
    })).toThrow(/declares shape 3/);
  });

  it('refuses duplicate section names', () => {
    expect(() => writeCache({
      sections: [
        { name: 'x', dtype: 'u8', shape: [1], data: new Uint8Array([1]) },
        { name: 'x', dtype: 'u8', shape: [1], data: new Uint8Array([2]) },
      ],
    })).toThrow(/named "x"/);
  });

  it('refuses a dtype it does not know rather than guessing a width', () => {
    expect(() => writeCache({ sections: [{ name: 'x', dtype: 'u16', shape: [1], data: [1] }] }))
      .toThrow(/unknown dtype/);
  });
});

describe('a cache that is damaged says how', () => {
  const good = writeCache({
    meta: { kind: 'test' },
    sections: [{ name: 'x', dtype: 'f32', shape: [2], data: new Float32Array([1, 2]) }],
  });

  it('rejects a file that is not a cache', () => {
    expect(() => readCache(Buffer.from('this is a log file, not a cache'))).toThrow(/expected magic/);
  });

  it('rejects a file shorter than its own header', () => {
    expect(() => readCache(good.subarray(0, 20))).toThrow(/shorter|truncated/);
  });

  it('rejects a truncated payload', () => {
    expect(() => readCache(good.subarray(0, good.length - 4))).toThrow(/points outside the file/);
  });

  it('rejects a version it does not read', () => {
    const other = Buffer.from(good);
    other.writeUInt8(9, 4);
    expect(() => readCache(other)).toThrow(/version 9 is not supported/);
  });

  it('rejects a corrupt header', () => {
    const broken = Buffer.from(good);
    broken.write('not json', 12, 'utf8');
    expect(() => readCache(broken)).toThrow(CacheError);
  });
});

describe('a trajectory cache', () => {
  const buffer = writeCache(cacheFromParsed(optimisation));
  const cache = readCache(buffer);

  it('keeps the frame and atom counts in the meta', () => {
    // 20 atoms: the fixture is C10H10. The old parser dropped the first two atom
    // rows of every frame and the expectation had been pinned to that bug.
    expect(cache.meta).toMatchObject({ kind: 'trajectory', frames: 6, atoms: 20 });
    expect(cache.meta.symbols).toContain('C');
  });

  it('returns the same geometries the log had', () => {
    const frames = framesFromCache(cache);
    expect(frames).toHaveLength(6);
    const source = optimisation.trajectory.steps[5].atoms[0];
    expect(frames[5].atoms[0].element).toBe(source.element);
    expect(frames[5].atoms[0].x).toBeCloseTo(source.x, 5);
    expect(frames[5].atoms[0].y).toBeCloseTo(source.y, 5);
    expect(frames[5].atoms[0].z).toBeCloseTo(source.z, 5);
  });

  it('keeps a missing energy missing', () => {
    const frames = framesFromCache(cache);
    expect(frames[0].energyHartree).toBeNull();
    expect(frames[5].energyHartree).toBeCloseTo(-382.308266602, 9);
  });

  it('is smaller than the log it came from', () => {
    expect(buffer.length).toBeLessThan(Buffer.byteLength(real('g16-dvb-gopt.out')));
  });

  it('summarises its sections without decoding them all', () => {
    const info = cacheInfo(buffer);
    expect(info.sections.map((section) => section.name)).toEqual(['coords', 'species', 'energy_hartree', 'step']);
    expect(info.sections.find((section) => section.name === 'coords').dtype).toBe('Float32Array');
  });

  it('refuses a record with no trajectory', () => {
    expect(() => cacheFromParsed({})).toThrow(/no trajectory/);
  });

  it('refuses frames whose atom counts disagree', () => {
    const parsed = {
      trajectory: {
        steps: [
          { index: 1, atoms: [{ element: 'H', x: 0, y: 0, z: 0 }] },
          { index: 2, atoms: [{ element: 'H', x: 0, y: 0, z: 0 }, { element: 'H', x: 1, y: 0, z: 0 }] },
        ],
      },
    };
    expect(() => cacheFromParsed(parsed)).toThrow(/has 2 atoms where the first has 1/);
  });
});

describe('a cube cache', () => {
  const cube = parseCube(CUBE_TEXT);

  it('round-trips the values exactly at f64', () => {
    const cache = readCache(writeCache(cacheFromCube(cube)));
    const values = cache.sections.get('values');
    expect(values).toBeInstanceOf(Float64Array);
    expect(Array.from(values)).toEqual([0.125, -0.5]);
    expect(cache.meta).toMatchObject({ kind: 'cube', dims: [2, 1, 1], precision: 'f64' });
  });

  it('keeps the grid placement, without which the numbers mean nothing', () => {
    const cache = readCache(writeCache(cacheFromCube(cube)));
    expect(cache.meta.origin).toEqual(cube.origin);
    expect(cache.meta.axes).toEqual(cube.axes);
    expect(cache.meta.atoms).toHaveLength(2);
  });

  it('can halve its size for display, and says which precision it used', () => {
    const small = writeCache(cacheFromCube(cube, { precision: 'f32' }));
    const cache = readCache(small);
    expect(cache.meta.precision).toBe('f32');
    expect(cache.sections.get('values')).toBeInstanceOf(Float32Array);
    expect(writeCache(cacheFromCube(cube, { precision: 'f32' })).length)
      .toBeLessThan(writeCache(cacheFromCube(cube)).length);
  });

  it('refuses a cube whose dimensions disagree with its values', () => {
    expect(() => cacheFromCube({ dims: [2, 2, 2], values: [1, 2], origin: [0, 0, 0] }))
      .toThrow(/declares 2x2x2/);
  });

  it('refuses an unknown precision instead of writing one of them', () => {
    expect(() => cacheFromCube(cube, { precision: 'f16' })).toThrow(/use f64 or f32/);
  });
});
