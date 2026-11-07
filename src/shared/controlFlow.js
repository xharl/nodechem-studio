/**
 * Condition and loop semantics for the workflow queue.
 *
 * Conditions are a small, safe expression language over fields parsed from the
 * upstream Gaussian result. No `eval`, no property access, no function calls
 * beyond `abs(...)`: a project file cannot execute anything.
 *
 * Grammar:
 *   expr    := or
 *   or      := and ('or' and)*
 *   and     := not ('and' not)*
 *   not     := 'not' not | comparison
 *   compare := sum (('=='|'!='|'>='|'<='|'>'|'<') sum)?
 *   sum     := product (('+'|'-') product)*
 *   product := unary (('*'|'/') unary)*
 *   unary   := '-' unary | primary
 *   primary := number | 'true' | 'false' | identifier | 'abs' '(' expr ')' | '(' expr ')'
 *
 * An unknown field makes the comparison unknown (`null`), never false. The
 * condition node's `unknown` policy decides what to do with that.
 */

export class ConditionError extends Error {}

const FIELD_ALIASES = {
  nu: 'minImaginary',
};

export function conditionFields(parsed, gates = null) {
  const frequencies = parsed?.frequencies || {};
  const scf = parsed?.scf || {};
  const optimization = parsed?.optimization || {};
  const termination = parsed?.termination || 'No termination marker';
  const minImaginary = Number.isFinite(frequencies.minImaginary) ? frequencies.minImaginary : null;
  return {
    normalTermination: termination === 'Normal termination of Gaussian',
    errorTermination: termination === 'Error termination',
    scfConverged: scf.status === 'converged',
    scfFailed: scf.status === 'failed',
    optimizationCompleted: Boolean(optimization.completed),
    stationaryPoint: Boolean(optimization.stationary),
    modeCount: Number(frequencies.count) || 0,
    imaginaryCount: Number(frequencies.imaginaryCount) || 0,
    minImaginary,
    absMinImaginary: minImaginary === null ? null : Math.abs(minImaginary),
    freeEnergy: Number.isFinite(parsed?.thermochemistry?.freeEnergyHartree)
      ? parsed.thermochemistry.freeEnergyHartree
      : null,
    finalEnergy: Number.isFinite(parsed?.finalEnergy?.hartree) ? parsed.finalEnergy.hartree : null,
    gatePass: gates?.overall === 'pass',
    gateFail: gates?.overall === 'fail',
  };
}

/* ── Tokenizer ────────────────────────────────────────────── */

const PATTERN = /(\d+(?:\.\d*)?(?:[eE][-+]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(==|!=|>=|<=|>|<|\+|-|\*|\/|\(|\))/y;

function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) {
      index += whitespace[0].length;
      continue;
    }
    PATTERN.lastIndex = index;
    const match = PATTERN.exec(source);
    if (!match) {
      throw new ConditionError(`Unexpected character "${source[index]}" at position ${index + 1}.`);
    }
    index = PATTERN.lastIndex;
    if (match[1] !== undefined) tokens.push({ type: 'number', value: Number(match[1]) });
    else if (match[2] !== undefined) tokens.push({ type: 'word', value: match[2] });
    else tokens.push({ type: 'op', value: match[3] });
  }
  tokens.push({ type: 'eof' });
  return tokens;
}

/* ── Parser ───────────────────────────────────────────────── */

class Parser {
  constructor(tokens, source) {
    this.tokens = tokens;
    this.index = 0;
    this.source = source;
  }

  peek() { return this.tokens[this.index]; }

  next() { return this.tokens[this.index++]; }

  matchOp(value) {
    const token = this.peek();
    if (token.type === 'op' && token.value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  matchWord(value) {
    const token = this.peek();
    if (token.type === 'word' && token.value.toLowerCase() === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  expectOp(value) {
    if (!this.matchOp(value)) {
      const token = this.peek();
      throw new ConditionError(`Expected "${value}" but found ${describeToken(token)}.`);
    }
  }

  parse() {
    const node = this.parseOr();
    if (this.peek().type !== 'eof') {
      throw new ConditionError(`Unexpected ${describeToken(this.peek())} after the expression.`);
    }
    return node;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.matchWord('or')) left = { type: 'or', left, right: this.parseAnd() };
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    while (this.matchWord('and')) left = { type: 'and', left, right: this.parseNot() };
    return left;
  }

  parseNot() {
    if (this.matchWord('not')) return { type: 'not', value: this.parseNot() };
    return this.parseComparison();
  }

  parseComparison() {
    const left = this.parseSum();
    const token = this.peek();
    if (token.type === 'op' && ['==', '!=', '>=', '<=', '>', '<'].includes(token.value)) {
      this.index += 1;
      return { type: 'compare', op: token.value, left, right: this.parseSum() };
    }
    return left;
  }

  parseSum() {
    let left = this.parseProduct();
    for (;;) {
      if (this.matchOp('+')) left = { type: 'binary', op: '+', left, right: this.parseProduct() };
      else if (this.matchOp('-')) left = { type: 'binary', op: '-', left, right: this.parseProduct() };
      else return left;
    }
  }

  parseProduct() {
    let left = this.parseUnary();
    for (;;) {
      if (this.matchOp('*')) left = { type: 'binary', op: '*', left, right: this.parseUnary() };
      else if (this.matchOp('/')) left = { type: 'binary', op: '/', left, right: this.parseUnary() };
      else return left;
    }
  }

  parseUnary() {
    if (this.matchOp('-')) return { type: 'negate', value: this.parseUnary() };
    return this.parsePrimary();
  }

  parsePrimary() {
    const token = this.next();
    if (token.type === 'number') return { type: 'number', value: token.value };
    if (token.type === 'op' && token.value === '(') {
      const inner = this.parseOr();
      this.expectOp(')');
      return inner;
    }
    if (token.type === 'word') {
      const word = token.value;
      const lower = word.toLowerCase();
      if (lower === 'true') return { type: 'boolean', value: true };
      if (lower === 'false') return { type: 'boolean', value: false };
      if (lower === 'abs') {
        this.expectOp('(');
        const inner = this.parseOr();
        this.expectOp(')');
        return { type: 'abs', value: inner };
      }
      return { type: 'identifier', name: word };
    }
    throw new ConditionError(`Unexpected ${describeToken(token)}.`);
  }
}

function describeToken(token) {
  if (token.type === 'eof') return 'the end of the expression';
  if (token.type === 'number') return `number ${token.value}`;
  return `"${token.value}"`;
}

/* ── Evaluation ───────────────────────────────────────────── */

function truth(value) {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return null;
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function evaluateNode(node, fields, used) {
  switch (node.type) {
    case 'number':
      return node.value;
    case 'boolean':
      return node.value;
    case 'identifier': {
      const key = FIELD_ALIASES[node.name] || node.name;
      const value = Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : null;
      used[key] = value;
      return typeof value === 'number' || typeof value === 'boolean' ? value : null;
    }
    case 'negate': {
      const value = number(evaluateNode(node.value, fields, used));
      return value === null ? null : -value;
    }
    case 'abs': {
      const value = number(evaluateNode(node.value, fields, used));
      return value === null ? null : Math.abs(value);
    }
    case 'not': {
      const value = truth(evaluateNode(node.value, fields, used));
      return value === null ? null : !value;
    }
    case 'and': {
      const left = truth(evaluateNode(node.left, fields, used));
      if (left === false) return false;
      const right = truth(evaluateNode(node.right, fields, used));
      if (right === false) return false;
      return left === null || right === null ? null : true;
    }
    case 'or': {
      const left = truth(evaluateNode(node.left, fields, used));
      if (left === true) return true;
      const right = truth(evaluateNode(node.right, fields, used));
      if (right === true) return true;
      return left === null || right === null ? null : false;
    }
    case 'binary': {
      const left = number(evaluateNode(node.left, fields, used));
      const right = number(evaluateNode(node.right, fields, used));
      if (left === null || right === null) return null;
      if (node.op === '+') return left + right;
      if (node.op === '-') return left - right;
      if (node.op === '*') return left * right;
      if (right === 0) throw new ConditionError('Division by zero in the condition.');
      return left / right;
    }
    case 'compare': {
      const left = evaluateNode(node.left, fields, used);
      const right = evaluateNode(node.right, fields, used);
      if (left === null || right === null) return null;
      if (typeof left !== typeof right && !(typeof left === 'number' && typeof right === 'number')) return null;
      switch (node.op) {
        case '==': return left === right;
        case '!=': return left !== right;
        case '>': return left > right;
        case '>=': return left >= right;
        case '<': return left < right;
        case '<=': return left <= right;
        default: throw new ConditionError(`Unsupported comparison "${node.op}".`);
      }
    }
    default:
      throw new ConditionError(`Unsupported expression node "${node.type}".`);
  }
}

/**
 * Evaluate a condition expression.
 * Returns { value: true|false|null, reason, evidence, error }.
 * `value === null` means unknown: the caller applies the node's unknown policy.
 */
export function evaluateCondition(expression, fields, { unknownPolicy = 'block-both' } = {}) {
  const source = String(expression ?? '').trim();
  if (!source) return { value: null, reason: 'the condition has no expression', evidence: {}, error: null };

  let ast;
  try {
    ast = new Parser(tokenize(source), source).parse();
  } catch (error) {
    if (error instanceof ConditionError) {
      return { value: null, reason: `invalid expression: ${error.message}`, evidence: {}, error: error.message };
    }
    throw error;
  }

  const used = {};
  let raw;
  try {
    raw = evaluateNode(ast, fields || {}, used);
  } catch (error) {
    if (error instanceof ConditionError) {
      return { value: null, reason: error.message, evidence: used, error: error.message };
    }
    throw error;
  }

  const verdict = truth(raw);
  const evidence = Object.fromEntries(
    Object.entries(used).filter(([, value]) => value !== null && value !== undefined),
  );
  const unknownFields = Object.entries(used).filter(([, value]) => value === null || value === undefined).map(([key]) => key);

  if (verdict === null) {
    const policy = ['block-both', 'treat-false', 'treat-true'].includes(unknownPolicy) ? unknownPolicy : 'block-both';
    const reason = `unknown (${unknownFields.length ? unknownFields.join(', ') : 'no evidence'}) → policy ${policy}`;
    if (policy === 'treat-false') return { value: false, reason, evidence, error: null };
    if (policy === 'treat-true') return { value: true, reason, evidence, error: null };
    return { value: null, reason, evidence, error: null };
  }

  return { value: verdict, reason: `evaluated ${verdict ? 'true' : 'false'}`, evidence, error: null };
}

export function branchTargetFor(conditionResult) {
  if (conditionResult === true) return 'true';
  if (conditionResult === false) return 'false';
  return null;
}
