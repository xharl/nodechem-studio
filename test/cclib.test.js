import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { cclibOutputName, isCclibLogName, parseCclibSummary } from '../src/shared/cclib.js';
import { parseStructureRecords } from '../src/shared/structureImport.js';

const root = path.resolve(__dirname, '..');
const fixture = (name) => path.join(root, 'test/fixtures/cclib', name);
const cclibPython = process.env.NCS_CCLIB_PYTHON || '';
const temporary = [];

afterEach(() => {
  while (temporary.length > 0) fs.rmSync(temporary.pop(), { recursive: true, force: true });
});

function workdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncs-cclib-'));
  temporary.push(dir);
  return dir;
}

function ncsConvert(args) {
  try {
    const stdout = execFileSync(process.execPath, ['bin/ncs.js', 'convert', ...args, '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

describe('cclib conversion boundary (issue 273)', () => {
  it('names the logs it owns and the output beside them', () => {
    expect(isCclibLogName('run.log')).toBe(true);
    expect(isCclibLogName('run.out')).toBe(true);
    expect(isCclibLogName('gaussian.log')).toBe(false);
    expect(isCclibLogName('run.fchk')).toBe(false);
    expect(cclibOutputName('run.log')).toBe('run.cjson');
    expect(cclibOutputName('a/b/run.out')).toBe('run.cjson');
  });

  it('reads the last JSON summary line and ignores cclib chatter', () => {
    const summary = parseCclibSummary('cclib: reading\n{"ok":true,"atoms":3}\n');
    expect(summary).toEqual({ ok: true, atoms: 3 });
    expect(parseCclibSummary('not json')).toBeNull();
  });

  it('imports a real GAMESS cclib conversion with geometry, charge and energy', () => {
    const { records } = parseStructureRecords(fs.readFileSync(fixture('gamess-water-mp2.cjson'), 'utf8'), {
      filename: 'gamess-water-mp2.cjson',
    });
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.error).toBeUndefined();
    expect(record.atoms).toHaveLength(3);
    expect(record.atoms.map((atom) => atom.element)).toEqual(['O', 'H', 'H']);
    expect(record.charge).toBe(0);
    expect(record.energyHartree).toBeCloseTo(-2040.9159783225796, 10);
    expect(record.origin.program).toBe('GAMESS');
    expect(record.origin.method).toBe('MP2');
    expect(record.origin.cclibVersion).toBe('1.8.1');
  });

  it('imports the NWChem and Q-Chem conversions', () => {
    const nwchem = parseStructureRecords(fs.readFileSync(fixture('nwchem-hydrogen-hf.cjson'), 'utf8'), {
      filename: 'nwchem-hydrogen-hf.cjson',
    }).records[0];
    expect(nwchem.atoms).toHaveLength(1);
    expect(nwchem.energyHartree).toBeCloseTo(-13.586056882610858, 10);
    expect(nwchem.origin.program).toBe('NWChem');

    const qchem = parseStructureRecords(fs.readFileSync(fixture('qchem-water-ccsdt.cjson'), 'utf8'), {
      filename: 'qchem-water-ccsdt.cjson',
    }).records[0];
    expect(qchem.atoms).toHaveLength(3);
    expect(qchem.energyHartree).toBeCloseTo(-2041.3391880879758, 10);
    expect(qchem.origin.program).toBe('QChem');
    expect(qchem.origin.method).toBe('CCSD(T)');
  });
});

describe.skipIf(!cclibPython)('cclib sidecar with a real interpreter', () => {
  it('converts GAMESS, NWChem and Q-Chem logs and reports the origin', () => {
    for (const [input, program, energy] of [
      ['gamess-water-mp2.log', 'GAMESS', -2040.9159783225796],
      ['nwchem-hydrogen-hf.log', 'NWChem', -13.586056882610858],
      ['qchem-water-ccsdt.log', 'QChem', -2041.3391880879758],
    ]) {
      const dir = workdir();
      const output = path.join(dir, 'out.cjson');
      const result = ncsConvert(['--from', fixture(input), '--to', output, '--cclib', cclibPython]);
      expect(result.status, result.stderr).toBe(0);
      const summary = JSON.parse(result.stdout);
      expect(summary.ok).toBe(true);
      expect(summary.origin.program).toBe(program);
      expect(summary.energyHartree).toBeCloseTo(energy, 8);
      const imported = parseStructureRecords(fs.readFileSync(output, 'utf8'), { filename: 'out.cjson' });
      expect(imported.records[0].atoms.length).toBeGreaterThan(0);
    }
  });

  it('refuses a truncated log by name, not with a partial geometry', () => {
    const dir = workdir();
    const result = ncsConvert([
      '--from', fixture('gamess-truncated.log'),
      '--to', path.join(dir, 'truncated.cjson'),
      '--cclib', cclibPython,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/normal-termination evidence|truncated/i);
    expect(fs.existsSync(path.join(dir, 'truncated.cjson'))).toBe(false);
  });
});
