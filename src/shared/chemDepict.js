/**
 * ADR 0003 §3.7 — `depict`, a 2D structure for a report or an inspector.
 *
 * The sidecar draws; the app only validates and embeds. An SVG is markup, so it
 * crosses a trust boundary: one root `<svg>`, no scripts, no event attributes,
 * no foreign objects, and a byte cap. A refusal is shown as a sentence, never as
 * an empty frame that a reader could mistake for a structure.
 */

import { ChemError, chemOrigin, chemRequest, normalizeChemResponse } from './chemistry.js';

export const DEPICT_MAX_SVG_BYTES = 512 * 1024;
export const DEPICT_DEFAULT_WIDTH = 320;
export const DEPICT_DEFAULT_HEIGHT = 240;

export function depictRequest({ molecule, options = {} } = {}) {
  const width = Number.isFinite(Number(options.width)) ? Math.round(Number(options.width)) : DEPICT_DEFAULT_WIDTH;
  const height = Number.isFinite(Number(options.height)) ? Math.round(Number(options.height)) : DEPICT_DEFAULT_HEIGHT;
  const highlights = Array.isArray(options.highlights)
    ? options.highlights.filter((index) => Number.isInteger(index) && index >= 0).slice(0, 500)
    : [];
  return chemRequest({
    op: 'depict',
    molecule,
    options: {
      width: Math.min(1600, Math.max(80, width)),
      height: Math.min(1600, Math.max(80, height)),
      ...(highlights.length ? { highlights } : {}),
      ...(options.legend ? { legend: String(options.legend).slice(0, 120) } : {}),
    },
  });
}

/**
 * Validate an SVG string before it is embedded in the report or the DOM.
 *
 * This is deliberately a rejection list, not a sanitiser: silently rewriting
 * markup would let a hostile answer through in a form nobody tested.
 */
export function validateDepictSvg(svg) {
  if (typeof svg !== 'string' || svg.trim() === '') {
    throw new ChemError('bad-response', 'The depict answer carries no SVG.');
  }
  if (new TextEncoder().encode(svg).length > DEPICT_MAX_SVG_BYTES) {
    throw new ChemError('bad-response', `The depiction is larger than ${Math.round(DEPICT_MAX_SVG_BYTES / 1024)} KiB.`);
  }
  const text = svg.trim();
  if (!/^<svg[\s>]/i.test(text)) {
    throw new ChemError('bad-response', 'The depiction is not an <svg> document.');
  }
  if (/<\s*script[\s>]/i.test(text)) throw new ChemError('bad-response', 'The depiction contains a script element.');
  if (/<\s*foreignObject[\s>]/i.test(text)) throw new ChemError('bad-response', 'The depiction contains a foreignObject element.');
  if (/<\s*(iframe|object|embed)[\s>]/i.test(text)) throw new ChemError('bad-response', 'The depiction contains embedded content.');
  if (/\son[a-z]+\s*=/i.test(text)) throw new ChemError('bad-response', 'The depiction contains an event-handler attribute.');
  if (/javascript:/i.test(text)) throw new ChemError('bad-response', 'The depiction contains a javascript: URL.');
  if (/\bhref\s*=/i.test(text)) throw new ChemError('bad-response', 'The depiction contains a hyperlink.');
  if ((text.match(/<svg[\s>]/gi) || []).length !== 1) {
    throw new ChemError('bad-response', 'The depiction must have exactly one <svg> root.');
  }
  return text;
}

export function normalizeDepictResult(raw) {
  const answer = normalizeChemResponse(raw, { op: 'depict' });
  const result = answer.result;
  if (!result || typeof result !== 'object') {
    throw new ChemError('bad-response', 'The depict answer carries no result.');
  }
  const svg = validateDepictSvg(result.svg);
  const legend = result.legend === null || result.legend === undefined ? '' : String(result.legend).slice(0, 160);
  return {
    program: answer.program,
    version: answer.version,
    op: answer.op,
    options: answer.options,
    svg,
    legend,
    origin: chemOrigin(answer, { method: 'CoordGen + RDKit MolDraw2DSVG' }),
  };
}

/** A stable caption: the molecule and the set it came from, never a guess. */
export function depictCaption(identity = {}, legend = '') {
  const text = legend || [identity.formula, identity.inchiKey].filter(Boolean).join(' · ');
  return text || 'Structure';
}

/**
 * The figure block the report embeds. The caption is escaped by the report's
 * own helper; this function only refuses unsafe markup.
 */
export function depictFigureBlock(svg, caption) {
  const safe = validateDepictSvg(svg);
  const text = String(caption || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<figure class="structure">${safe}<figcaption>${text}</figcaption></figure>`;
}
