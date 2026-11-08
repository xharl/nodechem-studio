/**
 * Offline error-signature table.
 *
 * A Gaussian or xTB failure is only actionable if the reader knows what the
 * program was complaining about. This module matches the text a run actually
 * produced (an error-termination block, a runner error, or an exit code) to a
 * short explanation and a concrete next step.
 *
 * Two rules keep it honest:
 *
 *   1. The table is offline and versioned with the app. Nothing is fetched and
 *      no model guesses a cause from prose.
 *   2. An unmatched failure returns `matched: false`. The UI then says that no
 *      known signature matched, rather than showing the closest-looking entry.
 *
 * Every entry carries the engine it applies to (`gaussian`, `xtb`, or `any`)
 * so an xTB exit code is never explained with a Gaussian remedy.
 */

export const SIGNATURE_SEVERITY = Object.freeze({
  ERROR: 'error',
  FATAL: 'fatal',
  WARNING: 'warning',
});

/**
 * Patterns are deliberately narrow: they match wording the program prints, not
 * a paraphrase of it. `match` entries are tested in order against the joined
 * evidence text; the first entry whose every pattern is present wins.
 */
export const ERROR_SIGNATURES = Object.freeze([
  {
    id: 'scf-convergence',
    engine: 'gaussian',
    severity: SIGNATURE_SEVERITY.ERROR,
    title: 'SCF did not converge',
    patterns: [/Convergence failure -- run terminated/i, /SCF Done/i],
    cause: 'The self-consistent field reached its cycle limit before the density stopped changing.',
    action: 'Raise the cycle limit (`SCF=(MaxCycle=512)`) and add a fallback (`SCF=(XQC)`), then check the guess and the geometry. A distorted starting structure is the usual cause.',
    reference: 'gaussian.com/scf/',
  },
  {
    id: 'scf-convergence-short',
    engine: 'gaussian',
    severity: SIGNATURE_SEVERITY.ERROR,
    title: 'SCF did not converge',
    patterns: [/Convergence failure/i],
    cause: 'A self-consistent-field procedure hit its iteration limit.',
    action: 'Raise `MaxCycle`, add `XQC`, and inspect the initial guess and geometry before changing the method.',
    reference: 'gaussian.com/scf/',
  },
  {
    id: 'opt-not-converged',
    engine: 'gaussian',
    severity: SIGNATURE_SEVERITY.ERROR,
    title: 'Geometry optimisation ran out of cycles (Link 9999)',
    patterns: [/Link 9999/i],
    cause: 'The optimisation exhausted its maximum number of steps without meeting all four convergence criteria.',
    action: 'Continue from the checkpoint (`Opt=Restart` via `Geom=Check Guess=Read`) or raise `Opt=(MaxCycles=...)`. If it stalls repeatedly, the starting geometry or the coordinate system is the problem, not the cycle count.',
    reference: 'gaussian.com/opt/',
  },
  {
    id: 'opt-step-failed',
    engine: 'gaussian',
    severity: SIGNATURE_SEVERITY.ERROR,
    title: 'Optimisation step could not be taken',
    patterns: [/New curvilinear step not converged|Invariant failed|Error in internal coordinate/i],
    cause: 'The redundant internal-coordinate system produced an invalid step, usually after a badly distorted geometry or a strained ring.',
    action: 'Re-optimise in Cartesian coordinates (`Opt=Cartesian`) or repair the geometry first. For a transition state, confirm the force constants are present.',
    reference: 'gaussian.com/opt/',
  },
  {
    id: 'internal-coordinate-error',
    engine: 'gaussian',
    severity: SIGNATURE_SEVERITY.ERROR,
    title: 'Internal-coordinate construction failed',
    patterns: [/FormBX had a problem|Internal coordinate error|Z-matrix/i],
    cause: 'Gaussian could not build a valid set of internal coordinates for this structure.',
    action: 'Switch to `Opt=Cartesian`, or rebuild the input from a clean XYZ geometry. Check for atoms at identical positions.',
    reference: 'gaussian.com/opt/',
  },
  {
    id: 'multiplicity-impossible',
    engine: 'gaussian',
    severity: SIGNATURE_SEVERITY.FATAL,
    title: 'Charge and multiplicity are inconsistent',
    patterns: [/multiplicity/i, /(impossible|not possible|inconsistent)/i],
    cause: 'The requested multiplicity cannot be produced by the stated charge and electron count.',
    action: 'Check that the number of electrons (sum of atomic numbers minus charge) has the parity the multiplicity requires: even electrons need odd multiplicities.',
    reference: 'gaussian.com/multiplicity/',
  },
  {
    id: 'basis-missing',
    engine: 'gaussian',
    severity: SIGNATURE_SEVERITY.FATAL,
    title: 'Basis set missing or unusable',
    patterns: [/(basis set|basis functions)/i, /(not specified|not found|no basis|missing|unrecognized)/i],
    cause: 'The route named a basis set Gaussian cannot resolve, or an ECP basis was requested without its pseudopotential data.',
    action: 'Check the spelling and availability for this Gaussian revision. For SDD/LANL2DZ on heavy elements, the `GenECP` block and ECP data must be supplied.',
    reference: 'gaussian.com/basissets/',
  },
  {
    id: 'basis-linear-dependence',
    engine: 'gaussian',
    severity: SIGNATURE_SEVERITY.ERROR,
    title: 'Basis set is linearly dependent',
    patterns: [/linear(ly)? dependent/i],
    cause: 'The basis functions are numerically dependent, so the SCF cannot be solved as written.',
    action: 'Remove the diffuse functions that cause the dependency, or let Gaussian delete them (`Int=NoBasisTransform` is not a fix). Check for duplicate atoms first.',
    reference: 'gaussian.com/basissets/',
  },
  {
    id: 'distance-matrix',
    engine: 'gaussian',
    severity: SIGNATURE_SEVERITY.FATAL,
    title: 'Distance matrix problem',
    patterns: [/distance matrix/i],
    cause: 'Two atoms are too close, or the geometry is not physically sensible enough to build coordinates from.',
    action: 'Inspect the input geometry for overlapping atoms or a wrong unit (Å versus bohr). Clean the structure and retry.',
    reference: 'gaussian.com/geom/',
  },
  {
    id: 'disk-quota',
    engine: 'gaussian',
    severity: SIGNATURE_SEVERITY.FATAL,
    title: 'Scratch write failed (disk quota or full filesystem)',
    patterns: [/disk quota|Erroneous write|rwriter|No space left/i],
    cause: 'Gaussian could not write its scratch files.',
    action: 'Free space on the scratch volume, move `GAUSS_SCRDIR` to a larger local disk, or reduce `%Mem`/the job size. Do not point scratch at a network mount.',
    reference: 'gaussian.com/scratch/',
  },
  {
    id: 'link1-failure',
    engine: 'gaussian',
    severity: SIGNATURE_SEVERITY.FATAL,
    title: 'Link 1 (l1) failed to start',
    patterns: [/l1\.exe|link 1|Link1/i, /(failed|error|cannot|not found)/i],
    cause: 'Gaussian could not execute its first link, usually because `GAUSS_EXEDIR` is wrong or the installation is incomplete.',
    action: 'Point `GAUSS_EXEDIR` at the directory that actually contains `l1` (`l1.exe` on Windows) and rerun preflight.',
    reference: 'gaussian.com/install/',
  },
  {
    id: 'license',
    engine: 'gaussian',
    severity: SIGNATURE_SEVERITY.FATAL,
    title: 'Licence problem',
    patterns: [/licen[cs]e/i],
    cause: 'Gaussian could not validate its licence for this machine or user.',
    action: 'Check that the licence file is present and that the job runs on the platform and host the licence covers. A Windows licence does not authorise Linux execution.',
    reference: 'gaussian.com/license/',
  },
  {
    id: 'ccsd-not-converged',
    engine: 'gaussian',
    severity: SIGNATURE_SEVERITY.ERROR,
    title: 'Coupled-cluster iterations did not converge',
    patterns: [/CCSD/i, /(did not converge|failed to converge|not converged)/i],
    cause: 'The CC amplitude equations reached their iteration limit.',
    action: 'Raise `CC=(MaxCyc=...)`, tighten the SCF first, and consider a better reference wavefunction.',
    reference: 'gaussian.com/cc/',
  },
  {
    id: 'cphf-failure',
    engine: 'gaussian',
    severity: SIGNATURE_SEVERITY.ERROR,
    title: 'CPHF did not converge',
    patterns: [/CPHF/i, /(not converged|failed|convergence)/i],
    cause: 'The coupled-perturbed Hartree–Fock step (polarisability, NMR, or a derivative) did not converge.',
    action: 'Tighten the SCF (`SCF=Tight`), use a better guess, and check that the method/basis combination supports the requested property.',
    reference: 'gaussian.com/scf/',
  },
  {
    id: 'xtb-missing-parameters',
    engine: 'xtb',
    severity: SIGNATURE_SEVERITY.FATAL,
    title: 'xTB parameter files not found',
    patterns: [/(xtb|parameter)/i, /(not found|missing|cannot)/i],
    cause: 'xTB could not locate its `share/xtb` parameter directory.',
    action: 'Set `XTBPATH` to the directory that holds the parameter files, or install xTB with `bin/xtb` beside `share/xtb`.',
    reference: 'xtb-docs.readthedocs.io/en/latest/setup.html',
  },
  {
    id: 'xtb-topology',
    engine: 'xtb',
    severity: SIGNATURE_SEVERITY.ERROR,
    title: 'xTB could not build a topology',
    patterns: [/topology/i, /(error|fail|missing)/i],
    cause: 'The geometry has no sensible bonding pattern for the requested force field or method.',
    action: 'Check for overlapping atoms or a wrong element symbol. For GFN-FF, confirm the structure is a connected molecule rather than separated fragments with implausible distances.',
    reference: 'xtb-docs.readthedocs.io/en/latest/',
  },
]);

const RUNNER_SIGNATURES = Object.freeze([
  {
    id: 'engine-missing',
    engine: 'any',
    severity: SIGNATURE_SEVERITY.FATAL,
    title: 'Engine executable not found',
    patterns: [/(ENOENT|not found|no such file)/i],
    cause: 'The run could not start because the configured executable does not exist at that path.',
    action: 'Browse to the executable again and run preflight. On Linux and macOS confirm the executable bit; on Windows confirm you selected the console build.',
    reference: 'docs/guide/engines.md',
  },
  {
    id: 'permission-denied',
    engine: 'any',
    severity: SIGNATURE_SEVERITY.FATAL,
    title: 'Engine executable is not runnable',
    patterns: [/(EACCES|permission denied)/i],
    cause: 'The process was found but could not be executed.',
    action: 'Grant the executable bit (`chmod +x`) or check the filesystem mount options.',
    reference: 'docs/guide/troubleshooting.md',
  },
  {
    id: 'interrupted',
    engine: 'any',
    severity: SIGNATURE_SEVERITY.WARNING,
    title: 'Run was interrupted',
    patterns: [/(interrupted|SIGTERM|SIGKILL|cancelled)/i],
    cause: 'The engine process was stopped before it finished, either by the user or by the operating system.',
    action: 'Resume from the checkpoint if one exists; otherwise rerun. A cancelled run is never a result.',
    reference: 'docs/guide/workflow.md',
  },
]);

const ALL_SIGNATURES = Object.freeze([...ERROR_SIGNATURES, ...RUNNER_SIGNATURES]);

function evidenceText({ text = '', cause = '', terminationLine = '', runnerError = '', exitCode = null } = {}) {
  return [text, cause, terminationLine, runnerError, exitCode === null ? '' : String(exitCode)]
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join('\n');
}

/**
 * Explain a failure from the evidence a run carries.
 *
 * @param {object} input
 * @param {string} [input.text]            raw error block or output excerpt
 * @param {string} [input.cause]           parsed error cause line
 * @param {string} [input.terminationLine] the `Error termination` line
 * @param {string} [input.runnerError]     the runner's own message
 * @param {string} [input.engine]          `gaussian`, `xtb`, or omitted
 * @param {number|null} [input.exitCode]
 * @returns {{matched: boolean, severity: string|null, signature: object|null,
 *            explanation: {title: string, cause: string, action: string, docs: string}|null}}
 */
export function explainFailure(input = {}) {
  const evidence = evidenceText(input);
  if (evidence.trim() === '') {
    return { matched: false, severity: null, signature: null, explanation: null };
  }
  const engine = input.engine ? String(input.engine).toLowerCase() : null;
  const candidates = ALL_SIGNATURES.filter(
    (signature) => !engine || signature.engine === 'any' || signature.engine === engine,
  );
  for (const signature of candidates) {
    if (signature.patterns.every((pattern) => pattern.test(evidence))) {
      return {
        matched: true,
        severity: signature.severity,
        signature,
        explanation: {
          title: signature.title,
          cause: signature.cause,
          action: signature.action,
          docs: signature.docs,
        },
      };
    }
  }
  return { matched: false, severity: null, signature: null, explanation: null };
}

/**
 * Convenience wrapper for a run record: pulls the three places a failure can
 * hide (parsed error termination, runner error, canonical status) into one
 * call. Returns `null` when the run did not fail.
 */
export function explainRunFailure(record) {
  if (!record || typeof record !== 'object') return null;
  const parsed = record.parsed && typeof record.parsed === 'object' ? record.parsed : {};
  const errorTermination = parsed.errorTermination && typeof parsed.errorTermination === 'object'
    ? parsed.errorTermination
    : null;
  const status = String(parsed.status || record.status || '');
  const failed = Boolean(errorTermination)
    || String(record.error || '').trim() !== ''
    || status === 'error'
    || Number(record.exitCode) !== 0 && Number.isFinite(Number(record.exitCode));
  if (!failed) return null;
  return explainFailure({
    text: Array.isArray(errorTermination?.lines) ? errorTermination.lines.join('\n') : '',
    cause: errorTermination?.cause || '',
    terminationLine: errorTermination?.terminationLine || '',
    runnerError: record.error || '',
    engine: parsed.engine || record.engine || '',
    exitCode: record.exitCode ?? null,
  });
}
