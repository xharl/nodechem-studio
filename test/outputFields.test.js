import { describe, it, expect } from 'vitest';
import {
  defaultOutputPath,
  isOutputKind,
  outputOf,
  outputPathError,
} from '../src/renderer/outputFields.js';

describe('output kind defaults', () => {
  it('knows the four kinds and their default paths', () => {
    expect(isOutputKind('html')).toBe(true);
    expect(isOutputKind('pdf')).toBe(false);
    expect(defaultOutputPath('html')).toBe('reports/report.html');
    expect(defaultOutputPath('csv')).toBe('reports/dataset.csv');
    expect(defaultOutputPath('json')).toBe('reports/dataset.json');
    expect(defaultOutputPath('zip')).toBe('project.zip');
  });
});

describe('outputPathError', () => {
  it('accepts a relative path with the matching extension', () => {
    expect(outputPathError('reports/barrier.html', 'html')).toBe('');
    expect(outputPathError('tables/family.csv', 'csv')).toBe('');
    expect(outputPathError('project.zip', 'zip')).toBe('');
  });

  it('rejects an absolute path, traversal and a wrong extension', () => {
    expect(outputPathError('/tmp/report.html', 'html')).toMatch(/relative/);
    expect(outputPathError('../report.html', 'html')).toMatch(/relative|\.\./);
    expect(outputPathError('reports/report.csv', 'html')).toMatch(/\.html/);
    expect(outputPathError('', 'html')).toMatch(/Enter a path/);
  });
});

describe('outputOf', () => {
  it('keeps a v1 bundle-only output meaning the zip it named', () => {
    expect(outputOf({ output: { bundle: 'old.zip', manifest: false } })).toEqual({
      kind: 'zip',
      path: 'old.zip',
      include: 'records',
      bundle: 'old.zip',
      manifest: false,
      notes: '',
    });
  });

  it('normalizes an RFC 0001 output block', () => {
    expect(outputOf({
      output: { kind: 'csv', path: 'reports/family.csv', include: 'record', bundle: 'project.zip', manifest: true },
    })).toMatchObject({
      kind: 'csv',
      path: 'reports/family.csv',
      include: 'record',
      manifest: true,
    });
  });
});
