import { spawn } from 'node:child_process';

/**
 * Stopping an engine means stopping everything it started.
 *
 * Every engine this app launches is a program that starts helpers: Psi4 is a
 * Python driver with worker threads and child processes, ORCA's driver starts
 * each module as a separate process, Gaussian's Links fork, CREST spawns the
 * same, and an xTB job can hand off to a subshell. Signalling only the direct
 * child leaves the helpers running — the wrapper may report a dead process
 * while the thing that actually computes keeps going and the queue slot never
 * comes back. That is the failure this module exists to prevent, and it is the
 * mechanism the runners already used for Psi4 and ORCA; it now lives in one
 * place so every engine gets the same discipline.
 *
 * POSIX: the child is spawned into its own process group (`detached`), so one
 * signal reaches the whole tree. Windows: `taskkill /T /F` walks the tree.
 *
 * The escalation is deliberate and bounded: SIGTERM first (a program with a
 * checkpoint may write one), then SIGKILL after the grace period. Afterwards
 * the tree is polled until it is gone, so the caller gets a fact — `survived`
 * — instead of an assumption that the kill worked.
 */

const TERM_GRACE_MS = 2000;
/** How long a SIGKILL is given to take effect before the tree is reported alive. */
const KILL_WAIT_MS = 2000;
const POLL_MS = 25;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Spawn options that put the child in its own process group on POSIX. */
export function treeSpawnOptions(options = {}) {
  return {
    ...options,
    shell: false,
    windowsHide: true,
    // Not a daemon: the pipes keep the parent honest. The group is what makes
    // `process.kill(-pid, …)` reach every helper the engine starts.
    detached: process.platform !== 'win32',
  };
}

/** True when the pid (or, when negative, the process group) still exists. */
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else.
    return error?.code === 'EPERM';
  }
}

/** One signal to the tree, falling back to the direct child. */
export function signalTree(child, signal) {
  if (!child?.pid) return false;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // No group (a child spawned without `detached`, or already reaped):
      // signal the process itself so cancellation still does something.
    }
  }
  try {
    child.kill(signal);
    return true;
  } catch {
    return false;
  }
}

/** Windows has no process group: `taskkill /T` is the tree walk. */
async function taskkillTree(pid) {
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('error', () => resolve());
    killer.once('close', () => resolve());
  });
}

async function waitUntilGone(isGone, deadlineMs) {
  const started = Date.now();
  for (;;) {
    if (isGone()) return true;
    if (Date.now() - started >= deadlineMs) return false;
    // eslint-disable-next-line no-await-in-loop
    await wait(POLL_MS);
  }
}

/**
 * Terminate one child's whole process tree.
 *
 * @returns {Promise<{killed: boolean, escalated: boolean, survived: boolean}>}
 *   `escalated` — SIGTERM did not stop it inside the grace period.
 *   `survived`  — the tree was still alive after SIGKILL; the caller must not
 *                 report the task as stopped.
 */
export async function terminateTree(child, {
  graceMs = TERM_GRACE_MS,
  killWaitMs = KILL_WAIT_MS,
} = {}) {
  if (!child?.pid) return { killed: false, escalated: false, survived: false };
  const pid = child.pid;
  const gone = () => (process.platform === 'win32' ? !processAlive(pid) : !processAlive(-pid));

  if (process.platform === 'win32') {
    // A hard tree kill: Windows has no graceful equivalent that reaches
    // grandchildren, and a hung console process would not act on Ctrl+C anyway.
    await taskkillTree(pid);
    const survived = !(await waitUntilGone(gone, killWaitMs));
    return { killed: true, escalated: false, survived };
  }

  signalTree(child, 'SIGTERM');
  let escalated = false;
  if (!(await waitUntilGone(gone, graceMs))) {
    escalated = true;
    signalTree(child, 'SIGKILL');
    const survived = !(await waitUntilGone(gone, killWaitMs));
    return { killed: true, escalated, survived };
  }
  return { killed: true, escalated, survived: false };
}
