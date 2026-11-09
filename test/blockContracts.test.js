import { describe, expect, it } from 'vitest';
import { BLOCK_CONTRACTS, validateBlockContracts } from '../src/shared/blockContracts.js';

/**
 * ADR 0001 §4: one table, one test per rule. These tests exercise the table
 * directly; `projectSchema` runs it over every flow, so a violation is refused
 * when the project opens rather than when the queue reaches the block.
 */

const node = (id, type, extra = {}) => ({ id, type, title: id, ...extra });
const edge = (from, to, type = 'dependency') => ({ from, to, type });
const flow = (nodes, edges = []) => ({ id: 'main', nodes, edges });

const errorsFor = (graph) => validateBlockContracts(graph).errors;

describe('block contracts (ADR 0001 §4)', () => {
  it('input: no structure edges in', () => {
    const graph = flow([
      node('calc', 'calculate'),
      node('in', 'input', { input: {} }),
    ], [edge('calc', 'in')]);
    expect(errorsFor(graph).some((entry) => /no structure edges in/.test(entry.message))).toBe(true);
    expect(validateBlockContracts(flow([node('in', 'input', { input: {} }), node('calc', 'calculate')], [edge('in', 'calc')])).errors)
      .toHaveLength(0);
  });

  it('prepare: exactly one structure in, and no method settings', () => {
    const graph = flow([
      node('a', 'calculate'),
      node('b', 'calculate'),
      node('prep', 'prepare', { settings: { kind: 'relax' } }),
    ], [edge('a', 'prep'), edge('b', 'prep')]);
    expect(errorsFor(graph).some((entry) => /one structure in/.test(entry.message))).toBe(true);

    const withRoute = flow([
      node('a', 'calculate'),
      node('prep', 'prepare', { settings: { kind: 'relax', method: 'B3LYP' } }),
    ], [edge('a', 'prep')]);
    expect(errorsFor(withRoute).some((entry) => /no method settings/.test(entry.message))).toBe(true);
  });

  it('generate: one structure (search) or one ensemble (imported)', () => {
    const searchWithEnsemble = flow([
      node('ens', 'input', { input: { kind: 'ensemble' } }),
      node('gen', 'generate', { settings: { source: 'search' } }),
    ], [edge('ens', 'gen')]);
    expect(errorsFor(searchWithEnsemble).some((entry) => /set source to "imported"/.test(entry.message))).toBe(true);

    const importedWithoutEnsemble = flow([
      node('calc', 'calculate'),
      node('gen', 'generate', { settings: { source: 'imported' } }),
    ], [edge('calc', 'gen')]);
    expect(errorsFor(importedWithoutEnsemble).some((entry) => /exactly one ensemble input/.test(entry.message))).toBe(true);

    const ok = flow([
      node('ens', 'input', { input: { kind: 'ensemble' } }),
      node('gen', 'generate', { settings: { source: 'imported' } }),
    ], [edge('ens', 'gen')]);
    expect(validateBlockContracts(ok).errors).toHaveLength(0);
  });

  it('calculate: one structure in, engine/executable/method by schema', () => {
    const graph = flow([
      node('a', 'calculate'),
      node('b', 'calculate'),
      node('calc', 'calculate', { settings: { engine: 'gaussian' } }),
    ], [edge('a', 'calc'), edge('b', 'calc')]);
    const report = validateBlockContracts(graph);
    expect(report.errors).toHaveLength(0);
    expect(report.warnings.some((entry) => /more than one structure/.test(entry.message))).toBe(true);
  });

  it('analyse: one or more records in, no program', () => {
    const graph = flow([node('an', 'analyse', { analyse: { expression: 'E' } })]);
    expect(validateBlockContracts(graph).warnings.some((entry) => /no record input/.test(entry.message))).toBe(true);
    const ok = flow([
      node('calc', 'calculate'),
      node('an', 'analyse', { analyse: { expression: 'E' } }),
    ], [edge('calc', 'an')]);
    expect(validateBlockContracts(ok).errors).toHaveLength(0);
  });

  it('output: one or more records in, nothing downstream', () => {
    const graph = flow([
      node('calc', 'calculate'),
      node('out', 'output'),
      node('note', 'note'),
    ], [edge('calc', 'out'), edge('out', 'note')]);
    expect(errorsFor(graph).some((entry) => /terminal/.test(entry.message))).toBe(true);
  });

  it('control: payload unchanged', () => {
    const graph = flow([node('if', 'condition', { settings: { method: 'B3LYP' } })]);
    const report = validateBlockContracts(graph);
    expect(report.errors).toHaveLength(0);
    expect(report.warnings.some((entry) => /calculation settings/.test(entry.message))).toBe(true);
  });

  it('annotation: no payload', () => {
    expect(BLOCK_CONTRACTS.note.reads).toBe('nothing');
    expect(BLOCK_CONTRACTS.note.writes).toBe('nothing');
    expect(BLOCK_CONTRACTS.note.spawnsEngine).toBe(false);
  });
});
