/**
 * Issue #369: the in-app UFF relaxation runs off the main thread.
 *
 * These tests pin the three claims that make the move safe:
 *
 *   1. the worker and the in-process engine return the same numbers, bit for
 *      bit — not "close", the same Float64 values and the same ensemble text;
 *   2. progress events carry a real iteration count and cancellation lands
 *      inside one iteration batch;
 *   3. the main thread keeps answering timers during a 200-candidate, 48-atom
 *      search, and the same measurement fails when the worker/yield path is
 *      disabled (`mode: 'sync'`, the pre-#369 call). That second measurement is
 *      what proves the first is not vacuous.
 */
import { describe, expect, it, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UffJobExecutor, uffInputHash } from '../electron/runner/uffJob.js';
import { generateUffEnsemble, generateUffEnsembleAsync } from '../src/shared/uffConformers.js';
import { optimizeUff, optimizeUffAsync } from '../src/shared/uff.js';
import { parseStructure } from '../src/shared/structureImport.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* ── fixtures ───────────────────────────────────────────────── */

const ANGLE = (112 * Math.PI) / 180;
const norm = (v) => {
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
};
const unit = (a, b) => norm({ x: b.x - a.x, y: b.y - a.y, z: b.z - a.z });
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/** A straight-chain alkane with explicit hydrogens, as in uffConformers.test.js. */
function alkane(carbons) {
  const list = [];
  const chain = [];
  const spacing = 1.53 * Math.sin(ANGLE / 2);
  const rise = 1.53 * Math.cos(ANGLE / 2);
  for (let index = 0; index < carbons; index += 1) {
    chain.push({ element: 'C', x: index * spacing, y: (index % 2) * rise, z: 0 });
  }
  list.push(...chain);
  const hydrogens = [];
  for (let index = 0; index < carbons; index += 1) {
    const centre = chain[index];
    const neighbours = [chain[index - 1], chain[index + 1]].filter(Boolean);
    const directions = [];
    if (neighbours.length === 2) {
      const u1 = unit(centre, neighbours[0]);
      const u2 = unit(centre, neighbours[1]);
      const bisector = norm({ x: -(u1.x + u2.x), y: -(u1.y + u2.y), z: -(u1.z + u2.z) });
      const perpendicular = norm(cross(u1, u2));
      const half = (109.47 * Math.PI) / 360;
      for (const sign of [1, -1]) {
        directions.push(norm({
          x: bisector.x * Math.cos(half) + sign * perpendicular.x * Math.sin(half),
          y: bisector.y * Math.cos(half) + sign * perpendicular.y * Math.sin(half),
          z: bisector.z * Math.cos(half) + sign * perpendicular.z * Math.sin(half),
        }));
      }
    } else {
      const u = unit(centre, neighbours[0]);
      const helper = Math.abs(u.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
      const e1 = norm(cross(u, helper));
      const e2 = cross(u, e1);
      for (let h = 0; h < 3; h += 1) {
        const phi = (h * 2 * Math.PI) / 3;
        directions.push(norm({
          x: -u.x / 3 + (e1.x * Math.cos(phi) + e2.x * Math.sin(phi)) * Math.sqrt(8 / 9),
          y: -u.y / 3 + (e1.y * Math.cos(phi) + e2.y * Math.sin(phi)) * Math.sqrt(8 / 9),
          z: -u.z / 3 + (e1.z * Math.cos(phi) + e2.z * Math.sin(phi)) * Math.sqrt(8 / 9),
        }));
      }
    }
    for (const direction of directions) {
      hydrogens.push({ parent: index + 1 });
      list.push({
        element: 'H',
        x: centre.x + direction.x * 1.09,
        y: centre.y + direction.y * 1.09,
        z: centre.z + direction.z * 1.09,
      });
    }
  }
  const bonds = [];
  for (let index = 1; index < carbons; index += 1) bonds.push({ a: index, b: index + 1, order: 1 });
  hydrogens.forEach((hydrogen, index) => bonds.push({ a: hydrogen.parent, b: carbons + index + 1, order: 1 }));
  return { atoms: list, bonds };
}

/** The issue's 48-atom case: a C16 chain with its last two hydrogens removed. */
function molecule48() {
  const full = alkane(16);
  return {
    atoms: full.atoms.slice(0, 48),
    bonds: full.bonds.filter((bond) => bond.a <= 48 && bond.b <= 48),
  };
}

const distortedWater = () => ({
  atoms: [
    { element: 'O', x: 0, y: 0, z: 0 },
    { element: 'H', x: 1.25, y: 0, z: 0 },
    { element: 'H', x: 0.1, y: 1.15, z: 0.35 },
  ],
  bonds: [{ a: 1, b: 2, order: 1 }, { a: 1, b: 3, order: 1 }],
});

const executors = [];
function executor(options) {
  const instance = new UffJobExecutor(options);
  executors.push(instance);
  return instance;
}
afterEach(() => {
  for (const instance of executors.splice(0)) instance.cancelAll();
});

/** Every Float64 the optimiser reports, compared with `Object.is`. */
function expectSameNumbers(actual, expected, label = 'numbers') {
  expect(Array.from(actual), label).toHaveLength(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    if (!Object.is(Array.from(actual)[index], expected[index])) {
      throw new Error(`${label}[${index}]: ${actual[index]} !== ${expected[index]}`);
    }
  }
}

function expectSameRelaxation(actual, expected) {
  expect(actual.iterations).toBe(expected.iterations);
  expect(actual.converged).toBe(expected.converged);
  expect(actual.reason).toBe(expected.reason);
  expect(Object.is(actual.energyKcal, expected.energyKcal)).toBe(true);
  expect(Object.is(actual.initialEnergyKcal, expected.initialEnergyKcal)).toBe(true);
  expect(Object.is(actual.gradientNormKcalPerAngstrom, expected.gradientNormKcalPerAngstrom)).toBe(true);
  expectSameNumbers(actual.coords, expected.coords, 'coords');
  expect(actual.atoms).toHaveLength(expected.atoms.length);
  actual.atoms.forEach((atom, index) => {
    expect(atom.element).toBe(expected.atoms[index].element);
    expect(Object.is(atom.x, expected.atoms[index].x)).toBe(true);
    expect(Object.is(atom.y, expected.atoms[index].y)).toBe(true);
    expect(Object.is(atom.z, expected.atoms[index].z)).toBe(true);
  });
}

function expectSameEnsemble(actual, expected) {
  expect(actual.error).toBe(expected.error);
  expect(actual.ensembleText).toBe(expected.ensembleText);
  expect(JSON.stringify(actual.energies)).toBe(JSON.stringify(expected.energies));
  expect(JSON.stringify(actual.summary)).toBe(JSON.stringify(expected.summary));
  expect(JSON.stringify(actual.members)).toBe(JSON.stringify(expected.members));
}

/* ── identical results ─────────────────────────────────────── */

describe('UFF off the main thread: identical results (issue #369)', () => {
  it('relaxes one structure through the worker with the same bits as optimizeUff', async () => {
    const molecule = alkane(4);
    const options = { maxIterations: 300 };
    const expected = optimizeUff(molecule, options);
    const { result, cacheHit, mode } = await executor({ mode: 'worker' })
      .run({ kind: 'relax', molecule, options }, { jobId: 'identical-relax' });
    expect(mode).toBe('worker');
    expect(cacheHit).toBe(false);
    expectSameRelaxation(result, expected);
  });

  it('generates the same ensemble text through the worker as generateUffEnsemble', async () => {
    const molecule = alkane(4);
    const input = {
      atoms: molecule.atoms,
      bonds: molecule.bonds,
      torsionStepDegrees: 120,
      maxTrials: 6,
      rmsdThreshold: 0.1,
      relaxMaxIterations: 80,
      energyWindowKcal: 10,
      maxConformers: 20,
      temperature: 298.15,
      spreadThresholdKcal: 2,
      selectedConformerId: '',
    };
    const expected = generateUffEnsemble(structuredClone(input));
    const { result } = await executor({ mode: 'worker' })
      .run({ kind: 'search', input }, { jobId: 'identical-search' });
    expectSameEnsemble(result, expected);
  });

  it('keeps the yielding in-process driver bit-identical to the synchronous one', async () => {
    const molecule = alkane(5);
    const options = { maxIterations: 300 };
    const expected = optimizeUff(molecule, options);
    const yielded = await optimizeUffAsync(molecule, { ...options, yieldEvery: 7 });
    expectSameRelaxation(yielded, expected);

    const input = {
      atoms: molecule.atoms,
      bonds: molecule.bonds,
      torsionStepDegrees: 180,
      maxTrials: 4,
      relaxMaxIterations: 120,
    };
    const expectedEnsemble = generateUffEnsemble(structuredClone(input));
    const yieldedEnsemble = await generateUffEnsembleAsync(structuredClone(input));
    expectSameEnsemble(yieldedEnsemble, expectedEnsemble);
  });

  it('matches generateUffEnsemble on a shipped SDF fixture molecule', async () => {
    const text = await fsp.readFile(
      path.join(ROOT, 'test/fixtures/structures/pubchem-5molecules.sdf'),
      'utf8',
    );
    const record = parseStructure(text.split('$$$$')[0], { filename: 'aspirin.sdf' });
    expect(record.error).toBeUndefined();
    const input = {
      atoms: record.atoms,
      bonds: record.bonds,
      torsionStepDegrees: 180,
      maxTrials: 4,
      rmsdThreshold: 0.5,
      relaxMaxIterations: 120,
    };
    const expected = generateUffEnsemble(structuredClone(input));
    expect(expected.error).toBeNull();
    const { result } = await executor({ mode: 'worker' })
      .run({ kind: 'search', input }, { jobId: 'fixture-search' });
    expectSameEnsemble(result, expected);
    expect(result.ensembleText).toMatch(/UFF conformer 1/);
  });

  it('falls back to the yielding path when the worker cannot load', async () => {
    const fallbacks = [];
    const instance = executor({
      mode: 'auto',
      workerUrl: new URL('./no-such-worker-file.js', import.meta.url),
    });
    const molecule = distortedWater();
    const options = { maxIterations: 60 };
    const { result } = await instance.run(
      { kind: 'relax', molecule, options },
      { jobId: 'fallback', onFallback: (error) => fallbacks.push(error) },
    );
    expect(fallbacks).toHaveLength(1);
    expect(instance.stats.workerFallbacks).toBe(1);
    expect(instance.stats.yieldRuns).toBe(1);
    expectSameRelaxation(result, optimizeUff(molecule, options));
  });
});

/* ── progress and cancellation ─────────────────────────────── */

describe('UFF off the main thread: progress and cancellation (issue #369)', () => {
  it('reports progress events that carry the iteration count', async () => {
    const seen = [];
    const { result } = await executor({ mode: 'worker', progressEvery: 3 })
      .run(
        { kind: 'relax', molecule: alkane(4), options: { maxIterations: 200 } },
        { jobId: 'progress', onProgress: (event) => seen.push(event) },
      );
    expect(result.iterations).toBeGreaterThan(3);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0].phase).toBe('relax');
    expect(seen[0].iteration).toBe(1);
    expect(seen.every((event) => Number.isInteger(event.iteration) && event.iteration >= 1)).toBe(true);
    expect(seen.some((event) => event.iteration > 1)).toBe(true);
    expect(seen.every((event) => Number.isFinite(event.energyKcal))).toBe(true);
  });

  it('carries the trial index as well as the iteration during a search', async () => {
    const seen = [];
    await executor({ mode: 'worker', progressEvery: 5 })
      .run(
        {
          kind: 'search',
          input: {
            atoms: alkane(5).atoms,
            bonds: alkane(5).bonds,
            torsionStepDegrees: 180,
            maxTrials: 4,
            relaxMaxIterations: 60,
          },
        },
        { jobId: 'search-progress', onProgress: (event) => seen.push(event) },
      );
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen.every((event) => event.trial >= 1 && event.trial <= 4)).toBe(true);
    expect(new Set(seen.map((event) => event.trial)).size).toBe(4);
    expect(seen.every((event) => Number.isInteger(event.iteration) && event.iteration >= 1)).toBe(true);
  });

  it('stops a worker search within one iteration batch', async () => {
    const instance = executor({ mode: 'worker' });
    let firstProgress;
    const progressSeen = new Promise((resolve) => { firstProgress = resolve; });

    const run = instance.run(
      {
        kind: 'search',
        input: {
          atoms: molecule48().atoms,
          bonds: molecule48().bonds,
          torsionStepDegrees: 120,
          maxTrials: 200,
          relaxMaxIterations: 500,
        },
      },
      {
        jobId: 'cancel-me',
        onProgress: () => {
          firstProgress?.();
          firstProgress = null;
        },
      },
    );
    await progressSeen;
    const cancelStarted = Date.now();
    expect(instance.cancel('cancel-me')).toBe(true);
    const outcome = await run;
    const elapsed = Date.now() - cancelStarted;
    expect(outcome.result.cancelled).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });

  it('stops the yielding driver when shouldCancel turns true', async () => {
    let calls = 0;
    await expect(optimizeUffAsync(alkane(4), {
      maxIterations: 500,
      yieldEvery: 3,
      shouldCancel: () => { calls += 1; return calls > 2; },
    })).rejects.toMatchObject({ code: 'uff-cancelled' });
  });
});

/* ── the cache ─────────────────────────────────────────────── */

describe('UFF off the main thread: input-hash LRU (issue #369)', () => {
  it('turns a retry into a lookup and does not start a second worker', async () => {
    const instance = executor({ mode: 'worker', cacheSize: 4 });
    const job = { kind: 'relax', molecule: alkane(4), options: { maxIterations: 120 } };
    const first = await instance.run(job, { jobId: 'retry-1' });
    const second = await instance.run(job, { jobId: 'retry-2' });
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(instance.stats.workerRuns).toBe(1);
    expect(instance.stats.cacheHits).toBe(1);
    expectSameRelaxation(second.result, first.result);
  });

  it('separates different options and evicts the least recently used entry', async () => {
    const instance = executor({ mode: 'worker', cacheSize: 1 });
    const molecule = distortedWater();
    const first = { kind: 'relax', molecule, options: { maxIterations: 5 } };
    const second = { kind: 'relax', molecule, options: { maxIterations: 6 } };
    expect((await instance.run(first, { jobId: 'evict-1' })).cacheHit).toBe(false);
    expect((await instance.run(second, { jobId: 'evict-2' })).cacheHit).toBe(false);
    expect(instance.cacheSize).toBe(1);
    expect((await instance.run(first, { jobId: 'evict-3' })).cacheHit).toBe(false);
    expect(instance.stats.cacheMisses).toBe(3);
  });

  it('hashes atom and bond content, not object key order', () => {
    const plain = { kind: 'relax', molecule: alkane(2), options: { maxIterations: 10 } };
    const shuffled = {
      kind: 'relax',
      molecule: {
        atoms: plain.molecule.atoms.map((atom) => ({ z: atom.z, element: atom.element, y: atom.y, x: atom.x })),
        bonds: plain.molecule.bonds.map((bond) => ({ order: bond.order, b: bond.b, a: bond.a })),
      },
      options: { maxIterations: 10 },
    };
    expect(uffInputHash(shuffled)).toBe(uffInputHash(plain));
    const moved = structuredClone(plain);
    moved.molecule.atoms[0].x += 0.001;
    expect(uffInputHash(moved)).not.toBe(uffInputHash(plain));
  });
});

/* ── main-thread responsiveness ────────────────────────────── */

const searchJob48 = () => ({
  kind: 'search',
  input: {
    atoms: molecule48().atoms,
    bonds: molecule48().bonds,
    torsionStepDegrees: 120,
    maxTrials: 200,
    rmsdThreshold: 0.5,
    relaxMaxIterations: 3,
    energyWindowKcal: 10,
    maxConformers: 20,
    temperature: 298.15,
    spreadThresholdKcal: 2,
    selectedConformerId: '',
  },
});

/** Gaps between 5 ms timer ticks while `run()` is awaited. */
async function heartbeatGaps(run) {
  const gaps = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
  }, 5);
  try {
    await run();
  } finally {
    clearInterval(timer);
    gaps.push(performance.now() - last);
  }
  return gaps;
}

/** Nearest-rank percentile; `p` is 0…1. Mutates nothing. */
function percentile(gaps, p) {
  const sorted = [...gaps].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

describe('UFF off the main thread: responsiveness (issue #369)', () => {
  it('answers a 5 ms heartbeat during a 200-candidate, 48-atom worker search', async () => {
    const instance = executor({ mode: 'worker' });
    let outcome = null;
    const gaps = await heartbeatGaps(async () => {
      outcome = await instance.run(searchJob48(), { jobId: 'responsive-worker' });
    });
    expect(outcome.result.error).toBeNull();
    expect(outcome.result.search.trials).toBe(200);
    expect(outcome.result.search.rotatableBonds).toBeGreaterThan(5);
    // A blocked main thread blocks every tick; a loaded CI runner delays one.
    // p95 is the responsiveness claim (the issue's 50 ms bound), and the max
    // ceiling stays well under the sync path's single ~1 s block so a real
    // regression still fails here (measured 8 ms idle / 135 ms worst on CI).
    expect(percentile(gaps, 0.95)).toBeLessThan(50);
    expect(Math.max(...gaps)).toBeLessThan(250);
  }, 30000);

  it('proves the heartbeat measurement bites when the worker/yield path is disabled', async () => {
    const instance = executor({ mode: 'sync' });
    const gaps = await heartbeatGaps(() => instance.run(searchJob48(), { jobId: 'responsive-sync' }));
    // The pre-#369 call blocks the thread for the whole search (~1.7 s here):
    // almost every tick is one gap, far above the 50 ms acceptance bound.
    expect(percentile(gaps, 0.95)).toBeGreaterThan(200);
  }, 30000);
});
