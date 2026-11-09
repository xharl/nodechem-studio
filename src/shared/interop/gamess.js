/**
 * GAMESS (US) input, written from the keywords the GAMESS manual documents.
 *
 * Sources: the GAMESS `$CONTRL` / `$SYSTEM` / `$BASIS` / `$DATA` group
 * documentation ("$CONTRL group" — RUNTYP, SCFTYP, ICHARG, MULT, UNITS, COORD,
 * ISPHER; "$DATA group" — a title card, a symmetry line, then `label ZNUC x y
 * z` card images; "$SYSTEM" — MWORDS), and the firefly/GAMESS input manual for
 * `$BASIS GBASIS=<STO|N21|N31|N311|CCD> NGAUSS=<n> NDFUNC= NPFUNC=`.
 *
 * Written:
 *
 *   $CONTRL  SCFTYP=RHF|UHF RUNTYP=ENERGY|OPTIMIZE|HESSIAN [DFTTYP=…] ICHARG=
 *            MULT= UNITS=ANGS COORD=CART ISPHER=
 *   $SYSTEM  MWORDS=…            settings.memory ÷ processes ÷ 8 bytes per word
 *   $BASIS   GBASIS=… NGAUSS=… [NDFUNC=1] [NPFUNC=1]
 *   $DATA    title / C1 / `label ZNUC x y z` … / ` $END`
 *
 * Coordinates are Ångström and `UNITS=ANGS` says so; the ` $DATA` card carries
 * the nuclear charge with the label because that is what GAMESS reads, not a
 * derived number.
 *
 * Not written, and refused rather than approximated: PCM solvation (`$PCM`),
 * TD-DFT (`$CIS`), constraints (`$STATPT IFREEZ`), ECPs (`$ECP`), a transition
 * state search (SADPOINT reads a Hessian from `$HESS`; synthesising one is the
 * failure this refuses), and any Gaussian route keyword. `Opt Freq` is refused
 * as one deck: GAMESS has no "optimise then frequency" RUNTYP, so the block is
 * exported as two.
 */

import {
  coordinate,
  deckTitle,
  prepareMolecule,
  refuseUntranslatable,
  refusal,
} from './deck.js';

export const GAMESS_ENGINE_ID = 'gamess';

/** App method name → `$CONTRL DFTTYP=`. `null` means Hartree–Fock: no DFTTYP. */
const METHODS = Object.freeze({
  HF: null,
  B3LYP: 'B3LYP',
  PBE: 'PBE',
  PBE0: 'PBE0',
});

/** App basis name → the `$BASIS` card GAMESS documents for it. */
const BASES = Object.freeze({
  'STO-3G': { GBASIS: 'STO', NGAUSS: 3 },
  '3-21G': { GBASIS: 'N21', NGAUSS: 3 },
  '6-31G': { GBASIS: 'N31', NGAUSS: 6 },
  '6-31G(D)': { GBASIS: 'N31', NGAUSS: 6, NDFUNC: 1 },
  '6-31G*': { GBASIS: 'N31', NGAUSS: 6, NDFUNC: 1 },
  '6-31G(D,P)': { GBASIS: 'N31', NGAUSS: 6, NDFUNC: 1, NPFUNC: 1 },
  '6-31G**': { GBASIS: 'N31', NGAUSS: 6, NDFUNC: 1, NPFUNC: 1 },
  '6-311G(D,P)': { GBASIS: 'N311', NGAUSS: 6, NDFUNC: 1, NPFUNC: 1 },
  '6-311G**': { GBASIS: 'N311', NGAUSS: 6, NDFUNC: 1, NPFUNC: 1 },
  // Correlation-consistent sets are spherical-only in GAMESS: ISPHER=1.
  'CC-PVDZ': { GBASIS: 'CCD', NGAUSS: 0, ISPHER: 1 },
  'CC-PVTZ': { GBASIS: 'CCT', NGAUSS: 0, ISPHER: 1 },
});

const JOB_TYPES = Object.freeze({
  SP: 'ENERGY',
  Opt: 'OPTIMIZE',
  Freq: 'HESSIAN',
});

export const GAMESS_CAPABILITIES = Object.freeze({
  id: GAMESS_ENGINE_ID,
  label: 'GAMESS (US)',
  inputExtension: '.inp',
  runnable: false,
  jobTypes: Object.freeze(Object.keys(JOB_TYPES)),
  methods: Object.freeze(Object.keys(METHODS)),
  bases: Object.freeze(Object.keys(BASES)),
  dispersion: Object.freeze([]),
  solvation: false,
  td: false,
  ecp: false,
  notes: Object.freeze([
    'Writes `RUNTYP=ENERGY|OPTIMIZE|HESSIAN`; GAMESS takes no dispersion keyword this exporter knows.',
    'UNITS=ANGS is written explicitly, so the $DATA coordinates are Ångström.',
  ]),
});

function megaWords(settings) {
  const raw = Number(settings.memory);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const unit = String(settings.memoryUnit || 'GB').toUpperCase();
  const gigabytes = unit === 'MB' ? raw / 1024 : raw;
  const processes = Math.max(1, Math.floor(Number(settings.nproc) || 1));
  // A GAMESS word is 8 bytes on the 64-bit builds this app targets; MWORDS is
  // per process, so the block's total memory is split across them.
  return Math.max(1, Math.floor((gigabytes * 1024) / 8 / processes));
}

export function renderGamess({ settings = {}, molecule = {}, geometry = null, title = '' } = {}) {
  const prepared = prepareMolecule({ molecule, geometry });
  if (!prepared.ok) return prepared;
  const untranslatable = refuseUntranslatable(settings, 'GAMESS');
  if (untranslatable) return untranslatable;

  const jobType = String(settings.jobType || 'Opt').trim();
  if (jobType === 'Opt Freq') {
    return refusal('GAMESS has no "optimise then frequency" RUNTYP: `HESSIAN` is its own run, reading the geometry '
      + 'it is given. Export the Opt block, import the optimised geometry, then export the Freq block.');
  }
  if (jobType === 'Opt=TS') {
    return refusal('A GAMESS transition-state search (`RUNTYP=SADPOINT`) reads its initial Hessian from a `$HESS` '
      + 'group, which this exporter does not synthesise. Run the frequency block first and hand its `$HESS` to a '
      + 'SADPOINT deck.');
  }
  const runtime = JOB_TYPES[jobType];
  if (!runtime) {
    return refusal(`Job type "${jobType}" has no GAMESS export here. Supported: ${Object.keys(JOB_TYPES).join(', ')}.`);
  }

  const method = String(settings.method || '').trim();
  if (!Object.prototype.hasOwnProperty.call(METHODS, method)) {
    return refusal(`Method "${method}" is not in this exporter's GAMESS table (${Object.keys(METHODS).join(', ')}). `
      + 'GAMESS functional spellings are its own; an unlisted one is refused rather than guessed at.');
  }
  const basis = BASES[String(settings.basis || '').trim().toUpperCase()];
  if (!basis) {
    return refusal(`Basis "${settings.basis}" is not in this exporter's GAMESS table (${Object.keys(BASES).join(', ')}). `
      + 'Def2 sets live in a separate GAMESS basis library that this exporter does not carry.');
  }
  const dispersion = String(settings.dispersion || '').trim();
  if (dispersion) {
    return refusal(`The block asks for ${dispersion} dispersion. This exporter writes no GAMESS dispersion keyword, `
      + 'and GAMESS does not add one from the functional name: exporting it would silently compute the undispersed '
      + 'functional. Clear the dispersion field or add the keyword by hand.');
  }

  const dftType = METHODS[method];
  const contrl = [
    `SCFTYP=${prepared.multiplicity > 1 ? 'UHF' : 'RHF'}`,
    `RUNTYP=${runtime}`,
    ...(dftType ? [`DFTTYP=${dftType}`] : []),
    `ICHARG=${prepared.charge}`,
    `MULT=${prepared.multiplicity}`,
    'UNITS=ANGS',
    'COORD=CART',
    `ISPHER=${basis.ISPHER ?? 0}`,
  ];
  const basisCard = ['GBASIS=' + basis.GBASIS];
  if (basis.NGAUSS > 0) basisCard.push(`NGAUSS=${basis.NGAUSS}`);
  if (basis.NDFUNC) basisCard.push(`NDFUNC=${basis.NDFUNC}`);
  if (basis.NPFUNC) basisCard.push(`NPFUNC=${basis.NPFUNC}`);

  const mwords = megaWords(settings);
  const lines = [];
  lines.push(` $CONTRL ${contrl.join(' ')} $END`);
  if (mwords !== null) lines.push(` $SYSTEM MWORDS=${mwords} $END`);
  lines.push(` $BASIS ${basisCard.join(' ')} $END`);
  lines.push(' $DATA');
  lines.push(deckTitle(title));
  lines.push('C1');
  for (const atom of prepared.atoms) {
    const znuc = { H: 1, C: 6, N: 7, O: 8, F: 9, P: 15, S: 16, Cl: 17, Br: 35, I: 53, B: 5 }[atom.element];
    // Every element H–Kr has a nuclear charge this table can state; anything
    // missing would be a chemistry error, so it is a refusal, not a zero.
    if (znuc === undefined) {
      return refusal(`No nuclear charge is tabulated for ${atom.element} in this exporter's GAMESS writer.`);
    }
    lines.push(`${atom.element} ${znuc.toFixed(1)} ${coordinate(atom.x)} ${coordinate(atom.y)} ${coordinate(atom.z)}`);
  }
  lines.push(' $END');
  lines.push('');

  const notes = [
    'Symmetry is written as C1, so GAMESS uses the geometry exactly as given.',
    'Run with `rungms job.inp`; the process count comes from the script, not from the input file.',
  ];
  if (dftType) {
    notes.push('GAMESS spellings of functionals are not numerically interchangeable with Gaussian\'s; '
      + `DFTTYP=${dftType} is the string GAMESS documents.`);
  }
  if (runtime === 'HESSIAN') {
    notes.push('RUNTYP=HESSIAN computes the Hessian and the harmonic analysis; GAMESS echoes coordinates in Bohr '
      + 'whatever UNITS says on input.');
  }
  return { ok: true, engine: GAMESS_ENGINE_ID, text: `${lines.join('\n')}`, notes };
}
