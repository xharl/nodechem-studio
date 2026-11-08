import { afterEach, describe, expect, it } from 'vitest';
import { ENGINES, ENGINE_IDS } from '../src/shared/engines/index.js';
import {
  ENGINE_SPEC_VERSION,
  EngineSpecError,
  engineIds,
  listEngines,
  pluginEngine,
  registerEngine,
  resolveEngine,
  unregisterEngine,
  validateEngineSpec,
} from '../src/shared/engines/registry.js';

/**
 * The engine seam is additive: the four static engines stay exactly as
 * `./index.js` exports them, and a spec registered here becomes a fifth. The
 * only engine defined in this file is the test engine, and it is unregistered
 * after every test.
 */

const TEST_ENGINE_ID = 'test-engine';

function testSpec() {
  return {
    id: TEST_ENGINE_ID,
    label: 'Test engine',
    extensions: { input: '.tin', output: '.tout' },
    buildArgv: ({ inputName }) => [inputName, '--fast'],
    parseOutput: (text) => ({
      canonicalVersion: 1,
      engine: TEST_ENGINE_ID,
      lineCount: String(text).split('\n').length,
    }),
    gates: (parsed) => ({
      overall: parsed.lineCount > 0 ? 'pass' : 'unknown',
      gates: [{ name: 'Has lines', required: true, result: 'pass', detail: null }],
    }),
  };
}

afterEach(() => {
  unregisterEngine(TEST_ENGINE_ID);
});

describe('engine registry — accept', () => {
  it('registers a complete spec and exposes the runner-facing shape', () => {
    const engine = registerEngine(testSpec());
    expect(engine.plugin).toBe(true);
    expect(engine.specVersion).toBe(ENGINE_SPEC_VERSION);
    expect(engine.id).toBe(TEST_ENGINE_ID);
    expect(engine.capabilities.inputExtension).toBe('.tin');
    expect(engine.acceptsInputName('job.tin')).toBe(true);
    expect(engine.acceptsInputName('job.tout')).toBe(false);
    expect(engine.acceptsInputName('nested/job.tin')).toBe(false);
    expect(engine.acceptsOutputName('job.tout')).toBe(true);
    expect(engine.buildArgv({ inputName: 'job.tin' })).toEqual(['job.tin', '--fast']);
    expect(engine.parse('a\nb').lineCount).toBe(2);
    expect(engine.parseOutput).toBe(engine.parse);
    expect(engine.gates({ lineCount: 2 }).overall).toBe('pass');
    // Optional hooks have safe defaults.
    expect(engine.detect({})).toBe(false);
    expect(engine.toCanonical({ a: 1 })).toEqual({ a: 1 });
    expect(engineIds()).toContain(TEST_ENGINE_ID);
    expect(pluginEngine(TEST_ENGINE_ID)).toBe(engine);
  });

  it('keeps every static engine working next to a plugin', () => {
    registerEngine(testSpec());
    expect(listEngines()).toHaveLength(ENGINE_IDS.length + 1);
    for (const id of ENGINE_IDS) {
      expect(resolveEngine(id)).toBe(ENGINES[id]);
    }
    expect(listEngines().slice(0, ENGINE_IDS.length)).toEqual(ENGINE_IDS.map((id) => ENGINES[id]));
    expect(resolveEngine(TEST_ENGINE_ID).id).toBe(TEST_ENGINE_ID);
  });

  it('refuses a spec whose argv builder returns something else than strings', () => {
    const spec = { ...testSpec(), buildArgv: () => 'job.tin' };
    const engine = registerEngine(spec);
    expect(() => engine.buildArgv({ inputName: 'job.tin' })).toThrow(/must return an array of strings/);
  });
});

describe('engine registry — refuse', () => {
  it('names the missing key of an incomplete spec', () => {
    for (const key of ['id', 'extensions', 'buildArgv', 'parseOutput', 'gates']) {
      const spec = testSpec();
      delete spec[key];
      const verdict = validateEngineSpec(spec);
      expect(verdict.ok, key).toBe(false);
      expect(verdict.missing, key).toContain(key);
      let caught = null;
      try {
        registerEngine(spec);
      } catch (error) {
        caught = error;
      }
      expect(caught, key).toBeInstanceOf(EngineSpecError);
      expect(caught.code).toBe('engine-spec-invalid');
      expect(caught.message, key).toContain(`"${key}"`);
      expect(caught.missing, key).toContain(key);
    }
  });

  it('names a missing nested extension', () => {
    const spec = testSpec();
    delete spec.extensions.output;
    expect(() => registerEngine(spec)).toThrow(/extensions\.output/);
  });

  it('refuses a non-function parser and a wrong-typed id', () => {
    expect(() => registerEngine({ ...testSpec(), parseOutput: 'nope' }))
      .toThrow(/"parseOutput" must be a function/);
    expect(() => registerEngine({ ...testSpec(), id: 'Test Engine' }))
      .toThrow(/"id" must match/);
    expect(() => registerEngine(null)).toThrow(/engine spec must be an object/);
  });

  it('refuses a duplicate id and cannot shadow a static engine', () => {
    registerEngine(testSpec());
    expect(() => registerEngine(testSpec())).toThrow(/already registered/);
    expect(unregisterEngine(TEST_ENGINE_ID)).toBe(true);
    expect(unregisterEngine(TEST_ENGINE_ID)).toBe(false);
    expect(() => registerEngine({ ...testSpec(), id: 'gaussian' }))
      .toThrow(/already registered/);
    expect(ENGINES.gaussian.id).toBe('gaussian');
  });

  it('leaves the registry untouched after a refusal', () => {
    const spec = testSpec();
    delete spec.gates;
    expect(() => registerEngine(spec)).toThrow(EngineSpecError);
    expect(pluginEngine(TEST_ENGINE_ID)).toBe(null);
    expect(engineIds()).not.toContain(TEST_ENGINE_ID);
  });

  it('resolves only known ids', () => {
    expect(() => resolveEngine('nope')).toThrow(/Unknown engine "nope"/);
  });
});
