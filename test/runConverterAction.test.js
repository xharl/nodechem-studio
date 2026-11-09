import { describe, expect, it, vi } from 'vitest';
import { exportRunFormatAction, parseExportChoice } from '../src/renderer/runConverter.js';

describe('the run-console export action', () => {
  it('reads the format and the spectrum out of one select value', () => {
    expect(parseExportChoice('jcamp:uv')).toEqual({ format: 'jcamp', spectrum: 'uv' });
    expect(parseExportChoice('extxyz')).toEqual({ format: 'extxyz', spectrum: null });
    expect(parseExportChoice('')).toEqual({ format: '', spectrum: null });
  });

  it('explains itself when there is no desktop bridge', async () => {
    const notify = vi.fn();
    const result = await exportRunFormatAction({ desktop: null, runId: 'abc', choice: 'xyz', notify });
    expect(result).toMatchObject({ canceled: true });
    expect(notify).toHaveBeenCalledWith('Open the desktop app to export a converted run.');
  });

  it('asks for a run first', async () => {
    const notify = vi.fn();
    const result = await exportRunFormatAction({
      desktop: { exportRunFormat: vi.fn() }, runId: null, choice: 'xyz', notify,
    });
    expect(result).toMatchObject({ error: 'no-run' });
  });

  it('refuses a format the converters do not write', async () => {
    const notify = vi.fn();
    const result = await exportRunFormatAction({
      desktop: { exportRunFormat: vi.fn() }, runId: 'abc', choice: 'cif', notify,
    });
    expect(result).toMatchObject({ error: 'unknown-format' });
    expect(notify).toHaveBeenCalled();
  });

  it('sends Molden through like any other format (issue 187)', async () => {
    const exportRunFormat = vi.fn().mockResolvedValue({
      canceled: false, path: '/tmp/abc.molden', format: 'molden', bytes: 4096,
    });
    const notify = vi.fn();
    const result = await exportRunFormatAction({
      desktop: { exportRunFormat }, runId: 'abc', choice: 'molden', notify,
    });
    expect(exportRunFormat).toHaveBeenCalledWith('abc', 'molden', null);
    expect(result.path).toBe('/tmp/abc.molden');
  });

  it('passes the spectrum through and reports the written path', async () => {
    const exportRunFormat = vi.fn().mockResolvedValue({
      canceled: false, path: '/tmp/run.jdx', format: 'jcamp', bytes: 120,
    });
    const notify = vi.fn();
    const result = await exportRunFormatAction({
      desktop: { exportRunFormat }, runId: 'r1', choice: 'jcamp:raman', notify,
    });
    expect(exportRunFormat).toHaveBeenCalledWith('r1', 'jcamp', 'raman');
    expect(result.path).toBe('/tmp/run.jdx');
    expect(notify).toHaveBeenCalledWith('Exported jcamp to /tmp/run.jdx');
  });

  it('surfaces a refusal from the main process instead of claiming success', async () => {
    const notify = vi.fn();
    const result = await exportRunFormatAction({
      desktop: {
        exportRunFormat: vi.fn().mockResolvedValue({
          canceled: false,
          error: { message: 'This run is a dry-run fixture: its output is synthetic, so it is not exported.' },
        }),
      },
      runId: 'r1',
      choice: 'xyz',
      notify,
    });
    expect(result.error.message).toMatch(/dry-run fixture/);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('dry-run fixture'));
  });

  it('treats a cancelled dialog as a non-event', async () => {
    const notify = vi.fn();
    const result = await exportRunFormatAction({
      desktop: { exportRunFormat: vi.fn().mockResolvedValue({ canceled: true }) },
      runId: 'r1',
      choice: 'xyz',
      notify,
    });
    expect(result).toEqual({ canceled: true });
    expect(notify).not.toHaveBeenCalled();
  });
});
