import { describe, expect, it } from 'vitest';

import { DEFAULT_RUN_OUTPUT_LIMIT, createRunOutputBuffer } from '../src/renderer/runOutputBuffer.js';

/**
 * Issue 374 — the run log.
 *
 * `appendRunOutput` rebuilt a 60 kB string and reassigned `textContent` per
 * output chunk. These tests pin the buffer that replaced it: appends stay cheap
 * until a flush, the retained text stays bounded, and the caller is told
 * exactly which characters to remove from the front of the element.
 */

describe('run output buffer', () => {
  it('holds chunks until a flush and returns them as one append', () => {
    const log = createRunOutputBuffer();
    log.append('first ');
    log.append('second');
    log.append(' third');

    expect(log.length).toBe(18);
    expect(log.flush()).toEqual({ append: 'first second third', dropped: 0 });
    // A second flush has nothing left to paint.
    expect(log.flush()).toEqual({ append: '', dropped: 0 });
    expect(log.text).toBe('first second third');
  });

  it('keeps only the newest characters past the limit', () => {
    const log = createRunOutputBuffer({ limit: 12 });
    log.append('12345678');
    log.flush();

    const result = log.flush();
    expect(result).toEqual({ append: '', dropped: 0 });
    expect(log.text).toBe('12345678');

    log.append('abcdef');
    // 8 retained + 6 new − 12 limit = 2 characters fall off the front.
    expect(log.flush()).toEqual({ append: 'abcdef', dropped: 2 });
    expect(log.text).toBe('345678abcdef');
    expect(log.text).toHaveLength(12);
  });

  it('drops the whole retained head and the over-long part of a chunk', () => {
    const log = createRunOutputBuffer({ limit: 10 });
    log.append('0123456789');
    log.flush();

    log.append('ABCDEFGHIJKLMN');
    const result = log.flush();
    // Everything retained is dropped, and the chunk keeps only its last 10.
    expect(result).toEqual({ append: 'EFGHIJKLMN', dropped: 10 });
    expect(log.text).toBe('EFGHIJKLMN');
  });

  it('keeps a single oversized chunk to the limit', () => {
    const log = createRunOutputBuffer({ limit: 10 });
    log.append('0123456789ABCDEFGHIJ');
    expect(log.flush()).toEqual({ append: 'ABCDEFGHIJ', dropped: 0 });
    expect(log.text).toBe('ABCDEFGHIJ');
  });

  it('reports committed and pending characters separately', () => {
    const log = createRunOutputBuffer();
    log.append('alpha');
    expect(log.retainedLength).toBe(0);
    expect(log.length).toBe(5);
    log.flush();
    log.append(' beta');
    expect(log.retainedLength).toBe(5);
    expect(log.length).toBe(10);
    // The text getter includes pending chunks, so a reader never sees a stale log.
    expect(log.text).toBe('alpha beta');
  });

  it('reset discards pending output and starts a fresh log', () => {
    const log = createRunOutputBuffer();
    log.append('old');
    log.flush();
    log.append('unflushed');

    expect(log.reset('Starting local runner…\n')).toBe('Starting local runner…\n');
    expect(log.length).toBe('Starting local runner…\n'.length);
    expect(log.flush()).toEqual({ append: '', dropped: 0 });
    expect(log.text).toBe('Starting local runner…\n');
  });

  it('never exceeds the default 60 kB limit across many frames', () => {
    const log = createRunOutputBuffer();
    const chunk = 'x'.repeat(4000);
    for (let frame = 0; frame < 40; frame += 1) {
      log.append(chunk);
      const { append, dropped } = log.flush();
      expect(append.length + dropped).toBeGreaterThan(0);
      expect(log.text.length).toBeLessThanOrEqual(DEFAULT_RUN_OUTPUT_LIMIT);
    }
    expect(log.text).toHaveLength(DEFAULT_RUN_OUTPUT_LIMIT);
  });
});
