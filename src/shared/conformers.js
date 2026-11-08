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

/**
 * Issue #130: the unit an absolute member energy is recorded in. `hartree` is
 * the historical default, so every ensemble written before the field existed
 * still means what it always meant. `kcal/mol` is what an MM program prints —
 * and an MM energy is not a molecular total energy, so it never gets stored in
 * a field named `energyEh`.
 */
export const CONFORMER_ENERGY_UNITS = Object.freeze(['hartree', 'kcal/mol']);
export const DEFAULT_ENERGY_UNIT = 'hartree';

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
  // Issue #130: what the imported file's energies are, and what produced them.
  // Ignored by a CREST search, which always writes Hartree energies.
  energyUnit: 'hartree',
  energyMethod: '',
  // Issue #129: the provenance the user declares for an imported file. The
  // hash of the bytes actually read is recorded at run time, not typed in.
  origin: Object.freeze({ program: '', version: '', method: '' }),
  // Issue #80: fan the retained ensemble out into one task per member instead
  // of carrying a single chosen geometry downstream. Off by default, so a file
  // written before the switch existed runs exactly as it did.
  fanOut: false,
});


const PROTROMER_TOKEN = /(?:protomer|tautomer)\s*[=:]\s*([A-Za-z0-9_.-]+)/i;
const ENERGY_TOKEN = /(?:energy|e)\s*[=:]\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/i;
/** Issue #130: a frame may say what unit its energy is in, and by what method. */
const UNIT_TOKEN = /(?:energy[_\s-]?unit|unit)\s*[=:]\s*(hartree|ha|eh|kcal\/mol|kcal)/i;
const METHOD_TOKEN = /(?:energy[_\s-]?method|energy[_\s-]?model|method)\s*[=:]\s*([A-Za-z0-9_.+\/-]{1,40})/i;

/** Normalise a unit label; '' when the text is not a unit this app records. */
export function normalizeEnergyUnit(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'kcal/mol' || text === 'kcal' || text === 'kcal mol-1') return 'kcal/mol';
  if (text === 'hartree' || text === 'ha' || text === 'eh') return 'hartree';
  return '';
}

/** `gfn2` → `GFN2-xTB`; anything else is returned as written. */
export function conformerMethodLabel(method) {
  const key = String(method ?? '').trim();
  const lower = key.toLowerCase();
  if (lower === 'gfn2') return 'GFN2-xTB';
  if (lower === 'gfnff') return 'GFN-FF';
  return key;
}


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
    // A unit or method written in the frame comment belongs to that frame: an
    // ensemble stitched together from two programs can carry both.
    const unit = normalizeEnergyUnit(comment.match(UNIT_TOKEN)?.[1] ?? '');
    const method = (comment.match(METHOD_TOKEN)?.[1] ?? '').trim();
    frames.push({
      index: frames.length + 1,
      comment: comment.trim(),
      atoms,
      energyEh: energy,
      protomer,
      ...(unit ? { energyUnit: unit } : {}),
      ...(method ? { energyMethod: method } : {}),
    });
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
  energyUnit = DEFAULT_ENERGY_UNIT,
  energyMethod = '',
} = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    return { members: [], spreadKcal: null, warnings: [], selectedId: '', requiresSelection: false, mixedEnergies: false, energyUnit: normalizeEnergyUnit(energyUnit) || DEFAULT_ENERGY_UNIT, error: 'The ensemble is empty.' };
  }
  const missing = frames.findIndex((frame) => !Number.isFinite(frame.energyEh));
  if (missing !== -1) {
    return { members: [], spreadKcal: null, warnings: [], selectedId: '', requiresSelection: false, mixedEnergies: false, energyUnit: normalizeEnergyUnit(energyUnit) || DEFAULT_ENERGY_UNIT, error: `Conformer ${missing + 1} has no energy.` };
  }

  // Issue #130: what unit a frame's number is in. A frame may say so itself
  // (comment `unit=kcal/mol`); otherwise the ensemble's declaration applies,
  // and a file that declares nothing is Hartree, exactly as before.
  const declaredUnit = normalizeEnergyUnit(energyUnit) || DEFAULT_ENERGY_UNIT;
  const declaredMethod = String(energyMethod ?? '').trim();
  const unitOf = (frame) => normalizeEnergyUnit(frame.energyUnit) || declaredUnit;
  const methodOf = (frame) => String(frame.energyMethod ?? '').trim() || declaredMethod;
  // The only conversion in this module, and it is explicit: one Hartree is
  // HARTREE_KCAL kcal/mol. Nothing is converted *into* Hartree, so an MM energy
  // never acquires a Hartree-looking value.
  const absoluteKcal = (frame) => (unitOf(frame) === 'kcal/mol' ? frame.energyEh : frame.energyEh * HARTREE_KCAL);

  const sorted = frames
    .map((frame, index) => ({ ...frame, originalIndex: index, absoluteKcal: absoluteKcal(frame) }))
    .sort((a, b) => (a.absoluteKcal - b.absoluteKcal) || (a.originalIndex - b.originalIndex));
  const lowest = sorted[0];
  const singleFactor = unitOf(lowest) === 'kcal/mol' ? 1 : HARTREE_KCAL;

  const members = sorted.map((frame, rank) => {
    const unit = unitOf(frame);
    return {
      id: `c${rank + 1}`,
      originalIndex: frame.originalIndex,
      rank: rank + 1,
      // The absolute energy keeps the unit that produced it: a kcal/mol member
      // has no Hartree energy at all, so `energyEh` is null rather than a
      // converted number that would invite comparison with an SCF total.
      energyEh: unit === 'hartree' ? frame.energyEh : null,
      energyKcal: unit === 'kcal/mol' ? frame.energyEh : null,
      energyUnit: unit,
      energyMethod: methodOf(frame),
      relativeKcal: unit === unitOf(lowest)
        ? (frame.energyEh - lowest.energyEh) * singleFactor
        : frame.absoluteKcal - lowest.absoluteKcal,
      population: 0,
      rmsdToLowest: 0,
      rmsdToPreviousKept: null,
      protomer: frame.protomer || '',
      atoms: frame.atoms,
      kept: false,
      dropped: null,
    };
  });

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

  // Issue #130: an ensemble whose members were not all produced the same way
  // cannot be averaged. Averaging MM and SCF energies would report a population
  // that no single method supports, so the ensemble is flagged and neither a
  // population nor a spread is reported.
  const signature = (member) => `${member.energyUnit}|${member.energyMethod.toLowerCase()}`;
  const signatures = [...new Set(retained.map(signature))];
  const mixedEnergies = signatures.length > 1;

  // Boltzmann populations over the retained set, at the requested temperature.
  const t = Math.max(Number(temperature) || 0, 1);
  const partition = mixedEnergies
    ? 0
    : retained.reduce((sum, member) => sum + Math.exp(-member.relativeKcal / (KB_KCAL * t)), 0);
  for (const member of retained) {
    if (mixedEnergies) {
      member.population = null;
      continue;
    }
    member.population = partition > 0 ? Math.exp(-member.relativeKcal / (KB_KCAL * t)) / partition : 0;
  }

  const spreadKcal = !mixedEnergies && retained.length > 0
    ? retained[retained.length - 1].relativeKcal - retained[0].relativeKcal
    : null;

  const warnings = [];
  if (mixedEnergies) {
    const units = [...new Set(retained.map((member) => member.energyUnit))].sort();
    const methods = [...new Set(retained.map((member) => member.energyMethod).filter(Boolean))];
    warnings.push({
      id: 'conformer-mixed-energies',
      status: 'warn',
      message: `The ensemble mixes different energy units or methods (${units.join(', ')}${methods.length ? `; ${methods.join(', ')}` : ''}): the relative energies are not comparable across them, so no populations or spread are reported. The members are shown, not averaged.`,
      units,
      methods,
    });
  } else if (spreadKcal !== null && spreadKcal > spreadThresholdKcal) {
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
    mixedEnergies,
    energyUnit: declaredUnit,
    energyMethod: declaredMethod,
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
export function ensembleSummary(result, {
  generator = '',
  method = '',
  origin = null,
  energyUnit = '',
  energyMethod = '',
} = {}) {
  const selected = result.retained?.find((member) => member.id === result.selectedId) || null;
  const unit = normalizeEnergyUnit(result.energyUnit) || normalizeEnergyUnit(energyUnit) || DEFAULT_ENERGY_UNIT;
  const methodName = String(
    result.energyMethod || energyMethod || (generator === 'crest' ? conformerMethodLabel(method) : ''),
  ).trim();
  const imported = String(generator || '').toLowerCase() === 'import';
  // Issue #129: an origin is recorded for every ensemble. A generated one names
  // the thing that ran here; an imported one carries only what was declared,
  // and an empty program means "not recorded" rather than "computed here".
  const originSource = origin && typeof origin === 'object' ? origin : {};
  const recordedOrigin = {
    program: String(originSource.program ?? '').trim() || (imported ? '' : String(generator || '').trim()),
    version: String(originSource.version ?? '').trim(),
    // `method` here is the *producing* method (MMFF94, GFN2-xTB), not the
    // conformer-block enum: an imported MMFF94 ensemble has no gfn2 anywhere.
    method: String(originSource.method ?? '').trim() || (imported ? '' : String(method || '').trim()),
    sourceSha256: String(originSource.sourceSha256 ?? '').trim(),
  };
  const carryEnergy = (member) => ({
    energyUnit: member.energyUnit || unit,
    // The ensemble's method fills in when a member does not name its own; a
    // mixed ensemble keeps each member's own answer.
    energyMethod: String(member.energyMethod || methodName).trim(),
  });
  return {
    generator: String(generator || ''),
    method: String(method || ''),
    energyUnit: unit,
    energyMethod: methodName,
    mixedEnergies: Boolean(result.mixedEnergies),
    origin: recordedOrigin,
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
      energyEh: selected.energyEh ?? null,
      energyKcal: selected.energyKcal ?? null,
      ...carryEnergy(selected),
      relativeKcal: selected.relativeKcal,
      population: selected.population ?? null,
      protomer: selected.protomer || '',
      atoms: selected.atoms,
    } : null,
    members: (result.members || []).map((member) => ({
      id: member.id,
      rank: member.rank,
      energyEh: member.energyEh ?? null,
      energyKcal: member.energyKcal ?? null,
      ...carryEnergy(member),
      relativeKcal: member.relativeKcal,
      population: member.population ?? null,
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

/* ── Provenance copy (issues #129, #130) ───────────────────────
 *
 * The card, the inspector and the ensemble table must agree on what an
 * ensemble is. These three functions are the only place that copy is built, so
 * "computed here" cannot appear on an imported ensemble and "Ha" cannot appear
 * next to a kcal/mol number: the tests assert the exact strings.
 */

const ENERGY_UNIT_LABEL = Object.freeze({ hartree: 'Hartree', 'kcal/mol': 'kcal/mol' });

function ensembleField(ensemble, key) {
  return ensemble && typeof ensemble === 'object' ? ensemble[key] : undefined;
}

function originOf(ensemble) {
  const origin = ensembleField(ensemble, 'origin');
  return origin && typeof origin === 'object' ? origin : {};
}

/** `program version` from an origin, or '' when nothing was declared. */
function originProgramText(origin) {
  return [origin.program, origin.version]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

/** Short digest for display: the first 12 hex characters and an ellipsis. */
export function formatSourceHash(value) {
  const text = String(value ?? '').trim();
  return text ? `${text.slice(0, 12)}…` : '';
}

/**
 * One line naming what produced the ensemble, for a card footer.
 *  - imported with a declared origin: `imported · Spartan 26.1`
 *  - imported with nothing declared:  `imported · origin not recorded`
 *  - a CREST search:                  `CREST GFN2-xTB`
 *  - a dry run:                       `dry-run fixture`
 */
export function conformerOriginShort(ensemble) {
  const generator = String(ensembleField(ensemble, 'generator') ?? '').trim().toLowerCase();
  const origin = originOf(ensemble);
  if (generator === 'crest') {
    const method = String(ensembleField(ensemble, 'energyMethod') ?? '').trim()
      || conformerMethodLabel(ensembleField(ensemble, 'method'));
    return ['CREST', method].filter(Boolean).join(' ');
  }
  if (generator === 'fixture') return 'dry-run fixture';
  if (generator === 'import') {
    const program = originProgramText(origin);
    return program ? `imported · ${program}` : 'imported · origin not recorded';
  }
  return generator ? `imported · ${generator}` : '';
}

/**
 * The full provenance line for the inspector. Deliberately says *imported*
 * and names the producing method — never the conformer-block generator, and
 * never `gfn2`, which an imported file was not produced with.
 */
export function conformerOriginLabel(ensemble) {
  const generator = String(ensembleField(ensemble, 'generator') ?? '').trim().toLowerCase();
  if (!generator) return '';
  const origin = originOf(ensemble);
  if (generator === 'fixture') return 'dry run · labelled fixture, not a search';
  if (generator === 'crest') {
    const method = String(ensembleField(ensemble, 'energyMethod') ?? '').trim()
      || conformerMethodLabel(ensembleField(ensemble, 'method'));
    return `computed here · ${['CREST', method].filter(Boolean).join(' ')}`;
  }
  const parts = ['imported'];
  const program = originProgramText(origin);
  parts.push(program || 'origin not recorded');
  const method = String(origin.method ?? '').trim();
  if (method) parts.push(method);
  const hash = formatSourceHash(origin.sourceSha256);
  if (hash) parts.push(`sha256 ${hash}`);
  return parts.join(' · ');
}

/**
 * What unit the absolute energies are in, and what produced them:
 * `kcal/mol · MMFF94`, `Hartree · GFN2-xTB`, or the mixed-ensemble refusal.
 */
export function conformerEnergyLabel(ensemble) {
  if (ensembleField(ensemble, 'mixedEnergies')) return 'mixed units/methods — not averaged';
  const unit = normalizeEnergyUnit(ensembleField(ensemble, 'energyUnit')) || DEFAULT_ENERGY_UNIT;
  const method = String(ensembleField(ensemble, 'energyMethod') ?? '').trim()
    || (String(ensembleField(ensemble, 'generator') ?? '').toLowerCase() === 'crest'
      ? conformerMethodLabel(ensembleField(ensemble, 'method'))
      : '');
  return `${ENERGY_UNIT_LABEL[unit]} · ${method || 'method not stated'}`;
}

/**
 * The caption above the ensemble table. The table's ΔE column is always
 * kcal/mol relative to the lowest member; this line says what the *absolute*
 * numbers are, because that is the claim a reader would otherwise guess.
 */
export function conformerTableCaption(ensemble) {
  if (!ensemble || typeof ensemble !== 'object') return 'No ensemble yet.';
  if (ensembleField(ensemble, 'mixedEnergies')) {
    return 'ΔE in kcal/mol · mixed energy units/methods — not averaged';
  }
  const unit = normalizeEnergyUnit(ensembleField(ensemble, 'energyUnit')) || DEFAULT_ENERGY_UNIT;
  const method = String(ensembleField(ensemble, 'energyMethod') ?? '').trim()
    || (String(ensembleField(ensemble, 'generator') ?? '').toLowerCase() === 'crest'
      ? conformerMethodLabel(ensembleField(ensemble, 'method'))
      : '');
  return `ΔE in kcal/mol · absolute energies in ${ENERGY_UNIT_LABEL[unit]}${method ? ` (${method})` : ''}`;
}

/* ── Boltzmann-weighted observables (issue #96) ─────────────────
 *
 * A conformer ensemble answers a different question from a single geometry:
 * the observable is a population-weighted mean, not the value of the lowest
 * member. This section only weights an ensemble that was actually retained:
 * every member must carry the population `rankEnsemble` assigned, and those
 * populations must sum to one. A missing population is a refusal, never a
 * silent re-normalisation over whichever members happened to have a value.
 */

/** Observables the parser already produces per conformer, and their units. */
export const ENSEMBLE_OBSERVABLES = Object.freeze({
  energyHartree: { label: 'Energy', unit: 'Eh', digits: 8 },
  gibbsHartree: { label: 'Gibbs free energy', unit: 'Eh', digits: 8 },
  gapEv: { label: 'HOMO–LUMO gap', unit: 'eV', digits: 3 },
});

/**
 * Boltzmann populations for relative energies in kcal/mol.
 * Returns [] for an empty ensemble, a non-finite energy or a non-positive
 * temperature: there is no population to report in those cases.
 */
export function boltzmannWeights(relativeKcal, temperature = DEFAULT_CONFORMER_SETTINGS.temperature) {
  if (!Array.isArray(relativeKcal) || relativeKcal.length === 0) return [];
  const t = Number(temperature);
  if (!Number.isFinite(t) || t <= 0) return [];
  const values = relativeKcal.map(Number);
  if (values.some((value) => !Number.isFinite(value))) return [];
  const lowest = Math.min(...values);
  const exponents = values.map((value) => -(value - lowest) / (KB_KCAL * t));
  const partition = exponents.reduce((sum, value) => sum + Math.exp(value), 0);
  if (!Number.isFinite(partition) || partition <= 0) return [];
  return exponents.map((value) => Math.exp(value) / partition);
}

function formatObservable(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : null;
}

/**
 * Population-weighted observables over a retained ensemble.
 *
 * @param {Array<object>} members retained members, each `{ id, population,
 *   values: { energyHartree?, gibbsHartree?, gapEv? } }`. `population` is the
 *   Boltzmann weight `rankEnsemble` assigned; it is never recomputed here.
 * @param {object} [options]
 * @param {number} [options.temperature] the temperature the populations were
 *   computed at, printed with the result
 * @param {string[]} [options.observables] observable keys to average
 * @returns {object} weighted and unweighted means, min/max spread, weighted
 *   standard deviation, the population table and an explicit convergence label
 */
export function boltzmannWeightedObservables(members, {
  temperature = DEFAULT_CONFORMER_SETTINGS.temperature,
  observables = Object.keys(ENSEMBLE_OBSERVABLES),
} = {}) {
  const t = Number(temperature);
  if (!Number.isFinite(t) || t <= 0) {
    return { available: false, reason: 'a positive temperature is required to label an ensemble average' };
  }
  if (!Array.isArray(members) || members.length === 0) {
    return { available: false, reason: 'the retained ensemble is empty; nothing is weighted' };
  }

  const populations = [];
  for (const member of members) {
    const id = String(member?.id ?? '');
    const population = Number(member?.population);
    if (!id) return { available: false, reason: 'a retained member has no id; the population table cannot be built' };
    if (!Number.isFinite(population) || population <= 0) {
      return { available: false, reason: `member ${id} has no population; an ensemble that was not retained is never weighted` };
    }
    populations.push({ id, population });
  }
  const total = populations.reduce((sum, entry) => sum + entry.population, 0);
  if (Math.abs(total - 1) > 1e-6) {
    return { available: false, reason: `the populations do not sum to 1 (Σ = ${total.toFixed(6)}); an ensemble that was not retained is never weighted` };
  }

  const maxPopulation = Math.max(...populations.map((entry) => entry.population));
  const converged = maxPopulation >= 0.95;
  const convergence = converged
    ? `largest retained population ${formatPopulation(maxPopulation)} ≥ 95%; one conformer dominates`
    : `largest retained population ${formatPopulation(maxPopulation)} < 95%; the unweighted value is shown beside the ensemble average`;

  const averaged = [];
  const omitted = [];
  for (const key of Array.isArray(observables) ? observables : []) {
    const config = ENSEMBLE_OBSERVABLES[key] || { label: key, unit: '', digits: 6 };
    let missing = null;
    const values = [];
    for (let index = 0; index < members.length; index += 1) {
      const raw = members[index]?.values?.[key];
      const value = Number(raw);
      if (raw === null || raw === undefined || !Number.isFinite(value)) {
        missing = populations[index].id;
        break;
      }
      values.push(value);
    }
    if (missing !== null) {
      omitted.push({ key, reason: `member ${missing} has no ${config.label}` });
      continue;
    }
    const weightedMean = values.reduce((sum, value, index) => sum + populations[index].population * value, 0);
    const unweightedMean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const weightedStdDev = Math.sqrt(values.reduce(
      (sum, value, index) => sum + populations[index].population * (value - weightedMean) ** 2,
      0,
    ));
    averaged.push({
      key,
      label: config.label,
      unit: config.unit,
      weightedMean,
      unweightedMean,
      min,
      max,
      spread: max - min,
      weightedStdDev,
      count: values.length,
      over: `${values.length} retained conformers`,
      converged,
      formattedWeightedMean: formatObservable(weightedMean, config.digits),
      formattedUnweightedMean: formatObservable(unweightedMean, config.digits),
      formattedSpread: formatObservable(max - min, config.digits),
    });
  }

  if (averaged.length === 0) {
    return {
      available: false,
      reason: `nothing could be averaged: ${omitted.map((entry) => entry.reason).join('; ')}`,
      omitted,
    };
  }

  return {
    available: true,
    reason: null,
    label: 'ensemble-averaged',
    temperatureK: t,
    memberCount: populations.length,
    populations,
    observables: averaged,
    omitted,
    converged,
    convergence,
    unweightedFallback: !converged,
  };
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

