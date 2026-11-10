import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executableSeed } from '../src/renderer/runExecutable.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Issue #233: the console must use a detected executable on a fresh profile,
 * but a stored (typed or browsed) path always wins.
 */

const ORCA = '/home/xeyve/.local/bin/orca';
const status = { orca: { ok: true, path: ORCA }, xtb: { ok: false, path: '' } };

describe('run console executable seeding (#233)', () => {
  it('prefills a detected engine and marks the value as detected', () => {
    const seed = executableSeed({ engineId: 'orca', stored: {}, status });
    expect(seed).toEqual({ value: ORCA, detected: true, path: ORCA });
  });

  it('keeps a stored path even when detection reports another one', () => {
    const seed = executableSeed({
      engineId: 'orca',
      stored: { orca: '/opt/orca/orca' },
      status,
    });
    expect(seed.value).toBe('/opt/orca/orca');
    expect(seed.detected).toBe(false);
  });

  it('leaves the field empty and unmarked when the engine is not on PATH', () => {
    expect(executableSeed({ engineId: 'xtb', stored: {}, status }))
      .toEqual({ value: '', detected: false, path: '' });
    expect(executableSeed({ engineId: 'psi4', stored: {}, status: null }))
      .toEqual({ value: '', detected: false, path: '' });
  });

  it('re-seeds when the selected block changes to another engine', () => {
    const psi4 = executableSeed({
      engineId: 'psi4',
      stored: {},
      status: { ...status, psi4: { ok: true, path: '/usr/local/bin/psi4' } },
    });
    expect(psi4.value).toBe('/usr/local/bin/psi4');
    expect(psi4.detected).toBe(true);
  });
});

describe('run console executable wiring (issue 233)', () => {
  it('renders the detected marker and seeds from the cached engineStatus', () => {
    expect(read('index.html')).toContain('id="run-exe-detected"');
    const app = read('src/renderer/app.js');
    expect(app).toContain('state.engineStatus = status');
    expect(app).toContain('syncRunExecutableDetected(engineId)');
    expect(app).toContain('executableSeed({');
  });
});
