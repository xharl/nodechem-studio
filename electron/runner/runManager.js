import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { GaussianRunner } from './gaussianRunner.js';
import { parseGaussianOutput, evaluateGates } from '../../src/shared/gaussianOutput.js';
import { makeFixtureOutput } from '../../src/shared/fixtureOutput.js';

const SAFE_INPUT = /^[A-Za-z0-9._-]+\.(gjf|com)$/i;
const SAFE_OUTPUT = /^[A-Za-z0-9._-]+\.(out|log)$/i;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;

function runIdFor(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export class RunManager {
  constructor({ runsRoot, emit, createRunner }) {
    this.runsRoot = runsRoot;
    this.emitExternal = emit;
    this.createRunner = createRunner || (() => new GaussianRunner());
    this.active = new Map();
    this.listeners = new Set();
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
    const inputText = String(payload.inputText || '');
    if (!inputText.trim()) throw new Error('The run has no Gaussian input text.');
    if (Buffer.byteLength(inputText, 'utf8') > MAX_INPUT_BYTES) throw new Error('Gaussian input is larger than 2 MiB.');
    if (!SAFE_INPUT.test(payload.inputName || '')) throw new Error('Input name must be a safe .gjf or .com basename.');
    if (!SAFE_OUTPUT.test(payload.outputName || '')) throw new Error('Output name must be a safe .out or .log basename.');

    const dryRun = Boolean(payload.dryRun);
    if (!dryRun) {
      if (!payload.executable) throw new Error('Choose the licensed Gaussian executable before running without dry-run.');
      const stat = await fsp.stat(payload.executable).catch(() => null);
      if (!stat?.isFile()) throw new Error(`Gaussian executable not found: ${payload.executable}`);
    }

    const runId = runIdFor();
    const runDir = path.join(this.runsRoot, runId);
    const scratchDir = String(payload.scratchDir || '').trim() || path.join(runDir, 'scratch');
    await fsp.mkdir(runDir, { recursive: true });
    await fsp.mkdir(scratchDir, { recursive: true });
    await fsp.writeFile(path.join(runDir, payload.inputName), inputText, 'utf8');

    const record = {
      id: runId,
      status: 'running',
      dryRun,
      title: String(payload.title || 'Gaussian task'),
      inputName: payload.inputName,
      outputName: payload.outputName,
      executable: dryRun ? null : payload.executable,
      scratchDir,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      parsed: null,
      gates: null,
      error: null,
    };
    await writeJson(path.join(runDir, 'run.json'), record);
    await writeJson(path.join(runDir, 'request.json'), {
      ...record,
      inputText: undefined,
    });

    const context = { runId, runDir, payload, scratchDir, cancelled: false, timer: null, runner: null };
    this.active.set(runId, context);
    this.emit({ type: 'started', runId, runDir, record });
    this.execute(context).catch(async (error) => {
      await this.fail(context, error);
    });
    return { runId, runDir, status: 'running' };
  }

  async execute(context) {
    const { runId, runDir, payload, scratchDir } = context;
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
      outputText = makeFixtureOutput({ imaginary: Number(expected) > 0 ? 1 : 0 });
      await fsp.writeFile(path.join(runDir, payload.outputName), outputText, 'utf8');
      this.emit({ type: 'output', runId, text: outputText });
      exitCode = 0;
    } else {
      const runner = this.createRunner();
      context.runner = runner;
      const result = await runner.run({
        executable: payload.executable,
        inputName: payload.inputName,
        outputName: payload.outputName,
        cwd: runDir,
        scratchDir,
        timeoutMs: Number(payload.timeoutMs) || 0,
        onOutput: ({ text }) => this.emit({ type: 'output', runId, text }),
      });
      outputText = result.outputText;
      exitCode = result.exitCode;
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
      if (result.exitCode !== 0 && !/Normal termination|Error termination/i.test(outputText)) {
        throw new Error(`Gaussian exited with code ${result.exitCode} and produced no termination record.`);
      }
    }

    const parsed = parseGaussianOutput(outputText);
    const gates = evaluateGates(parsed, {
      expectedImaginary: payload.gates?.expectedImaginary ?? null,
      minMagnitude: payload.gates?.minMagnitude ?? 50,
      requireOptimization: Boolean(payload.gates?.requireOptimization),
      requireFrequency: Boolean(payload.gates?.requireFrequency),
      requireThermochemistry: Boolean(payload.gates?.requireThermochemistry),
    });

    const status = parsed.status === 'error' || gates.overall === 'fail' ? 'failed'
      : gates.overall === 'pass' ? 'completed' : 'needs-review';
    await this.finish(context, { status, exitCode, parsed, gates, error: null });
  }

  async finish(context, { status, exitCode, parsed, gates, error }) {
    const { runId, runDir } = context;
    const runPath = path.join(runDir, 'run.json');
    const record = JSON.parse(await fsp.readFile(runPath, 'utf8'));
    const finished = {
      ...record,
      status,
      exitCode,
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
