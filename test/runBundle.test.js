import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeRunBundle } from '../electron/runner/runBundle.js';
import {
  RUN_BUNDLE_FILES,
  RUN_BUNDLE_KIND,
  RUN_BUNDLE_VERSION,
  buildBundleManifest,
  bundleFileNamesFor,
  isSafeBundleFileName,
  isSafeRunId,
} from '../src/shared/runBundle.js';
import { makeFixtureOutput } from '../src/shared/fixtureOutput.js';

const roots = [];

function sha256Text(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

// Every synthetic byte is labelled: no Gaussian install exists on this machine.
const INPUT_TEXT = [
  '%Mem=4GB',
  '%NProcShared=4',
  '%Chk=job.chk',
  '#p PBE0/def2TZVP Opt Freq EmpiricalDispersion=GD3BJ Integral=UltraFine',
  '',
  'Synthetic bundle fixture',
  '',
  '0 1',
  'O   0.000000    0.000000    0.117300',
  'H   0.000000    0.757200   -0.469200',
  'H   0.000000   -0.757200   -0.469200',
  '',
  '',
].join('\n');

const OUTPUT_TEXT = [
  ' SYNTHETIC FIXTURE — bundle test bytes, not a Gaussian calculation.',
  ' Normal termination of Gaussian 16 at Fri Nov  7 12:00:00 2026.',
  '',
].join('\n');

function baseRecord() {
  return {
    id: 'run-1',
    status: 'completed',
    engine: 'gaussian',
    dryRun: false,
    title: 'Synthetic bundle fixture',
    inputName: 'job.gjf',
    outputName: 'job.out',
    outputFile: 'job.out',
    inputSha256: sha256Text(INPUT_TEXT),
    outputSha256: sha256Text(OUTPUT_TEXT),
    app: { version: '0.1.0', commit: 'deadbee' },
    provenance: {
      kind: 'calculation',
      jobType: 'Opt Freq',
      method: {
        functional: 'PBE0',
        basis: 'def2-TZVP',
        dispersion: 'GD3BJ',
        solvation: null,
        grid: 'UltraFine',
        scf: null,
      },
    },
    parsed: {
      program: { name: 'Gaussian', version: '16', revision: 'C.01' },
      route: '#p PBE0/def2TZVP Opt Freq EmpiricalDispersion=GD3BJ Integral=UltraFine',
      scf: { cycles: 8 },
      thermochemistry: { freeEnergyHartree: -76.02, temperatureK: 298.15, pressureAtm: 1 },
    },
  };
}

async function makeRun({ record = baseRecord(), inputText = INPUT_TEXT, outputText = OUTPUT_TEXT } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nodechem-studio-bundle-'));
  roots.push(root);
  const runDir = path.join(root, record.id);
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, record.inputName), inputText, 'utf8');
  await fsp.writeFile(path.join(runDir, record.outputName), outputText, 'utf8');
  await fsp.writeFile(path.join(runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { root, runDir, record };
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

afterEach(async () => {
  await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe('run bundle writer', () => {
  it('writes a self-contained folder whose manifest hashes match the files on disk', async () => {
    const { root, runDir, record } = await makeRun();
    const bundleDir = path.join(root, 'bundle');
    const createdAt = '2026-11-07T12:00:00.000Z';

    const result = await writeRunBundle({ runDir, bundleDir, createdAt });
    expect(result.canceled).toBe(false);
    expect(result.path).toBe(bundleDir);
    expect(result.runId).toBe('run-1');

    for (const name of ['job.gjf', 'job.out', 'methods.md', 'README.md', 'manifest.json']) {
      const stat = await fsp.stat(path.join(bundleDir, name));
      expect(stat.isFile()).toBe(true);
    }

    const manifest = await readJson(path.join(bundleDir, RUN_BUNDLE_FILES.manifest));
    expect(manifest.kind).toBe(RUN_BUNDLE_KIND);
    expect(manifest.schemaVersion).toBe(RUN_BUNDLE_VERSION);
    expect(manifest.createdAt).toBe(createdAt);
    expect(manifest.runId).toBe('run-1');
    expect(manifest.app).toEqual({ version: '0.1.0', commit: 'deadbee' });
    expect(manifest.provenanceKind).toBe('calculation');
    expect(manifest.engine).toBe('gaussian');
    expect(manifest.recordedHashes.inputSha256).toBe(record.inputSha256);
    expect(manifest.recordedHashes.outputSha256).toBe(record.outputSha256);
    expect(manifest.hashMatchesRunRecord).toEqual({ input: true, output: true });

    expect(manifest.files.map((file) => file.name)).toEqual([
      'job.gjf',
      'job.out',
      'methods.md',
      'README.md',
    ]);

    for (const file of manifest.files) {
      const filePath = path.join(bundleDir, file.name);
      const stat = await fsp.stat(filePath);
      const bytes = await fsp.readFile(filePath);
      expect(file.bytes).toBe(stat.size);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }

    // The exact input bytes are copied, not regenerated from parsed fields.
    const [inputCopy, inputOriginal] = await Promise.all([
      fsp.readFile(path.join(bundleDir, 'job.gjf')),
      fsp.readFile(path.join(runDir, 'job.gjf')),
    ]);
    expect(inputCopy.equals(inputOriginal)).toBe(true);

    const methods = await fsp.readFile(path.join(bundleDir, 'methods.md'), 'utf8');
    expect(methods).toContain('## Computational methods');
    expect(methods).toContain('PBE0/def2-TZVP');
    expect(methods).toContain('as recorded in run.json');

    const readme = await fsp.readFile(path.join(bundleDir, 'README.md'), 'utf8');
    expect(readme).toContain('## Contents');
    expect(readme).toContain('## What this bundle cannot prove');
    expect(readme).toContain('sha256sum');
    expect(readme).toContain('cannot prove that the calculation was actually executed');
    expect(readme).toContain('Input hash at bundle time: matches the recorded hash');
    expect(readme).toContain('Output hash at bundle time: matches the recorded hash');
  });

  it('refuses to overwrite a non-empty target and leaves it untouched', async () => {
    const { root, runDir } = await makeRun();
    const bundleDir = path.join(root, 'existing');
    await fsp.mkdir(bundleDir);
    await fsp.writeFile(path.join(bundleDir, 'keep.txt'), 'keep me', 'utf8');

    await expect(writeRunBundle({ runDir, bundleDir })).rejects.toThrow(/non-empty folder/);

    expect(await fsp.readFile(path.join(bundleDir, 'keep.txt'), 'utf8')).toBe('keep me');
    expect(await fsp.readdir(bundleDir)).toEqual(['keep.txt']);
  });

  it('refuses a target that is a file or a symbolic link', async () => {
    const { root, runDir } = await makeRun();
    const fileTarget = path.join(root, 'not-a-folder');
    await fsp.writeFile(fileTarget, 'x', 'utf8');
    await expect(writeRunBundle({ runDir, bundleDir: fileTarget })).rejects.toThrow(/not a folder/);

    const realDir = path.join(root, 'real');
    await fsp.mkdir(realDir);
    if (process.platform !== 'win32') {
      const linkTarget = path.join(root, 'link');
      await fsp.symlink(realDir, linkTarget);
      await expect(writeRunBundle({ runDir, bundleDir: linkTarget })).rejects.toThrow(/symbolic link/);
    }
  });

  it('refuses unsafe names from run.json before creating the target', async () => {
    const { root, runDir, record } = await makeRun();

    record.inputName = '../escape.gjf';
    await fsp.writeFile(path.join(runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    const escaped = path.join(root, 'escaped');
    await expect(writeRunBundle({ runDir, bundleDir: escaped }))
      .rejects.toThrow(/safe \.gjf, \.com or \.xyz basename/);
    await expect(fsp.stat(escaped)).rejects.toMatchObject({ code: 'ENOENT' });

    record.inputName = 'job.gjf';
    record.outputName = 'job.exe';
    record.outputFile = 'job.exe';
    await fsp.writeFile(path.join(runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await expect(writeRunBundle({ runDir, bundleDir: escaped }))
      .rejects.toThrow(/safe \.out or \.log basename/);

    record.outputName = 'job.out';
    record.outputFile = 'job.out';
    record.id = '../run';
    await fsp.writeFile(path.join(runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await expect(writeRunBundle({ runDir, bundleDir: escaped }))
      .rejects.toThrow(/safe run id/);
  });

  it('reports a missing output instead of writing a partial bundle', async () => {
    const { root, runDir, record } = await makeRun();
    record.outputName = 'missing.out';
    record.outputFile = 'missing.out';
    await fsp.writeFile(path.join(runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');

    const bundleDir = path.join(root, 'partial');
    await expect(writeRunBundle({ runDir, bundleDir })).rejects.toThrow(/output file is missing/);
    await expect(fsp.stat(bundleDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('run bundle — fixture runs', () => {
  it('labels a dry-run fixture in README and refuses to write methods prose', async () => {
    const record = baseRecord();
    record.dryRun = true;
    record.status = 'completed';
    record.provenance = { ...record.provenance, kind: 'fixture' };
    const fixtureText = makeFixtureOutput();
    record.outputSha256 = sha256Text(fixtureText);
    const { root, runDir } = await makeRun({ record, outputText: fixtureText });
    const bundleDir = path.join(root, 'fixture-bundle');

    const result = await writeRunBundle({ runDir, bundleDir });
    expect(result.manifest.provenanceKind).toBe('fixture');

    const methods = await fsp.readFile(path.join(bundleDir, 'methods.md'), 'utf8');
    expect(methods).toContain('No methods paragraph is provided');
    expect(methods).toContain('not a real calculation');
    expect(methods).not.toContain('PBE0/def2-TZVP');

    const readme = await fsp.readFile(path.join(bundleDir, 'README.md'), 'utf8');
    expect(readme).toContain('## Fixture warning');
    expect(readme).toContain('synthetic');
  });
});

describe('run bundle — naming and manifest helpers', () => {
  it('accepts one safe path segment and rejects traversal or a wrong extension', () => {
    expect(isSafeBundleFileName('job.gjf')).toBe(true);
    expect(isSafeBundleFileName('job.out')).toBe(true);
    expect(isSafeBundleFileName('../job.gjf')).toBe(false);
    expect(isSafeBundleFileName('sub/job.gjf')).toBe(false);
    expect(isSafeBundleFileName('.hidden')).toBe(false);
    expect(isSafeBundleFileName('..')).toBe(false);
    expect(isSafeBundleFileName('job.gjf\u0000')).toBe(false);
    expect(isSafeRunId('run-1')).toBe(true);
    expect(isSafeRunId('../run-1')).toBe(false);

    expect(bundleFileNamesFor({ inputName: 'job.gjf', outputName: 'job.out' })).toEqual({
      inputName: 'job.gjf',
      outputName: 'job.out',
      methods: 'methods.md',
      readme: 'README.md',
      manifest: 'manifest.json',
    });
    expect(bundleFileNamesFor({ inputName: 'job.xyz', outputFile: 'xtb.log' })).toMatchObject({
      inputName: 'job.xyz',
      outputName: 'xtb.log',
    });
    expect(() => bundleFileNamesFor({ inputName: 'job.exe', outputName: 'job.out' })).toThrow();
    expect(() => bundleFileNamesFor({ inputName: 'job.gjf', outputName: 'job.gjf' })).toThrow();
    expect(() => bundleFileNamesFor({ inputName: 'job.xyz', outputName: 'job.exe' })).toThrow();
  });

  it('flags a changed run folder through the recorded-hash comparison', () => {
    const files = [
      { name: 'job.gjf', sha256: 'a'.repeat(64), bytes: 10 },
      { name: 'job.out', sha256: 'b'.repeat(64), bytes: 20 },
    ];
    const record = { ...baseRecord(), inputSha256: 'a'.repeat(64), outputSha256: 'b'.repeat(64) };
    const manifest = buildBundleManifest(record, { files, createdAt: '2026-11-07T12:00:00.000Z' });
    expect(manifest.hashMatchesRunRecord).toEqual({ input: true, output: true });

    const changed = buildBundleManifest(
      { ...record, inputSha256: 'c'.repeat(64) },
      { files, createdAt: '2026-11-07T12:00:00.000Z' },
    );
    expect(changed.hashMatchesRunRecord.input).toBe(false);
  });

  it('has no network API anywhere in the feature modules', async () => {
    const modules = [
      '../src/shared/methodsParagraph.js',
      '../src/shared/runBundle.js',
      '../electron/runner/runBundle.js',
      '../src/renderer/runBundle.js',
    ];
    const banned = [
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /\bEventSource\b/,
      /\baxios\b/,
      /from\s+['"]node:(?:http|https|net|tls|dns|dgram)['"]/,
      /require\(\s*['"]node:(?:http|https|net|tls|dns|dgram)['"]\s*\)/,
    ];
    for (const relative of modules) {
      const text = await fsp.readFile(new URL(relative, import.meta.url), 'utf8');
      for (const pattern of banned) {
        expect(text, `${relative} must not reference a network API`).not.toMatch(pattern);
      }
    }
  });
});
