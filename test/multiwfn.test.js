import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmrf } from './helpers/tempCleanup.js';
import {
  MULTIWFN_ANALYSES,
  MULTIWFN_CITATION,
  MULTIWFN_CITATION_2012,
  MULTIWFN_CITATION_2024,
  MULTIWFN_CITATION_NOTE,
  QTAIM_COMPARISON_TOLERANCES,
  compareQtaimToApp,
  multiwfnCitationFor,
  multiwfnMenuScript,
  multiwfnArgv,
  multiwfnBandFor,
  multiwfnSummary,
  multiwfnVersionRefusal,
  parseMultiwfnOutput,
  validateMultiwfnDefinition,
} from '../src/shared/multiwfn.js';
import { parseFchk } from '../src/shared/fchk.js';
import { qtaimAnalysis } from '../src/shared/qtaim.js';
import { defaultSettings, validateProject } from '../src/shared/projectSchema.js';
import { buildWorkflowPlan, computeContext } from '../src/shared/workflowTasks.js';
import { RunManager } from '../electron/runner/runManager.js';
import { QueueManager } from '../electron/runner/queue.js';
import { resultsPanelHtml } from '../src/renderer/resultsView.js';
import { multiwfnSectionHtml } from '../src/shared/workflowReport.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = path.join(ROOT, 'test/fixtures/multiwfn');
const read = (name) => fsp.readFile(path.join(FIXTURES, name), 'utf8');
const roots = [];

// The fake Multiwfn below is a POSIX shell script, like the other sidecar fakes.
// `Windows package` runs this suite on windows-latest, where it cannot start, so
// the two tests that spawn it are skipped there; the parsers, menu scripts and
// validation run on every platform.
const canSpawnShell = process.platform !== 'win32';

const water = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.9572, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.927, z: 0 },
];

function molecule() {
  return {
    smiles: '', charge: 0, multiplicity: 1, fragments: [], coords: water,
    geometry: { source: 'demo', file: '', format: '' },
  };
}

const calc = (id = 'calc') => ({
  id, type: 'calculate', kind: 'SP', title: id, state: 'ready', x: 0, y: 0,
  settings: defaultSettings({ jobType: 'SP' }), output: null,
});

const multiwfnNode = (definition, id = 'mw') => ({
  id, type: 'analyse', kind: 'Analyse', title: 'Multiwfn', state: 'ready', x: 40, y: 0,
  analyse: { mode: 'multiwfn', multiwfn: definition },
});

function projectWith(nodes, edges) {
  return {
    schemaVersion: 3,
    name: 'Multiwfn',
    molecule: molecule(),
    defaults: { method: 'B3LYP', basis: '6-31G*', memory: '4', memoryUnit: 'GB', nproc: '4' },
    runner: { maxParallel: 1 },
    datasets: [],
    flows: [{ id: 'main', title: 'Main', nodes, edges }],
    reports: [],
    activeFlowId: 'main',
  };
}

function validated(raw) {
  const result = validateProject(raw);
  expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
  return result.project;
}

function definitionFor(analysis, extra = {}) {
  return validateMultiwfnDefinition({
    analysis,
    input: { nodeId: 'calc' },
    ...extra,
  }).value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rmrf(root)));
});

describe('issue #270 — Multiwfn schema', () => {
  it('accepts each v1 analysis and keeps the expression default byte for byte', () => {
    for (const analysis of MULTIWFN_ANALYSES) {
      const definition = definitionFor(analysis.id);
      const project = validated(projectWith(
        [calc(), multiwfnNode(definition)],
        [{ from: 'calc', to: 'mw', type: 'dependency' }],
      ));
      expect(project.nodes[1].analyse.mode).toBe('multiwfn');
      expect(project.nodes[1].analyse.multiwfn.analysis).toBe(analysis.id);
      expect(project.nodes[1].analyse.multiwfn.input).toEqual({ nodeId: 'calc' });
    }
    const old = validated(projectWith([
      { ...calc(), id: 'a' },
      {
        id: 'c', type: 'analyse', kind: 'Analyse', title: 'CBS', state: 'ready', x: 0, y: 0,
        analyse: { expression: 'E', inputs: [{ name: 'E', field: 'finalEnergyHartree', source: 'a' }] },
      },
    ], [{ from: 'a', to: 'c', type: 'dependency' }]));
    expect(old.nodes[1].analyse.mode).toBeUndefined();
    expect(old.nodes[1].analyse.multiwfn).toBeUndefined();
  });

  it('refuses an unknown analysis by name', () => {
    const checked = validateMultiwfnDefinition({ analysis: 'npa', input: { nodeId: 'calc' } });
    expect(checked.errors[0].path).toBe('analysis');
    expect(checked.errors[0].message).toContain('"npa" is not a supported Multiwfn analysis');
  });

  it('refuses a missing input, two inputs and a path that escapes the project', () => {
    expect(validateMultiwfnDefinition({ analysis: 'qtaim' }).errors[0].message)
      .toContain('input');
    const two = validateMultiwfnDefinition({
      analysis: 'qtaim', input: { nodeId: 'calc', path: 'water.fchk' },
    });
    expect(two.errors[0].message).toContain('exactly one of runId, nodeId or path');
    const escape = validateMultiwfnDefinition({
      analysis: 'qtaim', input: { path: '../water.fchk' },
    });
    expect(escape.errors[0].message).toContain('must not contain ".."');
  });

  it('refuses an unsupported format for the analysis', () => {
    const checked = validateMultiwfnDefinition({ analysis: 'qtaim', input: { path: 'density.cube' } });
    expect(checked.errors[0].path).toBe('input.path');
    expect(checked.errors[0].message).toContain('QTAIM basin integration reads');
  });

  it('refuses a project whose Multiwfn block has no analysis', () => {
    const raw = projectWith(
      [calc(), multiwfnNode(null)],
      [{ from: 'calc', to: 'mw', type: 'dependency' }],
    );
    const result = validateProject(raw);
    expect(result.errors.some((entry) => entry.path.includes('analyse.multiwfn'))).toBe(true);
  });

  it('plans one task per record and carries the definition', () => {
    // `esp` no longer declares a grid (issue 339: no menu answer carries one), so
    // the grid belongs to the analysis that uses it — QTAIM's basin grid.
    const definition = definitionFor('qtaim', { grid: 3 });
    const project = validated(projectWith(
      [calc(), multiwfnNode(definition)],
      [{ from: 'calc', to: 'mw', type: 'dependency' }],
    ));
    const plan = buildWorkflowPlan(project);
    const task = plan.tasks.find((entry) => entry.type === 'analyse');
    expect(task.analyse.mode).toBe('multiwfn');
    expect(task.analyse.multiwfn.grid).toBe(3);
    expect(task.executable).toBe(false);
    const context = computeContext(project, project.nodes[1]);
    expect(context.mode).toBe('multiwfn');
  });
});

describe('issue #270 — deterministic menu scripts', () => {
  it('pins the current-band QTAIM recipe exactly (issue 339)', () => {
    const script = multiwfnMenuScript('qtaim', { grid: 2 });
    expect(script.version).toBe('2024+');
    // The CP properties come from topology option 7 + `-1`; the old `-4 / -1 / 7 / 0`
    // export submenu wrote no CPprop.txt at all.
    expect(script.text).toBe([
      '2', '2', '3', '7', '-1', '-10',
      '17', '1', '1', '2', '7', '2', '1', '-10', 'q', '',
    ].join('\n'));
    expect(multiwfnMenuScript('qtaim', { grid: 2 }).text).toBe(script.text);
  });

  it('keeps the 3.8 recipes in their own band', () => {
    expect(multiwfnMenuScript('qtaim', { grid: 2 }, { band: '3.8' }).text).toBe([
      '2', '2', '3', '-4', '-1', '7', '0', '-10',
      '17', '1', '1', '2', '7', '2', '1', '-10', 'q', '',
    ].join('\n'));
    expect(() => multiwfnMenuScript('qtaim', {}, { band: '2.5' }))
      .toThrow(/not a Multiwfn menu band/);
  });

  it('writes the ELF cube recipe with the requested grid', () => {
    expect(multiwfnMenuScript('elf', { grid: 80 }).text).toBe([
      '5', '9', '4', '80,80,80', '2', '0', 'q', '',
    ].join('\n'));
  });

  it('writes ESP and RDG recipes with their parameters (issue 339)', () => {
    // 0 = analyse *with* the mapped ESP; -1 -1 take the default post-processing
    // answers. `6` and the trailing `0 q` used to exit 59 after the surface run.
    expect(multiwfnMenuScript('esp', { isovalue: 0.001 }).text).toBe([
      '12', '1', '1', '0.001', '0', '-1', '-1', 'q', '',
    ].join('\n'));
    expect(multiwfnMenuScript('rdg', { grid: 3 }).text).toBe([
      '20', '1', '3', '2', '0', '0', 'q', '',
    ].join('\n'));
  });

  it('accepts the release a user can install and refuses only unknown bands (issue 341)', () => {
    expect(multiwfnVersionRefusal('3.8(dev)')).toBeNull();
    expect(multiwfnVersionRefusal('3.8')).toBeNull();
    // The vendor's download page installs a 2026 build; that is not a refusal.
    expect(multiwfnVersionRefusal('2026.11.3')).toBeNull();
    expect(multiwfnBandFor('2026.11.3').id).toBe('2024+');
    expect(multiwfnBandFor('3.8').id).toBe('3.8');
    expect(multiwfnVersionRefusal('3.7')).toContain('not in a menu band');
    expect(multiwfnVersionRefusal('3.7')).toContain('archive-only');
    expect(multiwfnVersionRefusal('')).toContain('version could not be read');
  });

  it('cites both papers for a 2024+ banner and the 2012 paper alone for 3.8 (issue 342)', () => {
    // The 2026.11.3 banner prints both DOIs and says both MUST be cited.
    expect(MULTIWFN_CITATION_2012).toContain('10.1002/jcc.22885');
    expect(MULTIWFN_CITATION_2024).toContain('10.1063/5.0216272');
    expect(MULTIWFN_CITATION).toContain(MULTIWFN_CITATION_2012);
    expect(MULTIWFN_CITATION).toContain(MULTIWFN_CITATION_2024);
    expect(MULTIWFN_CITATION_NOTE).toContain('Both papers must be cited');
    // The default is the current band, so anything that cannot name a version
    // over-cites rather than under-cites.
    expect(multiwfnCitationFor()).toBe(MULTIWFN_CITATION);
    expect(multiwfnCitationFor('2026.11.3')).toBe(MULTIWFN_CITATION);
    expect(multiwfnCitationFor('2024+')).toBe(MULTIWFN_CITATION);
    expect(multiwfnCitationFor('3.8')).toBe(MULTIWFN_CITATION_2012);
    expect(multiwfnCitationFor('3.8(dev)')).toBe(MULTIWFN_CITATION_2012);
    expect(multiwfnCitationFor('')).toBe(MULTIWFN_CITATION);
  });
});

describe('issue #270 — transcript parsers', () => {
  it('parses the QTAIM basin table, charges and critical points', async () => {
    const text = await read('qtaim.out');
    const result = parseMultiwfnOutput({ analysis: 'qtaim', text, files: { cpProp: text } });
    expect(result.ok).toBe(true);
    expect(result.basins.count).toBe(3);
    expect(result.basins.rows[0]).toEqual({
      basin: 1, electrons: 8.123456789, volumeBohr3: 120.123, volumeRhoCutoffBohr3: 34.884,
    });
    expect(result.basins.sumElectrons).toBe(10);
    expect(result.atomicCharges[0]).toMatchObject({ basin: 1, element: 'O', charge: -0.123457 });
    expect(result.criticalPoints).toHaveLength(3);
    expect(result.criticalPoints[0]).toMatchObject({
      index: 1, type: '(3,-1)', connectedAtoms: '1(O ) -- 2(H )',
    });
    expect(result.criticalPoints[0].density).toBeCloseTo(0.3560528793, 10);
    expect(result.criticalPoints[0].laplacian).toBeCloseTo(-1.866651214, 9);
  });

  it('parses the ESP surface summary into stated units', async () => {
    const text = await read('esp.out');
    const result = parseMultiwfnOutput({ analysis: 'esp', text, parameters: { isovalue: 0.001 } });
    expect(result.ok).toBe(true);
    expect(result.surfaceArea.overall).toMatchObject({
      bohr: 90, angstrom: 25.2, bohrUnit: 'bohr^2', angstromUnit: 'angstrom^2',
    });
    expect(result.volume.angstrom).toBeCloseTo(17.782, 3);
    expect(result.potential.minimalKcalMol).toBe(-45);
    expect(result.potential.maximalKcalMol).toBe(32);
    expect(result.potential.overall.kcalMol).toBeCloseTo(-0.12695332, 8);
    expect(result.polarity.mpiEv).toBeCloseTo(0.50154872, 8);
  });

  it('summarises the ELF cube from the file itself', async () => {
    const cubeText = await read('elf.cube');
    const result = parseMultiwfnOutput({
      analysis: 'elf', text: '', files: { cubeText, cubeName: 'elf.cube' },
    });
    expect(result.ok).toBe(true);
    expect(result.cube.dims).toEqual([4, 4, 4]);
    expect(result.cube.voxels).toBe(64);
    expect(result.summary.min).toBe(0);
    expect(result.summary.max).toBeCloseTo(0.63, 8);
    expect(result.summary.mean).toBeCloseTo(0.315, 8);
  });

  it('parses RDG–NCI points from the five-column scatter file (issue 340)', async () => {
    const text = await read('nci-output-2026.txt');
    const result = parseMultiwfnOutput({ analysis: 'rdg', text, parameters: { isovalue: 0.5 } });
    expect(result.ok).toBe(true);
    expect(result.points.count).toBe(3);
    // Columns 4 and 5 — not the X/Y coordinates, which is what the old parser read.
    expect(result.points.values[0]).toEqual([-0.33717929e-3, 7.4118347]);
    expect(result.points.values[1]).toEqual([-0.38441398e-3, 7.046955]);
    expect(result.range.xMax).toBeCloseTo(-0.33717929e-3, 12);
    expect(result.range.sMax).toBeCloseTo(7.4118347, 7);
    expect(result.counts.attractive).toBe(3);
    expect(result.counts.belowIsovalue).toBe(0);
  });

  it('counts a two-column file as skipped lines instead of reading coordinates', async () => {
    const text = await read('nci.txt');
    const result = parseMultiwfnOutput({ analysis: 'rdg', text, parameters: { isovalue: 0.5 } });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no sign(lambda2)rho / RDG points');
  });

  it('refuses a transcript with no basin table instead of returning zero', () => {
    const result = parseMultiwfnOutput({ analysis: 'qtaim', text: 'no table here' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no four-column basin integration table');
  });

  it('normalises the same transcript to the same JSON every time', async () => {
    const text = await read('qtaim.out');
    const one = parseMultiwfnOutput({ analysis: 'qtaim', text, files: { cpProp: text } });
    const two = parseMultiwfnOutput({ analysis: 'qtaim', text, files: { cpProp: text } });
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });

  it('runs the binary with -silent and writes the menu to stdin', () => {
    expect(multiwfnArgv({ inputName: 'water.fchk', threads: 4 }))
      .toEqual(['water.fchk', '-nt', '4', '-silent']);
    expect(multiwfnArgv({ inputName: 'water.fchk' })).toEqual(['water.fchk', '-silent']);
  });
});

describe('issue #270 — QTAIM comparison with the in-app analysis', () => {
  it('compares (3,-1) properties and reports the stated tolerances', async () => {
    const fchkText = await fsp.readFile(path.join(ROOT, 'test/fixtures/esp/water-esp.fchk'), 'utf8');
    const inApp = qtaimAnalysis({ fchk: parseFchk(fchkText), bondPath: false });
    const multiwfn = parseMultiwfnOutput({
      analysis: 'qtaim', text: await read('qtaim.out'), files: { cpProp: await read('qtaim.out') },
    });
    const comparison = compareQtaimToApp(multiwfn, inApp);
    expect(comparison.matched).toBe(2);
    expect(comparison.differences.length).toBeGreaterThanOrEqual(6);
    expect(comparison.differences.some((entry) => entry.property === 'density')).toBe(true);
    expect(comparison.tolerances).toEqual(QTAIM_COMPARISON_TOLERANCES);
    // The fixture is synthetic and close to the in-app values on purpose; this
    // proves the comparison runs, not that Multiwfn agrees with qtaim.js.
    expect(comparison.withinTolerance).toBe(true);
  });
});

describe('issue #270 — the result card and the report', () => {
  it('prints the normalised QTAIM table, provenance, script and citation', async () => {
    const result = parseMultiwfnOutput({
      analysis: 'qtaim', text: await read('qtaim.out'), files: { cpProp: await read('qtaim.out') },
    });
    const provenance = {
      program: 'Multiwfn',
      version: '3.8(dev)',
      executable: '/opt/Multiwfn/Multiwfn',
      menuVersion: '3.8',
      menuScript: multiwfnMenuScript('qtaim', {}).text,
      citation: MULTIWFN_CITATION,
      input: { name: 'water.fchk', sha256: 'c'.repeat(64) },
    };
    const analyse = { mode: 'multiwfn', status: 'computed', summary: multiwfnSummary(result), notComputed: null };
    const card = resultsPanelHtml({
      id: 'mw', title: 'Water QTAIM', status: 'completed', analyse, multiwfn: result, provenance,
    });
    expect(card).toContain('data-role="multiwfn-basin"');
    expect(card).toContain('data-role="multiwfn-critical-point"');
    expect(card).toContain('data-role="multiwfn-script"');
    expect(card).toContain('3.8(dev)');
    expect(card).toContain('c'.repeat(64));
    expect(card).toContain('J. Comput. Chem.');
    expect(resultsPanelHtml({
      id: 'mw', title: 'Water QTAIM', analyse: { ...analyse, status: 'refused', notComputed: 'no Multiwfn binary' },
    })).toContain('no Multiwfn binary');

    const section = multiwfnSectionHtml([{
      nodeId: 'mw', title: 'Water QTAIM', status: 'computed', summary: '', notComputed: null,
      result, provenance,
    }], 'h2');
    expect(section).toContain('data-field="multiwfn-basin"');
    expect(section).toContain('data-field="multiwfn-provenance"');
    expect(section).toContain('3.8(dev)');
    expect(section).toContain('c'.repeat(64));
  });
});

describe('issue #270 — the sidecar through the queue', () => {
  it.skipIf(!canSpawnShell)('runs a fake Multiwfn, writes run.json with version, script and input hash', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'multiwfn-'));
    roots.push(base);
    const queuesRoot = path.join(base, 'queues');
    const runsRoot = path.join(base, 'runs');
    const sourceDir = path.join(runsRoot, 'gaussian-run');
    await fsp.mkdir(sourceDir, { recursive: true });
    const fchk = await fsp.readFile(path.join(ROOT, 'test/fixtures/esp/water-esp.fchk'));
    await fsp.writeFile(path.join(sourceDir, 'water.fchk'), fchk);
    // The transcript the fake prints must name the same release the banner probe saw.
    const qtaimOut = (await read('qtaim.out'))
      .replace(/Version 3\.8\(dev\)[^\n]*/, 'Version 2026.11.3 (release date is the same as version name)');
    const fake = path.join(base, 'Multiwfn');
    const fakeScript = [
      '#!/bin/sh',
      'if [ "$#" -eq 0 ]; then',
      '  echo " Multiwfn -- A Multifunctional Wavefunction Analyzer"',
      '  echo " Version 2026.11.3 (release date is the same as version name)"',
      '  exit 0',
      'fi',
      'cat > menu.txt',
      `cat <<'EOF' > CPprop.txt`,
      qtaimOut,
      'EOF',
      `cat <<'EOF'`,
      qtaimOut,
      'EOF',
      'exit 0',
    ].join('\n');
    await fsp.writeFile(fake, fakeScript, { mode: 0o755 });

    const events = [];
    const runManager = new RunManager({ runsRoot, emit: (event) => events.push(event) });
    const queueManager = new QueueManager({ queuesRoot, runManager, emit: (event) => events.push(event) });
    await queueManager.init();
    const definition = definitionFor('qtaim', { input: { nodeId: 'calc' } });
    const queue = {
      id: 'mw-queue',
      projectName: 'Multiwfn',
      status: 'running',
      createdAt: new Date().toISOString(),
      options: { multiwfnExecutable: fake, projectDir: base, maxParallel: 1, dryRun: false },
      timeoutSeconds: 60,
      edges: [{ from: 'calc', to: 'mw', type: 'dependency' }],
      tasks: [
        { nodeId: 'calc', title: 'Gaussian', status: 'completed', runDir: sourceDir, runId: 'run-1' },
        {
          nodeId: 'mw', type: 'analyse', title: 'Multiwfn QTAIM', status: 'pending', attempts: 0,
          analyse: { mode: 'multiwfn', multiwfn: definition, sources: ['calc'] },
        },
      ],
    };
    queueManager.queues.set(queue.id, queue);
    await fsp.mkdir(queueManager.queueDir(queue.id), { recursive: true });
    await queueManager.persist(queue);
    const task = queue.tasks[1];
    await queueManager.runMultiwfn(queue, task);
    expect(task.status).toBe('completed');
    const record = JSON.parse(await fsp.readFile(path.join(queueManager.queueDir(queue.id), 'analyse', 'mw', 'run.json'), 'utf8'));
    expect(record.kind).toBe('multiwfn');
    expect(record.status).toBe('completed');
    expect(record.provenance.version).toBe('2026.11.3');
    expect(record.provenance.menuVersion).toBe('2024+');
    expect(record.provenance.menuScript).toBe(multiwfnMenuScript('qtaim', { grid: 2 }, { band: '2024+' }).text);
    expect(record.provenance.citation).toBe(MULTIWFN_CITATION);
    expect(record.inputSha256).toBe(createHash('sha256').update(fchk).digest('hex'));
    expect(record.multiwfn.basins.count).toBe(3);
    expect(record.multiwfn.comparison.matched).toBe(2);
    expect(task.analyse.summary).toBe(multiwfnSummary(record.multiwfn));
    const menu = await fsp.readFile(path.join(queueManager.queueDir(queue.id), 'analyse', 'mw', 'menu.txt'), 'utf8');
    expect(menu).toBe(record.provenance.menuScript);
  });

  it.skipIf(!canSpawnShell)('refuses a checkpoint with no density matrix by name', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'multiwfn-nodensity-'));
    roots.push(base);
    const queuesRoot = path.join(base, 'queues');
    const runsRoot = path.join(base, 'runs');
    const sourceDir = path.join(runsRoot, 'gaussian-run');
    await fsp.mkdir(sourceDir, { recursive: true });
    const fchk = (await fsp.readFile(path.join(ROOT, 'test/fixtures/esp/water-esp.fchk'), 'utf8'))
      .replace('Total SCF Density', 'Removed SCF Density');
    await fsp.writeFile(path.join(sourceDir, 'water.fchk'), fchk);
    const fake = path.join(base, 'Multiwfn');
    await fsp.writeFile(fake, [
      '#!/bin/sh',
      'echo " Version 2026.11.3 (release date is the same as version name)"',
      'exit 0',
    ].join('\n'), { mode: 0o755 });
    const runManager = new RunManager({ runsRoot, emit: () => {} });
    const queueManager = new QueueManager({ queuesRoot, runManager, emit: () => {} });
    await queueManager.init();
    const definition = definitionFor('qtaim');
    const queue = {
      id: 'mw-nodensity',
      projectName: 'Multiwfn',
      status: 'running',
      createdAt: new Date().toISOString(),
      options: { multiwfnExecutable: fake, projectDir: base, maxParallel: 1, dryRun: false },
      timeoutSeconds: 60,
      edges: [{ from: 'calc', to: 'mw', type: 'dependency' }],
      tasks: [
        { nodeId: 'calc', title: 'Gaussian', status: 'completed', runDir: sourceDir, runId: 'run-1' },
        { nodeId: 'mw', type: 'analyse', title: 'Multiwfn QTAIM', status: 'pending', attempts: 0, analyse: { mode: 'multiwfn', multiwfn: definition } },
      ],
    };
    queueManager.queues.set(queue.id, queue);
    await fsp.mkdir(queueManager.queueDir(queue.id), { recursive: true });
    await queueManager.persist(queue);
    await queueManager.runMultiwfn(queue, queue.tasks[1]);
    expect(queue.tasks[1].status).toBe('failed');
    expect(queue.tasks[1].error).toContain('needs a density matrix');
    expect(queue.tasks[1].error).toContain('no density in this file');
  });

  it('names a missing executable instead of reporting unknown', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'multiwfn-missing-'));
    roots.push(base);
    const queuesRoot = path.join(base, 'queues');
    const runsRoot = path.join(base, 'runs');
    const runManager = new RunManager({ runsRoot, emit: () => {} });
    const queueManager = new QueueManager({ queuesRoot, runManager, emit: () => {} });
    await queueManager.init();
    const definition = definitionFor('qtaim');
    const queue = {
      id: 'mw-missing',
      projectName: 'Multiwfn',
      status: 'running',
      createdAt: new Date().toISOString(),
      options: { multiwfnExecutable: '', projectDir: base, maxParallel: 1, dryRun: false },
      timeoutSeconds: 60,
      edges: [{ from: 'calc', to: 'mw', type: 'dependency' }],
      tasks: [
        { nodeId: 'calc', title: 'Gaussian', status: 'completed', runDir: path.join(base, 'none'), runId: 'run-1' },
        { nodeId: 'mw', type: 'analyse', title: 'Multiwfn QTAIM', status: 'pending', attempts: 0, analyse: { mode: 'multiwfn', multiwfn: definition } },
      ],
    };
    queueManager.queues.set(queue.id, queue);
    await fsp.mkdir(queueManager.queueDir(queue.id), { recursive: true });
    await queueManager.persist(queue);
    await queueManager.runMultiwfn(queue, queue.tasks[1]);
    expect(queue.tasks[1].status).toBe('failed');
    expect(queue.tasks[1].error).toContain('No Multiwfn executable is configured');
    const record = JSON.parse(await fsp.readFile(path.join(queueManager.queueDir(queue.id), 'analyse', 'mw', 'run.json'), 'utf8'));
    expect(record.error.code).toBe('multiwfn-binary');
    expect(record.analyse.notComputed).toContain('No Multiwfn executable is configured');
  });

  it.skipIf(!canSpawnShell)('reports a child killed by a signal as a failure, not a parse error (issue 344)', async () => {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'multiwfn-signal-'));
    roots.push(base);
    const queuesRoot = path.join(base, 'queues');
    const runsRoot = path.join(base, 'runs');
    const sourceDir = path.join(runsRoot, 'gaussian-run');
    await fsp.mkdir(sourceDir, { recursive: true });
    await fsp.copyFile(path.join(ROOT, 'test/fixtures/esp/water-esp.fchk'), path.join(sourceDir, 'water.fchk'));
    const fake = path.join(base, 'Multiwfn');
    await fsp.writeFile(fake, [
      '#!/bin/sh',
      'if [ "$#" -eq 0 ]; then',
      '  echo " Version 2026.11.3 (release date is the same as version name)"',
      '  exit 0',
      'fi',
      'cat > menu.txt',
      'echo "NCI analysis started"',
      // A process that dies from a signal reports exitCode null; the queue used to
      // read Number(null) as 0 and blame the parser for the missing output.
      'kill -KILL $$',
    ].join('\n'), { mode: 0o755 });

    const runManager = new RunManager({ runsRoot, emit: () => {} });
    const queueManager = new QueueManager({ queuesRoot, runManager, emit: () => {} });
    await queueManager.init();
    const definition = definitionFor('rdg', { grid: 2, input: { nodeId: 'calc' } });
    const queue = {
      id: 'mw-signal',
      projectName: 'Multiwfn',
      status: 'running',
      createdAt: new Date().toISOString(),
      options: { multiwfnExecutable: fake, projectDir: base, maxParallel: 1, dryRun: false },
      timeoutSeconds: 60,
      edges: [{ from: 'calc', to: 'mw', type: 'dependency' }],
      tasks: [
        { nodeId: 'calc', title: 'Gaussian', status: 'completed', runDir: sourceDir, runId: 'run-1' },
        { nodeId: 'mw', type: 'analyse', title: 'Multiwfn NCI', status: 'pending', attempts: 0, analyse: { mode: 'multiwfn', multiwfn: definition } },
      ],
    };
    queueManager.queues.set(queue.id, queue);
    await fsp.mkdir(queueManager.queueDir(queue.id), { recursive: true });
    await queueManager.persist(queue);
    await queueManager.runMultiwfn(queue, queue.tasks[1]);

    expect(queue.tasks[1].status).toBe('failed');
    expect(queue.tasks[1].error).toContain('killed by signal');
    // The failure belongs to the engine, not to the parser: the transcript never
    // reached a scatter file, and the reason says so.
    expect(queue.tasks[1].error).not.toContain('no sign(lambda2)rho');
  });
});
