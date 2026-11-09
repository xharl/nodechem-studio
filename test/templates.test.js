import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKFLOW_TEMPLATES,
  blankProject,
  templateProject,
} from '../src/shared/templates.js';
import { parseProjectText, validateProject } from '../src/shared/projectSchema.js';

/**
 * Why: the templates are the first graph a new user sees, and examples/*.ncs
 * are public files that can drift from the code that generated them. These
 * checks pin the contract — schema-valid, deterministic, non-overlapping
 * layout — and fail if a checked-in example stops matching its recipe.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Keep in step with `.node { width: 216px; height: 112px; }` in styles.css. */
const NODE_W = 216;
const NODE_H = 112;

describe('workflow templates — schema', () => {
  it('validates every template with zero errors', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const result = validateProject(templateProject(template.id));
      expect(result.errors, template.id).toEqual([]);
      expect(result.ok, template.id).toBe(true);
    }
  });

  it('lists the recipes in the promised order with honest metadata', () => {
    expect(WORKFLOW_TEMPLATES.map((template) => template.id))
      .toEqual(['opt-freq', 'ts-search', 'emission', 'single-point']);
    for (const template of WORKFLOW_TEMPLATES) {
      const project = templateProject(template.id);
      expect(template.blockCount, template.id).toBe(project.nodes.length);
      expect(template.name.length, template.id).toBeGreaterThan(0);
      expect(template.description, template.id).not.toMatch(/[\r\n]/);
    }
  });

  it('keeps node ids unique across every template', () => {
    const ids = WORKFLOW_TEMPLATES.flatMap((template) => (
      templateProject(template.id).nodes.map((node) => node.id)
    ));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('places every block on the canvas without overlap', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const nodes = templateProject(template.id).nodes;
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i];
          const b = nodes[j];
          const clear = a.x + NODE_W <= b.x
            || b.x + NODE_W <= a.x
            || a.y + NODE_H <= b.y
            || b.y + NODE_H <= a.y;
          expect(clear, `${template.id}: ${a.id} overlaps ${b.id}`).toBe(true);
        }
      }
    }
  });

  it('returns a fresh, deterministic project object', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const first = templateProject(template.id);
      const second = templateProject(template.id);
      expect(first).toEqual(second);
      expect(first).not.toBe(second);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    }
  });

  it('normalizes a name override like the schema does', () => {
    const project = templateProject('opt-freq', { name: '  My   project\n' });
    expect(project.name).toBe('My project');
    expect(validateProject(project).ok).toBe(true);
  });

  it('rejects an unknown template id', () => {
    expect(() => templateProject('no-such-recipe')).toThrow(/Unknown workflow template/);
  });
});

describe('workflow templates — recipe contract', () => {
  it('opt-freq requires termination, SCF and a final energy on both blocks', () => {
    const project = templateProject('opt-freq');
    const [opt, freq] = project.nodes;
    expect(opt.settings.jobType).toBe('Opt');
    expect(freq.settings.jobType).toBe('Freq');
    expect(opt.settings.gates).toMatchObject({ termination: true, scf: true, finalEnergy: true });
    expect(freq.settings.gates).toMatchObject({
      termination: true, scf: true, finalEnergy: true, imaginary: 0,
    });
    // A checkpoint edge: without it the frequency block re-runs the input
    // geometry and both gates still pass.
    expect(project.edges).toEqual([
      { from: 'of-opt', to: 'of-freq', type: 'checkpoint', fromPort: 'bottom', toPort: 'top' },
    ]);
    expect(freq.checkpointFrom).toBe('of-opt');
  });

  it('ts-search uses Opt=TS/CalcFC and verifies exactly one imaginary mode', () => {
    const project = templateProject('ts-search');
    const tsOpt = project.nodes.find((node) => node.id === 'ts-opt');
    const tsFreq = project.nodes.find((node) => node.id === 'ts-freq');
    expect(tsOpt.settings.jobType).toBe('Opt=TS');
    expect(tsOpt.settings.forceConstants).toBe('CalcFC');
    expect(tsFreq.settings.jobType).toBe('Freq');
    expect(tsFreq.settings.gates).toMatchObject({ imaginary: 1, minMagnitude: 50 });
    expect(tsFreq.checkpointFrom).toBe('ts-opt');
    expect(project.edges).toContainEqual({
      from: 'ts-opt', to: 'ts-freq', type: 'checkpoint', fromPort: 'bottom', toPort: 'top',
    });
    expect(project.nodes.some((node) => node.type === 'note')).toBe(true);
  });

  it('single-point asks for NBO charges and sets no frequency gate', () => {
    const project = templateProject('single-point');
    const [node] = project.nodes;
    expect(node.settings.jobType).toBe('SP');
    expect(node.settings.population).toBe('NBO');
    expect(node.settings.gates.imaginary).toBeNull();
    expect(node.settings.gates.thermo).toBe(false);
    expect(project.edges).toEqual([]);
  });

  it('blankProject is one default calculation block and nothing else', () => {
    const project = blankProject();
    expect(validateProject(project).ok).toBe(true);
    expect(project.nodes).toHaveLength(1);
    expect(project.edges).toEqual([]);
    expect(project.nodes[0].type).toBe('calculate');
    expect(project.nodes[0].title).toBe('Reactant optimization');
    expect(project.nodes[0].settings.jobType).toBe('Opt');
  });
});

describe('workflow templates — public examples', () => {
  it('ships one example per template that parses and deep-equals the recipe', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const rel = `examples/${template.id}.ncs`;
      expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true);
      const result = parseProjectText(read(rel));
      expect(result.errors, rel).toEqual([]);
      expect(result.project, rel).toEqual(templateProject(template.id));
    }
  });
});
