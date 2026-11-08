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
    // G09 prints `Frequencies ---`, G16 A.03 `Frequencies --`: the dash count
    // is not a stable marker, the label is.
    if (/^\s*Frequencies\s*--+/.test(lines[index])) starts.push(index);
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

  // A log can print the same mode table twice, once per layout (an Opt Freq
  // prints it again after the optimisation, and a converted/merged log can
  // carry both). When a G16-shaped block exists, its vectors are the ones the
  // job printed last; reading both would double the mode list.
  const shapeOf = (start) => {
    for (let index = start + 1; index < Math.min(lines.length, start + 60); index += 1) {
      if (/^\s*Coord\s+Atom\s+Element/i.test(lines[index])) return 'components';
      if (/^\s*Atom\s+AN\b/i.test(lines[index])) return 'atoms';
      if (/^\s*Frequencies\s*--/.test(lines[index])) break;
    }
    return null;
  };
  const shapes = starts.map(shapeOf);
  // Only filter when a G16-shaped block is actually present; otherwise every
  // block is read with the legacy reader, including one whose header is missing.
  const preferAtoms = shapes.includes('atoms');

  const frequencies = [];
  const reducedMasses = [];
  const forceConstants = [];
  const irIntensities = [];
  const displacements = [];
  let atomCount = 0;
  let incomplete = 0;

  for (const [position, start] of starts.entries()) {
    if (preferAtoms && shapes[position] !== 'atoms') continue;
    const blockFrequencies = numbersIn(lines[start]);
    if (blockFrequencies.length === 0) continue;
    const blockCount = blockFrequencies.length;
    const masses = valueLine(lines, start, /^\s*Reduced masses\s*---/);
    const constants = valueLine(lines, start, /^\s*Force constants\s*---/);
    // `IR Intensities ---` (G09) vs `IR Inten    --` (G16 A.03).
    const intensities = valueLine(lines, start, /^\s*IR\s+Inten(?:sities)?\s*--+/);

    // Two displacement layouts exist in the wild, and they disagree about what
    // the columns mean:
    //
    //   G09  `Coord Atom Element:`  component atom Z   v1 v2 v3 …   (3 rows/atom)
    //   G16  `Atom  AN      X Y Z`  atom Z  x1 y1 z1  x2 y2 z2 …   (1 row/atom)
    //
    // Reading one as the other silently transposes the mode vectors, so the
    // header decides which reader runs.
    let header = -1;
    let shape = null;
    for (let index = start + 1; index < Math.min(lines.length, start + 60); index += 1) {
      if (/^\s*Coord\s+Atom\s+Element/i.test(lines[index])) { header = index; shape = 'components'; break; }
      if (/^\s*Atom\s+AN\b/i.test(lines[index])) { header = index; shape = 'atoms'; break; }
      if (/^\s*Frequencies\s*--/.test(lines[index])) break;
    }

    const blockVectors = Array.from({ length: blockCount }, () => []);
    if (header !== -1) {
      const byAtom = new Map();
      for (let index = header + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.trim() === '') break;
        if (/^\s*[A-Za-z]/.test(line)) break;
        const values = rowNumbers(line);
        if (values.length < 3) break;

        if (shape === 'components') {
          const component = Math.round(values[0]);
          const atom = Math.round(values[1]);
          const modeValues = values.slice(3);
          if (component < 1 || component > 3 || atom < 1) break;
          if (modeValues.length !== blockCount) break;
          if (!byAtom.has(atom)) byAtom.set(atom, {});
          const entry = byAtom.get(atom);
          if (entry[component]) break;
          entry[component] = modeValues;
          if (atom > atomCount) atomCount = atom;
        } else {
          const atom = Math.round(values[0]);
          const flat = values.slice(2);
          if (atom < 1) break;
          if (flat.length !== blockCount * 3) break;
          // Same key convention as the component shape (1 = x, 2 = y, 3 = z),
          // so the assembly below has one reader rather than two.
          const entry = { 1: [], 2: [], 3: [] };
          for (let mode = 0; mode < blockCount; mode += 1) {
            entry[1].push(flat[mode * 3]);
            entry[2].push(flat[mode * 3 + 1]);
            entry[3].push(flat[mode * 3 + 2]);
          }
          byAtom.set(atom, entry);
          if (atom > atomCount) atomCount = atom;
        }
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
