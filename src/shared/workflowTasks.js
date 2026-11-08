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
import { LIMITS } from './projectSchema.js';
import {
  activeFlow,
  datasetById,
  edgesOfFlow,
  recordsForInput,
  flowById,
  nodesOfFlow,
  scopeFor,
  taskIdFor,
} from './flows.js';

export const safeBase = (value) => String(value).replace(/[^A-Za-z0-9._-]/g, '_');

/** defaultSettings() plants these; a block only overrides a record when it differs. */
const DEFAULT_CHARGE = 0;
const DEFAULT_MULTIPLICITY = 1;

/**
 * A block by id. Ids are unique per flow (schema v2), so a project-wide lookup
 * is unambiguous; the active flow is searched first because that is the graph
 * the caller is looking at.
 */
export function nodeById(project, id) {
  const wanted = String(id || '');
  const local = nodesOfFlow(activeFlow(project)).find((node) => node.id === wanted);
  if (local) return local;
  for (const flow of Array.isArray(project?.flows) ? project.flows : []) {
    const found = nodesOfFlow(flow).find((node) => node.id === wanted);
    if (found) return found;
  }
  const legacy = Array.isArray(project?.nodes) ? project.nodes : [];
  return legacy.find((node) => node.id === wanted) || null;
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

export function moleculeForNode(project, node, conformerMember = null, record = null, { ignoreConformer = false } = {}) {
  const settings = node?.settings && typeof node.settings === 'object' ? node.settings : {};
  const molecule = project?.molecule || {};
  // RFC 0001: a record carries its own charge and multiplicity. A block's
  // fields stay overrides, but only when they differ from the schema default —
  // every block gets charge 0 / multiplicity 1 from defaultSettings(), so
  // treating the default as "explicit" would silently ignore the dataset.
  const chargeOverride = Number.isInteger(settings.charge) && settings.charge !== DEFAULT_CHARGE
    ? settings.charge : null;
  const multiplicityOverride = Number.isInteger(settings.multiplicity) && settings.multiplicity !== DEFAULT_MULTIPLICITY
    ? settings.multiplicity : null;
  const recordCharge = Number.isInteger(record?.charge) ? record.charge : null;
  const recordMultiplicity = Number.isInteger(record?.multiplicity) ? record.multiplicity : null;
  const charge = chargeOverride ?? recordCharge ?? (Number.isInteger(settings.charge) ? settings.charge : molecule.charge);
  const multiplicity = multiplicityOverride ?? recordMultiplicity
    ?? (Number.isInteger(settings.multiplicity) ? settings.multiplicity : molecule.multiplicity);
  // Issue #30: a calculation downstream of a conformer block runs on the
  // conformer that was *chosen*, not on the project's single imported geometry.
  // Issue #80: a fanned-out block names the member per task instead.
  // RFC 0001: a dataset record supplies the geometry for its own run.
  // Issue #87: a task that reads a checkpoint takes its geometry from that
  // checkpoint, so it must not also receive a member's pre-optimisation atoms.
  const conformer = ignoreConformer ? null : conformerForNode(project, node, conformerMember);
  const chosen = conformer?.atoms;
  const recordCoords = Array.isArray(record?.coords) && record.coords.length > 0 ? record.coords : null;
  const coords = Array.isArray(chosen) && chosen.length > 0
    ? chosen
    : (recordCoords || (Array.isArray(molecule.coords) && molecule.coords.length > 0 ? molecule.coords : DEMO_WATER));
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
    fanOut: pick('fanOut') === true,
    // Issue #132: the study id the block carries. Passed through, never derived:
    // the app does not decide which blocks belong together.
    group: String(source.group || ''),
    // Issues #129/#130: what an imported file is, and what its energies are.
    // Passed through as declared — the queue records it, it does not guess it.
    energyUnit: pick('energyUnit') === 'kcal/mol' ? 'kcal/mol' : 'hartree',
    energyMethod: String(source.energyMethod || ''),
    origin: {
      program: String(source.origin?.program || ''),
      version: String(source.origin?.version || ''),
      method: String(source.origin?.method || ''),
    },
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
 *
 * `conformerMember` is the member a fanned-out task was planned for (#80); it
 * takes the place of the block's single selection without changing the shape
 * of what the caller sees. Since #87 a propagated member also carries the
 * ensemble it came from (`nodeId`, `title`, `generator`, `spreadKcal`), because
 * the block may be upstream through a chain rather than wired directly.
 */
export function conformerForNode(project, node, conformerMember = null) {
  const member = conformerMember && Array.isArray(conformerMember.atoms) && conformerMember.atoms.length > 0
    ? conformerMember
    : null;
  const source = member?.nodeId ? nodeById(project, member.nodeId) : conformerSourceFor(project, node);
  if (!source && !member) return null;
  const output = source?.output && typeof source.output === 'object' ? source.output : null;
  const selected = member || (output?.selected && Array.isArray(output.selected.atoms) && output.selected.atoms.length > 0
    ? output.selected
    : null);
  const spreadKcal = Number.isFinite(member?.spreadKcal)
    ? member.spreadKcal
    : (Number.isFinite(output?.spreadKcal) ? output.spreadKcal : null);
  const thresholdKcal = Number.isFinite(Number(member?.thresholdKcal))
    ? Number(member.thresholdKcal)
    : (Number.isFinite(Number(source?.settings?.spreadThresholdKcal))
      ? Number(source.settings.spreadThresholdKcal)
      : DEFAULT_CONFORMER_SETTINGS.spreadThresholdKcal);
  return {
    nodeId: source?.id || member.nodeId,
    title: member?.title || source?.title,
    generator: member?.generator || output?.generator || '',
    spreadKcal,
    thresholdKcal,
    requiresSelection: member ? false : Boolean(output?.requiresSelection),
    atoms: selected ? selected.atoms : null,
    selected: selected ? {
      id: String(selected.id || ''),
      relativeKcal: Number(selected.relativeKcal ?? 0),
      population: Number(selected.population ?? 0),
      protomer: String(selected.protomer || ''),
    } : null,
  };
}

/**
 * The conformer block a calculation is waiting on because it has not produced
 * an ensemble yet, or null.
 *
 * Issue #101: `buildRunInput` refuses any conformer-fed block without a chosen
 * member, which is right when the ensemble exists and the choice is the user's.
 * On a fresh project the ensemble itself does not exist — the search task that
 * would create it has not run — so refusing the whole plan deadlocks the
 * natural `conformers -> calc` graph. Only a *missing* ensemble is deferred
 * here; an ensemble that exists without a selection is still refused at plan
 * time, because that is a decision, not a pending computation.
 */
export function pendingConformerFor(project, node) {
  if (!node || node.type === 'conformers') return null;
  const source = conformerSourceFor(project, node);
  if (!source) return null;
  if (source.output && typeof source.output === 'object') return null;
  return { nodeId: source.id, title: source.title };
}

/** The one refusal message used at plan time and again by the queue. */
export function noSelectedConformerMessage(conformer, node) {
  return `"${conformer.title}" has no selected conformer. Run the ensemble and choose a member before running "${node.title}".`;
}

/**
 * The members a fanned-out conformer block runs, in rank order.
 *
 * Returns null when fan-out is off, when the block has not produced an
 * ensemble yet (the search itself still has to run once), or when nothing
 * survived pruning. Throws when the ensemble mixes protomers and no member was
 * chosen: fanning out would put different protonation states into one ΔE
 * table, which is the mistake the single-selection refusal exists to stop.
 */
export function fanOutMembersFor(node) {
  if (!node || node.type !== 'conformers') return null;
  const settings = conformerSettingsFor(node);
  if (!settings.fanOut) return null;
  const output = node.output && typeof node.output === 'object' ? node.output : null;
  if (!output) return null;
  const kept = (Array.isArray(output.members) ? output.members : [])
    .filter((member) => member && member.kept === true
      && /^c\d+$/.test(String(member.id || ''))
      && Array.isArray(member.atoms) && member.atoms.length > 0);
  if (kept.length === 0) return null;
  const protomers = (Array.isArray(output.protomers) ? output.protomers : [])
    .map((item) => String(item || ''))
    .filter(Boolean);
  const selectedId = String(output.selectedId || '');
  if (output.requiresSelection === true || (protomers.length > 1 && !selectedId)) {
    throw new Error(`"${node.title}" holds ${protomers.length > 1 ? protomers.length : 'several'} protomers`
      + `${protomers.length > 0 ? ` (${protomers.join(', ')})` : ''}; choose the member to fan out instead of comparing protonation states.`);
  }
  // A chosen protomer bounds the fan-out: the other protonation states are not
  // conformers of this one and must not share its ΔE table.
  const selected = kept.find((member) => member.id === selectedId) || null;
  const scope = selected && protomers.length > 1
    ? kept.filter((member) => String(member.protomer || '') === String(selected.protomer || ''))
    : kept;
  const members = [];
  const seen = new Set();
  for (const member of scope) {
    const id = String(member.id);
    if (seen.has(id)) continue;
    seen.add(id);
    members.push({
      id,
      rank: Number.isInteger(member.rank) ? member.rank : members.length + 1,
      energyEh: Number.isFinite(member.energyEh) ? member.energyEh : null,
      relativeKcal: Number.isFinite(member.relativeKcal) ? member.relativeKcal : 0,
      population: Number.isFinite(member.population) ? member.population : 0,
      protomer: String(member.protomer || ''),
      atoms: member.atoms,
    });
  }
  if (members.length === 0) return null;
  return {
    nodeId: node.id,
    title: node.title,
    generator: String(output.generator || ''),
    method: String(output.method || ''),
    spreadKcal: Number.isFinite(output.spreadKcal) ? output.spreadKcal : null,
    count: members.length,
    total: Number.isFinite(output.total) ? output.total : members.length,
    temperature: settings.temperature,
    members,
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

/**
 * The checkpoint hand-off this block reads.
 *
 * `checkpointTaskId` is the upstream *task* the downstream task pairs with when
 * a fan-out propagates (#87): `freq~c2` reads `opt~c2`'s file, so the declared
 * name must be built from that task id, never from the shared block id.
 */
export function checkpointSourceFor(project, node, checkpointTaskId = null) {
  const source = checkpointSourceNode(project, node);
  if (!source) return null;
  const taskId = checkpointTaskId || source.id;
  // Across engines there is no artifact the downstream engine can read: the
  // parsed final geometry is handed over instead, and the edge says so.
  if (engineForNode(project, source).id !== engineForNode(project, node).id) {
    return { nodeId: taskId, checkpoint: '', geometryOnly: true };
  }
  return { nodeId: taskId, checkpoint: checkpointNameFor(project, source, taskId) };
}

export function oldCheckpointFor(project, node, checkpointTaskId = null) {
  const source = checkpointSourceNode(project, node);
  if (!source) return '';
  // A source on another engine has no checkpoint this one can read; emitting
  // %OldChk would point Gaussian at a file that does not exist.
  if (engineForNode(project, source).id !== engineForNode(project, node).id) return '';
  return checkpointNameFor(project, source, checkpointTaskId || source.id);
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

export function blockingValidityFinding(project, node, settings, molecule, conformerMember = null, { ignoreConformer = false } = {}) {
  const engine = engineForNode(project, node);
  const conformer = ignoreConformer ? null : conformerForNode(project, node, conformerMember);
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

export function validityForNode(project, node, conformerMember = null, record = null, { ignoreConformer = false } = {}) {
  const molecule = moleculeForNode(project, node, conformerMember, record, { ignoreConformer });
  const conformer = ignoreConformer ? null : conformerForNode(project, node, conformerMember);
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
export function buildRunInput(project, node, {
  taskId = node?.id,
  settingsOverride = null,
  conformerMember = null,
  record = null,
  checkpointTaskId = null,
  ignoreConformer = false,
} = {}) {
  const engine = engineForNode(project, node);
  // A ReadFC TS block without a usable checkpoint hand-off has nothing to read.
  const issues = engine.id === 'xtb' ? { errors: [] } : tsForceConstantIssues(project, node);
  if (issues.errors.length > 0) throw new Error(issues.errors[0]);
  const settings = settingsOverride || settingsForNode(project, node);
  // A spin-state sweep varies the multiplicity per task, and the multiplicity
  // is printed in the molecule block; an override has to reach it.
  const baseMolecule = moleculeForNode(project, node, conformerMember, record, { ignoreConformer });
  // A sweep override is the only reason to rewrite the multiplicity here: the
  // record's own value must survive a block whose field still holds the default.
  const molecule = settingsOverride
    && Number.isInteger(Number(settings.multiplicity)) && Number(settings.multiplicity) > 0
    ? { ...baseMolecule, multiplicity: Number(settings.multiplicity) }
    : baseMolecule;
  const blocking = blockingValidityFinding(project, node, settings, molecule, conformerMember, { ignoreConformer });
  if (blocking) throw new Error(blocking.message || blocking.detail || `The ${blocking.id} check failed.`);
  // Issue #30: a block fed by a conformer ensemble may not run until a member
  // is chosen. Falling back to the project geometry would silently discard the
  // entire conformer stage, which is the error this feature exists to stop.
  const conformer = ignoreConformer ? null : conformerForNode(project, node, conformerMember);
  if (conformer && !conformer.selected) {
    throw new Error(noSelectedConformerMessage(conformer, node));
  }
  const base = safeBase(taskId);
  const built = engine.id === 'xtb'
    ? engine.buildInput({ title: node.title, settings, molecule, inputName: `${base}.xyz` })
    : engine.buildInput({
      title: node.title,
      settings,
      molecule,
      inputName: `${base}.gjf`,
      oldCheckpoint: oldCheckpointFor(project, node, checkpointTaskId),
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
 * A calculation whose conformer ensemble has not been searched yet is included
 * as a non-executable task carrying `pendingInput` (issue #101); the queue
 * fails it with that reason instead of running it on the project geometry.
 * Throws when the workflow has nothing to run, which is what the UI shows as
 * "no calculation blocks".
 */
export function buildWorkflowTasks(project) {
  return buildWorkflowPlan(project).tasks;
}

/**
 * Issue #87: the ensemble that fans a block out, or null.
 *
 * Fan membership is a property of the *plan*, not of a single edge: once a
 * conformer block fans out, every calculation that inherits its geometry or
 * checkpoint inherits the membership too. The walk is recursive over the
 * ordering edges (the graph is small and acyclic; a cycle is the queue's own
 * refusal), so node array order cannot change the answer.
 *
 * A block is fanned when:
 *   - every dependency branch feeding it is fanned over the same ensemble, or
 *   - its checkpoint source is fanned and it has no dependency inputs.
 *
 * Anything else is ambiguous and refused here, before queueing: one input
 * fanned and one fixed would run once per member *and* once on a shared
 * geometry; two ensembles would make one run read members of both.
 */
function computeFanMembership(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const dependencies = new Map(nodes.map((node) => [node.id, []]));
  const checkpoints = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    if (edge.type === 'dependency') dependencies.get(edge.to).push(edge.from);
    else if (edge.type === 'checkpoint') checkpoints.get(edge.to).push(edge.from);
  }

  const fans = new Map();
  const visiting = new Set();

  function fanFor(node) {
    // Input blocks declare a scope and notes carry no data; neither is a
    // geometry branch, so neither can make a legitimate fan ambiguous.
    const branches = dependencies.get(node.id)
      .map((id) => byId.get(id))
      .filter((source) => source && source.type !== 'input' && source.type !== 'note');
    const fannedDeps = [];
    const unfannedDeps = [];
    for (const source of branches) {
      const fan = resolve(source.id);
      if (fan) fannedDeps.push({ source, fan });
      else unfannedDeps.push(source);
    }
    const checkpointSources = checkpoints.get(node.id)
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((source) => ({ source, fan: resolve(source.id) }));
    const fannedCheckpoints = checkpointSources.filter((entry) => entry.fan);

    const ensembles = new Map();
    for (const entry of [...fannedDeps, ...fannedCheckpoints]) ensembles.set(entry.fan.nodeId, entry.fan);
    if (ensembles.size > 1) {
      const titles = [...ensembles.values()].map((fan) => `"${fan.title || fan.nodeId}"`);
      throw new Error(`"${node.title}" would be fanned out over two conformer ensembles (${titles.join(' and ')}).`
        + ' One run cannot use members of two ensembles; give each ensemble its own branch, or turn fan-out off on one of them.');
    }

    if (fannedDeps.length > 0) {
      if (unfannedDeps.length > 0) {
        const other = unfannedDeps[0];
        throw new Error(`"${node.title}" has a fanned-out branch from "${fannedDeps[0].fan.title || fannedDeps[0].fan.nodeId}"`
          + ` and a branch from "${other.title || other.id}" that is not fanned.`
          + ' A block cannot run once per member and once on a single geometry; wire the other branch to the same conformer ensemble,'
          + ' or collect the fanned branch with a merge block.');
      }
      // A shared checkpoint may legitimately seed every member's run (an
      // initial guess, say), so an unfanned checkpoint on an already-fanned
      // block is not a mixing error.
      return fannedDeps[0].fan;
    }

    if (fannedCheckpoints.length > 0) {
      if (branches.length > 0) {
        const other = branches[0];
        throw new Error(`"${node.title}" reads a checkpoint fanned out over "${fannedCheckpoints[0].fan.title || fannedCheckpoints[0].fan.nodeId}"`
          + ` but also depends on "${other.title || other.id}", which is not fanned.`
          + ' A block cannot run once per member and once on a single geometry; wire the other branch to the same conformer ensemble,'
          + ' or collect the fanned branch with a merge block.');
      }
      return fannedCheckpoints[0].fan;
    }
    return null;
  }

  function resolve(nodeId) {
    if (fans.has(nodeId)) return fans.get(nodeId);
    if (visiting.has(nodeId)) return null; // a cycle is reported when the queue starts
    const node = byId.get(nodeId);
    if (!node) return null;
    visiting.add(nodeId);
    let fan = null;
    try {
      if (node.type === 'conformers') {
        fan = conformerSettingsFor(node).fanOut ? fanOutMembersFor(node) : null;
      } else if (node.type === 'calc') {
        fan = fanFor(node);
      }
    } finally {
      visiting.delete(nodeId);
    }
    fans.set(nodeId, fan);
    return fan;
  }

  for (const node of nodes) resolve(node.id);
  return fans;
}

/**
 * The task-level conformer context for one fanned-out member (#87).
 *
 * `fanOutMembersFor` returns the ranking row; a propagated task also needs the
 * ensemble it came from so `buildRunInput` can record provenance without a
 * direct edge back to the conformer block.
 */
function fanMemberContext(project, fan, member) {
  const source = nodeById(project, fan.nodeId);
  const settings = source ? conformerSettingsFor(source) : DEFAULT_CONFORMER_SETTINGS;
  const thresholdKcal = Number.isFinite(Number(settings.spreadThresholdKcal))
    ? Number(settings.spreadThresholdKcal)
    : DEFAULT_CONFORMER_SETTINGS.spreadThresholdKcal;
  return {
    ...member,
    nodeId: fan.nodeId,
    title: fan.title,
    generator: fan.generator,
    method: fan.method,
    spreadKcal: fan.spreadKcal,
    thresholdKcal,
  };
}

/**
 * The task list plus the edges that connect it.
 *
 * A calculation block may carry a method ladder: it then becomes one task per
 * rung (`<nodeId>~1`, `~2`, …) and the block itself is no longer a task.
 * Dependencies expand to every rung; a checkpoint hand-off leaves only the
 * primary rung (the first one), because a downstream block reads one file and
 * picking a rung silently is exactly what a ladder must not do.
 *
 * A conformer block with `fanOut` on (#80) expands the other way: its stored
 * ensemble's kept members each become one task (`<nodeId>~<memberId>`), and a
 * calculation fed by that block becomes one task per member too. Edges between
 * two blocks fanned out over the same ensemble pair member to member, so a
 * member's branch never waits on a different member; an edge into a block that
 * is not fanned (a merge, say) keeps every member as an input.
 *
 * A calculation fed by a conformer block that has not produced an ensemble yet
 * (#101) is planned as a non-executable task with `pendingInput`, so the search
 * task that creates the ensemble is still queued. An ensemble that exists but
 * has no chosen member is still refused here, exactly as before: that is a
 * user decision, not a pending computation.
 */
export function buildWorkflowPlan(project, { flowId = null } = {}) {
  const flow = flowId ? flowById(project, flowId) : activeFlow(project);
  const flowKey = flow?.id || 'main';
  const nodes = nodesOfFlow(flow).length > 0 || flow?.nodes
    ? nodesOfFlow(flow)
    : (Array.isArray(project?.nodes) ? project.nodes : []);
  const projectEdges = edgesOfFlow(flow).length > 0 || flow?.edges
    ? edgesOfFlow(flow)
    : (Array.isArray(project?.edges) ? project.edges : []);

  // RFC 0001: a block downstream of an input block runs once per record of that
  // block's dataset; anything else runs once, exactly as every v1 project did.
  const scopes = new Map();
  for (const node of nodes) {
    scopes.set(node.id, scopeFor(project, nodes, projectEdges, node));
  }

  // Issue #87: fan membership is decided once, for the whole branch, before
  // any task is created. Every downstream block inherits the ensemble the walk
  // found; the task loop only reads the answer.
  const fanForNode = computeFanMembership(nodes, projectEdges);

  const tasks = [];
  const idsFor = new Map();
  // Task id -> the fan-out it belongs to, and the record it was planned for.
  const fanOf = new Map();
  const recordOf = new Map();
  const registerFan = (taskId, conformerId, memberId) => fanOf.set(taskId, { conformerId, memberId });
  const pushTask = (task, recordId = null) => {
    task.flowId = flowKey;
    if (recordId) task.recordId = recordId;
    tasks.push(task);
    recordOf.set(task.nodeId, recordId || null);
  };

  for (const node of nodes) {
    const scope = scopes.get(node.id) || null;
    const records = scope ? scope.records : [null];

    if (node.type === 'input') {
      // An input block is the *source* of a scope, so `scopeFor` finds nothing
      // upstream of it; its records come straight from the dataset it names.
      const bound = datasetById(project, node.input?.datasetId);
      tasks.push({
        nodeId: node.id,
        type: 'input',
        title: node.title,
        kind: node.kind || 'Input',
        executable: false,
        flowId: flowKey,
        input: {
          datasetId: node.input?.datasetId || '',
          datasetTitle: bound?.title || '',
          records: recordsForInput(node, bound).map((record) => ({ id: record.id, label: record.label || record.id })),
        },
      });
      idsFor.set(node.id, [node.id]);
      continue;
    }

    if (node.type === 'conformers') {
      const fanOut = fanForNode.get(node.id) || null;
      const ids = [];
      for (const record of records) {
        const recordId = record?.id || null;
        if (fanOut) {
          for (const member of fanOut.members) {
            const taskId = taskIdFor(node.id, recordId, member.id);
            pushTask(conformerMemberTask(project, node, { taskId, member, ensemble: fanOut, record }), recordId);
            registerFan(taskId, node.id, member.id);
            ids.push(taskId);
          }
        } else {
          const taskId = taskIdFor(node.id, recordId);
          pushTask(conformerSearchTask(project, node, record), recordId);
          ids.push(taskId);
        }
      }
      idsFor.set(node.id, ids);
      continue;
    }

    if (node.type !== 'calc') {
      // Control-flow blocks are planned once per flow: an output block collects
      // every record, a merge joins branches, a condition routes them.
      tasks.push({
        nodeId: node.id,
        type: node.type,
        title: node.title,
        kind: node.kind || node.type,
        executable: false,
        flowId: flowKey,
        condition: node.type === 'condition'
          ? { expression: node.condition?.expression || '', unknown: node.condition?.unknown || 'block-both' }
          : null,
        loop: node.type === 'loop'
          ? { maxAttempts: node.loop?.maxAttempts || 3, mode: node.loop?.mode || 'retry', target: node.loop?.target || '' }
          : null,
        merge: node.type === 'merge' ? { policy: node.merge?.policy || 'all' } : null,
        ...(node.type === 'output' ? { output: { ...node.output } } : {}),
      });
      idsFor.set(node.id, [node.id]);
      continue;
    }

    const ladder = ladderRungs(node.settings);
    const spin = spinSweepFor(node.settings);
    const fanOut = fanForNode.get(node.id) || null;
    const checkpointSource = checkpointSourceNode(project, node);
    const checkpointFan = checkpointSource ? fanForNode.get(checkpointSource.id) || null : null;
    const checkpointLadder = checkpointSource ? ladderRungs(checkpointSource.settings) : null;
    const checkpointSpin = checkpointSource ? spinSweepFor(checkpointSource.settings) : null;
    if (ladder && spin) {
      throw new Error(`Block "${node.title}" has both a method ladder and a spin-state sweep; run one at a time.`);
    }
    if (fanOut && (ladder || spin)) {
      throw new Error(`Block "${node.title}" has a method ladder${spin ? ' and a spin-state sweep' : ''} and a fanned-out conformer ensemble;`
        + ' run the levels on a separate block instead of multiplying both expansions.');
    }

    const ids = [];
    for (const record of records) {
      const recordId = record?.id || null;
      const base = taskIdFor(node.id, recordId);
      // The upstream *task* whose artifact this run reads: the member's own run
      // when the fan propagates, otherwise the record's (or primary rung's) run.
      const checkpointTaskFor = (memberId = null) => {
        if (!checkpointSource) return null;
        if (memberId && checkpointFan && fanOut && checkpointFan.nodeId === fanOut.nodeId) {
          return taskIdFor(checkpointSource.id, recordId, memberId);
        }
        const sourceTask = taskIdFor(checkpointSource.id, recordId);
        if (checkpointSpin?.multiplicities?.length) {
          return `${sourceTask}.m${checkpointSpin.multiplicities[0]}`;
        }
        return checkpointLadder ? `${sourceTask}.r1` : sourceTask;
      };
      if (fanOut) {
        // A checkpoint edge supplies the geometry: the run must not also be
        // built from the member's pre-optimisation atoms (#87).
        const readsCheckpoint = Boolean(checkpointSource);
        for (const member of fanOut.members) {
          const taskId = taskIdFor(node.id, recordId, member.id);
          pushTask(calculationTask(project, node, {
            taskId,
            record,
            conformerMember: readsCheckpoint ? null : fanMemberContext(project, fanOut, member),
            ignoreConformer: readsCheckpoint,
            checkpointTaskId: checkpointTaskFor(member.id),
            title: `${node.title} — ${member.id}${member.protomer ? ` (${member.protomer})` : ''}`
              + `${record ? ` · ${record.label || record.id}` : ''}`,
            fanOut: {
              conformerId: fanOut.nodeId,
              memberId: member.id,
              count: fanOut.members.length,
              spreadKcal: fanOut.spreadKcal,
            },
          }), recordId);
          registerFan(taskId, fanOut.nodeId, member.id);
          ids.push(taskId);
        }
        continue;
      }
      if (spin) {
        spin.multiplicities.forEach((multiplicity, index) => {
          const taskId = `${base}.m${multiplicity}`;
          pushTask(calculationTask(project, node, {
            taskId,
            record,
            settingsOverride: { ...settingsForNode(project, node), multiplicity, spinSweep: null },
            checkpointTaskId: checkpointTaskFor(),
            title: `${node.title} — multiplicity ${multiplicity}`,
            spin: { id: node.id, index, multiplicity, count: spin.multiplicities.length },
          }), recordId);
          ids.push(taskId);
        });
        continue;
      }
      if (!ladder) {
        pushTask(calculationTask(project, node, {
          taskId: base,
          record,
          checkpointTaskId: checkpointTaskFor(),
        }), recordId);
        ids.push(base);
        continue;
      }
      // Task ids must satisfy the queue's SAFE_ID rule, so the separator is a dot.
      ladder.rungs.forEach((rung, index) => {
        const taskId = `${base}.r${index + 1}`;
        const settings = {
          ...settingsForNode(project, node),
          method: rung.method || node.settings.method,
          basis: rung.basis || node.settings.basis,
          dispersion: rung.dispersion || node.settings.dispersion,
          ladder: null,
        };
        pushTask(calculationTask(project, node, {
          taskId,
          record,
          settingsOverride: settings,
          checkpointTaskId: checkpointTaskFor(),
          title: `${node.title} — ${rung.label}`,
          ladder: {
            id: node.id,
            index: rung.index,
            label: rung.label,
            count: ladder.rungs.length,
            toleranceKcal: ladder.toleranceKcal,
          },
        }), recordId);
        ids.push(taskId);
      });
    }
    idsFor.set(node.id, ids);
  }

  const edges = [];
  const recordFor = (taskId) => recordOf.get(taskId) ?? null;
  const fanFor = (taskId) => fanOf.get(taskId) || null;

  for (const edge of projectEdges) {
    const fromIds = idsFor.get(edge.from) || [];
    const toIds = idsFor.get(edge.to) || [];
    if (fromIds.length === 0 || toIds.length === 0) continue;

    if (edge.type === 'checkpoint') {
      const fromFan = fanFor(fromIds[0]);
      const toFan = fanFor(toIds[0]);
      if (fromFan && !toFan) {
        // One checkpoint x N fanned-out runs has no honest reading: either the
        // consumer is fanned out over the same ensemble and pairs by member, or
        // the workflow is ambiguous and must say so before queueing.
        throw new Error(`The checkpoint hand-off from "${nodeById(project, edge.from)?.title || edge.from}" is fanned out over`
          + ` ${fromIds.length} members, but "${nodeById(project, edge.to)?.title || edge.to}" would read one checkpoint.`
          + ' Give the consumer its own dependency on the conformer block, or join the branches with a merge first.');
      }
      for (const to of toIds) {
        const toFanEntry = fanFor(to);
        const toRecord = recordFor(to);
        const from = toFanEntry
          ? fromIds.find((id) => fanFor(id)?.memberId === toFanEntry.memberId && recordFor(id) === toRecord)
          : fromIds.find((id) => recordFor(id) === toRecord);
        if (from) edges.push({ ...edge, from, to });
        else if (fromIds.length === 1 && !fromFan && !toFanEntry) edges.push({ ...edge, from: fromIds[0], to });
      }
      continue;
    }

    // A barrier waits for every record of its source, so it expands to the full
    // cross product; a dependency is a same-record hand-off. An unscoped block
    // broadcasts (single source) or collects (single consumer).
    const barrier = edge.type === 'barrier';
    for (const from of fromIds) {
      for (const to of toIds) {
        if (!barrier) {
          const a = recordFor(from);
          const b = recordFor(to);
          if (a && b && a !== b) continue;
        }
        const fa = fanFor(from);
        const fb = fanFor(to);
        // Same ensemble on both ends: member c1 feeds member c1, never c2.
        if (!barrier && fa && fb && fa.conformerId === fb.conformerId && fa.memberId !== fb.memberId) continue;
        edges.push({ ...edge, from, to });
      }
    }
  }

  // Issue #80 follow-up: a fanned-out branch may not feed a *single* run of an
  // executable block. In `conformers -> opt -> freq` the frequency block would
  // otherwise wait for every member's optimisation and then run once on the
  // project geometry, silently discarding the ensemble — the exact mistake
  // fan-out exists to prevent. Control-flow nodes (merge, output) are the
  // documented exception: collecting the members is what they are for.
  const fanInputs = new Map();
  for (const edge of edges) {
    const fan = fanFor(edge.from);
    if (!fan || edge.type === 'checkpoint' || edge.type === 'barrier') continue;
    const entry = fanInputs.get(edge.to) || { conformerIds: new Set(), count: 0 };
    entry.conformerIds.add(fan.conformerId);
    entry.count += 1;
    fanInputs.set(edge.to, entry);
  }
  for (const [taskId, entry] of fanInputs) {
    if (fanFor(taskId) || entry.count < 2) continue;
    const node = nodeById(project, taskId.split('~')[0]);
    if (!node || (node.type !== 'calc' && node.type !== 'conformers')) continue;
    const ensemble = nodeById(project, [...entry.conformerIds][0]);
    throw new Error(`"${node.title}" would run once but ${entry.count} fanned-out branches feed it,`
      + ` so it could only use one member of "${ensemble?.title || 'the ensemble'}".`
      + ' Wire it to the conformer block directly so it runs once per member,'
      + ' or collect the branches with a merge block if one run is what you want.');
  }

  // A downstream task reads the checkpoint of the *primary* rung; record that
  // explicitly so the run record cannot imply it consumed the whole ladder.
  // A fanned-out task reads the checkpoint of *its own member* instead, and the
  // name has to be rebuilt because the member's task id is what the upstream
  // run actually wrote. RFC 0001 adds the record dimension to the same pairing.
  for (const task of tasks) {
    if (!task.checkpointFrom) continue;
    // A fanned-out task already names its paired *task* here (#87); the block
    // a checkpoint edge starts from is still the edge's source, not a segment
    // of the task id.
    const blockId = String(task.nodeId).split('~')[0];
    const block = nodeById(project, blockId);
    const checkpointBlock = block ? checkpointSourceNode(project, block) : null;
    const sourceBlockId = checkpointBlock?.id || task.checkpointFrom.nodeId;
    const sourceIds = idsFor.get(sourceBlockId) || [];
    if (sourceIds.length === 0) continue;
    const targetFan = fanFor(task.nodeId) || null;
    const sourceFan = fanFor(sourceIds[0]) || null;
    const targetRecord = recordFor(task.nodeId);
    if (sourceFan && !targetFan) {
      throw new Error(`"${task.title}" builds one run but its checkpoint source is fanned out over ${sourceIds.length} members.`
        + ' Give the consumer its own dependency on the conformer block, or join the branches with a merge first.');
    }
    if (targetFan && sourceFan) {
      if (sourceFan.conformerId !== targetFan.conformerId) {
        throw new Error(`"${task.title}" is fanned out over one conformer ensemble but reads a checkpoint fanned out over another.`
          + ' Connect both blocks to the same conformer block.');
      }
      const paired = sourceIds.find((id) => fanFor(id)?.memberId === targetFan.memberId
        && recordFor(id) === targetRecord);
      if (!paired) {
        throw new Error(`"${task.title}" has a member ${targetFan.memberId} with no matching checkpoint source task.`);
      }
      const sourceNode = nodeById(project, sourceBlockId);
      task.checkpointFrom = {
        ...task.checkpointFrom,
        nodeId: paired,
        ...(task.checkpointFrom.geometryOnly ? {} : {
          checkpoint: checkpointNameFor(project, sourceNode, paired),
        }),
        fanOutMember: targetFan.memberId,
        ...(targetRecord ? { recordId: targetRecord } : {}),
      };
      continue;
    }
    const sameRecord = sourceIds.find((id) => recordFor(id) === targetRecord) || sourceIds[0];
    if (sameRecord !== sourceBlockId) {
      task.checkpointFrom = { ...task.checkpointFrom, nodeId: sameRecord, ladderPrimary: true };
    }
  }

  if (!tasks.some((task) => task.executable)) throw new Error('The workflow has no calculation blocks to run.');

  // RFC 0001: a family of molecules multiplies every block, so the plan has a
  // ceiling and names the product that hit it. Issue #87 adds the fan-out
  // factor: a chain under a two-member ensemble is two runs per block.
  if (tasks.length > LIMITS.planTasks) {
    const recordCount = new Set(tasks.map((task) => task.recordId).filter(Boolean)).size;
    const memberCount = tasks.reduce((most, task) => (
      Number.isInteger(task.fanOut?.count) ? Math.max(most, task.fanOut.count) : most
    ), 0);
    const factors = [];
    if (recordCount) factors.push(`${recordCount} records`);
    if (memberCount > 1) factors.push(`${memberCount} conformer members`);
    throw new Error(`This workflow expands to ${tasks.length} tasks`
      + `${factors.length ? ` (${factors.join(' × ')} × the blocks they feed)` : ''}; the limit is ${LIMITS.planTasks}.`
      + (memberCount > 1
        ? ' Disable some records, turn fan-out off, or split the family across flows.'
        : ' Disable some records, or split the family across flows.'));
  }

  return { tasks, edges, flowId: flowKey };
}

function calculationTask(project, node, {
  taskId,
  settingsOverride = null,
  title = null,
  ladder = null,
  spin = null,
  conformerMember = null,
  fanOut = null,
  record = null,
  checkpointTaskId = null,
  ignoreConformer = false,
}) {
  // Issue #101: the ensemble has not been searched yet, so there is no member
  // to build from. Emit a task that marks the block pending instead of throwing
  // away the whole plan (which also discarded the search task that creates the
  // ensemble). The queue fails it with the same reason if the ensemble is still
  // missing when it gets there; it never falls back to the project geometry.
  const pending = pendingConformerFor(project, node);
  if (pending && !conformerMember) {
    return pendingCalculationTask(project, node, {
      taskId, title, settingsOverride, ladder, spin, pending, checkpointTaskId,
    });
  }
  const built = buildRunInput(project, node, { taskId, settingsOverride, conformerMember, record, checkpointTaskId, ignoreConformer });
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
    validity: validityForNode(project, node, conformerMember, record, { ignoreConformer }),
    checkpointName: checkpointNameFor(project, node, taskId),
    checkpointFrom: checkpointSourceFor(project, node, checkpointTaskId),
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
          transitionStateNodeId: checkpointSourceFor(project, node, checkpointTaskId)?.nodeId || null,
          reactantNodeId: (settingsOverride || settingsForNode(project, node)).referenceNodeId || null,
        },
      }
      : {}),
    ...(ladder ? { ladder } : {}),
    ...(spin ? { spin } : {}),
    ...(fanOut ? { fanOut } : {}),
    ...(emissionFor ? { emission: emissionFor } : {}),
    ...(built.conformer ? { conformer: built.conformer } : {}),
    ...(record ? { record: { id: record.id, label: record.label || record.id, charge: record.charge, multiplicity: record.multiplicity } } : {}),
  };
}

/**
 * A calculation whose input cannot be built yet because its conformer block has
 * not produced an ensemble (issue #101).
 *
 * It is deliberately not executable and carries no input text: the queue must
 * never fall back to the project geometry. `pendingInput.reason` is the same
 * refusal `buildRunInput` raises, and the queue fails the task with it when it
 * reaches the task and the ensemble is still absent. A later plan — after the
 * search stored the ensemble — turns the block into a normal runnable task.
 */
function pendingCalculationTask(project, node, { taskId, title, settingsOverride, ladder, spin, pending, checkpointTaskId = null }) {
  const engine = engineForNode(project, node);
  const base = safeBase(taskId);
  const inputName = engine.id === 'xtb' ? `${base}.xyz` : engine.id === 'orca' ? `${base}.inp` : `${base}.gjf`;
  return {
    nodeId: taskId,
    type: 'calc',
    title: title || node.title,
    kind: node.kind || 'Calc',
    executable: false,
    engine: engine.id,
    argv: null,
    route: null,
    inputName,
    outputName: inputName.replace(/\.[^.]+$/, '.out'),
    inputText: '',
    settings: settingsOverride || settingsForNode(project, node),
    gates: gatesForNode(node),
    validity: null,
    checkpointName: checkpointNameFor(project, node, taskId),
    checkpointFrom: checkpointSourceFor(project, node, checkpointTaskId),
    pendingInput: {
      reason: noSelectedConformerMessage(pending, node),
      conformerId: pending.nodeId,
      conformerTitle: pending.title,
    },
    ...(ladder ? { ladder } : {}),
    ...(spin ? { spin } : {}),
  };
}

/**
 * One retained member of a fanned-out conformer block (#80).
 *
 * The ensemble has already been searched and ranked — it is stored in the
 * project — so this task does not search again. It exists so every member has
 * its own branch, its own task id and its own folder: the queue materialises
 * the member geometry into it and a downstream calculation reads that member
 * explicitly.
 */
function conformerMemberTask(project, node, { taskId, member, ensemble, record = null }) {
  const settings = conformerSettingsFor(node);
  const chemistry = moleculeForNode(project, node, null, record);
  const charge = chemistry.charge ?? 0;
  const multiplicity = chemistry.multiplicity ?? 1;
  const inputName = `${safeBase(taskId)}.xyz`;
  return {
    nodeId: taskId,
    type: 'conformers',
    title: `${node.title} — ${member.id}${member.protomer ? ` (${member.protomer})` : ''}`,
    kind: node.kind || 'Conformers',
    executable: true,
    engine: null,
    inputName,
    outputName: 'member.xyz',
    inputText: xyzText(member.atoms, `${node.title} · member ${member.id} · fan-out · charge ${charge} · multiplicity ${multiplicity}`),
    gates: null,
    validity: null,
    checkpointFrom: null,
    fanOut: {
      conformerId: node.id,
      memberId: member.id,
      count: ensemble.members.length,
      spreadKcal: ensemble.spreadKcal,
    },
    conformers: {
      ...settings,
      charge,
      multiplicity,
      argv: [],
      member: {
        id: member.id,
        rank: member.rank,
        parentId: node.id,
        parentTitle: node.title,
        generator: ensemble.generator,
        method: ensemble.method,
        energyEh: member.energyEh ?? null,
        energyKcal: member.energyKcal ?? null,
        energyUnit: member.energyUnit || ensemble.energyUnit || 'hartree',
        energyMethod: member.energyMethod || ensemble.energyMethod || '',
        origin: ensemble.origin || null,
        relativeKcal: member.relativeKcal,
        population: member.population,
        protomer: member.protomer,
        spreadKcal: ensemble.spreadKcal,
        temperature: ensemble.temperature,
      },
    },
  };
}

/**
 * The conformer-search task.
 *
 * It is executable but has no engine: CREST is not a calculation engine in this
 * app's vocabulary (no route, no gates, no parsed output), and pretending it
 * was one would force it through a runner built for Gaussian. The queue has a
 * dedicated path for it, just as it does for conditions and merges.
 *
 * Exported because "Run selected block" on a conformer block runs exactly this
 * search, independent of whether the block is fanned out (#101).
 */
export function conformerSearchTask(project, node, record = null) {
  const settings = conformerSettingsFor(node);
  const chemistry = moleculeForNode(project, node, null, record);
  const charge = chemistry.charge ?? 0;
  const multiplicity = chemistry.multiplicity ?? 1;
  const coords = chemistry.coords;
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
    ...(record ? { record: { id: record.id, label: record.label || record.id, charge: record.charge, multiplicity: record.multiplicity } } : {}),
  };
}
