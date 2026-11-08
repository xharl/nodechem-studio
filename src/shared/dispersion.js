/**
 * Which dispersion corrections a Gaussian revision actually implements.
 *
 * Only D4 has a hard revision floor: it was added in Gaussian 16 rev. C.01 and
 * is absent from every Gaussian 09 and from Gaussian 16 A.03/B.01. GD3 and
 * GD3BJ are left unchecked here — they are accepted across the versions this
 * app supports, and inventing a stricter floor would refuse working jobs.
 *
 * A version that cannot be read is `unknown`, never `ok`: a gate that passes
 * because the output did not say what program printed it is not a check.
 */

/** Compare "16" / "C.01" style revisions. Letters sort before numbers by design. */
export function revisionAtLeast(revision, floor) {
  const parse = (value) => {
    const match = /^([A-Z])\.(\d{2})$/.exec(String(value || '').trim().toUpperCase());
    return match ? { letter: match[1], minor: Number(match[2]) } : null;
  };
  const left = parse(revision);
  const right = parse(floor);
  if (!left || !right) return null;
  if (left.letter !== right.letter) return left.letter > right.letter;
  return left.minor >= right.minor;
}

export const D4_FLOOR = Object.freeze({ version: '16', revision: 'C.01' });

/**
 * `{ status: 'ok' | 'unsupported' | 'unknown', detail }` for a requested
 * dispersion correction against the program that produced the output.
 */
export function dispersionSupport(program, dispersion) {
  const requested = String(dispersion || '').toUpperCase();
  if (requested !== 'D4') return { status: 'ok', detail: null };
  const version = String(program?.version || '').trim();
  const revision = String(program?.revision || '').trim();
  if (!version) {
    return { status: 'unknown', detail: 'The output does not state the Gaussian version, so D4 support cannot be confirmed.' };
  }
  if (Number(version) > Number(D4_FLOOR.version)) return { status: 'ok', detail: null };
  if (version !== D4_FLOOR.version) {
    return {
      status: 'unsupported',
      detail: `EmpiricalDispersion=D4 requires Gaussian ${D4_FLOOR.version} rev. ${D4_FLOOR.revision} or later; this output reports Gaussian ${version}${revision ? ` rev. ${revision}` : ''}.`,
    };
  }
  // Gaussian 17+ would read as a different version string; treat anything
  // numerically newer than 16 as supported rather than refusing it.
  const atLeast = revisionAtLeast(revision, D4_FLOOR.revision);
  if (atLeast === null) {
    return {
      status: 'unknown',
      detail: `Gaussian ${version}${revision ? ` rev. ${revision}` : ''} does not state a revision this check can compare against C.01.`,
    };
  }
  return atLeast
    ? { status: 'ok', detail: null }
    : {
      status: 'unsupported',
      detail: `EmpiricalDispersion=D4 requires Gaussian ${D4_FLOOR.version} rev. ${D4_FLOOR.revision} or later; this output reports Gaussian ${version} rev. ${revision}.`,
    };
}
