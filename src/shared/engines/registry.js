/**
 * Engine plugin seam.
 *
 * `./index.js` is the static registry: five engines compiled into the app. This
 * module is the additive seam beside it. A host — a test, a CLI runner, a
 * future user-directory loader — hands `registerEngine(spec)` a descriptor and
 * receives a frozen engine object shaped like the static ones, without editing
 * `index.js` or rebuilding the app.
 *
 * What a spec must carry (all required unless stated):
 *
 *   id            lowercase slug, unique across static and plugin engines
 *   extensions    { input, output } — dot-prefixed basenames, e.g. '.inp'
 *   buildArgv     ({ inputName, outputName, settings, molecule }) => string[]
 *   parseOutput   (text, options) => canonical result (see ./canonical.js)
 *   gates         (parsed, options) => { overall, gates: [{ name, required, result, detail }] }
 *
 * Optional:
 *
 *   label, capabilities, detect(settings), toCanonical(parsed)
 *
 * Everything is validated before a single field reaches the registry, and the
 * error names the key that is wrong: a half-registered engine that fails at run
 * time is worse than a refused registration at load time. See
 * `docs/ENGINE_PLUGIN.md` for the contract and an example.
 *
 * There is no sandbox: a plugin is JavaScript the host imported, with the
 * host's privileges. The seam decides *what* an engine is, not *whether* to
 * trust it.
 */

import { ENGINES, ENGINE_IDS, isEngineId } from './index.js';

/** Version of the descriptor contract itself. */
export const ENGINE_SPEC_VERSION = 1;

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const EXTENSION_PATTERN = /^\.[A-Za-z0-9]+$/;

/** id → frozen descriptor for engines registered through the seam. */
const pluginEngines = new Map();

/**
 * A refused engine spec. `problems` always names the offending key, and
 * `missing` is the subset that was absent altogether.
 */
export class EngineSpecError extends Error {
  constructor(id, problems) {
    const name = id ? `"${id}"` : '(no id)';
    const missing = problems.filter((problem) => problem.kind === 'missing').map((problem) => problem.key);
    const detail = problems.map((problem) => problem.message).join(' ');
    super(`Engine spec ${name} is invalid: ${detail}`);
    this.name = 'EngineSpecError';
    this.code = 'engine-spec-invalid';
    this.engineId = id || null;
    this.problems = problems;
    this.missing = missing;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(spec, key, { pattern = null, description = 'a non-empty string' } = {}) {
  const value = spec?.[key];
  if (value === undefined || value === null || value === '') {
    return { kind: 'missing', key, message: `missing "${key}" (${description}).` };
  }
  if (typeof value !== 'string') {
    return { kind: 'type', key, message: `"${key}" must be ${description}.` };
  }
  if (pattern && !pattern.test(value)) {
    return { kind: 'shape', key, message: `"${key}" must match ${pattern}.` };
  }
  return null;
}

function requireFunction(spec, key) {
  const value = spec?.[key];
  if (value === undefined || value === null) {
    return { kind: 'missing', key, message: `missing "${key}" (a function).` };
  }
  if (typeof value !== 'function') {
    return { kind: 'type', key, message: `"${key}" must be a function.` };
  }
  return null;
}

/**
 * Check a spec without registering it.
 *
 * Returns `{ ok, problems, missing }`; `missing` lists the absent keys, so a
 * caller can say exactly what a half-written plugin lacks.
 */
export function validateEngineSpec(spec) {
  if (!isPlainObject(spec)) {
    return {
      ok: false,
      problems: [{ kind: 'type', key: 'spec', message: 'the engine spec must be an object.' }],
      missing: [],
    };
  }
  const problems = [];
  const push = (problem) => { if (problem) problems.push(problem); };

  push(requireString(spec, 'id', {
    pattern: ID_PATTERN,
    description: 'a lowercase slug such as "mopac"',
  }));

  if (spec.label !== undefined && typeof spec.label !== 'string') {
    problems.push({ kind: 'type', key: 'label', message: '"label" must be a string.' });
  }
  if (spec.capabilities !== undefined && !isPlainObject(spec.capabilities)) {
    problems.push({ kind: 'type', key: 'capabilities', message: '"capabilities" must be an object.' });
  }

  if (spec.extensions === undefined || spec.extensions === null) {
    problems.push({ kind: 'missing', key: 'extensions', message: 'missing "extensions" ({ input, output }).' });
  } else if (!isPlainObject(spec.extensions)) {
    problems.push({ kind: 'type', key: 'extensions', message: '"extensions" must be an object.' });
  } else {
    for (const key of ['input', 'output']) {
      const value = spec.extensions[key];
      const fullKey = `extensions.${key}`;
      if (value === undefined || value === null || value === '') {
        problems.push({
          kind: 'missing',
          key: fullKey,
          message: `missing "${fullKey}" (a dot-prefixed extension such as "${key === 'input' ? '.inp' : '.out'}").`,
        });
      } else if (typeof value !== 'string' || !EXTENSION_PATTERN.test(value)) {
        problems.push({
          kind: 'shape',
          key: fullKey,
          message: `"${fullKey}" must be a dot-prefixed extension such as "${key === 'input' ? '.inp' : '.out'}".`,
        });
      }
    }
  }

  push(requireFunction(spec, 'buildArgv'));
  push(requireFunction(spec, 'parseOutput'));
  push(requireFunction(spec, 'gates'));
  if (spec.detect !== undefined && typeof spec.detect !== 'function') {
    problems.push({ kind: 'type', key: 'detect', message: '"detect" must be a function when present.' });
  }
  if (spec.toCanonical !== undefined && typeof spec.toCanonical !== 'function') {
    problems.push({ kind: 'type', key: 'toCanonical', message: '"toCanonical" must be a function when present.' });
  }

  return {
    ok: problems.length === 0,
    problems,
    missing: problems.filter((problem) => problem.kind === 'missing').map((problem) => problem.key),
  };
}

function acceptsExtension(extension) {
  return (name) => {
    const text = String(name ?? '');
    if (!text.endsWith(extension)) return false;
    const base = text.slice(0, -extension.length);
    return base.length > 0 && !/[\\/]/.test(base) && base !== '.' && base !== '..';
  };
}

/**
 * Register one engine descriptor.
 *
 * Returns the frozen engine object. Throws `EngineSpecError` for an incomplete
 * spec, a duplicate id (static ids cannot be shadowed), or an invalid id.
 */
export function registerEngine(spec) {
  const result = validateEngineSpec(spec);
  if (!result.ok) throw new EngineSpecError(isPlainObject(spec) ? spec.id : null, result.problems);

  const id = spec.id;
  if (isEngineId(id) || pluginEngines.has(id)) {
    throw new EngineSpecError(id, [{
      kind: 'duplicate',
      key: 'id',
      message: `"id" is already registered; engine ids are unique across the static registry and plugins.`,
    }]);
  }

  const inputExtension = spec.extensions.input;
  const outputExtension = spec.extensions.output;
  const label = spec.label || id;
  // The static engines expose `buildInput`; a plugin is a runner-facing engine,
  // so it names its argv builder instead and gets the same `parse` alias the
  // runner already calls.
  const descriptor = Object.freeze({
    id,
    label,
    plugin: true,
    specVersion: ENGINE_SPEC_VERSION,
    extensions: Object.freeze({ input: inputExtension, output: outputExtension }),
    capabilities: Object.freeze({
      ...(isPlainObject(spec.capabilities) ? spec.capabilities : {}),
      id,
      label,
      inputExtension,
      outputExtension,
    }),
    acceptsInputName: acceptsExtension(inputExtension),
    acceptsOutputName: acceptsExtension(outputExtension),
    detect: typeof spec.detect === 'function' ? spec.detect : () => false,
    /**
     * The runner calls `engine.buildArgv` for a plugin engine; the returned
     * vector is checked here so a plugin cannot hand the runner a non-array.
     */
    buildArgv(context = {}) {
      const argv = spec.buildArgv(context);
      if (!Array.isArray(argv) || argv.some((entry) => typeof entry !== 'string')) {
        throw new Error(`Engine "${id}" buildArgv() must return an array of strings.`);
      }
      return [...argv];
    },
    parseOutput: spec.parseOutput,
    parse: spec.parseOutput,
    gates: spec.gates,
    toCanonical: typeof spec.toCanonical === 'function' ? spec.toCanonical : (parsed) => parsed,
  });

  pluginEngines.set(id, descriptor);
  return descriptor;
}

/** Remove a plugin engine. Static engines cannot be removed; returns false then. */
export function unregisterEngine(id) {
  return pluginEngines.delete(String(id));
}

/** A registered plugin descriptor, or `null`. */
export function pluginEngine(id) {
  return pluginEngines.get(String(id)) || null;
}

/** Ids of engines registered through the seam, in registration order. */
export function pluginEngineIds() {
  return [...pluginEngines.keys()];
}

/** Every id a host can resolve: the static engines first, then plugins. */
export function engineIds() {
  return [...ENGINE_IDS, ...pluginEngines.keys()];
}

/**
 * Every engine descriptor this process knows: the static engines exactly as
 * `./index.js` exports them, then plugins in registration order.
 */
export function listEngines() {
  return [...ENGINE_IDS.map((id) => ENGINES[id]), ...pluginEngines.values()];
}

/** Resolve a static or plugin engine. Throws on an unknown id. */
export function resolveEngine(id) {
  const key = String(id);
  if (pluginEngines.has(key)) return pluginEngines.get(key);
  if (isEngineId(key)) return ENGINES[key];
  throw new Error(`Unknown engine "${key}". Known engines: ${engineIds().join(', ')}.`);
}
