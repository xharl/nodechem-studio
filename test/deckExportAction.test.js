import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { deckFilename, exportDeckAction } from '../src/renderer/deckExport.js';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'bin', 'ncs.js');

const WATER = [
  { element: 'O', x: 0, y: 0, z: 0.1173 },
  { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
  { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
];

/** The single-point example with water, and settings all three exporters carry. */
function waterProject(overrides = {}) {
  const project = JSON.parse(readFileSync('examples/single-point.ncs', 'utf8'));
  project.molecule.coords = WATER;
  project.molecule.geometry = { source: 'imported', file: 'water.xyz', format: 'xyz' };
  for (const node of project.nodes) {
    if (node.type === 'calc') {
      node.settings.basis = '6-31G*';
      node.settings.dispersion = '';
      node.settings.population = '';
      Object.assign(node.settings, overrides);
    }
  }
  return project;
}

const nodeOf = (project) => project.nodes.find((node) => node.type === 'calc');

describe('the window\'s deck export action', () => {
  it('writes the same text the CLI writes for the same block', async () => {
    const project = waterProject();
    const node = nodeOf(project);
    const saved = [];
    const desktop = {
      saveText: vi.fn(async (payload) => {
        saved.push(payload);
        return { canceled: false, path: '/tmp/job.nw' };
      }),
    };
    const notify = vi.fn();
    const result = await exportDeckAction({ desktop, project, node, engine: 'nwchem', notify });

    expect(result).toMatchObject({ path: '/tmp/job.nw', engine: 'nwchem' });
    expect(notify).toHaveBeenCalledWith('Exported /tmp/job.nw');
    expect(desktop.saveText).toHaveBeenCalledTimes(1);
    const [{ suggestedName, text }] = saved;
    expect(suggestedName).toBe(`${node.id}.nw`);
    expect(text).toMatch(/^task dft energy$/m);

    // The CLI's own output, from a project file with the same block.
    const dir = await mkdtemp(path.join(tmpdir(), 'ncs-deck-'));
    const file = path.join(dir, 'water.ncs');
    await writeFile(file, JSON.stringify(project, null, 2), 'utf8');
    const out = path.join(dir, 'cli.nw');
    await run(process.execPath, [cli, 'export-input', file, '--node', node.id, '--engine', 'nwchem', '--out', out], { cwd: root });
    expect(text).toBe(await readFile(out, 'utf8'));
  });

  it('names the file with the format extension and a safe basename', () => {
    expect(deckFilename({ id: 'opt-1' }, { extension: '.nw' })).toBe('opt-1.nw');
    expect(deckFilename({ id: 'opt 1/x' }, { extension: '.inp' })).toBe('opt_1_x.inp');
    expect(deckFilename({ title: 'freq' }, { extension: '.qcin' })).toBe('freq.qcin');
  });

  it('shows the exporter\'s refusal and saves nothing', async () => {
    const project = waterProject({ solvation: true, solvationModel: 'PCM', solvent: 'Water' });
    const desktop = { saveText: vi.fn().mockResolvedValue({ canceled: false, path: '/tmp/job.inp' }) };
    const notify = vi.fn();
    const result = await exportDeckAction({ desktop, project, node: nodeOf(project), engine: 'gamess', notify });

    expect(result.error).toBe('export-refused');
    expect(desktop.saveText).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/requests solvation \(PCM, Water\)/));
  });

  it('refuses a project with no geometry with the CLI\'s code', async () => {
    const project = JSON.parse(readFileSync('examples/single-point.ncs', 'utf8'));
    const desktop = { saveText: vi.fn() };
    const notify = vi.fn();
    const result = await exportDeckAction({ desktop, project, node: nodeOf(project), engine: 'qchem', notify });
    expect(result.error).toBe('export-no-geometry');
    expect(desktop.saveText).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/demo water molecule/));
  });

  it('asks for a block rather than guessing one', async () => {
    const desktop = { saveText: vi.fn() };
    const notify = vi.fn();
    const result = await exportDeckAction({ desktop, project: waterProject(), node: null, engine: 'nwchem', notify });
    expect(result.error).toBe('no-node');
    expect(desktop.saveText).not.toHaveBeenCalled();
  });

  it('rejects an engine the app runs but does not export', async () => {
    const desktop = { saveText: vi.fn() };
    const notify = vi.fn();
    const result = await exportDeckAction({ desktop, project: waterProject(), node: null, engine: 'gaussian', notify });
    expect(result.error).toBe('unknown-engine');
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/not an export engine/));
  });

  it('treats a cancelled dialog as a non-event', async () => {
    const desktop = { saveText: vi.fn().mockResolvedValue({ canceled: true }) };
    const notify = vi.fn();
    const project = waterProject();
    const result = await exportDeckAction({ desktop, project, node: nodeOf(project), engine: 'nwchem', notify });
    expect(result).toEqual({ canceled: true });
    expect(notify).not.toHaveBeenCalled();
  });
});
