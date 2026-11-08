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
  // Frontier orbitals (#81). Empty cells when the log carried no Pop=Full
  // print — never a zero gap.
  { key: 'homoEv', label: 'homo_ev' },
  { key: 'lumoEv', label: 'lumo_ev' },
  { key: 'gapEv', label: 'gap_ev' },
  { key: 'hardnessEv', label: 'hardness_ev' },
  { key: 'inputSha256', label: 'input_sha256' },
  { key: 'outputSha256', label: 'output_sha256' },
]);

export const DATASET_SCHEMA_VERSION = 1;

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
    homoEv: num(parsed?.orbitals?.alpha?.homoEv),
    lumoEv: num(parsed?.orbitals?.alpha?.lumoEv),
    gapEv: num(parsed?.orbitals?.alpha?.gapEv),
    hardnessEv: num(parsed?.orbitals?.alpha?.etaEv),
    conformerProtomer: text(conformer.protomer),
    inputSha256: text(run.inputSha256),
    outputSha256: text(run.outputSha256),
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
