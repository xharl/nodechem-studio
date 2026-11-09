/**
 * Q-Chem input, written from the `$molecule` and `$rem` keywords the Q-Chem
 * manual documents.
 *
 * Sources: the Q-Chem 6/7 manual, chapter "Job Control" (`$molecule` with a
 * `charge multiplicity` first line, then Cartesian atoms; `$rem` with JOBTYPE =
 * sp|opt|freq, METHOD, BASIS, MEM_TOTAL in MB) and the manual's example decks,
 * which is where the `$comment … $end` group appears.
 *
 * Written:
 *
 *   $comment  <title>;           a group Q-Chem reads and echoes, so the title
 *                                survives without inventing a keyword
 *   $molecule charge multiplicity / element x y z … / $end
 *   $rem      JOBTYPE METHOD BASIS MEM_TOTAL
 *
 * Q-Chem decides restricted versus unrestricted from the multiplicity on the
 * `$molecule` line, so an open-shell block needs nothing else written.
 *
 * `DFT_D` follows the Q-Chem manual's DFT-D section: `D3_ZERO` is DFT-D3(0)
 * and `D3_BJ` is DFT-D3(BJ), so the app's GD3 and GD3BJ map onto them. When the
 * functional already carries dispersion (ωB97X-D) no `DFT_D` is written.
 *
 * Not written, and refused rather than approximated: PCM/SMD solvation
 * (`SOLVENT_METHOD` and the `$pcm` group), TD-DFT (`CIS_N_ROOTS`), constraints
 * (`$opt`), ECPs (`ECP`), and a transition-state search (`$ts`, which needs a
 * Hessian).
 * `Opt Freq` is refused as one deck: `JOBTYPE` is a single choice, so the block
 * is exported as two.
 */

import {
  coordinate,
  deckTitle,
  prepareMolecule,
  refuseUntranslatable,
  refusal,
} from './deck.js';

export const QCHEM_ENGINE_ID = 'qchem';

/** App method name → `$rem METHOD`. */
const METHODS = Object.freeze({
  HF: 'hf',
  B3LYP: 'b3lyp',
  PBE: 'pbe',
  PBE0: 'pbe0',
  'M06-2X': 'm06-2x',
  'ωB97X-D': 'wb97x-d',
  'wB97X-D': 'wb97x-d',
});

/** App basis name → `$rem BASIS`. */
const BASES = Object.freeze({
  'STO-3G': 'sto-3g',
  '3-21G': '3-21g',
  '6-31G': '6-31g',
  '6-31G(D)': '6-31g*',
  '6-31G*': '6-31g*',
  '6-31G(D,P)': '6-31g**',
  '6-31G**': '6-31g**',
  '6-311G(D,P)': '6-311g**',
  '6-311G**': '6-311g**',
  '6-311+G(D,P)': '6-311+g**',
  'CC-PVDZ': 'cc-pvdz',
  'CC-PVTZ': 'cc-pvtz',
  'DEF2-SVP': 'def2-svp',
  'DEF2-TZVP': 'def2-tzvp',
});

const JOB_TYPES = Object.freeze({
  SP: 'sp',
  Opt: 'opt',
  Freq: 'freq',
});

export const QCHEM_CAPABILITIES = Object.freeze({
  id: QCHEM_ENGINE_ID,
  label: 'Q-Chem',
  inputExtension: '.qcin',
  runnable: false,
  jobTypes: Object.freeze(Object.keys(JOB_TYPES)),
  methods: Object.freeze(Object.keys(METHODS)),
  bases: Object.freeze(Object.keys(BASES)),
  dispersion: Object.freeze(['GD3', 'GD3BJ']),
  solvation: false,
  td: false,
  ecp: false,
  notes: Object.freeze([
    'Writes `JOBTYPE = sp|opt|freq`; Q-Chem takes its thread count from `-nt`, not from the input file.',
    'MEM_TOTAL is the block\'s memory in MB, as `$rem` documents.',
  ]),
});

export function renderQchem({ settings = {}, molecule = {}, geometry = null, title = '' } = {}) {
  const prepared = prepareMolecule({ molecule, geometry });
  if (!prepared.ok) return prepared;
  const untranslatable = refuseUntranslatable(settings, 'Q-Chem');
  if (untranslatable) return untranslatable;

  const jobType = String(settings.jobType || 'Opt').trim();
  if (jobType === 'Opt Freq') {
    return refusal('Q-Chem takes one JOBTYPE per deck, so "Opt Freq" is exported as two decks: export the Opt '
      + 'block, import the optimised geometry, then export the Freq block.');
  }
  if (jobType === 'Opt=TS') {
    return refusal('A Q-Chem transition-state search needs a `$ts` group and a Hessian this exporter does not write. '
      + 'Run the frequency block first and write the `$ts` deck by hand.');
  }
  const code = JOB_TYPES[jobType];
  if (!code) {
    return refusal(`Job type "${jobType}" has no Q-Chem export here. Supported: ${Object.keys(JOB_TYPES).join(', ')}.`);
  }

  const method = String(settings.method || '').trim();
  if (!Object.prototype.hasOwnProperty.call(METHODS, method)) {
    return refusal(`Method "${method}" is not in this exporter's Q-Chem table (${Object.keys(METHODS).join(', ')}). `
      + 'A functional name is a different string in every program; an unlisted one is refused rather than guessed at.');
  }
  const basis = BASES[String(settings.basis || '').trim().toUpperCase()];
  if (!basis) {
    return refusal(`Basis "${settings.basis}" is not in this exporter's Q-Chem table (${Object.keys(BASES).join(', ')}). `
      + 'An unlisted basis is refused rather than transliterated into a name Q-Chem may not resolve.');
  }
  const dispersion = String(settings.dispersion || '').trim();
  const methodCarriesDispersion = METHODS[method] === 'wb97x-d';
  let dispersionKeyword = '';
  if (dispersion && !methodCarriesDispersion) {
    if (dispersion === 'GD3') dispersionKeyword = 'D3_ZERO';
    else if (dispersion === 'GD3BJ') dispersionKeyword = 'D3_BJ';
    else {
      return refusal(`Dispersion "${dispersion}" is not one this exporter writes for Q-Chem (GD3 → D3_ZERO, `
        + 'GD3BJ → D3_BJ, per the DFT_D options in the Q-Chem manual).');
    }
  }

  const memory = Number(settings.memory);
  const megabytes = Number.isFinite(memory) && memory > 0
    ? Math.max(1, Math.round(String(settings.memoryUnit || 'GB').toUpperCase() === 'MB' ? memory : memory * 1024))
    : null;

  const rem = [
    ['JOBTYPE', code],
    ['METHOD', METHODS[method]],
    ['BASIS', basis],
    ...(dispersionKeyword ? [['DFT_D', dispersionKeyword]] : []),
    ...(megabytes === null ? [] : [['MEM_TOTAL', String(megabytes)]]),
  ];
  const width = Math.max(...rem.map(([key]) => key.length)) + 2;

  const lines = [];
  lines.push('$comment');
  lines.push(deckTitle(title));
  lines.push('$end');
  lines.push('');
  lines.push('$molecule');
  lines.push(`${prepared.charge} ${prepared.multiplicity}`);
  for (const atom of prepared.atoms) {
    lines.push(`${atom.element.padEnd(2)} ${coordinate(atom.x)} ${coordinate(atom.y)} ${coordinate(atom.z)}`);
  }
  lines.push('$end');
  lines.push('');
  lines.push('$rem');
  for (const [key, value] of rem) lines.push(`${key.padEnd(width)}${value}`);
  lines.push('$end');
  lines.push('');

  const notes = [
    'Run with `qchem -nt <n> job.inp job.out`; the thread count comes from the command line, not from `$rem`.',
  ];
  if (prepared.multiplicity > 1) {
    notes.push(`Multiplicity ${prepared.multiplicity} on the \`$molecule\` line is what makes Q-Chem use an `
      + 'unrestricted wavefunction; no extra keyword is needed.');
  }
  if (methodCarriesDispersion) {
    notes.push('ωB97X-D carries its dispersion in the functional definition; no `DFT_D` keyword is written.');
  } else if (dispersionKeyword) {
    notes.push(`DFT_D = ${dispersionKeyword} is Q-Chem's spelling of ${dispersion === 'GD3' ? 'DFT-D3(0)' : 'DFT-D3(BJ)'}.`);
  }
  return { ok: true, engine: QCHEM_ENGINE_ID, text: `${lines.join('\n')}`, notes };
}
