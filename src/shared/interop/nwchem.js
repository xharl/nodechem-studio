/**
 * NWChem input, written from the keywords NWChem 7 documents.
 *
 * Sources: the NWChem 7.2 "Molecular Geometry" and "Density Functional Theory"
 * reference pages (`geometry units angstroms … end`, `charge`, `basis …
 * * library … end`, `dft … xc … mult … end`, `task <module> <operation>`), and
 * the NWChem DFT page for `disp vdw 3` (D3) / `disp vdw 4` (D3BJ), whose
 * documented restriction is that vdw 4 is implemented for BLYP, B3LYP, BHLYP,
 * TPSS and TPSSh only.
 *
 * Written:
 *
 *   start <name>              job name, no spaces
 *   title "<one line>"
 *   echo                      the input echoed into the output
 *   memory total <n> mb       settings.memory, converted from GB when needed
 *   charge <q>
 *   geometry units angstroms  Cartesian atoms, one per line, H–Kr only
 *   basis / * library <name> / end
 *   dft / xc <functional> / mult <n> / [disp vdw 3|4] / end     (DFT)
 *   scf / rhf / end                                             (Hartree–Fock)
 *   task <dft|scf> <energy|optimize|freq>
 *
 * Not written, and refused rather than approximated: solvation (a `cosmo`
 * block), TD-DFT (`tddft`), constraints (`geometry adjust` / `zcoord`), ECPs,
 * and any Gaussian route keyword. `Opt Freq` is refused as one deck: NWChem
 * runs one `task` per deck here, so the block is exported as two.
 */

import {
  coordinate,
  deckTitle,
  jobToken,
  prepareMolecule,
  refuseUntranslatable,
  refusal,
} from './deck.js';

export const NWCHEM_ENGINE_ID = 'nwchem';

/** App method name → NWChem `xc` functional. */
const METHODS = Object.freeze({
  HF: null, // the `scf` module, not `dft`
  B3LYP: 'b3lyp',
  PBE0: 'pbe0',
  PBE: 'pbe96',
  'M06-2X': 'm06-2x',
});

/** App basis name → NWChem basis library entry. */
const BASES = Object.freeze({
  'STO-3G': 'sto-3g',
  '3-21G': '3-21g',
  '6-31G': '6-31g',
  '6-31G(D)': '6-31g*',
  '6-31G*': '6-31g*',
  '6-31G(D,P)': '6-31g**',
  '6-31G**': '6-31g**',
  '6-31+G(D)': '6-31+g*',
  '6-31+G*': '6-31+g*',
  '6-311G(D,P)': '6-311g**',
  '6-311G**': '6-311g**',
  '6-311+G(D,P)': '6-311+g**',
  'CC-PVDZ': 'cc-pvdz',
  'CC-PVTZ': 'cc-pvtz',
  'DEF2-SVP': 'def2-svp',
  'DEF2-TZVP': 'def2-tzvp',
  'DEF2-TZVPP': 'def2-tzvpp',
});

const JOB_TYPES = Object.freeze({
  SP: 'energy',
  Opt: 'optimize',
  Freq: 'freq',
  'Opt=TS': 'saddle',
});

/** `disp vdw 4` (D3BJ) is documented for these functionals only. */
const DISPERSION_METHODS = Object.freeze(['BLYP', 'B3LYP', 'BHLYP', 'TPSS', 'TPSH']);

export const NWCHEM_CAPABILITIES = Object.freeze({
  id: NWCHEM_ENGINE_ID,
  label: 'NWChem',
  inputExtension: '.nw',
  runnable: false,
  jobTypes: Object.freeze(Object.keys(JOB_TYPES)),
  methods: Object.freeze(Object.keys(METHODS)),
  bases: Object.freeze(Object.keys(BASES)),
  dispersion: Object.freeze(['GD3', 'GD3BJ']),
  solvation: false,
  td: false,
  ecp: false,
  notes: Object.freeze([
    'Writes `task dft <operation>`; NWChem is run by the user (mpirun nwchem job.nw).',
    'No cosmo/tddft/ECP section is written; those blocks are refused by name.',
  ]),
});

function memoryMegabytes(settings) {
  const raw = Number(settings.memory);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const unit = String(settings.memoryUnit || 'GB').toUpperCase();
  const megabytes = unit === 'MB' ? raw : raw * 1024;
  return Math.max(1, Math.round(megabytes));
}

export function renderNwchem({ settings = {}, molecule = {}, geometry = null, title = '' } = {}) {
  const prepared = prepareMolecule({ molecule, geometry });
  if (!prepared.ok) return prepared;
  const untranslatable = refuseUntranslatable(settings, 'NWChem');
  if (untranslatable) return untranslatable;

  const jobType = String(settings.jobType || 'Opt').trim();
  if (jobType === 'Opt Freq') {
    return refusal('NWChem runs one `task` per deck here, so "Opt Freq" is exported as two decks: export the Opt '
      + 'block, import the optimised geometry, then export the Freq block. A single deck with two chained tasks '
      + 'would make the frequency silently depend on whether NWChem carried the optimised geometry across.');
  }
  const operation = JOB_TYPES[jobType];
  if (!operation) {
    return refusal(`Job type "${jobType}" has no NWChem export here. Supported: ${Object.keys(JOB_TYPES).join(', ')}.`);
  }

  const method = String(settings.method || '').trim();
  if (!Object.prototype.hasOwnProperty.call(METHODS, method)) {
    return refusal(`Method "${method}" is not in this exporter's NWChem table (${Object.keys(METHODS).join(', ')}). `
      + 'A functional name is a different string in every program, so an unlisted one is refused instead of '
      + 'guessed at.');
  }
  const basisKey = String(settings.basis || '').trim().toUpperCase();
  const basis = BASES[basisKey];
  if (!basis) {
    return refusal(`Basis "${settings.basis}" is not in this exporter's NWChem table (${Object.keys(BASES).join(', ')}). `
      + 'NWChem library names are its own; an unlisted basis is refused rather than transliterated.');
  }

  const dispersion = String(settings.dispersion || '').trim();
  let dispersionKeyword = '';
  if (dispersion) {
    if (dispersion !== 'GD3' && dispersion !== 'GD3BJ') {
      return refusal(`Dispersion "${dispersion}" is not one this exporter writes for NWChem (GD3 or GD3BJ).`);
    }
    if (!DISPERSION_METHODS.includes(method.toUpperCase())) {
      return refusal(`The block asks for ${method}-D3 dispersion, but NWChem documents \`disp vdw 4\` (D3BJ) for `
        + `${DISPERSION_METHODS.join(', ')} only. Exporting ${method} without the keyword would be a different `
        + 'calculation; clear the dispersion field or choose a functional the keyword covers.');
    }
    dispersionKeyword = dispersion === 'GD3BJ' ? 'disp vdw 4' : 'disp vdw 3';
  }

  const isHf = METHODS[method] === null;
  if (isHf && prepared.multiplicity !== 1) {
    return refusal(`Hartree–Fock with multiplicity ${prepared.multiplicity} needs NWChem's open-shell \`scf\` section, `
      + 'which this exporter does not write. Use a DFT functional or a singlet.');
  }

  const memory = memoryMegabytes(settings);
  const lines = [];
  lines.push(`start ${jobToken(title || molecule.name || 'ncs')}`);
  lines.push(`title "${deckTitle(title)}"`);
  lines.push('echo');
  if (memory !== null) lines.push(`memory total ${memory} mb`);
  lines.push(`charge ${prepared.charge}`);
  lines.push('geometry units angstroms');
  for (const atom of prepared.atoms) {
    lines.push(`  ${atom.element.padEnd(2)} ${coordinate(atom.x)} ${coordinate(atom.y)} ${coordinate(atom.z)}`);
  }
  lines.push('end');
  lines.push('basis');
  lines.push(`  * library ${basis}`);
  lines.push('end');
  if (isHf) {
    lines.push('scf');
    lines.push('  rhf');
    lines.push('end');
  } else {
    lines.push('dft');
    lines.push(`  xc ${METHODS[method]}`);
    lines.push(`  mult ${prepared.multiplicity}`);
    if (dispersionKeyword) lines.push(`  ${dispersionKeyword}`);
    lines.push('end');
  }
  lines.push(`task ${isHf ? 'scf' : 'dft'} ${operation}`);
  lines.push('');

  const notes = [
    'Run with `mpirun -np <n> nwchem job.nw`; NWChem takes its process count from MPI, not from the input file.',
  ];
  if (Number(settings.nproc) > 1) {
    notes.push(`The block asks for ${Number(settings.nproc)} processes; that is the -np value, not an input keyword.`);
  }
  if (jobType === 'Opt=TS') {
    notes.push('`task dft saddle` is a saddle search that builds its own initial Hessian; a frequency job first is '
      + 'the usual way to give it a better one.');
  }
  if (jobType === 'Freq') {
    notes.push('NWChem computes the Hessian analytically by default for these functionals; `task dft freq` is the '
      + 'documented form.');
  }
  notes.push('Coordinates are Ångström, as the `geometry units angstroms` line states.');
  return { ok: true, engine: NWCHEM_ENGINE_ID, text: `${lines.join('\n')}`, notes };
}
