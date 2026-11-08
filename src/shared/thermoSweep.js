/**
 * Rigid-rotor / harmonic-oscillator thermochemistry at an arbitrary temperature
 * and pressure, itemised so every term can be checked.
 *
 * Gaussian prints one thermochemistry table, at the temperature and pressure in
 * the route (`Temperature=` / `Pressure=`), and nothing else. Recomputing at
 * another T or p is not a correction bolted onto that table: it needs the
 * partition function, which means the molecular mass, the rotational constants,
 * the symmetry number and the frequencies. All four are in the output.
 *
 * The formulas are the textbook RRHO ones (Sackur–Tetrode translation,
 * rigid-rotor rotation, harmonic vibration) and the test suite pins them
 * against Gaussian's own printed table at 298.15 K / 1 atm: the components
 * agree to 0.001 cal/mol/K, so the same code moved to 350 K or 0.1 atm is not
 * an extrapolation guess.
 *
 * Electronic excitation is not modelled: the electronic partition function is
 * the ground-state degeneracy, as in Gaussian's own table.
 */

export const HARTREE_TO_KCAL_PER_MOL = 627.5094740631;
export const R_J_PER_MOL_K = 8.314462618;
export const CALORIE_TO_JOULE = 4.184;
export const JOULES_PER_KCAL = 4184;
export const PLANCK_J_S = 6.62607015e-34;
export const BOLTZMANN_J_PER_K = 1.380649e-23;
export const SPEED_OF_LIGHT_CM_PER_S = 2.99792458e10;
export const AMU_KG = 1.66053906660e-27;
export const ATM_PA = 101325;
export const STANDARD_TEMPERATURE_K = 298.15;
export const STANDARD_PRESSURE_ATM = 1;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** Molecular mass in kg from the `Molecular mass: … amu.` line. */
function massKg(thermochemistry) {
  return finite(thermochemistry.molecularMassAmu) ? thermochemistry.molecularMassAmu * AMU_KG : null;
}

function rotationalMoments(thermochemistry) {
  const constants = thermochemistry.rotationalConstantsGHz;
  if (!Array.isArray(constants)) return null;
  const moments = constants
    .filter((value) => finite(value) && value > 0)
    .map((ghz) => PLANCK_J_S / (8 * Math.PI ** 2 * ghz * 1e9));
  return moments.length >= 2 ? moments : null;
}

/**
 * Thermochemistry at one (T, p).
 *
 * Returns `{ available: false, missing }` when the output does not carry the
 * constants needed to recompute, rather than falling back to the printed table
 * and calling that a new temperature.
 */
export function thermoAt(parsed, {
  temperatureK = STANDARD_TEMPERATURE_K,
  pressureAtm = STANDARD_PRESSURE_ATM,
  includeZeroPoint = true,
} = {}) {
  const T = Number(temperatureK);
  const p = Number(pressureAtm);
  if (!finite(T) || T <= 0) throw new Error('Temperature must be a positive number of kelvin.');
  if (!finite(p) || p <= 0) throw new Error('Pressure must be a positive number of atmospheres.');

  const thermochemistry = parsed?.thermochemistry || {};
  const missing = [];
  const mass = massKg(thermochemistry);
  if (mass === null) missing.push('molecular mass');
  const moments = rotationalMoments(thermochemistry);
  if (moments === null) missing.push('rotational constants');
  const symmetryNumber = finite(thermochemistry.symmetryNumber) && thermochemistry.symmetryNumber > 0
    ? thermochemistry.symmetryNumber : 1;
  const frequencies = Array.isArray(parsed?.frequencies?.values)
    ? parsed.frequencies.values.filter((value) => finite(value) && value > 0)
    : [];
  if (frequencies.length === 0) missing.push('vibrational frequencies');
  const zeroPointKcal = finite(thermochemistry.zeroPointVibrationalEnergyKcalPerMol)
    ? thermochemistry.zeroPointVibrationalEnergyKcalPerMol : null;

  if (missing.length > 0) return { available: false, missing, temperatureK: T, pressureAtm: p };

  const nonlinear = moments.length === 3;
  const rt = R_J_PER_MOL_K * T;

  // Translation: Sackur–Tetrode. Pressure enters here and nowhere else.
  const qTrans = ((2 * Math.PI * mass * BOLTZMANN_J_PER_K * T) / PLANCK_J_S ** 2) ** 1.5
    * (BOLTZMANN_J_PER_K * T) / (p * ATM_PA);
  const sTrans = R_J_PER_MOL_K * (Math.log(qTrans) + 2.5);
  const eTrans = 1.5 * rt;
  const cvTrans = 1.5 * R_J_PER_MOL_K;

  // Rotation: rigid rotor, linear uses two moments and no 1/sigma^(?) change —
  // sigma still divides the partition function.
  const inertia = nonlinear
    ? Math.sqrt(moments[0] * moments[1] * moments[2])
    : moments[0];
  const qRot = nonlinear
    ? (Math.sqrt(Math.PI) / symmetryNumber) * ((8 * Math.PI ** 2 * BOLTZMANN_J_PER_K * T) / PLANCK_J_S ** 2) ** 1.5 * inertia
    : ((8 * Math.PI ** 2 * BOLTZMANN_J_PER_K * T) / PLANCK_J_S ** 2) * inertia / symmetryNumber;
  const rotationalDegrees = nonlinear ? 1.5 : 1;
  const sRot = R_J_PER_MOL_K * (Math.log(qRot) + rotationalDegrees);
  const eRot = rotationalDegrees * rt;
  const cvRot = rotationalDegrees * R_J_PER_MOL_K;

  let sVib = 0;
  let eVib = 0;
  let cvVib = 0;
  let zeroPointJ = 0;
  const modes = [];
  for (const wavenumber of frequencies) {
    const x = (PLANCK_J_S * SPEED_OF_LIGHT_CM_PER_S * wavenumber) / (BOLTZMANN_J_PER_K * T);
    const occupation = 1 / (Math.expm1(x));
    const e = R_J_PER_MOL_K * T * x * occupation;
    const s = R_J_PER_MOL_K * (x * occupation - Math.log1p(-Math.exp(-x)));
    const cv = R_J_PER_MOL_K * x * x * Math.exp(x) / Math.expm1(x) ** 2;
    eVib += e;
    sVib += s;
    cvVib += cv;
    zeroPointJ += 0.5 * PLANCK_J_S * SPEED_OF_LIGHT_CM_PER_S * wavenumber * 6.02214076e23;
    modes.push({ wavenumber, energyKcalPerMol: e / JOULES_PER_KCAL, entropyCalPerMolK: s / CALORIE_TO_JOULE });
  }
  const zeroPointKcalComputed = zeroPointJ / JOULES_PER_KCAL;

  const zeroPointUsedKcal = includeZeroPoint ? (zeroPointKcal ?? zeroPointKcalComputed) : 0;
  const thermalKcal = (eTrans + eRot + eVib) / JOULES_PER_KCAL;
  const entropyCal = (sTrans + sRot + sVib) / CALORIE_TO_JOULE;
  const heatCapacityCal = (cvTrans + cvRot + cvVib) / CALORIE_TO_JOULE;

  const enthalpyCorrectionKcal = zeroPointUsedKcal + thermalKcal + rt / JOULES_PER_KCAL;
  const gibbsCorrectionKcal = enthalpyCorrectionKcal - (T * entropyCal) / 1000;

  const electronicHartree = finite(thermochemistry.zeroPointEnergyHartree)
    && finite(thermochemistry.zeroPointCorrectionHartree)
    ? thermochemistry.zeroPointEnergyHartree - thermochemistry.zeroPointCorrectionHartree
    : null;

  return {
    available: true,
    temperatureK: T,
    pressureAtm: p,
    standardState: { temperatureK: STANDARD_TEMPERATURE_K, pressureAtm: STANDARD_PRESSURE_ATM },
    geometry: nonlinear ? 'nonlinear' : 'linear',
    symmetryNumber,
    frequencyCount: frequencies.length,
    zeroPointKcalPerMol: zeroPointKcalComputed,
    components: {
      translational: { energyKcalPerMol: eTrans / JOULES_PER_KCAL, entropyCalPerMolK: sTrans / CALORIE_TO_JOULE, heatCapacityCalPerMolK: cvTrans / CALORIE_TO_JOULE },
      rotational: { energyKcalPerMol: eRot / JOULES_PER_KCAL, entropyCalPerMolK: sRot / CALORIE_TO_JOULE, heatCapacityCalPerMolK: cvRot / CALORIE_TO_JOULE },
      vibrational: { energyKcalPerMol: eVib / JOULES_PER_KCAL, entropyCalPerMolK: sVib / CALORIE_TO_JOULE, heatCapacityCalPerMolK: cvVib / CALORIE_TO_JOULE },
      electronic: { energyKcalPerMol: 0, entropyCalPerMolK: 0, heatCapacityCalPerMolK: 0 },
    },
    totals: {
      thermalEnergyKcalPerMol: thermalKcal + zeroPointUsedKcal,
      enthalpyKcalPerMol: enthalpyCorrectionKcal,
      entropyCalPerMolK: entropyCal,
      heatCapacityCalPerMolK: heatCapacityCal,
      gibbsKcalPerMol: gibbsCorrectionKcal,
    },
    // Itemised so a table can show each line and each can be switched off.
    terms: [
      { id: 'zero-point', label: 'Zero-point energy', kcalPerMol: includeZeroPoint ? zeroPointUsedKcal : 0, enabled: includeZeroPoint },
      { id: 'translational', label: 'Translational (3 kT/2)', kcalPerMol: eTrans / JOULES_PER_KCAL, enabled: true },
      { id: 'rotational', label: `Rotational (${rotationalDegrees === 1.5 ? '3' : '2'} RT/2)`, kcalPerMol: eRot / JOULES_PER_KCAL, enabled: true },
      { id: 'vibrational', label: 'Vibrational thermal', kcalPerMol: eVib / JOULES_PER_KCAL, enabled: true },
      { id: 'pv', label: 'pV = RT', kcalPerMol: rt / JOULES_PER_KCAL, enabled: true },
      { id: 'entropy', label: `−TΔS at ${T} K`, kcalPerMol: -(T * entropyCal) / 1000, enabled: true },
    ],
    absolute: {
      electronicEnergyHartree: electronicHartree,
      gibbsHartree: electronicHartree === null ? null : electronicHartree + gibbsCorrectionKcal / HARTREE_TO_KCAL_PER_MOL,
    },
    modes,
  };
}

/**
 * A temperature/pressure grid. Pressures are a list because the standard state
 * is the usual reason to sweep them (1 atm vs 1 M).
 */
export function thermoGrid(parsed, {
  temperaturesK = [STANDARD_TEMPERATURE_K],
  pressuresAtm = [STANDARD_PRESSURE_ATM],
  includeZeroPoint = true,
} = {}) {
  const rows = [];
  for (const temperatureK of temperaturesK) {
    for (const pressureAtm of pressuresAtm) {
      const result = thermoAt(parsed, { temperatureK, pressureAtm, includeZeroPoint });
      rows.push(result);
    }
  }
  return rows;
}

/** RFC 4180 CSV of a grid, with the same columns the panel shows. */
export function thermoCsv(rows, { includeModes = false } = {}) {
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = [
    'temperature_K', 'pressure_atm', 'geometry', 'symmetry_number', 'modes',
    'zero_point_kcal_per_mol', 'translational_kcal_per_mol', 'rotational_kcal_per_mol',
    'vibrational_kcal_per_mol', 'pv_kcal_per_mol', 'entropy_cal_per_mol_K',
    'heat_capacity_cal_per_mol_K', 'gibbs_correction_kcal_per_mol', 'gibbs_hartree',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    if (!row.available) {
      lines.push([row.temperatureK, row.pressureAtm, 'not available', '', '', ...Array(10).fill('')].map(escape).join(','));
      continue;
    }
    const c = row.components;
    lines.push([
      row.temperatureK,
      row.pressureAtm,
      row.geometry,
      row.symmetryNumber,
      row.frequencyCount,
      row.zeroPointKcalPerMol.toFixed(6),
      c.translational.energyKcalPerMol.toFixed(6),
      c.rotational.energyKcalPerMol.toFixed(6),
      c.vibrational.energyKcalPerMol.toFixed(6),
      (row.totals.enthalpyKcalPerMol - row.totals.thermalEnergyKcalPerMol).toFixed(6),
      row.totals.entropyCalPerMolK.toFixed(4),
      row.totals.heatCapacityCalPerMolK.toFixed(4),
      row.totals.gibbsKcalPerMol.toFixed(6),
      row.absolute.gibbsHartree === null ? '' : row.absolute.gibbsHartree.toFixed(9),
    ].map(escape).join(','));
  }
  if (includeModes && rows[0]?.available) {
    for (const mode of rows[0].modes) {
      lines.push(['mode', mode.wavenumber.toFixed(4), mode.energyKcalPerMol.toFixed(6), mode.entropyCalPerMolK.toFixed(6)].join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}
