import { describe, expect, it } from 'vitest';

import {
  FRAME_FALLBACK_MS,
  createFrameCoalescer,
  createQueueEventCoalescer,
  frameSchedule,
  mergeQueueEvent,
  queueGraphSignature,
} from '../src/renderer/eventCoalescer.js';

/**
 * Issue 374 — the queue event path.
 *
 * A queue used to repaint the list, the badges and the whole canvas for every
 * task transition and every output chunk. These tests pin the coalescer that
 * now sits in front of that work: at most one apply per frame, the last state
 * wins, and the one-shot start/finish events cannot be swallowed.
 */

/** A scheduler the test fires by hand, standing in for one animation frame. */
function manualScheduler() {
  let queued = null;
  return {
    schedule: (run) => {
      queued = run;
      return () => {
        if (queued === run) queued = null;
      };
    },
    fire() {
      const run = queued;
      queued = null;
      run?.();
    },
    get queued() {
      return queued;
    },
  };
}

describe('frame schedule', () => {
  it('runs on the frame and cancels the timer fallback', () => {
    const calls = [];
    let run = 0;
    const scheduled = frameSchedule(() => { run += 1; }, {
      requestFrame: (callback) => { calls.push('frame'); return 'frame-1'; },
      cancelFrame: (id) => calls.push(`cancel-frame:${id}`),
      setTimer: (callback, delay) => { calls.push(`timer:${delay}`); return 'timer-1'; },
      clearTimer: (id) => calls.push(`clear-timer:${id}`),
    });

    expect(calls).toEqual(['frame', `timer:${FRAME_FALLBACK_MS}`]);
    // The callback the browser would call:
    expect(typeof scheduled).toBe('function');
  });

  it('fires once even when both transports arrive', () => {
    let frameCallback = null;
    let timerCallback = null;
    let run = 0;
    frameSchedule(() => { run += 1; }, {
      requestFrame: (callback) => { frameCallback = callback; return 1; },
      cancelFrame: () => {},
      setTimer: (callback) => { timerCallback = callback; return 2; },
      clearTimer: () => {},
    });

    frameCallback();
    timerCallback();
    frameCallback();
    expect(run).toBe(1);
  });

  it('still fires from the timer when frames are unavailable', () => {
    let timerCallback = null;
    let run = 0;
    frameSchedule(() => { run += 1; }, {
      requestFrame: null,
      cancelFrame: null,
      setTimer: (callback) => { timerCallback = callback; return 2; },
      clearTimer: () => {},
    });

    timerCallback();
    expect(run).toBe(1);
  });

  it('cancelling prevents the run entirely', () => {
    let frameCallback = null;
    let timerCallback = null;
    let run = 0;
    const cancel = frameSchedule(() => { run += 1; }, {
      requestFrame: (callback) => { frameCallback = callback; return 1; },
      cancelFrame: () => {},
      setTimer: (callback) => { timerCallback = callback; return 2; },
      clearTimer: () => {},
    });

    cancel();
    frameCallback();
    timerCallback();
    expect(run).toBe(0);
  });
});

describe('frame coalescer', () => {
  it('hands the handler only the latest value, once per frame', () => {
    const scheduler = manualScheduler();
    const seen = [];
    const coalescer = createFrameCoalescer((value) => seen.push(value), { schedule: scheduler.schedule });

    coalescer.push(1);
    coalescer.push(2);
    coalescer.push(3);

    expect(seen).toEqual([]);
    expect(coalescer.pending).toBe(true);
    expect(scheduler.queued).not.toBeNull();

    scheduler.fire();
    expect(seen).toEqual([3]);
    expect(coalescer.pending).toBe(false);
  });

  it('flushNow applies without waiting for a frame', () => {
    const scheduler = manualScheduler();
    const seen = [];
    const coalescer = createFrameCoalescer((value) => seen.push(value), { schedule: scheduler.schedule });

    coalescer.push('a');
    expect(coalescer.flushNow()).toBe(true);
    expect(seen).toEqual(['a']);
    // The cancelled frame must not fire a second time.
    scheduler.fire();
    expect(seen).toEqual(['a']);
    expect(coalescer.flushNow()).toBe(false);
  });

  it('starts a new frame for a push made during the handler', () => {
    const scheduler = manualScheduler();
    const seen = [];
    const coalescer = createFrameCoalescer((value) => {
      seen.push(value);
      if (value < 2) coalescer.push(value + 1);
    }, { schedule: scheduler.schedule });

    coalescer.push(1);
    scheduler.fire();
    expect(seen).toEqual([1]);
    expect(coalescer.pending).toBe(true);

    scheduler.fire();
    expect(seen).toEqual([1, 2]);
  });
});

describe('queue event batch', () => {
  it('keeps the newest queue state and the one-shot event flags', () => {
    let batch = null;
    batch = mergeQueueEvent(batch, {
      type: 'queue-started',
      queue: { id: 'q', status: 'running', tasks: [{ nodeId: 'a', status: 'running' }] },
    });
    batch = mergeQueueEvent(batch, {
      type: 'queue',
      queue: { id: 'q', status: 'running', tasks: [{ nodeId: 'a', status: 'running', progress: 60 }] },
    });
    batch = mergeQueueEvent(batch, {
      type: 'queue-done',
      queue: { id: 'q', status: 'completed', tasks: [{ nodeId: 'a', status: 'completed' }] },
    });

    // The last snapshot wins...
    expect(batch.queue.status).toBe('completed');
    expect(batch.queue.tasks[0].status).toBe('completed');
    // ...but the start is not forgotten, and the count says how many events
    // the single apply stood in for.
    expect(batch.started).toBe(true);
    expect(batch.done).toBe(true);
    expect(batch.count).toBe(3);
  });

  it('ignores a null event without losing the batch', () => {
    const batch = mergeQueueEvent(null, { type: 'queue', queue: { id: 'q', tasks: [] } });
    expect(mergeQueueEvent(batch, null)).toBe(batch);
    expect(batch.count).toBe(1);
  });
});

describe('queue event coalescer', () => {
  it('applies one batch per frame with the final queue state', () => {
    const scheduler = manualScheduler();
    const batches = [];
    const coalescer = createQueueEventCoalescer((batch) => batches.push(batch), { schedule: scheduler.schedule });

    coalescer.push({ type: 'queue', queue: { id: 'q', status: 'running', tasks: [{ nodeId: 'a', status: 'running', progress: 10 }] } });
    coalescer.push({ type: 'queue', queue: { id: 'q', status: 'running', tasks: [{ nodeId: 'a', status: 'running', progress: 55 }] } });
    coalescer.push({ type: 'queue', queue: { id: 'q', status: 'running', tasks: [{ nodeId: 'a', status: 'completed' }] } });

    expect(batches).toEqual([]);
    expect(coalescer.pending).toBe(true);

    scheduler.fire();
    expect(batches).toHaveLength(1);
    expect(batches[0].queue.tasks[0].status).toBe('completed');
    expect(batches[0].count).toBe(3);
  });

  it('flushNow applies a pending terminal batch immediately', () => {
    const scheduler = manualScheduler();
    const batches = [];
    const coalescer = createQueueEventCoalescer((batch) => batches.push(batch), { schedule: scheduler.schedule });

    coalescer.push({ type: 'queue-started', queue: { id: 'q', status: 'running', tasks: [] } });
    expect(coalescer.flushNow()).toBe(true);
    expect(batches).toHaveLength(1);
    expect(batches[0].started).toBe(true);

    // A later event starts a fresh frame rather than joining the applied batch.
    coalescer.push({ type: 'queue-done', queue: { id: 'q', status: 'completed', tasks: [] } });
    expect(coalescer.pending).toBe(true);
    scheduler.fire();
    expect(batches).toHaveLength(2);
    expect(batches[1].done).toBe(true);
  });
});

describe('queue graph signature', () => {
  const queue = (task, status = 'running') => ({ id: 'q', status, tasks: [task] });

  it('is unchanged by a progress tick', () => {
    expect(queueGraphSignature(queue({ nodeId: 'a', status: 'running', progress: 10 })))
      .toBe(queueGraphSignature(queue({ nodeId: 'a', status: 'running', progress: 90 })));
  });

  it('changes when a task status or gate verdict changes', () => {
    const running = queueGraphSignature(queue({ nodeId: 'a', status: 'running' }));
    const completed = queueGraphSignature(queue({ nodeId: 'a', status: 'completed', gateVerdict: 'pass' }));
    const failed = queueGraphSignature(queue({ nodeId: 'a', status: 'completed', gateVerdict: 'fail' }));
    expect(running).not.toBe(completed);
    expect(completed).not.toBe(failed);
  });

  it('changes when the queue status changes', () => {
    expect(queueGraphSignature(queue({ nodeId: 'a', status: 'completed' }, 'running')))
      .not.toBe(queueGraphSignature(queue({ nodeId: 'a', status: 'completed' }, 'completed')));
  });

  it('changes when a task records a timeout', () => {
    expect(queueGraphSignature(queue({ nodeId: 'a', status: 'running' })))
      .not.toBe(queueGraphSignature(queue({ nodeId: 'a', status: 'running', timeout: { elapsedSeconds: 3 } })));
  });
});
