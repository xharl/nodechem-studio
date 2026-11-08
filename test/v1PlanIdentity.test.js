import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseProjectText } from '../src/shared/projectSchema.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';

/**
 * The migration contract (RFC 0001).
 *
 * Every shipped example is still a schemaVersion 1 file — one graph, no flows,
 * no datasets — and that is exactly the shape a user's existing project has.
 * Opening one must plan the same tasks, the same input text and the same
 * ordering edges as it did before flows existed, or the refactor silently moved
 * somebody's runs.
 *
 * The golden file was generated from `main` before the branch and re-checked
 * against it after: the two plans were identical for all five examples.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/v1-plan-golden.json'), 'utf8'));

const hash = (text) => crypto.createHash('sha256').update(text || '').digest('hex').slice(0, 16);

describe('schema v1 projects plan identically under schema v2', () => {
  for (const [file, expected] of Object.entries(GOLDEN)) {
    it(`${file}`, () => {
      const text = fs.readFileSync(path.join(ROOT, 'examples', file), 'utf8');
      const parsed = parseProjectText(text);
      expect(parsed.errors, JSON.stringify(parsed.errors)).toEqual([]);
      expect(parsed.project.schemaVersion).toBe(2);
      expect(parsed.migrated).toBe(true);

      const plan = buildWorkflowPlan(parsed.project);
      expect(plan.tasks.map((task) => ({
        id: task.nodeId,
        type: task.type,
        executable: task.executable,
        inputHash: hash(task.inputText),
      }))).toEqual(expected.tasks);
      expect(plan.edges.map((edge) => `${edge.from}->${edge.to}:${edge.type}`)).toEqual(expected.edges);
      // A migrated project keeps bare task ids: no record segment is invented.
      expect(plan.tasks.every((task) => !task.recordId)).toBe(true);
    });
  }
});
