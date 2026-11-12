import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  DEPICT_MAX_SVG_BYTES,
  depictCaption,
  depictFigureBlock,
  depictRequest,
  normalizeDepictResult,
  validateDepictSvg,
} from '../src/shared/chemDepict.js';
import { buildWorkflowReport, workflowReportHtml } from '../src/shared/workflowReport.js';
import { depictStructuresFor } from '../electron/runner/depictStructures.js';

/**
 * ADR 0003 §3.4 — depictions.
 *
 * An SVG is markup crossing into the report and the DOM, so the validator is
 * tested as a rejection list. The accepted answer is a real RDKit drawing.
 */

const fixture = JSON.parse(readFileSync(new URL('./fixtures/chem/depict.json', import.meta.url), 'utf8'));
const svg = fixture.result.svg;

describe('depict SVG validation', () => {
  it('accepts the recorded RDKit drawing', () => {
    expect(validateDepictSvg(svg)).toBe(svg.trim());
  });

  it('refuses script, event handlers, foreignObject, links and embedded content', () => {
    expect(() => validateDepictSvg('<svg><script>alert(1)</script></svg>')).toThrow(/script/);
    expect(() => validateDepictSvg('<svg onload="alert(1)"></svg>')).toThrow(/event-handler/);
    expect(() => validateDepictSvg('<svg><foreignObject></foreignObject></svg>')).toThrow(/foreignObject/);
    expect(() => validateDepictSvg('<svg><a href="https://example.test"></a></svg>')).toThrow(/hyperlink/);
    expect(() => validateDepictSvg('<svg><iframe src="x"></iframe></svg>')).toThrow(/embedded content/);
    expect(() => validateDepictSvg('<svg><image href="javascript:alert(1)"/></svg>')).toThrow(/javascript/);
  });

  it('refuses more than one root and an over-budget document', () => {
    expect(() => validateDepictSvg('<svg></svg><svg></svg>')).toThrow(/exactly one/);
    const huge = `<svg>${'x'.repeat(DEPICT_MAX_SVG_BYTES)}</svg>`;
    expect(() => validateDepictSvg(huge)).toThrow(/larger than/);
    expect(() => validateDepictSvg('')).toThrow(/no SVG/);
  });

  it('escapes a caption when it builds the figure block', () => {
    const block = depictFigureBlock(svg, 'A & B <C>');
    expect(block).toContain('A &amp; B &lt;C&gt;');
    expect(block).toContain('<svg');
  });
});

describe('depict request and answer', () => {
  it('clamps the canvas and keeps atom highlights', () => {
    const request = depictRequest({
      molecule: { atoms: [{ element: 'C', x: 0, y: 0, z: 0 }] },
      options: { width: 10, height: 4000, highlights: [0, 2, -1] },
    });
    expect(request.options.width).toBe(80);
    expect(request.options.height).toBe(1600);
    expect(request.options.highlights).toEqual([0, 2]);
  });

  it('reads the recorded answer and refuses an invalid one', () => {
    const result = normalizeDepictResult(fixture);
    expect(result.svg.startsWith('<svg')).toBe(true);
    expect(result.origin.method).toContain('CoordGen');
    expect(() => normalizeDepictResult({
      protocol: 'nodechem-chem/1', op: 'depict', ok: true, program: 'RDKit', version: 'x',
      result: { svg: '<svg onload="x"></svg>' },
    })).toThrow(/event-handler/);
  });

  it('captions with the legend, then the identity, never an empty string', () => {
    expect(depictCaption({ formula: 'C9H8O4', inchiKey: 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N' })).toContain('C9H8O4');
    expect(depictCaption({ formula: 'C9H8O4' }, 'aspirin')).toBe('aspirin');
    expect(depictCaption({})).toBe('Structure');
  });
});

describe('depictions in the report', () => {
  const queue = {
    id: 'q',
    projectName: 'Depict',
    status: 'completed',
    tasks: [{ nodeId: 'opt', type: 'calculate', title: 'Optimise', status: 'completed', runId: 'opt' }],
  };
  const records = { opt: { status: 'completed' } };

  it('embeds a validated figure at the basic level', () => {
    const model = buildWorkflowReport(queue, records, {
      structures: { opt: { svg, caption: 'Optimised structure' } },
    });
    const html = workflowReportHtml(model);
    expect(html).toContain('Structures');
    expect(html).toContain('Optimised structure');
    expect(html).toContain('<svg');
  });

  it('drops the section at figure level none, and without structures', () => {
    const none = workflowReportHtml(buildWorkflowReport(queue, records, {
      structures: { opt: { svg, caption: 'Optimised structure' } },
      figureLevel: 'none',
    }));
    expect(none).not.toContain('Structures');
    const absent = workflowReportHtml(buildWorkflowReport(queue, records));
    expect(absent).not.toContain('Structures');
  });
});

describe('report figure collection', () => {
  const tasks = [
    { nodeId: 'opt', title: 'Optimise', runId: 'opt' },
    { nodeId: 'no-geometry', title: 'Empty', runId: 'none' },
  ];
  const records = {
    opt: {
      title: 'Optimise',
      parsed: {
        charge: 0,
        multiplicity: 1,
        formula: 'C9H8O4',
        finalGeometry: { atoms: [{ element: 'C', x: 0, y: 0, z: 0 }] },
      },
    },
    none: { title: 'Empty', parsed: {} },
  };

  it('collects one validated figure per record and skips a record with no geometry', async () => {
    const runner = { run: async () => fixture };
    const structures = await depictStructuresFor({
      tasks, records, executable: 'fake', runner,
    });
    expect(Object.keys(structures)).toEqual(['opt']);
    expect(structures.opt.caption).toContain('C9H8O4');
    expect(structures.opt.svg.startsWith('<svg')).toBe(true);
  });

  it('returns null when no sidecar is named or every answer is refused', async () => {
    expect(await depictStructuresFor({ tasks, records, executable: '', runner: { run: async () => fixture } })).toBeNull();
    const refusing = { run: async () => { throw new Error('rdkit-missing'); } };
    expect(await depictStructuresFor({ tasks, records, executable: 'fake', runner: refusing })).toBeNull();
  });
});
