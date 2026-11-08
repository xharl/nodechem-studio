/**
 * Figure registry: one entry point for both surfaces.
 *
 * `figure(kind, data, options)` is what the report and the app call; the mapping
 * to a concrete builder lives here so a new figure type is one line plus its
 * module, and the report's figure names stay a closed set a test can enumerate.
 */

import { contourFigure } from './contour.js';
import { convergenceFigure } from './convergence.js';
import { correlationFigure } from './correlation.js';
import { flowGraphFigure } from './dag.js';
import { reactionEnergyFigure } from './energy.js';
import { orbitalLevelsFigure } from './levels.js';
import {
  fromEcd, fromNmr, fromRaman, fromUvVis, fromVcd, spectrumFigure,
} from './spectra.js';

export const FIGURE_KINDS = Object.freeze([
  'spectrum:ir', 'spectrum:raman', 'spectrum:uvvis', 'spectrum:vcd', 'spectrum:ecd', 'spectrum:nmr',
  'levels', 'energy', 'convergence', 'correlation', 'contour', 'graph',
]);

const BUILDERS = {
  'spectrum:ir': (data, options) => spectrumFigure({ ...data, ...options, kind: 'ir' }),
  'spectrum:raman': (data) => fromRaman(data),
  'spectrum:uvvis': (data) => fromUvVis(data),
  'spectrum:vcd': (data) => fromVcd(data),
  'spectrum:ecd': (data) => fromEcd(data),
  'spectrum:nmr': (data, options) => fromNmr(data, options),
  levels: (data) => orbitalLevelsFigure(data),
  energy: (data) => reactionEnergyFigure(data),
  convergence: (data) => convergenceFigure(data),
  correlation: (data) => correlationFigure(data),
  contour: (data) => contourFigure(data),
  graph: (data) => flowGraphFigure(data),
};

/**
 * Builds a figure. Returns `null` when the data cannot support one — the caller
 * prints `figure not available: <reason>` rather than an empty frame.
 */
export function figure(kind, data, options = {}) {
  const builder = BUILDERS[kind];
  if (!builder) throw new Error(`unknown figure kind: ${kind}`);
  return builder(data, options) || null;
}

export {
  contourFigure, convergenceFigure, correlationFigure, flowGraphFigure, orbitalLevelsFigure,
  reactionEnergyFigure, spectrumFigure,
};
export { fromEcd, fromNmr, fromRaman, fromUvVis, fromVcd };
export { marchingSquares, sliceOf } from './contour.js';
