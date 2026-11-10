/**
 * Engine-aware copy for the run console and inspector.
 *
 * The product drives two engines. Wording has to name the engine that will
 * actually run, and must never tell an xTB user to install or licence
 * Gaussian. These helpers are pure functions of the engine id so the
 * distinction can be tested without a DOM.
 */

import { engineOrDefault } from '../shared/engines/index.js';

export const BROWSER_PREVIEW_RUN_MESSAGE = 'Open the desktop app to start a local run.';
export const BROWSER_PREVIEW_CONSOLE_HINT = 'Browser preview: the local runner is unavailable. '
  + 'Start the Electron app with "npm run dev" or "npm start".';

const FIXTURE_HINT = 'Dry run writes a synthetic fixture log and evaluates the parser.';

const EXECUTABLE_LABEL = Object.freeze({
  gaussian: 'Gaussian 16 executable',
  xtb: 'xTB executable',
  orca: 'ORCA executable',
  psi4: 'Psi4 executable',
  pyscf: 'Python interpreter with PySCF (or pyscf-runner)',
});

const EXECUTABLE_PLACEHOLDER = Object.freeze({
  gaussian: 'C:\\G16W\\g16.exe',
  xtb: '/usr/local/bin/xtb or C:\\xtb\\bin\\xtb.exe',
  // ORCA's parallel driver must be called by its full path, so the example is a
  // path and not a bare name.
  orca: '/opt/orca/orca or C:\\ORCA\\orca.exe',
  psi4: '/opt/conda/bin/psi4 or C:\\Psi4\\bin\\psi4.exe',
  pyscf: '/usr/bin/python3 or /usr/local/bin/pyscf-runner',
});

const DRY_RUN_HINT = Object.freeze({
  gaussian: `${FIXTURE_HINT} Uncheck to launch the licensed Gaussian 16 installation.`,
  xtb: `${FIXTURE_HINT} Uncheck to run the xTB executable.`,
  orca: `${FIXTURE_HINT} Uncheck to run the ORCA driver.`,
  psi4: `${FIXTURE_HINT} Uncheck to run the Psi4 interpreter.`,
  pyscf: `${FIXTURE_HINT} Uncheck to run the deck with the Python interpreter that has PySCF.`,
});

/** Label above the executable field — the engine named is the one that runs. */
export function executableLabelFor(engineId) {
  const id = engineOrDefault(engineId).id;
  return EXECUTABLE_LABEL[id] || EXECUTABLE_LABEL.gaussian;
}

/** Example path shown in the empty executable field. */
export function executablePlaceholderFor(engineId) {
  const id = engineOrDefault(engineId).id;
  return EXECUTABLE_PLACEHOLDER[id] || EXECUTABLE_PLACEHOLDER.gaussian;
}

/** Run-console hint under the dry-run checkbox. Dry run stays a fixture. */
export function dryRunHintFor(engineId) {
  const id = engineOrDefault(engineId).id;
  return DRY_RUN_HINT[id] || DRY_RUN_HINT.gaussian;
}

/** Status label for a run: `dry run`, or the engine that produced the record. */
export function runEngineLabel(engineId, { dryRun = false } = {}) {
  return dryRun ? 'dry run' : engineOrDefault(engineId).label;
}

/**
 * Inspector note under the checkpoint hand-off select. Gaussian stages a
 * `.chk`; xTB has no checkpoint file to hand off, so the note must say so
 * rather than promise Gaussian keywords that are never emitted.
 */
export function checkpointHandoffNote(engineId) {
  const id = engineOrDefault(engineId).id;
  if (id === 'xtb') {
    return 'Gaussian checkpoint hand-off is not applied to xTB; xTB re-reads '
      + '<code>xtbrestart</code> from its own run directory.';
  }
  if (id === 'orca') {
    return 'Stages the upstream <code>.gbw</code> in this run folder and adds '
      + '<code>%moinp</code> to this task; an ORCA edge cannot read a Gaussian <code>.chk</code>.';
  }
  if (id === 'psi4') {
    return 'Psi4 blocks have no checkpoint file; a Psi4 step reads the upstream geometry instead.';
  }
  if (id === 'pyscf') {
    return 'PySCF blocks have no checkpoint file; a PySCF step reads the upstream geometry and rewrites its deck.';
  }
  return 'Adds <code>%OldChk</code>, <code>Geom=Checkpoint</code> and <code>Guess=Read</code> to this task.';
}
