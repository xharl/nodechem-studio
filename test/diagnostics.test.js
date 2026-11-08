import { describe, it, expect } from 'vitest';
import {
  MAX_MARKDOWN_BYTES,
  MAX_RUNS,
  NOT_RECORDED,
  buildDiagnostics,
} from '../src/shared/diagnostics.js';

/**
 * The diagnostics bundle is attached to public bug reports, so the tests are
 * about what must never appear in it (paths, identities, credentials) and what
 * must never be invented (missing fields and counts). Determinism matters too:
 * a report that changes between two clicks cannot be diffed or trusted.
 */

const AT = '2026-11-07T12:00:00.000Z';

function build(overrides = {}) {
  return buildDiagnostics({ generatedAt: AT, ...overrides });
}

function allKeys(value, acc = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => allKeys(item, acc));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      acc.push(key);
      allKeys(child, acc);
    }
  }
  return acc;
}

describe('diagnostics — redaction', () => {
  it('removes POSIX and Windows home directories from every field', () => {
    const result = build({
      app: { version: '0.2.1', commit: 'abc1234' },
      platform: {
        os: 'Linux',
        release: '7.0.0',
        arch: 'x64',
        home: '/home/x',
        userData: '/home/x/.config/nodechem-studio',
      },
      project: {
        name: 'Repro in /home/x/projects/da',
        blockCount: 3,
        edgeCount: 2,
        validationErrors: 0,
        defaults: { engine: 'gaussian', method: 'B3LYP', basis: '6-31G(d)' },
      },
      runs: [{
        id: 'run-1',
        status: 'failed',
        engine: 'gaussian',
        title: 'Opt from /home/x/projects/da/input.gjf',
        startedAt: AT,
        finishedAt: null,
        gates: { overall: 'fail' },
        provenance: { kind: 'calculation' },
        error: 'Executable missing: C:\\Users\\x\\G16W\\g16.exe',
      }],
    });

    expect(result.markdown).not.toContain('/home/x');
    expect(result.markdown).not.toContain('C:\\Users\\x');
    expect(result.markdown).not.toContain('x\\G16W');
    expect(result.markdown).toContain('~');
    expect(JSON.stringify(result.json)).not.toContain('/home/x');
    expect(result.json.runs[0].error).not.toContain('C:');
    expect(result.json.runs[0].error).not.toContain('Users');
  });

  it('strips home-style usernames even when the caller did not report a home', () => {
    const result = build({
      runs: [{
        id: 'r1',
        title: 'Opened /home/stranger/secret/project.ncs and C:\\Users\\stranger\\project.ncs',
        error: 'Could not read /var/tmp/stranger/job.log or \\\\fileserver\\share\\stranger\\job.log',
      }],
    });

    expect(result.markdown).not.toContain('stranger');
    expect(result.markdown).not.toContain('fileserver');
    expect(result.markdown).toContain('~/secret/project.ncs');
    expect(result.markdown).toContain('~\\project.ncs');
    expect(result.markdown).toContain('<path>/job.log');
  });

  it('leaves no absolute path in the markdown or the JSON', () => {
    const result = build({
      platform: { os: 'Windows', release: '10.0.22631', arch: 'x64' },
      project: {
        name: 'C:\\Users\\x\\Documents\\repro.ncs',
        blockCount: 1,
        edgeCount: 0,
        validationErrors: 1,
      },
      runs: [{
        id: 'r1',
        status: 'failed',
        title: 'C:\\Users\\x\\scratch',
        error: 'C:\\Program Files\\Gaussian16\\g16.exe',
      }],
    });

    const corpus = `${result.markdown}\n${JSON.stringify(result.json)}`;
    expect(corpus).not.toMatch(/(^|\s)\/(?:home|Users|opt|usr|var|tmp|etc)\//m);
    expect(corpus).not.toMatch(/[A-Za-z]:[\\/]/);
  });

  it('masks credential-shaped strings and addresses in wrapped error messages', () => {
    const result = build({
      runs: [{
        id: 'r1',
        error: 'failed with Bearer abcdefghijklmnop API_TOKEN=abcdef1234567890 from 192.168.1.20 and 2001:db8::1',
      }],
    });

    expect(result.markdown).not.toContain('abcdefghijklmnop');
    expect(result.markdown).not.toContain('abcdef1234567890');
    expect(result.markdown).not.toContain('192.168.1.20');
    expect(result.markdown).not.toContain('2001:db8::1');
    expect(result.markdown).toContain('<redacted>');
    expect(result.markdown).toContain('<address>');
  });

  it('does not mistake a four-part version for a network address', () => {
    const result = build({
      app: { version: '0.2.1', chrome: '140.0.0.0', electron: '45.2.3', node: '22.19.0' },
    });

    expect(result.markdown).toContain('Chrome: 140.0.0.0');
    expect(result.markdown).toContain('Electron: 45.2.3');
    expect(result.markdown).not.toContain('Chrome: <address>');
    expect(result.json.app.chrome).toBe('140.0.0.0');
  });

  it('masks a bare credential name as well as a prefixed one', () => {
    // Regression: the first implementation only matched names whose suffix was
    // KEY/TOKEN/…, so `token=secretvalue` (no prefix) passed through untouched.
    const result = build({
      runs: [{
        id: 'r1',
        error: 'token=abc123SECRET password: hunter2 API_TOKEN=xyz789 AUTH=zzz',
      }],
    });

    for (const leaked of ['abc123SECRET', 'hunter2', 'xyz789', 'zzz']) {
      expect(result.markdown).not.toContain(leaked);
    }
    expect(result.markdown).toContain('token=<redacted>');
    expect(result.markdown).toContain('password=<redacted>');
    expect(result.markdown).toContain('API_TOKEN=<redacted>');
  });
});

describe('diagnostics — honest absence', () => {
  it('renders not recorded instead of inventing values or zeros', () => {
    const result = build({});

    expect(result.markdown).toContain(`Version: ${NOT_RECORDED}`);
    expect(result.markdown).toContain(`Commit: ${NOT_RECORDED}`);
    expect(result.markdown).toContain(`Runs: ${NOT_RECORDED}`);
    expect(result.markdown).toContain(`Project summary: ${NOT_RECORDED}`);
    expect(result.markdown).toContain(`Home folder: ${NOT_RECORDED}`);
    expect(result.json.app.version).toBeNull();
    expect(result.json.project).toBeNull();
    expect(result.json.runs).toBeNull();
  });

  it('keeps a measured zero and an empty run list distinct from unknown', () => {
    const result = build({
      project: { blockCount: 0, edgeCount: 0, validationErrors: 0, defaults: {} },
      runs: [],
    });

    expect(result.markdown).toContain('Blocks: 0');
    expect(result.markdown).toContain('Validation errors: 0');
    expect(result.markdown).toContain('No runs have been recorded.');
    expect(result.json.runs).toEqual([]);
  });

  it('does not invent counts inside a partially recorded project', () => {
    const result = build({ project: { name: 'Partial' } });

    expect(result.markdown).toContain(`Blocks: ${NOT_RECORDED}`);
    expect(result.markdown).toContain(`Connections: ${NOT_RECORDED}`);
    expect(result.markdown).toContain(`Validation errors: ${NOT_RECORDED}`);
    expect(result.json.project.blockCount).toBeNull();
  });
});

describe('diagnostics — caps and determinism', () => {
  it('includes at most ten runs and says how many older runs were left out', () => {
    const runs = Array.from({ length: 12 }, (_unused, index) => ({
      id: `case-${String(index).padStart(2, '0')}`,
      status: 'completed',
      engine: 'gaussian',
      title: `Run ${index}`,
      startedAt: AT,
      finishedAt: AT,
      gates: { overall: 'pass' },
    }));
    const result = build({ runs });

    expect(MAX_RUNS).toBe(10);
    expect(result.json.runs).toHaveLength(10);
    expect(result.json.truncation.runsOmitted).toBe(2);
    expect(result.markdown).toContain('Showing 10 of 12 recorded runs');
    expect(result.markdown).toContain('2 older runs are not included');
    expect(result.markdown).toContain('case-00');
    expect(result.markdown).toContain('case-09');
    expect(result.markdown).not.toContain('case-10');
    expect(result.markdown).not.toContain('case-11');
  });

  it('keeps the markdown within the 64 KB cap and flags a cut', () => {
    const long = 'x'.repeat(240);
    const runs = Array.from({ length: 10 }, (_unused, index) => ({
      id: `case-${index}`,
      status: 'failed',
      title: long,
      error: long,
    }));
    const result = build({
      project: { name: long.repeat(10), blockCount: 1, edgeCount: 0, validationErrors: 1 },
      runs,
    });

    expect(new TextEncoder().encode(result.markdown).length).toBeLessThanOrEqual(MAX_MARKDOWN_BYTES);
    expect(result.json.truncation.markdownTruncated).toBe(false);
  });

  it('cuts an oversized report at the limit and says how many bytes were dropped', () => {
    // The engine table is the one unbounded section; use it to reach the cap
    // without inventing fields the real caller would never send.
    const engines = Array.from({ length: 1200 }, (_unused, index) => ({
      id: `engine-${index}`,
      label: `Engine ${index} ${'x'.repeat(60)}`,
      inputExtension: '.gjf',
      outputExtension: '.out',
      restartArtifact: 'chk',
    }));
    const result = build({ engines });

    expect(new TextEncoder().encode(result.markdown).length).toBeLessThanOrEqual(MAX_MARKDOWN_BYTES);
    expect(result.json.truncation.markdownTruncated).toBe(true);
    expect(result.markdown).toContain('Report truncated');
    expect(result.markdown).toMatch(/\d+ bytes were omitted/);
  });

  it('produces identical output for identical input', () => {
    const input = {
      app: { version: '0.2.1', commit: 'abc1234' },
      platform: { os: 'Linux', release: '7.0.0', arch: 'x64', home: '/home/x' },
      engines: [{ id: 'gaussian', label: 'Gaussian 16', inputExtension: '.gjf' }],
      project: {
        name: 'Deterministic',
        blockCount: 2,
        edgeCount: 1,
        validationErrors: 0,
        defaults: { engine: 'gaussian', method: 'B3LYP', basis: '6-31G(d)' },
      },
      runs: [{ id: 'r1', status: 'completed', engine: 'gaussian', startedAt: AT, gates: { overall: 'pass' } }],
      generatedAt: AT,
    };

    expect(buildDiagnostics(input)).toEqual(buildDiagnostics(input));
    expect(buildDiagnostics({ ...input, generatedAt: '2026-11-08T00:00:00.000Z' }).markdown)
      .not.toBe(buildDiagnostics(input).markdown);
  });
});

describe('diagnostics — data that must not be collected', () => {
  it('has no env, hostname, address or token keys', () => {
    const result = build({
      app: { version: '0.2.1' },
      platform: { os: 'Linux', release: '7.0.0', arch: 'x64', home: '/home/x' },
      project: { name: 'P', blockCount: 1, edgeCount: 0, validationErrors: 0 },
      runs: [{ id: 'r1', status: 'completed', engine: 'gaussian' }],
    });
    const forbidden = new Set(['env', 'environment', 'hostname', 'host', 'ip', 'address', 'token', 'tokenid']);
    const offenders = allKeys(result.json).filter((key) => forbidden.has(key.toLowerCase()));

    expect(offenders).toEqual([]);
    expect(result.markdown).not.toMatch(/hostname|environment|process\.env/i);
    const dataKeys = allKeys(result.json).map((key) => key.toLowerCase());
    expect(dataKeys.some((key) => /molecule|coord|atom/.test(key))).toBe(false);
  });
});
