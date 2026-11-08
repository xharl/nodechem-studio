import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'bin', 'ncs.js');

async function ncs(args, options = {}) {
  try {
    const result = await run(process.execPath, [cli, ...args], { cwd: root, ...options });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
    };
  }
}

/** A project with an IRC path that declares a reactant block, from ts-search. */
async function ircProject(dir) {
  const project = JSON.parse(await readFile(path.join(root, 'examples', 'ts-search.ncs'), 'utf8'));
  const template = project.nodes.find((node) => node.id === 'ts-freq');
  project.nodes.push({
    ...JSON.parse(JSON.stringify(template)),
    id: 'irc-path',
    title: 'IRC',
    settings: { ...template.settings, jobType: 'IRC', referenceNodeId: 'ts-react-opt' },
  });
  project.edges.push({ from: 'ts-freq', to: 'irc-path', type: 'checkpoint', fromPort: 'bottom', toPort: 'top' });
  const file = path.join(dir, 'irc.ncs');
  await writeFile(file, JSON.stringify(project), 'utf8');
  return file;
}

describe('ncs run kinetics section', () => {
  it('adds a kinetics entry for a reaction path without changing existing keys', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ncs-kinetics-'));
    const file = await ircProject(dir);
    const result = await ncs(['run', file, '--out', path.join(dir, 'out'), '--dry-run'], { timeout: 120000 });
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout);

    // Existing keys keep their shape.
    expect(summary.queueId).toBeTruthy();
    expect(summary.status).toBe('completed');
    expect(Array.isArray(summary.runs)).toBe(true);
    expect(summary.runs.some((entry) => entry.nodeId === 'irc-path')).toBe(true);

    expect(Array.isArray(summary.kinetics)).toBe(true);
    const [entry] = summary.kinetics;
    expect(entry.nodeId).toBe('irc-path');
    expect(entry.transitionStateNodeId).toBe('ts-freq');
    expect(entry.reactantNodeId).toBe('ts-react-opt');
    // The example project declares no fragments or coordinates, so the
    // molecularity is unknown and k must stay unprinted — never a guessed unit.
    expect(entry.kText).toBe('not reported');
    expect(entry.units).toBeNull();
    expect(entry.refusal).toMatch(/molecularity/);
  }, 120000);

  it('omits the kinetics key for a project with no reaction path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ncs-nokinetics-'));
    const result = await ncs(['run', path.join(root, 'examples', 'opt-freq.ncs'), '--out', path.join(dir, 'out'), '--dry-run'], { timeout: 120000 });
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(Object.hasOwn(summary, 'kinetics')).toBe(false);
  }, 120000);
});
