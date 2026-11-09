import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  EXPORTERS,
  EXPORT_ENGINE_IDS,
  exporterFor,
  parseNwchemInput,
  renderInput,
} from '../src/shared/interop/index.js';
import { parseStructureRecords } from '../src/shared/structureImport.js';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'bin', 'ncs.js');

async function ncs(args) {
  try {
    const result = await run(process.execPath, [cli, ...args], { cwd: root });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

const WATER = {
  coords: [
    { element: 'O', x: 0, y: 0, z: 0.1173 },
    { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
    { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
  ],
  charge: 0,
  multiplicity: 1,
};

const SETTINGS = {
  jobType: 'Opt',
  method: 'B3LYP',
  basis: '6-31G*',
  dispersion: '',
  memory: '4',
  memoryUnit: 'GB',
  nproc: '4',
};

const GEOMETRY = { source: 'imported', file: 'water.xyz', format: 'xyz', dimension: '' };

const render = (engine, overrides = {}) => renderInput({
  engine,
  settings: { ...SETTINGS, ...(overrides.settings || {}) },
  molecule: { ...WATER, ...(overrides.molecule || {}) },
  geometry: overrides.geometry === undefined ? GEOMETRY : overrides.geometry,
  title: overrides.title || 'Water optimisation',
});

/**
 * A deck is checked two ways: the exact keywords this exporter claims to write,
 * and by reading the text back through the app's own importer. The second test
 * is the one that would catch a writer that prints numbers a reader cannot
 * recover — a deck that looks right and is not.
 */
describe('NWChem export', () => {
  it('writes the documented blocks for a B3LYP/6-31G* optimisation', () => {
    const rendered = render('nwchem');
    expect(rendered.ok).toBe(true);
    expect(rendered.text).toMatch(/^start Water_optimisation$/m);
    expect(rendered.text).toMatch(/^title "Water optimisation"$/m);
    expect(rendered.text).toMatch(/^memory total 4096 mb$/m);
    expect(rendered.text).toMatch(/^charge 0$/m);
    expect(rendered.text).toMatch(/^geometry units angstroms$/m);
    expect(rendered.text).toMatch(/^ {2}O {2}0\.0 0\.0 0\.1173$/m);
    expect(rendered.text).toMatch(/^ {2}\* library 6-31g\*$/m);
    expect(rendered.text).toMatch(/^ {2}xc b3lyp$/m);
    expect(rendered.text).toMatch(/^task dft optimize$/m);
  });

  it('writes dispersion only for the functionals NWChem documents for vdw 4', () => {
    const withD3 = render('nwchem', { settings: { dispersion: 'GD3BJ' } });
    expect(withD3.text).toMatch(/^ {2}disp vdw 4$/m);
    const withD3zero = render('nwchem', { settings: { dispersion: 'GD3' } });
    expect(withD3zero.text).toMatch(/^ {2}disp vdw 3$/m);
    // `disp vdw 4` is documented for B3LYP, BLYP, BHLYP, TPSS and TPSSh only.
    const pbe = render('nwchem', { settings: { method: 'PBE', dispersion: 'GD3BJ' } });
    expect(pbe.ok).toBe(false);
    expect(pbe.refused).toMatch(/NWChem documents `disp vdw 4` \(D3BJ\) for BLYP, B3LYP, BHLYP, TPSS, TPSH only/);
  });

  it('writes the `scf` module for Hartree–Fock, and refuses an open-shell HF it cannot spell', () => {
    const hf = render('nwchem', { settings: { method: 'HF' } });
    expect(hf.text).toMatch(/^scf$/m);
    expect(hf.text).toMatch(/^ {2}rhf$/m);
    expect(hf.text).toMatch(/^task scf optimize$/m);
    const triplet = render('nwchem', { settings: { method: 'HF' }, molecule: { multiplicity: 3 } });
    expect(triplet.ok).toBe(false);
    expect(triplet.refused).toMatch(/open-shell `scf` section/);
  });

  it('writes `mult` for an open-shell DFT block', () => {
    const rendered = render('nwchem', { molecule: { multiplicity: 3 } });
    expect(rendered.text).toMatch(/^ {2}mult 3$/m);
  });

  it('refuses Opt Freq as one deck, naming the two it would take', () => {
    const rendered = render('nwchem', { settings: { jobType: 'Opt Freq' } });
    expect(rendered.ok).toBe(false);
    expect(rendered.refused).toMatch(/one `task` per deck/);
  });
});

describe('GAMESS export', () => {
  it('writes $CONTRL, $SYSTEM, $BASIS and $DATA for a B3LYP/6-31G* optimisation', () => {
    const rendered = render('gamess');
    expect(rendered.ok).toBe(true);
    expect(rendered.text).toMatch(/^ \$CONTRL SCFTYP=RHF RUNTYP=OPTIMIZE DFTTYP=B3LYP ICHARG=0 MULT=1 UNITS=ANGS COORD=CART ISPHER=0 \$END$/m);
    expect(rendered.text).toMatch(/^ \$SYSTEM MWORDS=128 \$END$/m);
    expect(rendered.text).toMatch(/^ \$BASIS GBASIS=N31 NGAUSS=6 NDFUNC=1 \$END$/m);
    expect(rendered.text).toMatch(/^ \$DATA\nWater optimisation\nC1\n/m);
    expect(rendered.text).toMatch(/^O 8\.0 0\.0 0\.0 0\.1173$/m);
    expect(rendered.text).toMatch(/^ \$END$/m);
  });

  it('writes SCFTYP=UHF for a multiplet above a singlet', () => {
    const rendered = render('gamess', { molecule: { multiplicity: 3 } });
    expect(rendered.text).toMatch(/SCFTYP=UHF .*MULT=3/);
  });

  it('writes RUNTYP=HESSIAN for a frequency job', () => {
    const rendered = render('gamess', { settings: { jobType: 'Freq' } });
    expect(rendered.text).toMatch(/RUNTYP=HESSIAN/);
  });

  it('refuses a basis it does not carry rather than writing a name GAMESS may not resolve', () => {
    const rendered = render('gamess', { settings: { basis: 'def2-SVP' } });
    expect(rendered.ok).toBe(false);
    expect(rendered.refused).toMatch(/separate GAMESS basis library/);
  });

  it('refuses dispersion, because GAMESS would silently compute the undispersed functional', () => {
    const rendered = render('gamess', { settings: { dispersion: 'GD3BJ' } });
    expect(rendered.ok).toBe(false);
    expect(rendered.refused).toMatch(/silently compute the undispersed functional/);
  });

  it('refuses a saddle search: SADPOINT reads a Hessian this exporter will not synthesise', () => {
    const rendered = render('gamess', { settings: { jobType: 'Opt=TS' } });
    expect(rendered.ok).toBe(false);
    expect(rendered.refused).toMatch(/\$HESS/);
  });
});

describe('Q-Chem export', () => {
  it('writes $molecule, $comment and $rem for a B3LYP/def2-SVP optimisation', () => {
    const rendered = render('qchem', { settings: { basis: 'def2-SVP' } });
    expect(rendered.ok).toBe(true);
    expect(rendered.text).toMatch(/^\$comment\nWater optimisation\n\$end$/m);
    expect(rendered.text).toMatch(/^\$molecule\n0 1\n/m);
    expect(rendered.text).toMatch(/^O {2}0\.0 0\.0 0\.1173$/m);
    expect(rendered.text).toMatch(/^JOBTYPE {4}opt$/m);
    expect(rendered.text).toMatch(/^METHOD {5}b3lyp$/m);
    expect(rendered.text).toMatch(/^BASIS {6}def2-svp$/m);
    expect(rendered.text).toMatch(/^MEM_TOTAL {2}4096$/m);
  });

  it('maps GD3/GD3BJ onto DFT_D = D3_ZERO / D3_BJ, the spellings the manual lists', () => {
    expect(render('qchem', { settings: { dispersion: 'GD3BJ' } }).text).toMatch(/^DFT_D {6}D3_BJ$/m);
    expect(render('qchem', { settings: { dispersion: 'GD3' } }).text).toMatch(/^DFT_D {6}D3_ZERO$/m);
  });

  it('writes no DFT_D for ωB97X-D, which carries dispersion already', () => {
    const rendered = render('qchem', { settings: { method: 'ωB97X-D', basis: 'def2-SVP', dispersion: 'GD3BJ' } });
    expect(rendered.ok).toBe(true);
    expect(rendered.text).toMatch(/^METHOD {5}wb97x-d$/m);
    expect(rendered.text).not.toMatch(/DFT_D/);
  });

  it('puts charge and multiplicity on the $molecule line, which is what Q-Chem reads', () => {
    const rendered = render('qchem', { settings: { basis: 'def2-SVP' }, molecule: { charge: -1, multiplicity: 2 } });
    expect(rendered.text).toMatch(/^\$molecule\n-1 2\n/m);
  });

  it('refuses a transition-state search, which needs a $ts group', () => {
    const rendered = render('qchem', { settings: { jobType: 'Opt=TS' } });
    expect(rendered.ok).toBe(false);
    expect(rendered.refused).toMatch(/\$ts/);
  });
});

describe('job keywords, in each program\'s own spelling', () => {
  // The keyword is the part a deck cannot get wrong silently: a wrong one runs a
  // different job. Two job types per program, asserted against that program's
  // documented spelling, not against our writer's idea of it.
  const expected = {
    nwchem: { SP: /^task dft energy$/m, Freq: /^task dft freq$/m },
    gamess: { SP: /RUNTYP=ENERGY/, Freq: /RUNTYP=HESSIAN/ },
    qchem: { SP: /^JOBTYPE {4}sp$/m, Freq: /^JOBTYPE {4}freq$/m },
  };

  for (const [engine, jobTypes] of Object.entries(expected)) {
    it(`${engine} writes each job type's keyword`, () => {
      for (const [jobType, pattern] of Object.entries(jobTypes)) {
        const rendered = render(engine, { settings: { jobType } });
        expect(rendered.ok, `${engine} ${jobType} was refused: ${rendered.refused || ''}`).toBe(true);
        expect(rendered.text).toMatch(pattern);
      }
    });
  }
});

describe('every exporter refuses what it cannot spell', () => {
  const engines = ['nwchem', 'gamess', 'qchem'];

  it('exposes a capability table and says it is export-only', () => {
    expect(EXPORT_ENGINE_IDS).toEqual(['nwchem', 'gamess', 'qchem']);
    for (const id of engines) {
      const exporter = exporterFor(id);
      expect(exporter.capabilities).toMatchObject({ id, runnable: false });
      expect(Array.isArray(exporter.capabilities.jobTypes)).toBe(true);
      expect(exporter.capabilities.solvation).toBe(false);
      expect(EXPORTERS[id].extension).toMatch(/^\./);
    }
    expect(exporterFor('gaussian')).toBeNull();
  });

  it('refuses an unknown engine by naming the three it has', () => {
    const rendered = renderInput({ engine: 'orca', settings: SETTINGS, molecule: WATER });
    expect(rendered.ok).toBe(false);
    expect(rendered.refused).toMatch(/Supported: nwchem, gamess, qchem/);
  });

  it.each(engines)('%s refuses a 2D ChemDraw drawing', (engine) => {
    const rendered = render(engine, { geometry: { source: 'imported', format: 'cdxml', dimension: '2d' } });
    expect(rendered.ok).toBe(false);
    expect(rendered.refused).toMatch(/2D drawing .* page-unit coordinates/);
  });

  it.each(engines)('%s refuses a placeholder geometry where every atom sits at one point', (engine) => {
    const flat = { coords: WATER.coords.map((atom) => ({ ...atom, x: 0, y: 0, z: 0 })) };
    const rendered = render(engine, { molecule: flat, settings: { basis: 'def2-SVP' } });
    expect(rendered.ok).toBe(false);
    expect(rendered.refused).toMatch(/placeholder, not a geometry/);
  });

  it.each(engines)('%s refuses an empty coordinate list', (engine) => {
    const rendered = render(engine, { molecule: { coords: [] } });
    expect(rendered.ok).toBe(false);
    expect(rendered.refused).toMatch(/no coordinates/);
  });

  it.each(engines)('%s refuses an element beyond krypton, which needs an ECP', (engine) => {
    const molecule = { coords: [{ element: 'I', x: 0, y: 0, z: 0 }], charge: 0, multiplicity: 2 };
    const rendered = render(engine, { molecule, settings: { basis: 'def2-SVP' } });
    expect(rendered.ok).toBe(false);
    expect(rendered.refused).toMatch(/effective core potential/);
  });

  it.each(engines)('%s refuses Gaussian route syntax rather than guessing a translation', (engine) => {
    const custom = render(engine, { settings: { customKeywords: 'Int=UltraFine' } });
    expect(custom.refused).toMatch(/custom route keywords/);
    const solvated = render(engine, { settings: { solvation: true, solvationModel: 'PCM', solvent: 'Water' } });
    expect(solvated.refused).toMatch(/requests solvation \(PCM, Water\)/);
    const td = render(engine, { settings: { tdStates: 10 } });
    expect(td.refused).toMatch(/excited states/);
    const constrained = render(engine, { settings: { constraints: [{ kind: 'bond', atoms: [1, 2], value: 1.2 }] } });
    expect(constrained.refused).toMatch(/constraint/);
  });

  it.each(engines)('%s refuses a job type it has no keyword for, by name', (engine) => {
    const scan = render(engine, { settings: { jobType: 'Scan' } });
    expect(scan.ok).toBe(false);
    expect(scan.refused).toMatch(/Job type "Scan" has no .* export here/);
  });

  it.each(engines)('%s refuses a method outside its table, by name', (engine) => {
    const rendered = render(engine, { settings: { method: 'B2PLYP' } });
    expect(rendered.ok).toBe(false);
    expect(rendered.refused).toMatch(/Method "B2PLYP" is not in this exporter's/);
  });

  it.each(engines)('%s refuses a charge/multiplicity pair the electrons cannot support', (engine) => {
    const rendered = render(engine, { molecule: { multiplicity: 2 } });
    expect(rendered.ok).toBe(false);
    expect(rendered.refused).toMatch(/inconsistent with 10 electrons/);
  });
});

describe('round trip: write the deck, read it back with the app', () => {
  const files = { nwchem: 'job.nw', gamess: 'job.inp', qchem: 'job.qcin' };

  it.each(['nwchem', 'gamess', 'qchem'])('%s returns the same atoms, charge and multiplicity', (engine) => {
    const rendered = render(engine);
    expect(rendered.ok).toBe(true);
    const parsed = parseStructureRecords(rendered.text, { filename: files[engine], allowDecks: true });
    expect(parsed.format).toBe(engine);
    expect(parsed.records).toHaveLength(1);
    const record = parsed.records[0];
    expect(record.atoms.map((atom) => atom.element)).toEqual(['O', 'H', 'H']);
    record.atoms.forEach((atom, index) => {
      expect(atom.x).toBeCloseTo(WATER.coords[index].x, 6);
      expect(atom.y).toBeCloseTo(WATER.coords[index].y, 6);
      expect(atom.z).toBeCloseTo(WATER.coords[index].z, 6);
    });
    expect(record.charge).toBe(0);
    expect(record.multiplicity).toBe(1);
    expect(record.name).toContain('Water');
  });

  it.each(['nwchem', 'gamess', 'qchem'])('%s re-parses to the same geometry within 1e-9 Å', (engine) => {
    // The writers print eight decimals; a re-parse is therefore exact to well
    // inside 1e-9, and anything larger means a coordinate was rounded, shifted
    // or read in the wrong units (Bohr against Ångström is a 1.89× error).
    const rendered = render(engine);
    expect(rendered.ok).toBe(true);
    const record = parseStructureRecords(rendered.text, { filename: files[engine], allowDecks: true }).records[0];
    expect(record.atoms).toHaveLength(WATER.coords.length);
    record.atoms.forEach((atom, index) => {
      expect(Math.abs(atom.x - WATER.coords[index].x)).toBeLessThan(1e-9);
      expect(Math.abs(atom.y - WATER.coords[index].y)).toBeLessThan(1e-9);
      expect(Math.abs(atom.z - WATER.coords[index].z)).toBeLessThan(1e-9);
    });
  });

  it('carries a formal charge through NWChem and back', () => {
    // Acetate, built by hand because the point is the charge line, not a file.
    const acetate = {
      coords: [
        { element: 'C', x: -1.2, y: 0.0, z: 0.0 },
        { element: 'C', x: 0.0, y: 0.0, z: 0.0 },
        { element: 'O', x: 0.6, y: 1.0, z: 0.0 },
        { element: 'O', x: 0.7, y: -1.1, z: 0.0 },
        { element: 'H', x: -1.6, y: 1.0, z: 0.0 },
        { element: 'H', x: -1.6, y: -1.0, z: 0.0 },
        { element: 'H', x: -1.6, y: 0.0, z: 1.0 },
      ],
      charge: -1,
      multiplicity: 1,
    };
    const rendered = renderInput({ engine: 'nwchem', settings: SETTINGS, molecule: acetate, geometry: GEOMETRY });
    expect(rendered.text).toMatch(/^charge -1$/m);
    const record = parseStructureRecords(rendered.text, { filename: 'acetate.nw', allowDecks: true }).records[0];
    expect(record.charge).toBe(-1);
    expect(record.multiplicity).toBe(1);
    expect(record.atoms).toHaveLength(7);
  });

  it('round-trips a real fixture: aspirin from the PubChem SDF, through NWChem, and back', () => {
    // `test/fixtures/structures/pubchem-5molecules.sdf` record 1 is PubChem
    // CID 2244 (aspirin), 21 atoms. Its coordinates are the ones a real
    // depositor wrote, not numbers this test invented.
    const text = readFileSync('test/fixtures/structures/pubchem-5molecules.sdf', 'utf8');
    const source = parseStructureRecords(text, { filename: 'pubchem-5molecules.sdf' }).records[0];
    expect(source.atoms).toHaveLength(21);
    const rendered = renderInput({
      engine: 'nwchem',
      settings: SETTINGS,
      molecule: { coords: source.atoms, charge: source.charge, multiplicity: source.multiplicity },
      geometry: { source: 'imported', file: 'pubchem-5molecules.sdf', format: 'sdf', dimension: '' },
      title: 'Aspirin',
    });
    expect(rendered.ok).toBe(true);
    const back = parseStructureRecords(rendered.text, { filename: 'aspirin.nw', allowDecks: true }).records[0];
    expect(back.atoms.map((atom) => atom.element)).toEqual(source.atoms.map((atom) => atom.element));
    back.atoms.forEach((atom, index) => {
      expect(atom.x).toBeCloseTo(source.atoms[index].x, 6);
      expect(atom.y).toBeCloseTo(source.atoms[index].y, 6);
      expect(atom.z).toBeCloseTo(source.atoms[index].z, 6);
    });
    expect(back.charge).toBe(source.charge);
  });
});

describe('deck readers refuse what they cannot represent', () => {
  it('refuses an NWChem Z-matrix line instead of reading it as Cartesian', () => {
    const deck = 'charge 0\ngeometry\nO\nH 1 0.96\nH 1 0.96 2 104.5\nend\ntask dft energy\n';
    expect(() => parseNwchemInput(deck)).toThrow(/not Cartesian/);
  });

  it('converts NWChem Bohr coordinates and says so', () => {
    const deck = 'charge 0\ntitle "x"\ngeometry units au\nO 0.0 0.0 0.2217\nend\ntask dft energy\n';
    const record = parseStructureRecords(deck, { filename: 'bohr.nw', allowDecks: true }).records[0];
    expect(record.atoms[0].z).toBeCloseTo(0.2217 * 0.529177210903, 6);
    expect(record.warnings.join(' ')).toMatch(/Bohr/);
  });

  it('reads a GAMESS UNITS=BOHR deck in Bohr', () => {
    const deck = [
      ' $CONTRL SCFTYP=RHF RUNTYP=ENERGY ICHARG=0 MULT=1 UNITS=BOHR $END',
      ' $DATA',
      'x',
      'C1',
      'O 8.0 0.0 0.0 0.2217',
      ' $END',
    ].join('\n');
    const record = parseStructureRecords(deck, { filename: 'job.inp', allowDecks: true }).records[0];
    expect(record.atoms[0].z).toBeCloseTo(0.2217 * 0.529177210903, 6);
  });

  it('refuses a GAMESS deck whose $DATA lists symmetry-unique atoms only', () => {
    const deck = [
      ' $CONTRL SCFTYP=RHF RUNTYP=ENERGY $END',
      ' $DATA',
      'water',
      'C2V',
      'O 8.0 0.0 0.0 0.1173',
      'H 1.0 0.0 0.7572 -0.4692',
      ' $END',
    ].join('\n');
    expect(() => parseStructureRecords(deck, { filename: 'job.inp', allowDecks: true })).toThrow(/symmetry-unique atoms/);
  });

  it('refuses a Q-Chem deck that reads its geometry from another file', () => {
    const deck = '$molecule\nread\n$end\n$rem\nJOBTYPE sp\n$end\n';
    expect(() => parseStructureRecords(deck, { filename: 'job.qcin', allowDecks: true })).toThrow(/says `read`/);
  });
});

/** The shipped single-point example, with water and settings all three exporters carry. */
async function projectFile({ jobType = null } = {}) {
  const project = JSON.parse(readFileSync('examples/single-point.ncs', 'utf8'));
  project.molecule.coords = WATER.coords;
  project.molecule.geometry = { source: 'imported', file: 'water.xyz', format: 'xyz' };
  for (const node of project.flows[0].nodes) {
    if (node.type === 'calculate') {
      node.settings.basis = '6-31G*';
      node.settings.dispersion = '';
      node.settings.population = '';
      if (jobType) node.settings.jobType = jobType;
    }
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'ncs-export-'));
  const file = path.join(dir, 'water.ncs');
  await writeFile(file, JSON.stringify(project, null, 2), 'utf8');
  return { dir, file };
}

describe('ncs export-input', () => {
  it('writes the deck and reports what it wrote', async () => {
    const { dir, file } = await projectFile();
    const out = path.join(dir, 'job.nw');
    const result = await ncs(['export-input', file, '--node', 'sp-energy', '--engine', 'nwchem', '--out', out, '--json']);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ ok: true, engine: 'nwchem', out });
    expect(payload.bytes).toBeGreaterThan(100);
    const text = await readFile(out, 'utf8');
    expect(text).toMatch(/^task dft energy$/m);
    // And the app can read the file it just wrote.
    const record = parseStructureRecords(text, { filename: 'job.nw', allowDecks: true }).records[0];
    expect(record.atoms).toHaveLength(3);
    // The app-facing path refuses until the project format gains a deck id.
    expect(() => parseStructureRecords(text, { filename: 'job.nw' })).toThrow(/no geometry format for it/);
  });

  it('prints the deck on stdout when no --out is given', async () => {
    const { file } = await projectFile();
    const result = await ncs(['export-input', file, '--node', 'sp-energy', '--engine', 'qchem']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^\$molecule$/m);
    expect(result.stderr).toMatch(/^note: /m);
  });

  it('refuses a project with no geometry instead of exporting the demo water molecule', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ncs-export-'));
    const empty = path.join(dir, 'empty.ncs');
    await writeFile(empty, readFileSync('examples/single-point.ncs', 'utf8'), 'utf8');
    const result = await ncs(['export-input', empty, '--node', 'sp-energy', '--engine', 'nwchem']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/"code": "export-no-geometry"/);
    expect(result.stderr).toMatch(/demo water molecule/);
  });

  it('refuses a block whose settings it cannot spell, with a named reason', async () => {
    const project = JSON.parse(readFileSync('examples/single-point.ncs', 'utf8'));
    project.molecule.coords = WATER.coords;
    project.molecule.geometry = { source: 'imported', file: 'water.xyz', format: 'xyz' };
    const dir = await mkdtemp(path.join(tmpdir(), 'ncs-export-'));
    const file = path.join(dir, 'nbo.ncs');
    await writeFile(file, JSON.stringify(project, null, 2), 'utf8');
    const result = await ncs(['export-input', file, '--node', 'sp-energy', '--engine', 'nwchem']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/"code": "export-refused"/);
    expect(result.stderr).toMatch(/population-analysis keyword \("NBO"\)/);
  });

  it('rejects an engine it does not export with a usage error', async () => {
    const { file } = await projectFile();
    const result = await ncs(['export-input', file, '--node', 'sp-energy', '--engine', 'gaussian']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/does not know an engine "gaussian"/);
  });
});

describe('ncs convert --format <deck>', () => {
  const EXTENSION = { nwchem: 'nw', gamess: 'inp', qchem: 'qcin' };

  it.each(['nwchem', 'gamess', 'qchem'])('writes the same bytes as export-input for %s', async (engine) => {
    const { dir, file } = await projectFile();
    const viaExportInput = path.join(dir, `a.${EXTENSION[engine]}`);
    const viaConvert = path.join(dir, `b.${EXTENSION[engine]}`);
    const first = await ncs(['export-input', file, '--node', 'sp-energy', '--engine', engine, '--out', viaExportInput]);
    const second = await ncs(['convert', file, '--node', 'sp-energy', '--format', engine, '--out', viaConvert, '--json']);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ ok: true, format: engine, out: viaConvert });
    // One project → deck path: the two commands are two doors into one function.
    expect(await readFile(viaConvert, 'utf8')).toBe(await readFile(viaExportInput, 'utf8'));
  });

  it('names the format extension when no --out is given', async () => {
    const { dir, file } = await projectFile();
    const result = await ncs(['convert', file, '--node', 'sp-energy', '--format', 'gamess']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/gamess written to .*water\.inp/);
    expect((await readFile(path.join(dir, 'water.inp'), 'utf8'))).toMatch(/RUNTYP=ENERGY/);
  });

  it('writes the frequency job through the same route', async () => {
    const { dir, file } = await projectFile({ jobType: 'Freq' });
    const keyword = { nwchem: /^task dft freq$/m, gamess: /RUNTYP=HESSIAN/, qchem: /^JOBTYPE {4}freq$/m };
    for (const engine of ['nwchem', 'gamess', 'qchem']) {
      const out = path.join(dir, `freq.${engine}`);
      // eslint-disable-next-line no-await-in-loop
      const result = await ncs(['convert', file, '--node', 'sp-energy', '--format', engine, '--out', out]);
      expect(result.code, `${engine}: ${result.stderr}`).toBe(0);
      // eslint-disable-next-line no-await-in-loop
      expect(await readFile(out, 'utf8')).toMatch(keyword[engine]);
    }
  });

  it('refuses a structure file, because a deck needs a block\'s route', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ncs-export-'));
    const xyz = path.join(dir, 'water.xyz');
    await writeFile(xyz, '3\nwater\nO 0 0 0.1173\nH 0 0.7572 -0.4692\nH 0 -0.7572 -0.4692\n', 'utf8');
    const result = await ncs(['convert', xyz, '--format', 'nwchem']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/takes a \.ncs project and --node/);
    expect(result.stderr).toMatch(/no route/);
  });

  it('asks for --node rather than picking a block', async () => {
    const { file } = await projectFile();
    const result = await ncs(['convert', file, '--format', 'qchem']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/needs --node <id>/);
  });

  it('refuses a project with no geometry with the same code as export-input', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ncs-export-'));
    const empty = path.join(dir, 'empty.ncs');
    await writeFile(empty, readFileSync('examples/single-point.ncs', 'utf8'), 'utf8');
    const result = await ncs(['convert', empty, '--node', 'sp-energy', '--format', 'nwchem']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/"code": "export-no-geometry"/);
  });

  it('reports an option the target program cannot spell instead of dropping it', async () => {
    const project = JSON.parse(readFileSync('examples/single-point.ncs', 'utf8'));
    project.molecule.coords = WATER.coords;
    project.molecule.geometry = { source: 'imported', file: 'water.xyz', format: 'xyz' };
    for (const node of project.flows[0].nodes) {
      if (node.type === 'calculate') {
        node.settings.basis = '6-31G*';
        node.settings.solvation = true;
        node.settings.solvationModel = 'PCM';
        node.settings.solvent = 'Water';
      }
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'ncs-export-'));
    const file = path.join(dir, 'solvated.ncs');
    await writeFile(file, JSON.stringify(project, null, 2), 'utf8');
    const result = await ncs(['convert', file, '--node', 'sp-energy', '--format', 'gamess']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/"code": "export-refused"/);
    expect(result.stderr).toMatch(/requests solvation \(PCM, Water\)/);
  });
});
