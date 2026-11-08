/**
 * Cluster export file I/O and result import for NodeChem Studio.
 *
 * The script set is planned by `src/shared/clusterExport.js` in the renderer;
 * this module is the only place that touches the filesystem. Export writes a
 * new folder and never overwrites a previous one. Import reads the returned
 * outputs and records them in the same run model the local runner uses, so
 * `run.json`, gates and run history behave identically.
 *
 * No network code lives here, and none is needed: submission is a shell script
 * the user runs on the cluster.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseGaussianOutput, evaluateGates } from '../../src/shared/gaussianOutput.js';
import { CLUSTER_FORMATS, MANIFEST_KIND, MANIFEST_VERSION } from '../../src/shared/clusterExport.js';
import { outputCandidates } from './outputDiscovery.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_FILE = /^[A-Za-z0-9._-]+$/;
const SAFE_INPUT = /^[A-Za-z0-9._-]+\.(gjf|com)$/i;
const SAFE_OUTPUT = /^[A-Za-z0-9._-]+\.(out|log)$/i;

const MAX_FILES = 500;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

function stampFor(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

async function uniqueExportDir(parentDir, format, date) {
  const base = `cluster-${format}-${stampFor(date)}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const dir = path.join(parentDir, name);
    try {
      await fsp.mkdir(dir);
      return dir;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not create a new export folder; remove an old cluster export and try again.');
}

async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Write a planned file set under a fresh `cluster-<format>-<stamp>` folder.
 * File names are untrusted renderer input, so every name is validated and the
 * path is joined under the folder the user picked.
 */
export async function writeClusterExport({ parentDir, format, files, now = new Date() } = {}) {
  if (!CLUSTER_FORMATS.includes(format)) {
    throw new Error('Cluster format must be either "slurm" or "pbs".');
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('The cluster export has no files.');
  }
  if (files.length > MAX_FILES) {
    throw new Error(`A cluster export is limited to ${MAX_FILES} files.`);
  }
  const parent = path.resolve(String(parentDir || ''));
  const parentStat = await fsp.stat(parent).catch(() => null);
  if (!parentStat?.isDirectory()) {
    throw new Error('Choose an existing folder for the cluster export.');
  }

  const names = new Set();
  let total = 0;
  for (const file of files) {
    const name = String(file?.name || '');
    if (!SAFE_FILE.test(name) || name.startsWith('.')) {
      throw new Error(`Unsafe cluster export file name "${name}".`);
    }
    if (names.has(name)) throw new Error(`Duplicate cluster export file "${name}".`);
    names.add(name);
    const content = String(file?.content ?? '');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw new Error(`Cluster export file "${name}" is larger than 8 MiB.`);
    total += bytes;
  }
  if (total > MAX_TOTAL_BYTES) throw new Error('The cluster export is larger than 16 MiB.');

  const exportDir = await uniqueExportDir(parent, format, now);
  for (const file of files) {
    await fsp.writeFile(path.join(exportDir, String(file.name)), String(file.content ?? ''), 'utf8');
  }
  return { canceled: false, path: exportDir, format, files: [...names] };
}

function gateOptionsFor(raw) {
  const gates = raw && typeof raw === 'object' ? raw : {};
  return {
    expectedImaginary: Number.isInteger(gates.expectedImaginary) ? gates.expectedImaginary : null,
    minMagnitude: gates.minMagnitude === undefined || gates.minMagnitude === null
      ? 50 : Number(gates.minMagnitude),
    requireOptimization: Boolean(gates.requireOptimization),
    requireFrequency: Boolean(gates.requireFrequency),
    requireThermochemistry: Boolean(gates.requireThermochemistry),
    requireFinalEnergy: Boolean(gates.requireFinalEnergy),
  };
}

function runIdFor(date, index) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const suffix = `${String(index + 1).padStart(2, '0')}${Math.random().toString(36).slice(2, 6)}`;
  return `${stamp}-${suffix}`;
}

async function readManifest(exportDir) {
  let text;
  try {
    text = await fsp.readFile(path.join(exportDir, 'manifest.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('The selected folder has no manifest.json. Choose a folder produced by "Export cluster scripts".');
    }
    throw error;
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`The cluster manifest is not valid JSON: ${error.message}`);
  }
  if (manifest?.kind !== MANIFEST_KIND) {
    throw new Error('The selected folder is not a NodeChem Studio cluster export.');
  }
  if (manifest.schemaVersion !== MANIFEST_VERSION) {
    throw new Error(`Cluster manifest version ${manifest.schemaVersion} is not supported by this build.`);
  }
  if (!CLUSTER_FORMATS.includes(manifest.format)) {
    throw new Error('The cluster manifest has an unknown scheduler format.');
  }
  if (!Array.isArray(manifest.nodes) || manifest.nodes.length === 0) {
    throw new Error('The cluster manifest lists no calculation jobs.');
  }
  return manifest;
}

async function findReturnedOutput(exportDir, node) {
  for (const name of outputCandidates({ inputName: node.inputName, outputName: node.outputName })) {
    const file = path.join(exportDir, name);
    const stat = await fsp.stat(file).catch(() => null);
    if (stat?.isFile() && stat.size > 0) {
      return { name, file, size: stat.size, mtimeMs: stat.mtimeMs };
    }
  }
  return null;
}

/**
 * Import outputs returned from a cluster run into run folders.
 *
 * Every imported output goes through the same `parseGaussianOutput` +
 * `evaluateGates` path as a local run, so a normal termination is still only
 * a claim until the gates agree. Missing outputs are reported, never invented.
 */
export async function importClusterExport({ exportDir, runsRoot, now = new Date() } = {}) {
  const dir = path.resolve(String(exportDir || ''));
  const root = path.resolve(String(runsRoot || ''));
  if (!runsRoot) throw new Error('No run directory is configured for the import.');
  const manifest = await readManifest(dir);
  await fsp.mkdir(root, { recursive: true });

  const runs = [];
  const missing = [];
  const errors = [];

  for (const [index, node] of manifest.nodes.entries()) {
    const nodeId = String(node?.nodeId || '');
    if (!SAFE_ID.test(nodeId)) {
      errors.push({ nodeId, message: 'manifest entry has an unsafe node id.' });
      continue;
    }
    const inputName = String(node?.inputName || '');
    const outputName = String(node?.outputName || '');
    if (!SAFE_INPUT.test(inputName) || !SAFE_OUTPUT.test(outputName)) {
      errors.push({ nodeId, message: 'manifest entry has an unsafe input or output name.' });
      continue;
    }

    const found = await findReturnedOutput(dir, { inputName, outputName });
    if (!found) {
      missing.push({ nodeId, expected: outputName });
      continue;
    }
    if (found.size > MAX_OUTPUT_BYTES) {
      errors.push({ nodeId, message: `${found.name} is larger than 32 MiB and was not imported.` });
      continue;
    }

    let text;
    try {
      text = await fsp.readFile(found.file, 'utf8');
    } catch (error) {
      errors.push({ nodeId, message: `could not read ${found.name}: ${error.message}` });
      continue;
    }

    const parsed = parseGaussianOutput(text);
    const gates = evaluateGates(parsed, { ...gateOptionsFor(node.gates) });
    const status = parsed.status === 'error' || gates.overall === 'fail' ? 'failed'
      : gates.overall === 'pass' ? 'completed' : 'needs-review';

    const runId = runIdFor(now, index);
    const runDir = path.join(root, runId);
    await fsp.mkdir(runDir, { recursive: true });
    await fsp.copyFile(found.file, path.join(runDir, found.name));

    const returnedInput = path.join(dir, inputName);
    const inputStat = await fsp.stat(returnedInput).catch(() => null);
    const hasInput = Boolean(inputStat?.isFile());
    if (hasInput) await fsp.copyFile(returnedInput, path.join(runDir, inputName));

    const record = {
      // Same contract as a locally executed run (schemas/run-record.v1.schema.json).
      schemaVersion: 1,
      id: runId,
      status,
      dryRun: false,
      title: String(node.title || nodeId),
      inputName,
      outputName,
      outputFile: found.name,
      outputSource: 'cluster-import',
      truncated: false,
      executable: null,
      scratchDir: null,
      checkpointHandoff: null,
      startedAt: new Date(found.mtimeMs).toISOString(),
      finishedAt: new Date(now).toISOString(),
      exitCode: null,
      parsed,
      gates,
      error: null,
      provenance: {
        source: 'cluster-import',
        exportDir: dir,
        exportFormat: manifest.format,
        exportCreatedAt: manifest.createdAt || null,
        nodeId,
        inputStaged: hasInput,
        importedAt: new Date(now).toISOString(),
      },
    };
    await writeJson(path.join(runDir, 'run.json'), record);
    await writeJson(path.join(runDir, 'request.json'), record);
    runs.push(record);
  }

  return {
    canceled: false,
    exportDir: dir,
    format: manifest.format,
    runs,
    missing,
    errors,
  };
}
