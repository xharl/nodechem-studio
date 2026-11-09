/**
 * DP4+ as a workflow block (issue 165).
 *
 * `dp4.js` is the calculation: given candidates, one experimental list and a
 * level the parameter bank carries, it returns a probability per candidate.
 * This module is the *only* thing between that function and a project — it
 * turns a block's saved definition into the arguments `dp4.js` expects, and
 * turns the run records of the blocks wired upstream into candidates. Nothing
 * here computes a probability, a shift or an error: every number that reaches
 * the table was computed by `dp4.js` from the bank, and every number it reads
 * came from a `run.json` this app wrote.
 *
 * Why a separate module: the same conversion has to happen in three places —
 * saving a project (`projectSchema.js`), planning a queue (`workflowTasks.js`)
 * and running the task (`electron/runner/queue.js`) — and the renderer's
 * inspector previews from it too. One implementation, so the preview, the plan
 * and the run cannot disagree about what the experiment is.
 *
 * ## The definition a block carries
 *
 * ```json
 * "analyse": {
 *   "mode": "dp4",
 *   "dp4": {
 *     "level": "mPW1PW91/6-31+G(d,p)",
 *     "solvation": "PCM",
 *     "solvent": "CHCl3",
 *     "variant": "full",
 *     "temperature": 298.15,
 *     "experimental": [
 *       { "nucleus": "13C", "shift": 67.5, "sp2": false, "atoms": [2] },
 *       { "nucleus": "1H", "shift": 4.32, "atoms": [1] }
 *     ],
 *     "candidateAssignments": { "mol-2": [[2], [1]] }
 *   }
 * }
 * ```
 *
 * Every measured shift carries its own atom assignment (`atoms`, 1-based as
 * the log prints them, several atoms averaged when they are equivalent). That
 * is the one-to-one map the issue names: without it a computed shielding is not
 * comparable to a measurement, and `dp4.js` refuses. `candidateAssignments`
 * overrides the shared table for one candidate, because two isomers number
 * their atoms differently and that is a fact about the structures, not a
 * choice.
 *
 * ## Candidates from run records
 *
 * A candidate is one record of the blocks wired into the DP4 block; its
 * conformers are that record's runs (a fanned-out conformer ensemble runs one
 * per member). The shieldings come from `parsed.nmr.atoms`, which is what the
 * Gaussian GIAO parser wrote; the energies and populations come from
 * `parsed.scf`/`parsed.finalEnergy` and `conformer.population`. A candidate
 * whose run records carry no shielding block is refused by name — a Boltzmann
 * average over whichever members happened to have an NMR log is a different
 * average, and this module does not invent one.
 *
 * Pure: no filesystem, no clock, no network. The caller supplies the records.
 */

import {
  DP4_VARIANTS,
  DP4_VARIANT_LABELS,
  DP4_DEFAULT_TEMPERATURE,
  dp4Level,
  dp4Probabilities,
  dp4Verdict,
  dp4LevelIds,
} from './dp4.js';
import { elementForNucleus } from './nmr.js';

/** The value of `compute.mode` that selects this block; anything else is arithmetic. */
export const DP4_COMPUTE_MODE = 'dp4';

/** Longest experimental list a block may carry; the reference studies are ~30. */
export const DP4_EXPERIMENTAL_MAX = 400;

/** The nucleus labels a measured row may use, canonical form first. */
export const DP4_NUCLEUS_LABELS = Object.freeze(['13C', '1H', 'C', 'H']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** `13c` → `13C`; anything this app does not read → null. */
function canonicalNucleus(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const match = DP4_NUCLEUS_LABELS.find((label) => label.toLowerCase() === raw.toLowerCase());
  if (!match) return null;
  return elementForNucleus(match) === 'C' ? '13C' : '1H';
}

/**
 * The atom indices of one assignment row, or null when the row is not a list of
 * positive integers. Duplicates stay in place: `dp4.js` refuses them with the
 * row it names, and doing that check here would be a second copy of the rule.
 */
function atomIndices(value) {
  const list = Array.isArray(value) ? value : (Number.isFinite(Number(value)) ? [value] : []);
  if (list.length === 0) return null;
  const indices = list.map(Number);
  if (!indices.every((index) => Number.isInteger(index) && index > 0)) return null;
  return indices;
}

/**
 * Normalise a saved DP4 definition into the shape `dp4Probabilities()` takes.
 *
 * No validation happens here — `validateDp4Definition()` below is the checker,
 * and this function only arranges what is already there. It is deliberately
 * total: a caller that already validated gets no surprise, and a caller that
 * did not gets a definition the validator's refusals can describe.
 */
export function dp4DefinitionOf(raw) {
  const source = isObject(raw) ? raw : {};
  const level = text(source.level) || (isObject(source.level)
    ? `${text(source.level.method)}/${text(source.level.basis)}`.replace(/\/$/, '')
    : '');
  const solvationRaw = text(source.solvation);
  const solvation = /^gas(-phase)?$/i.test(solvationRaw) || /^none$/i.test(solvationRaw)
    ? 'gas'
    : (/^(pcm|scrpcm|cpcm)$/i.test(solvationRaw) ? 'PCM' : solvationRaw);
  const variantRaw = text(source.variant).toLowerCase() || 'full';
  const rawTemperature = source.temperature;
  const temperature = rawTemperature === null || rawTemperature === undefined || String(rawTemperature).trim() === ''
    ? DP4_DEFAULT_TEMPERATURE
    : Number(rawTemperature);
  const experimental = (Array.isArray(source.experimental) ? source.experimental : [])
    .slice(0, DP4_EXPERIMENTAL_MAX)
    .map((row) => {
      const entry = isObject(row) ? row : {};
      const nucleus = canonicalNucleus(entry.nucleus);
      const atoms = atomIndices(entry.atoms);
      // `Number(null)` is 0 and `Number('')` is 0: an unmeasured shift must stay
      // NaN so the validator refuses the row, never become a measured 0.00 ppm.
      const shift = entry.shift === null || entry.shift === undefined || String(entry.shift).trim() === ''
        ? Number.NaN
        : Number(entry.shift);
      return {
        nucleus: nucleus || text(entry.nucleus),
        shift,
        // An unmarked assignment means sp³ in the reference workflow, which is
        // what `dp4.js` documents for `sp2: false`. Absent stays absent here so
        // the saved file does not grow a field nobody wrote.
        ...(entry.sp2 === true ? { sp2: true } : {}),
        ...(text(entry.exchange) ? { exchange: text(entry.exchange) } : {}),
        ...(text(entry.unit) && text(entry.unit).toLowerCase() !== 'ppm' ? { unit: text(entry.unit) } : {}),
        ...(atoms ? { atoms } : {}),
      };
    });
  const candidateAssignments = {};
  if (isObject(source.candidateAssignments)) {
    for (const [id, rows] of Object.entries(source.candidateAssignments)) {
      const key = String(id).trim();
      if (!key) continue;
      candidateAssignments[key] = (Array.isArray(rows) ? rows : []).map((row) => atomIndices(row) || []);
    }
  }
  return {
    level,
    solvation,
    solvent: solvation === 'gas' ? '' : text(source.solvent),
    variant: variantRaw,
    temperature,
    experimental,
    ...(Object.keys(candidateAssignments).length ? { candidateAssignments } : {}),
  };
}

/**
 * Check a DP4 definition, naming every problem with the path inside `dp4`.
 *
 * The level is resolved against the bank here — at *save* time — because a
 * level the bank does not carry is not a run-time discovery: the project can
 * never produce a number, so the file must not be saved as if it could. The
 * refusal is `dp4Level()`'s own sentence, which names the level and lists the
 * ones the bank has; this function does not paraphrase it.
 *
 * @returns {{ok: boolean, errors: Array<{path: string, message: string}>, definition: object}}
 */
export function validateDp4Definition(raw) {
  const definition = dp4DefinitionOf(raw);
  const errors = [];
  const error = (path, message) => errors.push({ path, message });

  const source = isObject(raw) ? raw : {};
  const levelResolved = dp4Level({ level: definition.level, solvation: definition.solvation, solvent: definition.solvent });
  if (!definition.level) {
    error('level', `a DP4+ block needs the level of theory the shieldings were computed at; the bank carries ${dp4LevelIds().length} levels (${dp4LevelIds().join(', ')})`);
  } else if (!levelResolved.ok) {
    error(levelResolved.code === 'solvation-missing' || levelResolved.code === 'solvent-missing'
      || levelResolved.code === 'solvent-not-in-bank' ? 'solvation' : 'level', levelResolved.reason);
  }

  if (!DP4_VARIANTS.includes(definition.variant)) {
    const classic = ['dp4', 'classic', 'dp4-classic'].includes(definition.variant);
    error('variant', classic
      ? `classic DP4 (Smith & Goodman 2010) is not implemented: its t-parameters are a different fit that this bank does not carry, and a DP4+ number is never reported as DP4. Use ${DP4_VARIANTS.join(', ')}`
      : `unknown DP4 variant "${source.variant}"; this app computes ${DP4_VARIANTS.join(', ')} (${DP4_VARIANTS.map((key) => DP4_VARIANT_LABELS[key]).join('; ')})`);
  }
  if (!finite(definition.temperature) || definition.temperature <= 0) {
    error('temperature', 'the Boltzmann weights need a positive temperature in kelvin');
  }
  if (definition.experimental.length === 0) {
    error('experimental', 'no experimental shifts were given; DP4+ compares a calculation with a measurement');
  }
  definition.experimental.forEach((row, position) => {
    const path = `experimental[${position}]`;
    if (!canonicalNucleus(row.nucleus)) {
      error(`${path}.nucleus`, `"${row.nucleus ?? ''}" is not a nucleus this app reads for DP4+ (13C, 1H)`);
    }
    if (!finite(row.shift)) {
      error(`${path}.shift`, 'a measured shift must be a finite number in ppm');
    }
    if (row.unit) {
      error(`${path}.unit`, `measured shifts are read in ppm; "${row.unit}" is not a unit DP4+ is fitted in`);
    }
    if (!row.atoms || row.atoms.length === 0) {
      error(`${path}.atoms`, 'every measured shift needs at least one atom number (1-based, as the log prints them) so the computed shielding can be compared with it');
    }
  });
  for (const [id, rows] of Object.entries(definition.candidateAssignments || {})) {
    if (rows.length !== definition.experimental.length) {
      error(`candidateAssignments.${id}`, `${rows.length} assignment rows for ${definition.experimental.length} experimental shifts; the map is not one-to-one`);
    }
    rows.forEach((row, position) => {
      if (row.length === 0) {
        error(`candidateAssignments.${id}[${position}]`, 'row lists no atom; list the equivalent atoms this measured shift belongs to');
      }
    });
  }
  // Index reuse across *different* rows is refused by `dp4.js` at run time with
  // the two rows named; the check here is only that each row has an atom.
  return { ok: errors.length === 0, errors, definition };
}

/**
 * The definition as it is saved in the project file.
 *
 * What the block chose, made explicit: the nucleus labels canonical, the
 * temperature stated, the variant named. No resolved standard (σ(TMS)) is
 * written here — that belongs to the bank the calculation reads, and copying
 * it into a project would let a file outlive the parameters it was made with.
 */
export function dp4DefinitionForFile(raw) {
  const definition = dp4DefinitionOf(raw);
  return {
    level: definition.level,
    solvation: definition.solvation,
    ...(definition.solvent ? { solvent: definition.solvent } : {}),
    variant: definition.variant,
    temperature: definition.temperature,
    experimental: definition.experimental,
    ...(definition.candidateAssignments ? { candidateAssignments: definition.candidateAssignments } : {}),
  };
}

/** The refusal code for one validation path, so a caller can branch on a name. */
function codeOfValidation(pathname) {
  const path = String(pathname || '');
  if (path.startsWith('level')) return 'level-not-in-bank';
  if (path.startsWith('variant')) return 'unknown-variant';
  if (path.startsWith('temperature')) return 'temperature-invalid';
  if (path.startsWith('experimental') || path.startsWith('candidateAssignments')) return 'experimental-invalid';
  return 'dp4-definition';
}

/** One line naming what this block will compare, for the card and the queue row. */
export function dp4DefinitionSummary(definition) {
  const level = text(definition?.level) || 'no level';
  const variant = DP4_VARIANT_LABELS[definition?.variant] || text(definition?.variant) || 'DP4+';
  const solvent = definition?.solvation === 'gas' ? 'gas phase' : `${definition?.solvation || 'solvation?'}${definition?.solvent ? `/${definition.solvent}` : ''}`;
  const count = Array.isArray(definition?.experimental) ? definition.experimental.length : 0;
  return `${variant} over ${count} measured shift${count === 1 ? '' : 's'} at ${level} ${solvent}, ${definition?.temperature ?? DP4_DEFAULT_TEMPERATURE} K`;
}

/* ── candidates from run records ───────────────────────────── */

/** The shielding list a run recorded, in the shape `dp4.js` reads. */
function shieldingsOf(run) {
  const atoms = run?.parsed?.nmr?.atoms;
  if (!Array.isArray(atoms)) return null;
  const rows = atoms
    .filter((atom) => atom && Number.isFinite(Number(atom.index)) && Number.isFinite(Number(atom.isotropic)))
    .map((atom) => ({ index: Number(atom.index), element: text(atom.element), isotropic: Number(atom.isotropic) }));
  return rows.length ? rows : null;
}

/** The level a run declares, as `mPW1PW91/6-31+G(d,p)`, or ''. */
function declaredLevelOf(run) {
  const method = run?.provenance?.method;
  const functional = text(method?.functional) || text(method?.hamiltonian);
  const basis = text(method?.basis);
  return functional && basis ? `${functional}/${basis}` : '';
}

/**
 * Candidates from the run records of the blocks wired upstream.
 *
 * @param {Array<object>} rows each `{ source, recordId, memberId, taskId, label, run }`
 * @param {object} definition the normalised DP4 definition
 * @returns {{ok: true, candidates: Array<object>} | {ok: false, code: string, reason: string}}
 */
export function dp4CandidatesFromRuns(rows, definition) {
  const list = Array.isArray(rows) ? rows : [];
  const groups = new Map();
  for (const row of list) {
    const run = row?.run;
    if (!run || typeof run !== 'object') continue;
    const source = text(row.source) || String(row.taskId || '').split('~')[0];
    const recordId = text(row.recordId) || '';
    // One record = one candidate. A single-record flow (no dataset scope) has
    // no record id, so the block itself is the candidate: two blocks wired
    // into one DP4 block are two candidates, which is the two-isomer case.
    const key = `${source}::${recordId}`;
    const id = recordId || source;
    const group = groups.get(key) || { id, label: text(row.label), source, runs: [] };
    if (!group.label && text(row.label)) group.label = text(row.label);
    group.runs.push({ taskId: text(row.taskId) || key, run });
    groups.set(key, group);
  }
  if (groups.size === 0) {
    return { ok: false, code: 'no-candidate-records', reason: 'no upstream block has produced a run record yet; DP4+ compares finished calculations with a measurement' };
  }

  const candidates = [];
  const shared = (definition.experimental || []).map((row) => row.atoms || []);
  for (const group of groups.values()) {
    const conformers = [];
    for (const { taskId, run } of group.runs) {
      const shieldings = shieldingsOf(run);
      if (!shieldings) {
        return {
          ok: false,
          code: 'candidate-without-shieldings',
          reason: `candidate ${group.id}: run ${taskId} carries no parsed NMR shielding block; a Boltzmann average over only the members that printed one would be an average of a different ensemble`,
        };
      }
      const hartree = Number(run?.parsed?.finalEnergy?.hartree ?? run?.parsed?.scf?.energyHartree);
      const population = Number(run?.conformer?.population);
      const kcal = Number(run?.conformer?.relativeKcal);
      conformers.push({
        ...(Number.isFinite(hartree) ? { energyHartree: hartree } : {}),
        ...(!Number.isFinite(hartree) && Number.isFinite(kcal) ? { energyKcal: kcal } : {}),
        ...(Number.isFinite(population) && population > 0 ? { population } : {}),
        shieldings,
      });
    }
    const declared = group.runs.map(({ run }) => declaredLevelOf(run)).filter(Boolean);
    // `dp4.js` compares a candidate's declared level with the block's, and
    // refuses a mismatch — which is the check that stops one comparison mixing
    // two functionals. It compares the strings as written, so a candidate whose
    // level differs only in case from the bank's id is passed the bank's own
    // spelling; anything else is passed as declared and refused there.
    const sameLevel = declared.length && declared.every((value) => value.toLowerCase() === text(definition.level).toLowerCase());
    const assignments = definition.candidateAssignments?.[group.id] || shared;
    candidates.push({
      id: group.id,
      title: group.label || group.id,
      ...(sameLevel ? { level: text(definition.level) } : (declared[0] ? { level: declared[0] } : {})),
      conformers,
      assignments,
    });
  }
  return { ok: true, candidates };
}

/* ── the evaluation ───────────────────────────────────────── */

/**
 * Run one DP4+ block over the run records it was given.
 *
 * Never throws for a data problem: a missing candidate, a candidate without
 * shieldings, a level the bank does not carry and every refusal `dp4.js`
 * already implements come back as `{available: false, code, reason, status}`.
 * The shape is the one the card, the report and `run.json` all read: on success
 * it *is* the object `dp4Probabilities()` returned, with `status` and
 * `expression` added.
 *
 * @param {object} raw the saved `compute.dp4` definition
 * @param {object} options
 * @param {Array<object>} options.rows upstream run records, see `dp4CandidatesFromRuns`
 */
export function evaluateDp4(raw, { rows = [] } = {}) {
  const checked = validateDp4Definition(raw);
  const definition = checked.definition;
  const expression = dp4DefinitionSummary(definition);
  const refusal = (code, reason, extra = {}) => ({
    available: false,
    code,
    reason,
    status: 'refused',
    expression,
    notComputed: `not computed: ${reason}`,
    notes: [reason],
    ...extra,
  });
  if (!checked.ok) {
    const [first] = checked.errors;
    return refusal(codeOfValidation(first?.path), first?.message || 'the DP4+ definition is incomplete', { errors: checked.errors });
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return refusal('no-candidate-records', 'waiting for the blocks wired into this DP4+ block to produce run records', { status: 'pending' });
  }

  const built = dp4CandidatesFromRuns(rows, definition);
  if (!built.ok) return refusal(built.code, built.reason);

  const result = dp4Probabilities({
    candidates: built.candidates,
    experimental: definition.experimental.map((row, position) => ({
      index: position + 1,
      nucleus: row.nucleus,
      shift: row.shift,
      sp2: row.sp2 === true,
      ...(row.exchange ? { exchange: row.exchange } : {}),
    })),
    level: definition.level,
    solvation: definition.solvation,
    solvent: definition.solvent,
    variant: definition.variant,
    temperature: definition.temperature,
  });
  if (result.available !== true) {
    return {
      ...result,
      status: 'refused',
      expression,
      notComputed: `not computed: ${result.reason}`,
      notes: [result.reason],
    };
  }
  const verdict = dp4Verdict(result);
  return {
    ...result,
    status: 'computed',
    expression,
    notComputed: null,
    notes: [
      `${result.candidates.length} candidates over ${result.experimental.count} measured shifts; ${result.variantLabel}.`,
      ...(verdict ? [verdict.text] : []),
      ...(result.excluded.length
        ? [`${result.excluded.length} candidate(s) excluded: ${result.excluded.map((entry) => `${entry.candidateId} (${entry.reason})`).join('; ')}`]
        : []),
    ],
  };
}

/**
 * The one line a queue row and a card headline can share.
 *
 * On success it is the same verdict the card prints (`c1 — 87.3 %`), because a
 * second phrasing of the same result is a second claim; on a refusal it is the
 * refusal sentence, unaltered.
 */
export function dp4Summary(result) {
  if (!result || typeof result !== 'object') return 'no DP4+ result';
  if (result.available !== true) return result.reason || result.notComputed || 'DP4+ not computed';
  const verdict = dp4Verdict(result);
  return verdict ? verdict.text : `${result.candidates.length} candidates compared`;
}

/**
 * The upstream run records of a plan or a queue, grouped as rows.
 *
 * `lookup(blockId)` returns `{ taskId, recordId, memberId, run, label }[]` for
 * one upstream block; this only concatenates them and tags each row with the
 * block it came from, so two blocks cannot merge into one candidate.
 */
export function dp4RowsFromSources(sources, lookup) {
  const rows = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    for (const row of lookup(source) || []) rows.push({ ...row, source });
  }
  return rows;
}
