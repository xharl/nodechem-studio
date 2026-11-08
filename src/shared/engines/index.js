/**
 * Engine registry.
 *
 * One place that knows which calculation engines exist and how to drive them.
 * The renderer uses `buildInput` to produce a run payload; the runner uses
 * `parse`, `classify` and the name validators. Gates and condition fields only
 * ever see the canonical result (see ./canonical.js).
 */

import {
  buildGaussianInput,
  methodBlockFor,
  outputNameFor as gaussianOutputNameFor,
} from '../gaussianInput.js';
import { parseGaussianOutput } from '../gaussianOutput.js';
import { makeFixtureOutput } from '../fixtureOutput.js';
import { terminationCodeOf } from './canonical.js';
import {
  XTB_CAPABILITIES,
  XTB_ENGINE_ID,
  buildXtbInput,
  classifyXtbTermination,
  isSafeXtbInputName,
  isSafeXtbOutputName,
  makeXtbFixtureOutput,
  parseXtbOutput,
  xtbMethodBlock,
} from './xtb.js';
import {
  ORCA_CAPABILITIES,
  ORCA_ENGINE_ID,
  buildOrcaInput,
  classifyOrcaTermination,
  isSafeOrcaInputName,
  isSafeOrcaOutputName,
  makeOrcaFixtureOutput,
  orcaCheckpointArtifact,
  orcaMethodBlock,
  parseOrcaOutput,
} from './orca.js';
import {
  PSI4_CAPABILITIES,
  PSI4_ENGINE_ID,
  buildPsi4Input,
  classifyPsi4Termination,
  isSafePsi4InputName,
  isSafePsi4OutputName,
  makePsi4FixtureOutput,
  parsePsi4Output,
  psi4MethodBlock,
} from './psi4.js';

const GAUSSIAN_INPUT = /^[A-Za-z0-9._-]+\.(gjf|com)$/i;
const GAUSSIAN_OUTPUT = /^[A-Za-z0-9._-]+\.(out|log)$/i;

export const GAUSSIAN_ENGINE = Object.freeze({
  id: 'gaussian',
  label: 'Gaussian 16',
  capabilities: Object.freeze({
    id: 'gaussian',
    label: 'Gaussian 16',
    inputExtension: '.gjf',
    outputExtension: '.out',
    capturesStdout: false,
    restartArtifact: 'chk',
    exitCodes: Object.freeze({ success: 0 }),
    builtInDispersion: null,
    unsupportedFeatures: Object.freeze([]),
  }),

  acceptsInputName: (name) => GAUSSIAN_INPUT.test(String(name)),
  acceptsOutputName: (name) => GAUSSIAN_OUTPUT.test(String(name)),

  /**
   * The provenance method block for a Gaussian job. It is exactly the block
   * `methodBlockFor` writes into the manifest today; the hook exists so the
   * runner never assumes Gaussian when an engine supplies its own vocabulary.
   */
  methodBlock(settings = {}) {
    return methodBlockFor(settings);
  },

  /** A Gaussian checkpoint is named by the task; `%Chk` writes that file. */
  checkpointArtifact({ checkpointName = '', nodeId = 'task' } = {}) {
    return String(checkpointName || `${nodeId}.chk`);
  },

  /** Thin wrapper so callers can build either engine's input the same way. */
  buildInput({ title, settings, molecule, inputName, oldCheckpoint = '' }) {
    const text = buildGaussianInput({ title, settings, molecule, inputName, oldCheckpoint });
    return {
      engine: 'gaussian',
      inputName,
      inputText: text,
      outputName: gaussianOutputNameFor(inputName),
      argv: [inputName],
      captureStdout: false,
      route: '',
    };
  },

  parse(text, options = {}) {
    return parseGaussianOutput(text, options);
  },

  makeFixture({ imaginary = 0, multiplicity = 1 } = {}) {
    return makeFixtureOutput({ imaginary, multiplicity });
  },

  classify(text, exitCode) {
    const parsed = parseGaussianOutput(String(text || ''));
    const code = terminationCodeOf(parsed);
    if (code === 'normal') return { code, reason: 'Normal termination of Gaussian' };
    if (code === 'error') return { code, reason: 'Error termination' };
    const numeric = Number(exitCode);
    if (Number.isFinite(numeric) && numeric !== 0) {
      return { code: 'error', reason: `Gaussian exited with code ${numeric} and produced no termination record` };
    }
    return { code: 'none', reason: 'no termination marker' };
  },
});

export const XTB_ENGINE = Object.freeze({
  id: XTB_ENGINE_ID,
  label: XTB_CAPABILITIES.label,
  capabilities: XTB_CAPABILITIES,

  acceptsInputName: isSafeXtbInputName,
  acceptsOutputName: isSafeXtbOutputName,

  buildInput: buildXtbInput,
  methodBlock: xtbMethodBlock,
  parse: parseXtbOutput,

  /**
   * xTB reads its restart data from `xtbrestart` in the working directory; the
   * name is fixed by the engine, never by the node's Gaussian checkpoint field.
   */
  checkpointArtifact() {
    return XTB_CAPABILITIES.restartArtifact;
  },

  makeFixture({ imaginary = 0 } = {}) {
    return makeXtbFixtureOutput({ imaginary });
  },

  classify: classifyXtbTermination,
});

export const ORCA_ENGINE = Object.freeze({
  id: ORCA_ENGINE_ID,
  label: ORCA_CAPABILITIES.label,
  capabilities: ORCA_CAPABILITIES,

  acceptsInputName: isSafeOrcaInputName,
  acceptsOutputName: isSafeOrcaOutputName,

  buildInput: buildOrcaInput,
  methodBlock: orcaMethodBlock,
  parse: parseOrcaOutput,

  /**
   * ORCA restart data is the `<job>.gbw` file, not a Gaussian checkpoint. A
   * `.chk` name configured on the block is mapped to its `.gbw` sibling so the
   * checkpoint edge has something ORCA can actually name.
   */
  checkpointArtifact: orcaCheckpointArtifact,

  makeFixture({ imaginary = 0 } = {}) {
    return makeOrcaFixtureOutput({ imaginary });
  },

  classify: classifyOrcaTermination,
});

export const PSI4_ENGINE = Object.freeze({
  id: PSI4_ENGINE_ID,
  label: PSI4_CAPABILITIES.label,
  capabilities: PSI4_CAPABILITIES,

  acceptsInputName: isSafePsi4InputName,
  acceptsOutputName: isSafePsi4OutputName,

  buildInput: buildPsi4Input,
  methodBlock: psi4MethodBlock,
  parse: parsePsi4Output,

  /**
   * Psi4 leaves no restart file this app can hand to another block. Returning a
   * name keeps the generic task builder working; no checkpoint edge is offered
   * for a Psi4 block, and the queue refuses one that a stale project carries.
   */
  checkpointArtifact({ nodeId = 'task' } = {}) {
    return `${nodeId}.chk`;
  },

  makeFixture({ imaginary = 0 } = {}) {
    return makePsi4FixtureOutput({ imaginary });
  },

  classify: classifyPsi4Termination,
});

export const ENGINES = Object.freeze({
  gaussian: GAUSSIAN_ENGINE,
  xtb: XTB_ENGINE,
  orca: ORCA_ENGINE,
  psi4: PSI4_ENGINE,
});

export const ENGINE_IDS = Object.freeze(Object.keys(ENGINES));

export const DEFAULT_ENGINE_ID = 'gaussian';

export function isEngineId(id) {
  return Object.prototype.hasOwnProperty.call(ENGINES, String(id));
}

/** Resolve an engine id, falling back to Gaussian for missing or unknown values. */
export function engineOrDefault(id) {
  return isEngineId(id) ? ENGINES[String(id)] : ENGINES[DEFAULT_ENGINE_ID];
}

/** Resolve an engine id and throw on an unknown one — for user-facing input. */
export function engineFor(id) {
  const key = String(id ?? DEFAULT_ENGINE_ID);
  if (!isEngineId(key)) {
    throw new Error(`Unknown engine "${key}". Supported: ${ENGINE_IDS.join(', ')}.`);
  }
  return ENGINES[key];
}
