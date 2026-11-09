/**
 * Compute node: arithmetic across upstream records (issue 175).
 *
 * A protocol is more than a run: after nine single points there is a second
 * half, and it is arithmetic. This module is the whole of that half — a small,
 * safe expression language over numbers taken from other blocks' results.
 *
 * ## The language
 *
 *   digits, `+ - * /`, parentheses, unary minus, and a fixed function set:
 *   `sum`, `mean`, `min`, `max`, `sqrt`, `abs`, `fit_cubic_inverse`,
 *   `extrapolate_CBS`, `hartree_to_kcal`, `kcal_to_hartree`.
 *
 * Numbers may be written `1`, `-2.5`, `.5`, `1.0e-3`. The typographic signs
 * `−` (U+2212), `×` (U+00D7) and `÷` (U+00F7) mean `-`, `*` and `/`.
 *
 * There is no `eval`, no `Function` and no `new Function` anywhere in this file:
 * a hand-written tokeniser and recursive-descent parser produce an AST, and a
 * tree-walking evaluator reduces it. An identifier that is not a declared input
 * and not a function name is refused by name, so an expression can never reach
 * a property, a global or the prototype chain.
 *
 * Grammar (precedence climbing, all left-associative):
 *
 *   expression := term (('+' | '-') term)*
 *   term       := unary (('*' | '/') unary)*
 *   unary      := ('+' | '-') unary | primary
 *   primary    := number | name | name '(' [expression (',' expression)*] ')'
 *               | '(' expression ')'
 *
 * ## CBS extrapolation
 *
 * `fit_cubic_inverse(E_A, X_A, E_B, X_B)` and `extrapolate_CBS(...)` implement
 * the standard two-point inverse-cube extrapolation:
 *
 *   E_CBS = (E(X)·X³ − E(Y)·Y³) / (X³ − Y³)
 *
 * where X and Y are the cardinal numbers (D = 2, T = 3, Q = 4, …). Both take
 * the two energies and the two cardinal numbers, and both refuse equal or
 * non-positive cardinal numbers by name. The formula is repeated in the
 * result's `notes`, because a number that came from an extrapolation must not
 * read like a number an engine printed.
 *
 * `extrapolate_CBS` is the protocol name, `fit_cubic_inverse` the arithmetic
 * primitive; they are the same fit, and the second is what the first calls.
 *
 * ## Fields
 *
 * An input names a field with the vocabulary the dataset writer already uses
 * (`COMPUTE_FIELDS` is a subset of `DATASET_CSV_COLUMNS`), e.g.
 * `finalEnergyHartree`, `gibbsHartree`, `imaginaryCount`. The value is read
 * through `runRow()` — the same function the CSV export uses — so a field that
 * is absent is `null` here exactly as it is an empty cell there. A null field is
 * **never** zero: it is a named refusal, and the other records keep their
 * values.
 */

import { runRow } from './datasetExport.js';

/** Longest expression the schema accepts; a protocol is a line, not a script. */
export const COMPUTE_EXPRESSION_MAX = 2000;

/** Largest number of declared inputs; a protocol reads a handful of numbers. */
export const COMPUTE_INPUTS_MAX = 24;

/** Hartree → kcal/mol, CODATA-2018 (the constant `cbs.js` and the report use). */
export const HARTREE_TO_KCAL = 627.5094740631;

/** The formula text every CBS result carries, in the header and in `notes`. */
export const CBS_FORMULA = 'E_CBS = (E(X)·X³ − E(Y)·Y³) / (X³ − Y³)';

/**
 * The fields a compute node may read, with the unit it reports for each.
 *
 * Every key is a `DATASET_CSV_COLUMNS` key, so a compute input and a CSV column
 * name the same thing; `compute.test.js` holds the two lists together. A
 * quantity with no unit (a count, a cycle number) has `unit: ''`, which reads
 * as dimensionless — it is not "unit unknown".
 */
export const COMPUTE_FIELDS = Object.freeze([
  { key: 'finalEnergyHartree', label: 'Final energy', unit: 'hartree' },
  { key: 'gibbsHartree', label: 'Gibbs free energy', unit: 'hartree' },
  { key: 'scfCycles', label: 'SCF cycles', unit: '' },
  { key: 'imaginaryCount', label: 'Imaginary frequencies', unit: '' },
  { key: 'gapEv', label: 'HOMO–LUMO gap', unit: 'eV' },
  { key: 'homoEv', label: 'HOMO energy', unit: 'eV' },
  { key: 'lumoEv', label: 'LUMO energy', unit: 'eV' },
  { key: 'hardnessEv', label: 'Chemical hardness', unit: 'eV' },
  { key: 'elapsedSeconds', label: 'Elapsed time', unit: 's' },
  { key: 'conformerRelativeKcal', label: 'Conformer relative energy', unit: 'kcal/mol' },
  { key: 'conformerPopulation', label: 'Boltzmann population', unit: '' },
  { key: 'conformerSpreadKcal', label: 'Ensemble spread', unit: 'kcal/mol' },
  { key: 'ladderCbsHartree', label: 'Ladder CBS energy', unit: 'hartree' },
  { key: 'ladderSpreadKcal', label: 'Ladder spread', unit: 'kcal/mol' },
  { key: 'fchkTotalEnergyHartree', label: 'Wavefunction total energy', unit: 'hartree' },
  { key: 'mullikenChargeSum', label: 'Mulliken charge sum', unit: 'e' },
  { key: 'mullikenChargeDeviation', label: 'Mulliken charge deviation', unit: 'e' },
  { key: 'unpairedElectrons', label: 'Unpaired electrons', unit: '' },
]);

export const COMPUTE_FIELD_KEYS = Object.freeze(COMPUTE_FIELDS.map((field) => field.key));

const FIELD_BY_KEY = new Map(COMPUTE_FIELDS.map((field) => [field.key, field]));

/** The declared unit of a field, or throws with the field named. */
export function unitOfField(key) {
  const field = FIELD_BY_KEY.get(String(key || ''));
  if (!field) {
    throw new ComputeError(`unknown field "${key}"; a compute input may read ${COMPUTE_FIELD_KEYS.join(', ')}.`,
      { code: 'unknown-field' });
  }
  return field.unit;
}

/**
 * The function set. `arity` is `[min, max]`; `max: Infinity` is variadic.
 *
 * `resultUnit` is `'unit'` (the arguments' shared unit), a literal unit string,
 * or `null` for "this function does not report a unit".
 */
export const COMPUTE_FUNCTIONS = Object.freeze([
  {
    name: 'sum', arity: [1, Infinity], resultUnit: 'unit',
    summary: 'sum of one or more numbers, or of a record set',
  },
  { name: 'mean', arity: [1, Infinity], resultUnit: 'unit', summary: 'arithmetic mean' },
  { name: 'min', arity: [1, Infinity], resultUnit: 'unit', summary: 'smallest argument' },
  { name: 'max', arity: [1, Infinity], resultUnit: 'unit', summary: 'largest argument' },
  { name: 'sqrt', arity: [1, 1], resultUnit: null, summary: 'square root of one number' },
  { name: 'abs', arity: [1, 1], resultUnit: 'unit', summary: 'absolute value' },
  {
    name: 'fit_cubic_inverse', arity: [4, 4], resultUnit: 'hartree',
    summary: `two-point inverse-cube fit: ${CBS_FORMULA}`,
  },
  {
    name: 'extrapolate_CBS', arity: [4, 4], resultUnit: 'hartree',
    summary: `complete-basis-set limit: ${CBS_FORMULA}`,
  },
  {
    name: 'hartree_to_kcal', arity: [1, 1], resultUnit: 'kcal/mol',
    summary: `multiply an energy in Hartree by ${HARTREE_TO_KCAL}`,
  },
  {
    name: 'kcal_to_hartree', arity: [1, 1], resultUnit: 'hartree',
    summary: `divide an energy in kcal/mol by ${HARTREE_TO_KCAL}`,
  },
]);

const FUNCTION_BY_NAME = new Map(COMPUTE_FUNCTIONS.map((fn) => [fn.name, fn]));

/** Functions whose four arguments are (energy, cardinal, energy, cardinal). */
const CBS_FUNCTIONS = new Set(['fit_cubic_inverse', 'extrapolate_CBS']);

/** A refusal the caller can name: bad syntax, an unknown name, a division by 0. */
export class ComputeError extends Error {
  constructor(message, { code = 'compute', position = null } = {}) {
    super(message);
    this.name = 'ComputeError';
    this.code = code;
    this.position = position;
  }
}

/* ── tokeniser ────────────────────────────────────────────── */

const OPERATOR_ALIASES = new Map([
  ['−', '-'], ['\u2013', '-'], ['×', '*'], ['·', '*'], ['÷', '/'],
]);

const NUMBER_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;

function tokenize(source) {
  const text = String(source ?? '');
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const char = rest[0];
    if (/\s/.test(char)) { index += 1; continue; }
    const alias = OPERATOR_ALIASES.get(char);
    if (alias) {
      tokens.push({ type: 'op', value: alias, position: index });
      index += 1;
      continue;
    }
    if (char === '+' || char === '-' || char === '*' || char === '/' || char === '(' || char === ')' || char === ',') {
      tokens.push({ type: 'op', value: char, position: index });
      index += 1;
      continue;
    }
    const number = rest.match(NUMBER_RE);
    if (number) {
      tokens.push({ type: 'number', value: Number(number[0]), text: number[0], position: index });
      index += number[0].length;
      continue;
    }
    const name = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (name) {
      tokens.push({ type: 'name', value: name[0], position: index });
      index += name[0].length;
      continue;
    }
    throw new ComputeError(`unexpected character "${char}" at position ${index + 1} of "${text}".`,
      { code: 'character', position: index });
  }
  return tokens;
}

/* ── parser ───────────────────────────────────────────────── */

/**
 * Parse an expression into an AST.
 *
 * Nodes: `{ kind: 'number', value }`, `{ kind: 'name', name }`,
 * `{ kind: 'call', name, args }`, `{ kind: 'unary', op, operand }`,
 * `{ kind: 'binary', op, left, right }`. Each node keeps the source `position`
 * of the token it starts at, so a refusal can point at it.
 */
export function parseExpression(source) {
  const text = String(source ?? '').trim();
  if (!text) {
    throw new ComputeError('the expression is empty; a compute block needs at least one term.', { code: 'empty' });
  }
  if (text.length > COMPUTE_EXPRESSION_MAX) {
    throw new ComputeError(`the expression is ${text.length} characters; the limit is ${COMPUTE_EXPRESSION_MAX}.`,
      { code: 'too-long' });
  }
  const tokens = tokenize(text);
  let cursor = 0;

  const peek = () => tokens[cursor] || null;
  const next = () => tokens[cursor++] || null;
  const isOp = (value) => peek()?.type === 'op' && peek().value === value;

  function expectOp(value, opening) {
    const token = next();
    if (!token || token.type !== 'op' || token.value !== value) {
      throw new ComputeError(`unbalanced parentheses: the "(" at position ${opening + 1} is never closed.`,
        { code: 'parens', position: opening });
    }
    return token;
  }

  function parseAdditive() {
    let node = parseMultiplicative();
    while (isOp('+') || isOp('-')) {
      const op = next();
      const right = parseMultiplicative();
      node = { kind: 'binary', op: op.value, left: node, right, position: op.position };
    }
    return node;
  }

  function parseMultiplicative() {
    let node = parseUnary();
    while (isOp('*') || isOp('/')) {
      const op = next();
      const right = parseUnary();
      node = { kind: 'binary', op: op.value, left: node, right, position: op.position };
    }
    return node;
  }

  function parseUnary() {
    if (isOp('+') || isOp('-')) {
      const op = next();
      return { kind: 'unary', op: op.value, operand: parseUnary(), position: op.position };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const token = next();
    if (!token) {
      throw new ComputeError('the expression ends where a number, a name or "(" was expected.', { code: 'unexpected-end' });
    }
    if (token.type === 'number') return { kind: 'number', value: token.value, position: token.position };
    if (token.type === 'name') {
      if (isOp('(')) {
        const open = next();
        const args = [];
        if (!isOp(')')) {
          for (;;) {
            if (isOp(',')) {
              throw new ComputeError(`"${token.value}(" has an empty argument before position ${peek().position + 1}.`,
                { code: 'empty-argument', position: peek().position });
            }
            args.push(parseAdditive());
            if (isOp(',')) { next(); continue; }
            break;
          }
        }
        if (!isOp(')')) {
          throw new ComputeError(`unbalanced parentheses: "${token.value}(" at position ${open.position + 1} is never closed.`,
            { code: 'parens', position: open.position });
        }
        next();
        return { kind: 'call', name: token.value, args, position: token.position };
      }
      return { kind: 'name', name: token.value, position: token.position };
    }
    if (token.value === '(') {
      const inner = parseAdditive();
      expectOp(')', token.position);
      return inner;
    }
    throw new ComputeError(`"${token.value}" at position ${token.position + 1} is not the start of a term.`,
      { code: 'unexpected-token', position: token.position });
  }

  const ast = parseAdditive();
  if (cursor < tokens.length) {
    const stray = tokens[cursor];
    throw new ComputeError(`trailing "${stray.text ?? stray.value}" at position ${stray.position + 1};`
      + ' an expression is one term, not a list.', { code: 'trailing-tokens', position: stray.position });
  }
  return ast;
}

/** Every identifier the expression reads, in first-use order. */
export function identifiersOf(ast) {
  const names = [];
  const visit = (node) => {
    if (node.kind === 'name') {
      if (!names.includes(node.name)) names.push(node.name);
      return;
    }
    if (node.kind === 'unary') { visit(node.operand); return; }
    if (node.kind === 'binary') { visit(node.left); visit(node.right); return; }
    if (node.kind === 'call') { node.args.forEach(visit); }
  };
  visit(ast);
  return names;
}

/* ── evaluation ───────────────────────────────────────────── */

function finite(value, what) {
  if (!Number.isFinite(value)) {
    throw new ComputeError(`${what} is not a finite number (${value}).`, { code: 'non-finite' });
  }
  return value;
}

function report(arg) {
  return Array.isArray(arg) ? `[${arg.join(', ')}]` : String(arg);
}

/** Every scalar a variadic argument may expand to; a set is flattened once. */
function scalarsOf(args, name) {
  const out = [];
  for (const arg of args) {
    if (Array.isArray(arg)) out.push(...arg);
    else out.push(arg);
  }
  if (out.length === 0) {
    throw new ComputeError(`${name}() has no values to reduce; a record set with no records cannot be summed.`,
      { code: 'empty-set' });
  }
  return out;
}

function requireScalar(value, name, index) {
  if (Array.isArray(value)) {
    throw new ComputeError(`${name}() argument ${index + 1} is a record set;`
      + ' only sum, mean, min and max accept a record set.', { code: 'set-argument' });
  }
  return value;
}

/** Two-point inverse-cube extrapolation: (E_A·A³ − E_B·B³)/(A³ − B³). */
export function cbsTwoPoint({ energyA, cardinalA, energyB, cardinalB }) {
  const a = finite(Number(energyA), 'the first energy');
  const b = finite(Number(energyB), 'the second energy');
  const x = Number(cardinalA);
  const y = Number(cardinalB);
  for (const [cardinal, label] of [[x, 'the first cardinal number'], [y, 'the second cardinal number']]) {
    if (!Number.isFinite(cardinal) || cardinal <= 0) {
      throw new ComputeError(`${label} must be a positive number (got ${report(cardinal)});`
        + ` ${CBS_FORMULA} needs two cardinal numbers.`, { code: 'cbs-cardinal' });
    }
  }
  if (x === y) {
    throw new ComputeError(`the two cardinal numbers are both ${x}; ${CBS_FORMULA} needs two different basis sets.`,
      { code: 'cbs-cardinal' });
  }
  return (a * x ** 3 - b * y ** 3) / (x ** 3 - y ** 3);
}

/**
 * Evaluate an AST against a scope of named numbers (or record sets).
 *
 * `scope` is a Map name → number | number[]. `calls` collects every function
 * application with its evaluated arguments, in call order.
 */
export function evaluateAst(ast, scope, calls = []) {
  const read = (node) => {
    if (node.kind === 'number') return node.value;
    if (node.kind === 'name') {
      if (!scope.has(node.name)) {
        const known = [...scope.keys()];
        throw new ComputeError(`unknown identifier "${node.name}";`
          + `${known.length ? ` the declared inputs are ${known.join(', ')}` : ' no input is declared'}.`,
        { code: 'unknown-identifier', position: node.position });
      }
      return scope.get(node.name);
    }
    if (node.kind === 'unary') {
      const operand = read(node.operand);
      if (Array.isArray(operand)) {
        throw new ComputeError(`a record set cannot be negated; wrap it in sum(), mean(), min() or max().`,
          { code: 'set-arithmetic', position: node.position });
      }
      return node.op === '-' ? -operand : operand;
    }
    if (node.kind === 'binary') {
      const left = read(node.left);
      const right = read(node.right);
      if (Array.isArray(left) || Array.isArray(right)) {
        throw new ComputeError(`a record set cannot be used in "${node.op}";`
          + ' reduce it with sum(), mean(), min() or max() first.', { code: 'set-arithmetic', position: node.position });
      }
      if (node.op === '/' && right === 0) {
        throw new ComputeError('division by zero; the denominator evaluates to 0.', { code: 'division-by-zero', position: node.position });
      }
      const value = node.op === '+' ? left + right
        : node.op === '-' ? left - right
          : node.op === '*' ? left * right
            : left / right;
      return finite(value, `"${report(left)} ${node.op} ${report(right)}"`);
    }
    if (node.kind === 'call') return call(node);
    throw new ComputeError(`unknown expression node "${node.kind}".`, { code: 'ast' });
  };

  function call(node) {
    const fn = FUNCTION_BY_NAME.get(node.name);
    if (!fn) {
      throw new ComputeError(`unknown function "${node.name}";`
        + ` the function set is ${COMPUTE_FUNCTIONS.map((item) => item.name).join(', ')}.`,
      { code: 'unknown-function', position: node.position });
    }
    const [min, max] = fn.arity;
    if (node.args.length < min || node.args.length > max) {
      const wanted = max === min ? `${min}` : max === Infinity ? `at least ${min}` : `${min} to ${max}`;
      throw new ComputeError(`${node.name}() takes ${wanted} argument${min === 1 && max === 1 ? '' : 's'};`
        + ` this call has ${node.args.length}.`, { code: 'arity', position: node.position });
    }
    const args = node.args.map(read);
    const record = { name: node.name, args: args.map((arg) => (Array.isArray(arg) ? arg.slice() : arg)) };
    calls.push(record);
    switch (node.name) {
      case 'sum': return finite(scalarsOf(args, 'sum').reduce((total, value) => total + value, 0), 'sum()');
      case 'mean': {
        const values = scalarsOf(args, 'mean');
        return finite(values.reduce((total, value) => total + value, 0) / values.length, 'mean()');
      }
      case 'min': return Math.min(...scalarsOf(args, 'min'));
      case 'max': return Math.max(...scalarsOf(args, 'max'));
      case 'abs': return Math.abs(requireScalar(args[0], 'abs', 0));
      case 'sqrt': {
        const value = requireScalar(args[0], 'sqrt', 0);
        if (value < 0) {
          throw new ComputeError(`sqrt() of a negative number (${value}) is not real.`, { code: 'domain', position: node.position });
        }
        return Math.sqrt(value);
      }
      case 'fit_cubic_inverse':
      case 'extrapolate_CBS':
        return cbsTwoPoint({
          energyA: requireScalar(args[0], node.name, 0),
          cardinalA: requireScalar(args[1], node.name, 1),
          energyB: requireScalar(args[2], node.name, 2),
          cardinalB: requireScalar(args[3], node.name, 3),
        });
      case 'hartree_to_kcal': return finite(requireScalar(args[0], 'hartree_to_kcal', 0) * HARTREE_TO_KCAL, 'hartree_to_kcal()');
      case 'kcal_to_hartree': return finite(requireScalar(args[0], 'kcal_to_hartree', 0) / HARTREE_TO_KCAL, 'kcal_to_hartree()');
      default: throw new ComputeError(`unknown function "${node.name}".`, { code: 'unknown-function', position: node.position });
    }
  }

  return read(ast);
}

/** Convenience: parse and evaluate in one call. */
export function evaluateExpression(source, scope = new Map()) {
  const calls = [];
  const value = evaluateAst(parseExpression(source), scope, calls);
  if (Array.isArray(value)) {
    throw new ComputeError('the expression evaluates to a record set; reduce it with sum(), mean(), min() or max().',
      { code: 'set-result' });
  }
  return { value, calls };
}

/* ── units ────────────────────────────────────────────────── */

const DIMENSIONLESS = null;

/** True when a subtree is built only from numbers — it carries no unit. */
function isConstant(node) {
  if (node.kind === 'number') return true;
  if (node.kind === 'name') return false;
  if (node.kind === 'unary') return isConstant(node.operand);
  if (node.kind === 'binary') return isConstant(node.left) && isConstant(node.right);
  if (node.kind === 'call') return false;
  return false;
}

/**
 * The unit of an expression, or null when this node will not claim one.
 *
 * Conservative by construction: a sum keeps the unit only when every operand
 * agrees; a product or quotient of two dimensioned inputs has no unit here
 * (Hartree² is not a unit this node reports); `sqrt` of a dimensioned value is
 * dimensionless as far as the card is concerned. The conversion and CBS helpers
 * declare their unit outright.
 */
export function unitOfAst(node, units = new Map()) {
  const unitOfArg = (arg) => unitOfAst(arg, units);
  const shared = (args) => {
    const values = args.map(unitOfArg);
    return values.every((value) => value === values[0]) ? values[0] : DIMENSIONLESS;
  };
  switch (node.kind) {
    case 'number': return DIMENSIONLESS;
    case 'name': {
      // An empty declared unit is dimensionless (`null` here), not "unknown":
      // a count is a count, and a CBS fit must refuse it by that name.
      const unit = units.has(node.name) ? units.get(node.name) : null;
      return unit ? unit : DIMENSIONLESS;
    }
    case 'unary': return unitOfArg(node.operand);
    case 'binary': {
      if (node.op === '+' || node.op === '-') return shared([node.left, node.right]);
      const left = unitOfArg(node.left);
      const right = unitOfArg(node.right);
      // Hartree × Hartree is not Hartree, and a ratio of two dimensioned
      // inputs is dimensionless only in a sense this node cannot state.
      if (isConstant(node.left)) return right;
      if (isConstant(node.right)) return left;
      return DIMENSIONLESS;
    }
    case 'call': {
      const fn = FUNCTION_BY_NAME.get(node.name);
      if (!fn) return DIMENSIONLESS;
      if (fn.resultUnit === 'unit') return shared(node.args);
      return fn.resultUnit;
    }
    default: return DIMENSIONLESS;
  }
}

/**
 * Refuse an expression whose dimensions cannot be right before evaluating it:
 * a CBS fit takes energies in Hartree and two dimensionless cardinal numbers.
 *
 * This is a static check on the AST and the declared input units — it does not
 * look at any record.
 */
export function assertUnits(ast, units = new Map()) {
  const visit = (node) => {
    if (node.kind === 'unary') return visit(node.operand);
    if (node.kind === 'binary') { visit(node.left); visit(node.right); return; }
    if (node.kind !== 'call') return;
    node.args.forEach(visit);
    const fn = FUNCTION_BY_NAME.get(node.name);
    if (!fn) return; // the evaluator refuses an unknown function by name
    if (CBS_FUNCTIONS.has(node.name)) {
      for (const index of [0, 2]) {
        const arg = node.args[index];
        const unit = unitOfAst(arg, units);
        if (unit !== 'hartree') {
          const named = arg.kind === 'name' ? `"${arg.name}"` : 'that argument';
          throw new ComputeError(`${node.name}() needs an energy in Hartree at argument ${index + 1},`
            + ` but ${named} is ${unit === null ? 'dimensionless' : `in ${unit}`}.`,
          { code: 'unit', position: node.position });
        }
      }
      for (const index of [1, 3]) {
        const unit = unitOfAst(node.args[index], units);
        if (unit !== null) {
          throw new ComputeError(`${node.name}() argument ${index + 1} is a cardinal number and must be`
            + ` dimensionless, not in ${unit}.`, { code: 'unit', position: node.position });
        }
      }
      return;
    }
    if (node.name === 'hartree_to_kcal' || node.name === 'kcal_to_hartree') {
      const wanted = node.name === 'hartree_to_kcal' ? 'hartree' : 'kcal/mol';
      const unit = unitOfAst(node.args[0], units);
      if (unit !== wanted) {
        throw new ComputeError(`${node.name}() converts from ${wanted}, but argument 1 is`
          + ` ${unit === null ? 'dimensionless' : `in ${unit}`}.`, { code: 'unit', position: node.position });
      }
    }
  };
  visit(ast);
  return ast;
}

/* ── inputs and results ───────────────────────────────────── */

/** `not computed: <field> missing for record <id>` — the one refusal wording. */
export function missingFieldMessage(field, recordId) {
  return `not computed: ${field} missing for record ${recordId}`;
}

/**
 * Declared inputs of a compute block, normalised.
 *
 * Each entry is `{ name, field, source, scope }`: `name` is the identifier the
 * expression uses, `field` a `COMPUTE_FIELDS` key, `source` the upstream block
 * id (empty means "the one block feeding this compute node"), and `scope` is
 * `'record'` (this record only) or `'records'` (every record of that block).
 */
export function computeInputsOf(definition) {
  const raw = Array.isArray(definition?.inputs) ? definition.inputs : [];
  const seen = new Set();
  return raw.map((entry, index) => {
    const name = String(entry?.name ?? '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new ComputeError(`input ${index + 1} has no usable name; a name is a letter or "_" followed by`
        + ' letters, digits or "_".', { code: 'input-name' });
    }
    if (seen.has(name)) {
      throw new ComputeError(`two inputs are both named "${name}"; an expression cannot tell them apart.`,
        { code: 'duplicate-input' });
    }
    seen.add(name);
    const field = String(entry?.field ?? '').trim();
    if (!FIELD_BY_KEY.has(field)) {
      throw new ComputeError(`input "${name}" reads "${field}", which is not a field a compute block can read;`
        + ` use one of ${COMPUTE_FIELD_KEYS.join(', ')}.`, { code: 'unknown-field' });
    }
    return {
      name,
      field,
      source: String(entry?.source ?? '').trim(),
      scope: entry?.scope === 'records' ? 'records' : 'record',
      unit: unitOfField(field),
    };
  });
}

/** The record id a refusal names: the dataset record, else the upstream block. */
function recordLabelFor(recordId, source) {
  return String(recordId || source || '');
}

/**
 * Evaluate one compute block for one record.
 *
 * `resolveSource(sourceId)` returns `{ run }` — a run record carrying `parsed` —
 * or null when that upstream block has produced nothing yet; `allRecords(sourceId)`
 * returns `[{ recordId, run }]` for a `scope: 'records'` input. Both are supplied
 * by the caller, so this module never reads a file or a project.
 *
 * Never throws for a data problem: an absent field, a missing upstream result or
 * a refusal inside the expression comes back as `status: 'refused'` (or
 * 'pending' when nothing upstream has run yet) with `notComputed` set. It throws
 * only for a malformed *definition* — a bad expression, an unknown function, an
 * undeclared identifier, a unit that cannot be right — which is a project that
 * should never have been queued.
 */
export function evaluateCompute(definition, {
  recordId = null,
  resolveSource = () => null,
  allRecords = () => [],
} = {}) {
  const expression = String(definition?.expression ?? '').trim();
  const inputs = computeInputsOf(definition);
  const ast = assertUnits(parseExpression(expression), new Map(inputs.map((input) => [input.name, input.unit])));
  const scope = new Map();
  const used = [];
  const messages = [];
  let pending = false;

  for (const input of inputs) {
    const unit = input.unit;
    if (input.scope === 'records') {
      const rows = allRecords(input.source).filter((row) => row && row.run);
      if (rows.length === 0) {
        pending = true;
        messages.push(`waiting for ${input.source || 'the upstream block'} to produce a record`);
        continue;
      }
      const values = [];
      let missing = null;
      for (const row of rows) {
        const value = fieldValueOf(row.run, input.field);
        if (!Number.isFinite(value)) {
          missing = { recordId: recordLabelFor(row.recordId, input.source) };
          break;
        }
        values.push(value);
        used.push({ recordId: recordLabelFor(row.recordId, input.source), field: input.field, value, unit });
      }
      if (missing) {
        return refusal(expression, used, missingFieldMessage(input.field, missing.recordId), { unit });
      }
      if (!scope.has(input.name)) scope.set(input.name, values);
      continue;
    }

    const resolved = resolveSource(input.source || null, recordId);
    if (!resolved || !resolved.run) {
      pending = true;
      messages.push(`waiting for ${input.source || 'the upstream block'} to produce a result`);
      continue;
    }
    const value = fieldValueOf(resolved.run, input.field);
    const recordIdForRefusal = recordLabelFor(resolved.recordId || recordId, input.source);
    if (!Number.isFinite(value)) {
      return refusal(expression, used, missingFieldMessage(input.field, recordIdForRefusal), { unit });
    }
    scope.set(input.name, value);
    used.push({ recordId: recordIdForRefusal, field: input.field, value, unit });
  }

  if (pending) {
    return {
      expression,
      status: 'pending',
      inputs: used,
      value: null,
      unit: null,
      functionCalls: [],
      notes: messages,
      notComputed: messages[0] || 'waiting for upstream results',
    };
  }

  const calls = [];
  let value;
  try {
    value = evaluateAst(ast, scope, calls);
  } catch (error) {
    if (!(error instanceof ComputeError)) throw error;
    return { ...refusal(expression, used, `not computed: ${error.message}`, { unit: unitOfAst(ast, new Map(inputs.map((input) => [input.name, input.unit]))) }), code: error.code };
  }
  if (Array.isArray(value)) {
    return refusal(expression, used, 'not computed: the expression evaluates to a record set; reduce it with sum(), mean(), min() or max().');
  }
  const unit = unitOfAst(ast, new Map(inputs.map((input) => [input.name, input.unit])));
  const notes = [];
  if (calls.some((call) => CBS_FUNCTIONS.has(call.name))) {
    notes.push(`${CBS_FORMULA} — a two-point extrapolation, not a number an engine printed.`);
  }
  if (unit === null && inputs.some((input) => input.unit)) {
    notes.push('the expression mixes dimensions, so no unit is claimed for the result.');
  }
  return {
    expression,
    status: 'computed',
    inputs: used,
    value,
    unit: unit === null ? null : unit,
    functionCalls: calls,
    notes,
    notComputed: null,
  };
}

function refusal(expression, inputs, message, { unit = null } = {}) {
  return {
    expression,
    status: 'refused',
    inputs,
    value: null,
    unit,
    functionCalls: [],
    notes: [message],
    notComputed: message,
  };
}

/**
 * The value of a field on a run record, or null.
 *
 * `runRow()` is the writer's own flattener, so `finalEnergyHartree` here is the
 * same number as the `final_energy_hartree` column, and an absent field is null
 * in both. `Number(null)` is 0, which is why the check is on the raw cell.
 */
export function fieldValueOf(run, field) {
  if (!run || typeof run !== 'object') return null;
  const parsed = run.parsed && typeof run.parsed === 'object' ? run.parsed : null;
  // A bare canonical result (a project node's `parsed`) has no wrapper: accept
  // it by wrapping, so the same field vocabulary reads both shapes.
  const record = parsed && run.parsed ? run : { parsed: run };
  const row = runRow(record);
  const value = row[field];
  return Number.isFinite(value) ? value : null;
}

/** A one-line description a card, a queue row and a report can share. */
export function describeCompute(result) {
  if (!result) return 'no result';
  const value = Number.isFinite(result.value)
    ? `${formatComputeNumber(result.value)}${result.unit ? ` ${result.unit}` : ''}`
    : null;
  if (result.status === 'computed' && value) return `${result.expression} = ${value}`;
  return result.notComputed || 'not computed';
}

/** Significant figures, not a fixed decimal count: an energy and a count differ. */
export function formatComputeNumber(value) {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude === 0) return '0';
  if (magnitude >= 1e-3 && magnitude < 1e7) {
    return String(Number(value.toFixed(Math.max(0, 9 - Math.floor(Math.log10(magnitude)) - 1))));
  }
  return value.toExponential(6);
}
