/**
 * Multiwfn sidecar: definitions, batch menu recipes, output normalisation and
 * the QTAIM comparison (issue #270).
 *
 * ## What this module is, and is not
 *
 * Multiwfn is a separate, user-installed program. NodeChem Studio never bundles
 * it and never drives its GUI: this module writes the deterministic stdin menu
 * script for `Multiwfn <wavefunction> -silent`, parses the text Multiwfn prints,
 * and normalises it to a stable JSON shape. The runner that spawns the binary
 * lives in `electron/runner/multiwfnRunner.js`; everything here is pure and can
 * be tested from a transcript.
 *
 * The menu numbers are pinned to **Multiwfn 3.8**. They are transcribed from the
 * 3.8 manual examples (topology analysis, basin analysis, quantitative molecular
 * surface, grid data export, NCI). A different Multiwfn release renumbers its
 * menus; `multiwfnVersionRefusal()` refuses a version outside the pinned band
 * rather than guessing that the numbers still mean the same thing.
 *
 * ## Licence
 *
 * Multiwfn is free for academic and non-profit use with citation; commercial use
 * needs the author's permission. The citation Multiwfn requires is
 *
 *   Tian Lu, Feiwu Chen, J. Comput. Chem. 2012, 33, 580–592.
 *
 * and it travels with every result this module produces.
 *
 * ## What a transcript test does and does not prove
 *
 * The committed transcripts under `test/fixtures/multiwfn/` are **synthetic**:
 * they are copied into Multiwfn's printed layout to exercise the parser. No
 * number in them was produced by Multiwfn, and no test here claims that a real
 * Multiwfn run agrees with the in-app analysis. That comparison needs the user's
 * binary and a real wavefunction; `compareQtaimToApp()` is the code that will
 * make it when it runs, and the guide says exactly which part is unvalidated.
 */

import { parseCube } from './cubeFile.js';

/** The oldest release whose menus this build still writes. Kept for the UI. */
export const MULTIWFN_SUPPORTED_VERSION = '3.8';

/** The version recorded with every menu script when no band is named. */
export const MULTIWFN_MENU_VERSION = '2024+';

/** The 2012 paper every Multiwfn release requires. */
export const MULTIWFN_CITATION_2012 = 'Tian Lu, Feiwu Chen, J. Comput. Chem. 2012, 33, 580-592. '
  + 'doi:10.1002/jcc.22885';

/** The 2024 paper every 2024-and-later binary also requires (issue #342). */
export const MULTIWFN_CITATION_2024 = 'Tian Lu, J. Chem. Phys. 2024, 161, 082503. '
  + 'doi:10.1063/5.0216272';

/**
 * The citation Multiwfn requires by default. Every supported release band is
 * `2024+`, whose own banner says both papers must be cited; the 2012-only form
 * belongs to the retired 3.8 band and is selected by `multiwfnCitationFor()`.
 */
export const MULTIWFN_CITATION = `${MULTIWFN_CITATION_2012}; ${MULTIWFN_CITATION_2024}`;

/** The vendor's wording, printed beside the citation (issue #342). */
export const MULTIWFN_CITATION_NOTE = 'Both papers must be cited in the main text when Multiwfn 2024 '
  + 'or later is used.';

/**
 * The citation a banner version requires (issue #342). A 3.x banner is the
 * 3.8 band and predates the 2024 paper; anything else is a 2024+ release, whose
 * banner asks for both papers. Unknown or empty input returns both: the menu
 * band this build writes is `2024+`, so under-citing is the failure that
 * matters.
 */
export function multiwfnCitationFor(versionOrBand = MULTIWFN_MENU_VERSION) {
  const token = String(versionOrBand ?? '').trim();
  if (token === '3.8' || /^3\./.test(token)) return MULTIWFN_CITATION_2012;
  return MULTIWFN_CITATION;
}

/** The licence statement a user sees before running the sidecar. */
export const MULTIWFN_LICENCE = 'Multiwfn is free for academic and non-profit use with citation; '
  + 'commercial use requires the author\'s permission. It is user-installed and is not bundled '
  + 'with NodeChem Studio.';

/** Binary names looked for on PATH when no path is configured. */
export const MULTIWFN_BINARY_NAMES = Object.freeze(['Multiwfn', 'multiwfn']);

/** File extensions Multiwfn can read as a wavefunction in this sidecar. */
export const MULTIWFN_WAVEFUNCTION_FORMATS = Object.freeze(['wfn', 'wfx', 'fchk', 'molden']);

/**
 * Wavefunction files whose name the extension rule would miss (issue 343).
 *
 * xTB writes `molden.input`. `input` is not a Multiwfn format, and accepting a
 * bare `.input` extension would also claim unrelated files — an xTB deck is not
 * called `.input`, but a job folder can hold `request.input`, `notes.input` or a
 * third-party input file. So the whole basename is matched, and only this one.
 */
export const MULTIWFN_WAVEFUNCTION_FILENAMES = Object.freeze(['molden.input']);

/** File extensions accepted as an input, per analysis. */
export const MULTIWFN_INPUT_FORMATS = Object.freeze({
  qtaim: Object.freeze(['wfn', 'wfx', 'fchk', 'molden']),
  esp: Object.freeze(['wfn', 'wfx', 'fchk', 'molden', 'cube']),
  elf: Object.freeze(['wfn', 'wfx', 'fchk', 'molden']),
  lol: Object.freeze(['wfn', 'wfx', 'fchk', 'molden']),
  rdg: Object.freeze(['wfn', 'wfx', 'fchk', 'molden']),
});

/** Every extension any analysis reads, for name→format detection. */
const MULTIWFN_INPUT_EXTENSIONS = Object.freeze(
  [...new Set(Object.values(MULTIWFN_INPUT_FORMATS).flat())],
);

/**
 * The Multiwfn format a file name names, or `''` when it is not one this build
 * reads. `molden.input` is matched by its whole basename; every other file by
 * its extension (issue 343).
 */
export function multiwfnInputFormat(name) {
  // A project-relative `input.path` arrives with its folders; only the basename
  // decides the format.
  const base = String(name ?? '').trim().split(/[\\/]/).pop().toLowerCase();
  if (MULTIWFN_WAVEFUNCTION_FILENAMES.includes(base)) return 'molden';
  const extension = multiwfnExtension(base);
  return MULTIWFN_INPUT_EXTENSIONS.includes(extension) ? extension : '';
}

/**
 * Where a Multiwfn input comes from, per engine (issue 343).
 *
 * A refusal that only names the formats leaves a user asking which block could
 * have produced one, so this table is the single place the queue, the guide and
 * the tests read. `file: null` is an engine whose own artifact Multiwfn cannot
 * read: it is named rather than omitted, because otherwise the user tries it.
 */
export const MULTIWFN_ENGINE_SOURCES = Object.freeze([
  Object.freeze({
    engine: 'Psi4',
    file: '<job>.fchk',
    detail: 'every job type — SP, Opt, Freq, Opt Freq and TD-DFT; not SAPT0, which has no single wavefunction',
  }),
  Object.freeze({
    engine: 'xTB',
    file: 'molden.input',
    detail: 'every GFN job, because the argv carries --molden; GFN-FF has no orbitals',
  }),
  Object.freeze({
    engine: 'Gaussian',
    file: '<job>.fchk',
    detail: 'after `formchk -3` on the .chk the run leaves',
  }),
  Object.freeze({
    engine: 'ORCA',
    file: null,
    detail: 'writes only a .gbw, which Multiwfn cannot read',
  }),
]);

/** The engines-that-can-satisfy-it sentence a refusal appends (issue 343). */
export function multiwfnEngineSourcesSentence() {
  const writers = MULTIWFN_ENGINE_SOURCES
    .filter((entry) => entry.file)
    .map((entry) => `${entry.engine} (${entry.file}: ${entry.detail})`);
  const readers = MULTIWFN_ENGINE_SOURCES
    .filter((entry) => !entry.file)
    .map((entry) => `${entry.engine} ${entry.detail}`);
  return `A wavefunction file is written by ${writers.join(', ')}, or name one with input.path. `
    + `${readers.join('; ')}.`;
}

/**
 * The five analyses v1 implements. Each declares the formats it can read, the
 * parameters it understands and the normalised keys it writes, so the schema,
 * the inspector and the parser cannot disagree about what an analysis is.
 */
export const MULTIWFN_ANALYSES = Object.freeze([
  Object.freeze({
    id: 'qtaim',
    label: 'QTAIM basin integration',
    short: 'QTAIM',
    inputs: MULTIWFN_INPUT_FORMATS.qtaim,
    parameters: Object.freeze({
      grid: Object.freeze({
        type: 'integer', min: 1, max: 4, default: 2,
        label: 'Basin grid quality',
        help: 'Multiwfn basin grid: 1 low, 2 medium, 3 high, 4 lunatic. Higher is slower and more accurate.',
      }),
    }),
    outputs: Object.freeze(['basins', 'atomicCharges', 'criticalPoints', 'comparison']),
    summary: 'basin populations, atomic charges and critical points',
  }),
  Object.freeze({
    id: 'esp',
    label: 'ESP surface statistics',
    short: 'ESP',
    inputs: MULTIWFN_INPUT_FORMATS.esp,
    parameters: Object.freeze({
      // Issue 339: the surface tessellation is chosen *inside* Multiwfn's own
      // post-processing menu; there is no menu answer that carries a grid, so a
      // `grid` field here would be a parameter the record claims and the binary
      // never receives. It is gone rather than decorative.
      isovalue: Object.freeze({
        type: 'number', min: 1e-6, max: 1, default: 0.001,
        label: 'Density isovalue / a.u.',
        help: 'Electron-density isovalue that defines the molecular surface (0.001 a.u. is the gas-phase vdW surface).',
      }),
    }),
    outputs: Object.freeze(['volume', 'surfaceArea', 'potential']),
    summary: 'surface area, enclosed volume and ESP extrema/averages',
  }),
  Object.freeze({
    id: 'elf',
    label: 'ELF cube',
    short: 'ELF',
    inputs: MULTIWFN_INPUT_FORMATS.elf,
    parameters: Object.freeze({
      grid: Object.freeze({
        type: 'integer', min: 20, max: 240, default: 80,
        label: 'Cube grid points per axis',
        help: 'Grid points per axis for the exported cube.',
      }),
    }),
    outputs: Object.freeze(['cube', 'summary']),
    summary: 'an ELF cube and its value range',
  }),
  Object.freeze({
    id: 'lol',
    label: 'LOL cube',
    short: 'LOL',
    inputs: MULTIWFN_INPUT_FORMATS.lol,
    parameters: Object.freeze({
      grid: Object.freeze({
        type: 'integer', min: 20, max: 240, default: 80,
        label: 'Cube grid points per axis',
        help: 'Grid points per axis for the exported cube.',
      }),
    }),
    outputs: Object.freeze(['cube', 'summary']),
    summary: 'a LOL cube and its value range',
  }),
  Object.freeze({
    id: 'rdg',
    label: 'RDG-NCI points',
    short: 'RDG-NCI',
    inputs: MULTIWFN_INPUT_FORMATS.rdg,
    parameters: Object.freeze({
      grid: Object.freeze({
        type: 'integer', min: 1, max: 4, default: 2,
        label: 'NCI grid quality',
        help: 'Multiwfn NCI grid: 1 low, 2 medium, 3 high, 4 very high.',
      }),
      isovalue: Object.freeze({
        type: 'number', min: 0.01, max: 5, default: 0.5,
        label: 'RDG threshold',
        help: 'The s value the record counts as “below the isovalue” and a plot draws the surface at. '
          + 'Multiwfn writes every scatter point; this threshold is applied when the points are read, not by the binary.',
      }),
      // Issue 339: a density cutoff was stored and never applied — the scatter
      // file carries no rho column of its own, only sign(lambda2)rho — so it is
      // gone rather than a parameter the record claims and nothing uses.
    }),
    outputs: Object.freeze(['points', 'summary']),
    summary: 'NCI points in the sign(lambda2)rho / RDG plane',
  }),
]);

const ANALYSIS_BY_ID = new Map(MULTIWFN_ANALYSES.map((analysis) => [analysis.id, analysis]));

/** A named refusal from the Multiwfn sidecar. */
export class MultiwfnError extends Error {
  constructor(message, code = 'multiwfn') {
    super(message);
    this.name = 'MultiwfnError';
    this.code = code;
  }
}

/** The analysis definition, or null when the id is not one v1 implements. */
export function multiwfnAnalysis(id) {
  return ANALYSIS_BY_ID.get(String(id ?? '')) || null;
}

/** Every analysis id, in the order the inspector lists them. */
export function multiwfnAnalysisIds() {
  return MULTIWFN_ANALYSES.map((analysis) => analysis.id);
}

/** The formats an analysis reads, or `[]` for an unknown analysis. */
export function multiwfnInputFormats(analysis) {
  return multiwfnAnalysis(analysis)?.inputs || [];
}

/** `file.fchk` → `fchk`; an empty string when the name has no extension. */
export function multiwfnExtension(name) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name ?? '').trim());
  return match ? match[1].toLowerCase() : '';
}

/**
 * The menu-number bands this build knows (issue 341).
 *
 * Multiwfn's top-level menus have been stable for years, but the submenus behind
 * them changed between 3.8 and the 2024+ releases: the CP-export submenu, the ESP
 * post-processing menu and the NCI scatter menu all moved. A single pin to 3.8
 * made the feature unreachable, because 3.8 is archive-only and the download page
 * installs a 2026 release. So the scripts are kept per band, and a version
 * outside every band is refused by name.
 */
export const MULTIWFN_BANDS = Object.freeze([
  Object.freeze({
    id: '3.8',
    label: 'Multiwfn 3.8',
    matches: (version) => /^3\.8(?:\D|$)/.test(String(version ?? '').trim()),
  }),
  Object.freeze({
    id: '2024+',
    label: 'Multiwfn 2024 or later',
    matches: (version) => {
      const match = /^((?:19|20)\d\d)\./.exec(String(version ?? '').trim());
      return Boolean(match) && Number(match[1]) >= 2024;
    },
  }),
]);

/** The band a banner names, or null when no band claims it. */
export function multiwfnBandFor(version) {
  const text = String(version ?? '').trim();
  if (!text) return null;
  return MULTIWFN_BANDS.find((band) => band.matches(text)) || null;
}

/**
 * Is this Multiwfn version inside a band whose menus this build writes?
 *
 * Accepted: `3.8`, `3.8(dev)`, `3.8.1`, and any `YYYY.n` release from 2024 on
 * (`2026.11.3`). A banner that could not be read is its own refusal, because
 * "unknown version" is not permission to use any menu numbers.
 */
export function multiwfnVersionRefusal(version) {
  const text = String(version ?? '').trim();
  if (!text) {
    return 'The Multiwfn version could not be read from its banner, so no menu script is guessed. '
      + `Known menu bands: ${MULTIWFN_BANDS.map((band) => band.label).join(', ')}.`;
  }
  if (multiwfnBandFor(text)) return null;
  return `Multiwfn ${text} is not in a menu band this build writes `
    + `(${MULTIWFN_BANDS.map((band) => band.label).join(', ')}). Multiwfn's download page installs a `
    + 'current release; 3.8 is archive-only, so "install 3.8" is not an instruction this app can give. '
    + 'Install a 2024-or-later build, or add a version-pinned recipe for this release.';
}

/** Is this version string inside the pinned band? */
export function isMultiwfnVersionSupported(version) {
  return multiwfnVersionRefusal(version) === null;
}

/**
 * Validate one `analyse.multiwfn` definition.
 *
 * Returns every error with a path relative to the definition, and a normalised
 * value that only carries the keys this build reads. A missing input, an
 * unknown analysis, an unsupported format and an out-of-range parameter are all
 * refused by name; nothing is defaulted into a guess.
 */
export function validateMultiwfnDefinition(raw) {
  const errors = [];
  const value = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      errors: [{ path: '', message: 'must be an object with an analysis and an input.' }],
      value: null,
      analysis: null,
    };
  }
  const analysis = multiwfnAnalysis(raw.analysis);
  if (!raw.analysis) {
    errors.push({ path: 'analysis', message: 'is required: one of "qtaim", "esp", "elf", "lol" or "rdg".' });
  } else if (!analysis) {
    errors.push({
      path: 'analysis',
      message: `"${String(raw.analysis)}" is not a supported Multiwfn analysis; this build implements `
        + `${multiwfnAnalysisIds().map((id) => `"${id}"`).join(', ')}.`,
    });
  }
  if (analysis) value.analysis = analysis.id;

  const input = raw.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    errors.push({
      path: 'input',
      message: 'is required: name the upstream block (input.nodeId) whose run record carries the '
        + 'wavefunction, a run id (input.runId), or a path (input.path).',
    });
  } else {
    const given = ['runId', 'nodeId', 'path'].filter((key) => input[key] !== undefined
      && input[key] !== null && String(input[key]).trim() !== '');
    if (given.length === 0) {
      errors.push({
        path: 'input',
        message: 'names no source: set exactly one of runId, nodeId or path.',
      });
    } else if (given.length > 1) {
      errors.push({
        path: 'input',
        message: `names ${given.length} sources (${given.join(', ')}); set exactly one of runId, nodeId or path.`,
      });
    } else {
      const key = given[0];
      const text = String(input[key]).trim();
      if (key === 'path') {
        const problem = relativeInputPathProblem(text);
        if (problem) errors.push({ path: 'input.path', message: problem });
        const format = multiwfnInputFormat(text);
        if (!problem && analysis && !analysis.inputs.includes(format)) {
          const extension = multiwfnExtension(text);
          errors.push({
            path: 'input.path',
            message: `${analysis.label} reads ${analysis.inputs.map((entry) => `.${entry}`).join(', ')}; `
              + `"${text}" is ${extension ? `a .${extension} file` : 'a file with no extension'}.`,
          });
        }
        value.input = { path: text };
      } else {
        if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/.test(text)) {
          errors.push({ path: `input.${key}`, message: `"${text}" is not a safe block or run id.` });
        }
        value.input = { [key]: text };
      }
    }
  }

  if (analysis) {
    for (const [key, spec] of Object.entries(analysis.parameters)) {
      const rawValue = raw[key];
      if (rawValue === undefined || rawValue === null || rawValue === '') {
        value[key] = spec.default;
        continue;
      }
      const parsed = Number(rawValue);
      if (!Number.isFinite(parsed)) {
        errors.push({ path: key, message: `must be a number, not "${String(rawValue)}".` });
        continue;
      }
      if (spec.type === 'integer' && !Number.isInteger(parsed)) {
        errors.push({ path: key, message: 'must be a whole number.' });
        continue;
      }
      if (parsed < spec.min || parsed > spec.max) {
        errors.push({
          path: key,
          message: `must be between ${spec.min} and ${spec.max}${key === 'grid' && analysis.id === 'qtaim'
            ? ' (1 low, 2 medium, 3 high, 4 lunatic)' : ''}.`,
        });
        continue;
      }
      value[key] = parsed;
    }
    // A parameter that belongs to another analysis is dropped rather than
    // refused: the file may have been written by a newer build that adds one.
    // The previous iteration's parameter is reset above when the analysis
    // changes, and the saved value carries only what this build reads.
  }
  return { errors, value: errors.length ? null : value, analysis };
}

/** A relative path that stays inside the project folder, or a reason it does not. */
export function relativeInputPathProblem(text) {
  const value = String(text ?? '').trim();
  if (!value) return 'must name a file.';
  if (/^([A-Za-z]:[\\/]|[\\/])/.test(value)) {
    return 'must be relative to the project folder; an absolute path would not travel with the project.';
  }
  const segments = value.split(/[\\/]+/);
  if (segments.includes('..')) return 'must not contain ".."; the input has to stay inside the project folder.';
  if (!/^[A-Za-z0-9._\-/\\]+$/.test(value)) {
    return 'contains a character this build does not allow in a project-relative path.';
  }
  return null;
}

/** The payload the queue accepts for one Multiwfn analyse task. */
export function normalizeMultiwfnTask(raw, { path = 'multiwfn' } = {}) {
  const checked = validateMultiwfnDefinition(raw);
  if (checked.errors.length > 0) {
    const first = checked.errors[0];
    throw new MultiwfnError(`"${path}${first.path ? `.${first.path}` : ''}" ${first.message}`, 'multiwfn-schema');
  }
  return checked.value;
}

/* ── menu scripts ─────────────────────────────────────────────────── */

/** A deterministic menu number: no exponent, no trailing zeros. */
function menuNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new MultiwfnError('A menu parameter is not a finite number.');
  return String(Number(number.toPrecision(12)));
}

/**
 * The exact stdin script for one analysis.
 *
 * The script is a list of menu answers, one per line, in the order Multiwfn
 * prompts for them. `-silent` is a command-line argument, not a line. Which
 * numbers are right depends on the release band (issue 341): the `2024+` scripts
 * below were run against Multiwfn 2026.11.3 — the release the vendor's download
 * page installs — and the `3.8` scripts are the ones transcribed from the 3.8
 * manual (issue 339). Each line is documented in `steps`.
 */
export function multiwfnMenuScript(analysisId, parameters = {}, { band = MULTIWFN_MENU_VERSION } = {}) {
  const analysis = multiwfnAnalysis(analysisId);
  if (!analysis) {
    throw new MultiwfnError(`"${String(analysisId)}" is not a supported Multiwfn analysis.`, 'multiwfn-analysis');
  }
  if (!MULTIWFN_BANDS.some((entry) => entry.id === band)) {
    throw new MultiwfnError(`"${String(band)}" is not a Multiwfn menu band this build writes.`, 'multiwfn-band');
  }
  const grid = Number(parameters.grid ?? analysis.parameters.grid?.default ?? 80);
  const isovalue = Number(parameters.isovalue ?? analysis.parameters.isovalue?.default ?? 0.001);
  const legacy = band === '3.8';
  let steps;
  if (analysis.id === 'qtaim') {
    steps = legacy
      ? [
        ['2', 'Topology analysis'],
        ['2', 'Search critical points from nuclear positions'],
        ['3', 'Search critical points from midpoints of atom pairs'],
        ['-4', 'Modify or export critical points'],
        ['-1', 'Print summary of critical points in Angstrom'],
        ['7', 'Show real-space function values at all critical points'],
        ['0', 'Write CPprop.txt for all critical points'],
        ['-10', 'Return to the main menu'],
        ['17', 'Basin analysis'],
        ['1', 'Generate basins and locate attractors'],
        ['1', 'Electron density'],
        [String(grid), `Grid quality ${grid} (1 low, 2 medium, 3 high, 4 lunatic)`],
        ['7', 'Integrate real-space functions in AIM basins with mixed grids'],
        ['2', 'Integrate and refine the basin boundary'],
        ['1', 'Electron density'],
        ['-10', 'Return to the main menu'],
        ['q', 'Exit'],
      ]
      // Issue 339: the CP properties are written by topology option 7 (show
      // function values at all CPs) followed by -1 (skip the expensive ESP
      // property); the -4 export submenu has no 7 and wrote nothing at all.
      : [
        ['2', 'Topology analysis'],
        ['2', 'Search critical points from nuclear positions'],
        ['3', 'Search critical points from midpoints of atom pairs'],
        ['7', 'Show real-space function values at all critical points'],
        ['-1', 'All critical points, skipping the ESP property'],
        ['-10', 'Return to the main menu'],
        ['17', 'Basin analysis'],
        ['1', 'Generate basins and locate attractors'],
        ['1', 'Electron density'],
        [String(grid), `Grid quality ${grid} (1 low, 2 medium, 3 high, 4 lunatic)`],
        ['7', 'Integrate real-space functions in AIM basins with mixed grids'],
        ['2', 'Integrate and refine the basin boundary'],
        ['1', 'Electron density'],
        ['-10', 'Return to the main menu'],
        ['q', 'Exit'],
      ];
  } else if (analysis.id === 'esp') {
    steps = legacy
      ? [
        ['12', 'Quantitative analysis of molecular surface'],
        ['1', 'Select the way to define the surface'],
        ['1', 'Isosurface of electron density'],
        [menuNumber(isovalue), `Density isovalue ${menuNumber(isovalue)} a.u.`],
        ['6', 'Start analysis without a mapped function'],
        ['0', 'Return to the main menu'],
        ['q', 'Exit'],
      ]
      // Issue 339: option 0 starts the analysis *with* the mapped function (the
      // ESP statistics the parser reads), and `-1 -1` accept the default
      // post-processing choices. `6` analysed without the function, and the
      // trailing `0`/`q` were not answers to that menu at all.
      : [
        ['12', 'Quantitative analysis of molecular surface'],
        ['1', 'Select the way to define the surface'],
        ['1', 'Isosurface of electron density'],
        [menuNumber(isovalue), `Density isovalue ${menuNumber(isovalue)} a.u.`],
        ['0', 'Start the analysis with the ESP mapped on the surface'],
        ['-1', 'Default choice for the surface minima/maxima list'],
        ['-1', 'Default choice for the post-processing menu'],
        ['q', 'Exit'],
      ];
  } else if (analysis.id === 'elf' || analysis.id === 'lol') {
    const functionNumber = analysis.id === 'elf' ? '9' : '10';
    steps = [
      ['5', 'Output and plot a property within a spatial region (grid data)'],
      [functionNumber, analysis.id === 'elf' ? 'Electron Localization Function (ELF)' : 'Localized orbital locator (LOL)'],
      ['4', 'Set the grid to the requested number of points'],
      [`${grid},${grid},${grid}`, `Grid ${grid} x ${grid} x ${grid}`],
      ['2', 'Export the grid data to a cube file'],
      ['0', 'Return to the main menu'],
      ['q', 'Exit'],
    ];
  } else {
    steps = legacy
      ? [
        ['20', 'Visual study of weak interaction'],
        ['1', 'NCI analysis'],
        [String(grid), `NCI grid quality ${grid} (1 low, 2 medium, 3 high, 4 very high)`],
        ['2', 'Output scatter points to output.txt'],
        ['0', 'Return to the main menu'],
        ['q', 'Exit'],
      ]
      // Issue 339: the scatter submenu's 0 is *Exit* (back to the weak-interaction
      // menu); a second 0 leaves that menu, and `q` then quits. One 0 read `q` as
      // an answer to the scatter menu and Multiwfn died with a list-directed
      // I/O error after writing output.txt.
      : [
        ['20', 'Visual study of weak interaction'],
        ['1', 'NCI analysis'],
        [String(grid), `NCI grid quality ${grid} (1 low, 2 medium, 3 high, 4 very high)`],
        ['2', 'Output scatter points to output.txt'],
        ['0', 'Exit the scatter-point menu'],
        ['0', 'Exit the weak-interaction menu'],
        ['q', 'Exit'],
      ];
  }
  return {
    version: band,
    band,
    analysis: analysis.id,
    lines: steps.map(([line]) => line),
    text: `${steps.map(([line]) => line).join('\n')}\n`,
    steps: steps.map(([line, meaning]) => ({ line, meaning })),
    // The files the recipe asks Multiwfn to write, beside stdout.
    files: analysis.id === 'qtaim'
      ? ['CPprop.txt']
      : analysis.id === 'esp'
        ? []
        : analysis.id === 'rdg'
          ? ['output.txt']
          : ['*.cub'],
  };
}

/** The argv the runner uses; the menu script is written to stdin. */
export function multiwfnArgv({ inputName = '', threads = null } = {}) {
  const args = [];
  if (inputName) args.push(String(inputName));
  const count = Number(threads);
  if (Number.isInteger(count) && count > 0) args.push('-nt', String(Math.min(count, 256)));
  args.push('-silent');
  return args;
}

/* ── parsers ──────────────────────────────────────────────────────── */

function finiteNumber(token) {
  if (typeof token !== 'string') return null;
  if (/^NaN$/i.test(token.trim())) return null;
  const value = Number(token);
  return Number.isFinite(value) ? value : null;
}

function matchNumber(text, pattern) {
  const match = pattern.exec(text);
  return match ? finiteNumber(match[1]) : null;
}

/**
 * QTAIM: the refined basin table, the normalised atomic charges and the
 * `CPprop.txt` critical-point blocks. Every table is optional only in the sense
 * that its absence is reported; a run with no basin table is refused, because
 * the number the block exists for would otherwise be absent without a reason.
 */
export function parseQtaimOutput(text, { parameters = {}, cpProp = '' } = {}) {
  const stdout = String(text ?? '');
  const basinRows = [];
  const basinPattern = /^\s*(\d+)\s+(-?\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*$/gm;
  // Only the final "Total result" table has four columns: basin, integral,
  // Vol(Bohr^3), Vol(rho>0.001). Earlier tables in the same transcript have
  // two or three and must not be mistaken for it.
  const totalIndex = stdout.lastIndexOf('Total result:');
  const basinSection = totalIndex >= 0 ? stdout.slice(totalIndex) : stdout;
  let match;
  while ((match = basinPattern.exec(basinSection)) !== null) {
    basinRows.push({
      basin: Number(match[1]),
      electrons: finiteNumber(match[2]),
      volumeBohr3: finiteNumber(match[3]),
      volumeRhoCutoffBohr3: finiteNumber(match[4]),
    });
  }
  if (basinRows.length === 0) {
    return {
      ok: false,
      analysis: 'qtaim',
      reason: 'Multiwfn printed no four-column basin integration table (the "Total result" block was not found)',
      detail: 'The menu script asks for basin generation and refined integration; a transcript without that '
        + 'table is either a different Multiwfn version or a run that stopped before integration.',
    };
  }
  const sumMatch = /Sum of above integrals:\s+(-?\d+(?:\.\d+)?)/.exec(basinSection);
  const volumeSumMatch = /Sum of basin volumes \(rho>0\.001\):\s+(-?\d+(?:\.\d+)?)/.exec(basinSection);

  const atomicCharges = [];
  const chargePattern = /^\s*(\d+)\s+\(([^)]*)\)\s+Charge:\s+(-?\d+(?:\.\d+)?)\s+Volume:\s+(-?\d+(?:\.\d+)?)\s+Bohr\^3/gm;
  while ((match = chargePattern.exec(stdout)) !== null) {
    atomicCharges.push({
      basin: Number(match[1]),
      element: match[2].trim(),
      charge: finiteNumber(match[3]),
      volumeBohr3: finiteNumber(match[4]),
      unit: { charge: 'e', volume: 'bohr^3' },
    });
  }
  const normalisation = matchNumber(stdout, /Normalization factor of the integral of electron density is\s+(-?\d+(?:\.\d+)?)/);

  const criticalPoints = [];
  const cpText = String(cpProp || '');
  const blockPattern = /-{5,}\s*CP\s+(\d+),\s*Type\s+\((3,[+-]?\d)\)\s*-{5,}/g;
  const starts = [];
  while ((match = blockPattern.exec(cpText)) !== null) {
    starts.push({ index: match.index, cp: Number(match[1]), type: `(${match[2]})` });
  }
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = index + 1 < starts.length ? starts[index + 1].index : cpText.length;
    const block = cpText.slice(start.index, end);
    const position = /Position \(Angstrom\):\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/.exec(block);
    const connected = /Connected atoms:\s*([^\r\n]+)/.exec(block);
    criticalPoints.push({
      index: start.cp,
      type: start.type,
      connectedAtoms: connected ? connected[1].trim().replace(/\s+/g, ' ') : '',
      positionAngstrom: position ? {
        x: finiteNumber(position[1]), y: finiteNumber(position[2]), z: finiteNumber(position[3]),
      } : null,
      density: matchNumber(block, /Density of all electrons:\s+([0-9.Ee+-]+)/),
      laplacian: matchNumber(block, /Laplacian of electron density:\s+([0-9.Ee+-]+)/),
      ellipticity: matchNumber(block, /Ellipticity of electron density:\s+([0-9.Ee+-]+)/),
      elf: matchNumber(block, /Electron localization function \(ELF\):\s+([0-9.Ee+-]+)/),
      lol: matchNumber(block, /Localized orbital locator \(LOL\):\s+([0-9.Ee+-]+)/),
      rdg: matchNumber(block, /Reduced density gradient \(RDG\):\s+([0-9.Ee+-]+)/),
      signLambda2Rho: matchNumber(block, /Sign\(lambda2\)\*rho:\s+([0-9.Ee+-]+)/),
    });
  }

  return {
    ok: true,
    analysis: 'qtaim',
    method: 'Multiwfn 3.8 topology analysis (CP search from nuclei and bond midpoints) and '
      + 'basin integration on mixed atomic-centre + uniform grids',
    parameters,
    basins: {
      count: basinRows.length,
      rows: basinRows,
      sumElectrons: sumMatch ? finiteNumber(sumMatch[1]) : null,
      sumVolumeRhoCutoffBohr3: volumeSumMatch ? finiteNumber(volumeSumMatch[1]) : null,
      normalisation,
      unit: { electrons: 'e', volume: 'bohr^3', volumeRhoCutoff: 'bohr^3' },
    },
    atomicCharges,
    criticalPoints,
    warning: criticalPoints.length === 0
      ? 'the transcript carried no CPprop.txt critical-point blocks; basin integration is still reported'
      : null,
  };
}

/** ESP: the "Summary of surface analysis" block Multiwfn prints for function 12. */
export function parseEspOutput(text, { parameters = {} } = {}) {
  const source = String(text ?? '');
  const summaryIndex = source.lastIndexOf('Summary of surface analysis');
  if (summaryIndex < 0) {
    return {
      ok: false,
      analysis: 'esp',
      reason: 'Multiwfn printed no "Summary of surface analysis" block',
      detail: 'The menu script selects quantitative analysis of the molecular surface and starts the '
        + 'analysis without a mapped function; a transcript without the summary did not reach that step.',
    };
  }
  const block = source.slice(summaryIndex);
  const pair = (label) => {
    const matched = new RegExp(`${label}:\\s+(-?\\d+(?:\\.\\d+)?)\\s+Bohr\\^([23])\\s+\\(\\s*(-?\\d+(?:\\.\\d+)?)\\s+Angstrom\\^([23])\\)`).exec(block);
    if (!matched) return null;
    return {
      bohr: finiteNumber(matched[1]),
      bohrUnit: `bohr^${matched[2]}`,
      angstrom: finiteNumber(matched[3]),
      angstromUnit: `angstrom^${matched[4]}`,
    };
  };
  const average = (label) => {
    const matched = new RegExp(`${label}:\\s+(-?\\d+(?:\\.\\d+)?|NaN)\\s+a\\.u\\.\\s+\\(\\s*(-?\\d+(?:\\.\\d+)?|NaN)\\s+kcal/mol\\)`).exec(block);
    if (!matched) return null;
    return { hartree: finiteNumber(matched[1]), kcalMol: finiteNumber(matched[2]), unit: { hartree: 'hartree', kcalMol: 'kcal/mol' } };
  };
  const variance = (label) => {
    const matched = new RegExp(`${label}:\\s+(-?\\d+(?:\\.\\d+)?|NaN)\\s+a\\.u\\.\\^2\\s+\\(\\s*(-?\\d+(?:\\.\\d+)?|NaN)\\s+\\(kcal/mol\\)\\^2\\)`).exec(block);
    if (!matched) return null;
    return { hartree2: finiteNumber(matched[1]), kcalMol2: finiteNumber(matched[2]) };
  };
  const extrema = /Minimal value:\s+(-?\d+(?:\.\d+)?)\s+kcal\/mol\s+Maximal value:\s+(-?\d+(?:\.\d+)?)\s+kcal\/mol/.exec(block);
  return {
    ok: true,
    analysis: 'esp',
    method: 'Multiwfn 3.8 quantitative analysis of the molecular surface (vdW isosurface, '
      + 'surface tessellation and mapped total ESP)',
    parameters,
    volume: pair('Volume'),
    surfaceArea: {
      overall: pair('Overall surface area'),
      positive: pair('Positive surface area'),
      negative: pair('Negative surface area'),
      unit: { bohr: 'bohr^2', angstrom: 'angstrom^2' },
    },
    potential: {
      overall: average('Overall average value'),
      positive: average('Positive average value'),
      negative: average('Negative average value'),
      minimalKcalMol: extrema ? finiteNumber(extrema[1]) : null,
      maximalKcalMol: extrema ? finiteNumber(extrema[2]) : null,
      variance: {
        overall: variance('Overall variance \\(sigma\\^2_tot\\)'),
        positive: variance('Positive variance'),
        negative: variance('Negative variance'),
      },
      unit: { hartree: 'hartree/e', kcalMol: 'kcal/mol/e' },
    },
    polarity: {
      mpiEv: matchNumber(block, /Molecular polarity index \(MPI\):\s+(-?[\d.]+)\s+eV/),
      nonpolarAreaAngstrom2: matchNumber(block, /Nonpolar surface area \(\|ESP\| <= 10 kcal\/mol\):\s+(-?[\d.]+)\s+Angstrom\^2/),
      polarAreaAngstrom2: matchNumber(block, /Polar surface area \(\|ESP\| > 10 kcal\/mol\):\s+(-?[\d.]+)\s+Angstrom\^2/),
    },
  };
}

/** ELF/LOL: the cube Multiwfn writes, summarised. */
export function parseCubeOutput(analysis, cubeText, { name = '', parameters = {} } = {}) {
  let cube;
  try {
    cube = parseCube(String(cubeText ?? ''));
  } catch (error) {
    return {
      ok: false,
      analysis,
      reason: `Multiwfn wrote a cube this build cannot read: ${error.message}`,
    };
  }
  const values = cube.values;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let absMax = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
    if (Math.abs(value) > absMax) absMax = Math.abs(value);
    sum += value;
  }
  const count = values.length;
  return {
    ok: true,
    analysis,
    method: `Multiwfn 3.8 grid data export (${analysis === 'elf' ? 'ELF' : 'LOL'})`,
    parameters,
    cube: {
      name,
      dims: cube.dims,
      voxels: count,
      spacingBohr: cube.spacing,
      originBohr: cube.origin,
      volumeAngstrom3: cube.volumeAngstrom3,
      atoms: Array.isArray(cube.atoms) ? cube.atoms.length : 0,
      valuesUnit: analysis === 'elf' ? 'dimensionless' : 'dimensionless',
    },
    summary: {
      min: Number.isFinite(min) ? min : null,
      max: Number.isFinite(max) ? max : null,
      mean: count > 0 ? sum / count : null,
      absMax: Number.isFinite(absMax) ? absMax : null,
    },
  };
}

/**
 * RDG-NCI: `output.txt` has one row per scatter point, five whitespace-separated
 * columns — `X Y Z sign(lambda2)rho RDG`, the Cartesian position in Å followed by
 * the two values the plot uses (Multiwfn's own `RDGscatter.gnu` plots `u 4:5`).
 * Issue 340: reading columns 1-2 stored the x/y coordinates as the density sign and
 * the RDG, so the record described a rectangle instead of the NCI plane.
 *
 * A row with fewer than five numeric fields is counted in `skippedLines`; the
 * parser never invents a point. The full set is capped so a dense grid cannot turn
 * `run.json` into a multi-megabyte file.
 */
export function parseNciOutput(text, { parameters = {}, maxPoints = 200_000 } = {}) {
  const lines = String(text ?? '').split(/\r?\n/);
  const points = [];
  let skipped = 0;
  let truncated = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length < 5) { skipped += 1; continue; }
    const x = finiteNumber(fields[3]);
    const s = finiteNumber(fields[4]);
    if (x === null || s === null) { skipped += 1; continue; }
    if (points.length >= maxPoints) { truncated = true; break; }
    points.push([x, s]);
  }
  if (points.length === 0) {
    return {
      ok: false,
      analysis: 'rdg',
      reason: 'Multiwfn wrote no sign(lambda2)rho / RDG points (output.txt was empty or unreadable)',
      detail: 'The menu script asks for NCI analysis and scatter-point output, which writes five columns '
        + '(X Y Z sign(lambda2)rho RDG); a transcript without them did not reach the post-processing export.',
    };
  }
  let attractive = 0;
  let repulsive = 0;
  let xMin = Infinity;
  let xMax = -Infinity;
  let sMin = Infinity;
  let sMax = -Infinity;
  for (const [x, s] of points) {
    if (x < 0) attractive += 1; else repulsive += 1;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (s < sMin) sMin = s;
    if (s > sMax) sMax = s;
  }
  return {
    ok: true,
    analysis: 'rdg',
    method: `Multiwfn NCI analysis (${String(parameters.band || 'current menus')}); points in the sign(lambda2)rho / RDG plane`,
    parameters,
    points: {
      count: points.length,
      truncated,
      skippedLines: skipped,
      values: points,
      columns: ['signLambda2Rho', 'rdg'],
      unit: { signLambda2Rho: 'e/bohr^3', rdg: 'dimensionless' },
    },
    range: { xMin, xMax, sMin, sMax },
    counts: {
      attractive,
      repulsive,
      belowIsovalue: points.filter(([, s]) => s <= Number(parameters.isovalue ?? 0.5)).length,
    },
  };
}

/**
 * Dispatch one transcript to its parser. `files` carries the side files the
 * recipe asks for: `cpProp` (QTAIM), `cubeText`/`cubeName` (ELF/LOL) and
 * `nciOutput` (RDG).
 */
export function parseMultiwfnOutput({ analysis, text = '', files = {}, parameters = {} } = {}) {
  const definition = multiwfnAnalysis(analysis);
  if (!definition) {
    return { ok: false, analysis, reason: `"${String(analysis)}" is not a supported Multiwfn analysis.` };
  }
  if (definition.id === 'qtaim') {
    return parseQtaimOutput(text, { parameters, cpProp: files.cpProp || '' });
  }
  if (definition.id === 'esp') return parseEspOutput(text, { parameters });
  if (definition.id === 'elf' || definition.id === 'lol') {
    return parseCubeOutput(definition.id, files.cubeText || '', { name: files.cubeName || '', parameters });
  }
  return parseNciOutput(files.nciOutput || text, { parameters });
}

/* ── comparison with the in-app QTAIM ─────────────────────────────── */

/** The tolerances the QTAIM comparison states, in the unit of each column. */
export const QTAIM_COMPARISON_TOLERANCES = Object.freeze({
  density: 1e-3,
  laplacian: 1e-2,
  ellipticity: 1e-2,
  positionAngstrom: 0.05,
});

function atomLabelsFromConnected(text) {
  const labels = [];
  const pattern = /(\d+)\s*\(([A-Za-z]{1,3})\s*\)/g;
  let match;
  while ((match = pattern.exec(String(text ?? ''))) !== null) {
    labels.push(`${match[2].trim()}${match[1]}`);
  }
  return labels.sort();
}

function bondKey(labels) {
  return [...labels].sort().join('-');
}

/**
 * Compare Multiwfn's (3,-1) critical points with `qtaimAnalysis()` on the same
 * checkpoint.
 *
 * The match is by connected atom labels (`O1-H2`), with a coordinate fallback
 * within 0.1 Å. Every compared property is returned with the absolute and
 * relative difference and whether it is inside `QTAIM_COMPARISON_TOLERANCES`;
 * a pair that cannot be matched is named, never silently dropped. This function
 * compares numbers; it cannot make two different methods agree.
 */
export function compareQtaimToApp(multiwfn, inApp) {
  const multiwfnPoints = (multiwfn?.criticalPoints || []).filter((point) => point.type === '(3,-1)');
  const appBonds = Array.isArray(inApp?.bonds) ? inApp.bonds.filter((bond) => bond.found) : [];
  if (multiwfnPoints.length === 0 || appBonds.length === 0) {
    return {
      compared: 0,
      matched: 0,
      differences: [],
      unmatchedMultiwfn: multiwfnPoints.map((point) => point.connectedAtoms || `CP ${point.index}`),
      unmatchedApp: appBonds.map((bond) => (bond.labels || []).join('-')),
      withinTolerance: false,
      reason: multiwfnPoints.length === 0
        ? 'Multiwfn printed no (3,-1) critical points to compare'
        : 'the in-app QTAIM analysis found no bond critical points to compare',
      tolerances: QTAIM_COMPARISON_TOLERANCES,
    };
  }
  const differences = [];
  const unmatchedMultiwfn = [];
  const used = new Set();
  for (const point of multiwfnPoints) {
    const labels = atomLabelsFromConnected(point.connectedAtoms);
    const key = labels.length === 2 ? bondKey(labels) : '';
    let index = key ? appBonds.findIndex((bond, position) => !used.has(position)
      && bondKey(bond.labels || []) === key) : -1;
    if (index < 0 && point.positionAngstrom) {
      index = appBonds.findIndex((bond, position) => !used.has(position) && bond.at
        && Math.hypot(
          (bond.at.x ?? 0) - point.positionAngstrom.x,
          (bond.at.y ?? 0) - point.positionAngstrom.y,
          (bond.at.z ?? 0) - point.positionAngstrom.z,
        ) <= 0.1);
    }
    if (index < 0) {
      unmatchedMultiwfn.push(point.connectedAtoms || `CP ${point.index}`);
      continue;
    }
    used.add(index);
    const bond = appBonds[index];
    const pairs = [
      ['density', point.density, bond.rho, QTAIM_COMPARISON_TOLERANCES.density],
      ['laplacian', point.laplacian, bond.laplacian, QTAIM_COMPARISON_TOLERANCES.laplacian],
      ['ellipticity', point.ellipticity, bond.ellipticity, QTAIM_COMPARISON_TOLERANCES.ellipticity],
    ];
    if (point.positionAngstrom && bond.at) {
      const distance = Math.hypot(
        bond.at.x - point.positionAngstrom.x,
        bond.at.y - point.positionAngstrom.y,
        bond.at.z - point.positionAngstrom.z,
      );
      differences.push({
        bond: key || (bond.labels || []).join('-'),
        property: 'positionAngstrom',
        multiwfn: point.positionAngstrom,
        inApp: bond.at,
        absolute: distance,
        relative: null,
        tolerance: QTAIM_COMPARISON_TOLERANCES.positionAngstrom,
        withinTolerance: distance <= QTAIM_COMPARISON_TOLERANCES.positionAngstrom,
      });
    }
    for (const [property, left, right, tolerance] of pairs) {
      if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
      const absolute = Math.abs(left - right);
      differences.push({
        bond: key || (bond.labels || []).join('-'),
        property,
        multiwfn: left,
        inApp: right,
        absolute,
        relative: right !== 0 ? absolute / Math.abs(right) : null,
        tolerance,
        withinTolerance: absolute <= tolerance,
      });
    }
  }
  return {
    compared: differences.length,
    matched: multiwfnPoints.length - unmatchedMultiwfn.length,
    differences,
    unmatchedMultiwfn,
    unmatchedApp: appBonds.filter((bond, index) => !used.has(index)).map((bond) => (bond.labels || []).join('-')),
    withinTolerance: differences.length > 0 && differences.every((entry) => entry.withinTolerance),
    tolerances: QTAIM_COMPARISON_TOLERANCES,
    note: 'The in-app qtaim.js integrates no basins: this comparison covers the (3,-1) critical-point '
      + 'properties only. Basin populations have no in-app counterpart to compare against.',
  };
}

/* ── presentation helpers ─────────────────────────────────────────── */

/** One line for a queue row and a report sentence. */
export function multiwfnSummary(result) {
  if (!result || result.ok === false) return `Multiwfn — ${result?.reason || 'not computed'}`;
  if (result.analysis === 'qtaim') {
    const charges = result.atomicCharges || [];
    const range = charges.length
      ? `, charges ${Math.min(...charges.map((entry) => entry.charge)).toFixed(3)} to `
        + `${Math.max(...charges.map((entry) => entry.charge)).toFixed(3)} e`
      : '';
    return `QTAIM — ${result.basins.count} basin${result.basins.count === 1 ? '' : 's'}, `
      + `${result.criticalPoints.length} critical point${result.criticalPoints.length === 1 ? '' : 's'}${range}`;
  }
  if (result.analysis === 'esp') {
    const area = result.surfaceArea?.overall?.angstrom;
    const mean = result.potential?.overall?.kcalMol;
    return `ESP — ${Number.isFinite(area) ? `${area.toFixed(2)} Angstrom^2` : 'no area'}, `
      + `mean ${Number.isFinite(mean) ? `${mean.toFixed(2)} kcal/mol` : 'not printed'}`;
  }
  if (result.analysis === 'elf' || result.analysis === 'lol') {
    return `${result.analysis.toUpperCase()} — cube ${result.cube.dims.join('x')}, `
      + `values ${result.summary.min?.toFixed(6)} to ${result.summary.max?.toFixed(6)}`;
  }
  if (result.analysis === 'rdg') {
    return `RDG-NCI — ${result.points.count} points (${result.counts.attractive} attractive)`;
  }
  return 'Multiwfn analysis';
}

/** Key/value rows the inspector and card print, [label, value]. */
export function multiwfnCardRows(result) {
  if (!result || result.ok === false) return [['Multiwfn', result?.reason || 'not computed']];
  if (result.analysis === 'qtaim') {
    return [
      ['Basins', `${result.basins.count}`],
      ['Basin electrons', Number.isFinite(result.basins.sumElectrons)
        ? `${result.basins.sumElectrons.toFixed(6)} e` : 'not printed'],
      ['Critical points', `${result.criticalPoints.length}`],
      ['QTAIM charges', result.atomicCharges.length
        ? result.atomicCharges.map((entry) => `${entry.element}${entry.basin} ${entry.charge.toFixed(3)}`).join(', ')
        : 'not printed'],
    ];
  }
  if (result.analysis === 'esp') {
    return [
      ['Surface area', Number.isFinite(result.surfaceArea?.overall?.angstrom)
        ? `${result.surfaceArea.overall.angstrom.toFixed(2)} Angstrom^2` : 'not printed'],
      ['Volume', Number.isFinite(result.volume?.angstrom)
        ? `${result.volume.angstrom.toFixed(2)} Angstrom^3` : 'not printed'],
      ['ESP mean', Number.isFinite(result.potential?.overall?.kcalMol)
        ? `${result.potential.overall.kcalMol.toFixed(2)} kcal/mol` : 'not printed'],
      ['ESP range', `${Number.isFinite(result.potential?.minimalKcalMol)
        ? result.potential.minimalKcalMol.toFixed(2) : '?'} to ${Number.isFinite(result.potential?.maximalKcalMol)
        ? result.potential.maximalKcalMol.toFixed(2) : '?'} kcal/mol`],
    ];
  }
  if (result.analysis === 'elf' || result.analysis === 'lol') {
    return [
      ['Cube', result.cube.name || 'written'],
      ['Grid', result.cube.dims.join(' x ')],
      ['Range', `${result.summary.min?.toFixed(6)} to ${result.summary.max?.toFixed(6)}`],
      ['Mean', result.summary.mean?.toFixed(6) ?? 'not computed'],
    ];
  }
  if (result.analysis === 'rdg') {
    return [
      ['Points', `${result.points.count}${result.points.truncated ? ' (truncated)' : ''}`],
      ['Attractive / repulsive', `${result.counts.attractive} / ${result.counts.repulsive}`],
      ['sign(lambda2)rho range', `${result.range.xMin.toFixed(4)} to ${result.range.xMax.toFixed(4)}`],
      ['RDG range', `${result.range.sMin.toFixed(4)} to ${result.range.sMax.toFixed(4)}`],
    ];
  }
  return [];
}
