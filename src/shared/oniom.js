/**
 * ONIOM result extraction (issue 67).
 *
 * Gaussian prints one energy block per ONIOM evaluation:
 *
 * ```text
 *  ONIOM: gridpoint  1 method:  low   system:  model energy:     0.346273670054
 *  ONIOM: gridpoint  2 method:  high  system:  model energy: -1361.792785320875
 *  ONIOM: gridpoint  3 method:  low   system:  real  energy:     0.398717231287
 *  ONIOM: extrapolated energy =   -1361.740341759642
 * ```
 *
 * The extrapolated energy is `E(high, model) + E(low, real) - E(low, model)`.
 * An optimisation prints one such block per step; this reader keeps the last
 * block (the final geometry) and counts how many were printed. It also reads
 * the layer counts (`NAtoms= ... NQM= ... NMMI= ...`), the cuts that define
 * link atoms, the charge/multiplicity line for each layer calculation, and the
 * route's `ONIOM(high:low)` layer methods.
 *
 * A cut line is recorded as printed. The reader does not invent a link atom:
 * Gaussian writes `Cut between C /H 9 and C 10 factor= ...`, and the card says
 * that the link is the `/H 9` side rather than rebuilding the topology.
 */

import { toLines } from './lines.js';

const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;

const numbers = (text) => (String(text || '').match(NUMBER) || []).map(Number);

function splitTopLevel(value, separator = ':') {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function routeLayers(route) {
  const text = String(route || '');
  const keyword = text.toLowerCase().indexOf('oniom');
  if (keyword === -1) return null;
  const open = text.indexOf('(', keyword);
  if (open === -1) return null;
  // Nested parentheses are possible in layer methods (for example a TD
  // keyword), so balance them instead of taking the first closing paren.
  let depth = 0;
  let end = -1;
  for (let index = open + 1; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')') {
      if (depth === 0) { end = index; break; }
      depth -= 1;
    }
  }
  if (end === -1) return null;
  const body = text.slice(open + 1, end);
  const parts = splitTopLevel(body);
  if (parts.length === 2) return { high: parts[0], low: parts[1] };
  if (parts.length === 3) return { high: parts[0], medium: parts[1], low: parts[2] };
  return { high: parts[0] || null, low: parts.at(-1) || null };
}

function parseChargeLine(line) {
  const match = line.match(/Charge\s*=\s*(-?\d+)\s+Multiplicity\s*=\s*(\d+)\s+for\s+(low|high|medium)\s+level calculation on\s+(real|model)\s+system/i);
  if (!match) return null;
  return {
    level: match[3].toLowerCase(),
    system: match[4].toLowerCase(),
    charge: Number(match[1]),
    multiplicity: Number(match[2]),
  };
}

function parseDipole(lines, index) {
  const line = lines[index + 1] || '';
  const match = line.match(/X=\s*(-?\d+(?:\.\d+)?)\s+Y=\s*(-?\d+(?:\.\d+)?)\s+Z=\s*(-?\d+(?:\.\d+)?)\s+Tot=\s*(-?\d+(?:\.\d+)?)/i);
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]), total: Number(match[4]), units: 'debye' };
}

/**
 * Parse the ONIOM blocks out of a Gaussian output. Returns null unless the
 * text actually carries ONIOM evidence; a non-ONIOM log is not zero-filled.
 */
export function parseOniom(text) {
  const lines = toLines(text);
  let route = null;
  for (const line of lines) {
    if (/^\s*#/.test(line) && /oniom\s*\(/i.test(line)) {
      route = line.trim();
      break;
    }
  }

  const cuts = [];
  const seenCuts = new Set();
  const charges = {};
  let layerCounts = null;
  let dipole = null;
  const blocks = [];
  let current = null;

  const finish = () => {
    if (!current) return;
    if (current.gridpoints.length > 0 || current.extrapolatedEnergyHartree != null) blocks.push(current);
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const gridpoint = line.match(/ONIOM:\s+gridpoint\s+(\d+)\s+method:\s+(\S+)\s+system:\s+(\S+)\s+energy:\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/i);
    if (gridpoint) {
      if (!current) current = { gridpoints: [], extrapolatedEnergyHartree: null };
      current.gridpoints.push({
        index: Number(gridpoint[1]),
        method: gridpoint[2].toLowerCase(),
        system: gridpoint[3].toLowerCase(),
        energyHartree: Number(gridpoint[4]),
      });
      continue;
    }
    const extrapolated = line.match(/ONIOM:\s+extrapolated energy\s*=\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/i);
    if (extrapolated) {
      if (!current) current = { gridpoints: [], extrapolatedEnergyHartree: null };
      current.extrapolatedEnergyHartree = Number(extrapolated[1]);
      finish();
      continue;
    }
    const cut = line.match(/ONIOM:\s+Cut between\s+(\S+)\s*\/\s*(\S+)\s+(\d+)\s+and\s+(\S+)\s+(\d+)\s+factor=\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/i);
    if (cut) {
      const record = {
        highElement: cut[1],
        linkElement: cut[2],
        linkAtom: Number(cut[3]),
        lowElement: cut[4],
        lowAtom: Number(cut[5]),
        factors: [Number(cut[6]), Number(cut[7])],
      };
      const key = `${record.linkElement}:${record.linkAtom}-${record.lowElement}:${record.lowAtom}`;
      if (!seenCuts.has(key)) {
        seenCuts.add(key);
        cuts.push(record);
      }
      continue;
    }
    const counts = line.match(/NAtoms=\s*(\d+)\s+NQM=\s*(\d+).*?NMMI=\s*(\d+)/i);
    if (counts) {
      layerCounts = {
        total: Number(counts[1]),
        high: Number(counts[2]),
        low: Number(counts[3]),
      };
      continue;
    }
    const charge = parseChargeLine(line);
    if (charge) {
      charges[`${charge.level}-${charge.system}`] = {
        charge: charge.charge,
        multiplicity: charge.multiplicity,
      };
      continue;
    }
    if (/ONIOM:\s+Dipole moment \(Debye\):/i.test(line)) {
      dipole = parseDipole(lines, index) || dipole;
    }
  }
  finish();

  if (blocks.length === 0 && cuts.length === 0 && !route) return null;
  const final = blocks.at(-1) || null;
  const highModel = final?.gridpoints.find((point) => point.method === 'high' && point.system === 'model');
  const lowModel = final?.gridpoints.find((point) => point.method === 'low' && point.system === 'model');
  const lowReal = final?.gridpoints.find((point) => point.method === 'low' && point.system === 'real');
  const reconstructed = highModel && lowModel && lowReal
    ? highModel.energyHartree + lowReal.energyHartree - lowModel.energyHartree
    : null;
  const difference = reconstructed != null && final?.extrapolatedEnergyHartree != null
    ? final.extrapolatedEnergyHartree - reconstructed : null;

  return {
    route,
    layers: routeLayers(route),
    blocks: blocks.length,
    gridpoints: final?.gridpoints || [],
    extrapolatedEnergyHartree: final?.extrapolatedEnergyHartree ?? null,
    reconstructedEnergyHartree: reconstructed,
    reconstructionDifferenceHartree: difference,
    reconstructionOk: difference != null ? Math.abs(difference) < 5e-7 : null,
    cuts,
    layerCounts,
    charges,
    dipole,
    units: 'hartree',
    limitation: 'The extrapolated ONIOM energy is the reported total; a layer energy is a model/real '
      + 'ingredient, not a separately observable total. Link atoms are the cuts Gaussian printed.',
  };
}
