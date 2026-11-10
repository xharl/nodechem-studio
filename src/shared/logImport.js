/**
 * Batch import of existing log files.
 *
 * The point is to answer "what is in this folder?" without opening each file:
 * one row per log with its status, level of theory, energy and the failure
 * cause, built from the same parser a live run uses. Nothing is imported into a
 * project here — this is a read-only index.
 *
 * A file is parsed as Gaussian unless it identifies itself as xTB. A log that
 * cannot be parsed at all still gets a row with `status: 'unreadable'`, so the
 * table never silently drops a file.
 */

import { parseGaussianOutput } from './gaussianOutput.js';
import { parseXtbOutput } from './engines/xtb.js';
import { parseOrcaOutput } from './engines/orca.js';
import { parsePsi4Output } from './engines/psi4.js';
import { parsePyscfOutput } from './engines/pyscf.js';

export const BATCH_IMPORT_LIMIT = 500;
export const BATCH_MAX_LOG_BYTES = 32 * 1024 * 1024;

const JOB_WORDS = Object.freeze([
  'Opt=TS', 'Opt Freq', 'Opt', 'Freq', 'IRC', 'Scan', 'SP', 'TD',
]);

function text(value) {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * `#p B3LYP/def2-SVP Opt EmpiricalDispersion=GD3BJ` → method, basis and the
 * job keyword. Only the first `method/basis` token is read; anything the route
 * expresses differently is left null rather than guessed.
 */
export function parseRouteSummary(route) {
  const raw = text(route);
  if (!raw) return { method: null, basis: null, jobType: null };
  const tokens = raw.replace(/^#\w*\s*/i, '').split(/\s+/).filter(Boolean);
  let method = null;
  let basis = null;
  for (const token of tokens) {
    if (token.includes('/') && !token.startsWith('%')) {
      const [left, ...rest] = token.split('/');
      method = left || null;
      basis = rest.join('/') || null;
      break;
    }
  }
  const upper = raw.toUpperCase();
  const jobType = JOB_WORDS.find((word) => upper.includes(word.toUpperCase())) || null;
  return { method, basis, jobType };
}

function isXtb(textValue) {
  return /xtb version|normal termination of xtb|^\s*\*\s*xtb\s*$/im.test(textValue);
}

/**
 * ORCA's banner, version line or either termination line. Checked before the
 * Gaussian branch: an ORCA log is long and free-form enough that the Gaussian
 * parser would accept parts of it and return a row full of nulls, which reads
 * like a broken Gaussian run instead of "this is not a Gaussian log".
 */
function isOrca(textValue) {
  return /\*\s*O\s{2,}R\s{2,}C\s{2,}A\s*\*|ORCA TERMINATED NORMALLY|ORCA finished by error termination|Program Version\s+\d[^\r\n]*RELEASE/i
    .test(textValue);
}

/**
 * Psi4's banner or its termination lines. Checked before the Gaussian branch for
 * the same reason as ORCA: Psi4 output is long and loosely structured, and the
 * Gaussian parser would return a row of nulls instead of "this is not Gaussian".
 */
function isPsi4(textValue) {
  return /Psi4:\s*An Open-Source Ab Initio Electronic Structure Package|Psi4 exiting successfully|Psi4 encountered an error/i
    .test(textValue);
}

/**
 * PySCF's result record. The deck writes a schema-tagged JSON document, so a
 * log is PySCF when the record is present; PySCF's own printed text alone is
 * not enough to claim it (it has no stable banner contract here).
 */
function isPyscf(textValue) {
  return /NCS-PYSCF-RESULT-BEGIN|"schema"\s*:\s*"nodechem\.pyscf\.v1"/i.test(textValue);
}

/**
 * One log text → one index row.
 *
 * @param {string} source the file text
 * @param {{name?: string, bytes?: number|null}} file
 */
export function summarizeLog(source, { name = '', bytes = null } = {}) {
  const content = typeof source === 'string' ? source : '';
  const row = {
    name: String(name || ''),
    bytes: num(bytes),
    engine: null,
    status: 'unreadable',
    termination: null,
    program: null,
    method: null,
    basis: null,
    jobType: null,
    finalEnergyHartree: null,
    gibbsHartree: null,
    imaginaryCount: null,
    scfCycles: null,
    errorCause: null,
    lineCount: null,
  };
  if (content.trim() === '') {
    row.errorCause = 'The file is empty.';
    return row;
  }

  if (isXtb(content)) {
    let parsed;
    try {
      parsed = parseXtbOutput(content);
    } catch (error) {
      row.errorCause = `xTB output could not be parsed: ${error.message}`;
      return row;
    }
    const hamiltonian = parsed.extras?.hamiltonian || parsed.scf?.method || null;
    return {
      ...row,
      engine: 'xtb',
      status: parsed.status,
      termination: parsed.termination,
      program: parsed.program?.name ? `${parsed.program.name} ${parsed.program.version || ''}`.trim() : null,
      method: hamiltonian,
      jobType: null,
      finalEnergyHartree: num(parsed.finalEnergy?.hartree),
      gibbsHartree: num(parsed.thermochemistry?.freeEnergyHartree),
      imaginaryCount: Number.isInteger(parsed.frequencies?.imaginaryCount) ? parsed.frequencies.imaginaryCount : null,
      scfCycles: Number.isInteger(parsed.scf?.cycles) ? parsed.scf.cycles : null,
      errorCause: parsed.terminationCode === 'error' ? (parsed.termination || null) : null,
      lineCount: Number.isInteger(parsed.lineCount) ? parsed.lineCount : content.split(/\r\n|\n|\r/).length,
    };
  }

  if (isPyscf(content)) {
    let parsed;
    try {
      parsed = parsePyscfOutput(content);
    } catch (error) {
      row.errorCause = `PySCF output could not be parsed: ${error.message}`;
      return row;
    }
    return {
      ...row,
      engine: 'pyscf',
      status: parsed.status,
      termination: parsed.termination,
      program: parsed.program?.name
        ? `${parsed.program.name} ${parsed.program.version || ''}`.trim()
        : null,
      method: parsed.extras?.method ?? null,
      basis: parsed.extras?.basis ?? null,
      jobType: parsed.extras?.jobType ?? null,
      finalEnergyHartree: num(parsed.finalEnergy?.hartree),
      gibbsHartree: num(parsed.thermochemistry?.freeEnergyHartree),
      imaginaryCount: Number.isInteger(parsed.frequencies?.imaginaryCount)
        ? parsed.frequencies.imaginaryCount : null,
      scfCycles: Number.isInteger(parsed.scf?.cycles) ? parsed.scf.cycles : null,
      errorCause: parsed.status === 'error' ? (parsed.extras?.errorDetail || parsed.termination) : null,
      lineCount: Number.isInteger(parsed.lineCount) ? parsed.lineCount : content.split(/\r\n|\n|\r/).length,
    };
  }

  if (isPsi4(content)) {
    let parsed;
    try {
      parsed = parsePsi4Output(content);
    } catch (error) {
      row.errorCause = `Psi4 output could not be parsed: ${error.message}`;
      return row;
    }
    return {
      ...row,
      engine: 'psi4',
      status: parsed.status,
      termination: parsed.termination,
      program: parsed.program?.name
        ? `${parsed.program.name} ${parsed.program.version || ''}`.trim()
        : null,
      method: parsed.extras?.method ?? null,
      basis: parsed.extras?.basis ?? null,
      jobType: parsed.optimization?.attempted ? 'Opt' : parsed.frequencies?.count > 0 ? 'Freq' : 'SP',
      finalEnergyHartree: num(parsed.finalEnergy?.hartree),
      gibbsHartree: num(parsed.thermochemistry?.freeEnergyHartree),
      imaginaryCount: Number.isInteger(parsed.frequencies?.imaginaryCount)
        ? parsed.frequencies.imaginaryCount : null,
      scfCycles: Number.isInteger(parsed.scf?.cycles) ? parsed.scf.cycles : null,
      errorCause: parsed.status === 'error' ? (parsed.extras?.errorDetail || parsed.termination) : null,
      lineCount: Number.isInteger(parsed.lineCount) ? parsed.lineCount : content.split(/\r\n|\n|\r/).length,
    };
  }

  if (isOrca(content)) {
    let parsed;
    try {
      parsed = parseOrcaOutput(content);
    } catch (error) {
      row.errorCause = `ORCA output could not be parsed: ${error.message}`;
      return row;
    }
    return {
      ...row,
      engine: 'orca',
      status: parsed.status,
      termination: parsed.termination,
      program: parsed.program?.name
        ? `${parsed.program.name} ${parsed.program.version || ''}`.trim()
        : null,
      method: parsed.scf?.method ?? null,
      basis: parsed.extras?.basis ?? null,
      jobType: parsed.extras?.jobType ?? null,
      finalEnergyHartree: num(parsed.finalEnergy?.hartree),
      gibbsHartree: num(parsed.thermochemistry?.freeEnergyHartree),
      imaginaryCount: Number.isInteger(parsed.frequencies?.imaginaryCount)
        ? parsed.frequencies.imaginaryCount : null,
      scfCycles: Number.isInteger(parsed.scf?.cycles) ? parsed.scf.cycles : null,
      errorCause: parsed.extras?.errorModule
        ? `ORCA finished by error termination in ${parsed.extras.errorModule}` : null,
      lineCount: Number.isInteger(parsed.lineCount) ? parsed.lineCount : content.split(/\r\n|\n|\r/).length,
    };
  }

  let parsed;
  try {
    parsed = parseGaussianOutput(content);
  } catch (error) {
    row.errorCause = `Gaussian output could not be parsed: ${error.message}`;
    return row;
  }
  const route = parseRouteSummary(parsed.route);
  return {
    ...row,
    engine: 'gaussian',
    status: parsed.status,
    termination: parsed.termination,
    program: parsed.program?.name
      ? `${parsed.program.name} ${parsed.program.version || ''}`.trim()
      : null,
    method: route.method,
    basis: route.basis,
    jobType: route.jobType,
    finalEnergyHartree: num(parsed.finalEnergy?.hartree ?? parsed.scf?.energyHartree),
    gibbsHartree: num(parsed.thermochemistry?.freeEnergyHartree),
    imaginaryCount: Number.isInteger(parsed.frequencies?.imaginaryCount)
      ? parsed.frequencies.imaginaryCount : null,
    scfCycles: Number.isInteger(parsed.scf?.cycles) ? parsed.scf.cycles : null,
    errorCause: parsed.errorTermination?.cause ?? null,
    lineCount: Number.isInteger(parsed.lineCount) ? parsed.lineCount : null,
  };
}

export function summarizeLogs(entries) {
  const rows = (Array.isArray(entries) ? entries : [])
    .slice(0, BATCH_IMPORT_LIMIT)
    .map((entry) => summarizeLog(entry?.text ?? '', { name: entry?.name, bytes: entry?.bytes }));
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return {
    rows,
    counts: {
      total: rows.length,
      completed: rows.filter((row) => row.status === 'completed').length,
      error: rows.filter((row) => row.status === 'error').length,
      incomplete: rows.filter((row) => row.status === 'incomplete').length,
      unreadable: rows.filter((row) => row.status === 'unreadable').length,
    },
  };
}
