import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { GaussianRunner } from './gaussianRunner.js';
import { XtbRunner } from './xtbRunner.js';
import { OrcaRunner } from './orcaRunner.js';
import { Psi4Runner } from './psi4Runner.js';
import { PyscfRunner } from './pyscfRunner.js';
import { stageCheckpoint } from './checkpoint.js';
import { isFile, sha256File, sha256Text } from './hashing.js';
import { evaluateGates, outputEvidence } from '../../src/shared/gaussianOutput.js';
import { makeFixtureOutput } from '../../src/shared/fixtureOutput.js';
import { methodBlockFor } from '../../src/shared/gaussianInput.js';
import { ecpFromInput } from '../../src/shared/ecp.js';
import { normaliseAppInfo, provenanceKindFor } from '../../src/shared/provenance.js';
import { engineFor, DEFAULT_ENGINE_ID } from '../../src/shared/engines/index.js';
import { withRunProvenance } from './runProvenance.js';
import { xtbSolvationFromArgv, parseXtbGeometry } from '../../src/shared/engines/xtb.js';
import { normalizeValidityContext, runValidityChecks } from '../../src/shared/validityChecks.js';
import { cacheFromParsed, writeCache } from '../../src/shared/cache.js';
import { wavefunctionRecord } from '../../src/shared/wavefunction.js';
import { SidecarRunner } from './sidecarRunner.js';
import {
  INTEGRITY_INCONCLUSIVE_REASONS,
  integrityRequest,
  integrityVerdict,
  normalizeIntegrityResult,
} from '../../src/shared/structureIntegrity.js';

const SAFE_INPUT = /^[A-Za-z0-9._-]+\.(gjf|com)$/i;

/** The wavefunction files a run folder may carry (#334). */
const WAVEFUNCTION_FILES = /\.(fchk|fch|molden|wfn|wfx|cube)$/i;

/** A cube can be tens of megabytes; past this the record keeps the name and no parse. */
const WAVEFUNCTION_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The wavefunction block for a run folder, or null when it carries none.
 *
 * Issue 334: `wavefunctionRecord()` was only ever called from tests, so every
 * run.json in a shipped build had no `wavefunction` key and the dataset export's
 * checkpoint columns could never be filled. The runner calls it here, once, after
 * the engine has finished and its files are in the folder.
 */
export async function wavefunctionForRun(runDir) {
  let names;
  try {
    names = await fsp.readdir(runDir);
  } catch {
    return null;
  }
  const files = [];
  for (const name of names.filter((entry) => WAVEFUNCTION_FILES.test(entry)).sort()) {
    const target = path.join(runDir, name);
    try {
      const stats = await fsp.stat(target);
      if (!stats.isFile() || stats.size > WAVEFUNCTION_MAX_BYTES) continue;
      const text = await fsp.readFile(target, 'utf8');
      files.push({ text, filename: name });
    } catch {
      // A file that cannot be read is simply not attached.
    }
  }
  if (files.length === 0) return null;
  try {
    return wavefunctionRecord(files);
  } catch {
    // Two checkpoints, or a file that is not really a wavefunction: no block.
    return null;
  }
}

const SAFE_OUTPUT = /^[A-Za-z0-9._-]+\.(out|log)$/i;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
/**
 * Refuse a launch whose scratch filesystem cannot hold an SCF (issue 283).
 * One GiB is the floor, not an estimate of the job: it is small enough that no
 * healthy disk trips it and large enough that a tmpfs already full of a crashed
 * job is caught before an hour of CPU is spent.
 */
const MIN_SCRATCH_FREE_BYTES = 1024 ** 3;

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'an unknown amount of space';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled >= 100 || unit === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`;
}

/**
 * Free space where the engine will write its scratch.
 *
 * `null` when the platform cannot answer: a missing measurement must never be
 * turned into a pass or a refusal, so the caller records what it got.
 */
async function scratchSpaceFor(dir) {
  try {
    const stat = await fsp.statfs(dir);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes)) return { dir, freeBytes: null, totalBytes: null };
    return { dir, freeBytes, totalBytes };
  } catch {
    return { dir, freeBytes: null, totalBytes: null };
  }
}

function runIdFor(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * The conformer a run was built on (issue #30). Bounded and coerced here for
 * the same reason every other renderer-supplied value is: run.json is written
 * by the main process and must not be shaped by an untrusted payload.
 */
function conformerRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = (value, max) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  const id = text(raw.id, 24);
  if (!id) return null;
  return {
    nodeId: text(raw.nodeId, 64) || null,
    title: text(raw.title, 120),
    generator: text(raw.generator, 24),
    id,
    relativeKcal: number(raw.relativeKcal),
    population: number(raw.population),
    protomer: text(raw.protomer, 40),
    // Issue #226: which tautomer candidate this run started from, when the
    // ensemble enumerates them. Absent from a conformer run record.
    ...(raw.tautomer === undefined && raw.produces === undefined ? {} : {
      tautomer: text(raw.tautomer, 16),
      ...(raw.produces === 'tautomers' ? { produces: 'tautomers' } : {}),
    }),
    spreadKcal: number(raw.spreadKcal),
  };
}

export class RunManager {
  constructor({ runsRoot, emit, createRunner, appInfo }) {
    this.runsRoot = runsRoot;
    this.emitExternal = emit;
    this.createRunner = createRunner || null;
    // Version comes from the packaged package.json; commit is injected by the
    // build/launch environment. Neither is read from git or the network.
    this.appInfo = normaliseAppInfo(appInfo);
    this.active = new Map();
    this.listeners = new Set();
  }

  /** Build the process runner for an engine. Tests inject a fake one. */
  runnerFor(engine) {
    if (this.createRunner) return this.createRunner(engine);
    if (engine.id === 'xtb') return new XtbRunner();
    if (engine.id === 'gaussian') return new GaussianRunner();
    if (engine.id === 'orca') return new OrcaRunner();
    if (engine.id === 'psi4') return new Psi4Runner();
    if (engine.id === 'pyscf') return new PyscfRunner();
    // Any engine registered without a runner would otherwise fall through to
    // the Gaussian runner, which would launch g16 on another program's input
    // and print a parseable-looking failure. Refuse by name instead.
    throw new Error(`${engine.label || engine.id} has no runner: execution is not wired for that engine.`);
  }

  /** Internal subscribers (the queue) receive the same events as the renderer. */
  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    this.emitExternal?.(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A subscriber bug must not break the run.
      }
    }
  }

  async start(payload = {}) {
    const engine = engineFor(payload.engine ?? DEFAULT_ENGINE_ID);
    const inputText = String(payload.inputText || '');
    if (!inputText.trim()) throw new Error(`The run has no ${engine.label} input text.`);
    if (Buffer.byteLength(inputText, 'utf8') > MAX_INPUT_BYTES) throw new Error(`${engine.label} input is larger than 2 MiB.`);
    if (!engine.acceptsInputName(payload.inputName || '')) {
      throw new Error(`Input name must be a safe ${engine.capabilities.inputExtension} basename for ${engine.label}.`);
    }
    if (!engine.acceptsOutputName(payload.outputName || '')) {
      throw new Error(`Output name must be a safe ${engine.capabilities.outputExtension} basename.`);
    }

    const dryRun = Boolean(payload.dryRun);
    // Issue 177: the task's wall-clock limit, in whole seconds. Zero means no
    // limit — the queue always sends one; a direct `runTask` from the UI may not.
    const timeoutSeconds = Number.isInteger(Number(payload.timeoutSeconds)) && Number(payload.timeoutSeconds) > 0
      ? Number(payload.timeoutSeconds)
      : 0;
    if (!dryRun) {
      if (!payload.executable) throw new Error(`Choose the ${engine.label} executable before running without dry-run.`);
      const stat = await fsp.stat(payload.executable).catch(() => null);
      if (!stat?.isFile()) throw new Error(`${engine.label} executable not found: ${payload.executable}`);
    }

    const runId = runIdFor();
    const runDir = path.join(this.runsRoot, runId);
    const scratchDir = String(payload.scratchDir || '').trim() || path.join(runDir, 'scratch');
    await fsp.mkdir(runDir, { recursive: true });
    await fsp.mkdir(scratchDir, { recursive: true });
    // Issue 283: a run that dies of ENOSPC wastes an hour of SCF and blames the
    // engine. Check the space before the launch, and keep what was measured so
    // the record can say it afterwards.
    const scratch = await scratchSpaceFor(scratchDir);
    if (!dryRun && scratch.freeBytes !== null && scratch.freeBytes < MIN_SCRATCH_FREE_BYTES) {
      throw new Error(
        `Scratch directory ${scratchDir} has ${formatBytes(scratch.freeBytes)} free, below the `
        + `${formatBytes(MIN_SCRATCH_FREE_BYTES)} minimum: ${engine.label} writes its integrals and `
        + 'DIIS files there and would stop with "No space left on device". Point the scratch '
        + 'directory at a filesystem with more room (Settings → Tools → Scratch directory), or '
        + 'free space on this one.',
      );
    }
    const inputPath = path.join(runDir, payload.inputName);
    await fsp.writeFile(inputPath, inputText, 'utf8');
    // Hash the bytes that are actually on disk, not the string we asked for.
    const inputSha256 = await sha256File(inputPath);
    const inputBytes = Buffer.byteLength(inputText, 'utf8');

    let checkpointHandoff = null;
    let stageError = null;
    if (payload.checkpointHandoff) {
      try {
        checkpointHandoff = await stageCheckpoint({
          sourceRunDir: payload.checkpointHandoff.sourceRunDir,
          checkpoint: payload.checkpointHandoff.checkpoint,
          sourceRunId: payload.checkpointHandoff.sourceRunId || null,
          targetDir: runDir,
          dryRun,
          engine: engine.id,
        });
      } catch (error) {
        stageError = error instanceof Error ? error.message : String(error);
      }
    }

    const settings = payload.settings && typeof payload.settings === 'object' ? payload.settings : null;
    const ecp = engine.id === 'gaussian' ? ecpFromInput(inputText) : null;
    const argv = Array.isArray(payload.argv) ? payload.argv.map(String) : null;
    const jobType = settings ? String(settings.jobType || '').trim() || null : null;
    // Issue #39: the method block belongs to the engine that ran. A Gaussian
    // block is byte-identical to `methodBlockFor`; xTB records its Hamiltonian
    // and the argv it was invoked with instead of a Gaussian route.
    const method = settings
      ? (typeof engine.methodBlock === 'function'
        ? engine.methodBlock(settings, { argv, jobType })
        : methodBlockFor(settings))
      : null;

    const record = withRunProvenance({
      // The published contract this record conforms to (schemas/run-record.v1.schema.json).
      // Additive: records written before it are still read without the field.
      schemaVersion: 1,
      id: runId,
      status: stageError ? 'failed' : 'running',
      engine: engine.id,
      argv,
      dryRun,
      title: String(payload.title || `${engine.label} task`),
      inputName: payload.inputName,
      outputName: payload.outputName,
      outputFile: null,
      outputSource: null,
      truncated: false,
      outputBytes: null,
      executable: dryRun ? null : payload.executable,
      scratchDir,
      checkpointHandoff,
      inputSha256,
      outputSha256: null,
      app: { ...this.appInfo },
      ...(payload.conformer ? { conformer: conformerRecord(payload.conformer) } : {}),
      provenance: {
        kind: provenanceKindFor(dryRun),
        // The job keyword is part of the method record: a methods paragraph
        // must be able to say "optimization + frequency" from run.json alone.
        jobType,
        method,
        // Issue #42: xTB solvation is recorded beside the method so a reader
        // does not have to parse argv to know the model and solvent. Gaussian
        // records keep their existing shape.
        ...(engine.id === 'xtb' ? { solvation: xtbSolvationFromArgv(argv) } : {}),
        ...(ecp ? { ecp } : {}),
        input: { name: payload.inputName, bytes: inputBytes },
        output: null,
      },
      startedAt: new Date().toISOString(),
      finishedAt: stageError ? new Date().toISOString() : null,
      exitCode: null,
      parsed: null,
      gates: null,
      error: stageError,
    },
    // Issue 193: `record` and `series` appear only when the task carried them.
    // A single-structure block adds neither key, so its run.json is unchanged.
    {
      record: payload.record,
      series: payload.series,
    });
    await writeJson(path.join(runDir, 'run.json'), record);
    await writeJson(path.join(runDir, 'request.json'), {
      ...record,
      inputText: undefined,
    });
    if (stageError) {
      const error = new Error(stageError);
      error.runId = runId;
      error.runDir = runDir;
      throw error;
    }

    const context = { runId, runDir, payload, engine, scratchDir, scratch, outputText: '', cancelled: false, timedOut: false, finished: false, timer: null, runner: null, outputMeta: null, lastOutputLine: null, timeoutSeconds };
    this.active.set(runId, context);
    this.emit({ type: 'started', runId, runDir, record });
    this.execute(context).catch(async (error) => {
      await this.fail(context, error);
    });
    return { runId, runDir, status: 'running' };
  }

  /**
   * Remember the last line the engine printed (issue 177).
   *
   * When a run is stopped for taking too long, the last line is the only
   * evidence of where it was. It is the literal last non-empty line written —
   * never an inference from the elapsed time or the route.
   */
  noteOutputText(context, text) {
    const lines = String(text ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length > 0) context.lastOutputLine = lines[lines.length - 1].slice(0, 300);
  }

  /**
   * Await one engine invocation under a wall-clock limit (issue 177).
   *
   * Enforced here, in one place, because every engine has the same failure
   * mode: the process is alive and will not finish. The limit is a race, not a
   * guarded wait — a runner whose promise never settles (a wrapper waiting on a
   * pipe, a fake in a test) must not keep the queue slot either.
   *
   * @returns {Promise<{timedOut: true, elapsedMs: number}|{result: object}>}
   */
  async awaitUnderLimit(promise, limitSeconds) {
    // Both handlers are attached here, so an invocation that settles after the
    // deadline is abandoned without becoming an unhandled rejection.
    const settled = promise.then((result) => ({ result }), (error) => ({ error }));
    if (!(limitSeconds > 0)) {
      const outcome = await settled;
      if (outcome.error) throw outcome.error;
      return { result: outcome.result };
    }
    const startedAt = Date.now();
    let timer = null;
    const expired = new Promise((resolve) => {
      timer = setTimeout(
        () => resolve({ timedOut: true, elapsedMs: Date.now() - startedAt }),
        limitSeconds * 1000,
      );
    });
    let outcome;
    try {
      outcome = await Promise.race([settled, expired]);
    } finally {
      clearTimeout(timer);
    }
    if (outcome.timedOut) return outcome;
    if (outcome.error) throw outcome.error;
    return { result: outcome.result };
  }

  /**
   * Stop a run that reached its limit and record that fact.
   *
   * The process tree is stopped before the record is written, and the
   * runner's report says whether SIGTERM was enough (`escalated`) and whether
   * anything was still alive afterwards (`survived`). A partially written log
   * is not parsed: `parsed` and `gates` stay null, so a truncated file can
   * never be read as a result.
   */
  async finishTimedOut(context, elapsedMs) {
    context.timedOut = true;
    let termination = null;
    try {
      termination = await context.runner?.cancel();
    } catch {
      // A failed kill is reported as unverified, never as a stop.
      termination = null;
    }
    const limitSeconds = context.timeoutSeconds;
    const elapsedSeconds = Math.max(0, Math.round((elapsedMs / 1000) * 10) / 10);
    const tree = termination && typeof termination === 'object'
      ? { escalated: termination.escalated === true, survived: termination.survived === true }
      : null;
    const lastOutput = context.lastOutputLine || null;
    await this.finish(context, {
      status: 'timed out',
      exitCode: null,
      parsed: null,
      gates: null,
      error: `Stopped after ${elapsedSeconds.toFixed(1)} s: the ${limitSeconds} s wall-clock limit was reached`
        + `${tree?.survived ? ' and the process tree did not report itself gone' : ' and the process tree was stopped'}`
        + '; the output was not parsed.',
      timeout: {
        limitSeconds,
        elapsedSeconds,
        lastOutput,
        tree,
      },
    });
  }

  async execute(context) {
    const { runId, runDir, payload, engine, scratchDir } = context;
    let outputText = '';
    let exitCode = null;

    if (payload.dryRun) {
      await new Promise((resolve) => {
        context.timer = setTimeout(resolve, 350);
      });
      if (context.cancelled) {
        await this.finish(context, {
          status: 'cancelled',
          exitCode: null,
          parsed: null,
          gates: null,
          error: 'Run cancelled by the user.',
        });
        return;
      }
      const expected = payload.gates?.expectedImaginary;
      const requestedMultiplicity = payload.validity?.molecule?.multiplicity;
      outputText = engine.makeFixture({
        imaginary: Number(expected) > 0 ? 1 : 0,
        multiplicity: Number.isInteger(requestedMultiplicity) ? requestedMultiplicity : 1,
      });
      await fsp.writeFile(path.join(runDir, payload.outputName), outputText, 'utf8');
      // A dry run still has to produce the artefact a real xTB job leaves behind
      // (xtbopt.xyz), or a downstream block has nothing to hand over. It is
      // written from the input geometry and labelled as a fixture.
      if (engine.id === 'xtb') {
        const fixtureGeometry = parseXtbGeometry(payload.inputText);
        if (fixtureGeometry) {
          const xyz = [`${fixtureGeometry.atoms.length}`, 'fixture geometry (dry run, not optimised)', ...fixtureGeometry.atoms.map((atom) => `${atom.element} ${atom.x.toFixed(6)} ${atom.y.toFixed(6)} ${atom.z.toFixed(6)}`)].join('\n') + '\n';
          await fsp.writeFile(path.join(runDir, 'xtbopt.xyz'), xyz, 'utf8');
        }
      }
      this.emit({ type: 'output', runId, text: outputText });
      const fixtureBytes = Buffer.byteLength(outputText, 'utf8');
      context.outputPath = path.join(runDir, payload.outputName);
      context.outputMeta = {
        outputFile: payload.outputName,
        outputSource: 'fixture',
        truncated: false,
        outputBytes: {
          size: fixtureBytes,
          bytesRead: fixtureBytes,
          truncated: false,
          windows: [{ name: 'fixture', start: 0, end: fixtureBytes, bytes: fixtureBytes, supplied: outputEvidence(outputText) }],
        },
      };
      exitCode = 0;
    } else {
      const runner = this.runnerFor(engine);
      context.runner = runner;
      const timeoutMs = Number(payload.timeoutMs) || 0;
      const onOutput = ({ text }) => {
        this.noteOutputText(context, text);
        this.emit({ type: 'output', runId, text });
      };
      const argv = Array.isArray(payload.argv) && payload.argv.length > 0
        ? payload.argv.map(String) : [payload.inputName];
      const runArgs = {
        executable: payload.executable,
        cwd: runDir,
        outputName: payload.outputName,
        timeoutMs,
        onOutput,
      };
      let invocation;
      let result;
      if (engine.id === 'xtb') {
        invocation = runner.run({
          ...runArgs,
          argv,
          xtbPath: payload.xtbPath || null,
          threads: payload.settings?.xtbThreads ?? null,
        });
      } else if (engine.id === 'orca') {
        invocation = runner.run({ ...runArgs, argv });
      } else if (engine.id === 'psi4') {
        invocation = runner.run({
          ...runArgs,
          argv,
          threads: payload.settings?.psi4Threads ?? payload.settings?.nproc ?? null,
          // Issue 283: Psi4 scratch defaults to /tmp; the run's own folder is
          // what the queue already created for it.
          scratchDir,
        });
      } else if (engine.id === 'pyscf') {
        invocation = runner.run({
          ...runArgs,
          argv,
          threads: payload.settings?.nproc ?? null,
        });
      } else {
        invocation = runner.run({
          ...runArgs,
          inputName: payload.inputName,
          scratchDir,
        });
      }
      // Issue 177: the wall clock starts when the engine is launched and the
      // task is stopped when it runs out, whatever the engine is doing.
      const awaited = await this.awaitUnderLimit(invocation, context.timeoutSeconds);
      if (awaited.timedOut) {
        await this.finishTimedOut(context, awaited.elapsedMs);
        return;
      }
      result = awaited.result;
      outputText = result.outputText;
      context.outputText = outputText || '';
      // Issue 283: a full scratch filesystem is the real cause of "WRITE failed"
      // and of the "no termination marker" that used to stand in for it. Detect
      // it before any of the classify/throw paths below can lose the text.
      context.scratchExhausted = /No space left on device|ENOSPC|WRITE failed/i
        .test(`${outputText || ''}\n${result.stderr || ''}`);
      exitCode = result.exitCode;
      context.engineId = engine.id;
      if (engine.id === 'xtb') context.parametersPath = result.parameterPath ?? null;
      // ORCA reports to stdout and can fail with a zero exit code, so the text
      // is the evidence. When it printed nothing, stderr is all anyone has.
      if (engine.id === 'psi4') {
        context.stderr = result.stderr || null;
      }
      if (engine.id === 'pyscf') {
        context.stderr = result.stderr || null;
        context.recordText = result.recordText || null;
        context.recordFile = result.recordFile || null;
      }
      if (engine.id === 'orca') {
        context.stderr = result.stderr || null;
        context.artifacts = Array.isArray(result.artifacts) ? result.artifacts : null;
        context.driverAbsolute = result.driverAbsolute ?? null;
      }
      context.outputPath = result.outputPath || null;
      context.outputMeta = {
        outputFile: result.outputName || null,
        outputSource: result.outputSource || 'stdout',
        truncated: Boolean(result.truncated),
        outputBytes: result.outputBytes || null,
      };
      if (result.cancelled || context.cancelled) {
        await this.finish(context, {
          status: 'cancelled',
          exitCode,
          parsed: null,
          gates: null,
          error: 'Run cancelled by the user.',
        });
        return;
      }
      // A run that printed nothing has no record to read. Saying "needs review"
      // of an empty file would suggest there is something to review.
      if ((engine.id === 'orca' || engine.id === 'psi4' || engine.id === 'pyscf')
        && String(outputText || '').trim() === '') {
        const detail = result.stderr && String(result.stderr).trim()
          ? `; stderr said: ${String(result.stderr).trim().slice(0, 400)}`
          : '; stderr was empty too';
        throw new Error(`${engine.label} produced no output${detail}.`);
      }
      const classified = engine.classify(outputText, result.exitCode, { stderr: result.stderr });
      if (classified.code === 'none' && Number(result.exitCode) !== 0) {
        const detail = engine.id === 'orca' && result.stderr
          ? ` stderr said: ${String(result.stderr).trim().slice(0, 400)}`
          : '';
        throw new Error(`${engine.label} exited with code ${result.exitCode} and produced no termination record.${detail}`);
      }
    }

    const outputProvenance = await this.describeOutput(context, outputText);
    // Issue 168: an open-shell Psi4 single point writes a formatted checkpoint
    // (`fchk(wfn, …)` in the input, see `buildPsi4Input`), and the spin
    // populations and Fermi-contact couplings live in that file's `Spin SCF
    // Density` block — nowhere in the log. Read it here and hand the text to the
    // parser, and copy it beside `run.json` so the wavefunction view and the
    // Molden export find it the way they already find a Gaussian checkpoint.
    // No checkpoint is an ordinary case (a closed-shell job), not an error.
    let spinCheckpoint = null;
    if (engine.id === 'psi4') {
      for (const dir of [scratchDir, runDir]) {
        if (spinCheckpoint) break;
        try {
          const entries = await fsp.readdir(dir);
          const name = entries.filter((entry) => /\.fchk$/i.test(entry)).sort((a, b) => a.localeCompare(b))[0];
          if (!name) continue;
          spinCheckpoint = await fsp.readFile(path.join(dir, name), 'utf8');
          if (dir === scratchDir) await fsp.copyFile(path.join(dir, name), path.join(runDir, name));
        } catch {
          // No readable checkpoint for this run; the parser says so in words.
        }
      }
    }
    const parsed = engine.parse(outputText, {
      truncated: Boolean(context.outputMeta?.truncated),
      byteRange: context.outputMeta?.outputBytes || null,
      argv: Array.isArray(payload.argv) ? payload.argv.map(String) : null,
      route: payload.route || null,
      ...(spinCheckpoint ? { fchk: spinCheckpoint } : {}),
      ...(context.recordText ? { recordText: context.recordText } : {}),
    });
    // xTB writes the optimised geometry to `xtbopt.xyz` instead of printing it,
    // so a downstream block can only receive a parsed geometry if it is read
    // from the run folder here.
    if (engine.id === 'xtb' && parsed) {
      for (const dir of [scratchDir, runDir]) {
        if (parsed.finalGeometry) break;
        try {
          const geometry = parseXtbGeometry(await fsp.readFile(path.join(dir, 'xtbopt.xyz'), 'utf8'));
          if (geometry) parsed.finalGeometry = geometry;
        } catch {
          // No optimised geometry for this job (a single point, or a dry run
          // that did not write one) — the hand-off will report it.
        }
      }
    }
    // ADR 0003 §3.6: perceive what the final geometry actually is. The gate is
    // computed for every record and never turns a finished run into a failed
    // one; only an opted-in block may refuse, and only on a lost atom or a
    // changed connectivity.
    context.structureIntegrity = await this.integrityForRun(context, parsed);
    // Issue #25: the validity checks run on the parsed records, never on the
    // exit code. They are reported next to the gates (gates.validity) and do
    // not change gates.overall: the job can run correctly while the science is
    // unsupported, and the record must say both.
    const validityContext = payload.validity && typeof payload.validity === 'object'
      ? normalizeValidityContext(payload.validity)
      : null;
    const validity = validityContext
      ? runValidityChecks({
        ...validityContext,
        parsed,
        minMagnitude: payload.gates?.minMagnitude ?? null,
      }, { phase: 'post', engine: engine.id })
      : null;
    if (validity && context.structureIntegrity) {
      const verdict = integrityVerdict(context.structureIntegrity);
      validity.findings.push({
        id: 'structure-integrity',
        status: verdict.status === 'pass' ? 'pass' : (verdict.blocking ? 'fail' : 'warning'),
        message: verdict.message,
        evidence: {
          status: context.structureIntegrity.status,
          reason: context.structureIntegrity.reason,
          before: context.structureIntegrity.before?.formula ?? null,
          after: context.structureIntegrity.after?.formula ?? null,
        },
      });
    }
    const gates = evaluateGates(parsed, {
      expectedImaginary: payload.gates?.expectedImaginary ?? null,
      minMagnitude: payload.gates?.minMagnitude ?? 50,
      requireOptimization: Boolean(payload.gates?.requireOptimization),
      requireFrequency: Boolean(payload.gates?.requireFrequency),
      requireThermochemistry: Boolean(payload.gates?.requireThermochemistry),
      requireFinalEnergy: Boolean(payload.gates?.requireFinalEnergy),
      validity: validity ? validity.findings : null,
      // D4 has a revision floor; the check runs against the version this
      // output reports, not against what the settings hoped for.
      dispersion: payload.settings?.dispersion || null,
      requireStableWavefunction: payload.settings?.stableOpt === true,
    });

    // Cache the trajectory as typed arrays (#99). A viewer then reloads a run
    // without re-parsing the log: on a real optimisation the file is a few
    // kilobytes instead of hundreds, and there is no regex pass. The cache is a
    // convenience, never a requirement — a failure here must not turn a
    // finished run into a failed one, so it is recorded and swallowed.
    context.cache = await this.writeCache(context, parsed);
    const integrityBlock = context.structureIntegrity
      ? integrityVerdict(context.structureIntegrity)
      : { blocking: false, message: '' };
    const status = parsed.status === 'error' || gates.overall === 'fail' || integrityBlock.blocking ? 'failed'
      : gates.overall === 'pass' ? 'completed' : 'needs-review';
    await this.finish(context, {
      status,
      exitCode,
      parsed,
      gates,
      error: integrityBlock.blocking ? `Structure integrity: ${integrityBlock.message}` : null,
      outputProvenance,
    });
  }

  /**
   * ADR 0003 §3.6: run the integrity op over the input and the final geometry.
   *
   * A missing sidecar, a perception failure or a malformed answer is
   * `inconclusive`, never a failed run. The gate is evidence attached to the
   * record; the caller decides whether an opted-in block refuses.
   */
  async integrityForRun(context, parsed) {
    const spec = context.payload?.integrity;
    if (!spec || typeof spec !== 'object') return null;
    const policy = spec.policy === 'fail' ? 'fail' : 'warn';
    if (spec.notApplicable) {
      return {
        status: 'not-applicable',
        reason: 'partial-geometry',
        reasonText: INTEGRITY_INCONCLUSIVE_REASONS['partial-geometry'],
        policy,
        before: null,
        after: null,
      };
    }
    const finalAtoms = parsed?.finalGeometry?.atoms;
    if (!Array.isArray(finalAtoms) || finalAtoms.length === 0) {
      return {
        status: 'inconclusive',
        reason: 'empty-geometry',
        reasonText: INTEGRITY_INCONCLUSIVE_REASONS['empty-geometry'],
        policy,
        before: null,
        after: null,
      };
    }
    if (!spec.executable) {
      return {
        status: 'inconclusive',
        reason: 'rdkit-missing',
        reasonText: INTEGRITY_INCONCLUSIVE_REASONS['rdkit-missing'],
        policy,
        before: null,
        after: null,
      };
    }
    try {
      const raw = await new SidecarRunner({ label: 'chemistry sidecar' }).run({
        executable: spec.executable,
        script: spec.script || '',
        request: integrityRequest({ molecule: spec.molecule, finalAtoms, policy }),
        timeoutMs: 60_000,
        cwd: context.runDir,
        onOutput: ({ text }) => this.emit({ type: 'output', runId: context.runId, text }),
      });
      return normalizeIntegrityResult(raw, { policy });
    } catch (error) {
      return {
        status: 'inconclusive',
        reason: 'perception-failed',
        reasonText: `${INTEGRITY_INCONCLUSIVE_REASONS['perception-failed']} ${error?.message || String(error)}`.trim(),
        policy,
        before: null,
        after: null,
      };
    }
  }

  /**
   * Write the run's trajectory cache, or say why there is none.
   *
   * Dry runs are skipped on purpose: their output is a fixture, and a binary
   * file next to the run would outlive the label that says so.
   */
  async writeCache(context, parsed) {
    if (context.payload?.dryRun || !parsed) return null;
    try {
      const cache = cacheFromParsed(parsed);
      const bytes = writeCache(cache);
      const file = 'trajectory.ncsr';
      await fsp.writeFile(path.join(context.runDir, file), bytes);
      return {
        file,
        kind: cache.meta.kind,
        bytes: bytes.length,
        frames: cache.meta.frames,
        atoms: cache.meta.atoms,
      };
    } catch (error) {
      // No trajectory in this output, or a frame set that does not line up.
      return { file: null, skipped: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Hash the output that was actually parsed. A file written by Gaussian (or
   * the dry-run fixture) is hashed from its full bytes on disk; a stdout-only
   * capture is hashed from the text handed to the parser and labelled as such.
   */
  async describeOutput(context, outputText) {
    const candidates = [];
    if (context.outputPath) candidates.push(context.outputPath);
    if (context.outputMeta?.outputFile) {
      candidates.push(path.join(context.runDir, context.outputMeta.outputFile));
    }
    for (const file of candidates) {
      if (!(await isFile(file))) continue;
      const stat = await fsp.stat(file);
      return {
        name: context.outputMeta?.outputFile || path.basename(file),
        source: context.outputMeta?.outputSource || 'file',
        bytes: stat.size,
        hashSource: 'file',
        sha256: await sha256File(file),
      };
    }
    const text = String(outputText ?? '');
    return {
      name: context.outputMeta?.outputFile || null,
      source: context.outputMeta?.outputSource || 'stdout',
      bytes: Buffer.byteLength(text, 'utf8'),
      hashSource: 'stream',
      sha256: sha256Text(text),
    };
  }

  async finish(context, { status, exitCode, parsed, gates, error, outputProvenance = null, timeout = null }) {
    const { runId, runDir } = context;
    // One record per run: a second settle (a cancelled invocation resolving
    // after the deadline already stopped it) must not rewrite the verdict.
    if (context.finished) return;
    const runPath = path.join(runDir, 'run.json');
    const record = JSON.parse(await fsp.readFile(runPath, 'utf8'));
    const output = outputProvenance || null;
    // Issue 283: decided here as well as in `execute`, because an engine can
    // settle through more than one path and the text is the evidence either way.
    const scratchExhausted = Boolean(context.scratchExhausted)
      || /No space left on device|ENOSPC|WRITE failed/i
        .test(`${context.outputText || ''}\n${context.stderr || ''}`);
    // Issue 334: a run folder can carry a wavefunction file — a converted
    // checkpoint, a Molden/WFN/WFX the engine wrote, a cube. The record says what
    // it is and hashes it, so the dataset export's wavefunction columns and the
    // wavefunction view read a field that is actually written. A file that cannot
    // be parsed leaves the field null; it never turns a finished run into a failed
    // one.
    const wavefunction = await wavefunctionForRun(runDir);
    const finished = {
      ...record,
      ...(context.outputMeta || {}),
      ...(wavefunction ? { wavefunction } : {}),
      outputSha256: output?.sha256 || null,
      provenance: {
        ...(record.provenance || {}),
        ...(output ? { output } : {}),
        // xTB resolves its parameter directory from the executable or XTBPATH.
        // Recording the path that was actually used makes a run reproducible
        // after the installation moves, and records `null` when none was found.
        ...(context.engineId === 'xtb'
          ? { xtb: { parametersPath: context.parametersPath ?? null } }
          : {}),
        // ORCA's verdict lives in the text, so the record keeps the two things a
        // reader cannot recover from the .out alone: driver chatter and which
        // side files the process actually wrote.
        ...(context.engineId === 'psi4'
          ? { psi4: { stderr: context.stderr ?? null } }
          : {}),
        ...(context.engineId === 'pyscf'
          ? {
            pyscf: {
              stderr: context.stderr ?? null,
              recordFile: context.recordFile ?? null,
            },
          }
          : {}),
        ...(context.engineId === 'orca'
          ? {
            orca: {
              stderr: context.stderr ?? null,
              artifacts: context.artifacts ?? null,
              driverAbsolutePath: context.driverAbsolute ?? null,
            },
          }
          : {}),
      },
      status,
      exitCode,
      cache: context.cache ?? null,
      parsed,
      gates,
      // ADR 0003 §3.6: what the final geometry is, not just what converged.
      ...(context.structureIntegrity ? { structureIntegrity: context.structureIntegrity } : {}),
      // Issue 283: the scratch the engine wrote to, and — when it died for want
      // of space — that fact, instead of leaving "no termination marker" to
      // stand for a full filesystem.
      // Only a run that actually ran out keeps the numbers: `scratchDir` is
      // already on every record, and a free-space reading on a healthy run is
      // volatile noise that would make two identical runs differ byte for byte.
      ...(context.scratch && scratchExhausted
        ? {
          scratch: {
            dir: context.scratch.dir,
            freeAtExit: await scratchSpaceFor(context.scratch.dir).then((space) => space.freeBytes),
            freeAtLaunch: context.scratch.freeBytes,
            totalBytes: context.scratch.totalBytes,
            exhausted: true,
            note: `${context.scratch.dir} ran out of space: the engine could not write its scratch `
              + 'files (No space left on device). Free space on that filesystem, or point the '
              + 'scratch directory somewhere with room.',
          },
        }
        : {}),
      error: scratchExhausted && context.scratch
        ? [error, `${context.scratch.dir} ran out of space (No space left on device).`]
          .filter(Boolean).join(' — ')
        : error,
      // Issue 177: present only on a run stopped by its wall-clock limit, so a
      // run that finished inside it is byte-identical to a run from before.
      ...(timeout ? { timeout } : {}),
      finishedAt: new Date().toISOString(),
    };
    await writeJson(runPath, finished);
    context.finished = true;
    this.active.delete(runId);
    this.emit({ type: 'done', runId, runDir, record: finished });
  }

  async fail(context, error) {
    // A run that was stopped for taking too long has already settled.
    if (context.cancelled || context.timedOut || context.finished) return;
    await this.finish(context, {
      status: 'failed',
      exitCode: null,
      parsed: null,
      gates: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  async cancel(runId) {
    const context = this.active.get(runId);
    if (!context) return { canceled: false, reason: 'not-active' };
    if (context.finished) return { canceled: false, reason: 'settled' };
    context.cancelled = true;
    if (context.timer) clearTimeout(context.timer);
    // The runner stops the whole tree (issue 177); this does not wait for that
    // report, because the record is written when the runner's own promise
    // settles and a UI cancel must return at once.
    context.runner?.cancel();
    return { canceled: true };
  }

  cancelAll() {
    for (const context of this.active.values()) {
      if (context.finished) continue;
      context.cancelled = true;
      if (context.timer) clearTimeout(context.timer);
      context.runner?.cancel();
    }
  }

  /**
   * Recompute the input hash from the run folder and compare it with the
   * record. The renderer supplies the id, so it is validated as one safe path
   * segment before it is joined under the runs root.
   */
  async verify(runId) {
    const id = String(runId ?? '');
    if (!SAFE_RUN_ID.test(id)) throw new Error('Run id must be a safe run folder name.');
    const runDir = path.join(this.runsRoot, id);
    let record;
    try {
      record = JSON.parse(await fsp.readFile(path.join(runDir, 'run.json'), 'utf8'));
    } catch (error) {
      return {
        runId: id,
        status: 'missing-run',
        ok: false,
        error: error.code === 'ENOENT' ? 'The run folder has no run.json.' : error.message,
      };
    }
    const inputName = String(record.inputName || '');
    const base = { runId: id, inputName, expected: record.inputSha256 || null };
    if (!SAFE_INPUT.test(inputName)) return { ...base, status: 'missing', ok: false };
    if (!record.inputSha256) return { ...base, status: 'unrecorded', ok: false };
    const inputPath = path.join(runDir, inputName);
    if (!(await isFile(inputPath))) return { ...base, status: 'missing', ok: false };
    const actual = await sha256File(inputPath);
    const ok = actual === record.inputSha256;
    return {
      ...base,
      status: ok ? 'match' : 'mismatch',
      ok,
      actual,
      verifiedAt: new Date().toISOString(),
    };
  }

  async list() {
    try {
      const entries = await fsp.readdir(this.runsRoot, { withFileTypes: true });
      const runs = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const file = path.join(this.runsRoot, entry.name, 'run.json');
        if (!fs.existsSync(file)) continue;
        try {
          runs.push(JSON.parse(await fsp.readFile(file, 'utf8')));
        } catch {
          // Ignore an incomplete run directory rather than hiding the rest.
        }
      }
      return runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
}
