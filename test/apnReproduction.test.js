import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseProjectText } from '../src/shared/projectSchema.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';

/**
 * A reproduction of a published protocol, pinned to the paper's own words.
 *
 * Source: Molecules 2024, 29(8), 1808, "Synthesis, Cytotoxicity, and
 * Photophysical Investigations of 2-Amino-4,6-diphenylnicotinonitriles"
 * (open access, CC BY 4.0), section 3.4:
 *
 *   "optimized at the DFT/b3lyp/6-311++g(d,p) level using Gaussian 16 …
 *    further TD-DFT calculation … computing 5 singlet excited states … with the
 *    solvent polarizable continuum model (PCM) in toluene, tetrahydrofuran
 *    (THF), dichloromethane (DCM), dimethyl sulfoxide (DMSO), and methanol …
 *    A vibrational analysis was carried out for each optimized molecule to
 *    ensure that they were at a vibrational energy minimum."
 *
 * The assertions below fail if the project drifts from that protocol.
 */
const file = readFileSync(new URL('../examples/apn-fluorescence.ncs', import.meta.url), 'utf8');
const parsed = parseProjectText(file);

const routeOf = (nodeId) => {
  const plan = buildWorkflowPlan(parsed.project);
  const task = plan.tasks.find((item) => item.nodeId === nodeId);
  if (!task) throw new Error(`no task ${nodeId}`);
  return task.inputText;
};

describe('APN 1 reproduction (Molecules 2024, 29, 1808)', () => {
  it('validates', () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.project.molecule.coords).toHaveLength(34);
  });

  it('uses the molecule the paper calls compound 1: C18H13N3', () => {
    const counts = parsed.project.molecule.coords.reduce((acc, atom) => {
      acc[atom.element] = (acc[atom.element] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ C: 18, H: 13, N: 3 });
    expect(parsed.project.molecule.charge).toBe(0);
    expect(parsed.project.molecule.multiplicity).toBe(1);
  });

  it('optimises at B3LYP/6-311++G(d,p) with no dispersion correction', () => {
    const route = routeOf('apn-opt');
    expect(route).toContain('B3LYP/6-311++G(d,p)');
    expect(route).toMatch(/\bOpt\b/);
    // The paper states a plain B3LYP route; D3 would be a deviation.
    expect(route).not.toContain('EmpiricalDispersion');
  });

  it('runs a frequency job that requires zero imaginary modes', () => {
    const route = routeOf('apn-freq');
    expect(route).toMatch(/\bFreq\b/);
    expect(parsed.project.nodes.find((node) => node.id === 'apn-freq').settings.gates.imaginary).toBe(0);
  });

  it.each([
    ['toluene', 'Toluene'],
    ['thf', 'THF'],
    ['dcm', 'Dichloromethane'],
    ['dmso', 'DMSO'],
    ['meoh', 'Methanol'],
  ])('runs five singlet states in PCM %s', (slug, solvent) => {
    const route = routeOf(`apn-td-${slug}`);
    expect(route).toContain('TD=(NStates=5)');
    expect(route).toContain(`SCRF=(PCM,Solvent=${solvent})`);
    expect(route).toContain('B3LYP/6-311++G(d,p)');
    // The TD step is single-point at the optimised geometry, read from the chk.
    expect(route).toContain('Geom=Check');
    expect(route).toContain('Guess=Read');
  });

  it('reads every TD geometry from the optimised checkpoint', () => {
    for (const slug of ['toluene', 'thf', 'dcm', 'dmso', 'meoh']) {
      const node = parsed.project.nodes.find((item) => item.id === `apn-td-${slug}`);
      expect(node.checkpointFrom).toBe('apn-freq');
    }
    expect(parsed.project.nodes.find((node) => node.id === 'apn-freq').checkpointFrom).toBe('apn-opt');
  });

  it('ships a note block so the canvas states what it does and does not claim', () => {
    const note = parsed.project.nodes.find((node) => node.type === 'note');
    expect(note.note.text).toContain('Molecules 2024');
    expect(note.note.text).toContain('No result is claimed');
  });
});
