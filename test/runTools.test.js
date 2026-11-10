import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPANION_TOOL_IDS,
  companionPlaceholderFor,
  companionSeed,
  companionSeeds,
} from '../src/renderer/runTools.js';
import {
  companionCandidates,
  companionToolStatus,
} from '../electron/runner/companionTools.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Issue #258: every companion field seeds from the same detection answer as
 * the engine field. A stubbed status proves the renderer consumes all four,
 * not just the binaries `engineStatus()` already enumerated.
 */

const HOME = '/home/xeyve/.local/bin';
const STATUS = {
  orca: { ok: true, path: `${HOME}/orca` },
  platform: 'linux',
  tools: {
    crest: { ok: true, path: `${HOME}/crest` },
    obabel: { ok: true, path: `${HOME}/obabel` },
    scorer: { ok: true, path: `${HOME}/aimnet2-scorer` },
    tautomer: { ok: true, path: `${HOME}/python3` },
  },
};

describe('companion tool seeding (#258)', () => {
  it('seeds all four companion fields from one detection answer', () => {
    const seeds = companionSeeds({ status: STATUS });
    expect(Object.keys(seeds).sort()).toEqual([...COMPANION_TOOL_IDS].sort());
    expect(seeds).toEqual({
      crest: { value: `${HOME}/crest`, detected: true, path: `${HOME}/crest` },
      obabel: { value: `${HOME}/obabel`, detected: true, path: `${HOME}/obabel` },
      scorer: { value: `${HOME}/aimnet2-scorer`, detected: true, path: `${HOME}/aimnet2-scorer` },
      tautomer: { value: `${HOME}/python3`, detected: true, path: `${HOME}/python3` },
    });
  });

  it('keeps a stored path even when detection reports another one', () => {
    const seed = companionSeed({
      toolId: 'crest',
      stored: '/opt/crest/crest',
      status: STATUS,
    });
    expect(seed).toEqual({ value: '/opt/crest/crest', detected: false, path: '/opt/crest/crest' });
  });

  it('leaves a missing companion empty so the console can say not found', () => {
    const status = { tools: { crest: { ok: false, path: null } }, platform: 'linux' };
    expect(companionSeed({ toolId: 'crest', stored: '', status }))
      .toEqual({ value: '', detected: false, path: '' });
    expect(companionSeed({ toolId: 'obabel', stored: '', status }))
      .toEqual({ value: '', detected: false, path: '' });
  });
});

describe('companion placeholders are platform-correct (#258)', () => {
  it('shows POSIX paths on Linux and never a C: drive path', () => {
    for (const toolId of COMPANION_TOOL_IDS) {
      const placeholder = companionPlaceholderFor(toolId, 'linux');
      expect(placeholder, toolId).toBeTruthy();
      expect(placeholder, toolId).not.toMatch(/^[A-Za-z]:\\/);
      expect(placeholder, toolId).not.toContain('\\');
    }
    expect(companionPlaceholderFor('crest', 'linux')).toBe('/usr/local/bin/crest');
    expect(companionPlaceholderFor('obabel', 'linux')).toBe('/usr/local/bin/obabel');
  });

  it('shows Windows paths on win32 and never a /usr example', () => {
    for (const toolId of COMPANION_TOOL_IDS) {
      const placeholder = companionPlaceholderFor(toolId, 'win32');
      expect(placeholder, toolId).toContain('\\');
      expect(placeholder, toolId).not.toMatch(/^\/usr/);
      expect(placeholder, toolId).not.toContain('/usr/');
    }
    expect(companionPlaceholderFor('crest', 'win32')).toBe('C:\\crest\\crest.exe');
    expect(companionPlaceholderFor('obabel', 'win32')).toMatch(/obabel\.exe$/);
  });
});

describe('PATH detection names (#258)', () => {
  it('adds .exe only on Windows, and keeps the bare name first', () => {
    expect(companionCandidates(['obabel'], 'linux')).toEqual(['obabel']);
    expect(companionCandidates(['obabel'], 'win32')).toEqual(['obabel', 'obabel.exe']);
    expect(companionCandidates(['crest'], 'darwin')).toEqual(['crest']);
  });

  it('reports crest and obabel from stub PATH entries', () => {
    const files = new Set(['/bin/crest', '/bin/obabel']);
    const access = (candidate) => {
      if (!files.has(candidate)) throw new Error('ENOENT');
    };
    const stat = () => ({ isFile: () => true });
    const status = companionToolStatus({
      platform: 'linux',
      pathValue: ['/missing', '/bin'].join(path.delimiter),
      access,
      stat,
    });
    expect(status.crest).toEqual({ ok: true, path: '/bin/crest' });
    expect(status.obabel).toEqual({ ok: true, path: '/bin/obabel' });
    expect(status.scorer).toEqual({ ok: false, path: null });
  });

  it('finds obabel.exe on a stubbed Windows PATH', () => {
    const files = new Set([path.join('/tools', 'obabel.exe')]);
    const access = (candidate) => {
      if (!files.has(candidate)) throw new Error('ENOENT');
    };
    const stat = () => ({ isFile: () => true });
    const status = companionToolStatus({
      platform: 'win32',
      pathValue: '/tools',
      access,
      stat,
    });
    expect(status.obabel).toEqual({ ok: true, path: path.join('/tools', 'obabel.exe') });
  });
});

describe('run console companion wiring (#258)', () => {
  it('has a value field and a status marker for every companion', () => {
    const html = read('index.html');
    for (const toolId of COMPANION_TOOL_IDS) {
      expect(html, toolId).toContain(`id="run-${toolId}"`);
      expect(html, toolId).toContain(`id="run-${toolId}-detected"`);
      expect(html, toolId).toContain(`data-action="pick-${toolId}"`);
    }
    // No foreign-platform example survives in the static HTML.
    expect(html).not.toContain('placeholder="C:\\\\crest\\\\crest.exe"');
    expect(html).not.toContain('placeholder="C:\\\\obabel\\\\obabel.exe"');
  });

  it('seeds companions from the cached detection answer, next to the engine seed', () => {
    const app = read('src/renderer/app.js');
    expect(app).toContain('syncCompanionExecutables()');
    expect(app).toContain('companionSeed({ toolId, stored: \'\', status })');
    expect(app).toContain('detectedCompanionPath(status, toolId)');
    expect(app).toContain('not found on PATH');
  });

  it('main exposes companions and platform without changing the engine keys', () => {
    const main = read('electron/main.js');
    expect(main).toContain('...engineStatus()');
    expect(main).toContain('tools: companionToolStatus()');
    expect(main).toContain('platform: process.platform');
  });
});
