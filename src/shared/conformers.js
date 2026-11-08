/**
 * Conformer ensembles: parse what a generator wrote, rank it, prune it, and
 * say how much the answer depends on the choice.
 *
 * Issue #30: the project imports exactly one geometry, and conformer choice is
 * worth 2–10 kcal/mol — more than most functional differences. This module is
 * the offline half of the answer: it never invents a conformer, it only ranks
 * what an external generator (CREST) or an imported multi-XYZ supplied.
 *
 * Pure: no filesystem, no child process, no DOM. The runner feeds it text.
 */

import { superimpose } from './superpose.js';

/** Hartree → kcal/mol, CODATA-2018. */
export const HARTREE_KCAL = 627.5094740631;
/** Boltzmann constant in kcal/mol/K. */
export const KB_KCAL = 0.00198720425864083;

export const CONFORMER_GENERATORS = Object.freeze(['crest', 'import']);
export const CONFORMER_METHODS = Object.freeze(['gfn2', 'gfnff']);

export const DEFAULT_CONFORMER_SETTINGS = Object.freeze({
  generator: 'crest',
  method: 'gfn2',
  energyWindowKcal: 10,
  rmsdThreshold: 0.5,
  maxConformers: 20,
  temperature: 298.15,
  spreadThresholdKcal: 2,
  selectedConformerId: '',
  importPath: '',
  // Issue #80: fan the retained ensemble out into one task per member instead
  // of carrying a single chosen geometry downstream. Off by default, so a file
  // written before the switch existed runs exactly as it did.
  fanOut: false,
});

const PROTROMER_TOKEN = /(?:protomer|tautomer)\s*[=:]\s*([A-Za-z0-9_.-]+)/i;
const ENERGY_TOKEN = /(?:energy|e)\s*[=:]\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/i;

/**
 * Parse a multi-frame XYZ file — CREST's `crest_conformers.xyz` or any file a
 * user exported from another tool.
 *
 * A frame that does not parse is dropped with a reason; a file whose first
 * frame is malformed is an error, because silently returning a shorter ensemble
 * would change every downstream number.
 */
export function parseMultiXyz(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const frames = [];
  const errors = [];
  let index = 0;
  while (index < lines.length) {
    // Skip blank lines between frames; a count line is the first non-empty one.
    while (index < lines.length && lines[index].trim() === '') index += 1;
    if (index >= lines.length) break;
    const count = Number.parseInt(lines[index].trim(), 10);
    if (!Number.isInteger(count) || count <= 0) {
      errors.push({ frame: frames.length + 1, message: `Expected an atom count, found "${lines[index].trim().slice(0, 40)}".` });
      break;
    }
    const comment = lines[index + 1] ?? '';
    const atoms = [];
    let cursor = index + 2;
    for (let atom = 0; atom < count; atom += 1, cursor += 1) {
      const line = (lines[cursor] ?? '').trim();
      const parts = line.split(/\s+/);
      const element = parts[0];
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const z = Number(parts[3]);
      if (!element || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        errors.push({ frame: frames.length + 1, message: `Atom line ${atom + 1} is not "element x y z": "${line.slice(0, 60)}".` });
        return { frames, errors };
      }
      atoms.push({ element, x, y, z });
    }
    const energy = energyFromText(comment);
    const protomer = (comment.match(PROTROMER_TOKEN)?.[1] ?? '').trim();
    frames.push({ index: frames.length + 1, comment: comment.trim(), atoms, energyEh: energy, protomer });
    index = cursor;
  }
  if (frames.length === 0 && errors.length === 0) {
    errors.push({ frame: 0, message: 'The file contained no conformer frames.' });
  }
  return { frames, errors };
}

function energyFromText(text) {
  const source = String(text ?? '');
  const match = source.match(ENERGY_TOKEN);
  if (match) {
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  }
  // Many multi-XYZ writers put a bare Hartree value in the comment, sometimes
  // after a label ("conf 2 -76.418"). Take the last token, but only when it is
  // negative: a lone "3" is an index, and reading it as an energy would rank
  // conformers by their position in the file.
  const last = source.trim().split(/\s+/).pop() ?? '';
  if (!/^-\d+(\.\d+)?([eE][-+]?\d+)?$/.test(last)) return null;
  const value = Number(last);
  return Number.isFinite(value) && value < 0 ? value : null;
}

/**
 * CREST writes one energy per conformer to `crest.energies`, in the order the
 * conformers appear in `crest_conformers.xyz`. A line may be `index energy` or
 * just the energy, so the *last* number on the line is the energy — taking the
 * first would read the index and rank conformers by their position.
 */
export function parseCrestEnergies(text) {
  const values = [];
  for (const line of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const numbers = [...trimmed.matchAll(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g)].map((match) => Number(match[0]));
    const value = numbers.length > 0 ? numbers[numbers.length - 1] : NaN;
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

/**
 * Attach energies to frames. The frame comment wins when it carries one (that
 * is what an imported file usually has); otherwise the energies file supplies
 * them. A frame with neither is refused: ranking cannot invent an energy.
 */
export function withEnergies(frames, energies = []) {
  const out = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const energyEh = Number.isFinite(frame.energyEh) ? frame.energyEh : (Number.isFinite(energies[index]) ? energies[index] : null);
    if (energyEh === null) {
      return { frames: [], error: `Conformer ${index + 1} has no energy in its comment line and the energies file has no entry for it.` };
    }
    out.push({ ...frame, energyEh });
  }
  return { frames: out, error: null };
}

function rmsdBetween(a, b) {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  try {
    return superimpose(a, b).rmsd;
  } catch {
    // Elements may be in a different order across protomers; that is not a
    // conformer difference, and treating it as "distinct" is the safe answer.
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Rank and prune an ensemble.
 *
 * Pruning happens in a fixed order so the result is reproducible:
 *   1. energy window, relative to the lowest conformer;
 *   2. RMSD, greedy from the lowest-energy survivor upward;
 *   3. the retention count.
 * Every dropped member keeps its reason, so the table can show what pruning
 * removed and why — a pruned conformer is not a deleted one.
 */
export function rankEnsemble({
  frames = [],
  energyWindowKcal = DEFAULT_CONFORMER_SETTINGS.energyWindowKcal,
  rmsdThreshold = DEFAULT_CONFORMER_SETTINGS.rmsdThreshold,
  maxConformers = DEFAULT_CONFORMER_SETTINGS.maxConformers,
  temperature = DEFAULT_CONFORMER_SETTINGS.temperature,
  spreadThresholdKcal = DEFAULT_CONFORMER_SETTINGS.spreadThresholdKcal,
  selectedConformerId = '',
} = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    return { members: [], spreadKcal: null, warnings: [], selectedId: '', requiresSelection: false, error: 'The ensemble is empty.' };
  }
  const missing = frames.findIndex((frame) => !Number.isFinite(frame.energyEh));
  if (missing !== -1) {
    return { members: [], spreadKcal: null, warnings: [], selectedId: '', requiresSelection: false, error: `Conformer ${missing + 1} has no energy.` };
  }

  const sorted = frames
    .map((frame, index) => ({ ...frame, originalIndex: index }))
    .sort((a, b) => (a.energyEh - b.energyEh) || (a.originalIndex - b.originalIndex));
  const lowest = sorted[0].energyEh;

  const members = sorted.map((frame, rank) => ({
    id: `c${rank + 1}`,
    originalIndex: frame.originalIndex,
    rank: rank + 1,
    energyEh: frame.energyEh,
    relativeKcal: (frame.energyEh - lowest) * HARTREE_KCAL,
    population: 0,
    rmsdToLowest: 0,
    rmsdToPreviousKept: null,
    protomer: frame.protomer || '',
    atoms: frame.atoms,
    kept: false,
    dropped: null,
  }));

  // 1. Energy window.
  for (const member of members) {
    if (member.relativeKcal > energyWindowKcal) member.dropped = 'energy';
  }

  // 2. RMSD pruning, greedy from the lowest energy upward. Only kept members
  //    can be references; the lowest is always kept.
  const kept = [];
  for (const member of members) {
    if (member.dropped) continue;
    if (kept.length === 0) {
      kept.push(member);
      member.rmsdToLowest = 0;
      continue;
    }
    let closest = Number.POSITIVE_INFINITY;
    let reference = null;
    for (const candidate of kept) {
      const value = rmsdBetween(member.atoms, candidate.atoms);
      if (value < closest) { closest = value; reference = candidate; }
    }
    member.rmsdToLowest = rmsdBetween(member.atoms, kept[0].atoms);
    member.rmsdToPreviousKept = Number.isFinite(closest) ? { keptId: reference?.id ?? null, rmsd: closest } : null;
    if (Number.isFinite(closest) && closest < rmsdThreshold) {
      member.dropped = 'rmsd';
    } else {
      kept.push(member);
    }
  }

  // 3. Retention count.
  for (const member of kept.slice(maxConformers)) member.dropped = 'count';
  const retained = kept.slice(0, maxConformers);
  for (const member of retained) member.kept = true;

  // Boltzmann populations over the retained set, at the requested temperature.
  const t = Math.max(Number(temperature) || 0, 1);
  const partition = retained.reduce((sum, member) => sum + Math.exp(-member.relativeKcal / (KB_KCAL * t)), 0);
  for (const member of retained) {
    member.population = partition > 0 ? Math.exp(-member.relativeKcal / (KB_KCAL * t)) / partition : 0;
  }

  const spreadKcal = retained.length > 0
    ? retained[retained.length - 1].relativeKcal - retained[0].relativeKcal
    : null;

  const warnings = [];
  if (spreadKcal !== null && spreadKcal > spreadThresholdKcal) {
    warnings.push({
      id: 'conformer-spread',
      status: 'warn',
      message: `The retained conformers span ${spreadKcal.toFixed(2)} kcal/mol, above the ${Number(spreadThresholdKcal).toFixed(2)} kcal/mol threshold: the choice of conformer changes the answer.`,
      spreadKcal,
      thresholdKcal: Number(spreadThresholdKcal),
    });
  }

  const protomers = [...new Set(retained.map((member) => member.protomer).filter(Boolean))];
  const explicit = retained.find((member) => member.id === selectedConformerId) || null;
  const requiresSelection = !explicit && protomers.length > 1;
  if (requiresSelection) {
    warnings.push({
      id: 'conformer-protomer',
      status: 'warn',
      message: `The ensemble holds ${protomers.length} protomers (${protomers.join(', ')}); pick the one to carry forward rather than letting energy choose a protonation state silently.`,
      protomers,
    });
  }
  const selectedId = explicit ? explicit.id : (requiresSelection ? '' : (retained[0]?.id ?? ''));

  return {
    // Kept members keep their geometry: the summary is what the project stores,
    // and choosing a member must not depend on the queue folder still existing.
    // Pruned members never become an input, so their atoms are dropped here.
    members: members.map(({ atoms, ...rest }) => (rest.kept ? { ...rest, atoms } : rest)),
    retained,
    spreadKcal,
    warnings,
    selectedId,
    autoSelected: !explicit && !requiresSelection,
    requiresSelection,
    protomers,
    pruned: {
      energy: members.filter((member) => member.dropped === 'energy').length,
      rmsd: members.filter((member) => member.dropped === 'rmsd').length,
      count: members.filter((member) => member.dropped === 'count').length,
    },
    error: null,
  };
}

/**
 * The ensemble summary that travels with a run and is stored in the project.
 * Atoms are kept only for the selected member: one geometry, the one a
 * downstream block will actually use.
 */
export function ensembleSummary(result, { generator = '', method = '' } = {}) {
  const selected = result.retained?.find((member) => member.id === result.selectedId) || null;
  return {
    generator: String(generator || ''),
    method: String(method || ''),
    count: result.retained?.length ?? 0,
    total: result.members?.length ?? 0,
    spreadKcal: result.spreadKcal ?? null,
    pruned: result.pruned || { energy: 0, rmsd: 0, count: 0 },
    warnings: (result.warnings || []).map(({ id, status, message }) => ({ id, status, message })),
    requiresSelection: Boolean(result.requiresSelection),
    protomers: result.protomers || [],
    selectedId: result.selectedId || '',
    autoSelected: Boolean(result.autoSelected),
    selected: selected ? {
      id: selected.id,
      energyEh: selected.energyEh,
      relativeKcal: selected.relativeKcal,
      population: selected.population,
      protomer: selected.protomer || '',
      atoms: selected.atoms,
    } : null,
    members: (result.members || []).map((member) => ({
      id: member.id,
      rank: member.rank,
      energyEh: member.energyEh,
      relativeKcal: member.relativeKcal,
      population: member.population,
      rmsdToLowest: member.rmsdToLowest,
      protomer: member.protomer,
      kept: member.kept,
      dropped: member.dropped,
      // Kept members carry their geometry so choosing one is an offline
      // decision: the project stays self-contained after the queue folder moves.
      ...(member.kept && Array.isArray(member.atoms) ? { atoms: member.atoms } : {}),
    })),
  };
}

/** Format a relative energy the way the table shows it. */
export function formatRelativeKcal(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(2)}`;
}

/** Format a Boltzmann population as a percentage. */
export function formatPopulation(value) {
  if (!Number.isFinite(value)) return '—';
  const percent = value * 100;
  return percent >= 10 ? `${percent.toFixed(0)}%` : `${percent.toFixed(1)}%`;
}

/** The XYZ text a generator is given: the project geometry, one frame. */
export function xyzText(atoms, comment = '') {
  const lines = [String(atoms.length), String(comment || 'NodeChem Studio conformer search')];
  for (const atom of atoms) {
    lines.push(`${atom.element} ${Number(atom.x).toFixed(6)} ${Number(atom.y).toFixed(6)} ${Number(atom.z).toFixed(6)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * CREST arguments for one search. `--nci` enables the non-covalent interaction
 * terms that make conformer search meaningful; `--uhf` is 2S, not the
 * multiplicity, which is the classic off-by-one in CREST invocations.
 */
export function crestArgv({ method = 'gfn2', charge = 0, multiplicity = 1, inputName = 'input.xyz' } = {}) {
  const argv = [inputName];
  argv.push(method === 'gfnff' ? '--gfnff' : '--gfn2');
  argv.push('--nci');
  if (Number(charge) !== 0) argv.push('--chrg', String(Number(charge)));
  const uhf = Math.max(0, Number(multiplicity) - 1);
  if (uhf !== 0) argv.push('--uhf', String(uhf));
  return argv;
}

/**
 * A labelled dry-run ensemble.
 *
 * It is *not* a conformer search: three copies of the input geometry with
 * different synthetic energies, and a comment that says so on every frame. It
 * exists so the UI, ranking, and provenance paths can be exercised without
 * CREST — the same promise the Gaussian and xTB fixtures keep.
 */
export function fixtureConformerFrames(atoms) {
  const frames = [0, 1, 2].map((index) => ({
    index: index + 1,
    comment: `FIXTURE ensemble — dry run, not a conformer search (member ${index + 1})`,
    atoms: atoms.map((atom, atomIndex) => ({
      element: atom.element,
      // A deterministic, visible displacement of one atom per frame. Member 0
      // keeps the input geometry, so a dry run's downstream block still sees a
      // sane structure; the others are only table rows to rank.
      x: atom.x + (atomIndex === 1 ? index * 1.0 : 0),
      y: atom.y,
      z: atom.z,
    })),
    energyEh: -76.4 + index * 0.003,
    protomer: '',
  }));
  return { frames, text: frames.map((frame) => xyzText(frame.atoms, frame.comment)).join(''), energies: frames.map((frame) => frame.energyEh) };
}

