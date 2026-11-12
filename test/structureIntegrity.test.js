import { describe, expect, it, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { RunManager } from '../electron/runner/runManager.js';
import {
  INTEGRITY_STATUSES,
  compareStructureIdentities,
  integritySummary,
  integrityVerdict,
  normalizeIntegrityResult,
} from '../src/shared/structureIntegrity.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';
import { rmrf } from './helpers/tempCleanup.js';

/**
 * ADR 0003 §3.6 — the post-run identity gate.
 *
 * The sidecar answer is a real RDKit recording; the comparisons and the policy
 * are exercised here because they decide whether a finished run is refused.
 */

const fixture = JSON.parse(readFileSync(new URL('./fixtures/chem/integrity.json', import.meta.url), 'utf8'));

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rmrf(root)));
});

async function tempDir() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ncs-integrity-'));
  roots.push(base);
  return base;
}

const identity = (overrides = {}) => ({
  formula: 'C2H6O',
  atomCount: 9,
  heavyAtomCount: 3,
  charge: 0,
  connectivityHash: 'AAAA',
  tautomerHash: 'BBBB',
  inchiKey: 'LFQSCWFLJHTTHZ-UHFFFAOYSA-N',
  ...overrides,
});

describe('identity comparison order (ADR 0003 §3.6)', () => {
  it('reports match only when all three questions agree', () => {
    expect(compareStructureIdentities(identity(), identity())).toMatchObject({
      status: 'match',
      comparisons: { composition: true, connectivity: true, tautomer: true, configuration: true },
    });
  });

  it('names the first difference: composition, connectivity, tautomer, configuration', () => {
    expect(compareStructureIdentities(identity(), identity({ formula: 'C2H5O' })).status).toBe('composition-changed');
    expect(compareStructureIdentities(identity(), identity({ connectivityHash: 'CCCC' })).status).toBe('connectivity-changed');
    expect(compareStructureIdentities(identity(), identity({ tautomerHash: 'DDDD' })).status).toBe('tautomer-changed');
    expect(compareStructureIdentities(identity(), identity({ inchiKey: 'ZZZZ' })).status).toBe('stereo-changed');
  });

  it('is inconclusive rather than a pass when no identity was perceived', () => {
    const result = compareStructureIdentities({}, {});
    expect(result.status).toBe('inconclusive');
    expect(INTEGRITY_STATUSES).toContain(result.status);
  });
});

describe('integrity policy', () => {
  const answer = (status, policy = 'warn') => normalizeIntegrityResult({
    protocol: 'nodechem-chem/1',
    op: 'integrity',
    ok: true,
    program: 'RDKit',
    version: '2026.9.1',
    result: { status, reason: null, before: identity(), after: identity(), comparisons: {} },
  }, { policy });

  it('records a composition change as a warning by default', () => {
    const verdict = integrityVerdict(answer('composition-changed'));
    expect(verdict.blocking).toBe(false);
    expect(verdict.status).toBe('warning');
  });

  it('refuses a composition or connectivity change only when the block opted in', () => {
    expect(integrityVerdict(answer('composition-changed', 'fail')).blocking).toBe(true);
    expect(integrityVerdict(answer('connectivity-changed', 'fail')).blocking).toBe(true);
    // Stereo and tautomer changes stay warnings even with refusal on.
    expect(integrityVerdict(answer('stereo-changed', 'fail')).blocking).toBe(false);
    expect(integrityVerdict(answer('tautomer-changed', 'fail')).blocking).toBe(false);
  });

  it('treats inconclusive as a warning, never as a pass', () => {
    const normalized = normalizeIntegrityResult({
      protocol: 'nodechem-chem/1', op: 'integrity', ok: true, program: 'RDKit', version: '2026.9.1',
      result: { status: 'inconclusive', reason: 'open-shell', before: identity(), after: identity() },
    });
    const verdict = integrityVerdict(normalized);
    expect(verdict.status).toBe('warning');
    expect(verdict.blocking).toBe(false);
    expect(verdict.message).toMatch(/not a pass/i);
  });

  it('reads the recorded RDKit answer', () => {
    const normalized = normalizeIntegrityResult(fixture);
    expect(normalized.status).toBe('match');
    expect(normalized.after.formula).toBe('H2O');
    expect(integritySummary(normalized)).toContain('match');
  });
});

describe('integrity through the run manager', () => {
  async function fakeSidecar(base) {
    const answerPath = path.join(base, 'answer.json');
    await fsp.writeFile(answerPath, JSON.stringify(fixture), 'utf8');
    const script = path.join(base, 'fake-integrity.js');
    await fsp.writeFile(script, [
      "const fs = require('node:fs');",
      'let request = "";',
      'process.stdin.on("data", (chunk) => { request += chunk; });',
      'process.stdin.on("end", () => {',
      `  fs.writeFileSync(${JSON.stringify(path.join(base, 'seen.json'))}, request);`,
      `  process.stdout.write(fs.readFileSync(${JSON.stringify(answerPath)}, "utf8"));`,
      '});',
    ].join('\n'), 'utf8');
    return script;
  }

  const atoms = [
    { element: 'O', x: 0, y: 0, z: 0 },
    { element: 'H', x: 0.96, y: 0, z: 0 },
    { element: 'H', x: -0.24, y: 0.93, z: 0 },
  ];

  it('attaches the perceived identity to a finished run', async () => {
    const base = await tempDir();
    const runDir = path.join(base, 'run');
    await fsp.mkdir(runDir, { recursive: true });
    const manager = new RunManager({ runsRoot: path.join(base, 'runs'), emit: () => {} });
    const context = {
      runId: 'r1',
      runDir,
      payload: {
        integrity: {
          policy: 'warn',
          molecule: { title: 'water', charge: 0, multiplicity: 1, atoms },
          executable: process.execPath,
          script: await fakeSidecar(base),
        },
      },
    };
    const result = await manager.integrityForRun(context, { finalGeometry: { atoms } });
    expect(result.status).toBe('match');
    expect(result.after.inchiKey).toBe('XLYOFNOQVPJJNP-UHFFFAOYSA-N');
    const request = JSON.parse(await fsp.readFile(path.join(base, 'seen.json'), 'utf8'));
    expect(request.op).toBe('integrity');
    expect(request.options.finalAtoms).toHaveLength(3);
  });

  it('is inconclusive when there is no sidecar, never a failed run', async () => {
    const base = await tempDir();
    const manager = new RunManager({ runsRoot: path.join(base, 'runs'), emit: () => {} });
    const result = await manager.integrityForRun({
      runId: 'r2',
      runDir: base,
      payload: { integrity: { policy: 'warn', molecule: { atoms }, executable: '', script: '' } },
    }, { finalGeometry: { atoms } });
    expect(result.status).toBe('inconclusive');
    expect(result.reason).toBe('rdkit-missing');
  });

  it('marks a partial geometry not applicable without spawning', async () => {
    const base = await tempDir();
    const manager = new RunManager({ runsRoot: path.join(base, 'runs'), emit: () => {} });
    const result = await manager.integrityForRun({
      runId: 'r3',
      runDir: base,
      payload: { integrity: { policy: 'warn', notApplicable: true, molecule: { atoms }, executable: 'nope' } },
    }, { finalGeometry: { atoms } });
    expect(result.status).toBe('not-applicable');
  });
});

describe('integrity in the report', () => {
  it('prints the status, the before/after formula and the reason', () => {
    const model = buildWorkflowReport({
      id: 'q',
      projectName: 'Integrity',
      status: 'completed',
      tasks: [{ nodeId: 'opt', type: 'calculate', title: 'Optimise', status: 'completed', runId: 'opt' }],
    }, {
      opt: {
        status: 'completed',
        structureIntegrity: {
          status: 'inconclusive',
          reason: 'open-shell',
          reasonText: 'The record is open-shell; bond perception assumes a closed shell.',
          policy: 'warn',
          before: { formula: 'C2H5O' },
          after: { formula: 'C2H5O' },
        },
      },
    });
    const html = workflowReportHtml(model);
    expect(html).toContain('Structure integrity');
    expect(html).toContain('inconclusive');
    expect(html).toContain('open-shell');
    expect(html).toContain('C2H5O');
  });
});
