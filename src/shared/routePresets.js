/**
 * Route presets and dispersion defaults.
 *
 * The modern default route is B3LYP-D3(BJ)/def2-SVP: B3LYP has no built-in
 * dispersion, so a new route pairs it with Grimme D3(BJ) empirical dispersion
 * (`EmpiricalDispersion=GD3BJ`) and the modern def2-SVP basis.
 *
 * Methods whose Gaussian implementation already contains dispersion must not
 * receive a second empirical correction. Keep that an explicit allow-list:
 * guessing from the method name risks silently double-counting dispersion.
 */

export const DEFAULT_DISPERSION = 'GD3BJ';

/** Methods that already include a dispersion correction in Gaussian 16. */
export const BUILTIN_DISPERSION_METHODS = Object.freeze([
  'ωB97X-D',
  'wB97X-D',
  'wB97X-D3',
  'wB97X-V',
  'wB97M-V',
  'B97-D',
  'B97-D3',
]);

function methodKey(method) {
  return String(method ?? '')
    .trim()
    .toLowerCase()
    .replace(/ω/g, 'w')
    .replace(/[^a-z0-9]/g, '');
}

const BUILTIN_DISPERSION_KEYS = new Set(BUILTIN_DISPERSION_METHODS.map(methodKey));

/** True when the method already carries its own dispersion correction. */
export function hasBuiltinDispersion(method) {
  return BUILTIN_DISPERSION_KEYS.has(methodKey(method));
}

/** Dispersion default for a method: none when built in, otherwise D3(BJ). */
export function defaultDispersionFor(method) {
  return hasBuiltinDispersion(method) ? '' : DEFAULT_DISPERSION;
}

/**
 * Dispersion after an explicit method change in the inspector. A built-in
 * correction replaces any empirical keyword; otherwise keep an explicit
 * GD3/GD3BJ choice and supply D3(BJ) when the field is still None.
 */
export function dispersionForMethodChange(method, currentDispersion = '') {
  if (hasBuiltinDispersion(method)) return '';
  return currentDispersion || DEFAULT_DISPERSION;
}

/**
 * Methods whose Gaussian 16 implementation is a density functional. This is an
 * explicit allow-list, not a name heuristic: an unknown method is treated as
 * not-DFT so the app never silently changes the integration grid of a route it
 * does not understand. `Opt=Tight` with DFT calls for `Int=UltraFine`; see
 * `requiresUltraFineGrid` in ./tsForceConstants.js.
 */
export const DFT_METHODS = Object.freeze([
  'B3LYP', 'B3PW91', 'PBE0', 'PBE', 'PBEPBE', 'M06', 'M06-2X', 'M06-L',
  'ωB97X-D', 'wB97X-D', 'B97-D', 'TPSSTPSS', 'CAM-B3LYP', 'B2PLYP',
]);

const DFT_METHOD_KEYS = new Set(DFT_METHODS.map(methodKey));

/** True when the method is a density functional in Gaussian 16. */
export function isDftMethod(method) {
  return DFT_METHOD_KEYS.has(methodKey(method));
}

export const MODERN_ROUTE_PRESET = Object.freeze({
  id: 'modern',
  label: 'Modern default (B3LYP-D3(BJ)/def2-SVP)',
  method: 'B3LYP',
  basis: 'def2-SVP',
  dispersion: DEFAULT_DISPERSION,
});

/**
 * The pre-issue default. Kept byte-identical so an old input can still be
 * reproduced exactly; this is not the default for new projects or nodes.
 */
export const LEGACY_ROUTE_PRESET = Object.freeze({
  id: 'legacy',
  label: 'Legacy (reproduce a paper)',
  method: 'B3LYP',
  basis: '6-31G(d)',
  dispersion: '',
});

export const ROUTE_PRESETS = Object.freeze([MODERN_ROUTE_PRESET, LEGACY_ROUTE_PRESET]);

/** Preset id matching the current method/basis/dispersion, or '' for custom. */
export function routePresetIdFor(settings = {}) {
  const dispersion = settings.dispersion || '';
  const preset = ROUTE_PRESETS.find((item) => (
    item.method === settings.method
    && item.basis === settings.basis
    && item.dispersion === dispersion
  ));
  return preset ? preset.id : '';
}

/** Return a copy of `settings` with the preset's route fields applied. */
export function applyRoutePreset(settings, presetId) {
  const preset = ROUTE_PRESETS.find((item) => item.id === presetId);
  if (!preset) return { ...settings };
  return {
    ...settings,
    method: preset.method,
    basis: preset.basis,
    dispersion: preset.dispersion,
  };
}

/* ── Composite methods (issue #77) ─────────────────────────────
 *
 * G4, CBS-QB3 and their relatives are *route keywords*, not method/basis
 * pairs. Gaussian expands `#p CBS-QB3` into its documented sequence of
 * geometry, frequency and single-point links; writing `CBS-QB3/6-31G(d)`
 * (or appending `Opt`) is not the same job. The metadata below is the single
 * source of truth for which keywords are accepted, how they are written and
 * which summary label Gaussian prints for them.
 *
 * Only methods whose keyword and summary block are documented by Gaussian 16
 * are listed. W1/W1U/W1BD are real Gaussian keywords but their summary output
 * has not been verified here, so they are refused rather than guessed at.
 */

export const COMPOSITE_METHODS = Object.freeze([
  {
    id: 'CBS-4M',
    keyword: 'CBS-4M',
    labels: Object.freeze(['CBS-4M']),
    note: 'CBS-4M fixes its own basis sequence (first- and second-row elements).',
  },
  {
    id: 'CBS-QB3',
    keyword: 'CBS-QB3',
    labels: Object.freeze(['CBS-QB3']),
    note: 'CBS-QB3 fixes its own basis sequence (first- and second-row elements).',
  },
  {
    id: 'CBS-APNO',
    keyword: 'CBS-APNO',
    labels: Object.freeze(['CBS-APNO']),
    note: 'CBS-APNO fixes its own basis sequence (first-row elements only).',
  },
  { id: 'G1', keyword: 'G1', labels: Object.freeze(['G1']), note: 'G1 fixes its own basis sequence.' },
  { id: 'G2', keyword: 'G2', labels: Object.freeze(['G2']), note: 'G2 fixes its own basis sequence.' },
  { id: 'G3', keyword: 'G3', labels: Object.freeze(['G3']), note: 'G3 fixes its own basis sequence.' },
  { id: 'G4', keyword: 'G4', labels: Object.freeze(['G4']), note: 'G4 fixes its own basis sequence.' },
  {
    id: 'G4(MP2)',
    keyword: 'G4MP2',
    // The route keyword is G4MP2; Gaussian prints the method as G4(MP2) in
    // some summaries and as G4MP2 in others, so both labels are accepted.
    labels: Object.freeze(['G4(MP2)', 'G4MP2']),
    note: 'G4(MP2) is written as the G4MP2 route keyword and fixes its own basis sequence.',
  },
]);

export const COMPOSITE_JOB_TYPES = Object.freeze(COMPOSITE_METHODS.map((method) => method.id));

function compositeKey(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

const COMPOSITE_BY_KEY = new Map();
for (const method of COMPOSITE_METHODS) {
  COMPOSITE_BY_KEY.set(compositeKey(method.id), method);
  COMPOSITE_BY_KEY.set(compositeKey(method.keyword), method);
  for (const label of method.labels) COMPOSITE_BY_KEY.set(compositeKey(label), method);
}

/** The composite definition a job type names, or `null` for an ordinary job. */
export function compositeMethodFor(jobType) {
  return COMPOSITE_BY_KEY.get(compositeKey(jobType)) || null;
}

/** True when the job type is one of the first-class composite methods. */
export function isCompositeJobType(jobType) {
  return COMPOSITE_JOB_TYPES.includes(String(jobType ?? '').trim());
}

/**
 * Settings that compose a normal method/basis route. A composite method owns
 * its own sequence, so any of these that is set on a composite block is a
 * conflict: emitting it would change or invalidate the recipe, and dropping it
 * would silently run a job the user did not ask for. Shared by the input
 * builder (which throws) and the method/basis validity check (which fails).
 */
export function compositeSettingConflicts(settings = {}) {
  const text = (value) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  const conflicts = [];
  const method = text(settings.method);
  if (method) conflicts.push(`method "${method}"`);
  const basis = text(settings.basis);
  if (basis) conflicts.push(`basis "${basis}"`);
  if (text(settings.dispersion)) conflicts.push(`dispersion "${text(settings.dispersion)}"`);
  if (settings.solvation) conflicts.push('solvation');
  if (Number(settings.tdStates) > 0) conflicts.push('TD excited states');
  if (text(settings.population)) conflicts.push(`population "${text(settings.population)}"`);
  if (text(settings.customKeywords)) conflicts.push('extra route keywords');
  if (settings.orbitals === true) conflicts.push('frontier-orbital descriptors');
  if (settings.raman === true) conflicts.push('Raman activities');
  if (settings.stableOpt === true) conflicts.push('Stable=Opt');
  if (text(settings.optConvergence)) conflicts.push(`Opt=${text(settings.optConvergence)}`);
  if (counterpoiseCount(settings) !== 0) conflicts.push('Counterpoise');
  return conflicts;
}

/**
 * Composite keywords Gaussian 16 documents but this build does not yet write
 * a summary parser for. Recognising them in the method field lets the app
 * refuse with a reason instead of emitting `W1/6-31G(d)`.
 */
const UNSUPPORTED_COMPOSITE_NAMES = Object.freeze([
  'W1', 'W1U', 'W1BD',
  'G2(MP2)', 'G2MP2', 'G3(MP2)', 'G3MP2', 'G3(B3LYP)', 'G3B3', 'G3(MP2)B3LYP', 'G3MP2B3',
]);

const COMPOSITE_NAME_KEYS = new Set([
  ...COMPOSITE_BY_KEY.keys(),
  ...UNSUPPORTED_COMPOSITE_NAMES.map(compositeKey),
]);

/**
 * True when a *method field* names a composite method. That is the old
 * free-text workaround: it would produce `G4/6-31G(d)`, which Gaussian
 * refuses because a composite keyword takes no basis. The input builder and
 * the method/basis check both use this to refuse it and point at the job type.
 */
export function isCompositeMethodName(method) {
  return COMPOSITE_NAME_KEYS.has(compositeKey(method));
}

/* ── Counterpoise / BSSE (issue #77) ───────────────────────────
 *
 * Gaussian's documented `Counterpoise=N` block prints
 *
 *   Counterpoise corrected energy =    -622.483714884838
 *                    BSSE energy =       0.005664641553
 *               sum of fragments =    -622.333463706103
 *            complexation energy =     -97.84 kcal/mole (raw)
 *            complexation energy =     -94.28 kcal/mole (corrected)
 *
 * The corrected complex energy is the complex in the full dimer basis; the
 * "sum of fragments" is the monomers in that same basis. BSSE is the printed
 * `BSSE energy`, which is also `E(complex, raw) - E(complex, corrected)`;
 * it is *not* `corrected complex - sum of fragments` (that difference is the
 * corrected interaction energy). Individual monomer energies and monomer
 * deformation terms are not in this block, so they are not reported as if
 * they were.
 */

/** CODATA-2018 hartree to kcal/mol, the factor Gaussian prints against. */
export const HARTREE_TO_KCAL_PER_MOL = 627.5094740631;

export const COUNTERPOISE_MAX_FRAGMENTS = 10;

/**
 * The requested fragment count, `0` when counterpoise is off, or `null` when
 * the stored value is not a usable count. `null` is refused, never treated as
 * "off": silently dropping a requested correction is the bug this guards.
 */
export function counterpoiseCount(settings = {}) {
  const raw = settings?.counterpoise;
  if (raw === undefined || raw === null || raw === '' || raw === 0 || raw === '0' || raw === false) return 0;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 2 || count > COUNTERPOISE_MAX_FRAGMENTS) return null;
  return count;
}

/**
 * Fragment labels a counterpoise input needs. Returns human-readable issues;
 * an empty list means the molecule can be written as a Counterpoise=N input.
 * Both the input builder (which throws) and the pre-run validity check use
 * this, so the file and the finding cannot disagree.
 */
export function counterpoiseFragmentIssues({ settings = {}, molecule = {} } = {}) {
  const count = counterpoiseCount(settings);
  if (count === 0) return [];
  if (count === null) {
    return [`Counterpoise must be an integer between 2 and ${COUNTERPOISE_MAX_FRAGMENTS}, or off.`];
  }
  const issues = [];
  const atoms = Array.isArray(molecule.coords) ? molecule.coords : [];
  if (atoms.length === 0) {
    issues.push(`Counterpoise=${count} needs a geometry with fragment labels on every atom.`);
    return issues;
  }
  if (Array.isArray(molecule.fragments) && molecule.fragments.length > 0 && molecule.fragments.length !== count) {
    issues.push(`The molecule declares ${molecule.fragments.length} fragment string(s) but Counterpoise=${count}.`);
  }

  const labels = atoms.map((atom) => {
    const value = atom?.fragment;
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= 1 ? number : null;
  });
  const missing = [];
  labels.forEach((label, index) => {
    if (label === null) missing.push(index + 1);
  });
  if (missing.length > 0) {
    issues.push(`Atoms ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` and ${missing.length - 8} more` : ''} have no fragment label; Counterpoise=${count} needs every atom assigned a fragment 1-${count}.`);
  }
  const present = [...new Set(labels.filter((label) => label !== null))].sort((a, b) => a - b);
  const outOfRange = present.filter((label) => label > count);
  if (outOfRange.length > 0) {
    issues.push(`Fragment label(s) ${outOfRange.join(', ')} exceed Counterpoise=${count}.`);
  }
  const expected = Array.from({ length: count }, (_, index) => index + 1);
  if (missing.length === 0 && outOfRange.length === 0 && (present.length !== count || present.some((label, index) => label !== expected[index]))) {
    issues.push(`Fragment labels must run consecutively from 1 to ${count}; found ${present.join(', ') || 'none'}.`);
  }

  const states = Array.isArray(settings.counterpoiseChargeStates) ? settings.counterpoiseChargeStates : [];
  if (states.length > 0) {
    if (states.length !== count) {
      issues.push(`counterpoiseChargeStates has ${states.length} entries but Counterpoise=${count}.`);
    } else {
      const total = states.reduce((sum, state) => sum + (Number.isInteger(state?.charge) ? state.charge : NaN), 0);
      const whole = Number(molecule.charge ?? settings.charge ?? 0);
      if (Number.isFinite(total) && Number.isFinite(whole) && total !== whole) {
        issues.push(`The fragment charges sum to ${total} but the complex charge is ${whole}.`);
      }
      states.forEach((state, index) => {
        if (!Number.isInteger(state?.charge) || !Number.isInteger(state?.multiplicity)) {
          issues.push(`counterpoiseChargeStates[${index}] needs an integer charge and multiplicity.`);
        }
      });
    }
  }
  return issues;
}
