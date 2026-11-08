import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ANGSTROM_PER_BOHR,
  BOHR_PER_ANGSTROM,
  QCSCHEMA_SCHEMA_NAME,
  QCSCHEMA_SCHEMA_VERSION,
  QCSchemaError,
  atomicResultFromRun,
  atomsFromRun,
  gaussianInputMolecule,
  moleculeFromRun,
  qcschemaSchemaPath,
  readQcschema,
  recordPatchFromQcschema,
  structureFromQcschema,
  validateQcschemaOutput,
} from '../src/shared/qcschema.js';

/**
 * QCSchema AtomicResult in and out.
 *
 * The record below is **synthetic test data**: water at the geometry the dry-run
 * fixture writes, with the fixture's placeholder energy. Nothing here claims a
 * calculation happened. The fixture documents under test/fixtures/qcschema/ are
 * hand-built for the same reason and say so.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'qcschema');

const WATER_ATOMS = [
  { element: 'O', x: 0, y: 0, z: 0.1173 },
  { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
  { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
];

function syntheticRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    id: '20260101-000000-abc123',
    status: 'completed',
    engine: 'gaussian',
    dryRun: true,
    title: 'Single-point energy',
    inputName: 'sp-energy.gjf',
    outputName: 'sp-energy.out',
    outputFile: '/tmp/run/sp-energy.out',
    outputSource: 'file',
    truncated: false,
    executable: null,
    scratchDir: null,
    checkpointHandoff: null,
    app: { version: '0.3.0', commit: 'deadbee' },
    provenance: {
      kind: 'fixture',
      jobType: 'SP',
      method: {
        functional: 'B3LYP',
        basis: 'def2-SVP',
        dispersion: 'GD3BJ',
        solvation: null,
        grid: null,
        scf: null,
        td: null,
      },
      input: { name: 'sp-energy.gjf', bytes: 251 },
    },
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    exitCode: 0,
    parsed: {
      status: 'completed',
      terminationCode: 'normal',
      termination: 'Normal termination of Gaussian',
      program: { name: 'Gaussian', version: '16', revision: 'C.01' },
      scf: { status: 'converged', energyHartree: -76, cycles: 8, method: 'RB3LYP', applicable: true },
      frequencies: { count: 3, imaginaryCount: 0, imaginaryValues: [], minImaginary: null },
      thermochemistry: { freeEnergyHartree: -76.01, enthalpyHartree: -76.02, zpeHartree: 0.02 },
      finalEnergy: { hartree: -76, source: 'scf' },
      geometry: { input: null, standard: null, final: null },
      complete: true,
      lineCount: 88,
    },
    gates: { overall: 'pass', gates: [], complete: true },
    error: null,
    ...overrides,
  };
}

function waterMolecule(extra = {}) {
  return { atoms: WATER_ATOMS, charge: 0, multiplicity: 1, name: 'water', ...extra };
}

function catchRefusal(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

describe('QCSchema — writing an AtomicResult', () => {
  it('names the published schema and version', () => {
    const doc = atomicResultFromRun(syntheticRecord(), { molecule: waterMolecule() });
    expect(doc.schema_name).toBe(QCSCHEMA_SCHEMA_NAME);
    expect(doc.schema_name).toBe('qcschema_output');
    expect(doc.schema_version).toBe(QCSCHEMA_SCHEMA_VERSION);
    expect(doc.schema_version).toBe(2);
  });

  it('carries the molecule: symbols, geometry in bohr, charge and multiplicity', () => {
    const doc = atomicResultFromRun(syntheticRecord(), { molecule: waterMolecule() });
    expect(doc.molecule.schema_name).toBe('qcschema_molecule');
    expect(doc.molecule.schema_version).toBe(2);
    expect(doc.molecule.symbols).toEqual(['O', 'H', 'H']);
    expect(doc.molecule.molecular_charge).toBe(0);
    expect(doc.molecule.molecular_multiplicity).toBe(1);
    expect(doc.molecule.geometry).toHaveLength(9);
    // 0.1173 A in bohr; QCSchema geometry is atomic units, the app stores A.
    expect(doc.molecule.geometry[2]).toBeCloseTo(0.1173 * BOHR_PER_ANGSTROM, 9);
    expect(doc.molecule.geometry[2]).toBeCloseTo(0.2216648744, 9);
    // The x of the first atom is exactly 0 and stays exactly 0.
    expect(doc.molecule.geometry[0]).toBe(0);
  });

  it('converts angstrom to bohr with the CODATA factor, not something near it', () => {
    expect(ANGSTROM_PER_BOHR).toBeCloseTo(0.529177210903, 12);
    expect(BOHR_PER_ANGSTROM).toBeCloseTo(1.8897261246257702, 12);
    const doc = atomicResultFromRun(syntheticRecord(), { molecule: waterMolecule() });
    const h1 = doc.molecule.geometry.slice(3, 6);
    expect(h1[1]).toBeCloseTo(0.7572 / ANGSTROM_PER_BOHR, 9);
  });

  it('writes the energy unchanged in hartree, as return_result and properties.return_energy', () => {
    const record = syntheticRecord();
    const doc = atomicResultFromRun(record, { molecule: waterMolecule() });
    expect(doc.driver).toBe('energy');
    expect(doc.success).toBe(true);
    expect(doc.return_result).toBe(-76);
    expect(doc.properties.return_energy).toBe(-76);
    // No unit conversion on the energy: hartree in, hartree out.
    expect(doc.return_result).toBe(record.parsed.finalEnergy.hartree);
  });

  it('writes provenance: creator, version, engine, method, basis and the run id', () => {
    const doc = atomicResultFromRun(syntheticRecord(), { molecule: waterMolecule() });
    expect(doc.provenance).toMatchObject({
      creator: 'NodeChem Studio',
      version: '0.3.0',
      routine: 'ncs qcschema export (dry run)',
      engine: 'gaussian',
      method: 'B3LYP',
      basis: 'def2-SVP',
      run_id: '20260101-000000-abc123',
    });
    expect(doc.model).toMatchObject({ method: 'B3LYP', basis: 'def2-SVP', dispersion: 'GD3BJ' });
    // provenance is open in the schema; the extra keys must be strings.
    for (const value of Object.values(doc.provenance)) expect(typeof value).toBe('string');
  });

  it('labels a real run as a plain export, and a dry run as a dry run', () => {
    const real = atomicResultFromRun(syntheticRecord({ dryRun: false }), { molecule: waterMolecule() });
    expect(real.provenance.routine).toBe('ncs qcschema export');
    expect(real.extras.nodechem).not.toHaveProperty('dry_run');
    const dry = atomicResultFromRun(syntheticRecord(), { molecule: waterMolecule() });
    expect(dry.provenance.routine).toBe('ncs qcschema export (dry run)');
    expect(dry.extras.nodechem.dry_run).toBe(true);
  });

  it('omits wavefunction entirely when the run has no MOs, and passes a real one through', () => {
    const doc = atomicResultFromRun(syntheticRecord(), { molecule: waterMolecule() });
    expect(doc).not.toHaveProperty('wavefunction');

    // The smallest object the published Wavefunction schema accepts: a basis,
    // nothing else. Hand-built here; it is not a real basis set.
    const wavefunction = {
      basis: {
        schema_name: 'qcschema_basis',
        schema_version: 1,
        name: 'test-basis',
        center_data: {
          0: {
            electron_shells: [{
              angular_momentum: [0], harmonic_type: 'spherical', exponents: ['1.0'], coefficients: [['1.0']],
            }],
          },
        },
        atom_map: ['O', 'H', 'H'],
      },
    };
    const withWavefunction = atomicResultFromRun(syntheticRecord(), { molecule: waterMolecule(), wavefunction });
    expect(withWavefunction.wavefunction).toEqual(wavefunction);
    expect(validateQcschemaOutput(withWavefunction).errors).toEqual([]);
  });

  it('refuses a wavefunction that does not conform instead of shipping it', () => {
    const error = catchRefusal(() => atomicResultFromRun(syntheticRecord(), {
      molecule: waterMolecule(),
      wavefunction: { basis: { name: 'not-a-basis' } },
    }));
    expect(error.code).toBe('qcschema-invalid');
    expect(error.field).toMatch(/^\/wavefunction/);
  });

  it('puts a gradient in return_result with driver=gradient, never in properties', () => {
    const gradient = [0, 0, -0.01, 0, 0.006, 0.004, 0, -0.006, 0.004];
    const doc = atomicResultFromRun(syntheticRecord(), { molecule: waterMolecule(), gradient });
    expect(doc.driver).toBe('gradient');
    expect(doc.return_result).toEqual(gradient);
    expect(doc.properties.return_energy).toBe(-76);
    expect(doc.properties).not.toHaveProperty('return_gradient');
    expect(validateQcschemaOutput(doc).errors).toEqual([]);
  });

  it('puts a Hessian in return_result with driver=hessian', () => {
    const hessian = Array.from({ length: 81 }, (_, index) => index / 1000);
    const doc = atomicResultFromRun(syntheticRecord(), { molecule: waterMolecule(), hessian });
    expect(doc.driver).toBe('hessian');
    expect(doc.return_result).toHaveLength(81);
    expect(doc.return_result).toEqual(hessian);
  });

  it('refuses a Hessian and a gradient together: the schema has one return_result slot', () => {
    const error = catchRefusal(() => atomicResultFromRun(syntheticRecord(), {
      molecule: waterMolecule(),
      gradient: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      hessian: Array.from({ length: 81 }, () => 0),
    }));
    expect(error.field).toBe('return_result');
    expect(error.message).toContain('not both');
  });

  it('keeps thermochemistry out of the hartree fields and inside extras', () => {
    const doc = atomicResultFromRun(syntheticRecord(), { molecule: waterMolecule() });
    expect(doc.extras.nodechem.thermochemistry.free_energy_hartree).toBe(-76.01);
    expect(doc.return_result).toBe(-76);
    expect(doc.properties.return_energy).toBe(-76);
  });

  it('writes fragment information when the caller has it', () => {
    const doc = atomicResultFromRun(syntheticRecord(), {
      molecule: waterMolecule({
        fragments: [[0], [1, 2]],
        fragmentCharges: [0, 0],
        fragmentMultiplicities: [1, 1],
      }),
    });
    expect(doc.molecule.fragments).toEqual([[0], [1, 2]]);
    expect(doc.molecule.fragment_charges).toEqual([0, 0]);
    expect(doc.molecule.fragment_multiplicities).toEqual([1, 1]);
    expect(validateQcschemaOutput(doc).errors).toEqual([]);
  });

  it('marks a dry run in extras instead of passing fixture data off as a calculation', () => {
    const doc = atomicResultFromRun(syntheticRecord(), { molecule: waterMolecule() });
    expect(doc.extras.nodechem.dry_run).toBe(true);
    expect(doc.extras.nodechem.run_id).toBe('20260101-000000-abc123');
  });

  it('refuses a run with no final energy, naming return_result', () => {
    const record = syntheticRecord();
    record.parsed.finalEnergy = { hartree: null, source: null };
    const error = catchRefusal(() => atomicResultFromRun(record, { molecule: waterMolecule() }));
    expect(error).toBeInstanceOf(QCSchemaError);
    expect(error.code).toBe('qcschema-refused');
    expect(error.field).toBe('return_result');
    expect(error.message).toContain('return_result');
    expect(error.message).toContain('final energy');
  });

  it('never substitutes thermochemistry for a missing final energy', () => {
    const record = syntheticRecord();
    record.parsed.finalEnergy = { hartree: null, source: null };
    record.parsed.thermochemistry.freeEnergyHartree = -76.01;
    const error = catchRefusal(() => atomicResultFromRun(record, { molecule: waterMolecule() }));
    expect(error.field).toBe('return_result');
  });

  it('refuses a run whose provenance carries no method, naming model.method', () => {
    const record = syntheticRecord();
    record.provenance.method = { basis: 'def2-SVP' };
    const error = catchRefusal(() => atomicResultFromRun(record, { molecule: waterMolecule() }));
    expect(error.code).toBe('qcschema-refused');
    expect(error.field).toBe('model.method');
  });

  it('refuses a molecule with no charge or multiplicity instead of defaulting them', () => {
    const noCharge = catchRefusal(() => atomicResultFromRun(syntheticRecord(), {
      molecule: { atoms: WATER_ATOMS, multiplicity: 1 },
    }));
    expect(noCharge.field).toBe('molecule.molecular_charge');

    const noMultiplicity = catchRefusal(() => atomicResultFromRun(syntheticRecord(), {
      molecule: { atoms: WATER_ATOMS, charge: 0 },
    }));
    expect(noMultiplicity.field).toBe('molecule.molecular_multiplicity');
  });

  it('refuses a molecule with no atoms, naming molecule.geometry', () => {
    const error = catchRefusal(() => atomicResultFromRun(syntheticRecord(), {
      molecule: { atoms: [], charge: 0, multiplicity: 1 },
    }));
    expect(error.field).toBe('molecule.geometry');
  });

  it('refuses a gradient whose length is not 3N', () => {
    const error = catchRefusal(() => atomicResultFromRun(syntheticRecord(), {
      molecule: waterMolecule(),
      gradient: [0, 0, 0],
    }));
    expect(error.field).toBe('return_result');
    expect(error.message).toContain('3N');
  });

  it('refuses a record that is not a run record at all', () => {
    const error = catchRefusal(() => atomicResultFromRun({}, { molecule: waterMolecule() }));
    expect(error.code).toBe('qcschema-refused');
    expect(error.field).toBe('record');
  });

  it('validates the document it just wrote against the published schema', () => {
    const doc = atomicResultFromRun(syntheticRecord(), { molecule: waterMolecule(), gradient: [0, 0, 0, 0, 0, 0, 0, 0, 0] });
    const verdict = validateQcschemaOutput(doc);
    expect(verdict.errors).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(qcschemaSchemaPath('output')).toMatch(/schemas[\\/]qcschema[\\/]v2[\\/]qc_schema_output\.schema$/);
  });

  it('would fail a document with a field the published schema forbids', () => {
    const doc = atomicResultFromRun(syntheticRecord(), { molecule: waterMolecule() });
    doc.properties.return_gradient = [0, 0, 0];
    const verdict = validateQcschemaOutput(doc);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.some((error) => error.path === '/properties/return_gradient')).toBe(true);
  });
});

describe('QCSchema — reading the run record', () => {
  it('prefers the parsed final geometry over the input geometry', () => {
    const record = syntheticRecord();
    record.parsed.finalGeometry = {
      atoms: [{ element: 'O', x: 1, y: 1, z: 1 }, { element: 'H', x: 2, y: 2, z: 2 }],
      source: 'standard',
    };
    record.parsed.geometry.input = { atoms: WATER_ATOMS, source: 'input' };
    const found = atomsFromRun(record);
    expect(found.source).toBe('finalGeometry');
    expect(found.atoms.map((atom) => atom.element)).toEqual(['O', 'H']);
  });

  it('falls back to the standard orientation, then the input orientation', () => {
    const record = syntheticRecord();
    record.parsed.geometry.standard = { atoms: WATER_ATOMS, source: 'standard' };
    expect(atomsFromRun(record).source).toBe('geometry.standard');
    record.parsed.geometry.standard = null;
    record.parsed.geometry.input = { atoms: WATER_ATOMS, source: 'input' };
    expect(atomsFromRun(record).source).toBe('geometry.input');
  });

  it('says so when there is no geometry in the record', () => {
    expect(atomsFromRun(syntheticRecord())).toBeNull();
  });

  it('builds a molecule from atoms the caller supplies', () => {
    const molecule = moleculeFromRun(syntheticRecord(), { atoms: WATER_ATOMS, charge: 0, multiplicity: 1 });
    expect(molecule.atoms).toHaveLength(3);
    expect(molecule.charge).toBe(0);
    expect(molecule.multiplicity).toBe(1);
  });

  it('refuses when the charge cannot be established', () => {
    const error = catchRefusal(() => moleculeFromRun(syntheticRecord(), { atoms: WATER_ATOMS, multiplicity: 1 }));
    expect(error.code).toBe('qcschema-refused');
    expect(error.field).toBe('molecule.molecular_charge');
  });
});

describe('QCSchema — reading a Gaussian input', () => {
  const GJF = [
    '%Mem=4GB',
    '%NProcShared=4',
    '%Chk=sp_energy.chk',
    '#p B3LYP/def2-SVP SP EmpiricalDispersion=GD3BJ Pop=NBO',
    '',
    'Single-point energy',
    '',
    '0 1',
    'O      0.000000     0.000000     0.117300',
    'H      0.000000     0.757200    -0.469200',
    'H      0.000000    -0.757200    -0.469200',
    '',
  ].join('\n');

  it('reads charge, multiplicity and atoms from the job specification', () => {
    const molecule = gaussianInputMolecule(GJF);
    expect(molecule.charge).toBe(0);
    expect(molecule.multiplicity).toBe(1);
    expect(molecule.atoms).toEqual(WATER_ATOMS);
    expect(molecule.name).toBe('Single-point energy');
  });

  it('reads a charged, open-shell specification', () => {
    const text = GJF.replace('\n0 1\n', '\n1 2\n');
    const molecule = gaussianInputMolecule(text);
    expect(molecule.charge).toBe(1);
    expect(molecule.multiplicity).toBe(2);
  });

  it('returns null for text that is not a Gaussian input', () => {
    expect(gaussianInputMolecule('# not a job\n')).toBeNull();
    expect(gaussianInputMolecule('')).toBeNull();
  });
});

describe('QCSchema — reading an AtomicResult', () => {
  it('reads a valid result into the app vocabulary', () => {
    const verdict = readQcschema(readFixture('water-energy.qcschema.json'));
    expect(verdict.ok).toBe(true);
    expect(verdict.kind).toBe('result');
    expect(verdict.schemaName).toBe('qcschema_output');
    expect(verdict.schemaVersion).toBe(2);
    expect(verdict.energyHartree).toBe(-76);
    expect(verdict.driver).toBe('energy');
    expect(verdict.model).toMatchObject({ method: 'B3LYP', basis: 'def2-SVP', dispersion: 'GD3BJ' });
    expect(verdict.molecule).toMatchObject({ symbols: ['O', 'H', 'H'], charge: 0, multiplicity: 1 });
    expect(verdict.gradient).toBeNull();
    expect(verdict.hessian).toBeNull();
    expect(verdict.hasWavefunction).toBe(false);
    expect(verdict.runId).toBe('synthetic-water-energy');
    expect(verdict.dryRun).toBe(false);
    expect(verdict.warnings).toEqual([]);
  });

  it('converts the bohr geometry back to angstrom for the app', () => {
    const verdict = readQcschema(readFixture('water-energy.qcschema.json'));
    expect(verdict.atoms).toHaveLength(3);
    expect(verdict.atoms[0]).toEqual({ element: 'O', x: 0, y: 0, z: 0.1173 });
    expect(verdict.atoms[1].y).toBeCloseTo(0.7572, 9);
    expect(verdict.atoms[2].z).toBeCloseTo(-0.4692, 9);
  });

  it('reads a gradient result and labels its units', () => {
    const verdict = readQcschema(readFixture('water-gradient.qcschema.json'));
    expect(verdict.ok).toBe(true);
    expect(verdict.driver).toBe('gradient');
    expect(verdict.gradient.units).toBe('Eh/bohr');
    expect(verdict.gradient.values).toHaveLength(9);
    expect(verdict.gradient.shape).toEqual([9]);
    expect(verdict.energyHartree).toBe(-76);
    expect(verdict.warnings.some((warning) => warning.includes('return_result'))).toBe(true);
  });

  it('refuses a document with no return_result, naming the field', () => {
    const doc = readFixture('water-energy.qcschema.json');
    delete doc.return_result;
    const verdict = readQcschema(doc);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('qcschema-invalid');
    expect(verdict.field).toBe('return_result');
    expect(verdict.message).toContain('return_result');
  });

  it('refuses a document whose schema_name is not qcschema_output', () => {
    const doc = readFixture('water-energy.qcschema.json');
    doc.schema_name = 'qcschema_atomic_result';
    const verdict = readQcschema(doc);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('qcschema-unsupported');
    expect(verdict.field).toBe('schema_name');
    expect(verdict.message).toContain('qcschema_atomic_result');
  });

  it('refuses a result with no molecule charge rather than assuming zero', () => {
    const doc = readFixture('water-energy.qcschema.json');
    delete doc.molecule.molecular_charge;
    const verdict = readQcschema(doc);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('qcschema-invalid');
    expect(verdict.field).toBe('molecule.molecular_charge');
  });

  it('refuses a gradient whose length does not match the molecule', () => {
    const doc = readFixture('water-gradient.qcschema.json');
    doc.return_result = [0, 0, 0];
    const verdict = readQcschema(doc);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('qcschema-invalid');
    expect(verdict.field).toBe('return_result');
  });

  it('refuses something that is not a QCSchema document at all', () => {
    expect(readQcschema({}).code).toBe('qcschema-unsupported');
    expect(readQcschema(null).code).toBe('qcschema-invalid');
    expect(readQcschema('qcschema_output').code).toBe('qcschema-invalid');
  });

  it('reads a bare qcschema_input for its molecule and reports no energy', () => {
    const verdict = readQcschema(readFixture('water-input.qcschema.json'));
    expect(verdict.ok).toBe(true);
    expect(verdict.kind).toBe('input');
    expect(verdict.molecule.symbols).toEqual(['O', 'H', 'H']);
    expect(verdict.energyHartree).toBeNull();
    expect(verdict.model.method).toBe('B3LYP');
    expect(verdict.driver).toBe('energy');
  });

  it('turns a result into a structure the viewer can open', () => {
    const verdict = readQcschema(readFixture('water-energy.qcschema.json'));
    const structure = structureFromQcschema(verdict);
    expect(structure.format).toBe('qcschema');
    expect(structure.name).toBe('water');
    expect(structure.atoms[0]).toEqual({ element: 'O', x: 0, y: 0, z: 0.1173 });
    expect(structure.charge).toBe(0);
    expect(structure.multiplicity).toBe(1);
  });

  it('turns a result into the fields a run record can take', () => {
    const verdict = readQcschema(readFixture('water-energy.qcschema.json'));
    const patch = recordPatchFromQcschema(verdict);
    expect(patch.engine).toBeUndefined();
    expect(patch.provenance.kind).toBe('calculation');
    expect(patch.parsed.finalEnergy).toEqual({ hartree: -76, source: 'qcschema' });
    expect(patch.provenance.method).toEqual({ functional: 'B3LYP', basis: 'def2-SVP', dispersion: 'GD3BJ' });
    // Nothing the document does not carry is invented.
    expect(patch.provenance.jobType).toBeUndefined();
    expect(patch.dryRun).toBeUndefined();
  });
});

describe('QCSchema — round trip', () => {
  it('writes a run and reads it back with the same molecule, charge, multiplicity, energy and method', () => {
    const record = syntheticRecord();
    const doc = atomicResultFromRun(record, { molecule: waterMolecule() });
    const verdict = readQcschema(JSON.parse(JSON.stringify(doc)));

    expect(verdict.ok).toBe(true);
    expect(verdict.molecule.symbols).toEqual(['O', 'H', 'H']);
    expect(verdict.molecule.charge).toBe(0);
    expect(verdict.molecule.multiplicity).toBe(1);
    expect(verdict.energyHartree).toBe(record.parsed.finalEnergy.hartree);
    expect(verdict.model.method).toBe(record.provenance.method.functional);
    expect(verdict.model.basis).toBe(record.provenance.method.basis);
    for (let index = 0; index < WATER_ATOMS.length; index += 1) {
      expect(verdict.atoms[index].x).toBeCloseTo(WATER_ATOMS[index].x, 9);
      expect(verdict.atoms[index].y).toBeCloseTo(WATER_ATOMS[index].y, 9);
      expect(verdict.atoms[index].z).toBeCloseTo(WATER_ATOMS[index].z, 9);
    }
    expect(verdict.dryRun).toBe(true);
    expect(verdict.runId).toBe(record.id);
  });

  it('round-trips the fixture pair through record fields without drifting', () => {
    const verdict = readQcschema(readFixture('water-energy.qcschema.json'));
    const patch = recordPatchFromQcschema(verdict);
    const structure = structureFromQcschema(verdict);
    const rebuilt = syntheticRecord({
      id: verdict.runId,
      engine: undefined,
      provenance: { kind: 'calculation', ...patch.provenance },
      parsed: { ...syntheticRecord().parsed, ...patch.parsed },
    });
    const doc = atomicResultFromRun(rebuilt, {
      molecule: { atoms: structure.atoms, charge: structure.charge, multiplicity: structure.multiplicity },
      version: '0.0.0-fixture',
      routine: 'test/fixtures/qcschema/README.md',
    });
    expect(doc.molecule.symbols).toEqual(['O', 'H', 'H']);
    expect(doc.molecule.geometry[2]).toBeCloseTo(0.2216648744, 9);
    expect(doc.return_result).toBe(-76);
    expect(validateQcschemaOutput(doc).errors).toEqual([]);
  });
});
