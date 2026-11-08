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
import { DEFAULT_CONFORMER_SETTINGS, crestArgv, xyzText } from './conformers.js';
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
  // Issue #30: a calculation downstream of a conformer block runs on the
  // conformer that was *chosen*, not on the project's single imported geometry.
  const conformer = conformerForNode(project, node);
  const chosen = conformer?.atoms;
  const coords = Array.isArray(chosen) && chosen.length > 0
    ? chosen
    : (Array.isArray(molecule.coords) && molecule.coords.length > 0 ? molecule.coords : DEMO_WATER);
  return { charge, multiplicity, coords };
}

/** Settings of a conformer block, with the documented defaults filled in. */
export function conformerSettingsFor(node) {
  const source = node?.settings && typeof node.settings === 'object' ? node.settings : {};
  const pick = (key) => (source[key] === undefined || source[key] === null ? DEFAULT_CONFORMER_SETTINGS[key] : source[key]);
  return {
    generator: String(pick('generator') || 'crest'),
    method: String(pick('method') || 'gfn2'),
    energyWindowKcal: Number(pick('energyWindowKcal')),
    rmsdThreshold: Number(pick('rmsdThreshold')),
    maxConformers: Number(pick('maxConformers')),
    temperature: Number(pick('temperature')),
    spreadThresholdKcal: Number(pick('spreadThresholdKcal')),
    selectedConformerId: String(source.selectedConformerId || ''),
    importPath: String(source.importPath || ''),
  };
}

/**
 * The conformer block a calculation reads its geometry from, when one is
 * connected by a dependency edge.
 */
export function conformerSourceFor(project, node) {
  if (!node || node.type === 'conformers') return null;
  const edges = Array.isArray(project?.edges) ? project.edges : [];
  const edge = edges.find((item) => item.to === node.id
    && item.type === 'dependency'
    && nodeById(project, item.from)?.type === 'conformers');
  return edge ? nodeById(project, edge.from) : null;
}

/**
 * The chosen conformer of the upstream block: the geometry and the numbers a
 * downstream run must cite, or null when no conformer block feeds this node.
 */
export function conformerForNode(project, node) {
  const source = conformerSourceFor(project, node);
  if (!source) return null;
  const output = source.output && typeof source.output === 'object' ? source.output : null;
  const selected = output?.selected && Array.isArray(output.selected.atoms) && output.selected.atoms.length > 0
    ? output.selected
    : null;
  return {
    nodeId: source.id,
    title: source.title,
    generator: output?.generator || '',
    spreadKcal: Number.isFinite(output?.spreadKcal) ? output.spreadKcal : null,
    thresholdKcal: Number.isFinite(Number(source.settings?.spreadThresholdKcal))
      ? Number(source.settings.spreadThresholdKcal)
      : DEFAULT_CONFORMER_SETTINGS.spreadThresholdKcal,
    requiresSelection: Boolean(output?.requiresSelection),
    atoms: selected ? selected.atoms : null,
    selected: selected ? {
      id: String(selected.id || ''),
      relativeKcal: Number(selected.relativeKcal ?? 0),
      population: Number(selected.population ?? 0),
      protomer: String(selected.protomer || ''),
    } : null,
  };
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

/**
 * Describe the emission context of a TD block, or null.
 *
 * Emission is *not* a property of the log: the same excitation table means
 * absorption at the ground-state minimum and vertical emission at the excited
 * minimum. Only the workflow knows which one it computed, so the label is
 * derived here from the block that supplied the geometry and travels with the
 * task.
 */
export function emissionContextFor(project, node, settingsOverride = null) {
  const settings = settingsOverride || node?.settings || {};
  const jobType = String(settings.jobType || '');
  const states = Number(settings.tdStates || 0);
  if (jobType === 'NMR' || jobType === 'IRC' || jobType === 'Scan') return null;
  if (!Number.isFinite(states) || states <= 0) return null;
  const source = checkpointSourceNode(project, node);
  if (!source) return null;
  const upstream = source.settings || {};
  const upstreamStates = Number(upstream.tdStates || 0);
  if (!Number.isFinite(upstreamStates) || upstreamStates <= 0) return null;
  if (!/^Opt/.test(String(upstream.jobType || ''))) return null;
  return {
    sourceNodeId: source.id,
    root: Number(upstream.tdRoot || 0) || null,
    quantity: 'vertical emission from the excited-state minimum',
  };
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
  const conformer = conformerForNode(project, node);
  const result = runValidityChecks({
    settings,
    molecule,
    parsed: null,
    upstream: validityUpstreamFor(project, node),
    conformer: conformer ? {
      nodeId: conformer.nodeId,
      title: conformer.title,
      memberId: conformer.selected?.id || '',
      relativeKcal: conformer.selected?.relativeKcal ?? null,
      population: conformer.selected?.population ?? null,
      protomer: conformer.selected?.protomer || '',
      spreadKcal: conformer.spreadKcal,
      thresholdKcal: conformer.thresholdKcal,
      requiresSelection: conformer.requiresSelection,
    } : null,
  }, { phase: 'pre', engine: engine.id });
  const blocking = new Set(VALIDITY_CHECKS.filter((check) => check.blocking).map((check) => check.id));
  return result.findings.find((finding) => finding.status === CHECK_STATUS.FAIL && blocking.has(finding.id)) || null;
}

export function validityForNode(project, node) {
  const molecule = moleculeForNode(project, node);
  const conformer = conformerForNode(project, node);
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
    conformer: conformer ? {
      nodeId: conformer.nodeId,
      title: conformer.title,
      memberId: conformer.selected?.id || '',
      relativeKcal: conformer.selected?.relativeKcal ?? null,
      population: conformer.selected?.population ?? null,
      protomer: conformer.selected?.protomer || '',
      spreadKcal: conformer.spreadKcal,
      thresholdKcal: conformer.thresholdKcal,
      requiresSelection: conformer.requiresSelection,
    } : null,
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
  // Issue #30: a block fed by a conformer ensemble may not run until a member
  // is chosen. Falling back to the project geometry would silently discard the
  // entire conformer stage, which is the error this feature exists to stop.
  const conformer = conformerForNode(project, node);
  if (conformer && !conformer.selected) {
    throw new Error(`"${conformer.title}" has no selected conformer. Run the ensemble and choose a member before running "${node.title}".`);
  }
  const base = safeBase(taskId);
  const built = engine.id === 'xtb'
    ? engine.buildInput({ title: node.title, settings, molecule, inputName: `${base}.xyz` })
    : engine.buildInput({
      title: node.title,
      settings,
      molecule,
      inputName: `${base}.gjf`,
      oldCheckpoint: oldCheckpointFor(project, node),
    });
  return {
    ...built,
    ...(conformer?.selected ? {
      conformer: {
        nodeId: conformer.nodeId,
        title: conformer.title,
        generator: conformer.generator,
        id: conformer.selected.id,
        relativeKcal: conformer.selected.relativeKcal,
        population: conformer.selected.population,
        protomer: conformer.selected.protomer,
        spreadKcal: conformer.spreadKcal,
      },
    } : {}),
  };
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
    if (node.type === 'conformers') {
      tasks.push(conformerTask(project, node));
      idsFor.set(node.id, [node.id]);
      continue;
    }
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
  const emissionFor = emissionContextFor(project, node, settingsOverride);
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
    // Emission (#75): a TD block whose geometry came from a block that relaxed
    // an excited state reports vertical emission, not a ground-state vertical
    // excitation. The label travels with the task so no result is mislabelled
    // after the fact.
    emission: emissionContextFor(project, node, settingsOverride),
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
    ...(emissionFor ? { emission: emissionFor } : {}),
    ...(built.conformer ? { conformer: built.conformer } : {}),
  };
}

/**
 * The conformer-search task.
 *
 * It is executable but has no engine: CREST is not a calculation engine in this
 * app's vocabulary (no route, no gates, no parsed output), and pretending it
 * was one would force it through a runner built for Gaussian. The queue has a
 * dedicated path for it, just as it does for conditions and merges.
 */
function conformerTask(project, node) {
  const settings = conformerSettingsFor(node);
  const molecule = project?.molecule || {};
  const charge = Number.isInteger(node?.settings?.charge) ? node.settings.charge : Number(molecule.charge ?? 0);
  const multiplicity = Number.isInteger(node?.settings?.multiplicity) ? node.settings.multiplicity : Number(molecule.multiplicity ?? 1);
  const coords = Array.isArray(molecule.coords) && molecule.coords.length > 0 ? molecule.coords : DEMO_WATER;
  const inputName = `${safeBase(node.id)}.xyz`;
  return {
    nodeId: node.id,
    type: 'conformers',
    title: node.title,
    kind: node.kind || 'Conformers',
    executable: true,
    engine: null,
    inputName,
    outputName: 'crest.out',
    inputText: xyzText(coords, `${node.title} · charge ${charge} · multiplicity ${multiplicity}`),
    gates: null,
    validity: null,
    checkpointFrom: null,
    conformers: {
      ...settings,
      charge,
      multiplicity,
      argv: settings.generator === 'crest'
        ? crestArgv({ method: settings.method, charge, multiplicity, inputName })
        : [],
    },
  };
}
