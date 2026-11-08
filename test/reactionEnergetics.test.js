import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  deltaGDoubleDagger,
  ircGate,
  pKaFromCycle,
  parseIrcSummary,
  parseScanSummary,
  pathBarrier,
  scanExtremum,
  scanSurfaceSvg,
} from '../src/shared/reactionPath.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';
import { QueueManager } from '../electron/runner/queue.js';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/real/${name}`, import.meta.url)), 'utf8');

describe('IRC gate — real Gaussian 16 path', () => {
  const irc = parseIrcSummary(fixture('g16-h4s2-irc.log'));

  it('passes a path that crosses one barrier and descends on both sides', () => {
    const gate = ircGate(irc);
    expect(gate.status).toBe('pass');
    const byId = Object.fromEntries(gate.checks.map((check) => [check.id, check.status]));
    expect(byId['path-present']).toBe('pass');
    expect(byId['single-maximum']).toBe('pass');
    expect(byId['endpoints-below-maximum']).toBe('pass');
  });

  it('does not claim the endpoints are minima', () => {
    const gate = ircGate(irc);
    const check = gate.checks.find((entry) => entry.id === 'endpoint-is-a-minimum');
    expect(check.status).toBe('unknown');
    expect(check.detail).toMatch(/needs a frequency job/);
  });

  it('is unknown when the job has no IRC summary', () => {
    expect(ircGate(null).status).toBe('unknown');
    expect(ircGate({ points: [] }).status).toBe('unknown');
  });

  it('fails a path whose maximum is on an endpoint', () => {
    const record = {
      kind: 'irc',
      points: [
        { point: 1, rxCoord: -1, energyHartree: -100 },
        { point: 2, rxCoord: 0, energyHartree: -100.02 },
        { point: 3, rxCoord: 1, energyHartree: -100.05 },
      ],
    };
    const gate = ircGate(record);
    expect(gate.status).toBe('fail');
    expect(gate.checks.find((check) => check.id === 'maximum-in-interior').status).toBe('unknown');
  });
});

describe('scan extremum', () => {
  it('fits a parabola through the neighbours of a one-dimensional maximum', () => {
    const record = parseScanSummary(fixture('scan-unrelaxed.log'));
    const extremum = scanExtremum(record);
    expect(extremum.method).toBe('parabolic-fit');
    expect(extremum.interpolated).toBe(true);
    expect(extremum.vertexX).toBeCloseTo(0, 6);
    expect(extremum.neighbours).toHaveLength(3);
  });

  it('reports a two-dimensional scan as the highest grid node, with no interpolation', () => {
    const record = parseScanSummary(fixture('scan-relaxed.log'));
    const extremum = scanExtremum(record);
    expect(extremum.dimension).toBe(2);
    expect(extremum.method).toBe('grid-node');
    expect(extremum.interpolated).toBe(false);
    expect(extremum.note).toMatch(/no interpolation/i);
  });

  it('draws a surface only when the grid has at least four nodes', () => {
    expect(scanSurfaceSvg(parseScanSummary(fixture('scan-relaxed.log')))).toBe('');
    const grid = {
      kind: 'relaxed',
      parameterNames: ['R1', 'R2'],
      points: [
        { point: 1, energyHartree: -100.0, parameters: { R1: 1.0, R2: 1.0 } },
        { point: 2, energyHartree: -100.01, parameters: { R1: 1.1, R2: 1.0 } },
        { point: 3, energyHartree: -100.02, parameters: { R1: 1.0, R2: 1.1 } },
        { point: 4, energyHartree: -100.03, parameters: { R1: 1.1, R2: 1.1 } },
      ],
    };
    const svg = scanSurfaceSvg(grid);
    expect(svg).toContain('data-field="scan-surface"');
    expect((svg.match(/<rect/g) || []).length).toBe(4);
  });
});

describe('barrier context', () => {
  it('carries the level of theory and the treatment, and null when they are not known', () => {
    const record = parseScanSummary(fixture('scan-unrelaxed.log'));
    const bare = pathBarrier(record);
    expect(bare.levelOfTheory).toBeNull();
    expect(bare.thermochemicalTreatment).toBeNull();
    const contexted = pathBarrier(record, { levelOfTheory: 'B3LYP/def2-SVP', thermochemicalTreatment: 'harmonic frequencies' });
    expect(contexted.levelOfTheory).toBe('B3LYP/def2-SVP');
    expect(contexted.thermochemicalTreatment).toBe('harmonic frequencies');
  });
});

describe('ΔG‡', () => {
  it('subtracts the reactant free energy from the transition state', () => {
    const result = deltaGDoubleDagger({
      transitionState: { thermochemistry: { freeEnergyHartree: -100, temperatureK: 298.15 } },
      reactant: { thermochemistry: { freeEnergyHartree: -100.02 } },
    });
    expect(result.available).toBe(true);
    expect(result.kcalPerMol).toBeCloseTo(0.02 * 627.5094740631, 6);
    expect(result.scheme).toMatch(/ΔG‡ = G\(TS\) − G\(reactant\)/);
    expect(result.temperatureK).toBe(298.15);
  });

  it('refuses to compute one when either side has no free energy', () => {
    const result = deltaGDoubleDagger({
      transitionState: { thermochemistry: { freeEnergyHartree: -100 } },
      reactant: { thermochemistry: {} },
    });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/the reactant has none/);
  });
});

describe('pKa from an isodesmic cycle', () => {
  it('uses the module constant and states the solvent, standard state and reference', () => {
    const result = pKaFromCycle({
      deltaGDeprotonationKcal: 20,
      deltaGReferenceKcal: 18,
      referencePKa: 4.76,
      solvent: 'water',
    });
    expect(result.available).toBe(true);
    expect(result.pKa).toBeCloseTo(4.76 + 2 / 1.364, 6);
    expect(result.solvent).toBe('water');
    expect(result.standardState).toEqual({ temperatureK: 298.15, pressureAtm: 1 });
    expect(result.reference).toEqual({ pKa: 4.76, deltaGReferenceKcal: 18 });
  });

  it('names what is missing instead of returning a number', () => {
    const result = pKaFromCycle({ deltaGDeprotonationKcal: 20 });
    expect(result.available).toBe(false);
    expect(result.missing).toContain('the solvent');
    expect(result.reason).toMatch(/A pKa needs/);
  });
});

describe('the queue and the report', () => {
  const manager = () => new QueueManager({
    queuesRoot: '/tmp/ncs-reaction-test',
    runManager: { onEvent: () => () => {} },
    emit: () => {},
  });

  it('computes ΔG‡ once the transition state and reactant runs are finished', async () => {
    const queue = {
      id: 'q',
      reactions: {},
      tasks: [
        { nodeId: 'ts', status: 'completed', parsedSummary: { freeEnergyHartree: -100 } },
        { nodeId: 'r', status: 'completed', parsedSummary: { freeEnergyHartree: -100.02 } },
        { nodeId: 'irc', status: 'completed', reaction: { transitionStateNodeId: 'ts', reactantNodeId: 'r' }, parsedSummary: {} },
      ],
    };
    await manager().evaluateReactions(queue);
    expect(queue.reactions.irc.available).toBe(true);
    expect(queue.reactions.irc.kcalPerMol).toBeCloseTo(12.5502, 3);
  });

  it('writes a reason, not a number, when the reactant is undeclared', async () => {
    const queue = {
      id: 'q',
      reactions: {},
      tasks: [
        { nodeId: 'ts', status: 'completed', parsedSummary: { freeEnergyHartree: -100 } },
        { nodeId: 'irc', status: 'completed', reaction: { transitionStateNodeId: 'ts', reactantNodeId: null }, parsedSummary: {} },
      ],
    };
    await manager().evaluateReactions(queue);
    expect(queue.reactions.irc.available).toBe(false);
    expect(queue.reactions.irc.reason).toMatch(/reactant has none/);
  });

  it('renders the ΔG‡ block with its scheme', () => {
    const model = buildWorkflowReport({
      id: 'q-react',
      projectName: 'Reaction',
      status: 'completed',
      tasks: [{ nodeId: 'irc', title: 'IRC', status: 'completed' }],
      reactions: {
        irc: {
          available: true,
          kcalPerMol: 12.55,
          temperatureK: 298.15,
          scheme: 'ΔG‡ = G(TS) − G(reactant), both from frequency calculations at the same level of theory',
          transitionStateNodeId: 'ts',
          reactantNodeId: 'r',
        },
      },
    }, {});
    const html = workflowReportHtml(model);
    expect(html).toContain('Reaction energetics — irc');
    expect(html).toContain('ΔG‡ = 12.55 kcal mol⁻¹');
    expect(html).toContain('both from frequency calculations');
  });
});
