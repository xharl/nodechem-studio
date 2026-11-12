import { describe, expect, it, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SidecarRunner, SidecarRunError } from '../electron/runner/sidecarRunner.js';
import { probeChem } from '../electron/runner/chemProbe.js';
import { resolveChemScript, resolveTautomerScript } from '../electron/runner/chemPaths.js';
import { rmrf } from './helpers/tempCleanup.js';

/**
 * ADR 0003 phase 0 — one spawn path for every chemistry sidecar.
 *
 * The fake sidecars here are Node scripts run through `process.execPath`, so
 * the suite is portable: no shebang, no chmod, no POSIX-only assumption.
 */

const roots = [];

async function tempDir() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ncs-chem-'));
  roots.push(base);
  return base;
}

async function fakeScript(base, body) {
  const file = path.join(base, 'fake-sidecar.js');
  await fsp.writeFile(file, body, 'utf8');
  return file;
}

const readStdin = `
let request = '';
process.stdin.on('data', (chunk) => { request += chunk; });
`;

async function expectRejection(promise, check) {
  try {
    await promise;
  } catch (error) {
    check(error);
    return;
  }
  throw new Error('expected the run to fail');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rmrf(root)));
});

describe('SidecarRunner (ADR 0003 §2.1)', () => {
  it('writes one JSON request and returns the one JSON answer, forwarding only stderr', async () => {
    const base = await tempDir();
    const script = await fakeScript(base, `${readStdin}
process.stdin.on('end', () => {
  const parsed = JSON.parse(request);
  process.stderr.write('sidecar progress\\n');
  process.stdout.write(JSON.stringify({ protocol: 'nodechem-chem/1', op: parsed.op, ok: true, echo: parsed.marker }));
});`);
    const seen = [];
    const answer = await new SidecarRunner({ label: 'test sidecar' }).run({
      executable: process.execPath,
      script,
      request: { protocol: 'nodechem-chem/1', op: 'probe', marker: 7 },
      onOutput: (event) => seen.push(event),
    });
    expect(answer).toEqual({ protocol: 'nodechem-chem/1', op: 'probe', ok: true, echo: 7 });
    expect(seen.map((event) => event.stream)).toEqual(['stderr']);
    expect(seen[0].text).toContain('sidecar progress');
  });

  it('returns a refusal object unchanged instead of throwing', async () => {
    const base = await tempDir();
    const script = await fakeScript(base, `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ protocol: 'nodechem-chem/1', op: 'probe', ok: false,
    error: { code: 'rdkit-missing', message: 'no rdkit' } }));
});`);
    const answer = await new SidecarRunner().run({
      executable: process.execPath,
      script,
      request: { protocol: 'nodechem-chem/1', op: 'probe' },
    });
    expect(answer.ok).toBe(false);
    expect(answer.error.code).toBe('rdkit-missing');
  });

  it('refuses output that is not JSON', async () => {
    const base = await tempDir();
    const script = await fakeScript(base, 'process.stdout.write("not json\\n");');
    await expectRejection(new SidecarRunner({ label: 'test sidecar' }).run({
      executable: process.execPath,
      script,
      request: { op: 'probe' },
    }), (error) => {
      expect(error).toBeInstanceOf(SidecarRunError);
      expect(error.code).toBe('no-json');
      expect(error.message).toContain('did not return JSON');
    });
  });

  it('carries the exit code and the last stderr line of a failed process', async () => {
    const base = await tempDir();
    const script = await fakeScript(base, 'process.stderr.write("boom: missing module\\n"); process.exit(3);');
    await expectRejection(new SidecarRunner().run({
      executable: process.execPath,
      script,
      request: { op: 'probe' },
    }), (error) => {
      expect(error).toBeInstanceOf(SidecarRunError);
      expect(error.code).toBe('exit');
      expect(error.exitCode).toBe(3);
      expect(error.message).toContain('boom: missing module');
    });
  });

  it('stops a sidecar at its wall-clock limit', async () => {
    const base = await tempDir();
    const script = await fakeScript(base, 'process.stdin.resume(); setInterval(() => {}, 1000);');
    await expectRejection(new SidecarRunner().run({
      executable: process.execPath,
      script,
      request: { op: 'probe' },
      timeoutMs: 200,
    }), (error) => {
      expect(error).toBeInstanceOf(SidecarRunError);
      expect(error.code).toBe('timeout');
    });
  });

  it('cancels a running sidecar', async () => {
    const base = await tempDir();
    const script = await fakeScript(base, 'process.stdin.resume(); setInterval(() => {}, 1000);');
    const runner = new SidecarRunner();
    const running = runner.run({
      executable: process.execPath,
      script,
      request: { op: 'probe' },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    runner.cancel();
    await expectRejection(running, (error) => {
      expect(error).toBeInstanceOf(SidecarRunError);
      expect(error.code).toBe('cancelled');
    });
  });

  it('reports a missing executable as a spawn failure, not a crash', async () => {
    await expectRejection(new SidecarRunner().run({
      executable: path.join(os.tmpdir(), 'ncs-no-such-interpreter'),
      request: { op: 'probe' },
    }), (error) => {
      expect(error).toBeInstanceOf(SidecarRunError);
      expect(error.code).toBe('spawn');
    });
  });
});

describe('probeChem (ADR 0003 §2.1)', () => {
  const answer = {
    protocol: 'nodechem-chem/1',
    op: 'probe',
    ok: true,
    program: 'RDKit',
    version: '2026.9.1',
    capabilities: { etkdgv4: true, drawSvg: false },
  };

  it('returns the version and the capability flags', async () => {
    const base = await tempDir();
    const script = await fakeScript(base, `
process.stdin.resume();
process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(JSON.stringify(answer))}); });`);
    const result = await probeChem({ executable: process.execPath, script });
    expect(result.ok).toBe(true);
    expect(result.program).toBe('RDKit');
    expect(result.version).toBe('2026.9.1');
    expect(result.capabilities).toEqual({ etkdgv4: true, drawSvg: false });
  });

  it('returns a refusal instead of throwing when RDKit is missing', async () => {
    const base = await tempDir();
    const script = await fakeScript(base, `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ protocol: 'nodechem-chem/1', op: 'probe', ok: false,
    error: { code: 'rdkit-missing', message: 'RDKit is not installed' } }));
  process.exit(2);
});`);
    const result = await probeChem({ executable: process.execPath, script });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('rdkit-missing');
  });

  it('refuses a blank interpreter with its own code', async () => {
    const result = await probeChem({ executable: '', script: '' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('chem-sidecar-missing');
  });
});

describe('shipped script resolution (ADR 0003 §2.5)', () => {
  it('resolves the repository copy in development and resources/ when packaged', () => {
    expect(resolveChemScript({ isPackaged: false, appPath: '/app' }))
      .toBe(path.join('/app', 'scripts', 'nodechem-chem.py'));
    expect(resolveChemScript({ isPackaged: true, resourcesPath: '/opt/app/resources' }))
      .toBe(path.join('/opt/app/resources', 'scripts', 'nodechem-chem.py'));
    expect(resolveTautomerScript({ isPackaged: false, appPath: '/app' }))
      .toBe(path.join('/app', 'scripts', 'tautomer-enumerator.py'));
  });

  it('refuses to guess a root', () => {
    expect(() => resolveChemScript({})).toThrow(/needs appPath/);
  });
});
