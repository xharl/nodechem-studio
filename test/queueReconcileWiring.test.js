import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Issue 160, the half that no DOM test can reach.
 *
 * The reconciliation itself is pinned in `queueReconcile.test.js`; what cannot be
 * exercised here is the *wiring* — `app.js` is a 6 000-line renderer module that
 * touches `document` at load, so vitest cannot import it. This file asserts the
 * three things that were wrong in the reported build, against the source text:
 * the start-up order, the reconciliation after an open, and the single
 * implementation of "what next".
 *
 * It is a structural test, not a behavioural one, and says so. The behaviour it
 * guards is covered by the module tests beside it.
 */

const source = readFileSync(fileURLToPath(new URL('../src/renderer/app.js', import.meta.url)), 'utf8');

describe('start-up reconciliation wiring (issue 160)', () => {
  it('loads the project before restoring its queue', () => {
    // The bug: `restoreQueue()` was called on its own line at init, so it ran
    // before `openStartupProject()` had produced any blocks to apply verdicts to.
    expect(source).toMatch(/openStartupProject\(\)\s*\n\s*\.then\(\(\) => restoreQueue\(\)\)/);
    expect(source).not.toMatch(/^\s*restoreQueue\(\);\s*$/m);
  });

  it('reconciles the blocks after a project is opened', () => {
    const open = source.slice(source.indexOf('function applyOpenedProject'));
    const body = open.slice(0, open.indexOf('function openProjectPath'));
    expect(body).toContain('syncNodeStatesFromQueue(state.queue)');
    // Before markProjectSaved(), or opening a project reads as unsaved.
    expect(body.indexOf('syncNodeStatesFromQueue(state.queue)'))
      .toBeLessThan(body.indexOf('markProjectSaved('));
  });

  it('uses one definition of the next action, shared with the reconciler', () => {
    expect(source).toContain("from '../shared/queueReconcile.js'");
    expect(source).toContain('const next = nextAction(nodes)?.node ?? null;');
    // The inline search it replaced, which could disagree with the queue.
    expect(source).not.toContain("nodes.find((node) => node.state === 'review')");
  });

  it('refreshes the inspector when the queue changes a block state', () => {
    // The Next Action is computed from block states, so a state change that does
    // not re-render the inspector leaves the prompt stale for the whole session.
    expect(source).toMatch(/if \(reconciled\) renderInspector\(\)/);
  });
});
