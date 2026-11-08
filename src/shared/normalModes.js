/**
 * Normal-mode displacement blocks from a Gaussian frequency job.
 *
 * Gaussian prints the modes in blocks of three (older) or five (G16), each
 * block as:
 *
 *        Frequencies ---    53.1981   84.7415  149.4005  179.3403  263.3734
 *     Reduced masses ---     3.2266    2.4837    2.0822    3.3848    3.2244
 *    Force constants --- ...
 *     IR Intensities --- ...
 *    Coord Atom Element:
 *      1     1     6          0.00000  -0.00000  -0.00000  -0.10482   0.11959
 *      2     1     6          0.00000   0.00000  -0.00000  -0.01698  -0.04618
 *
 * The first three columns are the mode number *within the block*, the atom
 * index and the atomic number; the rest are three displacement components per
 * atom, repeated once per mode in the block.
 *
 * Nothing is invented: a block whose vectors do not cover every atom is dropped
 * (and counted in `incomplete`), and an output without displacement blocks
 * returns `null` rather than an empty mode list.
 */

const NUMBER = /-?\d+\.\d+/g;
// Coordinate rows start with three integers (mode, atom, atomic number) before
// the decimal displacement components, so they need their own tokeniser.
const ROW_NUMBER = /-?\d+(?:\.\d+)?/g;

function numbersIn(line) {
  return (line.match(NUMBER) || []).map(Number);
}

function rowNumbers(line) {
  return (line.match(ROW_NUMBER) || []).map(Number);
}

/** Every "… ---" line that starts a mode block, with its column count. */
function modeBlockStarts(lines) {
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*Frequencies\s*---/.test(lines[index])) starts.push(index);
  }
  return starts;
}

function valueLine(lines, start, pattern) {
  for (let index = start; index < Math.min(lines.length, start + 8); index += 1) {
    if (pattern.test(lines[index])) return numbersIn(lines[index]);
  }
  return [];
}

/**
 * Parse every displacement block.
 *
 * Returns `{ frequencies, displacements, reducedMasses, forceConstants,
 * irIntensities, atomCount, incomplete }` where `displacements[i]` is an array
 * of `{ x, y, z }` per atom, or `null` when the output has no such blocks.
 */
export function parseNormalModes(text, { maxAtoms = 2000 } = {}) {
  const lines = String(text ?? '').split(/\r\n|\n|\r/);
  const starts = modeBlockStarts(lines);
  if (starts.length === 0) return null;

  const frequencies = [];
  const reducedMasses = [];
  const forceConstants = [];
  const irIntensities = [];
  const displacements = [];
  let atomCount = 0;
  let incomplete = 0;

  for (const start of starts) {
    const blockFrequencies = numbersIn(lines[start]);
    if (blockFrequencies.length === 0) continue;
    const blockCount = blockFrequencies.length;
    const masses = valueLine(lines, start, /^\s*Reduced masses\s*---/);
    const constants = valueLine(lines, start, /^\s*Force constants\s*---/);
    const intensities = valueLine(lines, start, /^\s*IR Intensities\s*---/);

    // Find the coordinate header that belongs to this block.
    let header = -1;
    for (let index = start + 1; index < Math.min(lines.length, start + 60); index += 1) {
      if (/^\s*Coord Atom Element/.test(lines[index])) { header = index; break; }
      if (/^\s*Frequencies\s*---/.test(lines[index])) break;
    }

    // Gaussian prints one line per (component, atom): the first column is the
    // component (1 = x, 2 = y, 3 = z), the second the atom index, and the
    // numbers after the element column are that component for every mode in the
    // block. Three lines per atom, in component order.
    const blockVectors = Array.from({ length: blockCount }, () => []);
    if (header !== -1) {
      const byAtom = new Map();
      for (let index = header + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.trim() === '') break;
        if (/^\s*[A-Za-z]/.test(line)) break;
        const values = rowNumbers(line);
        if (values.length < 4) break;
        const component = Math.round(values[0]);
        const atom = Math.round(values[1]);
        const modeValues = values.slice(3);
        if (component < 1 || component > 3 || atom < 1) break;
        // A block lists one number per mode; anything else is not this format.
        if (modeValues.length !== blockCount) break;
        if (!byAtom.has(atom)) byAtom.set(atom, {});
        const entry = byAtom.get(atom);
        if (entry[component]) break;
        entry[component] = modeValues;
        if (atom > atomCount) atomCount = atom;
      }
      for (const [atom, entry] of byAtom) {
        if (!entry[1] || !entry[2] || !entry[3]) continue;
        for (let mode = 0; mode < blockCount; mode += 1) {
          blockVectors[mode][atom - 1] = { x: entry[1][mode], y: entry[2][mode], z: entry[3][mode] };
        }
      }
    }

    blockFrequencies.forEach((frequency, offset) => {
      const vectors = blockVectors[offset];
      // `every` skips holes in a sparse array, and a missing atom is exactly a
      // hole — so the check has to walk the indices explicitly.
      const complete = atomCount > 0 && vectors.length === atomCount
        && Array.from({ length: atomCount }, (_, atom) => Boolean(vectors[atom])).every(Boolean);
      frequencies.push(frequency);
      reducedMasses.push(Number.isFinite(masses[offset]) ? masses[offset] : null);
      forceConstants.push(Number.isFinite(constants[offset]) ? constants[offset] : null);
      irIntensities.push(Number.isFinite(intensities[offset]) ? intensities[offset] : null);
      if (complete && atomCount <= maxAtoms) {
        displacements.push(vectors.map((vector) => ({ ...vector })));
      } else {
        displacements.push(null);
        if (!complete) incomplete += 1;
      }
    });
  }

  if (frequencies.length === 0) return null;
  return {
    frequencies,
    displacements,
    reducedMasses,
    forceConstants,
    irIntensities,
    atomCount: atomCount || null,
    incomplete,
    modeCount: frequencies.length,
  };
}

/**
 * The shape `describeModes` wants: only the modes with a full vector set, in
 * the same order, so an index cannot silently shift between frequencies and
 * displacements.
 */
export function animatableModes(parsed) {
  if (!parsed || !Array.isArray(parsed.frequencies) || !Array.isArray(parsed.displacements)) return null;
  const frequencies = [];
  const displacements = [];
  parsed.frequencies.forEach((frequency, index) => {
    const vectors = parsed.displacements[index];
    // Dense check: `every` would skip a hole left by a missing atom.
    const dense = Array.isArray(vectors) && vectors.length > 0
      && Array.from({ length: vectors.length }, (_, atom) => Boolean(vectors[atom])).every(Boolean);
    if (dense) {
      frequencies.push(frequency);
      displacements.push(vectors);
    }
  });
  if (frequencies.length === 0) return null;
  return { frequencies, displacements };
}
