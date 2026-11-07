import { describe, it, expect } from 'vitest';
import {
  ConditionError,
  conditionFields,
  evaluateCondition,
} from '../src/shared/controlFlow.js';
import { parseGaussianOutput, evaluateGates } from '../src/shared/gaussianOutput.js';
import { makeFixtureOutput } from '../src/shared/fixtureOutput.js';

function fieldsFor(imaginary = 0) {
  const parsed = parseGaussianOutput(makeFixtureOutput({ imaginary }));
  return conditionFields(parsed, evaluateGates(parsed, { expectedImaginary: imaginary }));
}

describe('conditionFields', () => {
  it('exposes the values a condition may reference', () => {
    const fields = fieldsFor(0);
    expect(fields).toMatchObject({
      normalTermination: true,
      errorTermination: false,
      scfConverged: true,
      optimizationCompleted: true,
      imaginaryCount: 0,
      modeCount: 4,
      gatePass: true,
    });
    expect(fields.minImaginary).toBeNull();
    expect(fields.absMinImaginary).toBeNull();
  });

  it('exposes imaginary magnitude for a TS-like frequency result', () => {
    const fields = fieldsFor(1);
    expect(fields.imaginaryCount).toBe(1);
    expect(fields.minImaginary).toBe(-420);
    expect(fields.absMinImaginary).toBe(420);
  });

  it('tolerates a missing parsed result', () => {
    expect(conditionFields(null, null)).toMatchObject({
      normalTermination: false,
      scfConverged: false,
      imaginaryCount: 0,
    });
  });
});

describe('evaluateCondition', () => {
  it('compares counts and magnitudes with the documented grammar', () => {
    const ts = fieldsFor(1);
    expect(evaluateCondition('imaginaryCount == 1', ts).value).toBe(true);
    expect(evaluateCondition('imaginaryCount == 0', ts).value).toBe(false);
    expect(evaluateCondition('imaginaryCount == 1 and abs(nu) >= 50', ts).value).toBe(true);
    expect(evaluateCondition('imaginaryCount == 1 and abs(nu) >= 500', ts).value).toBe(false);
  });

  it('supports arithmetic, parentheses, not and or', () => {
    const ts = fieldsFor(1);
    expect(evaluateCondition('1 + 2 * 3 == 7', ts).value).toBe(true);
    expect(evaluateCondition('(1 + 2) * 3 == 9', ts).value).toBe(true);
    expect(evaluateCondition('not gateFail', ts).value).toBe(true);
    expect(evaluateCondition('gateFail or imaginaryCount == 1', ts).value).toBe(true);
    expect(evaluateCondition('gateFail and imaginaryCount == 1', ts).value).toBe(false);
  });

  it('treats a bare boolean field as its truth value', () => {
    expect(evaluateCondition('scfConverged', fieldsFor(0)).value).toBe(true);
    expect(evaluateCondition('errorTermination', fieldsFor(0)).value).toBe(false);
  });

  it('returns unknown for a field the output does not contain', () => {
    const result = evaluateCondition('magnetization > 0', fieldsFor(0));
    expect(result.value).toBeNull();
    expect(result.reason).toContain('magnetization');
  });

  it('applies the condition node unknown policy', () => {
    const fields = fieldsFor(0);
    expect(evaluateCondition('magnetization > 0', fields, { unknownPolicy: 'treat-false' }).value).toBe(false);
    expect(evaluateCondition('magnetization > 0', fields, { unknownPolicy: 'treat-true' }).value).toBe(true);
  });

  it('reports a syntax error instead of guessing', () => {
    const result = evaluateCondition('imaginaryCount ==', fieldsFor(0));
    expect(result.value).toBeNull();
    expect(result.error).toMatch(/Unexpected|Expected/);
  });

  it('reports division by zero', () => {
    const result = evaluateCondition('1 / 0 == 1', fieldsFor(0));
    expect(result.value).toBeNull();
    expect(result.reason).toContain('Division by zero');
  });

  it('treats an empty expression as unknown, not pass', () => {
    const result = evaluateCondition('   ', fieldsFor(0));
    expect(result.value).toBeNull();
    expect(result.reason).toContain('no expression');
  });

  it('exposes ConditionError as a class for callers', () => {
    expect(new ConditionError('x')).toBeInstanceOf(Error);
  });
});
