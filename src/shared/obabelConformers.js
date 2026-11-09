/**
 * Open Babel as an external force-field stage (#144 follow-up).
 *
 * Open Babel is not an engine in this app's vocabulary: it has no route, no
 * gates and no termination record. It is a *generator*, like CREST, and the
 * queue invokes it as a separate process. What it adds that the in-app UFF
 * search cannot is a modern organic force field (MMFF94 / MMFF94s) with
 * electrostatics, and a genetic-algorithm conformer search rather than a
 * torsion grid.
 *
 * Three things this module refuses to pretend:
 *
 * 1. **An MM energy is not a total electronic energy.** Every number here is
 *    kcal/mol from a force field, and the ensemble records
 *    `energyUnit: 'kcal/mol'` with `energyMethod: 'MMFF94'` so no reader can
 *    mistake it for a Hartree value.
 * 2. **MMFF94 does not cover every element.** It is parameterised for
 *    H, C, N, O, F, Si, P, S, Cl, Br and I (plus a short list of ions). An
 *    atom outside that list is refused by name before Open Babel is spawned —
 *    a silently untyped atom would give a plausible-looking energy for a
 *    molecule the force field never described.
 * 3. **This is not Spartan's stage.** Spartan uses MMFF94/DLFF03 with its own
 *    search protocol; an Open Babel ensemble is a different, reproducible
 *    search, and the docs and the provenance line say so.
 */

export const OBABEL_GENERATOR = 'obabel';

/**
 * Force fields this build will invoke. GAFF is deliberately absent: Open Babel
 * documents that it expects RESP/AM1-BCC charges and falls back to weaker ones,
 * so an ensemble produced here would carry an unstated charge model. MMFF94s is
 * the static variant (planarised delocalised nitrogen) and is a different claim
 * about the geometry, so it is a separate choice rather than a default.
 */
export const OBABEL_FORCE_FIELDS = Object.freeze(['mmff94', 'mmff94s']);
export const OBABEL_DEFAULT_FF = 'mmff94';
export const OBABEL_DEFAULT_NCONF = 20;
export const OBABEL_MIN_NCONF = 1;
export const OBABEL_MAX_NCONF = 1000;

export const OBABEL_PROVENANCE = 'Halgren, J. Comput. Chem. 17, 490-519 (1996), MMFF94';
export const OBABEL_ENERGY_KIND = 'force-field energy (kcal/mol), not a total electronic energy';

/** Elements MMFF94 is parameterised for (Open Babel docs, MMFF94 page). */
export const OBABEL_MMFF_ELEMENTS = Object.freeze(['H', 'C', 'N', 'O', 'F', 'Si', 'P', 'S', 'Cl', 'Br', 'I']);

export const OBABEL_SEARCH_OUTPUT = 'obabel_conformers.xyz';
export const OBABEL_SCORED_OUTPUT = 'obabel_scored.xyz';
export const OBABEL_SEARCH_LOG = 'obabel.log';

/** The force-field id as Gaussian/Open Babel spell it, or null when unknown. */
export function obabelForceFieldKeyword(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (key === 'mmff94') return 'MMFF94';
  if (key === 'mmff94s') return 'MMFF94s';
  return null;
}

/** The stored setting, normalised, or null when it is not one we run. */
export function normalizeObabelForceField(value, fallback = OBABEL_DEFAULT_FF) {
  const keyword = obabelForceFieldKeyword(value);
  if (keyword) return keyword.toLowerCase();
  return obabelForceFieldKeyword(fallback)?.toLowerCase() ?? OBABEL_DEFAULT_FF;
}

/**
 * Elements in the starting structure that MMFF94 cannot type.
 *
 * Returned sorted and de-duplicated so the refusal can name them exactly:
 * "MMFF94 has no parameters for Se (atom 3)" is actionable; "unsupported
 * atoms" is not.
 */
export function untypableElements(atoms) {
  const list = Array.isArray(atoms) ? atoms : [];
  const seen = new Set();
  for (const atom of list) {
    const element = String(atom?.element ?? '').trim();
    if (!element) continue;
    const normalised = element[0].toUpperCase() + element.slice(1).toLowerCase();
    if (!OBABEL_MMFF_ELEMENTS.includes(normalised)) seen.add(normalised);
  }
  return [...seen].sort();
}

/** Refusal text for a structure MMFF94 cannot describe, or '' when it can. */
export function obabelCoverageRefusal(atoms) {
  const missing = untypableElements(atoms);
  if (missing.length === 0) return '';
  return `MMFF94 has no parameters for ${missing.join(', ')}; Open Babel would leave those atoms untyped. `
    + `Choose another generator, or run the search in a program that covers this element.`;
}

/**
 * `obabel input.xyz -O obabel_conformers.xyz --conformer --nconf N --ff MMFF94
 *  --score energy --writeconformers`
 *
 * `--score energy` is not cosmetic: Open Babel's default is RMSD diversity,
 * which returns shapes chosen for being different from each other rather than
 * for being low in energy. A conformer *distribution* is an energy question.
 */
export function obabelSearchArgv({
  inputName = 'input.xyz',
  outputName = OBABEL_SEARCH_OUTPUT,
  nconf = OBABEL_DEFAULT_NCONF,
  ff = OBABEL_DEFAULT_FF,
} = {}) {
  const keyword = obabelForceFieldKeyword(ff);
  if (!keyword) throw new Error(`Open Babel force field "${ff}" is not one this app runs (${OBABEL_FORCE_FIELDS.join(', ')}).`);
  const count = Number(nconf);
  if (!Number.isInteger(count) || count < OBABEL_MIN_NCONF || count > OBABEL_MAX_NCONF) {
    throw new Error(`--nconf must be an integer between ${OBABEL_MIN_NCONF} and ${OBABEL_MAX_NCONF}.`);
  }
  return [
    inputName,
    '-O', outputName,
    '--conformer',
    '--nconf', String(count),
    '--ff', keyword,
    '--score', 'energy',
    '--writeconformers',
  ];
}

/**
 * Second pass: `obabel conf.xyz -O scored.xyz --energy --ff MMFF94 --append Energy`.
 *
 * Open Babel's GA logs the *best* energy per generation, not one per conformer
 * (verified on 3.1.0: the log prints `Generation #n <E>`), so the per-member
 * energies have to be evaluated. This pass appends the energy to each frame's
 * comment line, which is the same text the app already parses for geometry.
 */
export function obabelScoreArgv({
  inputName = OBABEL_SEARCH_OUTPUT,
  outputName = OBABEL_SCORED_OUTPUT,
  ff = OBABEL_DEFAULT_FF,
} = {}) {
  const keyword = obabelForceFieldKeyword(ff);
  if (!keyword) throw new Error(`Open Babel force field "${ff}" is not one this app runs (${OBABEL_FORCE_FIELDS.join(', ')}).`);
  return [inputName, '-O', outputName, '--energy', '--ff', keyword, '--append', 'Energy'];
}

/**
 * What the search printed, kept as facts rather than prose:
 *
 * ```
 * Initial conformer count: 6
 * 31 attempts,  22 duplicates, 4 failed filter.
 * Generation #1  -5.44312
 * ```
 *
 * `initialCount` is what was asked for; `generations` is the GA's best energies
 * in order, which is the only trace of the search itself once it converges.
 */
export function parseObabelSearchLog(text) {
  const source = String(text ?? '');
  const initial = source.match(/Initial conformer count:\s*(\d+)/i);
  const attempts = source.match(/(\d+)\s+attempts?,\s+(\d+)\s+duplicates?,\s+(\d+)\s+failed filter/i);
  const generations = [...source.matchAll(/Generation #(\d+)\s+(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/g)]
    .map((match) => ({ generation: Number(match[1]), energyKcal: Number(match[2]) }))
    .filter((row) => Number.isFinite(row.energyKcal));
  return {
    initialCount: initial ? Number(initial[1]) : null,
    attempts: attempts ? Number(attempts[1]) : null,
    duplicates: attempts ? Number(attempts[2]) : null,
    failedFilter: attempts ? Number(attempts[3]) : null,
    generations,
    // A search that printed no GA block is not necessarily wrong (a molecule
    // with one rotatable bond has nothing to search), but it is worth saying.
    stated: Boolean(initial || attempts || generations.length > 0),
  };
}

/**
 * Read the scored multi-frame XYZ.
 *
 * The comment of each frame is `<title> <energy>`, where the energy is the
 * number Open Babel appended in kcal/mol. It is read as a *positive or
 * negative* number here — unlike a Hartree total, an MM energy has no sign
 * convention that makes a positive value meaningless (the 84-atom 2,4-DHI-IQ
 * ensemble sits at +215.9 kcal/mol).
 */
export function parseObabelScoredEnsemble(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const frames = [];
  const errors = [];
  let index = 0;
  while (index < lines.length) {
    while (index < lines.length && lines[index].trim() === '') index += 1;
    if (index >= lines.length) break;
    const count = Number.parseInt(lines[index].trim(), 10);
    if (!Number.isInteger(count) || count <= 0) {
      errors.push({ frame: frames.length + 1, message: `Expected an atom count, found "${lines[index].trim().slice(0, 40)}".` });
      break;
    }
    const comment = (lines[index + 1] ?? '').trim();
    const atoms = [];
    let cursor = index + 2;
    for (let atom = 0; atom < count; atom += 1, cursor += 1) {
      const parts = (lines[cursor] ?? '').trim().split(/\s+/);
      const element = parts[0];
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const z = Number(parts[3]);
      if (!element || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        errors.push({ frame: frames.length + 1, message: `Atom line ${atom + 1} is not "element x y z": "${(lines[cursor] ?? '').slice(0, 60)}".` });
        return { frames, errors };
      }
      atoms.push({ element, x, y, z });
    }
    // The energy is the last token; anything else in the comment is the title
    // Open Babel copied from the input file.
    const last = comment.split(/\s+/).pop() ?? '';
    const energyKcal = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(last) ? Number(last) : null;
    frames.push({ index: frames.length + 1, comment, atoms, energyKcal });
    index = cursor;
  }
  if (frames.length === 0 && errors.length === 0) {
    errors.push({ frame: 0, message: 'Open Babel wrote no conformers.' });
  }
  const unscored = frames.findIndex((frame) => frame.energyKcal === null);
  if (unscored !== -1) {
    errors.push({
      frame: unscored + 1,
      message: `Conformer ${unscored + 1} came back without an MMFF94 energy — the force field could not type that structure.`,
    });
  }
  return { frames, errors };
}

/**
 * The ensemble text the rest of the app reads: one XYZ frame per conformer,
 * with the provenance in the comment and **no** energy token.
 *
 * The energy deliberately does not appear in the comment. The frame parser
 * treats a bare number there as a Hartree total, and writing kcal/mol into it
 * would be exactly the confusion this module exists to prevent; the numbers
 * travel separately and the ensemble declares their unit.
 */
export function obabelEnsembleText(frames, { version = '', ff = OBABEL_DEFAULT_FF } = {}) {
  const keyword = obabelForceFieldKeyword(ff) ?? 'MMFF94';
  const program = version ? `Open Babel ${version}` : 'Open Babel';
  return (Array.isArray(frames) ? frames : []).map((frame, index) => {
    const count = frame.atoms.length;
    const body = frame.atoms
      .map((atom) => `${atom.element} ${atom.x.toFixed(6)} ${atom.y.toFixed(6)} ${atom.z.toFixed(6)}`)
      .join('\n');
    return `${count}\n${program} · ${keyword} · conformer ${index + 1}\n${body}\n`;
  }).join('');
}

/** One line for the run console: what ran, and what it is not. */
export function obabelSearchSummary({ version = '', ff = OBABEL_DEFAULT_FF, nconf = 0, log = {} } = {}) {
  const keyword = obabelForceFieldKeyword(ff) ?? 'MMFF94';
  const parts = [
    `Open Babel${version ? ` ${version}` : ''} · ${keyword} · genetic-algorithm search`,
    `${nconf} requested`,
    `${log.attempts ?? '?'} attempts`,
    `${log.duplicates ?? '?'} duplicates`,
  ];
  return `${parts.join(' · ')}. Force-field structures in kcal/mol, not QM, and not Spartan's DLFF03 stage.`;
}
