/**
 * Excited-state optimisation report (#146).
 *
 * What this module reads
 * ----------------------
 * A Gaussian `Opt` job carrying a TD keyword prints, at every optimisation step,
 * the same excitation table a single point prints:
 *
 *   Excitation energies and oscillator strengths:
 *   Excited State   1:      Singlet-BU     5.3351 eV  232.39 nm  f=0.1707  <S**2>=0.000
 *         34 -> 36         0.48145
 *   This state for optimization and/or second-order correction.
 *   Total Energy, E(TD-HF/TD-DFT) =  -382.112205281
 *
 * The `This state for optimization` line names the root Gaussian is following,
 * and the `Total Energy, E(TD-HF/TD-DFT)` line is the only hartree energy for
 * that state that the log prints. `Optimization completed.` marks convergence;
 * `Optimization stopped.` / `Number of steps exceeded` mark a run that finished
 * without reaching the criteria.
 *
 * WHERE THE FORMAT COMES FROM — AND WHAT IS NOT VERIFIED
 * ------------------------------------------------------
 * The table line format is confirmed against a **real** Gaussian 16 TD
 * single-point log (`test/fixtures/real/g16-dvb-td.out`), which prints exactly
 * the `Excited State` / transition / `Total Energy` layout above. The Opt-TD
 * arrangement — one table per optimisation step, then the final table — is
 * taken from the Gaussian 16 output documentation.
 *
 * There is **no real `Opt TD` log in this repository**: no fixture contains
 * both `Excited State` and `Optimization completed`. The parser has therefore
 * never seen a real run of the job type it describes, and every report carries
 * `verified: false`. The results card repeats that sentence. Do not flip this
 * flag without committing the real log that proves it.
 *
 * Honesty rules this module follows
 * ---------------------------------
 * - `converged` is `true` only when the completion marker is present **and** the
 *   final table carries the root. It is `false` only for the two explicit
 *   non-convergence markers. Every other case — truncated log, no marker, no
 *   readable root — is `null`, never `false`.
 * - A per-step geometry is not returned: the geometry block format after each
 *   step is part of what is unverified here, and returning `null` is honest
 *   where a guessed atom list would not be.
 * - No number is derived. Energies and wavelengths are the printed values.
 */

/** A printed excited-state row, 4 decimal eV and 2 decimal nm as Gaussian writes them. */
const EXCITED_STATE = /^\s*Excited State\s+(\d+):\s+(\S+?)\s+([0-9.]+)\s+eV\s+([0-9.]+)\s+nm\s+f=([0-9.]+)(?:\s+<S\*\*2>=(-?[0-9.]+))?/;
const TRANSITION_LINE = /^\s*(\d+)\s*->\s*(\d+)\s+(-?[0-9.]+)\s*$/;
const TD_TOTAL_ENERGY = /^\s*Total Energy, E\(TD-HF\/TD-DFT\)\s*=\s*(-?[0-9.]+)/;
const ROOT_MARKER = /^\s*This state for optimization and\/or second-order correction\.\s*$/;
const TABLE_HEADER = /^\s*Excitation energies and oscillator strengths:\s*$/;
const STEP_MARKER = /^\s*Step number\s+(\d+)\s*$/;
const COMPLETED_MARKER = /^\s*Optimization completed\.?\s*$/m;
const STOPPED_MARKER = /Optimization stopped\.|Number of steps exceeded/;
/** A Gaussian route line carrying an optimisation job keyword. */
const ROUTE_OPT = /^\s*#.*\bOpt\b/i;
/** A Gaussian log starts with one of these; their absence means a window/truncation. */
const PROLOGUE = /Entering Gaussian System|Entering Link 1|Gaussian, Inc\./;

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function lineText(lines, index) {
  return String(lines[index] ?? '').trim();
}

/**
 * Split the text into TD tables. Gaussian prints one header per table, so the
 * header is the table boundary; a table without a header (an old G09 intent)
 * still starts at the first `Excited State` row after the previous table ends.
 */
function tablesOf(lines) {
  const tables = [];
  let current = null;
  let currentState = null;
  const startTable = (line) => {
    current = { line, states: [], stepNumber: null };
    tables.push(current);
    currentState = null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (TABLE_HEADER.test(line)) {
      startTable(index + 1);
      continue;
    }
    const step = line.match(STEP_MARKER);
    if (step && current) {
      current.stepNumber = Number(step[1]);
      continue;
    }
    const match = line.match(EXCITED_STATE);
    if (match) {
      if (!current) startTable(index + 1);
      const label = String(match[2] || '');
      const [spin, ...symmetryParts] = label.split('-');
      currentState = {
        index: Number(match[1]),
        line: index + 1,
        label,
        spin: spin || null,
        symmetry: symmetryParts.join('-') || null,
        energyEv: toNumber(match[3]),
        wavelengthNm: toNumber(match[4]),
        oscillatorStrength: toNumber(match[5]),
        s2: match[6] === undefined ? null : toNumber(match[6]),
        transitions: [],
        energyHartree: null,
        forOptimization: false,
      };
      current.states.push(currentState);
      continue;
    }
    const transition = line.match(TRANSITION_LINE);
    if (transition && currentState) {
      currentState.transitions.push({
        from: Number(transition[1]),
        to: Number(transition[2]),
        coefficient: toNumber(transition[3]),
      });
      continue;
    }
    const total = line.match(TD_TOTAL_ENERGY);
    if (total && currentState) {
      currentState.energyHartree = toNumber(total[1]);
      continue;
    }
    if (ROOT_MARKER.test(line) && currentState) {
      currentState.forOptimization = true;
    }
  }
  return tables;
}

/**
 * The root the log itself names: the state followed by "This state for
 * optimization". Returns `null` when no such line exists — an SP TD log names
 * no root, and the caller's requested root is then the only source of truth.
 */
function rootFromMarker(tables) {
  for (const table of tables) {
    const marked = table.states.find((state) => state.forOptimization);
    if (marked) return marked.index;
  }
  return null;
}

function finalTableOf(tables) {
  const table = tables[tables.length - 1];
  if (!table || table.states.length === 0) return null;
  return {
    line: table.line,
    states: table.states,
  };
}

/**
 * Parse an excited-state optimisation.
 *
 * @param {string} text Gaussian output.
 * @param {{ root?: number|null, truncated?: boolean }} options
 *   `root` is the root the block asked for; when absent the root named by the
 *   log is used. `truncated` marks a log read through a byte window; a text
 *   without a Gaussian prologue is treated as truncated even when the caller
 *   did not say so.
 * @returns {{
 *   verified: false,
 *   applicable: boolean,
 *   root: number|null,
 *   rootSource: 'requested'|'marker'|null,
 *   steps: Array<{index:number, energyEv:number|null, energyHartree:number|null, geometry:null, line:number}>,
 *   converged: boolean|null,
 *   convergedReason: string,
 *   finalTable: {line:number, states:Array<object>}|null,
 *   truncated: boolean,
 *   evidence: Array<{line:number, text:string, kind:string}>,
 * }}
 */
export function parseExcitedStateOptimization(text, { root = null, truncated = false } = {}) {
  const source = String(text ?? '');
  const lines = source.split(/\r\n|\n|\r/);
  const partial = truncated === true || (source.trim() !== '' && !PROLOGUE.test(source));
  if (!/Excited State/.test(source)) {
    // No TD record at all: this report does not apply. Returning the same shape
    // keeps every caller free of null checks, and `applicable: false` is what
    // stops the gate from reading the absence as a failure.
    return {
      verified: false,
      applicable: false,
      root: null,
      rootSource: null,
      steps: [],
      converged: null,
      convergedReason: 'the output has no Excited State record',
      finalTable: null,
      truncated: partial,
      evidence: [],
    };
  }
  const tables = tablesOf(lines);
  const requested = Number(root);
  const hasRequested = Number.isInteger(requested) && requested > 0;
  const markerRoot = rootFromMarker(tables);
  const effectiveRoot = hasRequested ? requested : markerRoot;
  const finalTable = finalTableOf(tables);

  const evidence = [];
  const pushEvidence = (line, kind) => {
    evidence.push({ line, kind, text: lineText(lines, line - 1) });
  };

  const steps = [];
  if (effectiveRoot !== null) {
    for (const table of tables) {
      const state = table.states.find((entry) => entry.index === effectiveRoot);
      if (!state) continue;
      steps.push({
        index: steps.length + 1,
        energyEv: state.energyEv,
        // The hartree energy is the TD total energy printed for the state being
        // optimised; for any other state the log prints no hartree value, and
        // this stays null rather than being back-converted from eV.
        energyHartree: state.energyHartree,
        geometry: null,
        line: state.line,
        // The ordinal of the TD table in this log. Gaussian's own `Step number`
        // line counts geometry updates, and its offset from the table is part of
        // the unverified layout; the ordinal is what the report can defend.
        tableIndex: steps.length + 1,
      });
      pushEvidence(state.line, 'step');
    }
  }
  if (finalTable) pushEvidence(finalTable.line, 'final-table');
  const completedLine = lines.findIndex((line) => COMPLETED_MARKER.test(line));
  if (completedLine !== -1) pushEvidence(completedLine + 1, 'optimization-completed');
  const stoppedLine = lines.findIndex((line) => STOPPED_MARKER.test(line));
  if (stoppedLine !== -1) pushEvidence(stoppedLine + 1, 'optimization-stopped');
  const markerLine = lines.findIndex((line) => ROOT_MARKER.test(line));
  if (markerLine !== -1) pushEvidence(markerLine + 1, 'root-marker');

  const applicable = tables.length > 0
    && (lines.some((line) => ROUTE_OPT.test(line))
      || tables.some((table) => table.stepNumber !== null)
      || completedLine !== -1 || stoppedLine !== -1);

  let converged = null;
  let convergedReason;
  const carriedRoot = finalTable && effectiveRoot !== null
    ? finalTable.states.some((state) => state.index === effectiveRoot)
    : false;
  if (partial) {
    convergedReason = 'the log does not start at the beginning of the run, so its convergence marker '
      + 'cannot be read; the report is partial';
  } else if (completedLine !== -1) {
    if (carriedRoot) {
      converged = true;
      convergedReason = `Optimization completed, and the final table carries Excited State ${effectiveRoot}`;
    } else {
      convergedReason = effectiveRoot === null
        ? 'Optimization completed, but the log does not say which excited state was followed'
        : `Optimization completed, but the final table has no Excited State ${effectiveRoot}`;
    }
  } else if (stoppedLine !== -1) {
    converged = false;
    convergedReason = 'the log says the optimisation stopped before meeting its criteria '
      + '(Optimization stopped / Number of steps exceeded)';
  } else {
    convergedReason = 'the log carries no Optimization completed marker; a truncated or unfinished '
      + 'output is unknown, not failed';
  }

  return {
    // Never true in this build: no real Opt TD log exists in the repository.
    verified: false,
    applicable,
    root: effectiveRoot,
    rootSource: hasRequested ? 'requested' : (markerRoot !== null ? 'marker' : null),
    steps,
    converged,
    convergedReason,
    finalTable,
    truncated: partial,
    evidence,
  };
}

/**
 * The `excited-state` gate (#146).
 *
 * `pass` only when the optimisation completed **and** the final table carries
 * the requested root. `fail` only when the log explicitly says the optimisation
 * stopped. Everything else is `unknown` — a gate that cannot read its input is
 * never a pass and is not turned into a failure either.
 *
 * @param {object|null} report result of `parseExcitedStateOptimization`
 * @param {{ requestedRoot?: number|null, unverified?: boolean }} options
 */
export function excitedStateGate(report, { requestedRoot = null, unverified = false } = {}) {
  const name = 'excited-state';
  const unverifiedNote = report?.verified === false || unverified
    ? ' This build has not seen a real log for this job type, so the format itself is unverified.'
    : '';
  if (!report || typeof report !== 'object') {
    return { name, required: true, result: 'unknown', detail: 'no excited-state optimisation report was parsed' };
  }
  if (!report.applicable) {
    return {
      name,
      required: true,
      result: 'unknown',
      detail: 'this output carries no excited-state optimisation ladder, so there is nothing to judge',
    };
  }
  if (report.truncated) {
    return {
      name,
      required: true,
      result: 'unknown',
      detail: `the log is partial (${report.convergedReason}).${unverifiedNote}`,
    };
  }
  if (report.converged === false) {
    return {
      name,
      required: true,
      result: 'fail',
      detail: `${report.convergedReason}.${unverifiedNote}`,
    };
  }
  if (report.converged !== true) {
    return {
      name,
      required: true,
      result: 'unknown',
      detail: `${report.convergedReason}.${unverifiedNote}`,
    };
  }
  const requested = Number(requestedRoot);
  const root = Number.isInteger(requested) && requested > 0 ? requested : report.root;
  if (!Number.isInteger(root) || root <= 0) {
    return {
      name,
      required: true,
      result: 'unknown',
      detail: `Optimization completed, but the log does not say which root was followed.${unverifiedNote}`,
    };
  }
  const carried = Array.isArray(report.finalTable?.states)
    && report.finalTable.states.some((state) => state.index === root);
  if (!carried) {
    return {
      name,
      required: true,
      result: 'unknown',
      detail: `Optimization completed, but the final table does not carry Excited State ${root}, `
        + `so root ${root} is not confirmed.${unverifiedNote}`,
    };
  }
  return {
    name,
    required: true,
    result: 'pass',
    detail: `Optimization completed and the final table carries Excited State ${root} `
      + `(${report.finalTable.states.find((state) => state.index === root)?.energyEv ?? 'not reported'} eV).`
      + unverifiedNote,
  };
}

/** The sentence the UI repeats wherever this parser's output appears. */
export const UNVERIFIED_ESOPT_NOTE = 'this build has not seen a real log for this job type';
