/**
 * ADR 0003 §3.4 — collect the 2D figures a report embeds.
 *
 * One sidecar call per record that still carries a geometry. A refusal drops
 * that figure only: the report keeps its tables and the missing picture is not
 * replaced by an empty frame. Bounded by a figure count and a byte budget so a
 * dataset with hundreds of records cannot turn a report into a sidecar sweep.
 */

import { depictRequest, normalizeDepictResult, DEPICT_MAX_SVG_BYTES } from '../../src/shared/chemDepict.js';
import { SidecarRunner } from './sidecarRunner.js';

const DEFAULT_MAX_FIGURES = 24;
const DEFAULT_BYTE_BUDGET = 4 * 1024 * 1024;

function atomsOf(record) {
  const parsed = record && typeof record === 'object' && record.parsed && typeof record.parsed === 'object'
    ? record.parsed : {};
  const atoms = parsed.finalGeometry?.atoms
    || parsed.geometry?.initial?.atoms
    || parsed.geometry?.atoms
    || (Array.isArray(parsed.coords) ? parsed.coords : null);
  if (!Array.isArray(atoms) || atoms.length === 0 || atoms.length > 1000) return null;
  return atoms.every((atom) => typeof atom?.element === 'string'
    && Number.isFinite(Number(atom.x)) && Number.isFinite(Number(atom.y)) && Number.isFinite(Number(atom.z)))
    ? atoms
    : null;
}

export async function depictStructuresFor({
  tasks = [],
  records = {},
  executable = '',
  script = '',
  maxFigures = DEFAULT_MAX_FIGURES,
  byteBudget = DEFAULT_BYTE_BUDGET,
  runner = null,
  timeoutMs = 20_000,
} = {}) {
  if (!String(executable || '').trim()) return null;
  const structures = {};
  let bytes = 0;
  let count = 0;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (count >= maxFigures || bytes >= byteBudget) break;
    const nodeId = String(task?.nodeId || '');
    if (!nodeId) continue;
    const record = (task?.runId && records[task.runId]) || records[nodeId] || null;
    const atoms = atomsOf(record);
    if (!atoms) continue;
    const parsed = record.parsed || {};
    try {
      const raw = await (runner || new SidecarRunner({ label: 'chemistry sidecar' })).run({
        executable,
        script,
        request: depictRequest({
          molecule: {
            title: record.title || task.title || nodeId,
            charge: Number.isInteger(parsed.charge) ? parsed.charge : 0,
            multiplicity: Number.isInteger(parsed.multiplicity) ? parsed.multiplicity : 1,
            atoms,
          },
          options: {
            width: 480,
            height: 320,
            legend: [record.title || task.title, parsed.formula].filter(Boolean).join(' · '),
          },
        }),
        timeoutMs,
      });
      const result = normalizeDepictResult(raw);
      const size = Buffer.byteLength(result.svg, 'utf8');
      if (bytes + size > byteBudget) break;
      // Bounded again on the way out: the validator allows 512 KiB per SVG, and
      // a figure set must stay within the report's own budget.
      if (size > DEPICT_MAX_SVG_BYTES) continue;
      structures[nodeId] = {
        svg: result.svg,
        caption: result.legend || [record.title || task.title, parsed.formula].filter(Boolean).join(' · ') || nodeId,
      };
      bytes += size;
      count += 1;
    } catch {
      // A refusal or a transport failure drops this figure, never the report.
    }
  }
  return count > 0 ? structures : null;
}
