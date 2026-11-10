import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preflight } from '../electron/runner/preflight.js';
import { GaussianRunner } from '../electron/runner/gaussianRunner.js';

/**
 * Preflight against fake installations.
 *
 * There is no Gaussian install and no Windows host here, so every executable,
 * Link 1 and scratch directory is a temp file. The Windows regression test
 * calls the same function with `platform: 'win32'` and asserts the exact check
 * ids, labels, verdicts and details the pre-issue preflight produced — that pins
 * the branch without needing a Windows machine. What it cannot prove is that a
 * real `C:\G16W` path parses; the product runs on the host `path` module there.
 */

const roots = [];
const onWindows = process.platform === 'win32';

async function tempRoot(prefix = 'gns-preflight-') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  // Canonical paths keep the symlink assertions stable on hosts where /tmp is
  // itself a link (macOS /var -> /private/var).
  const canonical = await fsp.realpath(root);
  roots.push(canonical);
  return canonical;
}

afterEach(async () => {
  await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

/**
 * A fake Gaussian installation: `<root>/g16/g16[.exe]` with Link 1 beside it.
 * Nothing executes it; preflight only stats and names it.
 */
async function fakeInstall(platform, { link1 = true, link1Name, mode = 0o755, executableName } = {}) {
  const root = await tempRoot();
  const install = path.join(root, 'g16');
  await fsp.mkdir(install, { recursive: true });
  const name = executableName || (platform === 'win32' ? 'g16.exe' : 'g16');
  const executable = path.join(install, name);
  await fsp.writeFile(executable, '#!/bin/sh\nexit 0\n');
  await fsp.chmod(executable, mode);
  if (link1) {
    await fsp.writeFile(path.join(install, link1Name || (platform === 'win32' ? 'l1.exe' : 'l1')), '');
  }
  return { root, install, executable };
}

async function runPreflight(config, { platform, env = {}, statfs } = {}) {
  const userData = await tempRoot('gns-preflight-user-');
  const result = await preflight(config, { platform, env, userData, statfs });
  return { result, userData };
}

const check = (result, id) => result.checks.find((entry) => entry.id === id);
const ids = (result) => result.checks.map((entry) => entry.id);

describe('Windows preflight is unchanged', () => {
  const WINDOWS_CHECK_ORDER = [
    'platform',
    'architecture',
    'executable',
    'executable-exists',
    'executable-name',
    'gauss-exedir',
    'link1-present',
    'run-root',
    'scratch',
    'resources',
  ];

  it('emits the original check ids, labels and details for a valid install', async () => {
    const install = await fakeInstall('win32');
    const { result, userData } = await runPreflight({ executable: install.executable }, { platform: 'win32' });

    expect(ids(result)).toEqual(WINDOWS_CHECK_ORDER);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);

    expect(result.checks.slice(2, 7)).toEqual([
      { id: 'executable', label: 'Gaussian executable configured', ok: true, detail: install.executable },
      { id: 'executable-exists', label: 'Executable exists', ok: true, detail: install.executable },
      {
        id: 'executable-name',
        label: 'Windows console executable',
        ok: true,
        detail: 'Found g16.exe; g16w.exe is the GUI, not the runner.',
      },
      { id: 'gauss-exedir', label: 'Gaussian executable directory readable', ok: true, detail: install.install },
      {
        id: 'link1-present',
        label: 'Gaussian Link 1 present',
        ok: true,
        detail: path.join(install.install, 'l1.exe'),
      },
    ]);

    // No POSIX-only permission check leaked onto the Windows path.
    expect(check(result, 'executable-permission')).toBeUndefined();
    expect(result.host).toMatchObject({
      platform: 'win32',
      userData,
      scratch: { envVar: 'GAUSS_SCRDIR', example: 'C:\\G16W\\SCRATCH' },
    });
  });

  it('still refuses the GUI and a POSIX-named runner with the same wording', async () => {
    const root = await tempRoot();
    const install = path.join(root, 'g16');
    await fsp.mkdir(install, { recursive: true });
    const gui = path.join(install, 'g16w.exe');
    await fsp.writeFile(gui, '');
    await fsp.writeFile(path.join(install, 'l1.exe'), '');
    const bare = path.join(install, 'g16');
    await fsp.writeFile(bare, '');

    const { result: guiResult } = await runPreflight({ executable: gui }, { platform: 'win32' });
    expect(check(guiResult, 'executable-name')).toEqual({
      id: 'executable-name',
      label: 'Windows console executable',
      ok: false,
      detail: 'Found g16w.exe; g16w.exe is the GUI, not the runner.',
    });
    expect(guiResult.ok).toBe(false);

    const { result: bareResult } = await runPreflight({ executable: bare }, { platform: 'win32' });
    expect(check(bareResult, 'executable-name').ok).toBe(false);
    expect(check(bareResult, 'executable-name').detail)
      .toBe('Found g16; g16w.exe is the GUI, not the runner.');
  });

  it('still fails when l1.exe is missing and points at the .exe path', async () => {
    const install = await fakeInstall('win32', { link1: false });
    const { result } = await runPreflight({ executable: install.executable }, { platform: 'win32' });

    expect(check(result, 'link1-present')).toEqual({
      id: 'link1-present',
      label: 'Gaussian Link 1 present',
      ok: false,
      detail: path.join(install.install, 'l1.exe'),
    });
    expect(result.ok).toBe(false);
  });

  it('warns about a scratch path with spaces without failing the run', async () => {
    const install = await fakeInstall('win32');
    const scratch = path.join(install.root, 'scratch dir');
    const { result } = await runPreflight({ executable: install.executable, scratchDir: scratch }, { platform: 'win32' });

    expect(check(result, 'scratch')).toMatchObject({ ok: true, detail: scratch });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      expect.objectContaining({ id: 'scratch-spaces' }),
    ]);
  });
});

describe.skipIf(onWindows)('POSIX preflight', () => {
  it('passes for a Linux install with g16 and l1', async () => {
    const install = await fakeInstall('linux');
    const { result } = await runPreflight({ executable: install.executable }, { platform: 'linux' });

    expect(result.ok).toBe(true);
    expect(check(result, 'executable-name')).toMatchObject({
      label: 'POSIX console executable',
      ok: true,
      detail: 'Found g16',
    });
    expect(check(result, 'executable-permission')).toMatchObject({ ok: true });
    expect(check(result, 'gauss-exedir')).toEqual({
      id: 'gauss-exedir',
      label: 'Gaussian executable directory readable',
      ok: true,
      detail: install.install,
    });
    expect(check(result, 'link1-present')).toEqual({
      id: 'link1-present',
      label: 'Gaussian Link 1 present',
      ok: true,
      detail: path.join(install.install, 'l1'),
    });
    expect(result.warnings).toEqual([]);
  });

  it('accepts the same layout on macOS', async () => {
    const install = await fakeInstall('darwin');
    const { result } = await runPreflight({ executable: install.executable }, { platform: 'darwin' });
    expect(result.ok).toBe(true);
    expect(result.host).toMatchObject({ platform: 'darwin', scratch: { example: '/tmp/g16-scratch' } });
  });

  it('does not accept l1.exe as Link 1 on POSIX', async () => {
    const install = await fakeInstall('linux', { link1: false });
    await fsp.writeFile(path.join(install.install, 'l1.exe'), '');
    const { result } = await runPreflight({ executable: install.executable }, { platform: 'linux' });

    expect(check(result, 'link1-present')).toEqual({
      id: 'link1-present',
      label: 'Gaussian Link 1 present',
      ok: false,
      detail: path.join(install.install, 'l1'),
    });
    expect(result.ok).toBe(false);
  });

  it('rejects the Windows executable on POSIX with a specific reason', async () => {
    const install = await fakeInstall('linux', { executableName: 'g16.exe' });
    const { result } = await runPreflight({ executable: install.executable }, { platform: 'linux' });

    const name = check(result, 'executable-name');
    expect(name.ok).toBe(false);
    expect(name.detail).toContain('Found g16.exe');
    expect(name.detail).toContain('POSIX console runner is g16');
    expect(result.ok).toBe(false);
  });

  it('fails a non-executable g16 before it can be spawned', async () => {
    const install = await fakeInstall('linux', { mode: 0o644 });
    const { result } = await runPreflight({ executable: install.executable }, { platform: 'linux' });

    expect(check(result, 'executable-permission')).toMatchObject({ ok: false });
    expect(check(result, 'executable-permission').detail).toContain('not executable');
    expect(result.ok).toBe(false);
  });

  it('validates GAUSS_EXEDIR at the real install behind a symlink', async () => {
    const install = await fakeInstall('linux');
    const bin = path.join(install.root, 'bin');
    await fsp.mkdir(bin, { recursive: true });
    const link = path.join(bin, 'g16');
    await fsp.symlink(install.executable, link);

    const { result } = await runPreflight({ executable: link }, { platform: 'linux' });

    // The directory of the link has no l1; only the resolved install does.
    expect(check(result, 'gauss-exedir')).toEqual({
      id: 'gauss-exedir',
      label: 'Gaussian executable directory readable',
      ok: true,
      detail: `${install.install} (resolved from ${bin})`,
    });
    expect(check(result, 'link1-present')).toMatchObject({
      ok: true,
      detail: path.join(install.install, 'l1'),
    });
    expect(result.ok).toBe(true);
  });

  it('warns when the shell exports a different GAUSS_EXEDIR', async () => {
    const install = await fakeInstall('linux');
    const { result } = await runPreflight(
      { executable: install.executable },
      { platform: 'linux', env: { GAUSS_EXEDIR: '/opt/other-g16' } },
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      expect.objectContaining({ id: 'gauss-exedir-override' }),
    ]);
    expect(result.warnings[0].detail).toContain('/opt/other-g16');
    expect(result.warnings[0].detail).toContain(install.install);
  });

  it('does not warn when GAUSS_EXEDIR already matches the installation', async () => {
    const install = await fakeInstall('linux');
    const { result } = await runPreflight(
      { executable: install.executable },
      { platform: 'linux', env: { GAUSS_EXEDIR: install.install } },
    );
    expect(result.warnings.filter((warning) => warning.id === 'gauss-exedir-override')).toEqual([]);
  });

  it('warns about an NFS scratch mount but still passes preflight', async () => {
    const install = await fakeInstall('linux');
    const scratch = path.join(install.root, 'scratch');
    const { result } = await runPreflight(
      { executable: install.executable, scratchDir: scratch },
      { platform: 'linux', statfs: () => ({ type: 0x6969 }) },
    );

    expect(check(result, 'scratch')).toMatchObject({ ok: true, detail: scratch });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      expect.objectContaining({ id: 'scratch-network' }),
    ]);
  });

  it('recognises an nfs path segment without statfs', async () => {
    const install = await fakeInstall('linux');
    const scratch = path.join(install.root, 'nfs', 'scratch');
    const { result } = await runPreflight(
      { executable: install.executable, scratchDir: scratch },
      { platform: 'linux' },
    );
    expect(result.warnings.map((warning) => warning.id)).toEqual(['scratch-network']);
    expect(result.ok).toBe(true);
  });
});

describe('preflight edge cases', () => {
  it('fails an unsupported platform instead of pretending the runner works', async () => {
    const install = await fakeInstall('linux');
    const { result } = await runPreflight({ executable: install.executable }, { platform: 'freebsd' });
    expect(check(result, 'platform')).toMatchObject({ ok: false });
    expect(check(result, 'platform').detail.startsWith('freebsd ')).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('keeps dry run free of executable checks on every platform', async () => {
    for (const platform of ['win32', 'linux']) {
      const { result } = await runPreflight({ dryRun: true }, { platform });
      expect(result.ok).toBe(true);
      expect(check(result, 'dry-run')).toMatchObject({ ok: true });
      expect(check(result, 'executable')).toBeUndefined();
      expect(result.host.platform).toBe(platform);
    }
  });

  it('reports a scratch directory it cannot create and says why', async () => {
    const install = await fakeInstall('linux');
    const file = path.join(install.root, 'not-a-directory');
    await fsp.writeFile(file, '');
    const { result } = await runPreflight(
      { executable: install.executable, scratchDir: path.join(file, 'scratch') },
      { platform: 'linux' },
    );
    expect(check(result, 'scratch')).toMatchObject({ ok: false });
    expect(check(result, 'scratch').detail).toContain('not-a-directory');
    expect(result.ok).toBe(false);
  });
});

describe.skipIf(onWindows)('PySCF preflight', () => {
  async function fakePython(name, { stdout = '', stderr = '', code = 0 } = {}) {
    const root = await tempRoot('gns-preflight-pyscf-');
    const executable = path.join(root, name);
    await fsp.writeFile(executable, `#!/bin/sh\nprintf '%s' '${stdout}' >&1\nprintf '%s' '${stderr}' >&2\nexit ${code}\n`);
    await fsp.chmod(executable, 0o755);
    return { root, executable, dir: root };
  }

  it('accepts python3 when the interpreter can import PySCF', async () => {
    const python = await fakePython('python3', { stdout: '2.15.0\n' });
    const { result } = await runPreflight(
      { engine: 'pyscf', executable: python.executable },
      { platform: 'linux', env: { PATH: python.dir } },
    );
    expect(result.ok).toBe(true);
    expect(check(result, 'executable')).toMatchObject({
      label: 'Python or pyscf-runner executable configured', ok: true, detail: python.executable,
    });
    expect(check(result, 'executable-name')).toMatchObject({
      label: 'Python interpreter or pyscf-runner', ok: true, detail: 'Found python3',
    });
    expect(check(result, 'pyscf-import')).toEqual({
      id: 'pyscf-import',
      label: 'PySCF importable from this interpreter',
      ok: true,
      detail: 'pyscf 2.15.0',
    });
    expect(result.warnings).toEqual([]);
  });

  it('accepts python3.13 and refuses a non-Python name by name', async () => {
    const py = await fakePython('python3.13', { stdout: '2.15.0\n' });
    const { result } = await runPreflight(
      { engine: 'pyscf', executable: py.executable },
      { platform: 'linux', env: { PATH: py.dir } },
    );
    expect(result.ok).toBe(true);

    const ruby = await fakePython('ruby');
    const { result: refused } = await runPreflight(
      { engine: 'pyscf', executable: ruby.executable },
      { platform: 'linux', env: { PATH: ruby.dir } },
    );
    expect(refused.ok).toBe(false);
    expect(check(refused, 'executable-name')).toEqual({
      id: 'executable-name',
      label: 'Python interpreter or pyscf-runner',
      ok: false,
      detail: 'ruby is neither a python interpreter (python, python3, python3.13) nor pyscf-runner',
    });
  });

  it('fails a Python that cannot import PySCF, naming the module', async () => {
    const python = await fakePython('python3', {
      stderr: "ModuleNotFoundError: No module named 'pyscf'\n", code: 1,
    });
    const { result } = await runPreflight(
      { engine: 'pyscf', executable: python.executable },
      { platform: 'linux', env: { PATH: python.dir } },
    );
    expect(result.ok).toBe(false);
    expect(check(result, 'pyscf-import').ok).toBe(false);
    expect(check(result, 'pyscf-import').detail).toContain("No module named 'pyscf'");
    expect(check(result, 'pyscf-import').detail).toContain('pip install pyscf');
  });

  it('delegates the import probe to pyscf-runner', async () => {
    const runner = await fakePython('pyscf-runner');
    const { result } = await runPreflight(
      { engine: 'pyscf', executable: runner.executable },
      { platform: 'linux', env: { PATH: runner.dir } },
    );
    expect(result.ok).toBe(true);
    expect(check(result, 'pyscf-import')).toMatchObject({
      ok: true,
      detail: expect.stringContaining('Delegated to the pyscf-runner wrapper'),
    });
  });

  it('fails a bare name that is not on PATH, not as an unknown engine', async () => {
    const { result } = await runPreflight(
      { engine: 'pyscf', executable: 'python3' },
      { platform: 'linux', env: { PATH: '/nonexistent' } },
    );
    expect(result.ok).toBe(false);
    expect(check(result, 'executable-exists')).toEqual({
      id: 'executable-exists',
      label: 'Executable exists',
      ok: false,
      detail: 'python3 was not found on PATH or as a file.',
    });
  });
});

describe.skipIf(onWindows)('runner GAUSS_EXEDIR', () => {
  it('spawns with the resolved installation directory and its PATH entry', async () => {
    const install = await fakeInstall('linux');
    // A real child shell that records the environment the runner handed it.
    const script = path.join(install.install, 'g16');
    await fsp.writeFile(script, '#!/bin/sh\nprintf "%s\\n%s\\n%s\\n" "$GAUSS_EXEDIR" "$GAUSS_SCRDIR" "$PATH" > env-capture.txt\n');
    await fsp.chmod(script, 0o755);

    const bin = path.join(install.root, 'bin');
    await fsp.mkdir(bin, { recursive: true });
    const link = path.join(bin, 'g16');
    await fsp.symlink(script, link);

    const cwd = path.join(install.root, 'run');
    const scratch = path.join(install.root, 'scratch');
    await fsp.mkdir(cwd, { recursive: true });

    const result = await new GaussianRunner().run({
      executable: link,
      inputName: 'job.gjf',
      outputName: 'job.out',
      cwd,
      scratchDir: scratch,
    });
    expect(result.exitCode).toBe(0);

    const captured = (await fsp.readFile(path.join(cwd, 'env-capture.txt'), 'utf8')).trim().split('\n');
    expect(captured[0]).toBe(install.install);
    expect(captured[1]).toBe(scratch);
    expect(captured[2].startsWith(`${install.install}${path.delimiter}`)).toBe(true);
  });
});
