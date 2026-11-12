import { describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';

/**
 * ADR 0003 §2.6 — a fixture is a recorded answer, not a hand-written one.
 *
 * Every file under `test/fixtures/chem/` must carry `_provenance` with the
 * interpreter and the date it was recorded. A fixture that drifts from the
 * script is a silent lie; this test makes at least the provenance impossible to
 * forget.
 */
describe('chemistry fixtures carry their provenance', () => {
  it('records the interpreter and the date for every fixture', async () => {
    const dir = new URL('./fixtures/chem/', import.meta.url);
    const files = (await fsp.readdir(dir)).filter((name) => name.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const answer = JSON.parse(await fsp.readFile(new URL(name, dir), 'utf8'));
      expect(answer._provenance, `${name} has no _provenance`).toBeTruthy();
      expect(answer._provenance.recordedWith, `${name} names no interpreter`).toBeTruthy();
      expect(answer._provenance.recordedAt, `${name} names no date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(answer.protocol).toBe('nodechem-chem/1');
      expect(typeof answer.op).toBe('string');
      expect(answer.ok).toBe(true);
    }
  });
});
