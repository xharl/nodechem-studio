/**
 * The one place a project becomes a queue of runnable tasks.
 *
 * Both the renderer's "Run workflow" button and the headless CLI call
 * `buildWorkflowTasks`, so the input text, the gates and the checkpoint
 * hand-off cannot drift between the two paths. Every helper takes the project
 * explicitly; nothing here reads the DOM or a renderer global.
 */

import { DEMO_WATER } from './gaussianInput.js';
import { engineOrDefault } from './engines/index.js';
import { runSettingsFor } from './engineSettings.js';
import { checkTsForceConstants, freqGeometryWarnings, optConvergenceWarnings } from './tsForceConstants.js';
import { CHECK_STATUS, VALIDITY_CHECKS, runValidityChecks } from './validityChecks.js';

export const safeBase = (value) => String(value).replace(/[^A-Za-z0-9._-]/g, '_');

export function nodeById(project, id) {
  const nodes = Array.isArray(project?.nodes) ? project.nodes : [];
  return nodes.find((node) => node.id === id) || null;
}

export function settingsForNode(project, node) {
  const engine = engineOrDefault(project?.defaults?.engine);
  return runSettingsFor(engine.id, { ...node.settings });
}

export function moleculeForNode(project, node) {
  const settings = node?.settings && typeof node.settings === 'object' ? node.settings : {};
  const molecule = project?.molecule || {};
  const charge = Number.isInteger(settings.charge) ? settings.charge : molecule.charge;
  const multiplicity = Number.isInteger(settings.multiplicity) ? settings.multiplicity : molecule.multiplicity;
  const coords = Array.isArray(molecule.coords) && molecule.coords.length > 0 ? molecule.coords : DEMO_WATER;
  return { charge, multiplicity, coords };
}

export function gatesForNode(node) {
  const settings = node.settings || {};
  const job = String(settings.jobType || '');
  const frequency = job.includes('Freq');
  const gates = settings.gates || {};
  const expectedImaginary = frequency
    ? (Number.isInteger(gates.imaginary) ? gates.imaginary : (job === 'Opt=TS' ? 1 : 0))
    : null;
  return {
    expectedImaginary,
    minMagnitude: gates.minMagnitude ?? 50,
    requireOptimization: job.startsWith('Opt'),
    requireFrequency: frequency,
    requireThermochemistry: Boolean(gates.thermo),
    requireFinalEnergy: Boolean(gates.finalEnergy),
  };
}

export function checkpointSourceNode(project, node) {
  const edges = Array.isArray(project?.edges) ? project.edges : [];
  const edge = edges.find((item) => item.to === node.id && item.type === 'checkpoint');
  return edge ? nodeById(project, edge.from) : null;
}

export function validityUpstreamFor(project, node) {
  const source = checkpointSourceNode(project, node);
  if (!source) return null;
  return {
    id: source.id,
    title: source.title,
    state: source.state,
    output: source.output ? source.output.file || source.output : null,
    settings: {
      jobType: source.settings?.jobType,
      method: source.settings?.method,
      basis: source.settings?.basis,
      dispersion: source.settings?.dispersion,
    },
    parsed: null,
  };
}

export function checkpointNameFor(project, node) {
  const engine = engineOrDefault(project?.defaults?.engine);
  return engine.checkpointArtifact({
    checkpointName: node?.settings?.checkpoint || '',
    nodeId: safeBase(node?.id || 'task'),
  });
}

export function checkpointSourceFor(project, node) {
  const source = checkpointSourceNode(project, node);
  if (!source) return null;
  return { nodeId: source.id, checkpoint: checkpointNameFor(project, source) };
}

export function oldCheckpointFor(project, node) {
  const source = checkpointSourceNode(project, node);
  return source ? checkpointNameFor(project, source) : '';
}

export function tsForceConstantIssues(project, node) {
  if (node?.type !== 'calc') return { errors: [], warnings: [] };
  return checkTsForceConstants({ settings: node.settings, upstream: checkpointSourceNode(project, node) });
}

/** Issue #16 findings for a node's optimisation convergence and integration grid. */
export function optConvergenceIssues(project, node) {
  if (node?.type !== 'calc') return [];
  return [
    ...optConvergenceWarnings(node.settings),
    ...freqGeometryWarnings({ settings: node.settings, upstream: checkpointSourceNode(project, node) }),
  ];
}

export function blockingValidityFinding(project, node, settings, molecule) {
  const engine = engineOrDefault(project?.defaults?.engine);
  const result = runValidityChecks({
    settings,
    molecule,
    parsed: null,
    upstream: validityUpstreamFor(project, node),
  }, { phase: 'pre', engine: engine.id });
  const blocking = new Set(VALIDITY_CHECKS.filter((check) => check.blocking).map((check) => check.id));
  return result.findings.find((finding) => finding.status === CHECK_STATUS.FAIL && blocking.has(finding.id)) || null;
}

export function validityForNode(project, node) {
  const molecule = moleculeForNode(project, node);
  return {
    settings: {
      jobType: node.settings.jobType,
      method: node.settings.method,
      basis: node.settings.basis,
      dispersion: node.settings.dispersion,
      disabledChecks: Array.isArray(node.settings.disabledChecks) ? node.settings.disabledChecks : [],
    },
    molecule,
    upstream: validityUpstreamFor(project, node),
  };
}

/** The engine's input for one calculation node, exactly as it will be written. */
export function buildRunInput(project, node) {
  const engine = engineOrDefault(project?.defaults?.engine);
  // A ReadFC TS block without a usable checkpoint hand-off has nothing to read.
  const issues = engine.id === 'xtb' ? { errors: [] } : tsForceConstantIssues(project, node);
  if (issues.errors.length > 0) throw new Error(issues.errors[0]);
  const settings = settingsForNode(project, node);
  const molecule = moleculeForNode(project, node);
  const blocking = blockingValidityFinding(project, node, settings, molecule);
  if (blocking) throw new Error(blocking.message);
  const base = safeBase(node.id);
  if (engine.id === 'xtb') {
    return engine.buildInput({ title: node.title, settings, molecule, inputName: `${base}.xyz` });
  }
  return engine.buildInput({
    title: node.title,
    settings,
    molecule,
    inputName: `${base}.gjf`,
    oldCheckpoint: oldCheckpointFor(project, node),
  });
}

/**
 * The queue payload: one task per node, with every calculation already built.
 * Throws when the workflow has nothing to run, which is what the UI shows as
 * "no calculation blocks".
 */
export function buildWorkflowTasks(project) {
  const nodes = Array.isArray(project?.nodes) ? project.nodes : [];
  const tasks = nodes.map((node) => {
    if (node.type !== 'calc') {
      return {
        nodeId: node.id,
        type: node.type,
        title: node.title,
        kind: node.kind || node.type,
        executable: false,
        condition: node.type === 'condition'
          ? { expression: node.condition?.expression || '', unknown: node.condition?.unknown || 'block-both' }
          : null,
        loop: node.type === 'loop'
          ? { maxAttempts: node.loop?.maxAttempts || 3, mode: node.loop?.mode || 'retry', target: node.loop?.target || '' }
          : null,
        merge: node.type === 'merge' ? { policy: node.merge?.policy || 'all' } : null,
      };
    }
    const built = buildRunInput(project, node);
    return {
      nodeId: node.id,
      type: 'calc',
      title: node.title,
      kind: node.kind || 'Calc',
      executable: true,
      engine: built.engine,
      argv: built.argv,
      route: built.route,
      inputName: built.inputName,
      outputName: built.outputName,
      inputText: built.inputText,
      settings: settingsForNode(project, node),
      gates: gatesForNode(node),
      validity: validityForNode(project, node),
      checkpointName: checkpointNameFor(project, node),
      checkpointFrom: checkpointSourceFor(project, node),
    };
  });
  if (!tasks.some((task) => task.executable)) throw new Error('The workflow has no calculation blocks to run.');
  return tasks;
}
