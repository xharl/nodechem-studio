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
import { ladderRungs } from './methodLadder.js';
import { spinSweepFor } from './spinSweep.js';
import { runSettingsFor } from './engineSettings.js';
import { checkTsForceConstants, freqGeometryWarnings, optConvergenceWarnings } from './tsForceConstants.js';
import { CHECK_STATUS, VALIDITY_CHECKS, runValidityChecks } from './validityChecks.js';

export const safeBase = (value) => String(value).replace(/[^A-Za-z0-9._-]/g, '_');

export function nodeById(project, id) {
  const nodes = Array.isArray(project?.nodes) ? project.nodes : [];
  return nodes.find((node) => node.id === id) || null;
}

/**
 * The engine a block runs on: its own `settings.engine` when set, otherwise the
 * project default. Empty means "inherit", so a .ncs written before per-block
 * engines existed keeps loading with the project's engine.
 */
export function engineForNode(project, node) {
  const chosen = String(node?.settings?.engine || project?.defaults?.engine || 'gaussian');
  return engineOrDefault(chosen);
}

export function settingsForNode(project, node) {
  const engine = engineForNode(project, node);
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

export function checkpointNameFor(project, node, taskId = node?.id) {
  const engine = engineForNode(project, node);
  return engine.checkpointArtifact({
    checkpointName: node?.settings?.checkpoint || '',
    nodeId: safeBase(taskId || 'task'),
  });
}

export function checkpointSourceFor(project, node) {
  const source = checkpointSourceNode(project, node);
  if (!source) return null;
  // Across engines there is no artifact the downstream engine can read: the
  // parsed final geometry is handed over instead, and the edge says so.
  if (engineForNode(project, source).id !== engineForNode(project, node).id) {
    return { nodeId: source.id, checkpoint: '', geometryOnly: true };
  }
  return { nodeId: source.id, checkpoint: checkpointNameFor(project, source) };
}

export function oldCheckpointFor(project, node) {
  const source = checkpointSourceNode(project, node);
  if (!source) return '';
  // A source on another engine has no checkpoint this one can read; emitting
  // %OldChk would point Gaussian at a file that does not exist.
  if (engineForNode(project, source).id !== engineForNode(project, node).id) return '';
  return checkpointNameFor(project, source);
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
  const engine = engineForNode(project, node);
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
export function buildRunInput(project, node, { taskId = node?.id, settingsOverride = null } = {}) {
  const engine = engineForNode(project, node);
  // A ReadFC TS block without a usable checkpoint hand-off has nothing to read.
  const issues = engine.id === 'xtb' ? { errors: [] } : tsForceConstantIssues(project, node);
  if (issues.errors.length > 0) throw new Error(issues.errors[0]);
  const settings = settingsOverride || settingsForNode(project, node);
  // A spin-state sweep varies the multiplicity per task, and the multiplicity
  // is printed in the molecule block; an override has to reach it.
  const baseMolecule = moleculeForNode(project, node);
  const molecule = Number.isInteger(Number(settings.multiplicity)) && Number(settings.multiplicity) > 0
    ? { ...baseMolecule, multiplicity: Number(settings.multiplicity) }
    : baseMolecule;
  const blocking = blockingValidityFinding(project, node, settings, molecule);
  if (blocking) throw new Error(blocking.message || blocking.detail || `The ${blocking.id} check failed.`);
  const base = safeBase(taskId);
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
  return buildWorkflowPlan(project).tasks;
}

/**
 * The task list plus the edges that connect it.
 *
 * A calculation block may carry a method ladder: it then becomes one task per
 * rung (`<nodeId>~1`, `~2`, …) and the block itself is no longer a task.
 * Dependencies expand to every rung; a checkpoint hand-off leaves only the
 * primary rung (the first one), because a downstream block reads one file and
 * picking a rung silently is exactly what a ladder must not do.
 */
export function buildWorkflowPlan(project) {
  const nodes = Array.isArray(project?.nodes) ? project.nodes : [];
  const tasks = [];
  const idsFor = new Map();

  for (const node of nodes) {
    if (node.type !== 'calc') {
      tasks.push({
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
      });
      idsFor.set(node.id, [node.id]);
      continue;
    }

    const ladder = ladderRungs(node.settings);
    const spin = spinSweepFor(node.settings);
    if (ladder && spin) {
      throw new Error(`Block "${node.title}" has both a method ladder and a spin-state sweep; run one at a time.`);
    }
    if (spin) {
      const spinIds = spin.multiplicities.map((multiplicity) => `${node.id}.m${multiplicity}`);
      spin.multiplicities.forEach((multiplicity, index) => {
        tasks.push(calculationTask(project, node, {
          taskId: spinIds[index],
          settingsOverride: { ...settingsForNode(project, node), multiplicity, spinSweep: null },
          title: `${node.title} — multiplicity ${multiplicity}`,
          spin: { id: node.id, index, multiplicity, count: spin.multiplicities.length },
        }));
      });
      idsFor.set(node.id, spinIds);
      continue;
    }
    if (!ladder) {
      tasks.push(calculationTask(project, node, { taskId: node.id }));
      idsFor.set(node.id, [node.id]);
      continue;
    }

    // Task ids must satisfy the queue's SAFE_ID rule, so the separator is a dot.
    const ids = ladder.rungs.map((rung) => `${node.id}.r${rung.index + 1}`);
    ladder.rungs.forEach((rung, index) => {
      const settings = {
        ...settingsForNode(project, node),
        method: rung.method || node.settings.method,
        basis: rung.basis || node.settings.basis,
        dispersion: rung.dispersion || node.settings.dispersion,
        ladder: null,
      };
      tasks.push(calculationTask(project, node, {
        taskId: ids[index],
        settingsOverride: settings,
        title: `${node.title} — ${rung.label}`,
        ladder: {
          id: node.id,
          index: rung.index,
          label: rung.label,
          count: ladder.rungs.length,
          toleranceKcal: ladder.toleranceKcal,
        },
      }));
    });
    idsFor.set(node.id, ids);
  }

  const edges = [];
  for (const edge of Array.isArray(project?.edges) ? project.edges : []) {
    const fromIds = idsFor.get(edge.from) || [];
    const toIds = idsFor.get(edge.to) || [];
    const sources = edge.type === 'checkpoint' ? fromIds.slice(0, 1) : fromIds;
    for (const from of sources) {
      for (const to of toIds) edges.push({ ...edge, from, to });
    }
  }

  // A downstream task reads the checkpoint of the *primary* rung; record that
  // explicitly so the run record cannot imply it consumed the whole ladder.
  for (const task of tasks) {
    if (!task.checkpointFrom) continue;
    const sourceIds = idsFor.get(task.checkpointFrom.nodeId) || [];
    if (sourceIds.length > 0 && sourceIds[0] !== task.checkpointFrom.nodeId) {
      task.checkpointFrom = { ...task.checkpointFrom, nodeId: sourceIds[0], ladderPrimary: true };
    }
  }

  if (!tasks.some((task) => task.executable)) throw new Error('The workflow has no calculation blocks to run.');
  return { tasks, edges };
}

function calculationTask(project, node, { taskId, settingsOverride = null, title = null, ladder = null, spin = null }) {
  const built = buildRunInput(project, node, { taskId, settingsOverride });
  return {
    nodeId: taskId,
    type: 'calc',
    title: title || node.title,
    kind: node.kind || 'Calc',
    executable: true,
    engine: built.engine,
    argv: built.argv,
    route: built.route,
    inputName: built.inputName,
    outputName: built.outputName,
    inputText: built.inputText,
    settings: settingsOverride || settingsForNode(project, node),
    gates: gatesForNode(node),
    validity: validityForNode(project, node),
    checkpointName: checkpointNameFor(project, node, taskId),
    checkpointFrom: checkpointSourceFor(project, node),
    // An IRC block can name the block that supplies the reactant free energy;
    // without it no ΔG‡ is computed for this path.
    ...(String((settingsOverride || settingsForNode(project, node)).jobType || '') === 'IRC'
      ? {
        reaction: {
          transitionStateNodeId: checkpointSourceFor(project, node)?.nodeId || null,
          reactantNodeId: (settingsOverride || settingsForNode(project, node)).referenceNodeId || null,
        },
      }
      : {}),
    ...(ladder ? { ladder } : {}),
    ...(spin ? { spin } : {}),
  };
}
