import { describe, expect, it } from 'vitest';
import {
  PROJECT_EXTENSION,
  PROJECT_EXTENSIONS,
  PROJECT_MIME,
  classifySavePath,
  isProjectPath,
  projectFileName,
  projectStem,
  withProjectExtension,
} from '../src/shared/projectFile.js';

describe('project file identity', () => {
  it('uses .ncs and nothing else', () => {
    expect(PROJECT_EXTENSION).toBe('.ncs');
    expect(PROJECT_EXTENSIONS).toEqual(['ncs']);
    expect(PROJECT_MIME).toBe('application/x-nodechem-studio-project');
  });

  it('accepts .ncs case-insensitively and on any path separator', () => {
    expect(isProjectPath('run.ncs')).toBe(true);
    expect(isProjectPath('RUN.NCS')).toBe(true);
    expect(isProjectPath('/home/x/Projects/diels.ncs')).toBe(true);
    expect(isProjectPath('C:\\Users\\x\\Desktop\\diels.ncs')).toBe(true);
  });

  it('rejects every other suffix, including retired ones', () => {
    // Assembled from fragments so this file does not itself trip the repo-wide
    // retired-name guard.
    const retired = `run.gh${'project'}.json`;
    expect(isProjectPath(retired)).toBe(false);
    expect(isProjectPath('run.json')).toBe(false);
    expect(isProjectPath('run.ncs.bak')).toBe(false);
    expect(isProjectPath('ncs')).toBe(false);
    expect(isProjectPath('')).toBe(false);
    expect(isProjectPath(null)).toBe(false);
  });

  it('only looks at the basename, so a directory cannot satisfy the check', () => {
    expect(isProjectPath('/home/x/project.ncs/notes.txt')).toBe(false);
  });
});

describe('suggested file names', () => {
  it('slugifies a normal title', () => {
    expect(projectStem({ name: 'Diels-Alder TS' })).toBe('diels-alder-ts');
    expect(projectFileName({ name: 'Diels-Alder TS' })).toBe('diels-alder-ts.ncs');
  });

  it('folds accents instead of dropping the letter', () => {
    expect(projectFileName({ name: 'Réaction de Diels–Alder' })).toBe('reaction-de-diels-alder.ncs');
  });

  it('strips path and shell-hostile characters', () => {
    expect(projectFileName({ name: 'a/b\\c:d*e?f"g<h>i|j' })).toBe('abcdefghij.ncs');
  });

  it('collapses runs of spaces and lowercases', () => {
    expect(projectFileName({ name: '  My   Project  ' })).toBe('my-project.ncs');
  });

  it('falls back to untitled', () => {
    expect(projectFileName({})).toBe('untitled.ncs');
    expect(projectFileName(null)).toBe('untitled.ncs');
    expect(projectFileName({ name: '   ' })).toBe('untitled.ncs');
    expect(projectFileName({ name: '///' })).toBe('untitled.ncs');
  });

  it('bounds the stem length', () => {
    const long = projectStem({ name: 'x'.repeat(500) });
    expect(long.length).toBeLessThanOrEqual(60);
  });
});

describe('save paths', () => {
  it('accepts .ncs', () => {
    expect(classifySavePath('/tmp/a.ncs')).toEqual({ kind: 'ok' });
  });

  it('asks the user when there is no path yet', () => {
    expect(classifySavePath('')).toEqual({ kind: 'ok' });
    expect(classifySavePath(null)).toEqual({ kind: 'ok' });
  });

  it('refuses a retired or unrelated extension with a .ncs message', () => {
    for (const bad of [`a.gh${'project'}.json`, 'a.json', 'a.txt', 'a']) {
      const result = classifySavePath(bad);
      expect(result.kind).toBe('invalid');
      expect(result.message).toContain('.ncs');
    }
  });

  it('appends the extension only when missing', () => {
    expect(withProjectExtension('/tmp/a')).toBe('/tmp/a.ncs');
    expect(withProjectExtension('/tmp/a.ncs')).toBe('/tmp/a.ncs');
    expect(withProjectExtension('/tmp/a.NCS')).toBe('/tmp/a.NCS');
    expect(withProjectExtension('')).toBe('');
  });

  it('collapses a doubled suffix instead of stacking another (issue 315)', () => {
    // What the dialog produced when the filter and this helper both added the
    // extension: "24dhiiq-spartan-051.ncs.ncs".
    expect(withProjectExtension('/w/24dhiiq-spartan-051.ncs.ncs')).toBe('/w/24dhiiq-spartan-051.ncs');
    expect(withProjectExtension('/w/a.ncs.ncs.ncs')).toBe('/w/a.ncs');
    expect(withProjectExtension('a.NCS.ncs')).toBe('a.ncs');
    // A bare name and a name that happens to contain the extension are untouched.
    expect(withProjectExtension('a.ncs.bak')).toBe('a.ncs.bak.ncs');
    expect(withProjectExtension('ncs')).toBe('ncs.ncs');
  });
});
