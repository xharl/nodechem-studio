import { describe, expect, it } from 'vitest';

import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';
import { taskFigures } from '../src/shared/figures/report.js';

/**
 * The report may show pictures, but only pictures it can derive from the record.
 * These tests pin the contract: a figure names its parameters, a missing input
 * is stated rather than hidden, the document stays script-free and network-free,
 * and the size budget is enforced rather than hoped for.
 */

function queueWith(tasks) {
  return {
    id: 'q-figures',
    flowId: 'main',
    projectName: 'Figure fixture',
    status: 'completed',
    createdAt: '2026-11-08T12:00:00.000Z',
    finishedAt: '2026-11-08T12:10:00.000Z',
    tasks,
  };
}

const irRecord = {
  id: 'run-freq',
  status: 'completed',
  engine: 'gaussian',
  parsed: {
    normalModesMeta: {
      frequencies: [1500, 3000, 3700],
      irIntensities: [30, 10, 55],
    },
    orbitals: {
      manifolds: {
        alpha: { occupied: [-0.62, -0.5], virtual: [-0.05, 0.02] },
        beta: null,
      },
    },
  },
};

function oneTask(record = irRecord) {
  return {
    queue: queueWith([
      { nodeId: 'freq', runId: 'run-freq', title: 'Frequency block', status: 'completed' },
    ]),
    records: { 'run-freq': record },
  };
}

describe('report figures', () => {
  it('draws the spectra and levels a run printed, with their parameters', () => {
    const { queue, records } = oneTask();
    const model = buildWorkflowReport(queue, records, { generatedAt: '2026-11-08T12:11:00.000Z' });
    const entries = model.figures.byTask.freq || [];
    const keys = entries.map((entry) => entry.key);
    expect(keys).toContain('ir');
    expect(keys).toContain('levels');

    const ir = entries.find((entry) => entry.key === 'ir');
    expect(ir.caption).toContain('FWHM 12 cm⁻¹');
    expect(ir.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(ir.svg.length).toBeGreaterThan(500);

    const html = workflowReportHtml(model);
    expect(html).toContain('data-figure="ir"');
    expect(html).toContain('data-figure="graph"');
    expect(html).toContain('figure ');
  });

  it('names a figure it could not build instead of dropping it', () => {
    const { queue, records } = oneTask();
    const model = buildWorkflowReport(queue, records, {
      generatedAt: '2026-11-08T12:11:00.000Z',
      figureLevel: 'surfaces',
    });
    const html = workflowReportHtml(model);
    expect(html).toContain('contour figure not available: no cube file in the run folder');
  });

  it('slices a cube volume when one is supplied', () => {
    const n = 12;
    const values = new Float64Array(n * n * n);
    for (let k = 0; k < n; k += 1) {
      for (let j = 0; j < n; j += 1) {
        for (let i = 0; i < n; i += 1) {
          const x = i - n / 2;
          const y = j - n / 2;
          values[(k * n + j) * n + i] = (x / 4) * Math.exp(-(x * x + y * y) / 18);
        }
      }
    }
    const volume = { values, origin: [-1.8, -1.8, -1.8], step: [0.3, 0.3, 0.3], counts: [n, n, n], axisAligned: true };
    const { queue, records } = oneTask();
    const model = buildWorkflowReport(queue, records, {
      generatedAt: '2026-11-08T12:11:00.000Z',
      figureLevel: 'surfaces',
      volumes: { freq: volume },
    });
    const contour = (model.figures.byTask.freq || []).find((entry) => entry.key === 'contour');
    expect(contour).toBeTruthy();
    expect(contour.svg).toMatch(/\/ Å/);
    expect(contour.caption).toContain('plane');
  });

  it('projects an isosurface when meshes are supplied', () => {
    // Two triangles, positions and normals per vertex in triangle order.
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      1, 0, 0, 1, 1, 0, 0, 1, 0,
    ]);
    const normals = new Float32Array([
      0, 0, 1, 0, 0, 1, 0, 0, 1,
      0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]);
    const { queue, records } = oneTask();
    const model = buildWorkflowReport(queue, records, {
      generatedAt: '2026-11-08T12:11:00.000Z',
      figureLevel: 'surfaces',
      surfaces: { freq: { iso: 0.02, meshes: [{ positions, normals, sign: 1 }] } },
    });
    const entry = (model.figures.byTask.freq || []).find((item) => item.key === 'surface');
    expect(entry).toBeTruthy();
    expect(entry.caption).toContain('iso 0.020');
    expect(workflowReportHtml(model)).toContain('data-figure="surface"');
  });

  it('refuses to draw a rotated cube as an axis-aligned plane', () => {
    const { queue, records } = oneTask();
    const model = buildWorkflowReport(queue, records, {
      generatedAt: '2026-11-08T12:11:00.000Z',
      figureLevel: 'surfaces',
      volumes: {
        freq: { values: new Float64Array(8), origin: [0, 0, 0], step: [1, 1, 1], counts: [2, 2, 2], axisAligned: false },
      },
    });
    const html = workflowReportHtml(model);
    expect(html).toContain('the cube axes are rotated');
  });

  it('honours the size budget and says what it dropped', () => {
    const { queue, records } = oneTask();
    const model = buildWorkflowReport(queue, records, {
      generatedAt: '2026-11-08T12:11:00.000Z',
      figureBudgetBytes: 3000,
    });
    expect(model.figures.dropped.length).toBeGreaterThan(0);
    expect(workflowReportHtml(model)).toContain('Figures omitted to keep the document within its size budget');
  });

  it('can be switched off entirely', () => {
    const { queue, records } = oneTask();
    const model = buildWorkflowReport(queue, records, {
      generatedAt: '2026-11-08T12:11:00.000Z',
      figureLevel: 'none',
    });
    expect(model.figures.level).toBe('none');
    expect(Object.keys(model.figures.byTask)).toHaveLength(0);
    expect(workflowReportHtml(model)).not.toContain('<figure');
  });

  it('stays script-free, network-free and deterministic', () => {
    const { queue, records } = oneTask();
    const options = { generatedAt: '2026-11-08T12:11:00.000Z' };
    const first = workflowReportHtml(buildWorkflowReport(queue, records, options));
    const second = workflowReportHtml(buildWorkflowReport(queue, records, options));
    expect(first).toBe(second);
    expect(first).not.toMatch(/<script/i);
    expect(first).not.toMatch(/https?:\/\//i);
    expect(first).not.toMatch(/\b(?:href|src)="(?!\#)/i);
  });

  it('returns nothing for a record with no printable spectra', () => {
    const figures = taskFigures({ id: 'x', parsed: {} });
    expect(figures.every((entry) => entry.figure === null)).toBe(true);
  });
});
