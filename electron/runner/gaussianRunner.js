import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { discoverOutput, outputCandidates } from './outputDiscovery.js';
import { terminateTree, treeSpawnOptions } from './processTree.js';
import { outputEvidence } from '../../src/shared/gaussianOutput.js';
import { gaussianInstallDir } from './gaussianPlatform.js';

const MAX_TAIL_BYTES = 256 * 1024;
const MAX_FINAL_BYTES = 32 * 1024 * 1024;
const HEAD_WINDOW_BYTES = 1 * 1024 * 1024;
const TAIL_WINDOW_BYTES = MAX_FINAL_BYTES - HEAD_WINDOW_BYTES;

async function readRange(filePath, offset, maxBytes) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size <= offset) return { text: '', nextOffset: offset, size: stat.size };
    const length = Math.min(stat.size - offset, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      nextOffset: offset + bytesRead,
      size: stat.size,
    };
  } finally {
    await handle.close();
  }
}

/** Drop a fragment that starts or ends mid-line: the parser must see whole lines. */
function trimPartialLastLine(text) {
  const index = text.lastIndexOf('\n');
  return index === -1 ? '' : text.slice(0, index + 1);
}

function trimPartialFirstLine(text) {
  const index = text.indexOf('\n');
  return index === -1 ? '' : text.slice(index + 1);
}

/**
 * Read a finished output file for the parser.
 *
 * Files at or under `maxBytes` are read whole. Larger files are read as two
 * windows inside the same byte budget: a head window (version banner, route
 * echo, initial geometry) and a tail window (termination, final SCF, frequency
 * and thermochemistry blocks). Partial lines at either boundary are dropped so
 * the parser never sees half a line, and the byte ranges actually read are
 * returned so the run record can show a reviewer what the parse was based on.
 */
export async function readOutputFile(filePath, {
  maxBytes = MAX_FINAL_BYTES,
  headBytes = HEAD_WINDOW_BYTES,
  tailBytes = TAIL_WINDOW_BYTES,
} = {}) {
  const stat = await fsp.stat(filePath);
  const size = stat.size;
  if (size <= maxBytes) {
    const text = await fsp.readFile(filePath, 'utf8');
    return {
      text,
      truncated: false,
      byteRange: {
        size,
        bytesRead: size,
        truncated: false,
        windows: [{ name: 'full', start: 0, end: size, bytes: size, supplied: outputEvidence(text) }],
      },
    };
  }

  const headLength = Math.min(headBytes, maxBytes, size);
  const tailLength = Math.min(tailBytes, Math.max(maxBytes - headLength, 0), size);
  const tailStart = Math.max(headLength, size - tailLength);

  const headText = headLength > 0
    ? trimPartialLastLine((await readRange(filePath, 0, headLength)).text)
    : '';
  const tailText = tailStart < size
    ? trimPartialFirstLine((await readRange(filePath, tailStart, size - tailStart)).text)
    : '';

  return {
    text: `${headText}${headText && !headText.endsWith('\n') ? '\n' : ''}${tailText}`,
    truncated: true,
    byteRange: {
      size,
      bytesRead: headLength + (size - tailStart),
      truncated: true,
      windows: [
        { name: 'head', start: 0, end: headLength, bytes: headLength, supplied: outputEvidence(headText) },
        { name: 'tail', start: tailStart, end: size, bytes: size - tailStart, supplied: outputEvidence(tailText) },
      ],
    },
  };
}

/**
 * Spawn one licensed Gaussian process and tail its output file.
 * No shell is involved; arguments are passed as an array.
 */
export class GaussianRunner {
  constructor() {
    this.child = null;
    this.cancelled = false;
  }

  async run({
    executable,
    inputName,
    outputName,
    cwd,
    scratchDir,
    onOutput = () => {},
    timeoutMs = 0,
  }) {
    // On POSIX a symlinked `g16` must still point GAUSS_EXEDIR at the real
    // installation directory, where Link 1 lives. Windows keeps the plain
    // executable directory, byte-identical to the original runner.
    const exeDir = gaussianInstallDir(executable, process.platform);
    const env = {
      ...process.env,
      GAUSS_EXEDIR: exeDir,
      GAUSS_SCRDIR: scratchDir,
      PATH: `${exeDir}${path.delimiter}${process.env.PATH || ''}`,
    };

    const outputPath = path.join(cwd, outputName);
    const candidates = outputCandidates({ inputName, outputName })
      .map((name) => ({ name, file: path.join(cwd, name), offset: 0 }));
    let stdout = '';
    let stderr = '';
    let polling = null;
    let timeout = null;

    const child = spawn(executable, [inputName], treeSpawnOptions({
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    this.child = child;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text.slice(-20000);
      onOutput({ stream: 'stdout', text });
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text.slice(-20000);
      onOutput({ stream: 'stderr', text });
    });

    const poll = async () => {
      for (const candidate of candidates) {
        try {
          const chunk = await readRange(candidate.file, candidate.offset, MAX_TAIL_BYTES);
          if (chunk.text) {
            candidate.offset = chunk.nextOffset;
            onOutput({ stream: 'output', file: candidate.name, text: chunk.text });
          }
        } catch (error) {
          if (error.code !== 'ENOENT') onOutput({ stream: 'stderr', text: `${candidate.name}: ${error.message}\n` });
        }
      }
    };
    polling = setInterval(poll, 300);

    if (timeoutMs > 0) {
      timeout = setTimeout(() => this.cancel(), timeoutMs);
    }

    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    }).finally(() => {
      clearInterval(polling);
      if (timeout) clearTimeout(timeout);
      this.child = null;
    });

    await poll();
    const discovered = await discoverOutput({ cwd, inputName, outputName, settleMs: 200 });
    let outputText = '';
    let outputBytes = null;
    let outputFile = null;
    let outputSource = 'stdout';
    let truncated = false;
    if (discovered) {
      outputFile = discovered.name;
      outputSource = 'file';
      const read = await readOutputFile(discovered.file);
      outputText = read.text;
      outputBytes = read.byteRange;
      truncated = read.truncated;
    } else {
      outputText = `${stdout}\n${stderr}`.trim();
    }

    return {
      exitCode: exit.code,
      signal: exit.signal,
      cancelled: this.cancelled,
      outputPath: discovered?.file || outputPath,
      outputName: outputFile,
      outputSource,
      truncated,
      outputBytes,
      outputText,
      stdout,
      stderr,
    };
  }

  cancel() {
    const child = this.child;
    if (!child) return undefined;
    this.cancelled = true;
    // The whole tree, not just the process that was spawned (issue 177): a
    // Gaussian Link dying must not leave its helpers holding the queue slot.
    return terminateTree(child);
  }
}
