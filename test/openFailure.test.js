import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { openFailureMessage, readFailure } from '../src/shared/fsError.js';
import { parseProjectText } from '../src/shared/projectSchema.js';

/**
 * Issue 323 — the window refused to open a project and blamed something else.
 *
 * A 10,002-node file (one flow, over the 2000-node limit) opened with
 * "A project needs at least one flow." — a string from the delete-flow guard —
 * while `ncs validate` on the same bytes named `flows[0].nodes`. The schema knew
 * the reason; the open path threw it away.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const example = () => JSON.parse(readFileSync(path.join(root, 'examples', 'single-point.ncs'), 'utf8'));

/** The reported file: a valid project with 10,000 note blocks appended. */
function oversizedProject() {
  const project = example();
  const nodes = project.flows[0].nodes;
  for (let i = 0; i < 10000; i += 1) {
    nodes.push({
      id: `note-${i}`, type: 'note', title: `Note ${i}`, note: { text: 'x' }, x: 0, y: 0,
    });
  }
  return project;
}

describe('the reason a project file was refused (issue 323)', () => {
  it('reports the validator error that was hit, not a stand-in', () => {
    const parsed = parseProjectText(JSON.stringify(oversizedProject()));
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0]).toMatchObject({ path: 'flows[0].nodes' });

    const message = openFailureMessage('/cases/B21.ncs', { errors: parsed.errors });
    expect(message).toMatch(/^\/cases\/B21\.ncs: flows\[0\]\.nodes: must contain at most 2000 nodes\./);
    expect(message).not.toMatch(/needs at least one flow/);
  });

  it('keeps "needs at least one flow" for a project that has no flow', () => {
    const project = example();
    project.flows = [];
    const parsed = parseProjectText(JSON.stringify(project));
    expect(parsed.ok).toBe(false);

    expect(openFailureMessage('/cases/empty.ncs', { errors: parsed.errors }))
      .toBe('/cases/empty.ncs: flows: must contain at least one flow.');
  });

  it('counts the errors it did not print', () => {
    const errors = [
      { path: 'flows[0].nodes', message: 'must contain at most 2000 nodes.' },
      { path: 'flows[0].edges', message: 'must contain at most 4000 edges.' },
      { path: 'defaults.memory', message: 'must be a number.' },
    ];
    expect(openFailureMessage('p.ncs', { errors }))
      .toBe('p.ncs: flows[0].nodes: must contain at most 2000 nodes. · +2 more');
  });

  it('names a filesystem failure instead of a schema error', () => {
    const eisdir = Object.assign(new Error('EISDIR: illegal operation on a directory, read'), { code: 'EISDIR' });
    const enoent = Object.assign(new Error("ENOENT: no such file or directory, open '/x.ncs'"), { code: 'ENOENT' });

    expect(openFailureMessage('/tmp', { error: eisdir })).toBe('cannot read /tmp: is a directory');
    expect(openFailureMessage('/nope.ncs', { error: enoent })).toBe('cannot read /nope.ncs: not found');
    // No stack trace, no Node errno string.
    expect(openFailureMessage('/nope.ncs', { error: enoent })).not.toMatch(/ENOENT|at Object/);
  });

  it('is the same sentence the CLI uses for the same mistake', () => {
    const eacces = Object.assign(new Error('EACCES: permission denied, open /root/p.ncs'), { code: 'EACCES' });
    expect(readFailure('/root/p.ncs', eacces)).toBe('cannot read /root/p.ncs: permission denied');
  });
});
