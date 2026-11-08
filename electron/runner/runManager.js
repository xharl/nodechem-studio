import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { GaussianRunner } from './gaussianRunner.js';
import { XtbRunner } from './xtbRunner.js';
import { stageCheckpoint } from './checkpoint.js';
import { isFile, sha256File, sha256Text } from './hashing.js';
import { evaluateGates, outputEvidence } from '../../src/shared/gaussianOutput.js';
import { makeFixtureOutput } from '../../src/shared/fixtureOutput.js';
import { methodBlockFor } from '../../src/shared/gaussianInput.js';
import { ecpFromInput } from '../../src/shared/ecp.js';
import { normaliseAppInfo, provenanceKindFor } from '../../src/shared/provenance.js';
import { engineFor, DEFAULT_ENGINE_ID } from '../../src/shared/engines/index.js';
import { xtbSolvationFromArgv, parseXtbGeometry } from '../../src/shared/engines/xtb.js';
import { normalizeValidityContext, runValidityChecks } from '../../src/shared/validityChecks.js';
import { cacheFromParsed, writeCache } from '../../src/shared/cache.js';

const SAFE_INPUT = /^[A-Za-z0-9._-]+\.(gjf|com)$/i;
const SAFE_OUTPUT = /^[A-Za-z0-9._-]+\.(out|log)$/i;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;

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
    // ORCA ships an input builder, a parser and preflight discovery (#31), but no
    // runner: handing its .inp to g16 would run a different program and print a
    // parseable-looking failure. Refuse until the runner lands (#98).
    throw new Error(`${engine.label || engine.id} has no runner yet: its input and parser are available,`
      + ' but execution is not wired. Run the job in ORCA and import the output, or use Gaussian/xTB.');
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

    const record = {
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
    };
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

    const context = { runId, runDir, payload, engine, scratchDir, cancelled: false, timer: null, runner: null, outputMeta: null };
    this.active.set(runId, context);
    this.emit({ type: 'started', runId, runDir, record });
    this.execute(context).catch(async (error) => {
      await this.fail(context, error);
    });
    return { runId, runDir, status: 'running' };
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
      const onOutput = ({ text }) => this.emit({ type: 'output', runId, text });
      const result = engine.id === 'xtb'
        ? await runner.run({
          executable: payload.executable,
          argv: Array.isArray(payload.argv) && payload.argv.length > 0 ? payload.argv : [payload.inputName],
          cwd: runDir,
          outputName: payload.outputName,
          timeoutMs,
          xtbPath: payload.xtbPath || null,
          threads: payload.settings?.xtbThreads ?? null,
          onOutput,
        })
        : await runner.run({
          executable: payload.executable,
          inputName: payload.inputName,
          outputName: payload.outputName,
          cwd: runDir,
          scratchDir,
          timeoutMs,
          onOutput,
        });
      outputText = result.outputText;
      exitCode = result.exitCode;
      context.engineId = engine.id;
      if (engine.id === 'xtb') context.parametersPath = result.parameterPath ?? null;
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
      const classified = engine.classify(outputText, result.exitCode);
      if (classified.code === 'none' && Number(result.exitCode) !== 0) {
        throw new Error(`${engine.label} exited with code ${result.exitCode} and produced no termination record.`);
      }
    }

    const outputProvenance = await this.describeOutput(context, outputText);
    const parsed = engine.parse(outputText, {
      truncated: Boolean(context.outputMeta?.truncated),
      byteRange: context.outputMeta?.outputBytes || null,
      argv: Array.isArray(payload.argv) ? payload.argv.map(String) : null,
      route: payload.route || null,
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
    const status = parsed.status === 'error' || gates.overall === 'fail' ? 'failed'
      : gates.overall === 'pass' ? 'completed' : 'needs-review';
    await this.finish(context, { status, exitCode, parsed, gates, error: null, outputProvenance });
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

  async finish(context, { status, exitCode, parsed, gates, error, outputProvenance = null }) {
    const { runId, runDir } = context;
    const runPath = path.join(runDir, 'run.json');
    const record = JSON.parse(await fsp.readFile(runPath, 'utf8'));
    const output = outputProvenance || null;
    const finished = {
      ...record,
      ...(context.outputMeta || {}),
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
      },
      status,
      exitCode,
      cache: context.cache ?? null,
      parsed,
      gates,
      error,
      finishedAt: new Date().toISOString(),
    };
    await writeJson(runPath, finished);
    this.active.delete(runId);
    this.emit({ type: 'done', runId, runDir, record: finished });
  }

  async fail(context, error) {
    if (context.cancelled) return;
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
    context.cancelled = true;
    if (context.timer) clearTimeout(context.timer);
    context.runner?.cancel();
    return { canceled: true };
  }

  cancelAll() {
    for (const context of this.active.values()) {
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
