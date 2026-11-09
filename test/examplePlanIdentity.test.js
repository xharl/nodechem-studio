import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseProjectText } from '../src/shared/projectSchema.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';

/**
 * Behaviour neutrality across ADR 0001's schemaVersion 3 rename.
 *
 * The golden file was generated from the five shipped examples before the
 * rename and re-checked after it. Task ids, executable flags, input text and
 * ordering edges must be identical: the rename was supposed to change the
 * vocabulary of a block, never the input a block writes or the order it runs.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/example-plan-golden.json'), 'utf8'));

const hash = (text) => crypto.createHash('sha256').update(text || '').digest('hex').slice(0, 16);

describe('shipped examples keep their pre-rename plan under schema v3', () => {
  for (const [file, expected] of Object.entries(GOLDEN)) {
    it(`${file}`, () => {
      const text = fs.readFileSync(path.join(ROOT, 'examples', file), 'utf8');
      const parsed = parseProjectText(text);
      expect(parsed.errors, JSON.stringify(parsed.errors)).toEqual([]);
      expect(parsed.project.schemaVersion).toBe(3);
      expect(parsed.migrated).toBe(false);

      const plan = buildWorkflowPlan(parsed.project);
      expect(plan.tasks.map((task) => ({
        id: task.nodeId,
        type: task.type,
        executable: task.executable,
        inputHash: hash(task.inputText),
      }))).toEqual(expected.tasks);
      expect(plan.edges.map((edge) => `${edge.from}->${edge.to}:${edge.type}`)).toEqual(expected.edges);
      // A single-flow example keeps bare task ids: no record segment is invented.
      expect(plan.tasks.every((task) => !task.recordId)).toBe(true);
    });
  }
});
