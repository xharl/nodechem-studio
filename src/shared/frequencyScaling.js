/**
 * Harmonic frequency scale factors (issue #350).
 *
 * A computed harmonic frequency is systematically larger than the fundamental
 * it is compared with: the harmonic approximation has no anharmonicity, and the
 * electronic-structure model is finite. Published scale factors correct the
 * *comparison*, not the calculation, so this module is the one place that knows
 * them — and the one place that decides whether one may be applied.
 *
 * The rules, in the order the code enforces them:
 *
 *   1. **A factor needs a source.** Every entry carries the paper or NIST page
 *      it came from, and `lookupScaleFactor()` returns that source with the
 *      number. A pair that is not in the table is *unknown*, never estimated.
 *   2. **`auto` never guesses.** An unknown method/basis pair resolves to
 *      unscaled with a warning that names the pair and the table version.
 *   3. **An imported record is never scaled.** Another program printed those
 *      numbers; they keep their producer's values, and the resolution says so.
 *   4. **Raw values are not touched.** The helpers return scaled copies. The
 *      caller keeps the parsed record exactly as the log printed it.
 *
 * Pure module: no DOM, no Node APIs, no clock, no network.
 *
 * Table provenance
 * ----------------
 * `SCALE_FACTOR_TABLE` is a hand-checked transcription, not a fitted value and
 * not an interpolation. Each entry names either
 *
 *   - Merrick, J. P.; Moran, D.; Radom, L. "An Evaluation of Harmonic
 *     Vibrational Frequency Scale Factors." J. Phys. Chem. A 2007, 111,
 *     11683–11700, Tables 2 and 4 (F1 set, 1066 frequencies), doi:10.1021/jp073974n; or
 *   - the NIST Computational Chemistry Comparison and Benchmark Database
 *     (CCCBDB), SRD 101, Release 22 (May 2022), "Precomputed vibrational
 *     scaling factors", cccbdb.nist.gov/vibscalejustx.asp.
 *
 * The two compilations fit different test sets and can differ in the third
 * decimal (B3LYP/6-31G(d) is 0.9613 in Merrick et al. and 0.960 in CCCBDB).
 * The entry's `source` says which number the table uses; a reader can check it
 * at the cited table. Nothing here is averaged between the two.
 */

/** The table's own version. Bump it when any factor or source changes. */
export const SCALE_FACTOR_TABLE_VERSION = '1.0.0';

/** Sanity bounds for an explicit factor. Harmonic factors are near unity. */
export const MIN_SCALE_FACTOR = 0.5;
export const MAX_SCALE_FACTOR = 1.5;

/** The two settings tokens that are not a number. */
export const UNSCALED = 'unscaled';
export const AUTO = 'auto';

export const MERRICK_2007 = Object.freeze({
  citation: 'Merrick, Moran & Radom, J. Phys. Chem. A 2007, 111, 11683–11700, Tables 2 and 4 (F1 set, 1066 frequencies)',
  doi: '10.1021/jp073974n',
  url: 'doi.org/10.1021/jp073974n',
});

export const CCCBDB_R22 = Object.freeze({
  citation: 'NIST CCCBDB, SRD 101, Release 22 (May 2022), "Precomputed vibrational scaling factors"',
  doi: null,
  url: 'cccbdb.nist.gov/vibscalejustx.asp',
});

/**
 * The table is assembled after the alias maps below: `frequencyScaleKey`
 * canonicalises both sides, and a top-level constant cannot call a `const`
 * declared later without landing in its temporal dead zone.
 */

/** Gaussian's `*` shorthand and Merrick's `(d)` spelling are the same basis. */
const BASIS_ALIASES = Object.freeze([
  ['6-31+g**', '6-31+g(d,p)'],
  ['6-31g**', '6-31g(d,p)'],
  ['6-311+g**', '6-311+g(d,p)'],
  ['6-311g**', '6-311g(d,p)'],
  ['6-31+g*', '6-31+g(d)'],
  ['6-31g*', '6-31g(d)'],
  ['6-311+g*', '6-311+g(d)'],
  ['6-311g*', '6-311g(d)'],
]);

/**
 * Method aliases, keyed by the compact spelling (whitespace and hyphens
 * removed). `B3-LYP` is Merrick's spelling and `B3LYP` Gaussian's; `PBE1PBE` is
 * Gaussian's keyword for PBE0.
 */
const METHOD_ALIASES = Object.freeze(new Map([
  ['hf', 'hf'],
  ['mp2', 'mp2'],
  ['b3lyp', 'b3lyp'],
  ['b3pw91', 'b3pw91'],
  ['pbe0', 'pbe0'],
  ['pbe1pbe', 'pbe0'],
  ['m052x', 'm052x'],
  ['bmk', 'bmk'],
  ['mpw1pw91', 'mpw1pw91'],
  ['ccsdt', 'ccsdt'],
  ['ccsd(t)', 'ccsdt'],
]));

/** Compact a method token without guessing at an unknown functional. */
export function normaliseMethod(value) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '').replace(/-/g, '');
  if (!raw) return '';
  const alias = METHOD_ALIASES.get(raw);
  if (alias) return alias;
  // Gaussian prints `RB3LYP`, `UB3LYP`, `RHF`, `UHF`. Strip one leading R/U only
  // when the remainder is a method the table knows; `ROHF` must not become HF.
  if ((raw.startsWith('r') || raw.startsWith('u')) && METHOD_ALIASES.has(raw.slice(1))) {
    return METHOD_ALIASES.get(raw.slice(1));
  }
  return raw;
}

/** Canonical basis spelling: lower case, no spaces, `*` expanded to `(d)`. */
export function normaliseBasis(value) {
  let raw = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!raw) return '';
  for (const [from, to] of BASIS_ALIASES) {
    if (raw === from) { raw = to; break; }
  }
  return raw;
}

/** `b3lyp/6-31g(d)` — the key both the table and a lookup use. */
export function frequencyScaleKey(method, basis) {
  const m = normaliseMethod(method);
  const b = normaliseBasis(basis);
  return m && b ? `${m}/${b}` : '';
}

/**
 * The table. `method` and `basis` are the spellings a Gaussian route prints;
 * the lookup canonicalises both sides (see `normaliseMethod`/`normaliseBasis`),
 * so `RB3LYP` + `6-31G*` finds the `B3LYP` + `6-31G(d)` row.
 *
 * Not every published pair is here. An absent pair is not a claim that no
 * factor exists — `auto` reports it as not in this table and leaves the values
 * unscaled.
 */
export const SCALE_FACTOR_TABLE = Object.freeze([
  entry('HF', '6-31G(d)', 0.8953, MERRICK_2007),
  entry('HF', '6-311+G(d,p)', 0.9059, MERRICK_2007),
  entry('MP2', '6-31G(d)', 0.9441, MERRICK_2007),
  entry('MP2', '6-31+G(d,p)', 0.9418, MERRICK_2007),
  entry('MP2', '6-311+G(d,p)', 0.9523, MERRICK_2007),
  entry('B3LYP', '6-31G(d)', 0.9613, MERRICK_2007),
  entry('B3LYP', '6-31G(d,p)', 0.9627, MERRICK_2007),
  entry('B3LYP', '6-31+G(d,p)', 0.9648, MERRICK_2007),
  entry('B3LYP', '6-31G(2df,p)', 0.9652, MERRICK_2007),
  entry('B3LYP', '6-311+G(d,p)', 0.9688, MERRICK_2007),
  entry('B3LYP', '6-311+G(2df,p)', 0.9686, MERRICK_2007),
  entry('B3LYP', 'cc-pVTZ', 0.9682, MERRICK_2007),
  // CCCBDB covers the small Pople sets Merrick et al. did not tabulate. These
  // two keep the real STO-3G / 3-21G Gaussian fixtures comparable.
  entry('B3LYP', 'STO-3G', 0.892, CCCBDB_R22),
  entry('B3LYP', '3-21G', 0.965, CCCBDB_R22),
  entry('B3PW91', '6-31G(d)', 0.9571, MERRICK_2007),
  entry('B3PW91', '6-311+G(d,p)', 0.9648, MERRICK_2007),
  entry('PBE0', '6-31G(d)', 0.9512, MERRICK_2007),
  entry('PBE0', '6-311+G(d,p)', 0.9594, MERRICK_2007),
  entry('M05-2X', '6-31G(d)', 0.9373, MERRICK_2007),
  entry('M05-2X', '6-31+G(d,p)', 0.9419, MERRICK_2007),
  entry('BMK', '6-31G(d)', 0.9475, MERRICK_2007),
  entry('BMK', '6-311+G(d,p)', 0.9566, MERRICK_2007),
  entry('mPW1PW91', '6-31G(d)', 0.9499, MERRICK_2007),
  entry('CCSD(T)', '6-31G(d)', 0.9603, MERRICK_2007),
].map((row) => Object.freeze(row)));

function entry(method, basis, factor, source) {
  return {
    method,
    basis,
    factor,
    source: source.citation,
    doi: source.doi,
    url: source.url,
    key: frequencyScaleKey(method, basis),
  };
}

function displayBasis(basis) {
  return String(basis ?? '').trim();
}

/** Every entry, for a report footer or a test that checks the table itself. */
export function scaleFactorTable() {
  return SCALE_FACTOR_TABLE.map((row) => ({ ...row }));
}

/**
 * Look one pair up. Always returns an object; `found` is the answer, not the
 * presence of a number. The caller must not substitute a factor when false.
 */
export function lookupScaleFactor(method, basis) {
  const key = frequencyScaleKey(method, basis);
  const base = {
    found: false,
    key: key || null,
    method: String(method ?? '').trim() || null,
    basis: displayBasis(basis) || null,
    factor: null,
    source: null,
    doi: null,
    url: null,
    tableVersion: SCALE_FACTOR_TABLE_VERSION,
  };
  if (!key) return base;
  const hit = SCALE_FACTOR_TABLE.find((row) => row.key === key);
  return hit ? { ...base, ...hit, found: true } : base;
}

/**
 * `unscaled` | `auto` | a number in [MIN_SCALE_FACTOR, MAX_SCALE_FACTOR].
 * Empty/absent is `unscaled`. Anything else is an error the schema reports;
 * `resolveFrequencyScale` refuses it rather than coercing.
 */
export function parseFrequencyScaleSetting(value) {
  if (value === undefined || value === null) return { mode: UNSCALED, factor: 1, setting: UNSCALED };
  const raw = String(value).trim();
  if (raw === '') return { mode: UNSCALED, factor: 1, setting: UNSCALED };
  const lowered = raw.toLowerCase();
  if (lowered === UNSCALED) return { mode: UNSCALED, factor: 1, setting: UNSCALED };
  if (lowered === AUTO) return { mode: AUTO, factor: null, setting: AUTO };
  const number = Number(raw);
  if (Number.isFinite(number) && number >= MIN_SCALE_FACTOR && number <= MAX_SCALE_FACTOR) {
    return { mode: 'explicit', factor: number, setting: String(number) };
  }
  return {
    mode: 'invalid',
    factor: null,
    setting: raw,
    error: `"${raw}" is not ${UNSCALED}, ${AUTO} or a factor between `
      + `${MIN_SCALE_FACTOR} and ${MAX_SCALE_FACTOR}.`,
  };
}

/** The setting a project should store for a factor, or `null` when invalid. */
export function normaliseFrequencyScaleSetting(value) {
  const parsed = parseFrequencyScaleSetting(value);
  if (parsed.mode === 'invalid') return null;
  if (parsed.mode === AUTO) return AUTO;
  if (parsed.mode === 'explicit') return String(parsed.factor);
  return UNSCALED;
}

function emptyResolution(mode, extra = {}) {
  return {
    mode,
    setting: UNSCALED,
    key: null,
    method: null,
    basis: null,
    factor: 1,
    applied: false,
    source: null,
    doi: null,
    url: null,
    tableVersion: SCALE_FACTOR_TABLE_VERSION,
    warnings: [],
    ...extra,
  };
}

/**
 * Decide what may be applied, and say why.
 *
 * Order matters: an imported record is refused before the setting is even read,
 * because no setting on this machine can make another program's numbers ours.
 * A `null` factor with `applied: false` is the only honest answer to an unknown
 * `auto` pair.
 */
export function resolveFrequencyScale({
  setting = UNSCALED,
  method = null,
  basis = null,
  imported = false,
} = {}) {
  if (imported) {
    return emptyResolution('imported', {
      setting: normaliseFrequencyScaleSetting(setting) ?? String(setting ?? UNSCALED),
      method: String(method ?? '').trim() || null,
      basis: displayBasis(basis) || null,
      warnings: ['Imported record: its numbers are kept exactly as its producer printed them; no scale factor is applied.'],
    });
  }

  const parsed = parseFrequencyScaleSetting(setting);
  if (parsed.mode === 'invalid') {
    return emptyResolution('invalid', {
      setting: parsed.setting,
      method: String(method ?? '').trim() || null,
      basis: displayBasis(basis) || null,
      warnings: [`Frequency scaling: ${parsed.error} The values are shown unscaled.`],
    });
  }
  if (parsed.mode === UNSCALED) {
    return emptyResolution(UNSCALED, {
      setting: UNSCALED,
      method: String(method ?? '').trim() || null,
      basis: displayBasis(basis) || null,
    });
  }
  if (parsed.mode === 'explicit') {
    const key = frequencyScaleKey(method, basis);
    return emptyResolution('explicit', {
      setting: parsed.setting,
      key: key || null,
      method: String(method ?? '').trim() || null,
      basis: displayBasis(basis) || null,
      factor: parsed.factor,
      applied: parsed.factor !== 1,
      source: 'explicit factor set on the block (not a table entry; no citation applies)',
      warnings: [],
    });
  }

  // auto
  const lookup = lookupScaleFactor(method, basis);
  const methodText = lookup.method || 'an unnamed method';
  const basisText = lookup.basis || 'an unnamed basis';
  if (!lookup.found) {
    return emptyResolution('unknown', {
      setting: AUTO,
      key: lookup.key,
      method: lookup.method,
      basis: lookup.basis,
      warnings: [
        `Frequency scaling: no published factor for ${methodText}/${basisText} in table `
        + `${SCALE_FACTOR_TABLE_VERSION}; the values are shown unscaled rather than guessed.`,
      ],
    });
  }
  return emptyResolution(AUTO, {
    setting: AUTO,
    key: lookup.key,
    method: lookup.method,
    basis: lookup.basis,
    factor: lookup.factor,
    applied: lookup.factor !== 1,
    source: lookup.source,
    doi: lookup.doi,
    url: lookup.url,
  });
}

/** `×0.9613` / `unscaled` / `unscaled — no factor for X/Y` for a card. */
export function describeFrequencyScale(resolution) {
  if (!resolution) return UNSCALED;
  if (resolution.applied) {
    const source = resolution.source ? ` — ${resolution.source}` : '';
    return `×${Number(resolution.factor).toFixed(4)}${source}`;
  }
  if (resolution.mode === 'imported') return 'not applied — imported record';
  if (resolution.mode === 'unknown') {
    const pair = resolution.method && resolution.basis
      ? `${resolution.method}/${resolution.basis}`
      : (resolution.key || 'unknown level of theory');
    return `unscaled — no factor for ${pair}`;
  }
  if (resolution.mode === 'invalid') return 'unscaled — invalid setting';
  return UNSCALED;
}

/**
 * A mode list with both numbers. `wavenumber` is the scaled value (what a
 * spectrum plots); `wavenumberRaw` is the parsed value, unchanged. The input
 * objects are copied, never mutated, so a record keeps its raw modes.
 */
export function scaledModeTable(modes, resolution) {
  const list = Array.isArray(modes) ? modes : [];
  const factor = resolution?.applied ? Number(resolution.factor) : 1;
  return list.map((mode) => {
    if (!mode || typeof mode !== 'object') return mode;
    const raw = Number(mode.wavenumber);
    if (!Number.isFinite(raw)) return { ...mode };
    return {
      ...mode,
      wavenumberRaw: raw,
      wavenumber: raw * factor,
    };
  });
}

/** One wavenumber, scaled when the resolution applied a factor. */
export function scaledWavenumber(value, resolution) {
  const number = Number(value);
  if (!Number.isFinite(number)) return number;
  return resolution?.applied ? number * Number(resolution.factor) : number;
}

/**
 * A zero-point correction is linear in the frequencies (ZPE = ½Σhν), so the
 * derived value is the printed one times the factor. The printed one is kept
 * beside it; nothing is overwritten.
 */
export function scaleZeroPoint(rawHartree, resolution) {
  const raw = Number(rawHartree);
  const usable = Number.isFinite(raw) ? raw : null;
  const factor = resolution?.applied ? Number(resolution.factor) : 1;
  return {
    rawHartree: usable,
    scaledHartree: usable === null ? null : usable * factor,
    factor,
    applied: resolution?.applied === true && usable !== null,
    source: resolution?.source ?? null,
    doi: resolution?.doi ?? null,
    url: resolution?.url ?? null,
    tableVersion: resolution?.tableVersion ?? SCALE_FACTOR_TABLE_VERSION,
    mode: resolution?.mode ?? UNSCALED,
    key: resolution?.key ?? null,
  };
}

/** The compact block a `run.json` provenance carries. No arrays, no raw data. */
export function frequencyScaleProvenance(resolution) {
  if (!resolution) return null;
  return {
    mode: resolution.mode,
    setting: resolution.setting,
    factor: Number.isFinite(resolution.factor) ? resolution.factor : null,
    applied: Boolean(resolution.applied),
    key: resolution.key ?? null,
    tableVersion: resolution.tableVersion,
    source: resolution.source ?? null,
    doi: resolution.doi ?? null,
    url: resolution.url ?? null,
    warnings: Array.isArray(resolution.warnings) ? resolution.warnings.slice(0, 4) : [],
  };
}

/**
 * The method/basis pair in a Gaussian route, for a parsed log that has no
 * `provenance.method`. ONIOM's model layer is the one that produced the
 * frequencies, so `oniom(B3LYP/6-31G(d):PM6)` reports B3LYP/6-31G(d).
 * A composite keyword (`CBS-QB3`) carries no pair and returns nulls.
 */
export function methodBasisFromRoute(route) {
  const text = String(route ?? '').trim();
  if (!text) return { method: null, basis: null, key: null };
  const oniom = text.match(/oniom\s*\(\s*([^:]+?)\s*:\s*([^)]+)\)/i);
  // The model layer is everything before the first colon — it may itself carry
  // parentheses (`B3LYP/6-31G(d)`), so the capture cannot exclude them.
  const pair = oniom ? oniom[1].trim() : null;
  const source = pair ?? text;
  const match = source.match(/\b([a-z][a-z0-9().\-]*)\s*\/\s*([a-z0-9][a-z0-9().+*,\-]*)/i);
  if (!match) return { method: null, basis: null, key: null };
  const method = match[1];
  const basis = match[2];
  return { method, basis, key: frequencyScaleKey(method, basis) || null };
}
