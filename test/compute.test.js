import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  CBS_FORMULA,
  COMPUTE_FIELDS,
  COMPUTE_FUNCTIONS,
  ComputeError,
  HARTREE_TO_KCAL,
  computeInputsOf,
  describeCompute,
  evaluateCompute,
  evaluateExpression,
} from '../src/shared/compute.js';
import { DATASET_CSV_COLUMNS } from '../src/shared/datasetExport.js';
import {
  NODE_TYPES,
  defaultSettings,
  stringifyProject,
  validateProject,
} from '../src/shared/projectSchema.js';
import { buildWorkflowPlan, computeContext } from '../src/shared/workflowTasks.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';
import { resultsPanelHtml } from '../src/renderer/resultsView.js';

/**
 * Issue 175: the Compute block.
 *
 * The evaluator is tested as an evaluator — precedence, parentheses, the CBS fit
 * against arithmetic written out here, and every refusal by name — because a
 * wrong number in a protocol is worse than a missing one. The plan tests then
 * pin that the plan, the preview and the queue all go through the same
 * `evaluateCompute()`, so none of them can drift from the others.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const water = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.9572, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.927, z: 0 },
];

const molecule = () => ({
  smiles: '', charge: 0, multiplicity: 1, fragments: [], coords: water,
  geometry: { source: 'demo', file: '', format: '' },
});

const calc = (id, title = id) => ({
  id, type: 'calc', kind: 'SP', title, state: 'ready', x: 0, y: 0,
  settings: defaultSettings({ jobType: 'SP' }), output: null,
});

const computeNode = (expression, inputs, extra = {}) => ({
  id: 'cbs', type: 'compute', kind: 'Compute', title: 'CBS limit', state: 'ready', x: 0, y: 0,
  compute: { expression, inputs },
  ...extra,
});

function projectWith(nodes, edges, { datasets = [] } = {}) {
  return {
    schemaVersion: 2,
    name: 'Compute protocol',
    molecule: molecule(),
    defaults: { method: 'MP2', basis: 'cc-pVQZ', memory: '4', memoryUnit: 'GB', nproc: '4' },
    runner: { maxParallel: 1 },
    datasets,
    flows: [{ id: 'main', title: 'Protocol', nodes, edges }],
    reports: [],
    activeFlowId: 'main',
  };
}

/** A validated project, or a test failure listing the schema errors. */
function validated(raw) {
  const result = validateProject(raw);
  expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
  return result.project;
}

const runRecord = (hartree, extra = {}) => ({
  parsed: { finalEnergy: { hartree }, ...extra },
});

describe('issue 175 — the expression evaluator', () => {
  const value = (source, scope = new Map()) => evaluateExpression(source, scope).value;

  it('applies precedence, parentheses and unary minus', () => {
    expect(value('2 + 3 * 4')).toBe(14);
    expect(value('(2 + 3) * 4')).toBe(20);
    expect(value('2 * 3 + 4 * 5')).toBe(26);
    expect(value('100 - 30 - 20')).toBe(50);
    expect(value('100 / 10 / 2')).toBe(5);
    expect(value('-2 * -3')).toBe(6);
    expect(value('-(2 + 3)')).toBe(-5);
    expect(value('2 * (3 + (4 - 1))')).toBe(12);
  });

  it('reads decimal and exponential numbers, and the typographic signs', () => {
    expect(value('.5 + 1.5')).toBe(2);
    expect(value('1.5e-3 * 2')).toBeCloseTo(0.003, 12);
    expect(value('6 ÷ 2 × 3 − 1')).toBe(8);
    expect(value('4 * 2')).toBe(8);
  });

  it('is a hand-written parser, not a JavaScript runtime', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/shared/compute.js'), 'utf8');
    // The header says "no eval, no Function"; what must not exist is a call.
    expect(/\beval\s*\(/.test(source)).toBe(false);
    expect(/new\s+Function\s*\(/.test(source)).toBe(false);
    expect(/Function\s*\(/.test(source)).toBe(false);
    // An identifier can never reach a property, a global or a prototype.
    expect(() => value('constructor')).toThrow(ComputeError);
    expect(() => value('this.constructor')).toThrow(ComputeError);
    expect(() => value('process.exit(1)')).toThrow(ComputeError);
    expect(() => value('globalThis')).toThrow(ComputeError);
  });

  it('reduces every function in the set', () => {
    expect(value('sum(1, 2, 3)')).toBe(6);
    expect(value('sum(E)', new Map([['E', [1, 2, 3]]]))).toBe(6);
    expect(value('mean(2, 4, 6)')).toBe(4);
    expect(value('mean(E)', new Map([['E', [1, 2]]]))).toBe(1.5);
    expect(value('min(3, -1, 2)')).toBe(-1);
    expect(value('max(3, -1, 2)')).toBe(3);
    expect(value('max(E)', new Map([['E', [3, -1, 2]]]))).toBe(3);
    expect(value('sqrt(9)')).toBe(3);
    expect(value('abs(-2.5)')).toBe(2.5);
    expect(value(`hartree_to_kcal(1)`)).toBeCloseTo(HARTREE_TO_KCAL, 9);
    expect(value(`kcal_to_hartree(${HARTREE_TO_KCAL})`)).toBeCloseTo(1, 12);
    expect(value('abs(hartree_to_kcal(kcal_to_hartree(-5)))')).toBeCloseTo(5, 9);
  });

  it('refuses an unknown function by name, and says what the set is', () => {
    try {
      value('nope(1)');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ComputeError);
      expect(error.code).toBe('unknown-function');
      expect(error.message).toContain('"nope"');
      expect(error.message).toContain('fit_cubic_inverse');
    }
  });

  it('refuses wrong arity, unknown identifiers and malformed expressions by code', () => {
    const code = (source) => {
      try {
        value(source);
        return 'no-throw';
      } catch (error) {
        expect(error).toBeInstanceOf(ComputeError);
        return error.code;
      }
    };
    expect(code('sqrt()')).toBe('arity');
    expect(code('sqrt(1, 2)')).toBe('arity');
    expect(code('sum()')).toBe('arity');
    expect(code('fit_cubic_inverse(1, 2, 3)')).toBe('arity');
    expect(code('E')).toBe('unknown-identifier');
    expect(code('')).toBe('empty');
    expect(code('(1 + 2')).toBe('parens');
    expect(code('1 + 2)')).toBe('trailing-tokens');
    expect(code('1 2')).toBe('trailing-tokens');
    expect(code('1 + ')).toBe('unexpected-end');
    expect(code('1 + @')).toBe('character');
    expect(code('2 / 0')).toBe('division-by-zero');
    expect(code('2 / (3 - 3)')).toBe('division-by-zero');
    expect(code('1e308 * 1e308')).toBe('non-finite');
    expect(code('sqrt(-1)')).toBe('domain');
    expect(code('1 + [1, 2]')).toBe('character');
  });

  it('refuses arithmetic on a record set, but reduces it', () => {
    const scope = new Map([['E', [1, 2]]]);
    expect(() => value('E + 1', scope)).toThrow(/record set cannot be used/);
    expect(() => value('-E', scope)).toThrow(ComputeError);
    expect(value('sum(E) + 1', scope)).toBe(4);
  });
});

describe('issue 175 — the two-point X^-3 extrapolation', () => {
  // Hand-computed, with the arithmetic written out: E_CBS = (E(X)·X³ − E(Y)·Y³)/(X³ − Y³).
  const e2 = -76.3;
  const e3 = -76.38;
  const e4 = -76.41;
  const expected42 = (e4 * 4 ** 3 - e2 * 2 ** 3) / (4 ** 3 - 2 ** 3);
  const expected43 = (e4 * 4 ** 3 - e3 * 3 ** 3) / (4 ** 3 - 3 ** 3);

  it('reproduces a hand-computed CBS limit', () => {
    const scope = new Map([['E2', e2], ['E3', e3], ['E4', e4]]);
    expect(evaluateExpression('fit_cubic_inverse(E4, 4, E2, 2)', scope).value).toBeCloseTo(expected42, 12);
    expect(evaluateExpression('extrapolate_CBS(E4, 4, E3, 3)', scope).value).toBeCloseTo(expected43, 12);
    // The fit is symmetric in the pair: swapping the two rungs changes nothing.
    expect(evaluateExpression('fit_cubic_inverse(E2, 2, E4, 4)', scope).value).toBeCloseTo(expected42, 12);
    // Written out by hand, without a helper, it is the same number.
    expect(evaluateExpression('(E4 * 4 * 4 * 4 - E2 * 2 * 2 * 2) / (4 * 4 * 4 - 2 * 2 * 2)', scope).value)
      .toBeCloseTo(expected42, 12);
  });

  it('refuses equal, zero and negative cardinal numbers by name', () => {
    const scope = new Map([['E2', e2], ['E4', e4]]);
    expect(() => evaluateExpression('fit_cubic_inverse(E4, 3, E2, 3)', scope)).toThrow(/both 3/);
    expect(() => evaluateExpression('fit_cubic_inverse(E4, 4, E2, 0)', scope)).toThrow(/positive number/);
    expect(() => evaluateExpression('fit_cubic_inverse(E4, 4, E2, -2)', scope)).toThrow(/positive number/);
    try {
      evaluateExpression('fit_cubic_inverse(E4, 4, E2, 4)', scope);
    } catch (error) {
      expect(error.code).toBe('cbs-cardinal');
    }
  });

  it('carries the formula in the result notes, and states Hartree', () => {
    const result = evaluateCompute({
      expression: 'extrapolate_CBS(E4, 4, E2, 2)',
      inputs: [
        { name: 'E4', field: 'finalEnergyHartree', source: 'sp4' },
        { name: 'E2', field: 'finalEnergyHartree', source: 'sp2' },
      ],
    }, {
      resolveSource: (id) => ({ run: runRecord(id === 'sp4' ? e4 : e2), recordId: id }),
    });
    expect(result.status).toBe('computed');
    expect(result.value).toBeCloseTo(expected42, 12);
    expect(result.unit).toBe('hartree');
    expect(result.notes.join(' ')).toContain(CBS_FORMULA);
    expect(result.functionCalls.map((call) => call.name)).toEqual(['extrapolate_CBS']);
  });

  it('refuses a CBS fit over a quantity that is not an energy', () => {
    const withField = (field) => evaluateCompute({
      expression: 'extrapolate_CBS(G4, 4, G2, 2)',
      inputs: [
        { name: 'G4', field, source: 'sp4' },
        { name: 'G2', field, source: 'sp2' },
      ],
    }, {});
    expect(() => withField('gapEv')).toThrow(/eV/);
    expect(() => withField('imaginaryCount')).toThrow(/dimensionless/);
  });
});

describe('issue 175 — fields, units and refusals', () => {
  it('reads the vocabulary the dataset writer already uses', () => {
    const writerKeys = new Set(DATASET_CSV_COLUMNS.map((column) => column.key));
    for (const field of COMPUTE_FIELDS) {
      expect(writerKeys.has(field.key), `${field.key} is not a dataset column`).toBe(true);
    }
  });

  it('reports a missing field by name, and keeps the other records', () => {
    const definition = {
      expression: 'E * 2',
      inputs: [{ name: 'E', field: 'finalEnergyHartree', source: 'sp' }],
    };
    const runs = new Map([
      ['mol-1', { recordId: 'mol-1', run: runRecord(-10) }],
      ['mol-2', { recordId: 'mol-2', run: { parsed: { finalEnergy: { hartree: null } } } }],
      ['mol-3', { recordId: 'mol-3', run: runRecord(-30) }],
    ]);
    const evaluate = (recordId) => evaluateCompute(definition, {
      recordId,
      resolveSource: () => runs.get(recordId),
    });
    expect(evaluate('mol-1').value).toBe(-20);
    const missing = evaluate('mol-2');
    expect(missing.status).toBe('refused');
    expect(missing.value).toBeNull();
    expect(missing.notComputed).toBe('not computed: finalEnergyHartree missing for record mol-2');
    expect(evaluate('mol-3').value).toBe(-60);
  });

  it('is pending — not zero — when nothing upstream has run', () => {
    const result = evaluateCompute({
      expression: 'E', inputs: [{ name: 'E', field: 'finalEnergyHartree', source: 'sp' }],
    }, { resolveSource: () => null });
    expect(result.status).toBe('pending');
    expect(result.value).toBeNull();
    expect(result.notComputed).toMatch(/waiting for sp/);
  });

  it('refuses a whole record set that has a missing field rather than summing around it', () => {
    const result = evaluateCompute({
      expression: 'sum(E)',
      inputs: [{ name: 'E', field: 'finalEnergyHartree', source: 'sp', scope: 'records' }],
    }, {
      allRecords: () => [
        { recordId: 'mol-1', run: runRecord(-1) },
        { recordId: 'mol-2', run: { parsed: {} } },
      ],
    });
    expect(result.status).toBe('refused');
    expect(result.notComputed).toBe('not computed: finalEnergyHartree missing for record mol-2');
  });

  it('sums the dataset through a record-set input', () => {
    const result = evaluateCompute({
      expression: 'sum(E)',
      inputs: [{ name: 'E', field: 'finalEnergyHartree', source: 'sp', scope: 'records' }],
    }, {
      allRecords: () => [
        { recordId: 'mol-1', run: runRecord(-1) },
        { recordId: 'mol-2', run: runRecord(-2) },
        { recordId: 'mol-3', run: runRecord(-3.5) },
      ],
    });
    expect(result.status).toBe('computed');
    expect(result.value).toBe(-6.5);
    expect(result.inputs.map((input) => input.recordId)).toEqual(['mol-1', 'mol-2', 'mol-3']);
  });

  it('keeps the field unit on a linear combination and refuses to invent one', () => {
    const evaluate = (expression, field) => evaluateCompute({
      expression,
      inputs: [
        { name: 'A', field, source: 'a' },
        { name: 'B', field, source: 'b' },
      ],
    }, {
      resolveSource: (id) => ({ run: runRecord(id === 'a' ? -10 : -20), recordId: id }),
    });
    expect(evaluate('A - B', 'finalEnergyHartree').unit).toBe('hartree');
    expect(evaluate('A - B', 'gapEv').unit).toBe('eV');
    expect(evaluate('mean(A, B)', 'gibbsHartree').unit).toBe('hartree');
    // A product of two dimensioned inputs is not given a made-up unit.
    expect(evaluate('A * B', 'finalEnergyHartree').unit).toBeNull();
    expect(evaluate('A / A', 'finalEnergyHartree').unit).toBeNull();
    // A conversion helper states the unit the expression asked for.
    expect(evaluate('hartree_to_kcal(A)', 'finalEnergyHartree').unit).toBe('kcal/mol');
  });

  it('refuses an undeclared field or a malformed input at definition time', () => {
    expect(() => computeInputsOf({
      expression: 'E', inputs: [{ name: 'E', field: 'finalEnergy', source: 'sp' }],
    })).toThrow(/not a field a compute block can read/);
    expect(() => computeInputsOf({
      expression: 'E', inputs: [{ name: '1E', field: 'finalEnergyHartree', source: 'sp' }],
    })).toThrow(/usable name/);
    expect(() => computeInputsOf({
      expression: 'E', inputs: [
        { name: 'E', field: 'finalEnergyHartree', source: 'sp' },
        { name: 'E', field: 'gibbsHartree', source: 'sp' },
      ],
    })).toThrow(/both named/);
  });

  it('describes a result in one line for the card, the queue and the report', () => {
    const result = evaluateCompute({
      expression: 'E * 2', inputs: [{ name: 'E', field: 'finalEnergyHartree', source: 'sp' }],
    }, { resolveSource: () => ({ run: runRecord(-10), recordId: 'sp' }) });
    expect(describeCompute(result)).toBe('E * 2 = -20 hartree');
    expect(describeCompute({ status: 'refused', notComputed: 'not computed: x missing for record y' }))
      .toBe('not computed: x missing for record y');
  });
});

describe('issue 175 — schema and plan', () => {
  const nodes = () => [
    calc('sp2', 'MP2/cc-pVDZ'), calc('sp3', 'MP2/cc-pVTZ'), calc('sp4', 'MP2/cc-pVQZ'),
    computeNode('fit_cubic_inverse(E4, 4, E2, 2)', [
      { name: 'E4', field: 'finalEnergyHartree', source: 'sp4' },
      { name: 'E2', field: 'finalEnergyHartree', source: 'sp2' },
    ]),
  ];
  const edges = () => [
    { from: 'sp2', to: 'cbs', type: 'dependency' },
    { from: 'sp3', to: 'cbs', type: 'dependency' },
    { from: 'sp4', to: 'cbs', type: 'dependency' },
  ];
  const results = () => ({
    sp2: runRecord(-76.3),
    sp3: runRecord(-76.38),
    sp4: runRecord(-76.41),
  });
  const expected = (e4, e2) => (e4 * 64 - e2 * 8) / (64 - 8);

  it('accepts the node type and keeps the block absent unless it is used', () => {
    expect(NODE_TYPES).toContain('compute');
    const project = validated(projectWith(nodes(), edges()));
    const node = project.nodes.find((item) => item.id === 'cbs');
    expect(node.type).toBe('compute');
    expect(node.compute.expression).toBe('fit_cubic_inverse(E4, 4, E2, 2)');
    expect(node.compute.inputs).toHaveLength(2);
    // Round-trip: what is saved is what was validated.
    const saved = stringifyProject(project);
    expect(saved.ok).toBe(true);
    const again = validateProject(JSON.parse(saved.text));
    expect(again.errors).toEqual([]);
    expect(again.project.nodes.find((item) => item.id === 'cbs').compute).toEqual(node.compute);
  });

  it('refuses an expression that reads an undeclared name, and an unknown field', () => {
    const undeclared = validateProject(projectWith([
      calc('sp2'), computeNode('E4', [{ name: 'E2', field: 'finalEnergyHartree', source: 'sp2' }]),
    ], [{ from: 'sp2', to: 'cbs', type: 'dependency' }]));
    expect(undeclared.errors.some((error) => /uses "E4", which is not a declared input/.test(error.message))).toBe(true);

    const badField = validateProject(projectWith([
      calc('sp2'), computeNode('E', [{ name: 'E', field: 'thermochemistry.gibbs', source: 'sp2' }]),
    ], [{ from: 'sp2', to: 'cbs', type: 'dependency' }]));
    expect(badField.errors.some((error) => /must be one of/.test(error.message))).toBe(true);
  });

  it('produces the CBS limit on the planned task, with the expression echoed', () => {
    const project = validated(projectWith(nodes(), edges()));
    const plan = buildWorkflowPlan(project, { results: results() });
    const task = plan.tasks.find((item) => item.type === 'compute');
    expect(task.executable).toBe(false);
    expect(task.compute.expression).toBe('fit_cubic_inverse(E4, 4, E2, 2)');
    expect(task.compute.value).toBeCloseTo(expected(-76.41, -76.3), 12);
    expect(task.compute.unit).toBe('hartree');
    expect(task.compute.inputs).toEqual([
      { recordId: 'sp4', field: 'finalEnergyHartree', value: -76.41, unit: 'hartree' },
      { recordId: 'sp2', field: 'finalEnergyHartree', value: -76.3, unit: 'hartree' },
    ]);
    expect(task.compute.notes.join(' ')).toContain(CBS_FORMULA);
    // The edge from the compute block keeps the plan's ordering.
    expect(plan.edges.filter((edge) => edge.to === 'cbs')).toHaveLength(3);
  });

  it('is pending, not wrong, when the plan is built before the upstream runs', () => {
    const project = validated(projectWith(nodes(), edges()));
    const task = buildWorkflowPlan(project).tasks.find((item) => item.type === 'compute');
    expect(task.compute.status).toBe('pending');
    expect(task.compute.value).toBeNull();
    expect(task.compute.notComputed).toMatch(/waiting for/);
  });

  it('fails the task with the field named when one upstream field is missing', () => {
    const project = validated(projectWith(nodes(), edges()));
    const runs = results();
    runs.sp2 = { parsed: { frequencies: { imaginaryCount: 0 } } };
    const task = buildWorkflowPlan(project, { results: runs }).tasks.find((item) => item.type === 'compute');
    expect(task.compute.status).toBe('refused');
    expect(task.compute.value).toBeNull();
    expect(task.compute.notComputed).toBe('not computed: finalEnergyHartree missing for record sp2');
  });

  it('previews exactly the plan value, from the same evaluator', () => {
    const project = validated(projectWith(nodes(), edges()));
    // The renderer keeps a finished block's canonical result on the node.
    project.nodes.find((item) => item.id === 'sp4').parsed = runRecord(-76.41).parsed;
    project.nodes.find((item) => item.id === 'sp2').parsed = runRecord(-76.3).parsed;
    const node = project.nodes.find((item) => item.id === 'cbs');
    const context = computeContext(project, node);
    const preview = evaluateCompute(node.compute, {
      recordId: null,
      resolveSource: context.resolveSource,
      allRecords: context.allRecords,
    });
    const planTask = buildWorkflowPlan(project).tasks.find((item) => item.type === 'compute');
    expect(preview.status).toBe('computed');
    expect(preview.value).toBe(planTask.compute.value);
    expect(preview.expression).toBe(planTask.compute.expression);
    expect(preview.inputs).toEqual(planTask.compute.inputs);
  });

  it('plans one derived value per record for a dataset family', () => {
    const dataset = {
      id: 'family', title: 'Family', source: { kind: 'inline', path: '', format: 'json' },
      fields: { label: '', charge: '', multiplicity: '' },
      records: [
        { id: 'mol-1', label: 'Water', charge: 0, multiplicity: 1, coords: water, enabled: true },
        { id: 'mol-2', label: 'Methanol', charge: 0, multiplicity: 1, coords: water, enabled: true },
        { id: 'mol-3', label: 'Ethanol', charge: 0, multiplicity: 1, coords: water, enabled: true },
      ],
      notes: '',
    };
    const project = validated(projectWith([
      { id: 'in', type: 'input', kind: 'Input', title: 'Family', state: 'ready', x: 0, y: 0, input: { datasetId: 'family', recordFilter: { field: '', equals: '' } } },
      calc('sp', 'MP2/cc-pVQZ'),
      computeNode('E', [{ name: 'E', field: 'finalEnergyHartree', source: 'sp' }]),
    ], [
      { from: 'in', to: 'sp', type: 'dependency' },
      { from: 'sp', to: 'cbs', type: 'dependency' },
    ], { datasets: [dataset] }));
    const runs = new Map([
      ['sp~mol-1', runRecord(-1)],
      ['sp~mol-2', runRecord(-2)],
      ['sp~mol-3', { parsed: { finalEnergy: { hartree: null } } }],
    ]);
    const plan = buildWorkflowPlan(project, { results: runs });
    const planned = plan.tasks.filter((item) => item.type === 'compute');
    expect(planned.map((item) => item.recordId)).toEqual(['mol-1', 'mol-2', 'mol-3']);
    expect(planned.map((item) => item.compute.value)).toEqual([-1, -2, null]);
    expect(planned[2].compute.notComputed).toBe('not computed: finalEnergyHartree missing for record mol-3');
  });

  it('leaves a plan with no compute block byte-identical', () => {
    const plain = validated(projectWith(nodes().filter((node) => node.type !== 'compute'),
      edges().filter((edge) => edge.to !== 'cbs')));
    const once = JSON.stringify(buildWorkflowPlan(plain));
    const twice = JSON.stringify(buildWorkflowPlan(plain));
    const withResults = JSON.stringify(buildWorkflowPlan(plain, { results: results() }));
    expect(twice).toBe(once);
    expect(withResults).toBe(once);
    expect(once.includes('"compute"')).toBe(false);
  });

  it('refuses to plan a compute block with no upstream or no named source', () => {
    const lonely = validated(projectWith([calc('sp2'), computeNode('1 + 2', [])], []));
    expect(() => buildWorkflowPlan(lonely)).toThrow(/declares no inputs/);
    const unwired = validated(projectWith([
      calc('sp2'), calc('sp3'),
      computeNode('E', [{ name: 'E', field: 'finalEnergyHartree', source: 'sp9' }]),
    ], [{ from: 'sp2', to: 'cbs', type: 'dependency' }]));
    expect(() => buildWorkflowPlan(unwired)).toThrow(/not wired into this block/);
  });
});

describe('issue 175 — the queue writes the derived record', () => {
  let QueueManager;
  let RunManager;
  let roots = [];

  beforeAll(async () => {
    ({ QueueManager } = await import('../electron/runner/queue.js'));
    ({ RunManager } = await import('../electron/runner/runManager.js'));
  });

  afterAll(async () => {
    await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
    roots = [];
  });

  it('evaluates from the upstream run.json and writes its own record', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-compute-'));
    roots.push(base);
    const queuesRoot = path.join(base, 'queues');
    const runsRoot = path.join(base, 'runs');
    await fsp.mkdir(runsRoot, { recursive: true });
    const manager = new QueueManager({
      queuesRoot,
      runManager: new RunManager({ runsRoot, emit: () => {} }),
      emit: () => {},
    });
    const runDir = (name, value) => {
      const dir = path.join(base, name);
      return fsp.mkdir(dir, { recursive: true })
        .then(() => fsp.writeFile(path.join(dir, 'run.json'), JSON.stringify(runRecord(value)), 'utf8'))
        .then(() => dir);
    };
    const queueDir = path.join(queuesRoot, 'q1');
    await fsp.mkdir(queueDir, { recursive: true });
    const task = {
      nodeId: 'cbs',
      type: 'compute',
      title: 'CBS limit',
      kind: 'Compute',
      executable: false,
      recordId: null,
      compute: {
        expression: 'fit_cubic_inverse(E4, 4, E2, 2)',
        declared: [
          { name: 'E4', field: 'finalEnergyHartree', source: 'sp4', scope: 'record' },
          { name: 'E2', field: 'finalEnergyHartree', source: 'sp2', scope: 'record' },
        ],
        sources: ['sp2', 'sp4'],
      },
    };
    const queue = {
      id: 'q1',
      tasks: [
        { nodeId: 'sp2', type: 'calc', status: 'completed', runDir: await runDir('sp2', -76.3) },
        { nodeId: 'sp4', type: 'calc', status: 'completed', runDir: await runDir('sp4', -76.41) },
        task,
      ],
      edges: [
        { from: 'sp2', to: 'cbs', type: 'dependency' },
        { from: 'sp4', to: 'cbs', type: 'dependency' },
      ],
      status: 'running',
      options: {},
    };
    await manager.runCompute(queue, task);
    expect(task.status).toBe('completed');
    expect(task.compute.value).toBeCloseTo((-76.41 * 64 + 76.3 * 8) / 56, 12);
    const written = JSON.parse(await fsp.readFile(path.join(task.runDir, 'run.json'), 'utf8'));
    expect(written.kind).toBe('derived');
    expect(written.compute.expression).toBe('fit_cubic_inverse(E4, 4, E2, 2)');
    expect(written.compute.value).toBeCloseTo(task.compute.value, 12);
    expect(written.compute.inputs.map((input) => input.recordId)).toEqual(['sp4', 'sp2']);
    // No `parsed` block: a derived value must never read as an engine result.
    expect(written.parsed).toBeUndefined();
  });
});

describe('issue 175 — report and card', () => {
  const computed = {
    nodeId: 'cbs',
    type: 'compute',
    title: 'CBS limit',
    kind: 'Compute',
    status: 'completed',
    compute: {
      expression: 'fit_cubic_inverse(E4, 4, E2, 2)',
      status: 'computed',
      value: -76.41242857142858,
      unit: 'hartree',
      inputs: [
        { recordId: 'sp4', field: 'finalEnergyHartree', value: -76.41, unit: 'hartree' },
        { recordId: 'sp2', field: 'finalEnergyHartree', value: -76.3, unit: 'hartree' },
      ],
      notes: [CBS_FORMULA],
      sources: ['sp2', 'sp4'],
    },
  };
  const queue = () => ({
    id: 'q1', projectName: 'CBS', status: 'completed', createdAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T01:00:00Z', tasks: [computed], edges: [],
  });

  it('reports the derived value in its own section, with its inputs and methods sentence', () => {
    const model = buildWorkflowReport(queue(), {});
    expect(model.derived).toHaveLength(1);
    expect(model.derived[0].value).toBeCloseTo(-76.41242857142858, 12);
    expect(model.derived[0].paragraph).toContain('fit_cubic_inverse(E4, 4, E2, 2)');
    expect(model.derived[0].paragraph).toContain('not a computed QM result');
    expect(model.derived[0].paragraph).toContain('finalEnergyHartree of sp4');
    // The task row has no energy: a derived number never enters that column.
    expect(model.tasks[0].finalEnergyHartree).toBeNull();
    const html = workflowReportHtml(model);
    expect(html).toContain('Derived quantity');
    expect(html).toContain('data-field="derived-value"');
    expect(html).toContain('data-field="derived-input"');
  });

  it('renders a derived record as a card that names its inputs', () => {
    const html = resultsPanelHtml({ compute: computed.compute });
    expect(html).toContain('Derived quantity');
    expect(html).toContain('fit_cubic_inverse(E4, 4, E2, 2)');
    expect(html).toContain('data-role="compute-input"');
    expect(html).toContain('finalEnergyHartree');
    expect(html).toContain('sp4');
    expect(html).toContain('hartree');
  });

  it('reports a refusal verbatim, naming the field', () => {
    const refused = {
      ...computed,
      status: 'failed',
      compute: {
        ...computed.compute,
        status: 'refused',
        value: null,
        notComputed: 'not computed: finalEnergyHartree missing for record sp2',
      },
    };
    const model = buildWorkflowReport({ ...queue(), tasks: [refused] }, {});
    expect(model.derived[0].paragraph).toContain('not computed: finalEnergyHartree missing for record sp2');
    expect(workflowReportHtml(model)).toContain('data-field="derived-refusal"');
  });
});
