/**
 * Provenance manifest helpers.
 *
 * Pure module: no Node APIs, no filesystem, no network. The runner uses it to
 * shape the record; the run console uses the same vocabulary to describe it.
 *
 * A run is either a real calculation or a dry-run fixture. The distinction is
 * recorded explicitly (`provenance.kind`) so a synthetic result can never be
 * mistaken for a computed one when the record is read on its own.
 */

export const UNKNOWN = 'unknown';

export const PROVENANCE_KINDS = Object.freeze({
  fixture: 'fixture',
  calculation: 'calculation',
});

export function normaliseAppInfo(info = {}) {
  const version = String(info?.version ?? '').trim();
  const commit = String(info?.commit ?? '').trim();
  return {
    version: version || UNKNOWN,
    commit: commit || UNKNOWN,
  };
}

export function provenanceKindFor(dryRun) {
  return dryRun ? PROVENANCE_KINDS.fixture : PROVENANCE_KINDS.calculation;
}

function shortHash(value) {
  return typeof value === 'string' && value ? `${value.slice(0, 12)}…` : 'none';
}

function hamiltonianText(value) {
  const id = String(value ?? '').trim().toLowerCase();
  if (!id) return UNKNOWN;
  if (id === 'gfnff') return 'GFN-FF';
  const match = /^gfn(\d+)$/.exec(id);
  return match ? `GFN${match[1]}-xTB` : String(value);
}

function methodText(method) {
  if (!method) return UNKNOWN;
  // xTB records a Hamiltonian and its argv, not a Gaussian route. Keep the two
  // vocabularies separate so an xTB run can never be described as a DFT route.
  if (method.hamiltonian) {
    const opt = method.optLevel ? ` · opt ${method.optLevel}` : '';
    const solvent = method.solvation ? ` · ${method.solvation}` : '';
    return `${hamiltonianText(method.hamiltonian)}${opt}${solvent}`;
  }
  const solvent = method.solvation ? ` solvation ${method.solvation}` : '';
  const grid = method.grid ? ` grid ${method.grid}` : '';
  const scf = method.scf ? ` SCF ${method.scf}` : '';
  const dispersion = method.dispersion ? ` ${method.dispersion}` : '';
  const pno = method.pnoThreshold ? ` ${method.pnoThreshold}` : '';
  // ORCA records `method` rather than Gaussian's `functional`; read both so an
  // ORCA block is not printed as `undefined/def2-SVP`.
  const level = method.functional || method.method || UNKNOWN;
  return `${level}/${method.basis}${pno}${dispersion}${solvent}${grid}${scf}`;
}

function programText(program) {
  if (!program?.name || !program?.version) return UNKNOWN;
  return `${program.name} ${program.version}${program.revision ? ` revision ${program.revision}` : ''}`;
}

/** Human-readable summary of the manifest fields, for the run console. */
export function provenanceSummary(record = {}) {
  const provenance = record?.provenance || {};
  const app = record?.app || {};
  return [
    `Provenance · ${provenance.kind || UNKNOWN}`,
    `  method: ${methodText(provenance.method)}`,
    `  program: ${programText(record?.parsed?.program)}`,
    `  app: ${app.version || UNKNOWN} (${app.commit || UNKNOWN})`,
    `  input sha256: ${shortHash(record?.inputSha256)}`,
    `  output sha256: ${shortHash(record?.outputSha256)}`,
  ].join('\n');
}

/**
 * Ask the main process to recompute the input hash for a run folder and turn
 * the answer into text for the run console. The comparison itself happens in
 * the main process, next to the file; the renderer never reads disk.
 */
export async function verifyRunInput({ desktop, runId }) {
  if (!desktop?.verifyRun) {
    return { ok: false, text: 'Verify unavailable: the desktop bridge is not present.' };
  }
  if (!runId) {
    return { ok: false, text: 'Verify unavailable: no run has been recorded yet.' };
  }
  const result = await desktop.verifyRun(runId);
  if (!result) return { ok: false, text: 'Verify failed: the main process returned no result.' };
  if (result.status === 'match') {
    return {
      ok: true,
      text: `Verify · input hash matches ${result.inputName}\n  sha256 ${result.actual}`,
    };
  }
  if (result.status === 'mismatch') {
    return {
      ok: false,
      text: `Verify · INPUT HASH MISMATCH for ${result.inputName}\n  recorded ${result.expected}\n  on disk  ${result.actual}\n  The .gjf changed after the run; the recorded result is not reproducible from this folder.`,
    };
  }
  if (result.status === 'missing') {
    return {
      ok: false,
      text: `Verify · input file ${result.inputName || '(unknown)'} is missing from the run folder.`,
    };
  }
  if (result.status === 'unrecorded') {
    return {
      ok: false,
      text: 'Verify · this run has no recorded input hash (it predates the provenance manifest).',
    };
  }
  return { ok: false, text: `Verify · ${result.status || 'unknown'}${result.error ? `: ${result.error}` : ''}` };
}
