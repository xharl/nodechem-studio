import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rmrf } from './helpers/tempCleanup.js';
import {
  NETWORK_FILESYSTEM_MAGIC,
  SUPPORTED_PLATFORMS,
  defaultGaussianExecutablePath,
  gaussianExecutableCheck,
  gaussianExecutableNames,
  gaussianInstallDir,
  isPosix,
  isSupportedPlatform,
  link1For,
  link1Names,
  networkScratchReason,
  scratchConventions,
  scratchDirWarnings,
} from '../electron/runner/gaussianPlatform.js';

/**
 * Platform resolution for a local Gaussian 16 installation.
 *
 * No Gaussian install and no Windows exist here, so these tests pin the
 * conventions with fake directories and injected filesystem probes. The one
 * thing they cannot prove is that a real Windows path parses with `path.win32`
 * (the product runs `path` on the host); the strings that reach the user are
 * pinned instead.
 */

const roots = [];
const onWindows = process.platform === 'win32';

async function tempRoot(prefix = 'gns-platform-') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.map((root) => rmrf(root)));
  roots.length = 0;
});

describe('platform resolution', () => {
  it('names the console runner and Link 1 per platform', () => {
    expect(gaussianExecutableNames('win32')).toEqual(['g16.exe']);
    expect(gaussianExecutableNames('linux')).toEqual(['g16']);
    expect(gaussianExecutableNames('darwin')).toEqual(['g16']);
    expect(link1Names('win32')).toEqual(['l1.exe']);
    expect(link1Names('linux')).toEqual(['l1']);
    expect(link1Names('darwin')).toEqual(['l1']);
  });

  it('suggests the conventional install path per platform', () => {
    expect(defaultGaussianExecutablePath('win32')).toBe('C:\\G16W\\g16.exe');
    expect(defaultGaussianExecutablePath('linux')).toBe('/usr/local/g16/g16');
    expect(defaultGaussianExecutablePath('darwin')).toBe('/usr/local/g16/g16');
  });

  it('classifies supported platforms and treats darwin as POSIX', () => {
    expect(SUPPORTED_PLATFORMS).toEqual(['win32', 'linux', 'darwin']);
    expect(isSupportedPlatform('linux')).toBe(true);
    expect(isSupportedPlatform('darwin')).toBe(true);
    expect(isSupportedPlatform('win32')).toBe(true);
    expect(isSupportedPlatform('freebsd')).toBe(false);
    expect(isPosix('linux')).toBe(true);
    expect(isPosix('darwin')).toBe(true);
    expect(isPosix('win32')).toBe(false);
  });

  it('accepts only the platform console runner and explains the wrong one', () => {
    expect(gaussianExecutableCheck('/opt/g16/g16', 'linux'))
      .toEqual({ label: 'POSIX console executable', ok: true, detail: 'Found g16' });
    expect(gaussianExecutableCheck('/opt/g16/g16', 'darwin').ok).toBe(true);
    expect(gaussianExecutableCheck('C:\\G16W\\g16.exe', 'win32').ok).toBe(true);
    expect(gaussianExecutableCheck('C:\\G16W\\G16.EXE', 'win32').ok).toBe(true);

    // The Windows rejection wording is part of the accepted behaviour.
    expect(gaussianExecutableCheck('C:\\G16W\\g16w.exe', 'win32')).toEqual({
      label: 'Windows console executable',
      ok: false,
      detail: 'Found g16w.exe; g16w.exe is the GUI, not the runner.',
    });
    expect(gaussianExecutableCheck('C:\\G16W\\g16', 'win32')).toEqual({
      label: 'Windows console executable',
      ok: false,
      detail: 'Found g16; g16w.exe is the GUI, not the runner.',
    });

    const wrongBuild = gaussianExecutableCheck('/opt/g16/g16.exe', 'linux');
    expect(wrongBuild.ok).toBe(false);
    expect(wrongBuild.detail).toContain('Windows console runner');
    expect(wrongBuild.detail).toContain('g16');

    const gui = gaussianExecutableCheck('/opt/g16/g16w', 'linux');
    expect(gui.ok).toBe(false);
    expect(gui.detail).toContain('GUI');
  });
});

describe('installation directory', () => {
  it.skipIf(onWindows)('resolves a POSIX symlink to the real installation directory', async () => {
    const root = await tempRoot();
    const install = path.join(root, 'opt', 'g16');
    const bin = path.join(root, 'bin');
    await fsp.mkdir(install, { recursive: true });
    await fsp.mkdir(bin, { recursive: true });
    const real = path.join(install, 'g16');
    await fsp.writeFile(real, '');
    const link = path.join(bin, 'g16');
    await fsp.symlink(real, link);

    expect(gaussianInstallDir(link, 'linux')).toBe(path.resolve(install));
    expect(gaussianInstallDir(link, 'darwin')).toBe(path.resolve(install));
  });

  it('never resolves on Windows, where the selected directory is the install', () => {
    const chosen = path.join(os.tmpdir(), 'G16W', 'g16.exe');
    const sentinel = path.join(os.tmpdir(), 'sentinel', 'g16');
    const resolved = gaussianInstallDir(chosen, 'win32', { realpath: () => sentinel });
    expect(resolved).toBe(path.dirname(chosen));
  });

  it('falls back to the plain directory when realpath fails', () => {
    expect(gaussianInstallDir('/opt/g16/g16', 'linux', { realpath: () => { throw new Error('ENOENT'); } }))
      .toBe('/opt/g16');
    expect(gaussianInstallDir('', 'linux')).toBe('');
  });

  it('finds only the platform Link 1 name', () => {
    const dir = '/opt/g16';
    // The module deliberately uses the host `path` module: at runtime the
    // simulated platform is always the host platform, so the separator follows
    // the machine running the suite (this test runs on the Windows CI runner).
    const onlyPosix = (candidate) => candidate === path.join(dir, 'l1');
    const onlyWindows = (candidate) => candidate === path.join(dir, 'l1.exe');

    expect(link1For(dir, 'linux', { exists: onlyPosix }))
      .toEqual({ path: path.join(dir, 'l1'), exists: true });
    expect(link1For(dir, 'linux', { exists: onlyWindows }))
      .toEqual({ path: path.join(dir, 'l1'), exists: false });
    expect(link1For(dir, 'win32', { exists: onlyWindows }))
      .toEqual({ path: path.join(dir, 'l1.exe'), exists: true });
    expect(link1For(dir, 'win32', { exists: onlyPosix }))
      .toEqual({ path: path.join(dir, 'l1.exe'), exists: false });
  });
});

describe('scratch-directory conventions', () => {
  it('reports the convention for each platform', () => {
    expect(scratchConventions('win32')).toMatchObject({
      envVar: 'GAUSS_SCRDIR',
      example: 'C:\\G16W\\SCRATCH',
    });
    expect(scratchConventions('linux').example).toBe('/scratch/$USER');
    expect(scratchConventions('darwin').example).toBe('/tmp/g16-scratch');
  });

  it('warns about spaces on every platform and never rewrites the path', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      const warning = scratchDirWarnings('C:\\G16W\\my scratch', platform)[0];
      expect(warning.id).toBe('scratch-spaces');
      expect(warning.detail).toContain('C:\\G16W\\my scratch');
      expect(warning.detail).toContain(scratchConventions(platform).example);
    }
  });

  it('detects network mounts by filesystem magic on POSIX', () => {
    const nfs = networkScratchReason('/tmp/gns-scratch', 'linux', { statfs: () => ({ type: 0x6969 }) });
    expect(nfs).toBe('NFS mount');

    // fs.statfs exposes an int32; the unsigned comparison must still match.
    const smb = networkScratchReason('/tmp/gns-scratch', 'linux', {
      statfs: () => ({ type: 0xff534d42 | 0 }),
    });
    expect(smb).toContain('SMB');
    expect(NETWORK_FILESYSTEM_MAGIC[0xfe534d42 >>> 0]).toBe('SMB2');
  });

  it('ignores network filesystem magic on Windows', () => {
    expect(networkScratchReason('C:\\scratch', 'win32', { statfs: () => ({ type: 0x6969 }) })).toBeNull();
    expect(scratchDirWarnings('C:\\scratch', 'win32', { statfs: () => ({ type: 0x6969 }) })).toEqual([]);
  });

  it('recognises network-looking POSIX paths without statfs', () => {
    const noStatfs = { statfs: null };
    expect(networkScratchReason('/net/scratch/will', 'linux', noStatfs)).toContain('network mount');
    expect(networkScratchReason('/mnt/nfs/scratch', 'linux', noStatfs)).toContain('network mount');
    expect(networkScratchReason('/Volumes/nfs-share/scratch', 'darwin', noStatfs)).toContain('network');
    expect(networkScratchReason('/scratch/will', 'linux', noStatfs)).toBeNull();
    expect(networkScratchReason('/tmp/gns-scratch', 'linux', { statfs: () => { throw new Error('ENOENT'); } })).toBeNull();
  });

  it('does not warn when no scratch directory is configured', () => {
    expect(scratchDirWarnings('', 'linux')).toEqual([]);
    expect(scratchDirWarnings('   ', 'win32')).toEqual([]);
  });
});
