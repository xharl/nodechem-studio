/**
 * Job keyword composition: transition-state force constants (issue #15) and
 * optimization convergence (issue #16).
 *
 * A Berny transition-state search needs real curvature information. Without it
 * Gaussian starts from a valence-force-field Hessian guessed from atomic radii,
 * and the G16 manual is explicit that for optimizations to transition states
 * "some knowledge of the curvature around the saddle point is essential, and
 * the default approximate Hessian must always be improved". A bare `Opt=TS`
 * therefore either stalls or walks to a different stationary point.
 *
 * The G16 manual for `Opt=Tight` is equally direct: a tight optimization takes
 * more steps but "may be necessary to ensure adequate convergence and
 * reliability of frequencies computed in a subsequent job step", and for DFT
 * "Int=UltraFine should be specified as well".
 *
 * This module is the single place that turns a job type, a force-constant
 * choice and a convergence choice into the route's job keyword, so composing
 * `Opt=TS` with force constants and convergence can never emit two `Opt`
 * keywords.
 *
 * NoEigenTest: Gaussian runs the curvature test by default for TS searches. It
 * is suppressed only for `CalcFC`, where the Hessian is computed once at a
 * starting geometry that is often a rough guess and the job would otherwise
 * abort before the first step. `CalcAll` recomputes the Hessian at every point
 * and `ReadFC` reads one written by a real frequency job, so both keep the
 * test: it is the guard that the curvature really is a single saddle.
 */

import { isDftMethod } from './routePresets.js';

export const TS_JOB_TYPE = 'Opt=TS';

/** Force-constant choices, in inspector order. `default` adds no Opt flag. */
export const TS_FORCE_CONSTANT_OPTIONS = Object.freeze([
  {
    id: 'CalcFC',
    label: 'CalcFC — compute at the first point',
    flags: Object.freeze(['CalcFC', 'NoEigenTest']),
  },
  {
    id: 'CalcAll',
    label: 'CalcAll — compute at every point',
    flags: Object.freeze(['CalcAll']),
  },
  {
    id: 'ReadFC',
    label: 'ReadFC — read from the checkpoint',
    flags: Object.freeze(['ReadFC']),
  },
  {
    id: 'default',
    label: 'Default (unsafe) — estimated Hessian',
    flags: Object.freeze([]),
  },
]);

export const TS_FORCE_CONSTANT_IDS = Object.freeze(
  TS_FORCE_CONSTANT_OPTIONS.map((option) => option.id),
);

export const DEFAULT_TS_FORCE_CONSTANTS = 'CalcFC';

/**
 * Optimization-convergence choices, in inspector order. `''` is Gaussian's
 * default and adds no Opt flag; the others append one flag inside the existing
 * `Opt=` keyword.
 */
export const OPT_CONVERGENCE_OPTIONS = Object.freeze([
  { id: '', label: 'Default — Gaussian cutoffs' },
  { id: 'Tight', label: 'Tight — recommended before a frequency job' },
  { id: 'VeryTight', label: 'Very tight — for very flat modes' },
]);

export const OPT_CONVERGENCE_IDS = Object.freeze(
  OPT_CONVERGENCE_OPTIONS.map((option) => option.id),
);

export const DEFAULT_OPT_CONVERGENCE = '';

/** The grid Gaussian 16 recommends for DFT optimizations at tight convergence. */
export const ULTRAFINE_GRID = 'UltraFine';

/** An `Opt` keyword at the start of a token, e.g. `Opt`, `Opt=TS`, `Opt=(TS,CalcFC)`. */
const OPT_KEYWORD = /(^|[^A-Za-z0-9])opt\s*(=|\(|\s|$)/i;

/** A job keyword that optimizes a geometry: `Opt`, `Opt Freq`, `Opt=TS`. */
const OPT_JOB = /^opt(\s|=|$)/i;

function oneLine(value, fallback = '') {
  return String(value ?? fallback).replace(/[\r\n]+/g, ' ').trim();
}

export function isTsJob(jobType) {
  return oneLine(jobType) === TS_JOB_TYPE;
}

/** True when the job type is an optimization. */
export function isOptJob(jobType) {
  return OPT_JOB.test(oneLine(jobType));
}

/** True when extra route keywords already carry an `Opt` keyword of their own. */
export function hasOptKeyword(text) {
  return OPT_KEYWORD.test(String(text ?? ''));
}

/**
 * The stored force-constant choice, or the safe default. An unknown value is
 * never emitted as route syntax; it falls back to CalcFC, the safe direction.
 */
export function forceConstantsFor(settings = {}) {
  const value = settings.forceConstants;
  return TS_FORCE_CONSTANT_IDS.includes(value) ? value : DEFAULT_TS_FORCE_CONSTANTS;
}

/** The `Opt=(...)` flags for the stored choice. Empty for the unsafe default. */
export function forceConstantFlags(settings = {}) {
  const option = TS_FORCE_CONSTANT_OPTIONS.find((item) => item.id === forceConstantsFor(settings));
  return option ? [...option.flags] : [];
}

/**
 * The stored optimization-convergence choice, or `''` for Gaussian's default.
 * An unknown value is never emitted as route syntax.
 */
export function optConvergenceFor(settings = {}) {
  const value = oneLine(settings.optConvergence);
  return OPT_CONVERGENCE_IDS.includes(value) ? value : DEFAULT_OPT_CONVERGENCE;
}

/**
 * True when the route should default the integration grid to UltraFine: an
 * optimization at a requested (non-default) convergence with a DFT method.
 * VeryTight is stricter than Tight, so the same G16 guidance applies.
 */
export function requiresUltraFineGrid(settings = {}) {
  return isOptJob(settings.jobType)
    && optConvergenceFor(settings) !== ''
    && isDftMethod(settings.method);
}

/**
 * The grid keyword value: an explicit choice wins, otherwise the DFT + tight
 * convergence default. `''` means the route carries no Integral keyword.
 */
export function gridFor(settings = {}) {
  const explicit = oneLine(settings.grid);
  if (explicit) return explicit;
  return requiresUltraFineGrid(settings) ? ULTRAFINE_GRID : '';
}

/** True when an explicit grid choice overrides the UltraFine default. */
export function gridOverridden(settings = {}) {
  const explicit = oneLine(settings.grid);
  return requiresUltraFineGrid(settings)
    && explicit !== ''
    && explicit.toLowerCase() !== ULTRAFINE_GRID.toLowerCase();
}

/**
 * The job keyword for a route: `Opt`, `Opt=Tight`, `Opt Freq`,
 * `Opt=(TS,CalcFC,NoEigenTest,Tight)`, `Freq`, `IRC(forward,reverse)`, `SP`,
 * `Scan`. Always exactly one job keyword.
 */
export function jobKeywordFor(settings = {}) {
  const jobType = oneLine(settings.jobType, 'Opt');
  // An NMR job is a single point with the shielding keyword. Gaussian's default
  // gauge is GIAO; the output states which gauge produced the numbers.
  if (jobType === 'NMR') return 'NMR';
  if (jobType === 'IRC') {
    const direction = settings.ircDirection === 'both'
      ? 'forward,reverse'
      : (oneLine(settings.ircDirection, 'forward') || 'forward');
    return `IRC(${direction})`;
  }
  const convergence = optConvergenceFor(settings);
  if (jobType === TS_JOB_TYPE) {
    const flags = ['TS', ...forceConstantFlags(settings)];
    if (convergence) flags.push(convergence);
    return flags.length === 1 ? TS_JOB_TYPE : `Opt=(${flags.join(',')})`;
  }
  // `Opt` and `Opt Freq` (a frequency after the optimization) take the flag in
  // the same keyword: `Opt=Tight Freq`, never `Opt=Tight Opt Freq`.
  // Raman activities are a flag on the frequency keyword, not a job of their
  // own: `Freq=Raman`, and `Opt Freq=Raman` for a frequency after an
  // optimisation (#76).
  const raman = settings.raman === true;
  if (jobType === 'Freq') return raman ? 'Freq=Raman' : 'Freq';
  if (jobType === 'Opt' || jobType === 'Opt Freq') {
    const [head, ...rest] = jobType.split(/\s+/);
    const tail = rest.map((token) => (raman && token === 'Freq' ? 'Freq=Raman' : token));
    return [convergence ? `${head}=${convergence}` : head, ...tail].join(' ');
  }
  return jobType;
}

/**
 * True when a job is known to write force constants to its checkpoint:
 * a `Freq` job, or an `Opt=TS` job that computes them with `CalcFC`.
 * Deliberately an allow-list — reading a checkpoint that never received a
 * Hessian fails at run time, after the user has paid for the job.
 */
export function upstreamProvidesForceConstants(settings = {}) {
  const jobType = oneLine(settings.jobType);
  if (jobType === 'Freq') return true;
  return jobType === TS_JOB_TYPE && forceConstantsFor(settings) === 'CalcFC';
}

/**
 * Check one node's force-constant choice. `upstream` is the checkpoint source
 * node (`{ id, title, settings }`) or null. Returns human-readable messages;
 * the caller supplies the JSON path and decides how to report them.
 */
export function checkTsForceConstants({ settings = {}, upstream = null } = {}) {
  const errors = [];
  const warnings = [];
  if (!isTsJob(settings.jobType)) return { errors, warnings };

  const choice = forceConstantsFor(settings);
  if (choice === 'default') {
    warnings.push(
      'uses the estimated initial Hessian for a transition-state search. Berny needs '
      + 'real curvature there, so the search often stalls or converges to the wrong '
      + 'saddle. CalcFC is the safe default.',
    );
  }
  if (choice === 'ReadFC') {
    if (!upstream) {
      errors.push(
        'ReadFC reads force constants from a checkpoint, but this transition-state '
        + 'block has no checkpoint hand-off. Connect a Freq or Opt=CalcFC block as its '
        + 'checkpoint source, or choose CalcFC.',
      );
    } else if (!upstreamProvidesForceConstants(upstream.settings || {})) {
      const title = oneLine(upstream.title) || oneLine(upstream.id) || 'the upstream block';
      const jobType = oneLine(upstream.settings?.jobType) || 'an unknown job type';
      errors.push(
        `ReadFC needs force constants in the upstream checkpoint, but "${title}" is `
        + `${jobType} and does not write them. Use a Freq or Opt=CalcFC block as the `
        + 'checkpoint source, or choose CalcFC.',
      );
    }
  }
  return { errors, warnings };
}

/**
 * Issue #16: warn when the integration grid overrides the UltraFine default
 * that Gaussian 16 pairs with Opt=Tight for DFT. Returns human-readable
 * messages; the caller supplies the JSON path. Never blocks a run.
 */
export function optConvergenceWarnings(settings = {}) {
  const warnings = [];
  if (!gridOverridden(settings)) return warnings;
  const grid = oneLine(settings.grid);
  warnings.push(
    `uses Integral=${grid} for a DFT optimization at `
    + `${optConvergenceFor(settings)} convergence. Gaussian's Opt=Tight guidance `
    + 'specifies Int=UltraFine for DFT as well; the grid was overridden.',
  );
  return warnings;
}

/**
 * Issue #16: a frequency job that reads the geometry from an optimization left
 * at Gaussian's default convergence. `upstream` is the checkpoint source node
 * (`{ id, title, settings }`) or null. Returns human-readable messages; the
 * caller supplies the JSON path. Never blocks a run.
 */
export function freqGeometryWarnings({ settings = {}, upstream = null } = {}) {
  const warnings = [];
  if (oneLine(settings.jobType) !== 'Freq' || !upstream) return warnings;
  const upstreamSettings = upstream.settings || {};
  if (!isOptJob(upstreamSettings.jobType)) return warnings;
  if (optConvergenceFor(upstreamSettings) !== '') return warnings;
  const title = oneLine(upstream.title) || oneLine(upstream.id) || 'the upstream block';
  warnings.push(
    `reads its geometry from "${title}", which was optimized at the default `
    + 'convergence. Gaussian recommends Opt=Tight before a frequency job so the '
    + 'frequencies are computed on a tightly converged geometry.',
  );
  return warnings;
}

