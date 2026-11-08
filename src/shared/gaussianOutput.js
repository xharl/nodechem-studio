/**
 * Minimal, dependency-free Gaussian output reader.
 *
 * The parser is organised around **links** (split on `--Link1--`) and **steps**
 * (an optimisation cycle, a frequency section or a single-point section). Every
 * record is scoped to the link that printed it; the flat root-level keys are
 * summaries taken from the link that owns the relevant record, so existing
 * callers and gates keep working unchanged.
 *
 * A partial parse is recorded as `complete: false` and `evaluateGates` refuses
 * to pass it. A fuller parser can replace this module without changing the
 * runner contract.
 */

import { terminationCodeOf } from './engines/canonical.js';
import { dispersionSupport } from './dispersion.js';
import { ELEMENTS } from './elements.js';
import { parseIrcSummary, parseScanSummary } from './reactionPath.js';
import { parseShieldings } from './nmr.js';
import { animatableModes, parseNormalModes } from './normalModes.js';
import { attachRaman, parseRamanActivities } from './raman.js';
import { attachVcd, parseVcdStrengths } from './vcd.js';
import { parseOrbitals } from './orbitals.js';
import { parseRotatoryStrengths } from './ecd.js';
import { parseTrajectory } from './trajectory.js';
import { summarizeValidity } from './validityChecks.js';
import { COMPOSITE_METHODS, compositeMethodFor, HARTREE_TO_KCAL_PER_MOL } from './routePresets.js';

const NUMBER = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][-+]?\d+)?`;

const SYMBOLS_BY_NUMBER = new Map([...ELEMENTS].map(([symbol, number]) => [number, symbol]));

// The documented Gaussian banner, e.g. "Gaussian 16, Revision C.01". The
// termination line ("Normal termination of Gaussian 16 at ...") deliberately
// does not match: it carries no revision and says nothing about the build.
const PROGRAM_BANNER = /\bGaussian\s+(\d{1,2}(?:\.\d+)?),\s*Revision\s+([A-Za-z]\.\d{2})\b/;

// Gaussian writes this marker between links, so the parser can scope every
// record to the link that produced it. A link is not a "job": Opt Freq is one
// link, Opt followed by Freq with a checkpoint is two.
const LINK_MARKER = /^\s*--Link1--\s*$/i;

const NORMAL_TERMINATION = /\bNormal termination of Gaussian\b/i;
const ERROR_TERMINATION = /\bError termination\b/i;

const SCF_DONE = new RegExp(
  String.raw`SCF Done:\s+E\(([^)]+)\)\s*=\s*(${NUMBER})\s+A\.U\.\s+after\s+(\d+)\s+cycles`,
  'i',
);
const SCF_FAILURE = /\bConvergence failure\b|\bSCF (?:did not converge|failed)\b/i;

// `Frequencies --` needs whitespace after the dashes: "Low frequencies ---"
// also contains "frequencies --" but is a different record.
const FREQUENCIES_LINE = new RegExp(String.raw`Frequencies\s+--\s+(.+)$`, 'i');
const LOW_FREQUENCIES_LINE = new RegExp(String.raw`Low\s+frequencies\s*-+\s*(.*)$`, 'i');
const RED_MASSES_LINE = new RegExp(String.raw`Red\.\s*masses\s*--\s*(.*)$`, 'i');
const FRC_CONSTS_LINE = new RegExp(String.raw`Frc\s+consts\s*--\s*(.*)$`, 'i');
const IR_INTEN_LINE = new RegExp(String.raw`IR\s+Inten\s*--\s*(.*)$`, 'i');

/**
 * A line that separates one frequency section from another. Mode index and
 * symmetry rows do not match; SCF, geometry, step and thermochemistry records
 * do, so `Opt=CalcAll` sections become separate blocks instead of one flat
 * list.
 */
const FREQUENCY_BREAK = /^\s*(?:SCF Done:|Step number\s+\d+|Input orientation:|Standard orientation:|Harmonic frequencies|Optimization completed|Stationary point found|Sum of electronic|Zero-point|Thermal correction|Temperature\s+\S+\s+Kelvin|Normal termination|Error termination)/i;

const STEP_NUMBER = /^\s*Step number\s+(\d+)/i;
const ORIENTATION_HEADER = /^\s*(Input|Standard) orientation:\s*$/i;
const ORIENTATION_ROW = new RegExp(
  String.raw`^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(${NUMBER})\s+(${NUMBER})\s+(${NUMBER})\s*$`,
);
const ROUTE_LINE = /^\s*(#[pPnNtT]?\s*\S.*)$/;

const CONVERGENCE_ROWS = [
  ['maxForce', 'Maximum Force'],
  ['rmsForce', 'RMS\\s+Force'],
  ['maxDisplacement', 'Maximum Displacement'],
  ['rmsDisplacement', 'RMS\\s+Displacement'],
];
const PREDICTED_CHANGE = new RegExp(
  String.raw`^\s*Predicted change in Energy\s*=\s*(${NUMBER})`,
  'i',
);

const CHARGE_ROW = new RegExp(
  String.raw`^\s*(\d+)\s+([A-Z][a-z]?)\s+(${NUMBER})(?:\s+(${NUMBER}))?\s*$`,
);
const NBO_ROW = new RegExp(
  String.raw`^\s*([A-Z][a-z]?)\s+(\d+)\s+(${NUMBER})\s+(${NUMBER})\s+(${NUMBER})\s+(${NUMBER})\s+(${NUMBER})\s*$`,
);
const DIPOLE_ROW = new RegExp(
  String.raw`X=\s*(${NUMBER})\s+Y=\s*(${NUMBER})\s+Z=\s*(${NUMBER})\s+Tot=\s*(${NUMBER})`,
  'i',
);
const T1_DIAGNOSTIC = new RegExp(String.raw`T1\s+[Dd]iagnostic\s*[:=]\s*(${NUMBER})`);
const DURATION = String.raw`(?:(\d+)\s+days\s+)?(?:(\d+)\s+hours\s+)?(?:(\d+)\s+minutes\s+)?(${NUMBER})\s+seconds`;
const CPU_TIME = new RegExp(String.raw`Job cpu time:\s*${DURATION}`, 'i');
const ELAPSED_TIME = new RegExp(String.raw`Elapsed time:\s*${DURATION}`, 'i');

const ERROR_CAUSE_BOUNDARY = /^\s*(?:SCF Done:|Step number\s+\d+|Input orientation:|Standard orientation:|Harmonic frequencies|Frequencies\s+--\s+|Optimization completed|Stationary point found|#)/i;
const ERROR_DIAGNOSTIC = /(?:Convergence failure|convergence criterion not met|(?:problem with|error in) the distance matrix|FormBX|Basis set .*not (?:available|found)|Erroneous (?:write|read)|disk quota|Atomic number out of range|End of file|Missing or bad data|Optimization stopped|Number of steps exceeded|SCF has not converged|SCF Error|>>>>>>>>>>)/i;
const NON_ACTIONABLE = /^(?:SCF Done:|Step number\s|Optimization completed|Stationary point found|Normal termination|--Link1--)/i;

/**
 * Most specific first. Gaussian repeats "SCF Error" across a whole block and
 * prints the sentence that names the problem in the middle of it.
 */
const DIAGNOSTIC_PRIORITY = [
  /SCF has not converged/i,
  /Convergence failure|convergence criterion not met|Number of steps exceeded|Optimization stopped/i,
  /(?:problem with|error in) the distance matrix|FormBX/i,
  /Basis set .*not (?:available|found)|Atomic number out of range|Missing or bad data|End of file|Erroneous (?:write|read)|disk quota/i,
  /SCF Error/i,
];

/**
 * Which records a piece of output can supply. The runner uses this to say what
 * the head and tail windows of a large file each contributed.
 */
export function outputEvidence(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  return EVIDENCE.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

const EVIDENCE = [
  ['banner', /\bEntering Gaussian System\b/i],
  ['program', PROGRAM_BANNER],
  ['route', /^[ \t]*#[pPnNtT]?\s*\S/m],
  ['geometry', /^[ \t]*[A-Z][a-z]?[ \t]+[-+]?\d+(?:\.\d+)?[ \t]+[-+]?\d+(?:\.\d+)?[ \t]+[-+]?\d+(?:\.\d+)?/m],
  ['scf', /\bSCF Done:/i],
  ['optimization', /\b(?:Optimization completed|Stationary point found)\b/i],
  ['frequencies', /\bFrequencies\s*--/i],
  ['thermochemistry', /\bSum of electronic and thermal (?:Free Energies|Enthalpies)\b/i],
  ['termination', /\b(?:Normal termination of Gaussian|Error termination)\b/i],
];

function toNumber(value) {
  if (value === undefined || value === null) return null;
  const number = Number(String(value).replace(/[Dd]/, 'E'));
  return Number.isFinite(number) ? number : null;
}

/**
 * A byte range is partial when the caller says so, when the range itself says
 * so, or when it does not cover the whole file. Never trust a single flag.
 */
function normalizeByteRange(byteRange, truncated) {
  if (!byteRange || typeof byteRange !== 'object') return null;
  const size = Number.isFinite(byteRange.size) ? byteRange.size : null;
  const bytesRead = Number.isFinite(byteRange.bytesRead) ? byteRange.bytesRead : null;
  const partial = truncated === true || byteRange.truncated === true
    || (size !== null && bytesRead !== null && bytesRead < size);
  const windows = Array.isArray(byteRange.windows) ? byteRange.windows.map((entry) => {
    const start = Number.isFinite(entry?.start) ? entry.start : null;
    const end = Number.isFinite(entry?.end) ? entry.end : null;
    return {
      name: typeof entry?.name === 'string' ? entry.name : 'window',
      start,
      end,
      bytes: Number.isFinite(entry?.bytes) ? entry.bytes
        : start !== null && end !== null ? Math.max(0, end - start) : null,
      supplied: Array.isArray(entry?.supplied) ? entry.supplied.map(String) : [],
    };
  }) : [];
  return { size, bytesRead, truncated: partial, windows };
}

/**
 * The `E (Thermal) / CV / S` table that follows the correction lines.
 * Every component is `null` when the row was not printed, never zero by default.
 */
function emptyThermalComponents() {
  return {
    total: null,
    electronic: null,
    translational: null,
    rotational: null,
    vibrational: null,
  };
}

function parseThermalComponents(lines) {
  const table = {
    thermalEnergyKcalPerMol: emptyThermalComponents(),
    heatCapacityCalPerMolK: emptyThermalComponents(),
    entropyCalPerMolK: emptyThermalComponents(),
  };
  const start = lines.findIndex((line) => /E\s*\(Thermal\)/i.test(line) && /\bCV\b/i.test(line));
  if (start === -1) return table;
  const row = new RegExp(
    String.raw`^\s*(Total|Electronic|Translational|Rotational|Vibrational)\s+(${NUMBER})\s+(${NUMBER})\s+(${NUMBER})\s*$`,
    'i',
  );
  let found = 0;
  for (let index = start + 1; index < lines.length && index < start + 12 && found < 5; index += 1) {
    const match = lines[index].match(row);
    if (!match) {
      if (found > 0 && lines[index].trim() === '') break;
      continue;
    }
    const key = match[1].toLowerCase();
    table.thermalEnergyKcalPerMol[key] = toNumber(match[2]);
    table.heatCapacityCalPerMolK[key] = toNumber(match[3]);
    table.entropyCalPerMolK[key] = toNumber(match[4]);
    found += 1;
  }
  return table;
}

/**
 * Parse the complete Gaussian thermochemistry block. Gaussian prints these
 * records one per line after the frequency section; older outputs wrap the
 * zero-point energy (Joules/Mol then Kcal/Mol) over two lines.
 */
function parseThermochemistry(joined, lines) {
  const value = (pattern) => {
    const match = joined.match(new RegExp(pattern, 'i'));
    return match ? toNumber(match[1]) : null;
  };

  const temperature = joined.match(new RegExp(
    String.raw`Temperature\s+(${NUMBER})\s+Kelvin`,
    'i',
  ));
  const pressure = joined.match(new RegExp(
    String.raw`Pressure\s+(${NUMBER})\s+Atm`,
    'i',
  ));
  const zeroPointVibrational = joined.match(new RegExp(
    String.raw`Zero-point vibrational energy\s+(${NUMBER})\s+\(Joules/Mol\)\s+(${NUMBER})\s+\(Kcal/Mol\)`,
    'i',
  ));

  // The constants the RRHO partition function needs. `Rotational constants`
  // appears twice in a frequency job (once before the modes, once in the
  // thermochemistry block); the last one belongs to the parsed geometry.
  const lastNumberTriple = (label) => {
    const pattern = new RegExp(String.raw`${label}\s+(${NUMBER})\s+(${NUMBER})\s+(${NUMBER})`, 'gi');
    let match = null;
    for (const candidate of joined.matchAll(pattern)) match = candidate;
    return match ? [toNumber(match[1]), toNumber(match[2]), toNumber(match[3])] : null;
  };

  return {
    molecularMassAmu: value(String.raw`Molecular mass:\s+(${NUMBER})\s+amu`),
    symmetryNumber: value(String.raw`Rotational symmetry number\s+(${NUMBER})`),
    rotationalConstantsGHz: lastNumberTriple('Rotational constants \\(GHZ\\):'),
    rotationalTemperaturesK: lastNumberTriple('Rotational temperatures \\(Kelvin\\)'),
    // Kept from the first parser slice: callers and gates read this key.
    freeEnergyHartree: value(String.raw`Sum of electronic and thermal Free Energies\s*=\s*(${NUMBER})`),
    enthalpyHartree: value(String.raw`Sum of electronic and thermal Enthalpies\s*=\s*(${NUMBER})`),
    thermalEnergyHartree: value(String.raw`Sum of electronic and thermal Energies\s*=\s*(${NUMBER})`),
    zeroPointEnergyHartree: value(String.raw`Sum of electronic and zero-point Energies\s*=\s*(${NUMBER})`),
    zeroPointCorrectionHartree: value(String.raw`Zero-point correction\s*=\s*(${NUMBER})`),
    thermalCorrectionEnergyHartree: value(String.raw`Thermal correction to Energy\s*=\s*(${NUMBER})`),
    thermalCorrectionEnthalpyHartree: value(String.raw`Thermal correction to Enthalpy\s*=\s*(${NUMBER})`),
    thermalCorrectionFreeEnergyHartree: value(String.raw`Thermal correction to Gibbs Free Energy\s*=\s*(${NUMBER})`),
    zeroPointVibrationalEnergyJoulesPerMol: zeroPointVibrational ? toNumber(zeroPointVibrational[1]) : null,
    zeroPointVibrationalEnergyKcalPerMol: zeroPointVibrational ? toNumber(zeroPointVibrational[2]) : null,
    temperatureK: temperature ? toNumber(temperature[1]) : null,
    pressureAtm: pressure ? toNumber(pressure[1]) : null,
    ...parseThermalComponents(lines),
  };
}

/* ── Links and steps ─────────────────────────────────────────── */

/**
 * Split the file on `--Link1--`. Each section keeps its starting line index so
 * every nested record can report an absolute line number.
 */
function splitLinks(lines) {
  const sections = [];
  let current = { lines: [], startLine: 0 };
  for (let index = 0; index < lines.length; index += 1) {
    if (LINK_MARKER.test(lines[index])) {
      sections.push(current);
      current = { lines: [], startLine: index + 1 };
    } else {
      current.lines.push(lines[index]);
    }
  }
  sections.push(current);
  return sections.filter((section) => section.lines.some((line) => line.trim() !== ''));
}

function programOf(joined) {
  const banner = joined.match(PROGRAM_BANNER);
  return {
    name: banner ? 'Gaussian' : null,
    version: banner ? banner[1] : null,
    revision: banner ? banner[2].toUpperCase() : null,
  };
}

function terminationOf(lines) {
  const joined = lines.join('\n');
  if (NORMAL_TERMINATION.test(joined)) return 'normal';
  if (ERROR_TERMINATION.test(joined)) return 'error';
  return 'none';
}

/**
 * The exact route as echoed by Gaussian, for comparison against the route the
 * input builder wrote. Case is preserved; the leading `#` is kept.
 */
function routeOf(lines) {
  for (const line of lines) {
    const match = line.match(ROUTE_LINE);
    if (match) return match[1].trimEnd();
  }
  return null;
}

/**
 * One `Input orientation` / `Standard orientation` table. Column order is
 * Center Number, Atomic Number, Atomic Type, X, Y, Z; the element symbol is
 * derived from the atomic number for XYZ export.
 */
function parseOrientationTable(lines, headerIndex, source, offset) {
  const atoms = [];
  let started = false;
  for (let index = headerIndex + 1; index < lines.length && index <= headerIndex + 200; index += 1) {
    const line = lines[index];
    if (/^\s*-{3,}\s*$/.test(line)) continue;
    if (line.trim() === '') {
      if (started) break;
      continue;
    }
    const row = line.match(ORIENTATION_ROW);
    if (row) {
      const atomicNumberValue = Number(row[2]);
      atoms.push({
        center: Number(row[1]),
        atomicNumber: atomicNumberValue,
        atomicType: Number(row[3]),
        element: SYMBOLS_BY_NUMBER.get(atomicNumberValue) || null,
        x: toNumber(row[4]),
        y: toNumber(row[5]),
        z: toNumber(row[6]),
      });
      started = true;
      continue;
    }
    if (started) break;
    if (index > headerIndex + 8) break;
  }
  if (atoms.length === 0) return null;
  return {
    source,
    line: offset + headerIndex + 1,
    atomCount: atoms.length,
    atoms,
  };
}

/**
 * Orientation tables in one link, keeping only the last Input and Standard
 * table plus the table that follows the final step. A hundred-step
 * optimisation therefore does not put a hundred geometries in `run.json`.
 */
function parseGeometries(lines, offset) {
  const tables = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(ORIENTATION_HEADER);
    if (!header) continue;
    const table = parseOrientationTable(lines, index, header[1].toLowerCase(), offset);
    if (table) tables.push(table);
  }
  const input = [...tables].reverse().find((table) => table.source === 'input') || null;
  const standard = [...tables].reverse().find((table) => table.source === 'standard') || null;
  return {
    input,
    standard,
    final: tables.length ? tables[tables.length - 1] : null,
  };
}

/**
 * Write a parsed geometry as XYZ. Coordinates are printed with the same six
 * decimals Gaussian uses in the orientation table, so re-importing the text
 * reproduces the optimised structure exactly at the printed precision.
 */
export function geometryToXyz(geometry, { comment = 'NodeChem Studio final geometry' } = {}) {
  if (!geometry || !Array.isArray(geometry.atoms) || geometry.atoms.length === 0) {
    throw new TypeError('A geometry with at least one atom is required to write XYZ.');
  }
  const header = [String(geometry.atoms.length), String(comment ?? '').replace(/[\r\n]+/g, ' ')];
  const atomLines = geometry.atoms.map((atom) => {
    if (!atom.element) {
      throw new TypeError(`Atom ${atom.center ?? '?'} has no element symbol; XYZ needs one.`);
    }
    if (![atom.x, atom.y, atom.z].every((value) => Number.isFinite(value))) {
      throw new TypeError(`Atom ${atom.center ?? '?'} has non-finite coordinates.`);
    }
    return `${atom.element} ${atom.x.toFixed(6)} ${atom.y.toFixed(6)} ${atom.z.toFixed(6)}`;
  });
  return `${header.concat(atomLines).join('\n')}\n`;
}

/**
 * Regular population tables (`Mulliken`, `Löwdin`, `ESP`): atom number,
 * element, charge and an optional spin density. Stops at the blank line that
 * ends the table, so the next population block is never consumed.
 */
function parseChargeRows(lines, startIndex) {
  const atoms = [];
  let started = false;
  for (let index = startIndex + 1; index < lines.length && index <= startIndex + 200; index += 1) {
    const line = lines[index];
    if (line.trim() === '') {
      if (started) break;
      continue;
    }
    if (/^\s*-{3,}\s*$/.test(line)) continue;
    const match = line.match(CHARGE_ROW);
    if (match) {
      atoms.push({
        atom: Number(match[1]),
        element: match[2],
        charge: toNumber(match[3]),
        spinDensity: match[4] === undefined ? null : toNumber(match[4]),
      });
      started = true;
      continue;
    }
    if (started) break;
    if (index - startIndex > 6) break;
  }
  return atoms;
}

/**
 * `Natural Population Analysis` rows: element, atom number, natural charge,
 * then the core/valence/Rydberg/total breakdown.
 */
function parseNboRows(lines, startIndex) {
  const atoms = [];
  for (let index = startIndex + 1; index < lines.length && index <= startIndex + 200; index += 1) {
    const line = lines[index];
    if (/^\s*={3,}\s*$/.test(line)) {
      if (atoms.length) break;
      continue;
    }
    if (line.trim() === '') {
      if (atoms.length) break;
      continue;
    }
    const match = line.match(NBO_ROW);
    if (!match) continue;
    atoms.push({
      element: match[1],
      atom: Number(match[2]),
      charge: toNumber(match[3]),
      core: toNumber(match[4]),
      valence: toNumber(match[5]),
      rydberg: toNumber(match[6]),
      total: toNumber(match[7]),
    });
  }
  return atoms;
}

function parseDipole(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*Dipole moment\b/i.test(lines[index])) continue;
    for (let cursor = index; cursor < lines.length && cursor <= index + 3; cursor += 1) {
      const match = lines[cursor].match(DIPOLE_ROW);
      if (!match) continue;
      return {
        x: toNumber(match[1]),
        y: toNumber(match[2]),
        z: toNumber(match[3]),
        total: toNumber(match[4]),
      };
    }
  }
  return null;
}

function emptyCharges() {
  return { mulliken: [], lowdin: [], nbo: [], esp: [], hirshfeld: [], dipole: null };
}

function parseCharges(lines) {
  const charges = emptyCharges();
  const mulliken = lines.findIndex((line) => /^\s*Mulliken charges(?:\s+and\s+spin densities)?\s*:/i.test(line));
  if (mulliken !== -1) charges.mulliken = parseChargeRows(lines, mulliken);

  const lowdin = lines.findIndex((line) => /^\s*L(?:ö|o)wdin charges\s*:/i.test(line));
  if (lowdin !== -1) charges.lowdin = parseChargeRows(lines, lowdin);

  const esp = lines.findIndex((line) => /^\s*(?:ESP charges|Charges from ESP fit)\b/i.test(line));
  if (esp !== -1) charges.esp = parseChargeRows(lines, esp);

  const natural = lines.findIndex((line) => /^\s*(?:Summary of\s+)?Natural Population Analysis\b/i.test(line));
  if (natural !== -1) charges.nbo = parseNboRows(lines, natural);
  if (charges.nbo.length === 0) {
    const nbo = lines.findIndex((line) => /^\s*NBO charges\s*:/i.test(line));
    if (nbo !== -1) charges.nbo = parseChargeRows(lines, nbo);
  }

  // Hirshfeld is printed with one charge column (Q-H) plus spin density, three
  // dipole components and CM5; only the first is the Hirshfeld charge.
  const hirshfeld = lines.findIndex((line) => /^\s*Hirshfeld charges\b/i.test(line));
  if (hirshfeld !== -1) charges.hirshfeld = parseHirshfeldRows(lines, hirshfeld);

  charges.dipole = parseDipole(lines);
  return charges;
}

/**
 * `Hirshfeld charges, spin densities, dipoles, and CM5 charges using IRadAn= 5:`
 *
 *   Q-H  S-H  Dx  Dy  Dz  Q-CM5
 *   1  O  -0.323144  0.000000  0.000000  0.000000  -0.186775  -0.659188
 *
 * The charge is the first numeric column; the `Tot` line is a sum, not an atom.
 */
function parseHirshfeldRows(lines, startIndex) {
  const atoms = [];
  for (let index = startIndex + 1; index < lines.length && index <= startIndex + 200; index += 1) {
    const line = lines[index];
    if (/^\s*Tot\b/i.test(line)) break;
    const match = line.match(/^\s*(\d+)\s+([A-Z][a-z]?)\s+(-?\d+\.\d+)/);
    if (match) {
      atoms.push({ atom: Number(match[1]), element: match[2], charge: toNumber(match[3]), spinDensity: null });
      continue;
    }
    if (atoms.length > 0) break;
    if (index - startIndex > 6) break;
  }
  return atoms;
}

function parseT1Diagnostic(lines) {
  for (const line of lines) {
    const match = line.match(T1_DIAGNOSTIC);
    if (match) return toNumber(match[1]);
  }
  return null;
}

/**
 * Gaussian closes a failed job with an epigraph: a shouted line and an
 * attribution ("BREAD HAS TO MOLD IN ORDER TO GET PENICILLIN. / -- JERRY
 * BOATZ"). It is not a diagnosis, so it is skipped.
 */
const EPITAPH = /^(?:--\s+)?[A-Z][A-Z0-9 ,.'"!?;:()-]{3,}$/;

/**
 * The actionable line(s) immediately before `Error termination`: convergence
 * failure, distance-matrix problem, missing basis, disk quota. Scanning stops
 * at the previous section boundary so an SCF record is never called a cause.
 *
 * The decisive line can sit far above the termination — an optimiser that runs
 * out of steps reports once, then the tail of the file carries only the link
 * number and the epigraph — so a longer window is scanned for a real
 * diagnostic when the nearby lines carry none.
 */
function parseErrorCause(lines) {
  const index = lines.findIndex((line) => ERROR_TERMINATION.test(line));
  if (index === -1) return null;
  const collected = [];
  for (let cursor = index - 1; cursor >= 0 && collected.length < 5; cursor -= 1) {
    const text = lines[cursor].trim();
    if (text === '') continue;
    if (/^[-=*]{3,}$/.test(text)) continue;
    if (ERROR_CAUSE_BOUNDARY.test(text)) break;
    if (NON_ACTIONABLE.test(text) || EPITAPH.test(text)) continue;
    collected.unshift(text);
  }
  const candidates = collected.filter((text) => ERROR_DIAGNOSTIC.test(text));
  if (candidates.length === 0) {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const text = lines[cursor].trim();
      if (/\bNormal termination\b/i.test(text) || text === '--Link1--') break;
      if (ERROR_DIAGNOSTIC.test(text)) {
        const next = (lines[cursor + 1] || '').trim();
        candidates.push(/^--\s/.test(next) ? `${text} ${next}` : text);
        break;
      }
    }
  }
  // The most specific diagnosis wins over the loudest: a block of repeated
  // "SCF Error" banners must not hide "SCF has not converged".
  let diagnostic = null;
  for (const pattern of DIAGNOSTIC_PRIORITY) {
    const matches = candidates.filter((text) => pattern.test(text));
    if (matches.length > 0) {
      diagnostic = matches[matches.length - 1];
      break;
    }
  }
  return {
    cause: diagnostic || (collected.length ? collected[collected.length - 1] : null),
    lines: collected,
    terminationLine: lines[index].trim(),
  };
}

function secondsOf(match) {
  if (!match) return null;
  const seconds = toNumber(match[4]);
  if (seconds === null) return null;
  const days = match[1] ? Number(match[1]) : 0;
  const hours = match[2] ? Number(match[2]) : 0;
  const minutes = match[3] ? Number(match[3]) : 0;
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

/**
 * Basis-set size and the per-link resource lines Gaussian prints at the end.
 * A field the log did not print stays null.
 */
function parseResources(joined) {
  const nBasis = joined.match(/\bNBasis\s*=\s*(\d+)/i);
  const basis = joined.match(/There are\s+(\d+)\s+basis functions,\s+(\d+)\s+primitive gaussians/i);
  const processors = joined.match(/Will use up to\s+(\d+)\s+processors/i);
  const memory = joined.match(/^\s*%mem\s*=\s*(\S+)/im);
  return {
    nBasis: nBasis ? Number(nBasis[1]) : null,
    basisFunctions: basis ? Number(basis[1]) : null,
    primitiveGaussians: basis ? Number(basis[2]) : null,
    processors: processors ? Number(processors[1]) : null,
    memory: memory ? memory[1] : null,
    cpuSeconds: secondsOf(joined.match(CPU_TIME)),
    elapsedSeconds: secondsOf(joined.match(ELAPSED_TIME)),
  };
}

function emptyResources() {
  return {
    nBasis: null,
    basisFunctions: null,
    primitiveGaussians: null,
    processors: null,
    memory: null,
    cpuSeconds: null,
    elapsedSeconds: null,
  };
}

/* ── Composite methods and counterpoise (issue #77) ──────────── */

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Longest keyword first so G4MP2 is never read as G4. */
const COMPOSITE_ROUTE_TOKENS = COMPOSITE_METHODS
  .map((method) => ({
    method,
    pattern: new RegExp(`(^|[\\s(])${escapeRegExp(method.keyword)}(?=[\\s),=]|$)`, 'i'),
  }))
  .sort((a, b) => b.method.keyword.length - a.method.keyword.length);

/** The composite method named by an echoed route line, or `null`. */
export function compositeMethodFromRoute(route) {
  const text = String(route ?? '');
  if (!text) return null;
  for (const entry of COMPOSITE_ROUTE_TOKENS) {
    if (entry.pattern.test(text)) return entry.method;
  }
  return null;
}

function labelPattern(method) {
  return method.labels.map(escapeRegExp).join('|');
}

/**
 * The method-specific summary Gaussian prints after all composite links, e.g.
 *
 *   CBS-QB3 (0 K)=        -39.069832 CBS-QB3 Energy=           -39.066969
 *   CBS-QB3 Enthalpy=     -39.066025 CBS-QB3 Free Energy=      -39.088192
 *
 * A G2 job prints G1 lines before its G2 lines, so the last recognised block
 * wins. `(0 K)` is the headline composite energy; `Energy`, `Enthalpy` and
 * `Free Energy` are the thermochemically corrected terms and stay separate.
 */
function parseCompositeSummary(lines, offset) {
  const joined = lines.join('\n');
  let record = null;
  for (let index = 0; index < lines.length; index += 1) {
    const zero = lines[index].match(new RegExp(
      String.raw`^\s*([A-Za-z][A-Za-z0-9()\- ]*?)\s*\(0 K\)\s*=\s*(${NUMBER})`,
      'i',
    ));
    if (!zero) continue;
    const method = compositeMethodFor(zero[1]);
    if (!method) continue;
    const labels = labelPattern(method);
    const energy = joined.match(new RegExp(String.raw`(?:${labels})\s*Energy\s*=\s*(${NUMBER})`, 'i'));
    const enthalpy = joined.match(new RegExp(String.raw`(?:${labels})\s*Enthalpy\s*=\s*(${NUMBER})`, 'i'));
    const freeEnergy = joined.match(new RegExp(String.raw`(?:${labels})\s*Free Energy\s*=\s*(${NUMBER})`, 'i'));
    record = {
      found: true,
      method: method.id,
      keyword: method.keyword,
      label: zero[1].trim(),
      line: offset + index + 1,
      zeroPointEnergyHartree: toNumber(zero[2]),
      thermalEnergyHartree: energy ? toNumber(energy[1]) : null,
      enthalpyHartree: enthalpy ? toNumber(enthalpy[1]) : null,
      freeEnergyHartree: freeEnergy ? toNumber(freeEnergy[1]) : null,
    };
  }
  return record;
}

function emptyComposite(expected = null) {
  return {
    expected,
    found: false,
    method: null,
    keyword: expected ? compositeMethodFor(expected)?.keyword ?? null : null,
    zeroPointEnergyHartree: null,
    thermalEnergyHartree: null,
    enthalpyHartree: null,
    freeEnergyHartree: null,
  };
}

const COUNTERPOISE_CORRECTED = new RegExp(
  String.raw`^\s*(?:Counterpoise\s*:?\s*)?corrected energy\s*=\s*(${NUMBER})`, 'i',
);
const COUNTERPOISE_BSSE = new RegExp(
  String.raw`^\s*(?:Counterpoise\s*:?\s*)?BSSE energy\s*=\s*(${NUMBER})`, 'i',
);
const COUNTERPOISE_SUM = new RegExp(
  String.raw`^\s*(?:Counterpoise\s*:?\s*)?sum of fragments\s*=\s*(${NUMBER})`, 'i',
);
const COUNTERPOISE_COMPLEXATION = new RegExp(
  String.raw`^\s*complexation energy\s*=\s*(${NUMBER})\s*kcal/mole\s*\((raw|corrected)\)`, 'i',
);

/**
 * The counterpoise summary block, scoped to one link. Gaussian prints the
 * corrected complex energy, the BSSE and the monomer sum; older revisions use
 * a `Counterpoise:` prefix, newer ones do not. The printed BSSE is the
 * correction; `raw - corrected` complexation energies are a cross-check, not
 * the definition. Individual monomer energies and deformation terms are not in
 * this block and are left null rather than invented.
 */
function parseCounterpoise(lines, offset, route) {
  const routeMatch = String(route ?? '').match(/Counterpoise\s*=\s*(\d+)/i);
  const fragments = routeMatch ? Number(routeMatch[1]) : null;
  let complexEnergyHartree = null;
  let printedBsse = null;
  let monomerSumHartree = null;
  let rawInteractionKcalPerMol = null;
  let correctedInteractionKcalPerMol = null;
  let line = null;
  let bsseSource = null;

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    let match = text.match(COUNTERPOISE_CORRECTED);
    if (match) {
      complexEnergyHartree = toNumber(match[1]);
      line = line ?? offset + index + 1;
      continue;
    }
    match = text.match(COUNTERPOISE_BSSE);
    if (match) {
      printedBsse = toNumber(match[1]);
      line = line ?? offset + index + 1;
      continue;
    }
    match = text.match(COUNTERPOISE_SUM);
    if (match) {
      monomerSumHartree = toNumber(match[1]);
      continue;
    }
    match = text.match(COUNTERPOISE_COMPLEXATION);
    if (match) {
      if (match[2].toLowerCase() === 'raw') rawInteractionKcalPerMol = toNumber(match[1]);
      else correctedInteractionKcalPerMol = toNumber(match[1]);
    }
  }

  const found = complexEnergyHartree !== null || printedBsse !== null || monomerSumHartree !== null;
  if (!found && fragments === null) return null;
  if (!found) {
    return {
      fragments,
      found: false,
      complexEnergyHartree: null,
      monomerSumHartree: null,
      bsseHartree: null,
      bsseSource: null,
      bsseKcalPerMol: null,
      rawInteractionKcalPerMol: null,
      correctedInteractionKcalPerMol: null,
      interactionCorrectedHartree: null,
      line: null,
    };
  }

  // If a log prints only the complexation energies, BSSE is their difference;
  // otherwise the printed BSSE line is authoritative.
  let bsseHartree = printedBsse;
  if (bsseHartree !== null) bsseSource = 'printed';
  if (bsseHartree === null && rawInteractionKcalPerMol !== null && correctedInteractionKcalPerMol !== null) {
    bsseHartree = (rawInteractionKcalPerMol - correctedInteractionKcalPerMol) / HARTREE_TO_KCAL_PER_MOL;
    bsseSource = 'complexation-difference';
  }
  const interactionCorrectedHartree = correctedInteractionKcalPerMol !== null
    ? correctedInteractionKcalPerMol / HARTREE_TO_KCAL_PER_MOL
    : complexEnergyHartree !== null && monomerSumHartree !== null
      ? complexEnergyHartree - monomerSumHartree
      : null;

  return {
    fragments,
    found: true,
    complexEnergyHartree,
    monomerSumHartree,
    bsseHartree,
    bsseSource,
    bsseKcalPerMol: bsseHartree === null ? null : bsseHartree * HARTREE_TO_KCAL_PER_MOL,
    rawInteractionKcalPerMol,
    correctedInteractionKcalPerMol,
    interactionCorrectedHartree,
    line,
  };
}

function parseScfRecords(lines, offset) {
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(SCF_DONE);
    if (!match) continue;
    records.push({
      line: offset + index + 1,
      method: match[1].trim(),
      energyHartree: toNumber(match[2]),
      cycles: Number(match[3]),
    });
  }
  const failed = lines.some((line) => SCF_FAILURE.test(line));
  return {
    records,
    status: failed ? 'failed' : records.length ? 'converged' : 'unknown',
  };
}

function scfFailureLine(lines) {
  for (const line of lines) {
    if (SCF_FAILURE.test(line)) return line.trim();
  }
  return null;
}

/**
 * One `Converged?` table: final force/displacement values, their thresholds and
 * the YES/NO verdicts. Null fields mean the row was not printed, never zero.
 */
function parseConvergenceTable(lines, startIndex, offset) {
  const record = {
    line: offset + startIndex + 1,
    maxForce: null,
    rmsForce: null,
    maxDisplacement: null,
    rmsDisplacement: null,
    thresholds: {
      maxForce: null,
      rmsForce: null,
      maxDisplacement: null,
      rmsDisplacement: null,
    },
    converged: {
      maxForce: null,
      rmsForce: null,
      maxDisplacement: null,
      rmsDisplacement: null,
    },
    allConverged: null,
    predictedChangeInEnergy: null,
  };

  const patterns = CONVERGENCE_ROWS.map(([key, label]) => [
    key,
    new RegExp(String.raw`^\s*${label}\s+(${NUMBER})\s+(${NUMBER})\s+(YES|NO)\s*$`, 'i'),
  ]);

  for (let index = startIndex; index < lines.length && index <= startIndex + 8; index += 1) {
    for (const [key, pattern] of patterns) {
      const match = lines[index].match(pattern);
      if (!match) continue;
      record[key] = toNumber(match[1]);
      record.thresholds[key] = toNumber(match[2]);
      record.converged[key] = match[3].toUpperCase() === 'YES';
    }
    const predicted = lines[index].match(PREDICTED_CHANGE);
    if (predicted) record.predictedChangeInEnergy = toNumber(predicted[1]);
  }

  const keys = CONVERGENCE_ROWS.map(([key]) => key);
  const verdicts = keys.map((key) => record.converged[key]);
  if (verdicts.every((verdict) => verdict === true)) record.allConverged = true;
  else if (verdicts.some((verdict) => verdict === false)) record.allConverged = false;
  return record;
}

function parseConvergenceRecords(lines, offset) {
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*Maximum Force\s+[-+]?\d/i.test(lines[index])) {
      records.push(parseConvergenceTable(lines, index, offset));
    }
  }
  return records;
}

/**
 * Split a link into steps. A `Step number` line always starts a step; a second
 * Input/Standard orientation table starts one when the current step already
 * printed a table of the same kind. The preamble (banner, route, title) is not
 * a step.
 */
function splitSteps(lines, offset) {
  const steps = [];
  let current = { start: 0, explicit: false, hasInput: false, hasStandard: false, lines: [] };

  const flush = () => {
    if (!current.explicit) return;
    const convergence = parseConvergenceRecords(current.lines, offset + current.start);
    steps.push({
      index: steps.length,
      line: offset + current.start + 1,
      scf: parseScfRecords(current.lines, offset + current.start),
      optimization: {
        convergence: convergence.length ? convergence[convergence.length - 1] : null,
      },
    });
  };

  const begin = (index, explicit) => {
    flush();
    current = { start: index, explicit, hasInput: false, hasStandard: false, lines: [] };
  };

  const recordLine = /^\s*(?:SCF Done:|Frequencies\s+--\s+|Harmonic frequencies|Item\s+Value\s+Threshold|Maximum Force\s)/i;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const orientation = line.match(ORIENTATION_HEADER);
    if (STEP_NUMBER.test(line)) {
      begin(index, true);
    } else if (orientation) {
      const key = orientation[1].toLowerCase() === 'input' ? 'hasInput' : 'hasStandard';
      if (current[key]) {
        begin(index, true);
      } else if (!current.explicit) {
        // The first geometry table in a step anchors the step; the banner and
        // route preamble before it are not a step of their own.
        begin(index, true);
      }
      current[key] = true;
    } else if (!current.explicit && recordLine.test(line)) {
      begin(index, true);
    }
    current.lines.push(line);
  }
  flush();
  return steps;
}

/* ── Frequencies ─────────────────────────────────────────────── */

function numbersIn(text, invalidSink = null) {
  const values = [];
  for (const token of String(text).split(/\s+/)) {
    if (token === '') continue;
    const value = toNumber(token);
    if (value !== null) values.push(value);
    else if (invalidSink) invalidSink.push(token);
  }
  return values;
}

function emptyFrequencySummary() {
  return {
    count: 0,
    imaginaryCount: 0,
    imaginaryValues: [],
    minImaginary: null,
    values: [],
    lowest: [],
    invalid: false,
    invalidTokens: [],
  };
}

/**
 * Frequency sections scoped to one link. `Frequencies --` lines belonging to
 * the same section are grouped; a structural record between them (SCF, step,
 * geometry, thermochemistry) starts a new block, which is what keeps
 * `Opt=CalcAll` intermediate Hessians apart.
 */
function parseFrequencyBlocks(lines, offset) {
  const blocks = [];
  let currentBlock = null;
  let lastFrequencyIndex = -1;
  let pendingLow = null;

  const startBlock = (index) => {
    currentBlock = {
      index: blocks.length,
      line: offset + index + 1,
      values: [],
      invalidTokens: [],
      reducedMasses: [],
      forceConstants: [],
      irIntensities: [],
      lowFrequencies: pendingLow,
    };
    pendingLow = null;
    blocks.push(currentBlock);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const frequency = line.match(FREQUENCIES_LINE);
    if (frequency) {
      let startsNew = currentBlock === null;
      if (!startsNew) {
        const between = lines.slice(lastFrequencyIndex + 1, index);
        if (between.some((text) => FREQUENCY_BREAK.test(text))) startsNew = true;
      }
      if (startsNew) startBlock(index);
      currentBlock.values.push(...numbersIn(frequency[1], currentBlock.invalidTokens));
      lastFrequencyIndex = index;
      continue;
    }

    const low = line.match(LOW_FREQUENCIES_LINE);
    if (low) {
      const values = numbersIn(low[1]);
      // "Low frequencies" is printed before the mode table of its section. If
      // the previous section is still open, hold the values for the next block.
      if (currentBlock && currentBlock.values.length === 0) currentBlock.lowFrequencies = values;
      else pendingLow = values;
      continue;
    }

    if (currentBlock) {
      const reduced = line.match(RED_MASSES_LINE);
      if (reduced) {
        currentBlock.reducedMasses.push(...numbersIn(reduced[1]));
        continue;
      }
      const force = line.match(FRC_CONSTS_LINE);
      if (force) {
        currentBlock.forceConstants.push(...numbersIn(force[1]));
        continue;
      }
      const ir = line.match(IR_INTEN_LINE);
      if (ir) {
        currentBlock.irIntensities.push(...numbersIn(ir[1]));
      }
    }
  }

  for (const block of blocks) {
    const imaginaryValues = block.values.filter((value) => value < 0);
    block.count = block.values.length;
    block.invalid = block.invalidTokens.length > 0;
    block.imaginaryCount = imaginaryValues.length;
    block.imaginaryValues = imaginaryValues;
    block.minImaginary = imaginaryValues.length ? Math.min(...imaginaryValues) : null;
    block.lowest = [...block.values].sort((a, b) => a - b).slice(0, 10);
    block.lowModes = block.values
      .map((wavenumber, index) => ({
        wavenumber,
        reducedMass: block.reducedMasses[index] ?? null,
        forceConstant: block.forceConstants[index] ?? null,
        irIntensity: block.irIntensities[index] ?? null,
      }))
      .sort((a, b) => a.wavenumber - b.wavenumber)
      .slice(0, 10);
  }
  return blocks;
}

function summarizeFrequencies(blocks) {
  const block = blocks.length ? blocks[blocks.length - 1] : null;
  if (!block) return emptyFrequencySummary();
  return {
    count: block.count,
    imaginaryCount: block.imaginaryCount,
    imaginaryValues: block.imaginaryValues.slice(0, 20),
    minImaginary: block.minImaginary,
    values: block.values,
    lowest: block.lowest,
    invalid: block.invalid,
    invalidTokens: block.invalidTokens.slice(0, 20),
  };
}

/* ── Energies ────────────────────────────────────────────────── */

/**
 * Correlated (post-HF) energy when present; otherwise the SCF energy is the
 * best record.
 */
function parseFinalEnergy(joined, scf) {
  const correlatedMatch = joined.match(new RegExp(
    String.raw`(?:CCSD\(T\)|CCSD|QCISD\(T\)|QCISD|MP4|MP3|MP2)\s*(?:energy)?\s*=\s*(${NUMBER})`,
    'i',
  )) || joined.match(new RegExp(String.raw`E\(CORR\)\s*=\s*(${NUMBER})`, 'i'));
  const correlatedEnergy = correlatedMatch ? toNumber(correlatedMatch[1]) : null;
  const hartree = correlatedEnergy !== null ? correlatedEnergy : scf.energyHartree;
  return {
    hartree,
    source: correlatedEnergy !== null ? 'post-hf' : scf.energyHartree !== null ? 'scf' : null,
  };
}

/**
 * Spin contamination from the unrestricted reference, if printed.
 *
 * Restricted (RHF/RDFT) references print no such line, so both values stay
 * null and the validity check reports `skipped` rather than inventing a zero.
 */
/**
 * The ⟨S²⟩ Gaussian prints after the SCF converges, e.g.
 *   <Sx>= 0.0000 <Sy>= 0.0000 <Sz>= 0.5000 <S**2>= 0.7778 S= 0.5138
 * A restricted reference prints no such line: S² is exact by construction and
 * is reported as null rather than as a zero we did not read.
 */
/**
 * Wavefunction stability analysis (requested with `Stable` or `Stable=Opt`).
 *
 * Gaussian prints one of two verdicts after the perturbation analysis. These
 * strings are the documented output; the app's corpus has no Stable job yet, so
 * an output without them is `null` — and the gate built on this says `unknown`
 * rather than assuming stability.
 */
function parseWavefunctionStability(text) {
  if (/The wavefunction is stable under the perturbations considered\./i.test(text)) {
    return { stable: true, detail: 'stable under the perturbations considered' };
  }
  if (/The wavefunction has an internal instability\./i.test(text)) {
    return { stable: false, detail: 'the wavefunction has an internal instability' };
  }
  if (/The wavefunction is not stable under the perturbations considered/i.test(text)) {
    return { stable: false, detail: 'not stable under the perturbations considered' };
  }
  return { stable: null, detail: null };
}

function parseSpinSquared(joined) {
  const matches = [...joined.matchAll(new RegExp(String.raw`<S\*\*2>=\s*(${NUMBER})`, 'g'))];
  if (matches.length === 0) return { value: null, s: null };
  const last = matches[matches.length - 1];
  const sMatch = joined.slice(last.index).match(new RegExp(String.raw`^(?=[^\n]*S=\s*(${NUMBER}))`, 'm'));
  return { value: toNumber(last[1]), s: sMatch ? toNumber(sMatch[1]) : null };
}

function parseSpinContamination(joined) {
  const match = joined.match(new RegExp(
    String.raw`S\*\*2\s+before\s+annihilation\s+(${NUMBER})\s*,?\s*after\s+(${NUMBER})`,
    'i',
  ));
  return {
    before: match ? toNumber(match[1]) : null,
    after: match ? toNumber(match[2]) : null,
  };
}

/* ── Link assembly ───────────────────────────────────────────── */

/* ── Excited states (TD-DFT) ─────────────────────────────────── */

/**
 * Parse the `Excited State N:` table Gaussian prints for a TD or CIS job.
 *
 * The line Gaussian writes is:
 *
 *   Excited State   1:      Singlet-A      4.0115 eV  309.03 nm  f=0.1234  <S**2>=0.000
 *      12 -> 15         0.70123
 *
 * Nothing is derived: an unparsable line is skipped and the count is the number
 * of states actually read. A job with no table returns `{ count: 0, states: [] }`.
 */
const EXCITED_STATE = /^\s*Excited State\s+(\d+):\s+(\S+?)\s+([0-9.]+)\s+eV\s+([0-9.]+)\s+nm\s+f=([0-9.]+)(?:\s+<S\*\*2>=(-?[0-9.]+))?/;
const TRANSITION_LINE = /^\s*(\d+)\s*->\s*(\d+)\s+(-?[0-9.]+)\s*$/;

function parseExcitedStates(lines) {
  const states = [];
  let current = null;
  for (const line of lines) {
    const match = line.match(EXCITED_STATE);
    if (match) {
      const label = String(match[2] || '');
      const [spin, ...symmetryParts] = label.split('-');
      current = {
        index: Number(match[1]),
        label,
        spin: spin || null,
        symmetry: symmetryParts.join('-') || null,
        energyEv: toNumber(match[3]),
        wavelengthNm: toNumber(match[4]),
        oscillatorStrength: toNumber(match[5]),
        s2: match[6] === undefined ? null : toNumber(match[6]),
        transitions: [],
      };
      states.push(current);
      continue;
    }
    const transition = line.match(TRANSITION_LINE);
    if (transition && current) {
      current.transitions.push({
        from: Number(transition[1]),
        to: Number(transition[2]),
        coefficient: toNumber(transition[3]),
      });
    }
  }
  return { count: states.length, states };
}

function emptyExcitedStates() {
  return { count: 0, states: [] };
}

function parseLink(section, index) {
  const { lines, startLine } = section;
  const joined = lines.join('\n');
  const routeText = routeOf(lines);
  const steps = splitSteps(lines, startLine);
  const records = steps.flatMap((step) => step.scf.records);
  const failure = scfFailureLine(lines);
  const lastScf = records.length ? records[records.length - 1] : null;
  const scf = {
    status: failure ? 'failed' : lastScf ? 'converged' : 'unknown',
    energyHartree: lastScf ? lastScf.energyHartree : null,
    cycles: lastScf ? lastScf.cycles : null,
    method: lastScf ? lastScf.method : null,
    failure,
    records,
  };
  const frequencyBlocks = parseFrequencyBlocks(lines, startLine);
  // Raman rows (#76) sit inside the same frequency section. They are attached
  // to the modes rather than summarised, because the spectrum needs every
  // mode, not the ten lowest.
  const raman = attachRaman(
    (frequencyBlocks[frequencyBlocks.length - 1]?.values || []).map((wavenumber) => ({ wavenumber })),
    parseRamanActivities(lines.join('\n')),
  );
  // VCD (#78) rides the same frequency block, one signed row per mode.
  const vcdModes = attachVcd(
    (frequencyBlocks[frequencyBlocks.length - 1]?.values || []).map((wavenumber) => ({ wavenumber })),
    parseVcdStrengths(lines.join('\n')),
  );
  const convergenceRecords = parseConvergenceRecords(lines, startLine);
  const error = parseErrorCause(lines);
  const stepNumbers = lines
    .map((line) => line.match(STEP_NUMBER))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  const optimizationSteps = stepNumbers.length
    ? Math.max(Math.max(...stepNumbers), convergenceRecords.length || 0)
    : convergenceRecords.length || null;
  const optimization = {
    completed: /\bOptimization completed\b/i.test(joined),
    stationary: /\bStationary point found\b/i.test(joined),
    cycles: optimizationSteps,
    steps: optimizationSteps,
    convergence: convergenceRecords.length ? convergenceRecords[convergenceRecords.length - 1] : null,
    history: convergenceRecords,
  };

  return {
    index,
    line: startLine + 1,
    program: programOf(joined),
    route: routeText,
    termination: terminationOf(lines),
    geometry: parseGeometries(lines, startLine),
    scf,
    steps,
    optimization,
    frequencies: summarizeFrequencies(frequencyBlocks),
    raman: raman.some((mode) => mode.ramanActivity !== null) ? raman : null,
    vcd: vcdModes.some((mode) => mode.rotationalStrength !== null) ? vcdModes : null,
    vcdMeta: (() => {
      const table = parseVcdStrengths(lines.join('\n'));
      return table ? { units: table.units, dipoleUnits: table.dipoleUnits, representation: table.representation } : null;
    })(),
    frequencyBlocks,
    thermochemistry: parseThermochemistry(joined, lines),
    finalEnergy: parseFinalEnergy(joined, scf),
    composite: (() => {
      const expected = compositeMethodFromRoute(routeText);
      const summary = parseCompositeSummary(lines, startLine);
      if (!summary) return emptyComposite(expected?.id ?? null);
      return { ...summary, expected: expected?.id ?? null };
    })(),
    counterpoise: parseCounterpoise(lines, startLine, routeText),
    spinContamination: parseSpinContamination(joined),
    spinSquared: parseSpinSquared(joined),
    wavefunctionStability: parseWavefunctionStability(joined),
    excitedStates: parseExcitedStates(lines),
    charges: parseCharges(lines),
    t1Diagnostic: parseT1Diagnostic(lines),
    resources: parseResources(joined),
    error: error ? { ...error, linkIndex: index } : null,
  };
}

const THERMOCHEMISTRY_KEYS = [
  'freeEnergyHartree',
  'enthalpyHartree',
  'thermalEnergyHartree',
  'zeroPointEnergyHartree',
  'zeroPointCorrectionHartree',
  'thermalCorrectionEnergyHartree',
  'thermalCorrectionEnthalpyHartree',
  'thermalCorrectionFreeEnergyHartree',
  'zeroPointVibrationalEnergyJoulesPerMol',
  'zeroPointVibrationalEnergyKcalPerMol',
  'temperatureK',
  'pressureAtm',
];

function hasThermochemistry(thermochemistry) {
  return THERMOCHEMISTRY_KEYS.some((key) => thermochemistry[key] !== null);
}

/**
 * Parse one output text.
 *
 * `truncated` and `byteRange` describe how much of the file the text came from.
 * A partial parse is recorded as `complete: false`; `evaluateGates` then refuses
 * to pass it. A whole text defaults to complete because the caller supplied it
 * in full.
 *
 * Root-level records are the final/relevant-link summary; `links[]` keeps every
 * link's records so a caller can tell an intermediate Hessian from the final
 * frequency calculation.
 */
export function parseGaussianOutput(text, { truncated = false, byteRange = null } = {}) {
  if (typeof text !== 'string') throw new TypeError('Gaussian output must be text.');
  const bytes = normalizeByteRange(byteRange, truncated);
  const complete = bytes ? !bytes.truncated : !truncated;
  const lines = text.split(/\r\n|\n|\r/);
  const links = splitLinks(lines).map((section, index) => parseLink(section, index));
  const reversed = [...links].reverse();

  const errorLink = links.find((link) => link.termination === 'error') || null;
  const lastLink = links.length ? links[links.length - 1] : null;
  const terminationCode = errorLink ? 'error'
    : lastLink && lastLink.termination === 'normal' ? 'normal' : 'none';
  const status = terminationCode === 'normal' ? 'completed'
    : terminationCode === 'error' ? 'error' : 'incomplete';

  const program = links.find((link) => link.program.name !== null)?.program
    || { name: null, version: null, revision: null };

  const route = links.find((link) => link.route !== null)?.route ?? null;

  // The final geometry is the last orientation table printed by the last link
  // that has one; for an Opt this is the optimised structure.
  const geometryLink = reversed.find((link) => link.geometry.final !== null) || null;
  const geometry = geometryLink
    ? geometryLink.geometry
    : { input: null, standard: null, final: null };

  const scfLink = reversed.find((link) => link.scf.status !== 'unknown') || null;
  const scf = scfLink ? {
    status: scfLink.scf.status,
    energyHartree: scfLink.scf.energyHartree,
    cycles: scfLink.scf.cycles,
    method: scfLink.scf.method,
    failure: scfLink.scf.failure,
  } : { status: 'unknown', energyHartree: null, cycles: null, method: null, failure: null };

  // The frequency record belongs to the link that computed frequencies. A
  // flattened list across links would turn an intermediate imaginary mode into
  // a false saddle for the final structure.
  const frequencyLink = reversed.find((link) => link.frequencyBlocks.length > 0) || null;
  const frequencies = frequencyLink
    ? summarizeFrequencies(frequencyLink.frequencyBlocks)
    : emptyFrequencySummary();

  const thermochemistryLink = reversed.find((link) => hasThermochemistry(link.thermochemistry))
    || lastLink;
  const thermochemistry = thermochemistryLink
    ? thermochemistryLink.thermochemistry
    : parseThermochemistry('', ['']);

  const finalEnergyLink = reversed.find((link) => link.finalEnergy.hartree !== null) || null;
  // Issue #77: a composite route's answer is its method-specific summary, not
  // the last SCF or post-HF record of an intermediate link. If the summary is
  // absent, the composite energy is unknown — never the component energy.
  const compositeLink = reversed.find((link) => link.composite.found || link.composite.expected !== null) || null;
  const composite = compositeLink ? compositeLink.composite : null;
  const counterpoiseLink = reversed.find((link) => link.counterpoise !== null) || null;
  const counterpoise = counterpoiseLink ? counterpoiseLink.counterpoise : null;
  let finalEnergy;
  if (composite?.expected) {
    const hartree = composite.found && Number.isFinite(composite.zeroPointEnergyHartree)
      ? composite.zeroPointEnergyHartree
      : null;
    finalEnergy = {
      hartree,
      source: hartree === null ? null : `composite:${composite.method || composite.expected}`,
    };
  } else if (counterpoise?.found && Number.isFinite(counterpoise.complexEnergyHartree)) {
    finalEnergy = { hartree: counterpoise.complexEnergyHartree, source: 'counterpoise-corrected' };
  } else if (counterpoise && counterpoise.fragments !== null) {
    // The route asked for a correction but the summary is missing; the SCF
    // energy of the complex is uncorrected, so it is not this job's answer.
    finalEnergy = { hartree: null, source: null };
  } else {
    finalEnergy = finalEnergyLink
      ? { hartree: finalEnergyLink.finalEnergy.hartree, source: finalEnergyLink.finalEnergy.source }
      : { hartree: null, source: null };
  }

  const optimizationLink = reversed.find((link) => link.optimization.steps !== null) || null;
  const optimization = {
    completed: links.some((link) => link.optimization.completed),
    stationary: links.some((link) => link.optimization.stationary),
    cycles: optimizationLink ? optimizationLink.optimization.cycles : null,
    steps: optimizationLink ? optimizationLink.optimization.steps : null,
    convergence: optimizationLink ? optimizationLink.optimization.convergence : null,
  };

  // Population records are scoped per link; the root summary takes the latest
  // link that actually printed each block.
  const charges = emptyCharges();
  for (const key of ['mulliken', 'lowdin', 'nbo', 'esp', 'hirshfeld']) {
    const link = reversed.find((entry) => entry.charges[key].length > 0);
    if (link) charges[key] = link.charges[key];
  }
  const dipoleLink = reversed.find((link) => link.charges.dipole !== null) || null;
  charges.dipole = dipoleLink ? dipoleLink.charges.dipole : null;

  const t1Link = reversed.find((link) => link.t1Diagnostic !== null) || null;
  const resourcesLink = reversed.find((link) => link.resources.nBasis !== null
    || link.resources.processors !== null
    || link.resources.cpuSeconds !== null) || null;
  const errorTermination = errorLink ? errorLink.error : null;
  // Unrestricted references print one line, e.g.
  //   S**2 before annihilation     0.7531,   after     0.7500
  // A restricted reference prints none: S**2 is exact by construction.
  const spinLink = reversed.find((link) => link.spinContamination.before !== null
    || link.spinContamination.after !== null) || null;
  const spinContamination = spinLink
    ? spinLink.spinContamination
    : { before: null, after: null };
  // ⟨S²⟩ of the converged wavefunction: the annihilated value when Gaussian
  // printed one, otherwise the value on the SCF line, otherwise null.
  const spinSquaredLink = reversed.find((link) => link.spinSquared?.value !== null
    && link.spinSquared?.value !== undefined) || null;
  const stabilityLink = reversed.find((link) => link.wavefunctionStability?.stable !== null
    && link.wavefunctionStability?.stable !== undefined) || null;
  const wavefunctionStability = stabilityLink ? stabilityLink.wavefunctionStability : { stable: null, detail: null };
  const spinSquared = spinContamination.after !== null
    ? { value: spinContamination.after, source: 'after-annihilation', s: null }
    : spinSquaredLink
      ? { ...spinSquaredLink.spinSquared, source: 'scf' }
      : { value: null, source: null, s: null };

  // Excited states belong to the last link that printed a TD table.
  const excitedLink = reversed.find((link) => link.excitedStates.count > 0) || null;
  const excitedStates = excitedLink ? excitedLink.excitedStates : emptyExcitedStates();

  // Reaction-path and scan tables are printed once per job by the link that ran
  // them; absence means the job was neither, which is not an empty path.
  const reactionPath = parseIrcSummary(text);
  const scan = parseScanSummary(text);
  const nmr = parseShieldings(text);
  // Normal-mode vectors: only the modes whose displacement block is complete are
  // offered for animation, and the count of the rest is kept so the viewer can
  // say what it is not showing.
  // Optimisation geometries: bounded so a long optimisation cannot bloat the
  // run record; the number left out is stated rather than silently dropped.
  const parsedTrajectory = parseTrajectory(text);
  const TRAJECTORY_LIMIT = 80;
  const trajectory = parsedTrajectory && parsedTrajectory.steps.length > TRAJECTORY_LIMIT
    ? {
      ...parsedTrajectory,
      steps: parsedTrajectory.steps.slice(-TRAJECTORY_LIMIT),
      dropped: parsedTrajectory.steps.length - TRAJECTORY_LIMIT,
    }
    : parsedTrajectory;
  const parsedModes = parseNormalModes(text);
  const normalModes = parsedModes ? animatableModes(parsedModes) : null;
  // Raman rows come from the same frequency section the summary was built
  // from, so they are attached to that section's modes and never to another
  // link's.
  const ramanModes = attachRaman(
    (frequencyLink?.frequencyBlocks?.at(-1)?.values || []).map((wavenumber) => ({ wavenumber })),
    parseRamanActivities(text),
  );
  const raman = ramanModes.some((mode) => mode.ramanActivity !== null) ? ramanModes : null;
  // VCD (#78) sits in the same frequency section: rotational strengths per
  // mode, signed, with the dipole strength and E-M angle Gaussian prints
  // beside them. Null means the route did not ask for VCD, never "all zero".
  const vcdTable = parseVcdStrengths(text);
  const vcdModes = attachVcd(
    (frequencyLink?.frequencyBlocks?.at(-1)?.values || []).map((wavenumber) => ({ wavenumber })),
    vcdTable,
  );
  const vcd = vcdModes.some((mode) => mode.rotationalStrength !== null) ? vcdModes : null;
  // Units and representation belong to the table, not to a mode: a reader has to
  // be able to say which convention produced these numbers, and Gaussian 16
  // prints the unit without naming a representation.
  const vcdMeta = vcdTable
    ? { units: vcdTable.units, dipoleUnits: vcdTable.dipoleUnits, representation: vcdTable.representation }
    : null;
  // ECD (#75): only a chiral TD job prints non-zero rotatory strengths, but the
  // table is present whenever the route asks for it. Null means "not printed".
  const rotatoryStrengths = parseRotatoryStrengths(text);
  // Frontier orbitals (#88): printed only when the route asked for Pop=Full.
  // `matched: false` means the print is absent, not that the gap is zero.
  const orbitals = parseOrbitals(text);

  return {
    status,
    termination: terminationCode === 'normal'
      ? 'Normal termination of Gaussian'
      : terminationCode === 'error' ? 'Error termination' : 'No termination marker',
    program,
    route,
    scf,
    optimization,
    geometry,
    finalGeometry: geometry.final,
    frequencies,
    raman,
    vcd,
    // The table carries the unit string and (when a revision prints one) the
    // velocity/length representation; the card must not re-invent either.
    vcdTable: vcdTable
      ? {
        units: vcdTable.units,
        dipoleUnits: vcdTable.dipoleUnits,
        representation: vcdTable.representation,
        modeCount: vcdTable.rotationalStrengths.length,
      }
      : null,
    rotatoryStrengths,
    orbitals,
    thermochemistry,
    finalEnergy,
    composite,
    counterpoise,
    spinContamination,
    spinSquared,
    wavefunctionStability,
    excitedStates,
    reactionPath,
    scan,
    nmr,
    trajectory,
    normalModes,
    normalModesMeta: parsedModes
      ? {
        modeCount: parsedModes.modeCount,
        incomplete: parsedModes.incomplete,
        atomCount: parsedModes.atomCount,
        // The full table as printed, including modes the viewer cannot animate.
        // Index-aligned with each other, so a converter can pair a wavenumber
        // with its IR intensity without assuming the filtered list kept order.
        frequencies: parsedModes.frequencies,
        irIntensities: parsedModes.irIntensities,
      }
      : null,
    charges,
    t1Diagnostic: t1Link ? t1Link.t1Diagnostic : null,
    resources: resourcesLink ? resourcesLink.resources : emptyResources(),
    errorTermination,
    links,
    complete,
    bytes,
    lineCount: lines.length,
  };
}

/**
 * A composite gate expects a *method*, not just an energy: a log whose summary
 * says G3 cannot satisfy a G4 block. `compositeMethodFor` canonicalises both
 * spellings of G4(MP2).
 */
function compositeNameMatches(record, expected) {
  if (!record?.method) return false;
  const target = compositeMethodFor(expected)?.id || String(expected).trim();
  return String(record.method).toLowerCase() === String(target).toLowerCase();
}

/**
 * Evaluate the first-slice gates. A missing or unjudgeable value is `unknown`,
 * never `pass`. `expectedImaginary` is null when the route has no frequency
 * interpretation.
 *
 * Termination is read through the canonical `terminationCodeOf()` so the same
 * gates work for any engine. Root-level fields are already scoped to the
 * relevant link by `parseGaussianOutput`, so the gate never aggregates steps.
 *
 * `validity` is an optional list of validity-check findings (issue #25). They
 * are summarised under `gates.validity` and deliberately do not change
 * `gates.overall`: a run can execute correctly and still be scientifically
 * unsupported, and the record says both things separately.
 */
export function evaluateGates(parsed, {
  expectedImaginary = null,
  minMagnitude = 50,
  requireOptimization = false,
  requireFrequency = false,
  requireThermochemistry = false,
  requireFinalEnergy = false,
  requireComposite = null,
  validity = null,
  dispersion = null,
  requireStableWavefunction = false,
} = {}) {
  const gates = [];
  const add = (name, required, result, detail) => {
    gates.push({ name, required, result, detail: detail || null });
  };

  const complete = parsed.complete === true;
  const bytes = parsed.bytes || null;
  const byteDetail = bytes && Number.isFinite(bytes.bytesRead)
    ? `read ${bytes.bytesRead} of ${bytes.size ?? '?'} bytes${Array.isArray(bytes.windows) && bytes.windows.length ? ` (${bytes.windows.map((window) => window.name).join('+')})` : ''}`
    : 'the parse does not cover the whole output';
  add('Output complete', true, complete ? 'pass' : 'unknown',
    complete ? (bytes && Number.isFinite(bytes.bytesRead) ? byteDetail : 'full output parsed') : byteDetail);

  if (requireStableWavefunction) {
    const stability = parsed.wavefunctionStability || { stable: null, detail: null };
    add('Wavefunction stability', true,
      stability.stable === true ? 'pass' : stability.stable === false ? 'fail' : 'unknown',
      stability.stable === null
        ? 'no stability analysis in this output, so stability was not confirmed'
        : stability.stable ? 'the wavefunction is stable under the perturbations considered'
          : 'the wavefunction is unstable; re-run with Stable=Opt to re-optimise under the stable solution');
  }

  const dispersionCheck = dispersion ? dispersionSupport(parsed.program, dispersion) : null;
  if (dispersionCheck && dispersionCheck.status !== 'ok') {
    add('Dispersion supported', true,
      dispersionCheck.status === 'unsupported' ? 'fail' : 'unknown',
      dispersionCheck.detail);
  }

  const termination = terminationCodeOf(parsed);
  add('Normal termination', true,
    termination === 'normal' ? 'pass'
      : termination === 'error' ? 'fail' : 'unknown',
    parsed.termination);

  const scfApplicable = parsed.scf?.applicable !== false;
  const finalEnergyRecorded = Number.isFinite(parsed.finalEnergy?.hartree);
  add('SCF record', true,
    !scfApplicable
      ? (parsed.extras?.runtimeException ? 'fail' : finalEnergyRecorded ? 'pass' : 'unknown')
      : parsed.scf.status === 'converged' ? 'pass'
        : parsed.scf.status === 'failed' ? 'fail' : 'unknown',
    !scfApplicable
      ? (parsed.extras?.runtimeException
        ? (parsed.extras.runtimeExceptionDetail || 'xTB runtime exception')
        : `${parsed.finalEnergy?.hartree ?? '?'} Eh; SCF not applicable to this method`)
      : parsed.scf.status === 'converged'
        ? `${parsed.scf.energyHartree ?? '?'} Eh after ${parsed.scf.cycles ?? '?'} cycles`
        : parsed.scf.status);

  if (requireOptimization) {
    add('Optimization completed', true,
      parsed.optimization.completed ? 'pass' : 'unknown',
      parsed.optimization.completed ? 'Optimization completed' : null);
  }

  if (expectedImaginary !== null) {
    const invalid = parsed.frequencies.invalid === true;
    const countPass = invalid ? false
      : Number.isInteger(expectedImaginary) && parsed.frequencies.count > 0
        ? parsed.frequencies.imaginaryCount === expectedImaginary
        : null;
    add('Imaginary mode count', true,
      countPass === true ? 'pass' : countPass === false ? 'fail' : 'unknown',
      invalid
        ? `non-finite frequency token(s): ${parsed.frequencies.invalidTokens?.join(' ') || 'invalid data'}`
        : `expected ${expectedImaginary}, found ${parsed.frequencies.imaginaryCount}`);

    if (expectedImaginary > 0) {
      const floor = Number.isFinite(Number(minMagnitude)) ? Number(minMagnitude) : 0;
      const magnitude = parsed.frequencies.minImaginary === null
        ? null : Math.abs(parsed.frequencies.minImaginary);
      add('Imaginary magnitude', true,
        magnitude === null ? 'unknown' : magnitude >= floor ? 'pass' : 'fail',
        magnitude === null ? null : `${magnitude.toFixed(1)} cm^-1 (floor ${floor})`);
    }
  }

  if (requireFrequency) {
    const invalid = parsed.frequencies.invalid === true;
    add('Frequency record', true,
      invalid ? 'fail' : parsed.frequencies.count > 0 ? 'pass' : 'unknown',
      invalid
        ? `non-finite frequency token(s): ${parsed.frequencies.invalidTokens?.join(' ') || 'invalid data'}`
        : `${parsed.frequencies.count} modes`);
  }

  if (requireThermochemistry) {
    add('Thermochemistry record', true,
      parsed.thermochemistry.freeEnergyHartree !== null ? 'pass' : 'unknown',
      parsed.thermochemistry.freeEnergyHartree !== null ? 'free energy parsed' : null);
  }

  if (requireFinalEnergy) {
    const finalEnergy = parsed.finalEnergy || { hartree: null, source: null };
    add('Final energy record', true,
      finalEnergy.hartree !== null ? 'pass' : 'unknown',
      finalEnergy.hartree !== null ? `${finalEnergy.hartree} Eh (${finalEnergy.source})` : null);
  }

  // Issue #77: when the route names a composite method, its summary is the
  // only acceptable final answer. A log that contains SCF or post-HF energies
  // from the component links but no composite summary must not pass on one of
  // those component energies — that is the exact failure this gate exists for.
  const compositeRecord = parsed.composite || null;
  const compositeExpected = requireComposite === true
    ? compositeRecord?.expected ?? null
    : typeof requireComposite === 'string' && requireComposite.trim() !== ''
      ? requireComposite.trim()
      : compositeRecord?.expected ?? null;
  if (compositeExpected) {
    const matches = compositeNameMatches(compositeRecord, compositeExpected);
    const compositeEnergy = compositeRecord?.zeroPointEnergyHartree;
    const judged = matches && Number.isFinite(compositeEnergy);
    let result;
    let detail;
    if (judged) {
      result = 'pass';
      detail = `${compositeEnergy} Eh (${compositeRecord.method} 0 K composite energy)`;
    } else if (!complete) {
      result = 'unknown';
      detail = `the output is incomplete, so the ${compositeExpected} composite summary cannot be confirmed`;
    } else if (termination === 'error') {
      result = 'fail';
      detail = `the run terminated with an error before printing a ${compositeExpected} composite summary`;
    } else if (termination === 'none') {
      result = 'unknown';
      detail = `the output has no termination marker and no ${compositeExpected} composite summary`;
    } else if (compositeRecord?.found) {
      result = 'fail';
      detail = `the log printed a ${compositeRecord.method} summary, but this block is ${compositeExpected};`
        + ' a different composite method is not this block\'s result';
    } else {
      result = 'fail';
      detail = `the log terminated normally but printed no ${compositeExpected} composite summary;`
        + ' the SCF or post-HF energy it contains is a component link, not the composite result';
    }
    add('Composite energy', true, result, detail);
  }

  const required = gates.filter((gate) => gate.required);
  const evaluated = required.some((gate) => gate.result === 'fail') ? 'fail'
    : required.every((gate) => gate.result === 'pass') ? 'pass' : 'unknown';
  // Structural guard: no partial parse can ever report a pass, whatever else it found.
  const overall = evaluated === 'pass' && !complete ? 'unknown' : evaluated;
  return {
    overall,
    gates,
    complete,
    // Null means validity checks were not run for this job (for example an
    // engine other than Gaussian); it is never reported as a pass.
    validity: validity === null ? null : summarizeValidity(validity),
  };
}
