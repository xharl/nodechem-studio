/**
 * ORCA property blocks the energy/frequency parser does not read: the
 * hyperfine tensor (EPR) and the isotropic spin-spin coupling summary (NMR).
 *
 * ## Why this module exists
 *
 * `orca.js` answers "did the job finish, what was the energy, did it optimise".
 * An ORCA EPR or NMR job prints its magnetic properties in separate blocks after
 * the SCF, and those blocks were previously dropped: a user saw an EPR run with
 * no couplings and had no way to tell whether ORCA computed them. This module
 * reads them into the two record shapes the app already has, so the existing
 * EPR and NMR cards and the workflow report render ORCA numbers without a new
 * consumer:
 *
 *   - `parseOrcaHyperfine` → the `hyperfine[]` rows `epr.js` produces
 *     (`aIsoMhz`, `aIsoGauss`, isotope and spin). The dipolar components and
 *     the total tensor are kept beside the isotropic value because ORCA prints
 *     them and a card that showed only the trace would hide what it read.
 *   - `parseOrcaSpinSpin` → the `couplings` object `nmr.js` produces
 *     (`matrix`, `kMatrix`, units, convention, indexing). ORCA prints a full
 *     symmetric J table; it prints no reduced K table in the logs this parser
 *     was written against, so `kMatrix` is `null` and the record says why.
 *
 * ## What is read, exactly
 *
 * Hyperfine (ORCA 6.0.0, `NH2_A.out`):
 *
 *   Nucleus   0N : A  : Isotope=   14 I=  1.0 P= 38.5677 MHz/au**3
 *   Total HFC matrix (all values in MHz):
 *   A(FC) … A(SD) … A(ORB+DIA) … A(Tot) … A(iso)=   28.4976
 *
 * `A(iso)` is the printed isotropic value and is what `aIsoMhz` carries. The
 * sign is the log's own: ORCA states the A matrix conforms to the "SAI" spin
 * Hamiltonian convention and is right-handed, and nothing here flips a sign.
 * `A(SD)` is the spin-dipolar tensor's principal values in MHz; the full 3×3
 * `Total HFC matrix` is kept as printed. The trace of that matrix divided by 3
 * is an independent route to the same isotropic value, and the module reports
 * the worst deviation between the two (issue 222, requirement 3).
 *
 * Spin-spin (ORCA 5.0.4, `dvb_coupling_nmr.out`):
 *
 *   SUMMARY OF ISOTROPIC COUPLING CONSTANTS (Hz)
 *     0 C   0.000   9.451 …
 *     1 C   9.451   0.000 …
 *
 * The summary is a full matrix in 0-based nucleus order, printed in column
 * chunks of six. `matrix[i*atoms + j]` is J in Hz. ORCA also prints each pair's
 * own `Total … iso=` value in the pair blocks, which is the same quantity
 * printed twice; the parser checks the two against each other and reports the
 * worst deviation. The per-pair `gnA`/`gnB` constants are checked against the
 * app's isotope table. No reduced K table is printed, so `kMatrix` stays null
 * and `kUnits` says so rather than inventing a conversion.
 *
 * ## Refusals
 *
 * A log with `Hyperfine couplings ... NO` has no hyperfine section, and the
 * parser returns null — the record carries no `epr` key, never a table of
 * zeros. A log that says YES but does not print the nuclei is refused by name
 * with the count it declared and the count it read. The same rule holds for the
 * coupling summary: no request and no table means absent; a request with no
 * table means `couplings: null` plus a `couplingsError` naming the missing
 * line.
 *
 * ## What this module does not do
 *
 * It does not compute a hyperfine tensor, a g-tensor, a shielding or a coupling
 * constant — it reads what ORCA printed. It does not convert K into J or J into
 * K. `parseOrcaShieldings` reads the isotropic/anisotropy summary ORCA prints
 * (`CHEMICAL SHIELDING SUMMARY`); the chemical shift itself is not computed
 * here, because that needs a reference at the same level of theory. It does not
 * read the STEOM-CCSD/NTO output named in the issue; that is a different
 * property and is refused by omission here.
 */

import { atomicNumber } from '../elements.js';
import {
  G_ELECTRON,
  GAUSS_PER_MHZ,
  MU_BOHR,
  NUCLEAR_ISOTOPES,
  PLANCK,
  mhzToGauss,
} from '../epr.js';
import { couplingSummary } from '../nmr.js';

const NUMBER = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][-+]?\d+)?`;
const NUMBER_RE = new RegExp(`^${NUMBER}$`);
const ELEMENT = '[A-Z][a-z]?';
const ELEMENT_RE = new RegExp(`^${ELEMENT}$`);

/** The SAI convention ORCA prints above every hyperfine block. */
export const ORCA_HYPERFINE_CONVENTION = 'A matrix conforms to the "SAI" spin Hamiltonian '
  + 'convention; tensor is right-handed; sign as printed, never normalised';

/**
 * ORCA's own nucleus numbering. This is the field that prevents a consumer from
 * shifting every coupling pair by one: Gaussian tables in this app are 1-based,
 * ORCA's summary is 0-based.
 */
export const ORCA_COUPLING_INDEXING = 'ORCA numbers nuclei from 0 in input order: matrix '
  + 'row/column k and pair indices i,j are 0-based, so nucleus k is geometry.atoms[k] (the '
  + 'record geometry is 0-based). Gaussian tables in this app are 1-based; do not add 1 to '
  + 'these indices.';

/** The gauss-per-MHz factor implied by g_e = 2.0023, the value the issue names. */
export const GAUSS_PER_MHZ_GE_20023 = (PLANCK * 1e6) / (2.0023 * MU_BOHR) * 1e4;

/** `0.926067D+01` or `-13.4` → a number, or null when the token is not one. */
function orcaNumber(token) {
  if (token === undefined || token === null) return null;
  const value = Number(String(token).replace(/[Dd]/, 'E'));
  return Number.isFinite(value) ? value : null;
}

function splitLines(text) {
  return String(text ?? '').split(/\r\n|\n|\r/);
}

/** Three numeric rows, starting at `start`, skipping dashed rules and blanks. */
function readMatrixRows(lines, start, count = 3) {
  const rows = [];
  let index = start;
  while (index < lines.length && rows.length < count) {
    const trimmed = lines[index].trim();
    if (trimmed === '' || /^-{5,}$/.test(trimmed)) {
      index += 1;
      continue;
    }
    const tokens = trimmed.split(/\s+/);
    if (tokens.length === 3 && tokens.every((token) => NUMBER_RE.test(token))) {
      rows.push(tokens.map(orcaNumber));
      index += 1;
      continue;
    }
    break;
  }
  return { rows, next: index };
}

const HYPERFINE_PRESENCE = /^\s*Hyperfine couplings\s+\.{3}\s+([A-Za-z]+)\s*(?:\(\s*(\d+)\s+nuclei\s*\))?/;
const HYPERFINE_SECTION = /^\s*ELECTRIC AND MAGNETIC HYPERFINE STRUCTURE\b/;
const HYPERFINE_NUCLEUS = new RegExp(
  String.raw`^\s*Nucleus\s+(\d+)\s*(${ELEMENT})\s*:\s*A\s*:\s*Isotope=\s*(\d+)\s+I=\s*(${NUMBER})\s+P=\s*(${NUMBER})\s+MHz/au\*\*3`,
);
const HFC_MATRIX_HEADER = /^\s*Total HFC matrix \(all values in MHz\)\s*:/i;
const HFC_ROW = new RegExp(
  String.raw`^\s*A\((FC|SD|ORB\+DIA|ORB|DIA|Tot)\)\s+(${NUMBER})\s+(${NUMBER})\s+(${NUMBER})`
  + String.raw`(?:\s+A\(PC\)\s*=\s*(${NUMBER}))?(?:\s+A\(iso\)=\s*(${NUMBER}))?`,
);
const RHO_ZERO = new RegExp(String.raw`^\s*RHO\(0\)=\s*(${NUMBER})\s+a\.u\.\*\*-3`);

function isotopeFor(element, massNumber) {
  const entry = NUCLEAR_ISOTOPES[element] ?? null;
  if (!entry || entry.massNumber !== massNumber) return null;
  return entry;
}

/** One `Nucleus nEl : A` block → the row the EPR card consumes. */
function hyperfineRow(block) {
  const aiso = Number.isFinite(block.rows.Tot?.iso) ? block.rows.Tot.iso : null;
  const trace = block.matrix
    ? (block.matrix[0][0] + block.matrix[1][1] + block.matrix[2][2]) / 3
    : null;
  const value = aiso ?? trace;
  const isotope = isotopeFor(block.element, block.isotope);
  const problems = [];
  if (aiso !== null && trace !== null && Math.abs(aiso - trace) > 2e-4) {
    problems.push(`A(iso) ${aiso} MHz differs from the trace of the Total HFC matrix (${trace.toFixed(6)} MHz)`);
  }
  if (value === null) {
    problems.push('the block prints neither A(iso) nor a 3x3 Total HFC matrix');
  }
  return {
    atom: block.index + 1,
    orcaIndex: block.index,
    element: block.element,
    atomicNumber: atomicNumber(block.element),
    status: value === null ? 'unreadable' : 'reported',
    massNumber: block.isotope,
    nuclearSpin: block.spin,
    gN: isotope ? isotope.gN : null,
    naturalIsotope: isotope ? isotope.natural : null,
    aIsoMhz: value,
    aIsoGauss: value === null ? null : mhzToGauss(value),
    aIsoFromTraceMHz: trace,
    aFcMHz: block.rows.FC?.values[0] ?? null,
    aSdMHz: block.rows.SD?.values ?? null,
    aSdGauss: block.rows.SD?.values?.map(mhzToGauss) ?? null,
    aOrbDiaMHz: block.rows['ORB+DIA']?.values ?? null,
    aOrbMHz: block.rows.ORB?.values ?? null,
    aDiaMHz: block.rows.DIA?.values ?? null,
    aPcMHz: block.rows['ORB+DIA']?.pc ?? null,
    aTotPrincipalMHz: block.rows.Tot?.values ?? null,
    aTensorMHz: block.matrix,
    aTensorGauss: block.matrix?.map((row) => row.map(mhzToGauss)) ?? null,
    rhoTotalBohr3: block.rho,
    pConstantMhzPerAu3: block.pConstant,
    lineNumber: block.lineNumber,
    note: problems.length ? problems.join('; ') : null,
    problems,
  };
}

/**
 * The hyperfine block, or null when the run did not ask for one.
 *
 * The presence gate is ORCA's own `Hyperfine couplings ... YES (N nuclei)`
 * line in the EPR properties block. A `NO` or a missing line returns null, so a
 * run that computed no hyperfine cannot be mistaken for a run whose couplings
 * were all zero.
 */
export function parseOrcaHyperfine(text) {
  const lines = splitLines(text);
  let presence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const match = HYPERFINE_PRESENCE.exec(lines[index]);
    if (!match) continue;
    presence = {
      requested: match[1].toUpperCase() === 'YES',
      declaredCount: match[2] === undefined ? null : Number(match[2]),
      line: lines[index].trim(),
      lineNumber: index + 1,
    };
    break;
  }
  if (!presence || !presence.requested) return null;

  const sectionIndex = lines.findIndex((line) => HYPERFINE_SECTION.test(line));
  if (sectionIndex === -1) {
    return {
      ok: false,
      requested: true,
      declaredCount: presence.declaredCount,
      reason: `the EPR properties block says "${presence.line}" at line ${presence.lineNumber}, `
        + 'but no "ELECTRIC AND MAGNETIC HYPERFINE STRUCTURE" section was found; '
        + 'the couplings are refused rather than reported as zero',
      lineNumber: presence.lineNumber,
    };
  }

  const meta = { method: null, basis: null, multiplicity: null, relativistic: null };
  const blocks = [];
  let current = null;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*Hyperfine and quadrupole coupling calculation done/i.test(line)) break;
    const nucleus = HYPERFINE_NUCLEUS.exec(line);
    if (nucleus) {
      if (current) blocks.push(current);
      current = {
        index: Number(nucleus[1]),
        element: nucleus[2],
        isotope: Number(nucleus[3]),
        spin: orcaNumber(nucleus[4]),
        pConstant: orcaNumber(nucleus[5]),
        matrix: null,
        rows: {},
        rho: null,
        lineNumber: index + 1,
      };
      continue;
    }
    if (!current) {
      const method = /^\s*Method\s*:\s*(\S+)/.exec(line);
      if (method) meta.method = method[1];
      const basis = /^\s*Basis\s*:\s*(\S+)/.exec(line);
      if (basis) meta.basis = basis[1];
      const multiplicity = /^\s*Multiplicity\s*:\s*(\d+)/.exec(line);
      if (multiplicity) meta.multiplicity = Number(multiplicity[1]);
      const relativistic = /^\s*Relativistic treatment\s*:\s*(\S+)/.exec(line);
      if (relativistic) meta.relativistic = relativistic[1];
      continue;
    }
    if (HFC_MATRIX_HEADER.test(line)) {
      const { rows } = readMatrixRows(lines, index + 1, 3);
      if (rows.length === 3) current.matrix = rows;
      continue;
    }
    const row = HFC_ROW.exec(line);
    if (row) {
      current.rows[row[1]] = {
        values: [orcaNumber(row[2]), orcaNumber(row[3]), orcaNumber(row[4])],
        pc: row[5] === undefined ? null : orcaNumber(row[5]),
        iso: row[6] === undefined ? null : orcaNumber(row[6]),
      };
      continue;
    }
    const rho = RHO_ZERO.exec(line);
    if (rho) current.rho = orcaNumber(rho[1]);
  }
  if (current) blocks.push(current);

  if (blocks.length === 0) {
    return {
      ok: false,
      requested: true,
      declaredCount: presence.declaredCount,
      reason: `the EPR properties block says "${presence.line}" at line ${presence.lineNumber}, `
        + 'but no "Nucleus nEl : A : Isotope= ..." block was read; the couplings are '
        + 'refused rather than reported as zero',
      lineNumber: presence.lineNumber,
    };
  }
  if (presence.declaredCount !== null && blocks.length !== presence.declaredCount) {
    return {
      ok: false,
      requested: true,
      declaredCount: presence.declaredCount,
      parsedCount: blocks.length,
      reason: `the EPR properties block declares ${presence.declaredCount} hyperfine nuclei, but `
        + `${blocks.length} "Nucleus nEl : A" block${blocks.length === 1 ? ' was' : 's were'} read; `
        + 'a partial hyperfine table is refused rather than presented as the whole set',
      lineNumber: presence.lineNumber,
    };
  }

  const nuclei = blocks.map(hyperfineRow);
  const unreadable = nuclei.filter((row) => row.status !== 'reported');
  if (unreadable.length > 0) {
    return {
      ok: false,
      requested: true,
      declaredCount: presence.declaredCount,
      parsedCount: nuclei.length,
      nuclei,
      reason: `nucleus ${unreadable.map((row) => `${row.element}${row.orcaIndex}`).join(', ')} `
        + 'printed neither A(iso) nor a 3x3 Total HFC matrix; no coupling is reported for it '
        + 'rather than a zero',
      lineNumber: presence.lineNumber,
    };
  }

  // Requirement 3: the log prints two independent routes to A(iso) — the
  // `A(iso)=` column and the trace of the 3x3 Total HFC matrix — and the three
  // components of A(Tot) are the sum of A(FC), A(SD) and A(ORB+DIA). Check both
  // and report the worst deviation in MHz.
  let traceCompared = 0;
  let traceWorst = 0;
  let traceWorstNucleus = null;
  let decompositionCompared = 0;
  let decompositionWorst = 0;
  let decompositionWorstNucleus = null;
  for (const row of nuclei) {
    if (row.aIsoFromTraceMHz !== null && row.aIsoMhz !== null) {
      const deviation = Math.abs(row.aIsoFromTraceMHz - row.aIsoMhz);
      traceCompared += 1;
      if (deviation > traceWorst) {
        traceWorst = deviation;
        traceWorstNucleus = `${row.element}${row.orcaIndex}`;
      }
    }
    const fc = row.aFcMHz;
    const sd = row.aSdMHz;
    const orb = row.aOrbDiaMHz;
    const total = row.aTotPrincipalMHz;
    if (fc !== null && Array.isArray(sd) && Array.isArray(orb) && Array.isArray(total)) {
      for (let component = 0; component < 3; component += 1) {
        const deviation = Math.abs(fc + sd[component] + orb[component] - total[component]);
        decompositionCompared += 1;
        if (deviation > decompositionWorst) {
          decompositionWorst = deviation;
          decompositionWorstNucleus = `${row.element}${row.orcaIndex}`;
        }
      }
    }
  }

  return {
    ok: true,
    requested: true,
    declaredCount: presence.declaredCount,
    parsedCount: nuclei.length,
    method: meta.method,
    basis: meta.basis,
    multiplicity: meta.multiplicity,
    relativistic: meta.relativistic,
    convention: ORCA_HYPERFINE_CONVENTION,
    nuclei,
    presenceLine: presence.line,
    presenceLineNumber: presence.lineNumber,
    sectionLineNumber: sectionIndex + 1,
    verification: {
      traceVsPrintedIso: {
        nucleiCompared: traceCompared,
        worstDeviationMHz: traceWorst,
        worstNucleus: traceWorstNucleus,
        statement: `${traceCompared} nuclei compared, worst |trace(A)/3 − A(iso)| = ${traceWorst} MHz`,
      },
      decompositionVsTotal: {
        componentsCompared: decompositionCompared,
        worstDeviationMHz: decompositionWorst,
        worstNucleus: decompositionWorstNucleus,
        statement: `${decompositionCompared} components compared, worst |A(FC)+A(SD)+A(ORB+DIA) − A(Tot)| = `
          + `${decompositionWorst} MHz`,
      },
      gaussConversion: {
        // The NH2 log prints only MHz. There is no gauss column to check
        // against, so this states the conversion and its constant instead of
        // pretending the log cross-checked it.
        checkedAgainstLog: false,
        reason: 'ORCA printed only MHz columns in this section; it printed no gauss column '
          + 'and no free-electron g value, so the MHz→G conversion cannot be checked against '
          + 'the log. It is arithmetic on the printed MHz value with the free-electron g value.',
        gElectron: G_ELECTRON,
        gElectronRequested: 2.0023,
        gaussPerMhz: GAUSS_PER_MHZ,
        gaussPerMhzAtGe20023: GAUSS_PER_MHZ_GE_20023,
        relativeDifference: Math.abs(GAUSS_PER_MHZ - GAUSS_PER_MHZ_GE_20023) / GAUSS_PER_MHZ_GE_20023,
        statement: `G = A[MHz] × ${GAUSS_PER_MHZ} (g_e = ${G_ELECTRON}); `
          + `with g_e = 2.0023 the factor is ${GAUSS_PER_MHZ_GE_20023}`,
      },
      signConvention: ORCA_HYPERFINE_CONVENTION,
    },
  };
}

const G_TOTAL = new RegExp(
  String.raw`^\s*g\(tot\)\s+(${NUMBER})\s+(${NUMBER})\s+(${NUMBER})\s+iso=\s*(${NUMBER})`,
);

/**
 * ORCA's `ELECTRONIC G-MATRIX` block, or null when the run printed none.
 *
 * The properties summary says `g-Tensor (aka g-matrix) ... YES`; the block that
 * follows prints the total matrix and a `g(tot) … iso=` row. Only the total is
 * read: the RMC/DSO/PSO breakdown is evidence ORCA printed, not a number this
 * record re-derives.
 */
export function parseOrcaGTensor(text) {
  const lines = splitLines(text);
  let requested = null;
  for (let index = 0; index < lines.length; index += 1) {
    const flag = /g-Tensor \(aka g-matrix\)\s+\.{3}\s+(YES|NO)/i.exec(lines[index]);
    if (!flag) continue;
    requested = flag[1].toUpperCase() === 'YES';
    break;
  }
  if (!requested) return null;

  const start = lines.findIndex((line) => /^\s*ELECTRONIC G-MATRIX\s*$/.test(line));
  if (start === -1) {
    return {
      status: 'unavailable',
      reason: 'the properties block says "g-Tensor (aka g-matrix) ... YES", but no '
        + '"ELECTRONIC G-MATRIX" section was found',
    };
  }
  const header = lines.findIndex((line, index) => index > start && /^\s*The g-matrix:\s*$/.test(line));
  if (header === -1) {
    return {
      status: 'unavailable',
      reason: 'the "ELECTRONIC G-MATRIX" section was found, but it carries no "The g-matrix:" rows',
    };
  }
  const { rows } = readMatrixRows(lines, header + 1, 3);
  if (rows.length !== 3) {
    return {
      status: 'unavailable',
      reason: `"The g-matrix:" printed ${rows.length} numeric row${rows.length === 1 ? '' : 's'}, not 3`,
    };
  }
  let principal = null;
  let printedIso = null;
  for (let index = start; index < lines.length; index += 1) {
    const total = G_TOTAL.exec(lines[index]);
    if (!total) continue;
    principal = [orcaNumber(total[1]), orcaNumber(total[2]), orcaNumber(total[3])];
    printedIso = orcaNumber(total[4]);
    break;
  }
  const trace = (rows[0][0] + rows[1][1] + rows[2][2]) / 3;
  const gIso = printedIso === null ? trace : printedIso;
  return {
    status: 'reported',
    matrix: rows,
    principal,
    gIso,
    gIsoPrinted: printedIso,
    gIsoFromTrace: trace,
    convention: 'ORCA ELECTRONIC G-MATRIX: the total g matrix as printed; g values are '
      + 'dimensionless and no shift is applied',
    lineNumber: start + 1,
    message: `ORCA printed a g-tensor: g_iso = ${Number.isFinite(gIso) ? gIso.toFixed(7) : 'not stated'}`,
  };
}

function gTensorForRecord(gTensor) {
  if (gTensor && gTensor.status === 'reported') {
    return {
      status: 'reported',
      requested: 'g-tensor',
      engine: 'ORCA',
      ...gTensor,
    };
  }
  return {
    status: 'refused',
    requested: 'g-tensor',
    engine: 'ORCA',
    missingCapability: 'an EPR g-tensor in this ORCA log',
    message: gTensor?.reason
      ? `this ORCA run says it computed a g-tensor, but the block could not be read: ${gTensor.reason}`
      : 'this ORCA run printed no g-tensor: its EPR properties block says '
        + '"g-Tensor (aka g-matrix) ... NO", so no value is reported.',
  };
}

/**
 * The `epr` block a canonical ORCA result carries.
 *
 * The shape is the one `epr.js` produces for Psi4 — `status`, `electrons`,
 * `populations`, `hyperfine[]`, `gTensor` — so `resultsView.js` and
 * `workflowReport.js` need no ORCA branch. ORCA prints no spin populations, so
 * `populations` is empty and the card hides that table; the hyperfine rows are
 * real and carry `aIsoMhz` / `aIsoGauss`.
 */
export function orcaEprBlock({ hyperfine = null, gTensor = null, level = null } = {}) {
  if (!hyperfine && !gTensor) return null;
  const g = gTensorForRecord(gTensor);
  const electrons = {
    alpha: null,
    beta: null,
    unpaired: Number.isInteger(hyperfine?.multiplicity) ? Math.max(0, hyperfine.multiplicity - 1) : null,
  };
  const base = {
    level: level ? String(level) : null,
    electrons,
    populations: [],
    hyperfine: [],
    units: { frequency: 'MHz', field: 'gauss' },
    gTensor: g,
  };

  if (!hyperfine) {
    return {
      ...base,
      status: 'unavailable',
      reason: 'this ORCA run printed a g-tensor but no hyperfine couplings; the hyperfine '
        + 'section is absent, not zero',
    };
  }
  if (!hyperfine.ok) {
    return {
      ...base,
      status: 'unavailable',
      reason: hyperfine.reason,
      detail: hyperfine.declaredCount === undefined ? null
        : `declared ${hyperfine.declaredCount ?? '?'} nuclei, read ${hyperfine.parsedCount ?? 0}`,
    };
  }

  return {
    ...base,
    status: 'open-shell',
    scheme: 'ORCA hyperfine block: A(iso) per nucleus; ORCA prints no spin populations',
    hyperfine: hyperfine.nuclei,
    hyperfineLabel: 'Isotropic hyperfine coupling A(iso)',
    hyperfineMethod: 'ORCA A(iso): the isotropic part of the total HFC matrix in MHz '
      + '(A(FC) + A(SD) + A(ORB+DIA)), SAI spin-Hamiltonian convention, sign as printed',
    hyperfineCaveat: 'Read from ORCA\'s hyperfine tensor, not a density-only Fermi-contact '
      + 'estimate. The gauss column is converted from the printed MHz with '
      + `g_e = ${G_ELECTRON}; this log prints no gauss column, so that conversion is not `
      + 'cross-checked against the log. Quadrupole and zero-field-splitting terms are not '
      + 'reported here.',
    hyperfineVerification: hyperfine.verification,
    provenance: {
      engine: 'ORCA',
      hyperfineBlock: 'ELECTRIC AND MAGNETIC HYPERFINE STRUCTURE',
      spinDensityBlock: 'ORCA hyperfine block (no spin density printed)',
      basisFunctions: null,
      method: hyperfine.method,
      propertyBasis: hyperfine.basis,
      relativistic: hyperfine.relativistic,
      presenceLine: hyperfine.presenceLine,
      constants: {
        gElectron: G_ELECTRON,
        gaussPerMhz: GAUSS_PER_MHZ,
      },
    },
  };
}

/* ── spin-spin couplings ─────────────────────────────────────── */

const COUPLING_SUMMARY = /^\s*SUMMARY OF ISOTROPIC COUPLING CONSTANTS\b[^\n]*\(Hz\)/i;
const SPIN_SPIN_REQUEST = /^\s*NMR spin-spin couplings\s+\.{3}\s+(\d+)/;
const PAIR_HEADER = new RegExp(
  String.raw`^\s*NUCLEUS A =\s*(${ELEMENT})\s+(\d+)\s+NUCLEUS B =\s*(${ELEMENT})\s+(\d+)`,
);
const PAIR_GN = new RegExp(
  String.raw`^\s*\(\s*(\d+)(${ELEMENT})\s+gnA\s*=\s*(${NUMBER})\s+`
  + String.raw`(\d+)(${ELEMENT})\s+gnB\s*=\s*(${NUMBER})\)`,
);
const PAIR_TOTAL = new RegExp(
  String.raw`^\s*Total\s+(${NUMBER})\s+(${NUMBER})\s+(${NUMBER})\s+iso=\s*(${NUMBER})`,
);

function isColumnHeader(tokens) {
  if (tokens.length < 4 || tokens.length % 2 !== 0) return false;
  for (let index = 0; index < tokens.length; index += 2) {
    if (!/^\d+$/.test(tokens[index]) || !ELEMENT_RE.test(tokens[index + 1])) return false;
  }
  return true;
}

function isDataRow(tokens) {
  if (tokens.length < 3) return false;
  if (!/^\d+$/.test(tokens[0]) || !ELEMENT_RE.test(tokens[1])) return false;
  return tokens.slice(2).every((token) => NUMBER_RE.test(token));
}

/**
 * The per-pair `NUCLEUS A = … NUCLEUS B = …` blocks.
 *
 * Each block carries its own `gnA`/`gnB` constants and a `Total … iso=` value.
 * Both are used only as an independent check on the summary matrix; a pair
 * block that is missing is not an error, it just reduces the number of pairs
 * the cross-check covers.
 */
function readPairBlocks(lines) {
  const pairs = new Map();
  const gN = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = PAIR_HEADER.exec(lines[index]);
    if (!header) continue;
    const a = Number(header[2]);
    const b = Number(header[4]);
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    let iso = null;
    let constants = null;
    for (let cursor = index + 1; cursor < Math.min(index + 260, lines.length); cursor += 1) {
      if (/^\s*NUCLEUS A =/.test(lines[cursor])) break;
      if (!constants) {
        const gn = PAIR_GN.exec(lines[cursor]);
        if (gn) {
          constants = {
            a: { massNumber: Number(gn[1]), element: gn[2], gN: orcaNumber(gn[3]) },
            b: { massNumber: Number(gn[4]), element: gn[5], gN: orcaNumber(gn[6]) },
          };
          gN.push(constants.a, constants.b);
        }
      }
      const total = PAIR_TOTAL.exec(lines[cursor]);
      if (total) {
        iso = orcaNumber(total[4]);
        break;
      }
    }
    if (iso !== null) pairs.set(key, { iso, constants });
  }
  return { pairs, gN };
}

/* ── chemical shieldings ─────────────────────────────────────── */

const SHIELDING_SUMMARY = /^\s*CHEMICAL SHIELDING SUMMARY\s*\(ppm\)/i;
const SHIELDING_ROW = /^\s*(\d+)\s+([A-Z][a-z]?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*$/;

/**
 * ORCA's `CHEMICAL SHIELDING SUMMARY (ppm)` table.
 *
 * ORCA numbers nuclei from **0** in input order; this app numbers atoms from 1,
 * so the shift happens here and nowhere else. The row carries the isotropic
 * shielding and the anisotropy ORCA prints beside it; the per-nucleus tensors
 * earlier in the log are not duplicated into this table.
 *
 * Returns null when the run asked for no shieldings — absence, never zeros.
 */
export function parseOrcaShieldings(text) {
  const lines = splitLines(text);
  const start = lines.findIndex((line) => SHIELDING_SUMMARY.test(line));
  if (start === -1) return null;
  const atoms = [];
  let inTable = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*Nucleus\s+Element/i.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (/^\s*-{3,}/.test(line)) continue;
    if (line.trim() === '') {
      if (atoms.length > 0) break;
      continue;
    }
    const match = SHIELDING_ROW.exec(line);
    if (!match) {
      if (atoms.length > 0) break;
      continue;
    }
    atoms.push({
      index: Number(match[1]) + 1,
      nucleus: Number(match[1]),
      element: match[2],
      isotropic: Number(match[3]),
      anisotropy: Number(match[4]),
      eigenvalues: null,
    });
  }
  if (atoms.length === 0) return null;
  return {
    gauge: /GIAO/i.test(text) ? 'GIAO' : null,
    method: null,
    count: atoms.length,
    atoms,
  };
}

/**
 * ORCA's `SUMMARY OF ISOTROPIC COUPLING CONSTANTS (Hz)` table, in the shape
 * `nmr.js` returns.
 *
 * ORCA prints the full symmetric matrix in six-column chunks; unlike Gaussian,
 * every row prints every column of the chunk, including above the diagonal. The
 * matrix is therefore read as printed and symmetrised only for a value that was
 * printed once. The diagonal is 0 because the log prints 0.
 *
 * `kMatrix` is null: these ORCA logs print J in Hz and the per-pair gnA/gnB
 * constants, but no reduced K table. `kUnits` says so; nothing is converted.
 */
export function parseOrcaSpinSpin(text) {
  const lines = splitLines(text);
  let request = null;
  for (const line of lines) {
    const match = SPIN_SPIN_REQUEST.exec(line);
    if (match) {
      request = Number(match[1]);
      break;
    }
  }
  const start = lines.findIndex((line) => COUPLING_SUMMARY.test(line));
  if (start === -1) {
    if (request === 1) {
      return {
        ok: false,
        requested: true,
        reason: 'the log says "NMR spin-spin couplings ... 1", but no '
          + '"SUMMARY OF ISOTROPIC COUPLING CONSTANTS (Hz)" table was found; couplings are '
          + 'refused rather than reported as a zero matrix',
      };
    }
    return null;
  }

  const values = new Map();
  const elements = {};
  const problems = [];
  let columns = null;
  let rowsInBlock = 0;
  let blocks = 0;
  let ended = false;
  for (let index = start + 1; index < lines.length && !ended; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === '' || /^-{5,}$/.test(trimmed)) continue;
    const tokens = trimmed.split(/\s+/);
    if (isColumnHeader(tokens)) {
      columns = [];
      for (let cursor = 0; cursor < tokens.length; cursor += 2) {
        const nucleus = Number(tokens[cursor]);
        columns.push(nucleus);
        const element = tokens[cursor + 1];
        if (elements[nucleus] && elements[nucleus] !== element) {
          problems.push(`line ${index + 1}: nucleus ${nucleus} is ${elements[nucleus]} in one `
            + `header and ${element} in another`);
        } else {
          elements[nucleus] = element;
        }
      }
      rowsInBlock = 0;
      blocks += 1;
      continue;
    }
    if (isDataRow(tokens)) {
      if (!columns) {
        problems.push(`line ${index + 1}: row ${tokens[0]} appears before a column header`);
        ended = true;
        continue;
      }
      const row = Number(tokens[0]);
      const element = tokens[1];
      if (elements[row] && elements[row] !== element) {
        problems.push(`line ${index + 1}: nucleus ${row} is ${elements[row]} in the header and `
          + `${element} in its row`);
      } else {
        elements[row] = element;
      }
      const printed = tokens.slice(2).map(orcaNumber);
      if (printed.length !== columns.length) {
        problems.push(`line ${index + 1}: row ${row} printed ${printed.length} value`
          + `${printed.length === 1 ? '' : 's'} where its header has ${columns.length} columns`);
      } else {
        printed.forEach((value, offset) => {
          const column = columns[offset];
          const key = `${row},${column}`;
          if (values.has(key) && Math.abs(values.get(key) - value) > 5e-4) {
            problems.push(`line ${index + 1}: J(${row},${column}) printed as `
              + `${values.get(key)} and ${value}`);
          } else {
            values.set(key, value);
          }
        });
      }
      rowsInBlock += 1;
      continue;
    }
    if (rowsInBlock > 0 || blocks > 0) ended = true;
  }

  if (values.size === 0) {
    return {
      ok: false,
      requested: true,
      reason: `the summary header at line ${start + 1} is present, but no column header or `
        + 'numeric row was read; the coupling table is refused rather than reported as zeros',
      lineNumber: start + 1,
    };
  }

  const indices = Object.keys(elements).map(Number);
  const atoms = Math.max(...indices) + 1;
  for (let nucleus = 0; nucleus < atoms; nucleus += 1) {
    if (!(nucleus in elements)) problems.push(`nucleus ${nucleus} has no row and no column label`);
  }

  const matrix = new Float64Array(atoms * atoms).fill(Number.NaN);
  for (const [key, value] of values) {
    const [row, column] = key.split(',').map(Number);
    matrix[row * atoms + column] = value;
  }
  // The table is symmetric; fill a value printed only once from its partner,
  // and check a value printed twice against its partner.
  let symmetryCompared = 0;
  let symmetryWorst = 0;
  let symmetryWorstPair = null;
  for (let row = 0; row < atoms; row += 1) {
    for (let column = row + 1; column < atoms; column += 1) {
      const forward = matrix[row * atoms + column];
      const reverse = matrix[column * atoms + row];
      if (Number.isFinite(forward) && Number.isFinite(reverse)) {
        const deviation = Math.abs(forward - reverse);
        symmetryCompared += 1;
        if (deviation > symmetryWorst) {
          symmetryWorst = deviation;
          symmetryWorstPair = `${row},${column}`;
        }
      } else if (Number.isFinite(forward)) {
        matrix[column * atoms + row] = forward;
      } else if (Number.isFinite(reverse)) {
        matrix[row * atoms + column] = reverse;
      }
    }
  }

  let diagonalZero = true;
  for (let nucleus = 0; nucleus < atoms; nucleus += 1) {
    const value = matrix[nucleus * atoms + nucleus];
    if (!Number.isFinite(value)) {
      problems.push(`the diagonal for nucleus ${nucleus} is not printed`);
      diagonalZero = false;
    } else if (value !== 0) {
      problems.push(`the printed diagonal for nucleus ${nucleus} is ${value}, not 0`);
      diagonalZero = false;
    }
  }

  const pairs = [];
  for (let row = 0; row < atoms; row += 1) {
    for (let column = row + 1; column < atoms; column += 1) {
      const value = matrix[row * atoms + column];
      if (Number.isFinite(value)) pairs.push({ i: row, j: column, hz: value, k: null });
    }
  }
  const expected = (atoms * (atoms - 1)) / 2;
  const complete = pairs.length === expected && diagonalZero;

  const pairBlocks = readPairBlocks(lines);
  let crossCompared = 0;
  let crossWorst = 0;
  let crossWorstPair = null;
  for (const [key, block] of pairBlocks.pairs) {
    const [row, column] = key.split(',').map(Number);
    const value = matrix[row * atoms + column];
    if (!Number.isFinite(value)) continue;
    const deviation = Math.abs(value - block.iso);
    crossCompared += 1;
    if (deviation > crossWorst) {
      crossWorst = deviation;
      crossWorstPair = key;
    }
  }

  let gNCompared = 0;
  let gNWorstAbsolute = 0;
  let gNWorstRelative = 0;
  let gNWorst = null;
  for (const constant of pairBlocks.gN) {
    const entry = NUCLEAR_ISOTOPES[constant.element];
    if (!entry || entry.massNumber !== constant.massNumber || !Number.isFinite(constant.gN)) continue;
    const absolute = Math.abs(constant.gN - entry.gN);
    const relative = absolute / Math.abs(entry.gN);
    gNCompared += 1;
    if (relative > gNWorstRelative) {
      gNWorstRelative = relative;
      gNWorstAbsolute = absolute;
      gNWorst = {
        element: constant.element,
        massNumber: constant.massNumber,
        printed: constant.gN,
        table: entry.gN,
      };
    }
  }

  return {
    ok: true,
    requested: true,
    atoms,
    elements: Array.from({ length: atoms }, (_, index) => elements[index] ?? null),
    pairs,
    matrix,
    kMatrix: null,
    units: 'Hz',
    kUnits: 'not printed: this ORCA log carries no reduced K table, so K is absent (null), not 0',
    convention: 'total isotropic J_ij in Hz as ORCA prints it: the sum of its DSO, PSO, FC, SD '
      + 'and SD/FC contributions (the pair blocks state each term); sign as printed, never '
      + 'normalised; the diagonal is printed as 0',
    note: 'J in Hz as ORCA prints it (the total of its DSO, PSO, FC, SD and SD/FC contributions, '
      + 'never normalised).',
    indexing: ORCA_COUPLING_INDEXING,
    source: 'orca',
    summaryLine: lines[start].trim(),
    summaryLineNumber: start + 1,
    verified: problems.length === 0,
    complete,
    problems,
    printed: { pairs: pairs.length, atoms, blocks },
    verification: {
      summary: {
        blocks,
        rows: values.size,
        atoms,
        statement: `${blocks} column block${blocks === 1 ? '' : 's'}, ${values.size} printed `
          + `values, ${atoms} nuclei`,
      },
      symmetry: {
        pairsCompared: symmetryCompared,
        worstDeviationHz: symmetryWorst,
        worstPair: symmetryWorstPair,
        statement: `${symmetryCompared} pairs printed twice, worst |J(i,j) − J(j,i)| = `
          + `${symmetryWorst} Hz`,
      },
      pairBlockCrossCheck: {
        pairsCompared: crossCompared,
        pairBlocksRead: pairBlocks.pairs.size,
        worstDeviationHz: crossWorst,
        worstPair: crossWorstPair,
        statement: `${crossCompared} summary pairs checked against the per-pair "Total ... iso=" `
          + `values, worst deviation ${crossWorst} Hz`,
      },
      gNConstants: gNCompared > 0
        ? {
          printed: true,
          comparisons: gNCompared,
          worstAbsoluteDeviation: gNWorstAbsolute,
          worstRelativeDeviation: gNWorstRelative,
          worst: gNWorst,
          statement: `${gNCompared} gnA/gnB values checked against the app's isotope table, `
            + `worst relative deviation ${gNWorstRelative}`,
        }
        : {
          printed: false,
          reason: 'this log printed no gnA/gnB constants to check',
        },
      kRelation: {
        checked: false,
        constantsPrinted: gNCompared > 0,
        reason: 'the log prints J in Hz and the per-pair gnA/gnB constants, but no reduced K '
          + 'table; J = K·(γ_i γ_j)/(2π) cannot be checked because K is not printed',
      },
    },
  };
}

/**
 * The `nmr` block a canonical ORCA result carries.
 *
 * ORCA's coupling summary is not accompanied by a parsed shielding table here,
 * so `atoms` is empty and `count` is 0. The NMR card treats an empty `atoms`
 * list as "no shieldings" and still draws the coupling table; the report does
 * the same. When the log requests couplings but the table is malformed, the
 * block is present with `couplings: null` and `couplingsError` naming what was
 * missing — an absence with a reason, never a zero matrix.
 */
export function orcaNmrBlock({ couplings = null, shieldings = null, text = '' } = {}) {
  if (!couplings && !shieldings) return null;
  let gauge = shieldings?.gauge ?? null;
  const gaugeMatch = /Treatment of gauge\s+\.{3}\s+([A-Za-z0-9]+)/.exec(String(text));
  if (!gauge && gaugeMatch) gauge = gaugeMatch[1];
  const base = {
    gauge,
    method: shieldings?.method ?? null,
    count: shieldings?.count ?? 0,
    atoms: shieldings?.atoms ?? [],
  };
  if (couplings && !couplings.ok) {
    return { ...base, couplings: null, couplingsError: couplings.reason };
  }
  return {
    ...base,
    couplings: couplings ? couplingSummary(couplings) : null,
    ...(couplings ? { couplingsSource: couplings.summaryLine } : {}),
  };
}
