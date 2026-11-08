import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { engineOrDefault } from '../../src/shared/engines/index.js';
import { XtbRunner } from './xtbRunner.js';
import {
  SUPPORTED_PLATFORMS,
  gaussianExecutableCheck,
  gaussianInstallDir,
  isPosix,
  link1For,
  scratchConventions,
  scratchDirWarnings,
} from './gaussianPlatform.js';

/**
 * Preflight for one run configuration.
 *
 * Runs in the main process but imports no Electron module, so the platform
 * logic can be exercised by Vitest against fake executables. Callers inject the
 * platform, environment and userData directory, which is also what lets the
 * suite assert the Windows branch is byte-identical to the original checks.
 *
 * Scratch problems are warnings, not failures: the user chose the path and the
 * runner uses it unchanged. A warning must never be reported as a pass either —
 * the renderer prints them as `WARN`, and `ok` is computed from hard checks
 * only.
 */

async function executablePermission(executable) {
  try {
    await fsp.access(executable, fs.constants.X_OK);
    return { ok: true, detail: `${executable} is executable.` };
  } catch (error) {
    return {
      ok: false,
      detail: `${executable} is not executable (${error.code || error.message}); make it executable or select the binary inside the installation directory.`,
    };
  }
}

async function directoryReadable(dir, platform) {
  try {
    const stat = await fsp.stat(dir);
    if (!stat.isDirectory()) return false;
    if (isPosix(platform)) await fsp.access(dir, fs.constants.R_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function preflight(config = {}, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const userData = String(options.userData || '');
  const runsRoot = String(options.runsRoot || path.join(userData, 'runs'));
  const statfs = options.statfs || fs.statfsSync;

  const checks = [];
  const warnings = [];
  const engine = engineOrDefault(config.engine);
  const isXtb = engine.id === 'xtb';
  const isOrca = engine.id === 'orca';
  const isPsi4 = engine.id === 'psi4';
  const dryRun = Boolean(config.dryRun);
  const executable = String(config.executable || '').trim();
  const scratchDir = String(config.scratchDir || '').trim();
  const add = (id, label, ok, detail = '') => checks.push({ id, label, ok, detail });

  add('platform', 'Operating system', SUPPORTED_PLATFORMS.includes(platform),
    `${platform} ${os.release()}`);
  add('architecture', 'Architecture', ['x64', 'arm64'].includes(process.arch), process.arch);

  if (dryRun) {
    add('dry-run', 'Dry-run fixture', true, `No ${engine.label} process will be started.`);
  } else if (isXtb) {
    add('executable', 'xTB executable configured', Boolean(executable), executable || 'Not configured');
    if (executable) {
      try {
        const stat = await fsp.stat(executable);
        add('executable-exists', 'Executable exists', stat.isFile(), executable);
        add('executable-name', 'xTB executable', /^xtb(\.exe)?$/i.test(path.basename(executable)),
          `Found ${path.basename(executable)}`);
        const parameterPath = XtbRunner.parameterPathFor(executable, config.xtbPath);
        add('xtb-parameters', 'xTB parameter files found',
          Boolean(parameterPath) || Boolean(env.XTBPATH),
          parameterPath || env.XTBPATH || 'Set XTBPATH to the xTB share/xtb directory');
      } catch (error) {
        add('executable-exists', 'Executable exists', false, error.message);
      }
    }
  } else if (isOrca) {
    add('executable', 'ORCA executable configured', Boolean(executable), executable || 'Not configured');
    if (executable) {
      try {
        const stat = await fsp.stat(executable);
        add('executable-exists', 'Executable exists', stat.isFile(), executable);
        add('executable-name', 'ORCA executable', /^orca(\.exe)?$/i.test(path.basename(executable)),
          `Found ${path.basename(executable)}`);
        if (isPosix(platform)) {
          const permission = await executablePermission(executable);
          add('executable-permission', 'Console executable is runnable', permission.ok, permission.detail);
        }
        // ORCA's parallel driver must be called by full pathname; it locates
        // its module binaries relative to the driver. The runner passes the
        // selected value unchanged, so warn rather than block a serial setup.
        if (!path.isAbsolute(executable)) {
          warnings.push({
            id: 'orca-full-path',
            label: 'ORCA executable is not an absolute path',
            detail: 'ORCA parallel runs must be started by the full path to the driver (`/opt/orca/orca job.inp`). The runner passes this value unchanged.',
          });
        }
      } catch (error) {
        add('executable-exists', 'Executable exists', false, error.message);
      }
    }
  } else if (isPsi4) {
    add('executable', 'Psi4 executable configured', Boolean(executable), executable || 'Not configured');
    if (executable) {
      try {
        const stat = await fsp.stat(executable);
        add('executable-exists', 'Executable exists', stat.isFile(), executable);
        add('executable-name', 'Psi4 executable', /^psi4(\.exe)?$/i.test(path.basename(executable)),
          `Found ${path.basename(executable)}`);
        if (isPosix(platform)) {
          const permission = await executablePermission(executable);
          add('executable-permission', 'Console executable is runnable', permission.ok, permission.detail);
        }
        // Psi4 finds its basis sets through PSIDATADIR. A conda launcher sets it
        // itself; a bare binary needs it in the environment, so warn rather than
        // block a setup that will work.
        if (!env.PSIDATADIR) {
          warnings.push({
            id: 'psi4-datadir',
            label: 'PSIDATADIR is not set in this environment',
            detail: 'Psi4 needs PSIDATADIR to find its basis sets. A conda installation sets it from its launcher; a bare binary needs it exported.',
          });
        }
      } catch (error) {
        add('executable-exists', 'Executable exists', false, error.message);
      }
    }
  } else {
    add('executable', 'Gaussian executable configured', Boolean(executable), executable || 'Not configured');
    if (executable) {
      try {
        const stat = await fsp.stat(executable);
        add('executable-exists', 'Executable exists', stat.isFile(), executable);

        const name = gaussianExecutableCheck(executable, platform);
        add('executable-name', name.label, name.ok, name.detail);

        if (isPosix(platform)) {
          const permission = await executablePermission(executable);
          add('executable-permission', 'Console executable is runnable', permission.ok, permission.detail);
        }

        // The runner sets GAUSS_EXEDIR to this directory for the child process,
        // so preflight validates exactly what will be handed to Gaussian.
        const installDir = gaussianInstallDir(executable, platform);
        const installDetail = installDir === path.dirname(executable)
          ? installDir
          : `${installDir} (resolved from ${path.dirname(executable)})`;
        add('gauss-exedir', 'Gaussian executable directory readable',
          await directoryReadable(installDir, platform), installDetail);

        const link1 = link1For(installDir, platform);
        add('link1-present', 'Gaussian Link 1 present', link1.exists, link1.path);

        // The runner overrides GAUSS_EXEDIR per run. Say so instead of letting a
        // shell export silently disagree with the executable the user selected.
        if (isPosix(platform) && env.GAUSS_EXEDIR) {
          const configured = String(env.GAUSS_EXEDIR).trim();
          if (configured && path.resolve(configured) !== path.resolve(installDir)) {
            warnings.push({
              id: 'gauss-exedir-override',
              label: 'GAUSS_EXEDIR is set per run',
              detail: `This environment exports GAUSS_EXEDIR=${configured}; NodeChem Studio sets it to ${installDir} for the run, the installation directory of the selected executable.`,
            });
          }
        }
      } catch (error) {
        add('executable-exists', 'Executable exists', false, error.message);
      }
    }
  }

  try {
    await fsp.mkdir(runsRoot, { recursive: true });
    await fsp.access(runsRoot, fs.constants.W_OK);
    add('run-root', 'Run directory writable', true, runsRoot);
  } catch (error) {
    add('run-root', 'Run directory writable', false, error.message);
  }

  if (scratchDir) {
    try {
      await fsp.mkdir(scratchDir, { recursive: true });
      await fsp.access(scratchDir, fs.constants.W_OK);
      add('scratch', 'Scratch directory writable', true, scratchDir);
    } catch (error) {
      add('scratch', 'Scratch directory writable', false, error.message);
    }
  } else {
    add('scratch', 'Scratch directory', true, 'Defaults to a per-run scratch folder.');
  }
  warnings.push(...scratchDirWarnings(scratchDir, platform, { statfs }));

  const cores = os.cpus().length;
  const memoryGb = os.totalmem() / (1024 ** 3);
  add('resources', 'Host resources detected', cores > 0,
    `${cores} logical cores · ${memoryGb.toFixed(1)} GB RAM`);

  return {
    ok: checks.every((check) => check.ok),
    dryRun,
    checks,
    warnings,
    host: {
      platform,
      arch: process.arch,
      release: os.release(),
      cores,
      memoryGb: Number(memoryGb.toFixed(1)),
      userData,
      scratch: scratchConventions(platform),
    },
  };
}
