/**
 * Deterministic methods-paragraph generator for one NodeChem Studio run.
 *
 * Pure: no DOM, no filesystem, no Electron, no clock, no randomness, no
 * locale-dependent formatting and no network. The only inputs are the run
 * record and the requested form.
 *
 * The paragraph describes exactly what `run.json` records. A field that is
 * absent is named as `not recorded in run.json`; no default functional, basis
 * set, dispersion correction, grid, solvent, thermochemistry correction or
 * program version is ever filled in. A dry-run fixture is refused outright,
 * because its output is synthetic and must never be described as a real
 * calculation.
 */

export const METHODS_FORMS = Object.freeze(['short', 'full']);

export const NOT_RECORDED = 'not recorded in run.json';

const JOB_TYPES = Object.freeze(['Opt', 'Opt Freq', 'Opt=TS', 'Freq', 'IRC', 'SP', 'Scan']);

const JOB_LABELS = Object.freeze({
  Opt: 'a geometry optimization',
  'Opt Freq': 'a geometry optimization followed by a harmonic frequency calculation',
  'Opt=TS': 'a transition-state search',
  Freq: 'a harmonic frequency calculation',
  IRC: 'an intrinsic reaction coordinate (IRC) calculation',
  SP: 'a single-point energy calculation',
  Scan: 'a relaxed potential-energy surface scan',
});

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function joinList(items) {
  const list = items.filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function fixedNumber(value, digits) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : null;
}

function methodOf(record) {
  const method = record?.provenance?.method;
  return method && typeof method === 'object' && !Array.isArray(method) ? method : null;
}

function engineIdFor(record) {
  const raw = clean(record?.engine).toLowerCase();
  return raw;
}

/** Why a record cannot be described as a real calculation, or null. */
function fixtureDetail(record) {
  const kind = clean(record?.provenance?.kind).toLowerCase();
  if (kind === 'fixture') return 'provenance.kind is "fixture"';
  if (record?.dryRun === true) return 'dryRun is true';
  if (clean(record?.outputSource).toLowerCase() === 'fixture') return 'outputSource is "fixture"';
  return null;
}

export function isFixtureRun(record = {}) {
  return fixtureDetail(record) !== null;
}

function normaliseJobType(value) {
  const text = clean(value);
  if (!text) return null;
  return JOB_TYPES.find((type) => type.toLowerCase() === text.toLowerCase()) || null;
}

/** The job keyword is the only job record there is when provenance.jobType is absent. */
function jobFromRoute(route) {
  const text = clean(route);
  if (!text) return null;
  if (/\bOpt\s*=\s*(?:\([^)]*\bTS\b|TS)/i.test(text)) return 'Opt=TS';
  if (/\bIRC\b/i.test(text)) return 'IRC';
  if (/\bScan\b/i.test(text)) return 'Scan';
  const opt = /\bOpt\b/i.test(text);
  const freq = /\bFreq\b/i.test(text);
  if (opt && freq) return 'Opt Freq';
  if (opt) return 'Opt';
  if (freq) return 'Freq';
  return 'SP';
}

function jobFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  const args = argv.map(String);
  if (args.includes('--ohess')) return 'Opt Freq';
  if (args.includes('--opt')) return 'Opt';
  if (args.includes('--hess')) return 'Freq';
  return args.length > 0 ? 'SP' : null;
}

/**
 * Job type precedence: explicit record fields first, then the route (Gaussian)
 * or argv (xTB). `source` is reported so the prose can say where it came from.
 */
function jobInfoFor(record, engine) {
  for (const candidate of [
    record?.provenance?.jobType,
    record?.jobType,
    record?.provenance?.method?.jobType,
  ]) {
    const type = normaliseJobType(candidate);
    if (type) return { type, source: 'record' };
  }
  if (engine === 'xtb') {
    const type = jobFromArgv(record?.argv);
    if (type) return { type, source: 'argv' };
  } else {
    const type = jobFromRoute(record?.parsed?.route);
    if (type) return { type, source: 'route' };
  }
  return { type: null, source: null };
}

function programLabel(record, engine) {
  const program = record?.parsed?.program && typeof record.parsed.program === 'object'
    ? record.parsed.program : {};
  const nameRaw = clean(program.name);
  const version = clean(program.version);
  const revision = clean(program.revision);

  if (engine === 'xtb') {
    const name = !nameRaw || /xtb/i.test(nameRaw) ? 'xTB' : nameRaw;
    if (!version) return `${name} (version ${NOT_RECORDED})`;
    return `${name} ${version}${revision ? ` (revision ${revision})` : ''}`;
  }

  const name = nameRaw || (engine === 'gaussian' ? 'Gaussian' : 'the program');
  if (!version) return `${name} (version ${NOT_RECORDED})`;
  return `${name} ${version}${revision ? `, revision ${revision}` : ''}`;
}

function appLabel(record) {
  const version = clean(record?.app?.version);
  const commit = clean(record?.app?.commit);
  if (!version) return `NodeChem Studio (version ${NOT_RECORDED})`;
  return `NodeChem Studio ${version}${commit ? ` (commit ${commit})` : ''}`;
}

/** Gaussian level of theory, or null when the method block carries neither field. */
function gaussianLevelPhrase(method) {
  if (!method) return null;
  const functional = clean(method.functional);
  const basis = clean(method.basis);
  if (functional && basis) return `the ${functional}/${basis} level of theory`;
  if (functional) return `the ${functional} functional with a basis set that is ${NOT_RECORDED}`;
  if (basis) return `the ${basis} basis set with a functional that is ${NOT_RECORDED}`;
  return null;
}

function solvationPhrase(method) {
  const raw = clean(method?.solvation);
  if (!raw) return null;
  const slash = raw.indexOf('/');
  if (slash === -1) return `the ${raw} solvation model`;
  const model = raw.slice(0, slash).trim();
  const solvent = raw.slice(slash + 1).trim();
  if (!model) return null;
  return solvent
    ? `the ${model} solvation model with ${solvent} as solvent`
    : `the ${model} solvation model`;
}

/** xTB Hamiltonian from the parsed summary, then from the recorded argv. */
function xtbHamiltonian(record) {
  const parsed = clean(record?.parsed?.scf?.method);
  if (parsed) return parsed;
  const argv = Array.isArray(record?.argv) ? record.argv.map(String) : [];
  if (argv.includes('--gfnff')) return 'GFN-FF';
  const index = argv.indexOf('--gfn');
  if (index !== -1 && argv[index + 1] !== undefined) {
    const value = clean(argv[index + 1]);
    if (value === '2') return 'GFN2-xTB';
    if (value === '1') return 'GFN1-xTB';
    if (value === '0') return 'GFN0-xTB';
    if (value) return `GFN${value}-xTB`;
  }
  return null;
}

function xtbSolvation(record) {
  const argv = Array.isArray(record?.argv) ? record.argv.map(String) : [];
  for (const [flag, model] of [['--alpb', 'ALPB'], ['--gbsa', 'GBSA']]) {
    const index = argv.indexOf(flag);
    if (index !== -1 && argv[index + 1] !== undefined) {
      const solvent = clean(argv[index + 1]);
      if (solvent) return { model, solvent };
    }
  }
  return null;
}

function hasThermochemistry(record) {
  const thermo = record?.parsed?.thermochemistry;
  if (!thermo || typeof thermo !== 'object') return false;
  return [
    'freeEnergyHartree',
    'enthalpyHartree',
    'thermalEnergyHartree',
    'zeroPointEnergyHartree',
    'temperatureK',
    'pressureAtm',
  ].some((key) => thermo[key] !== null && thermo[key] !== undefined);
}

function thermochemistryPhrase(record, engine) {
  if (engine === 'xtb') {
    const treatment = clean(record?.parsed?.frequencies?.entropyTreatment)
      || clean(record?.parsed?.thermochemistry?.entropyTreatment);
    if (!treatment) {
      return `no xTB entropy treatment; an additional quasi-RRHO correction and a 1 atm -> 1 M standard-state correction are ${NOT_RECORDED}`;
    }
    return `the xTB ${treatment} entropy treatment, with no additional quasi-RRHO correction or 1 atm -> 1 M standard-state correction recorded in run.json`;
  }

  if (!hasThermochemistry(record)) {
    return `no thermochemistry block; a quasi-RRHO cutoff and a 1 atm -> 1 M standard-state correction are ${NOT_RECORDED}`;
  }
  const thermo = record.parsed.thermochemistry;
  const temperature = fixedNumber(thermo.temperatureK, 3);
  const pressure = fixedNumber(thermo.pressureAtm, 3);
  let conditions;
  if (temperature && pressure) conditions = `at ${temperature} K and ${pressure} atm`;
  else if (temperature) conditions = `at ${temperature} K, with pressure ${NOT_RECORDED}`;
  else if (pressure) conditions = `at ${pressure} atm, with temperature ${NOT_RECORDED}`;
  else conditions = `with temperature and pressure ${NOT_RECORDED}`;
  return `harmonic thermochemistry ${conditions}, with no quasi-RRHO entropy treatment or 1 atm -> 1 M standard-state correction recorded in run.json`;
}

function geometryPhrase(record) {
  const provenance = record?.provenance && typeof record.provenance === 'object'
    ? record.provenance : {};
  const geometry = provenance.geometry && typeof provenance.geometry === 'object'
    ? provenance.geometry : null;
  const source = clean(geometry?.source) || clean(provenance.geometrySource) || clean(record?.geometry?.source);
  const conformer = clean(provenance.conformer) || clean(provenance.conformerId) || clean(record?.conformer);
  const protomer = clean(provenance.protomer) || clean(provenance.protomerId) || clean(record?.protomer);

  const sourceText = source
    ? `the geometry source is recorded as ${source}`
    : `the geometry source is ${NOT_RECORDED}`;
  const conformerText = conformer
    ? `the conformer is recorded as ${conformer}`
    : `the conformer is ${NOT_RECORDED}`;
  const protomerText = protomer
    ? `the protomer is recorded as ${protomer}`
    : `the protomer is ${NOT_RECORDED}`;
  return `${sourceText}, ${conformerText} and ${protomerText}`;
}

function provenancePhrase(record) {
  const id = clean(record?.id) || `whose id is ${NOT_RECORDED}`;
  const kind = clean(record?.provenance?.kind) || NOT_RECORDED;
  return `run ${id} with provenance kind ${kind}, generated by ${appLabel(record)}`;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Markdown italics around a value that must not break the emphasis. */
function emphasised(value) {
  return clean(value).replace(/[*_`]/g, '');
}

/**
 * Which record ran, and how it was derived (issue 193).
 *
 * A dataset fan-out writes one run record per record, and a series member is
 * "n of count" copies of one unit. `run.json` carries `record` and `series`
 * for exactly those cases, so the paragraph can attribute the number it
 * describes: "record 3 of 6 from dataset *monomers*" and "the 3-mer of
 * *ethene*". A single-structure run carries neither key and gets no sentence
 * at all — an input identity is never invented.
 */
function recordProvenanceText(record) {
  const identity = isObject(record?.record) ? record.record : null;
  const series = isObject(record?.series) ? record.series : null;
  if (!identity && !series) return '';

  const datasetId = emphasised(identity?.datasetId);
  const from = datasetId ? ` from dataset *${datasetId}*` : '';
  const n = Number.isInteger(series?.n) ? series.n : null;
  const count = Number.isInteger(series?.count) ? series.count : null;
  const parentId = emphasised(series?.parentId);

  if (parentId) {
    const position = n !== null && count !== null
      ? `record ${n} of ${count}`
      : n !== null ? `record ${n}` : 'a series member';
    const derived = n !== null ? `the ${n}-mer of *${parentId}*` : `a member of the unit *${parentId}*`;
    return `This run is ${position}${from}: ${derived}.`;
  }

  const label = emphasised(identity?.label);
  const id = emphasised(identity?.id);
  if (!label && !id) return '';
  const named = label && label !== id ? `record *${label}* (${id})` : `record *${id}*`;
  return `This run is ${named}${from}.`;
}

function shortOpening(record, engine, program, job) {
  const jobText = job.type ? JOB_LABELS[job.type] : `a job whose type is ${NOT_RECORDED}`;
  if (engine === 'xtb') {
    const hamiltonian = xtbHamiltonian(record);
    const methodText = hamiltonian
      ? `the ${hamiltonian} Hamiltonian`
      : `an xTB Hamiltonian that is ${NOT_RECORDED}`;
    return `The calculation used ${program} with ${methodText} for ${jobText}, as recorded in run.json.`;
  }
  const level = gaussianLevelPhrase(methodOf(record));
  if (!level) {
    return `Calculations were performed with ${program} for ${jobText}; the level of theory is ${NOT_RECORDED}.`;
  }
  return `Calculations were performed with ${program} at ${level} for ${jobText}, as recorded in run.json.`;
}

function shortRouteSentence(record, engine) {
  if (engine === 'xtb') {
    const solvation = xtbSolvation(record);
    const solvationText = solvation
      ? `implicit solvation with the ${solvation.model} model and solvent ${solvation.solvent}`
      : 'no implicit-solvation flag (gas phase)';
    const scf = record?.parsed?.scf && typeof record.parsed.scf === 'object' ? record.parsed.scf : {};
    const status = clean(scf.status);
    const cycles = scf.cycles !== null && scf.cycles !== undefined && Number.isFinite(Number(scf.cycles))
      ? Number(scf.cycles) : null;
    const scfText = status
      ? `SCC convergence is recorded as ${status}${cycles !== null ? ` after ${cycles} cycles` : ''}`
      : `SCC convergence is ${NOT_RECORDED}`;
    return `The run records ${solvationText}; xTB uses no Gaussian-style basis set or integration grid, and ${scfText}.`;
  }

  const method = methodOf(record);
  if (!method) {
    return `The run records no method block, so dispersion, solvation, grid and SCF convergence are ${NOT_RECORDED}.`;
  }
  const dispersion = clean(method.dispersion);
  const grid = clean(method.grid);
  const scf = clean(method.scf);
  const pieces = [
    dispersion ? `the ${dispersion} empirical dispersion correction` : 'no empirical dispersion correction',
    solvationPhrase(method) || 'no solvation model (gas phase)',
    grid ? `the ${grid} integration grid` : 'no integration-grid keyword',
    scf ? `${scf} SCF convergence` : 'no SCF-convergence keyword',
  ];
  return `The run records ${joinList(pieces)}.`;
}

function shortClosing(record, engine) {
  return `The run records ${thermochemistryPhrase(record, engine)}; ${geometryPhrase(record)}; the paragraph describes ${provenancePhrase(record)}.`;
}

function programSentence(record, engine) {
  return `Calculations were performed with ${programLabel(record, engine)}, as recorded in run.json.`;
}

function jobSentence(job) {
  if (!job.type) return `The job type is ${NOT_RECORDED}.`;
  const note = job.source === 'route'
    ? ' (derived from the route recorded in run.json)'
    : job.source === 'argv'
      ? ' (derived from the argv recorded in run.json)'
      : ' (as recorded in run.json)';
  return `The job type is ${JOB_LABELS[job.type]}${note}.`;
}

function levelSentence(record, engine) {
  if (engine === 'xtb') {
    const hamiltonian = xtbHamiltonian(record);
    const prefix = hamiltonian
      ? `The calculation used the ${hamiltonian} Hamiltonian`
      : `The calculation used an xTB Hamiltonian that is ${NOT_RECORDED}`;
    return `${prefix}; xTB selects its Hamiltonian with --gfn, so no Gaussian-style functional or basis set applies (basis set: not applicable to xTB), as recorded in run.json.`;
  }
  const level = gaussianLevelPhrase(methodOf(record));
  if (!level) {
    return `No method block is recorded in run.json, so the level of theory is unknown.`;
  }
  return `The calculation used ${level}, as recorded in run.json.`;
}

function dispersionSentence(record, engine) {
  if (engine === 'xtb') {
    const method = methodOf(record);
    // Only an engine-owned xTB block may describe xTB dispersion. A stale
    // Gaussian-shaped block on an old record must stay ignored.
    const value = method && clean(method.hamiltonian) ? clean(method.dispersion) : '';
    return value
      ? `Dispersion is built into the xTB parameterisation (${value}); no separate empirical dispersion keyword was applied.`
      : 'No separate empirical dispersion keyword is recorded in run.json; any dispersion treatment belongs to the xTB Hamiltonian and is not itemised in the record.';
  }
  const method = methodOf(record);
  if (!method) return `The dispersion treatment is ${NOT_RECORDED} because no method block is recorded.`;
  const value = clean(method.dispersion);
  return value
    ? `Empirical dispersion was treated with the ${value} correction, as recorded in run.json.`
    : 'No empirical dispersion correction is recorded in run.json (the route has no EmpiricalDispersion keyword).';
}

function solvationSentence(record, engine) {
  if (engine === 'xtb') {
    const solvation = xtbSolvation(record);
    return solvation
      ? `Implicit solvation used the ${solvation.model} model with the xTB solvent identifier "${solvation.solvent}", as recorded in argv in run.json.`
      : 'No implicit-solvation flag (--alpb or --gbsa) is recorded in run.json; the run is gas phase.';
  }
  const method = methodOf(record);
  if (!method) return `The solvation treatment is ${NOT_RECORDED} because no method block is recorded.`;
  const phrase = solvationPhrase(method);
  return phrase
    ? `Implicit solvation used ${phrase}, as recorded in run.json.`
    : 'The calculation is recorded as gas phase (no SCRF solvation keyword is present in run.json).';
}

function gridScfSentence(record, engine) {
  if (engine === 'xtb') {
    const scf = record?.parsed?.scf && typeof record.parsed.scf === 'object' ? record.parsed.scf : {};
    const status = clean(scf.status);
    const cycles = scf.cycles !== null && scf.cycles !== undefined && Number.isFinite(Number(scf.cycles))
      ? Number(scf.cycles) : null;
    const convergence = status
      ? `SCC convergence is recorded as ${status}${cycles !== null ? ` after ${cycles} cycles` : ''}`
      : `SCC convergence is ${NOT_RECORDED}`;
    return `xTB uses no Gaussian-style integration grid (grid: not applicable to xTB); ${convergence}.`;
  }
  const method = methodOf(record);
  if (!method) {
    return `The integration grid and SCF convergence are ${NOT_RECORDED} because no method block is recorded.`;
  }
  const grid = clean(method.grid);
  const scf = clean(method.scf);
  if (grid && scf) return `The ${grid} integration grid and ${scf} SCF convergence were used, as recorded in run.json.`;
  if (grid) return `The ${grid} integration grid was used; SCF convergence is ${NOT_RECORDED}.`;
  if (scf) return `SCF convergence was ${scf}; the integration grid is ${NOT_RECORDED}.`;
  return 'No integration-grid (Integral) or SCF-convergence (SCF) keyword is recorded in run.json.';
}

function buildBlocks(record, engine, job, missing) {
  if (!clean(record?.parsed?.program?.version)) missing.push('program.version');
  if (!job.type) missing.push('jobType');
  if (engine === 'xtb') {
    if (!xtbHamiltonian(record)) missing.push('xTB Hamiltonian');
  } else {
    if (!methodOf(record)) missing.push('provenance.method');
    if (!clean(methodOf(record)?.dispersion)) missing.push('provenance.method.dispersion');
    if (!clean(methodOf(record)?.solvation)) missing.push('provenance.method.solvation');
    if (!clean(methodOf(record)?.grid)) missing.push('provenance.method.grid');
  }
  if (!hasThermochemistry(record) && !clean(record?.parsed?.frequencies?.entropyTreatment)) {
    missing.push('parsed.thermochemistry');
  }

  const gridLabel = engine === 'xtb' ? 'Grid and SCC convergence' : 'Grid and SCF convergence';
  // Issue 193: appended only when the record carries `record` or `series`, so
  // a paragraph for a single-structure run is unchanged, sentence for sentence.
  const recordText = recordProvenanceText(record);
  const blocks = [
    { id: 'program', label: 'Program and version', text: programSentence(record, engine) },
    { id: 'job', label: 'Job type', text: jobSentence(job) },
    { id: 'level', label: 'Level of theory', text: levelSentence(record, engine) },
    { id: 'dispersion', label: 'Dispersion', text: dispersionSentence(record, engine) },
    { id: 'solvation', label: 'Solvation', text: solvationSentence(record, engine) },
    { id: 'gridScf', label: gridLabel, text: gridScfSentence(record, engine) },
    { id: 'thermochemistry', label: 'Thermochemistry', text: `The run records ${thermochemistryPhrase(record, engine)}.` },
    { id: 'geometry', label: 'Geometry and species', text: `The run record states that ${geometryPhrase(record)}.` },
    ...(recordText ? [{ id: 'record', label: 'Record', text: recordText }] : []),
    { id: 'provenance', label: 'Provenance', text: `The paragraph describes ${provenancePhrase(record)}.` },
  ];
  return blocks;
}

function refusal(record, form, engine, detail) {
  const id = clean(record?.id) || 'unknown';
  return {
    ok: false,
    refused: true,
    reason: 'fixture',
    form,
    engine,
    message:
      `Refusing to write a methods paragraph for run ${id}: ${detail}. `
      + 'This is a dry-run fixture, not a real calculation; a methods section must not describe '
      + 'synthetic output as computed data.',
    plain: '',
    markdown: '',
    missing: [],
  };
}

/**
 * Generate a methods paragraph from a run record.
 *
 * @param {object} record A `run.json` record.
 * @param {{form?: 'short'|'full'}} options `full` is the default.
 * @returns {{
 *   ok: boolean, refused: boolean, reason?: string, message?: string,
 *   form: string, engine: string, plain: string, markdown: string,
 *   missing: string[], fields?: string[]
 * }}
 */
export function methodsParagraphFor(record, options = {}) {
  const form = options && typeof options === 'object' ? options.form : undefined;
  const chosenForm = form === 'short' ? 'short' : 'full';
  const engine = engineIdFor(record);

  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return {
      ok: false,
      refused: false,
      reason: 'missing-record',
      form: chosenForm,
      engine,
      message: 'No run record was supplied, so no methods paragraph can be generated.',
      plain: '',
      markdown: '',
      missing: [],
    };
  }

  const detail = fixtureDetail(record);
  if (detail) return refusal(record, chosenForm, engine, detail);

  const job = jobInfoFor(record, engine);
  const missing = [];
  const blocks = buildBlocks(record, engine, job, missing);

  let plain;
  if (chosenForm === 'short') {
    const program = programLabel(record, engine);
    plain = [
      shortOpening(record, engine, program, job),
      shortRouteSentence(record, engine),
      shortClosing(record, engine),
      // Issue 193: empty for a single-structure run, so the short form it
      // produced before this field existed is unchanged.
      recordProvenanceText(record),
    ].filter(Boolean).join(' ');
  } else {
    plain = blocks.map((block) => `${block.label}: ${block.text}`).join('\n\n');
  }

  const markdown = chosenForm === 'short'
    ? `## Computational methods\n\n${plain}\n`
    : `## Computational methods\n\n${blocks.map((block) => `**${block.label}:** ${block.text}`).join('\n\n')}\n`;

  return {
    ok: true,
    refused: false,
    form: chosenForm,
    engine,
    plain,
    markdown,
    missing: [...new Set(missing)],
    fields: blocks.map((block) => block.id),
  };
}
