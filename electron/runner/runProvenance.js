/**
 * Record provenance for `run.json` (issue 193).
 *
 * A run record must say **which** record a task ran and **how** that record was
 * derived. Both facts already exist on the queued task
 * (`electron/runner/queue.js`): `task.record` names the dataset record and
 * `task.series` names the repeat unit a generated member was expanded from.
 * They are copied here — not recomputed from a task id, a file name or a
 * project — so the run record cannot disagree with the plan that produced it.
 *
 * Absent by default: a task that ran a single structure carries neither key, so
 * its run record grows no key and stays byte-identical to one written before
 * this shape existed. Nothing is ever filled in with `null`, an empty object or
 * a synthetic id; an unknown value is left out.
 *
 * Pure: no filesystem, no clock, no dependencies.
 */

function text(value, max) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

/** An integer of at least `min`, or null. Never coerced from a string like "2a". */
function integer(value, min = 1) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min ? number : null;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The linkage rule a series member was built with. Atom indices are 1-based,
 * exactly as `src/shared/series.js` defines them; a rule that does not name both
 * junction atoms is dropped rather than half-recorded.
 */
function linkageFor(raw) {
  if (!isObject(raw)) return null;
  const donor = integer(raw.donor);
  const acceptor = integer(raw.acceptor);
  if (donor === null || acceptor === null) return null;
  const bondLength = Number(raw.bondLengthAngstrom);
  return {
    donor,
    acceptor,
    bondLengthAngstrom: Number.isFinite(bondLength) ? bondLength : null,
    leaving: Array.isArray(raw.leaving)
      ? raw.leaving.map((value) => integer(value)).filter((value) => value !== null).slice(0, 64)
      : [],
  };
}

/**
 * `record: { id, label, datasetId }` for a dataset record, or null.
 *
 * `datasetId` is copied only when the caller could name the dataset: a record
 * the queue cannot place keeps no datasetId instead of a made-up one.
 */
export function recordIdentityFor(raw) {
  if (!isObject(raw)) return null;
  const id = text(raw.id, 64);
  if (!id) return null;
  const datasetId = text(raw.datasetId, 64);
  return {
    id,
    label: text(raw.label, 200) || id,
    ...(datasetId ? { datasetId } : {}),
  };
}

/**
 * `series: { parentId, n, count, linkage }` for a member of a series block, or
 * null. Without a parent and a member number there is no derivation to state.
 */
export function seriesDerivationFor(raw) {
  if (!isObject(raw)) return null;
  const parentId = text(raw.parentId, 64);
  const n = integer(raw.n);
  const count = integer(raw.count);
  if (!parentId || n === null || count === null) return null;
  const linkage = linkageFor(raw.linkage);
  return {
    parentId,
    n,
    count,
    ...(linkage ? { linkage } : {}),
  };
}

/**
 * Add the provenance keys a run actually has. The one place that decides
 * whether `record`/`series` appear in `run.json`: with neither source present
 * the record object comes back untouched, key for key and byte for byte.
 */
export function withRunProvenance(record, source = {}) {
  const identity = recordIdentityFor(source?.record);
  const series = seriesDerivationFor(source?.series);
  return {
    ...record,
    ...(identity ? { record: identity } : {}),
    ...(series ? { series } : {}),
  };
}
