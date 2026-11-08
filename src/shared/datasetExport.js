/**
 * Dataset export: every finished run as one flat row.
 *
 * The per-run `run.json` is the source of truth; this module only reshapes it
 * into a table a spreadsheet or a script can consume. It never derives a value
 * that is not in the record: a missing energy is an empty cell, not a zero, and
 * a dry run keeps its `dryRun` flag so a fixture cannot be mistaken for a
 * calculation.
 *
 * Two formats are produced from the same rows: CSV (RFC 4180 quoting) and a
 * versioned JSON envelope with the schema, the app version and the rows.
 */

export const DATASET_CSV_COLUMNS = Object.freeze([
  { key: 'id', label: 'run_id' },
  { key: 'finishedAt', label: 'finished_at' },
  { key: 'title', label: 'title' },
  { key: 'engine', label: 'engine' },
  { key: 'jobType', label: 'job_type' },
  { key: 'method', label: 'method' },
  { key: 'basis', label: 'basis' },
  { key: 'dispersion', label: 'dispersion' },
  { key: 'solvation', label: 'solvation' },
  { key: 'status', label: 'status' },
  { key: 'gates', label: 'gates' },
  { key: 'validity', label: 'validity' },
  { key: 'finalEnergyHartree', label: 'final_energy_hartree' },
  { key: 'gibbsHartree', label: 'gibbs_hartree' },
  { key: 'imaginaryCount', label: 'imaginary_count' },
  { key: 'scfCycles', label: 'scf_cycles' },
  { key: 'elapsedSeconds', label: 'elapsed_seconds' },
  { key: 'dryRun', label: 'dry_run' },
  // Issue #80: fanned-out runs are one row per member. The conformer columns
  // keep the member grouping visible in a spreadsheet instead of collapsing N
  // runs into N rows that differ only by title.
  { key: 'conformerNode', label: 'conformer_node' },
  { key: 'conformerMember', label: 'conformer_member' },
  { key: 'conformerRelativeKcal', label: 'conformer_relative_kcal' },
  { key: 'conformerPopulation', label: 'conformer_population' },
  { key: 'conformerProtomer', label: 'conformer_protomer' },
  // Frontier orbitals (#88). Empty cells when the log carried no Pop=Full
  // print — never a zero gap.
  { key: 'homoEv', label: 'homo_ev' },
  { key: 'lumoEv', label: 'lumo_ev' },
  { key: 'gapEv', label: 'gap_ev' },
  { key: 'hardnessEv', label: 'hardness_ev' },
  { key: 'inputSha256', label: 'input_sha256' },
  { key: 'outputSha256', label: 'output_sha256' },
  // Issue #59: a run that carries a `.fchk` and/or a `.cube` records what was
  // read from them. The columns are appended rather than inserted so an
  // existing spreadsheet template keeps its column positions, and every one of
  // them is empty when the run had no wavefunction attachment — an empty cell
  // is "not measured", not zero.
  { key: 'fchkSha256', label: 'fchk_sha256' },
  { key: 'cubeSha256', label: 'cube_sha256' },
  { key: 'cubeDims', label: 'cube_dims' },
  { key: 'cubeMin', label: 'cube_min' },
  { key: 'cubeMax', label: 'cube_max' },
  { key: 'cubeMean', label: 'cube_mean' },
  { key: 'fchkTotalEnergyHartree', label: 'fchk_total_energy_hartree' },
  { key: 'mullikenChargeSum', label: 'mulliken_charge_sum' },
  { key: 'mullikenChargeDeviation', label: 'mulliken_charge_deviation' },
  { key: 'spinMultiplicity', label: 'spin_multiplicity' },
  { key: 'unpairedElectrons', label: 'unpaired_electrons' },
  // Issue #96: a value that came from an ensemble or a method ladder carries
  // its spread beside it. The columns are appended so an existing spreadsheet
  // template keeps its positions; an absent block is an empty cell, never a
  // zero and never a "0.00" that would read as a measured spread.
  { key: 'conformerSpreadKcal', label: 'conformer_ensemble_spread_kcal' },
  { key: 'conformerTemperatureK', label: 'conformer_ensemble_temperature_k' },
  { key: 'ladderSpreadKcal', label: 'ladder_spread_kcal' },
  { key: 'ladderSpreadOver', label: 'ladder_spread_over' },
  { key: 'ladderCbsHartree', label: 'ladder_cbs_hartree' },
  { key: 'ladderCbsSpreadKcal', label: 'ladder_cbs_spread_kcal' },
  { key: 'ladderCbsForm', label: 'ladder_cbs_form' },
]);

/** Version 3 added the method-sensitivity columns; existing keys are unchanged. */
export const DATASET_SCHEMA_VERSION = 3;

function text(value) {
  return value === null || value === undefined ? null : String(value);
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integer(value) {
  const number = num(value);
  return number === null || !Number.isInteger(number) ? null : number;
}

/**
 * One run record → one flat row. Unknown fields stay `null`.
 */
export function runRow(record) {
  const run = record && typeof record === 'object' ? record : {};
  const parsed = run.parsed && typeof run.parsed === 'object' ? run.parsed : {};
  const provenance = run.provenance && typeof run.provenance === 'object' ? run.provenance : {};
  const method = provenance.method && typeof provenance.method === 'object' ? provenance.method : {};
  const conformer = run.conformer && typeof run.conformer === 'object' ? run.conformer : {};
  // The wavefunction block is written by `wavefunction.js` when a run carries a
  // `.fchk`/`.cube`; a record without one reads as an empty block, so every
  // column below stays null rather than becoming a zero.
  const wavefunction = run.wavefunction && typeof run.wavefunction === 'object'
    ? run.wavefunction
    : parsed.wavefunction && typeof parsed.wavefunction === 'object' ? parsed.wavefunction : {};
  const artifacts = Array.isArray(wavefunction.artifacts) ? wavefunction.artifacts : [];
  const artifactSha = (kind) => {
    const match = artifacts.find((item) => item && item.kind === kind);
    return text(match?.sha256);
  };
  const cube = wavefunction.cube && typeof wavefunction.cube === 'object' ? wavefunction.cube : null;
  const fchk = wavefunction.fchk && typeof wavefunction.fchk === 'object' ? wavefunction.fchk : null;
  // Issue #96: a run may carry the ladder it belonged to and the conformer
  // ensemble it was expanded from. Neither block is invented here; absent
  // metadata stays an empty cell.
  const ladder = run.ladder && typeof run.ladder === 'object' ? run.ladder : {};
  const ladderCbs = ladder.cbs && typeof ladder.cbs === 'object' ? ladder.cbs : {};
  const ensemble = run.ensemble && typeof run.ensemble === 'object' ? run.ensemble : {};
  const cbsReported = ladderCbs.available === true;
  // Derived blocks are present but may be `{ok: false, reason}`. Only a
  // computed value reaches a cell; "not computable" is an empty cell, and the
  // reason lives in the run record.
  const gap = fchk?.orbitalGap?.ok === true ? fchk.orbitalGap : null;
  const charge = fchk?.chargeSanity?.ok === true ? fchk.chargeSanity : null;
  const spin = fchk?.spin?.ok === true ? fchk.spin : null;
  const dims = Array.isArray(cube?.dims) && cube.dims.length === 3 ? cube.dims.join('x') : null;
  return {
    id: text(run.id),
    finishedAt: text(run.finishedAt || run.startedAt),
    title: text(run.title),
    engine: text(run.engine || parsed.engine),
    jobType: text(provenance.jobType || method.jobType),
    method: text(method.functional || method.hamiltonian),
    basis: text(method.basis),
    dispersion: text(method.dispersion),
    solvation: text(method.solvation),
    status: text(run.status),
    gates: text(run.gates?.overall ?? run.gateVerdict),
    validity: text(run.gates?.validity?.overall ?? run.validity?.overall),
    finalEnergyHartree: num(parsed.finalEnergy?.hartree ?? parsed.scf?.energyHartree),
    gibbsHartree: num(parsed.thermochemistry?.freeEnergyHartree),
    imaginaryCount: integer(parsed.frequencies?.imaginaryCount),
    scfCycles: integer(parsed.scf?.cycles),
    elapsedSeconds: num(run.elapsedSeconds ?? parsed.resources?.elapsedSeconds),
    dryRun: run.dryRun === true,
    conformerNode: text(conformer.nodeId),
    conformerMember: text(conformer.id),
    conformerRelativeKcal: num(conformer.relativeKcal),
    conformerPopulation: num(conformer.population),
    // Frontier orbitals: the log's Pop=Full table first, because that is the
    // calculation's own print. A run whose route did not ask for it can still
    // carry a checkpoint, which holds the same converged SCF orbitals, so the
    // fchk-derived values fill the cells instead of leaving them empty.
    homoEv: num(parsed?.orbitals?.alpha?.homoEv) ?? num(gap?.homo?.energyEv),
    lumoEv: num(parsed?.orbitals?.alpha?.lumoEv) ?? num(gap?.lumo?.energyEv),
    gapEv: num(parsed?.orbitals?.alpha?.gapEv) ?? num(gap?.gapEv),
    hardnessEv: num(parsed?.orbitals?.alpha?.etaEv),
    conformerProtomer: text(conformer.protomer),
    inputSha256: text(run.inputSha256),
    outputSha256: text(run.outputSha256),
    fchkSha256: artifactSha('fchk'),
    cubeSha256: artifactSha('cube'),
    cubeDims: text(dims),
    cubeMin: num(cube?.stats?.min),
    cubeMax: num(cube?.stats?.max),
    cubeMean: num(cube?.stats?.mean),
    fchkTotalEnergyHartree: num(fchk?.totalEnergyHartree),
    mullikenChargeSum: num(charge?.chargeSum),
    mullikenChargeDeviation: num(charge?.deviation),
    spinMultiplicity: integer(spin?.multiplicity),
    unpairedElectrons: integer(spin?.unpairedElectrons),
    conformerSpreadKcal: num(conformer.spreadKcal),
    conformerTemperatureK: num(conformer.temperatureK ?? ensemble.temperatureK),
    ladderSpreadKcal: num(ladder.spreadKcal),
    ladderSpreadOver: text(ladder.spreadOver),
    ladderCbsHartree: cbsReported ? num(ladderCbs.energyHartree) : null,
    ladderCbsSpreadKcal: cbsReported ? num(ladderCbs.spread?.kcal ?? ladderCbs.spreadKcal) : null,
    ladderCbsForm: cbsReported ? text(ladderCbs.form) : null,
  };
}

export function runRows(records) {
  return (Array.isArray(records) ? records : []).map(runRow);
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const raw = String(value);
  // RFC 4180: quote when the value contains a delimiter, a quote or a newline.
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

export function datasetCsv(rows) {
  const header = DATASET_CSV_COLUMNS.map((column) => column.label).join(',');
  const lines = (Array.isArray(rows) ? rows : []).map((row) => (
    DATASET_CSV_COLUMNS.map((column) => csvCell(row?.[column.key])).join(',')
  ));
  return [header, ...lines].join('\n') + '\n';
}

export function datasetJson(rows, { generatedAt = null, appVersion = null } = {}) {
  return {
    schemaVersion: DATASET_SCHEMA_VERSION,
    kind: 'nodechem-studio.dataset',
    generatedAt: generatedAt === null ? null : String(generatedAt),
    appVersion: appVersion === null ? null : String(appVersion),
    rowCount: Array.isArray(rows) ? rows.length : 0,
    rows: Array.isArray(rows) ? rows : [],
  };
}
