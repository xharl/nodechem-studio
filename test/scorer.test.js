import { describe, expect, it, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EV_TO_HARTREE,
  EV_TO_KCAL,
  framesForScorerRanking,
  kendallTau,
  normalizeScorerResult,
  scorerDomainFindings,
} from '../src/shared/scorer.js';
import { validateProject } from '../src/shared/projectSchema.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';

/**
 * ADR 0001 §2.10 — a scorer is a role, not an engine. These tests pin the three
 * rules that make it safe to use one: the domain guard refuses by name, the eV
 * conversions are explicit, and a result without provenance is not a result.
 */

const water = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.96, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.93, z: 0 },
];

const provenance = {
  model: 'aimnet2',
  version: '2.0.0',
  weightsSha256: 'b'.repeat(64),
  dtype: 'float32',
  device: 'cpu',
  cutoffAngstrom: 5,
  charge: 0,
  multiplicity: 1,
};

describe('scorer role (ADR 0001 §2.10)', () => {
  it('refuses an element outside the model card before any spawn', () => {
    const report = scorerDomainFindings({
      spec: 'ml:aimnet2',
      atoms: [...water, { element: 'Fe', x: 2, y: 2, z: 2 }],
      charge: 0,
      multiplicity: 1,
    });
    expect(report.errors.some((message) => /Fe/.test(message))).toBe(true);
  });

  it('refuses a charge and a spin the model does not cover', () => {
    const charge = scorerDomainFindings({ spec: 'ml:aimnet2', atoms: water, charge: 4, multiplicity: 1 });
    expect(charge.errors.some((message) => /net charge/.test(message))).toBe(true);
    const spin = scorerDomainFindings({ spec: 'ml:aimnet2', atoms: water, charge: 0, multiplicity: 3 });
    expect(spin.errors.some((message) => /closed-shell/.test(message))).toBe(true);
  });

  it('converts eV explicitly and refuses a result with no provenance', () => {
    const raw = {
      ...provenance,
      results: [{ id: 'c1', energyEv: -1 }],
    };
    const scored = normalizeScorerResult(raw, { spec: 'ml:aimnet2', frameIds: ['c1'] });
    expect(scored.error).toBeNull();
    expect(scored.results[0].energyKcal).toBeCloseTo(-EV_TO_KCAL, 9);
    expect(scored.results[0].energyHartree).toBeCloseTo(-EV_TO_HARTREE, 12);
    expect(scored.provenance.comparableWithQuantumChemistry).toBe(false);

    const missing = normalizeScorerResult({ results: [{ id: 'c1', energyEv: -1 }] }, {
      spec: 'ml:aimnet2', frameIds: ['c1'],
    });
    expect(missing.error).toMatch(/provenance/);
  });

  it('puts the converted energy in the ranking frame and keeps the eV value', () => {
    const scored = normalizeScorerResult({
      ...provenance,
      results: [{ id: 'c1', energyEv: -2 }],
    }, { spec: 'ml:aimnet2', frameIds: ['c1'] });
    const frames = framesForScorerRanking([{ id: 'c1', atoms: water }], scored);
    expect(frames[0].energyEh).toBeCloseTo(-2 * EV_TO_HARTREE, 12);
    expect(frames[0].scorer.energyEv).toBe(-2);
    expect(frames[0].energyMethod).toBe('AIMNet2');
  });

  it('computes Kendall tau for the reordering benchmark', () => {
    expect(kendallTau(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
    expect(kendallTau(['a', 'b', 'c'], ['c', 'b', 'a'])).toBe(-1);
    expect(kendallTau(['a', 'b'], ['a'])).toBeNull();
  });

  it('accepts rankBy in a generate block and refuses an unknown model', () => {
    const base = {
      schemaVersion: 3,
      name: 'Scorer',
      molecule: { charge: 0, multiplicity: 1, fragments: [], coords: water, geometry: { source: 'imported', file: 'w.xyz', format: 'xyz' } },
      defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
      nodes: [{ id: 'g', type: 'generate', title: 'Generate', state: 'ready', x: 0, y: 0, settings: { rankBy: 'ml:aimnet2' } }],
      edges: [],
    };
    expect(validateProject(base).ok).toBe(true);
    const bad = { ...base, nodes: [{ ...base.nodes[0], settings: { rankBy: 'ml:nope' } }] };
    expect(validateProject(bad).ok).toBe(false);
  });
});

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

async function stack() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ncs-scorer-'));
  roots.push(base);
  const queuesRoot = path.join(base, 'queues');
  const runsRoot = path.join(base, 'runs');
  await fsp.mkdir(runsRoot, { recursive: true });
  const runManager = new RunManager({ runsRoot, emit: () => {} });
  const queueManager = new QueueManager({ queuesRoot, runManager, emit: () => {} });
  await queueManager.init();
  return { base, queueManager };
}

async function waitFor(check, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for the queue');
}

describe('scorer runtime', () => {
  it('ranks an imported ensemble by the scorer and records its provenance', async () => {
    const { base, queueManager } = await stack();
    const ensemblePath = path.join(base, 'ensemble.xyz');
    await fsp.writeFile(ensemblePath, [
      '3', 'conformer 1 energy=-76.400000',
      'O 0 0 0', 'H 0.96 0 0', 'H -0.24 0.93 0', '',
      '3', 'conformer 2 energy=-76.395000',
      'O 0 0 0', 'H 0.96 0 0', 'H -0.24 1.70 0', '',
    ].join('\n'), 'utf8');

    const fake = path.join(base, 'scorer');
    await fsp.writeFile(fake, [
      '#!/usr/bin/env node',
      'let text = "";',
      'process.stdin.on("data", (c) => { text += c; });',
      'process.stdin.on("end", () => {',
      '  const req = JSON.parse(text);',
      '  // Reverse the incumbents: the second frame is lowest for the model.',
      '  const results = req.frames.map((frame, i) => ({ id: frame.id, energyEv: i === 0 ? -1 : -2 }));',
      '  process.stdout.write(JSON.stringify({',
      '    model: "aimnet2", version: "2.0.0", weightsSha256: "b".repeat(64),',
      '    dtype: "float32", device: "cpu", cutoffAngstrom: 5,',
      '    charge: req.charge, multiplicity: req.multiplicity, results,',
      '  }));',
      '});',
    ].join('\n'), { mode: 0o755 });

    const raw = {
      schemaVersion: 3,
      name: 'Scorer queue',
      molecule: { charge: 0, multiplicity: 1, fragments: [], coords: water, geometry: { source: 'imported', file: 'w.xyz', format: 'xyz' } },
      defaults: { method: 'B3LYP', basis: '6-31G(d)', memory: '4', memoryUnit: 'GB', nproc: '4' },
      nodes: [
        {
          id: 'ens', type: 'input', kind: 'Ensemble input', title: 'Imported', state: 'ready', x: 0, y: 0,
          input: {
            kind: 'ensemble', path: ensemblePath, format: 'xyz', energyUnit: 'hartree',
            energyMethod: 'GFN2-xTB', origin: { program: 'CREST', version: '3.0', method: 'GFN2-xTB' },
          },
        },
        {
          id: 'gen', type: 'generate', title: 'Ranked', state: 'ready', x: 200, y: 0,
          settings: { source: 'imported', rankBy: 'ml:aimnet2', rmsdThreshold: 0.01, energyWindowKcal: 100 },
          output: null,
        },
      ],
      edges: [{ id: 'e1', from: 'ens', to: 'gen', type: 'dependency' }],
    };
    const validated = validateProject(raw);
    expect(validated.ok).toBe(true);
    const plan = buildWorkflowPlan(validated.project);
    const started = await queueManager.start({
      projectName: validated.project.name,
      tasks: plan.tasks,
      edges: plan.edges,
      options: { dryRun: false, executable: null, crestExecutable: '', scorerExecutable: fake, scratchDir: '' },
    });
    const done = await waitFor(async () => {
      const queue = (await queueManager.list()).find((entry) => entry.id === started.id);
      return queue && queue.status !== 'running' ? queue : null;
    });
    const generated = done.tasks.find((entry) => entry.nodeId === 'gen');
    expect(generated.error).toBeNull();
    expect(generated.status).toBe('completed');
    expect(generated.ensemble.scorer.model).toBe('aimnet2');
    expect(generated.ensemble.scorer.comparableWithQuantumChemistry).toBe(false);
    expect(generated.ensemble.energyMethod).toBe('AIMNet2');
    expect(generated.ensemble.members[0].scorer.energyEv).toBe(-2);
    expect(generated.ensemble.members[0].scorer.energyKcal).toBeLessThan(0);
    expect(generated.ensemble.selected.id).toBe('c1');
  });
});
