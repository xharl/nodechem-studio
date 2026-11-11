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
  gaussian: {
    win32: 'C:\\G16W\\g16.exe',
    posix: '/usr/local/g16/g16',
  },
  xtb: {
    win32: 'C:\\xtb\\bin\\xtb.exe',
    posix: '/usr/local/bin/xtb',
  },
  // ORCA's parallel driver must be called by its full path, so the example is a
  // path and not a bare name.
  orca: {
    win32: 'C:\\ORCA\\orca.exe',
    posix: '/opt/orca/orca',
  },
  psi4: {
    win32: 'C:\\Psi4\\bin\\psi4.exe',
    posix: '/usr/bin/psi4',
  },
  pyscf: {
    win32: 'C:\\Python\\python.exe',
    posix: '/usr/bin/python3',
  },
});

const DRY_RUN_HINT = Object.freeze({
  gaussian: `${FIXTURE_HINT} Uncheck to launch the licensed Gaussian 16 installation.`,
  xtb: `${FIXTURE_HINT} Uncheck to run the xTB executable.`,
  orca: `${FIXTURE_HINT} Uncheck to run the ORCA driver.`,
  psi4: `${FIXTURE_HINT} Uncheck to run the Psi4 interpreter.`,
  pyscf: `${FIXTURE_HINT} Uncheck to run the deck with the Python interpreter that has PySCF.`,
});

/** Label above the executable field — the engine named is the one that runs. */
export function executableLabelFor(engineId, { projectDefault = false } = {}) {
  const id = engineOrDefault(engineId).id;
  // Issue 361: with no block selected the field holds the project's default
  // engine, and the label has to say so instead of implying the flow runs it.
  if (projectDefault) return `project default: ${engineOrDefault(id).label}`;
  return EXECUTABLE_LABEL[id] || EXECUTABLE_LABEL.gaussian;
}

/**
 * Example path shown in the empty executable field, on this platform's
 * convention (issue 361: a Linux console offered `C:\G16W\g16.exe`).
 */
export function executablePlaceholderFor(engineId, platform = 'linux') {
  const id = engineOrDefault(engineId).id;
  const entry = EXECUTABLE_PLACEHOLDER[id] || EXECUTABLE_PLACEHOLDER.gaussian;
  return platform === 'win32' ? entry.win32 : entry.posix;
}

/**
 * `xTB`, `xTB and Psi4`, `xTB, Psi4 and ORCA` — the sentence form of a plan's
 * engines, so the hint can name them without a list of ids.
 */
export function engineListText(engineIds = []) {
  const labels = [...new Set((Array.isArray(engineIds) ? engineIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean)
    .map((id) => engineOrDefault(id).label))];
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

const TOOL_LABEL = Object.freeze({
  crest: 'CREST',
  obabel: 'Open Babel',
  scorer: 'the ML scorer',
  tautomer: 'the tautomer sidecar',
  multiwfn: 'Multiwfn',
});

/**
 * The hint under the dry-run checkbox (issue 361). It said "Uncheck to run the
 * Psi4 interpreter" on a flow whose blocks were xTB — the project default, not
 * the plan. It now names the engines the plan launches and the tools it spawns.
 */
export function planRunHint({ engines = [], tools = [], dryRun = true } = {}) {
  const engineText = engineListText(engines);
  const toolText = (Array.isArray(tools) ? tools : [])
    .map((toolId) => TOOL_LABEL[toolId])
    .filter(Boolean)
    .join(', ');
  if (!engineText) {
    return dryRun ? FIXTURE_HINT : `${FIXTURE_HINT} No block in this flow launches an engine.`;
  }
  const needs = toolText ? `${engineText}, plus ${toolText}` : engineText;
  const many = (Array.isArray(engines) ? engines.length : 0) > 1 || Boolean(toolText);
  return dryRun
    ? `${FIXTURE_HINT} This flow runs ${needs}; uncheck to launch ${many ? 'them' : 'it'}.`
    : `${FIXTURE_HINT} This flow runs ${needs}.`;
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
