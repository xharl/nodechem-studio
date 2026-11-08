/**
 * pKa and redox cycles with a cited reference library.
 *
 * Both results are differences between two computed free energies, anchored to
 * a measured reference. Nothing here is a prediction from a model: if either
 * side of the cycle has no frequency job, the result is `not reported` and the
 * missing block is named.
 *
 * pKa uses the isodesmic cycle already implemented in `reactionPath.js` and the
 * 1.364 kcal mol⁻¹ per pKa unit constant defined in `thermochemistry.js`
 * (2.303 RT at 298.15 K). E° uses
 *
 *   E°(sample) = E°(reference) + [ΔG(reference) − ΔG(sample)] / (n F)
 *
 * with both ΔG values computed at the same level of theory and in the same
 * solvent, so the electron convention and the absolute potential cancel. F is
 * 96485.33212 C mol⁻¹, i.e. 23.0605 kcal mol⁻¹ V⁻¹.
 *
 * References:
 * - IUPAC. Quantities, Units and Symbols in Physical Chemistry, 3rd ed., 2007
 *   (standard electrode potential, SHE reference).
 * - Eyring, H. J. Chem. Phys. 1935, 3, 107 (the pKa/E° link through ΔG).
 */

import pkaData from '../data/pkaReferences.json' with { type: 'json' };
import redoxData from '../data/redoxReferences.json' with { type: 'json' };
import { HARTREE_TO_KCAL_PER_MOL, PK_UNIT_KCAL_PER_MOL } from './thermochemistry.js';
import { pKaFromCycle } from './reactionPath.js';

/** kcal mol⁻¹ per pKa unit: 2.303 RT at 298.15 K, as defined in thermochemistry.js. */
export const DEPROTONATION_UNIT = PK_UNIT_KCAL_PER_MOL;

/** Faraday constant in kcal mol⁻¹ V⁻¹: 96485.33212 C mol⁻¹ / 4184 J kcal⁻¹. */
export const FARADAY_KCAL_PER_MOL_V = 96485.33212 / 4184;

const PKA_REFERENCES = Object.freeze((Array.isArray(pkaData?.references) ? pkaData.references : [])
  .map((entry) => Object.freeze({ ...entry, source: Object.freeze({ ...entry.source }) })));
const REDOX_REFERENCES = Object.freeze((Array.isArray(redoxData?.references) ? redoxData.references : [])
  .map((entry) => Object.freeze({ ...entry, source: Object.freeze({ ...entry.source }) })));

const PKA_BY_ID = new Map(PKA_REFERENCES.map((entry) => [entry.id, entry]));
const REDOX_BY_ID = new Map(REDOX_REFERENCES.map((entry) => [entry.id, entry]));

/** Every shipped reference-acid id, in file order. */
export function referenceAcidIds() {
  return PKA_REFERENCES.map((entry) => entry.id);
}

/** One reference acid with its provenance, or null when the id is not shipped. */
export function referenceAcid(id) {
  return PKA_BY_ID.get(String(id)) || null;
}

/** Every shipped reference-couple id, in file order. */
export function referenceCoupleIds() {
  return REDOX_REFERENCES.map((entry) => entry.id);
}

/** One reference couple with its potential and provenance, or null. */
export function referenceCouple(id) {
  return REDOX_BY_ID.get(String(id)) || null;
}

/** Free energy of one species in kcal/mol, from a hartree thermochemistry record. */
function freeEnergyKcal(species) {
  const hartree = species?.thermochemistry?.freeEnergyHartree
    ?? species?.freeEnergyHartree
    ?? null;
  if (Number.isFinite(hartree)) return hartree * HARTREE_TO_KCAL_PER_MOL;
  if (Number.isFinite(species?.freeEnergyKcal)) return species.freeEnergyKcal;
  return null;
}

function label(species, fallback) {
  return String(species?.label || fallback || 'the species');
}

function temperatureText(kelvin) {
  return `${Number(kelvin).toFixed(2)} K`;
}

/**
 * pKa of an acid from a four-species isodesmic cycle.
 *
 * The sample side is `acid`/`conjugateBase`; the reference side is a second
 * acid/base pair whose pKa is in the shipped library. All four free energies
 * must come from frequency jobs at the same level of theory in the same
 * solvent — that condition is the caller's to meet, and a mismatch of solvent
 * against the library entry is refused rather than papered over.
 */
export function pkaCycle({
  acid = null,
  conjugateBase = null,
  referenceAcid: referenceAcidSpecies = null,
  referenceBase = null,
  referenceId = null,
  solvent = null,
  temperatureK = 298.15,
  standardStateAtm = 1,
} = {}) {
  const reference = referenceId ? referenceAcid(referenceId) : null;
  const missing = [];
  if (freeEnergyKcal(acid) === null) missing.push('the acid free energy');
  if (freeEnergyKcal(conjugateBase) === null) missing.push('the conjugate base free energy');
  if (freeEnergyKcal(referenceAcidSpecies) === null) missing.push('the reference acid free energy');
  if (freeEnergyKcal(referenceBase) === null) missing.push('the reference base free energy');

  const refused = (refusal, extra = {}) => ({
    available: false,
    kind: 'pka',
    pKa: null,
    pKaText: 'not reported',
    deltaGDeprotonationKcal: null,
    deltaGReferenceKcal: null,
    unit: {
      value: DEPROTONATION_UNIT,
      unit: 'kcal mol⁻¹ per pKa unit',
      name: `${DEPROTONATION_UNIT} kcal mol⁻¹ per pKa unit`,
      meaning: '2.303 RT at 298.15 K (PK_UNIT_KCAL_PER_MOL in thermochemistry.js)',
    },
    reference: reference
      ? {
        id: reference.id,
        name: reference.name,
        pKa: reference.pKa,
        citation: reference.source.citation,
        solvent: reference.solvent,
        temperatureK: reference.temperatureK,
      }
      : null,
    solvent: solvent || null,
    temperatureK,
    missing,
    refusal,
    scheme: 'pKa = pKa(reference) + [ΔG(sample) − ΔG(reference)] / 1.364 kcal mol⁻¹, isodesmic cycle at the stated standard state',
    ...extra,
  });

  if (referenceId && !reference) {
    return refused(`pKa is not computable: the reference acid "${referenceId}" is not in the shipped library, so there is no reference pKa to anchor the cycle.`);
  }
  if (!reference) {
    return refused('pKa is not computable: no reference acid is selected from the shipped library.');
  }
  if (!solvent) {
    return refused('pKa is not computable: the solvent is missing, and a pKa is only defined in one.');
  }
  if (String(solvent).toLowerCase() !== String(reference.solvent).toLowerCase()) {
    return refused(`pKa is not computable: the solvent of the cycle is ${solvent} but the reference acid ${reference.name} is a ${reference.solvent} value, so the two free energies are not on the same scale.`);
  }
  if (missing.length > 0) {
    return refused(`pKa is not computable: missing ${missing.join(', ')}. A pKa from an electronic energy alone would be a free-energy difference with a decimal point moved.`);
  }

  const deltaGDeprotonationKcal = freeEnergyKcal(conjugateBase) - freeEnergyKcal(acid);
  const deltaGReferenceKcal = freeEnergyKcal(referenceBase) - freeEnergyKcal(referenceAcidSpecies);
  const cycle = pKaFromCycle({
    deltaGDeprotonationKcal,
    deltaGReferenceKcal,
    referencePKa: reference.pKa,
    solvent: reference.solvent,
    standardStateK: temperatureK,
    standardStateAtm,
  });
  if (!cycle.available) {
    return refused(`pKa is not computable: ${cycle.reason}`);
  }
  return {
    available: true,
    kind: 'pka',
    pKa: cycle.pKa,
    pKaText: cycle.pKa.toFixed(2),
    deltaGDeprotonationKcal,
    deltaGReferenceKcal,
    unit: {
      value: DEPROTONATION_UNIT,
      unit: 'kcal mol⁻¹ per pKa unit',
      name: `${DEPROTONATION_UNIT} kcal mol⁻¹ per pKa unit`,
      meaning: '2.303 RT at 298.15 K (PK_UNIT_KCAL_PER_MOL in thermochemistry.js)',
    },
    reference: {
      id: reference.id,
      name: reference.name,
      formula: reference.formula,
      conjugateBase: reference.conjugateBase,
      pKa: reference.pKa,
      citation: reference.source.citation,
      solvent: reference.solvent,
      temperatureK: reference.temperatureK,
    },
    solvent: reference.solvent,
    temperatureK,
    standardState: { temperatureK, pressureAtm: standardStateAtm },
    missing: [],
    refusal: null,
    scheme: cycle.scheme,
  };
}

/** One rendered line for a card or report. A refusal stays a refusal. */
export function pkaCycleLine(result) {
  const unit = `using ${DEPROTONATION_UNIT} kcal mol⁻¹ per pKa unit`;
  if (!result || result.available !== true) {
    return `pKa = not reported — ${result?.refusal || 'the cycle is incomplete'}`;
  }
  return `pKa = ${result.pKaText} — ΔG_deprot = ${result.deltaGDeprotonationKcal.toFixed(2)} kcal mol⁻¹, `
    + `reference ${result.reference.name} (pKa ${result.reference.pKa.toFixed(2)}, ${result.reference.solvent}, `
    + `${temperatureText(result.reference.temperatureK)}), ${unit}. `
    + `Reference: ${result.reference.citation}`;
}

/** The electron count of a half reaction, from the charge on each side. */
function electronsFromCharges(oxidized, reduced) {
  const ox = oxidized?.charge;
  const red = reduced?.charge;
  if (!Number.isInteger(ox) || !Number.isInteger(red)) return null;
  const count = ox - red;
  return Number.isInteger(count) && count > 0 ? count : null;
}

/**
 * E° of a half reaction from a thermodynamic cycle against a computed
 * reference couple.
 *
 * `reference.oxidized` and `reference.reduced` are free energies of the
 * reference couple's own two species, computed at the same level; the library
 * supplies the measured E° that anchors them to SHE. Supplying the library
 * offset alone (without the reference free energies) is not enough, and is
 * refused: that would turn a computed ΔG into an absolute potential, which
 * needs the electron convention this cycle exists to cancel.
 */
export function redoxCycle({
  oxidized = null,
  reduced = null,
  reference = null,
  electrons = null,
  solvent = null,
  temperatureK = 298.15,
} = {}) {
  const couple = reference?.coupleId ? referenceCouple(reference.coupleId) : null;
  const missing = [];
  if (freeEnergyKcal(oxidized) === null) missing.push('the oxidised species free energy');
  if (freeEnergyKcal(reduced) === null) missing.push('the reduced species free energy');
  if (freeEnergyKcal(reference?.oxidized) === null) missing.push('the reference couple oxidised free energy');
  if (freeEnergyKcal(reference?.reduced) === null) missing.push('the reference couple reduced free energy');

  const refused = (refusal, extra = {}) => ({
    available: false,
    kind: 'redox',
    e0V: null,
    e0Text: 'not reported',
    deltaGKcalPerMol: null,
    electrons: null,
    faraday: { value: FARADAY_KCAL_PER_MOL_V, unit: 'kcal mol⁻¹ V⁻¹' },
    reference: couple
      ? {
        id: couple.id,
        name: couple.name,
        e0V: couple.e0V,
        solvent: couple.solvent,
        temperatureK: couple.temperatureK,
        citation: couple.source.citation,
      }
      : null,
    solvent: solvent || null,
    temperatureK,
    sheOffsetV: couple ? couple.e0V : null,
    missing,
    refusal,
    scheme: 'E°(sample) = E°(reference) + [ΔG(reference) − ΔG(sample)] / (nF), both free energies computed at the same level of theory',
    ...extra,
  });

  if (reference?.coupleId && !couple) {
    return refused(`E° is not computable: the reference couple "${reference.coupleId}" is not in the shipped library.`);
  }
  if (!couple) {
    return refused('E° is not computable: no reference couple is selected, and an absolute potential is not a measured scale.');
  }
  if (!solvent) {
    return refused('E° is not computable: the solvent is missing, and a couple potential is only defined in one.');
  }
  if (String(solvent).toLowerCase() !== String(couple.solvent).toLowerCase()) {
    return refused(`E° is not computable: the solvent of the cycle is ${solvent} but the reference couple ${couple.name} is a ${couple.solvent} value.`);
  }
  const derived = Number.isInteger(electrons) && electrons > 0
    ? electrons
    : electronsFromCharges(oxidized, reduced);
  if (!derived) {
    return refused('E° is not computable: the electron count is neither given nor derivable from the charges on each side.');
  }
  const referenceElectrons = electronsFromCharges(reference.oxidized, reference.reduced);
  if (referenceElectrons !== null && referenceElectrons !== derived) {
    return refused(`E° is not computable: the sample transfers ${derived} electron(s) but the reference couple transfers ${referenceElectrons}.`);
  }
  if (missing.length > 0) {
    return refused(`E° is not computable: missing ${missing.join(', ')}.`);
  }

  const deltaGKcalPerMol = freeEnergyKcal(reduced) - freeEnergyKcal(oxidized);
  const deltaGReferenceKcal = freeEnergyKcal(reference.reduced) - freeEnergyKcal(reference.oxidized);
  const e0V = couple.e0V + (deltaGReferenceKcal - deltaGKcalPerMol) / (derived * FARADAY_KCAL_PER_MOL_V);
  return {
    available: true,
    kind: 'redox',
    e0V,
    e0Text: `${e0V.toFixed(3)} V`,
    deltaGKcalPerMol,
    deltaGReferenceKcal,
    electrons: derived,
    faraday: { value: FARADAY_KCAL_PER_MOL_V, unit: 'kcal mol⁻¹ V⁻¹' },
    reference: {
      id: couple.id,
      name: couple.name,
      couple: couple.couple,
      e0V: couple.e0V,
      solvent: couple.solvent,
      temperatureK: couple.temperatureK,
      citation: couple.source.citation,
    },
    solvent: couple.solvent,
    temperatureK,
    sheOffsetV: couple.e0V,
    missing: [],
    refusal: null,
    scheme: 'E°(sample) = E°(reference) + [ΔG(reference) − ΔG(sample)] / (nF), both free energies computed at the same level of theory',
  };
}

/** One rendered line for a card or report. A refusal stays a refusal. */
export function redoxCycleLine(result) {
  if (!result || result.available !== true) {
    return `E° = not reported — ${result?.refusal || 'the cycle is incomplete'}`;
  }
  return `E° = ${result.e0Text} vs SHE — ΔG = ${result.deltaGKcalPerMol.toFixed(2)} kcal mol⁻¹ for n = ${result.electrons}, `
    + `reference ${result.reference.name} (${result.reference.e0V.toFixed(3)} V vs SHE, ${result.reference.solvent}, `
    + `${temperatureText(result.reference.temperatureK)}), F = ${FARADAY_KCAL_PER_MOL_V.toFixed(4)} kcal mol⁻¹ V⁻¹.`;
}
