/**
 * Dependency-free structure viewer for parsed geometries.
 *
 * Everything above `createStructureViewer` is pure: it takes plain geometry
 * data and returns plain data, so the geometry preparation, bond perception,
 * bounding-box fit and normal-mode frame maths can be tested in Node without a
 * DOM (or a canvas implementation).
 *
 * The parser does not extract normal-mode displacement vectors today. The
 * animation path therefore only runs when a caller supplies an explicit
 * `{ frequencies, displacements }` object. Without it the panel says so and
 * shows a static geometry; it never invents motion.
 */

export const NO_MODES_NOTICE = 'Normal modes not present in this output.';
export const INVALID_MODES_NOTICE = 'Normal-mode data is incomplete or malformed; animation is unavailable.';

const FALLBACK_RADIUS = 1.5;
const FALLBACK_COLOR = '#a78bfa';

/**
 * Ball radius as a fraction of the covalent radius. Covalent radii describe a
 * bond, not the edge of an atom, so the drawn sphere is deliberately smaller.
 */
const BALL_SCALE = 0.42;

/**
 * Covalent radii (Å) and display colours. Radii follow Cordero et al. 2008,
 * rounded to 0.01 Å; colours follow the Jmol/CPK palette, lightened where the
 * classic colour would disappear on the dark canvas. These are visualisation
 * data only: they never feed a calculation or a gate.
 */
const ELEMENT_STYLE_DATA = {
  H: ['#f4f7fb', 0.31], He: ['#d9e4f5', 0.28],
  Li: ['#cc80ff', 1.28], Be: ['#c2ff00', 0.96], B: ['#ffb5b5', 0.84],
  C: ['#909090', 0.76], N: ['#3050f8', 0.71], O: ['#ff0d0d', 0.66],
  F: ['#90e050', 0.57], Ne: ['#b3e3f5', 0.58],
  Na: ['#ab5cf2', 1.66], Mg: ['#8aff00', 1.41], Al: ['#bfa6a6', 1.21],
  Si: ['#f0c8a0', 1.11], P: ['#ff8000', 1.07], S: ['#d4b000', 1.05],
  Cl: ['#1ff01f', 1.02], Ar: ['#80d1e3', 1.06],
  K: ['#8f40d4', 2.03], Ca: ['#3dff00', 1.76], Sc: ['#e6e6e6', 1.70],
  Ti: ['#bfc2c7', 1.60], V: ['#a6a6ab', 1.53], Cr: ['#8a99c7', 1.39],
  Mn: ['#9c7ac7', 1.39], Fe: ['#e06633', 1.32], Co: ['#f090a0', 1.26],
  Ni: ['#50d050', 1.24], Cu: ['#c88033', 1.32], Zn: ['#7d80b0', 1.22],
  Ga: ['#c28f8f', 1.22], Ge: ['#668f8f', 1.20], As: ['#bd80e3', 1.19],
  Se: ['#ffa100', 1.20], Br: ['#a62929', 1.20], Kr: ['#5cb8d1', 1.16],
  Rb: ['#702eb0', 2.20], Sr: ['#00ff00', 1.95], Y: ['#94ffff', 1.90],
  Zr: ['#94e0e0', 1.75], Nb: ['#73c2c9', 1.64], Mo: ['#54b5b5', 1.54],
  Tc: ['#3b9e9e', 1.47], Ru: ['#248f8f', 1.46], Rh: ['#0a7d8c', 1.42],
  Pd: ['#006985', 1.39], Ag: ['#c0c0c0', 1.45], Cd: ['#ffd98f', 1.44],
  In: ['#a67573', 1.42], Sn: ['#668080', 1.39], Sb: ['#9e63b5', 1.39],
  Te: ['#d47a00', 1.38], I: ['#940094', 1.39], Xe: ['#429eb0', 1.40],
  Cs: ['#57178f', 2.44], Ba: ['#00c900', 2.15], La: ['#70d4ff', 2.07],
  Ce: ['#ffffc7', 2.04], Pr: ['#d9ffc7', 2.03], Nd: ['#c7ffc7', 2.01],
  Pm: ['#a3ffc7', 1.99], Sm: ['#8fffc7', 1.98], Eu: ['#61ffc7', 1.98],
  Gd: ['#45ffc7', 1.96], Tb: ['#30ffc7', 1.94], Dy: ['#1fffc7', 1.92],
  Ho: ['#00ff9c', 1.92], Er: ['#00e675', 1.89], Tm: ['#00d452', 1.90],
  Yb: ['#00bf38', 1.87], Lu: ['#00ab24', 1.87],
  Hf: ['#4dc2ff', 1.75], Ta: ['#4da6ff', 1.70], W: ['#2194d6', 1.62],
  Re: ['#267dab', 1.51], Os: ['#266696', 1.44], Ir: ['#175487', 1.41],
  Pt: ['#d0d0e0', 1.36], Au: ['#ffd123', 1.36], Hg: ['#b8b8d0', 1.32],
  Tl: ['#a6544d', 1.45], Pb: ['#575961', 1.46], Bi: ['#9e4fb5', 1.48],
  Po: ['#ab5c00', 1.40], At: ['#754f45', 1.50], Rn: ['#428296', 1.50],
  Fr: ['#420066', 2.60], Ra: ['#007d00', 2.21], Ac: ['#70abfa', 2.15],
  Th: ['#00baff', 2.06], Pa: ['#00a1ff', 2.00], U: ['#008fff', 1.96],
  Np: ['#0080ff', 1.90], Pu: ['#006bff', 1.87], Am: ['#545cf2', 1.80],
  Cm: ['#785fe2', 1.69],
};

const ELEMENT_STYLE = new Map(
  Object.entries(ELEMENT_STYLE_DATA).map(([symbol, [color, radius]]) => [symbol, { color, radius }]),
);

export class StructureViewError extends Error {}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Colour plus covalent radius for a symbol; unknown symbols get a safe fallback. */
export function elementStyle(symbol) {
  const key = String(symbol ?? '').trim();
  const entry = ELEMENT_STYLE.get(key);
  if (!entry) {
    return { symbol: key || '?', color: FALLBACK_COLOR, radius: FALLBACK_RADIUS, known: false };
  }
  return { symbol: key, color: entry.color, radius: entry.radius, known: true };
}

/**
 * Axis-aligned bounding box of a list of points or a geometry object. The
 * radius is the half-diagonal of the box, a rotation-independent bound.
 */
export function boundingBox(points) {
  const list = Array.isArray(points) ? points : points?.atoms;
  if (!Array.isArray(list) || list.length === 0) {
    throw new StructureViewError('A geometry with at least one atom is required.');
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const point of list) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    const z = Number(point?.z);
    if (!finite(x) || !finite(y) || !finite(z)) {
      throw new StructureViewError('A geometry coordinate is missing or not finite.');
    }
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  const size = { x: maxX - minX, y: maxY - minY, z: maxZ - minZ };
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
    size,
    radius: Math.hypot(size.x, size.y, size.z) / 2,
  };
}

/**
 * Bond perception from covalent-radius sums. Two atoms are bonded when their
 * distance is at most `radiusA + radiusB + tolerance`. Nothing is inferred
 * about bond order, so a metal complex simply gets its close contacts drawn.
 */
export function detectBonds(atoms, { tolerance = 0.4 } = {}) {
  if (!Array.isArray(atoms)) return [];
  const bonds = [];
  for (let i = 0; i < atoms.length; i += 1) {
    const a = atoms[i];
    for (let j = i + 1; j < atoms.length; j += 1) {
      const b = atoms[j];
      const radiusA = Number.isFinite(a?.radius) ? a.radius : elementStyle(a?.element).radius;
      const radiusB = Number.isFinite(b?.radius) ? b.radius : elementStyle(b?.element).radius;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dz = a.z - b.z;
      const distance = Math.hypot(dx, dy, dz);
      if (!Number.isFinite(distance) || distance < 0.4) continue;
      if (distance <= radiusA + radiusB + tolerance) {
        bonds.push({ a: i, b: j, distance });
      }
    }
  }
  return bonds;
}

/**
 * Turn a parsed or imported geometry into the draw-ready model: element style,
 * coordinates centred on the bounding-box centre, bonds and a centred box.
 * Extra parser fields (center, atomicNumber, atomicType) are preserved on each
 * atom so a caller can still show the original record.
 */
export function prepareGeometry(input, { tolerance = 0.4 } = {}) {
  const sourceAtoms = Array.isArray(input) ? input : input?.atoms;
  if (!Array.isArray(sourceAtoms) || sourceAtoms.length === 0) {
    throw new StructureViewError('A geometry with at least one atom is required.');
  }
  const raw = sourceAtoms.map((atom, index) => {
    const element = String(atom?.element ?? '').trim() || '?';
    const style = elementStyle(element);
    const x = Number(atom?.x);
    const y = Number(atom?.y);
    const z = Number(atom?.z);
    if (!finite(x) || !finite(y) || !finite(z)) {
      throw new StructureViewError(`Atom ${index + 1} has a missing or non-finite coordinate.`);
    }
    return {
      ...atom,
      index,
      element: style.symbol,
      x,
      y,
      z,
      radius: style.radius,
      color: style.color,
      known: style.known,
    };
  });
  const sourceBox = boundingBox(raw);
  const center = sourceBox.center;
  const atoms = raw.map((atom) => ({
    ...atom,
    cx: atom.x - center.x,
    cy: atom.y - center.y,
    cz: atom.z - center.z,
  }));
  // A source file that states its topology wins: distance perception cannot
  // recover bond orders, and drawing a double bond as a single line loses
  // chemistry the file actually carried.
  // Bonds arrive 1-based, the way every file format and `molecule.bonds` state
  // them; they are converted once here so no caller has to remember.
  const stated = Array.isArray(input?.bonds) ? input.bonds : [];
  const bonds = stated.length
    ? stated
      .filter((bond) => Number.isInteger(bond.a) && Number.isInteger(bond.b)
        && bond.a >= 1 && bond.b >= 1 && bond.a <= atoms.length && bond.b <= atoms.length && bond.a !== bond.b)
      .map((bond) => {
        const a = bond.a - 1;
        const b = bond.b - 1;
        return {
          a,
          b,
          order: Number(bond.order) || 1,
          distance: Math.hypot(
            atoms[a].cx - atoms[b].cx,
            atoms[a].cy - atoms[b].cy,
            atoms[a].cz - atoms[b].cz,
          ),
        };
      })
    : detectBonds(atoms, { tolerance });
  return {
    atoms,
    bonds,
    bondsFrom: stated.length ? 'file' : 'perceived',
    atomCount: atoms.length,
    center,
    box: {
      min: { x: -sourceBox.size.x / 2, y: -sourceBox.size.y / 2, z: -sourceBox.size.z / 2 },
      max: { x: sourceBox.size.x / 2, y: sourceBox.size.y / 2, z: sourceBox.size.z / 2 },
      size: sourceBox.size,
      radius: sourceBox.radius,
    },
    source: typeof input?.source === 'string' ? input.source : null,
    tolerance,
  };
}

function bondOffsets(order) {
  if (order >= 3) return [-1, 0, 1];
  if (order >= 2) return [-1, 1];
  if (order === 1.5) return [-1, 1];
  return [0];
}

/* ── Projection and fitting ───────────────────────────────── */

export function rotationOf(yaw, pitch) {
  return {
    yaw,
    pitch,
    cosYaw: Math.cos(yaw),
    sinYaw: Math.sin(yaw),
    cosPitch: Math.cos(pitch),
    sinPitch: Math.sin(pitch),
  };
}

/** Rotate a centred point: yaw about Y, then pitch about X. */
export function rotatePoint(point, rotation) {
  const { cosYaw, sinYaw, cosPitch, sinPitch } = rotation;
  const x1 = point.x * cosYaw + point.z * sinYaw;
  const z1 = -point.x * sinYaw + point.z * cosYaw;
  const y2 = point.y * cosPitch - z1 * sinPitch;
  const z2 = point.y * sinPitch + z1 * cosPitch;
  return { x: x1, y: y2, z: z2 };
}

/** Screen-space extents of the rotated bounding box, plus a ball margin (Å). */
export function projectedBounds(geometry, rotation, margin = 0) {
  const box = geometry.box;
  const corners = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) corners.push({ x, y, z });
    }
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const corner of corners) {
    const rotated = rotatePoint(corner, rotation);
    minX = Math.min(minX, rotated.x);
    minY = Math.min(minY, rotated.y);
    maxX = Math.max(maxX, rotated.x);
    maxY = Math.max(maxY, rotated.y);
  }
  return {
    minX: minX - margin,
    maxX: maxX + margin,
    minY: minY - margin,
    maxY: maxY + margin,
    width: Math.max(0.1, maxX - minX + margin * 2),
    height: Math.max(0.1, maxY - minY + margin * 2),
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

/**
 * Bounding-box fit for a viewport. The base scale is recomputed from the box
 * under the current rotation, so a long molecule never clips while spinning.
 * `zoom` is applied later by `projectAtoms`, keeping the fit and the user's
 * wheel zoom independent.
 */
export function fitCamera(geometry, { width, height, padding = 16, rotation = null, extraMargin = 0 } = {}) {
  const viewWidth = Number(width);
  const viewHeight = Number(height);
  if (!finite(viewWidth) || !finite(viewHeight) || viewWidth <= 0 || viewHeight <= 0) {
    throw new StructureViewError('A positive viewport width and height are required.');
  }
  const rot = rotation || rotationOf(0, 0);
  const maxRadius = geometry.atoms.reduce((max, atom) => Math.max(max, atom.radius), 0);
  const margin = maxRadius * BALL_SCALE + 0.15 + Math.max(0, Number(extraMargin) || 0);
  const bounds = projectedBounds(geometry, rot, margin);
  const usableWidth = Math.max(1, viewWidth - padding * 2);
  const usableHeight = Math.max(1, viewHeight - padding * 2);
  const scale = Math.min(usableWidth / bounds.width, usableHeight / bounds.height);
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    scale: safeScale,
    originX: viewWidth / 2 - bounds.centerX * safeScale,
    originY: viewHeight / 2 + bounds.centerY * safeScale,
    rotation: rot,
    zoom: 1,
  };
}

/** Project centred atoms to screen space, sorted information kept per atom. */
export function projectAtoms(geometry, camera) {
  const rotation = camera.rotation || rotationOf(0, 0);
  const zoom = finite(camera.zoom) ? camera.zoom : 1;
  return geometry.atoms.map((atom) => {
    const rotated = rotatePoint({ x: atom.cx, y: atom.cy, z: atom.cz }, rotation);
    return {
      atom,
      index: atom.index,
      element: atom.element,
      color: atom.color,
      depth: rotated.z,
      sx: camera.originX + rotated.x * camera.scale * zoom,
      sy: camera.originY - rotated.y * camera.scale * zoom,
      screenRadius: atom.radius * BALL_SCALE * camera.scale * zoom,
    };
  });
}

/* ── Normal modes ─────────────────────────────────────────── */

function vectorFrom(value) {
  if (Array.isArray(value) && value.length >= 3) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    const z = Number(value[2]);
    return finite(x) && finite(y) && finite(z) ? { x, y, z } : null;
  }
  if (value && typeof value === 'object') {
    const x = Number(value.x);
    const y = Number(value.y);
    const z = Number(value.z);
    return finite(x) && finite(y) && finite(z) ? { x, y, z } : null;
  }
  return null;
}

function displacementVectors(value, atomCount) {
  if (!Array.isArray(value)) return null;
  if (value.length === atomCount * 3 && value.every((entry) => finite(Number(entry)))) {
    const vectors = [];
    for (let index = 0; index < atomCount; index += 1) {
      vectors.push({
        x: Number(value[index * 3]),
        y: Number(value[index * 3 + 1]),
        z: Number(value[index * 3 + 2]),
      });
    }
    return vectors;
  }
  if (value.length === atomCount) {
    const vectors = value.map(vectorFrom);
    return vectors.every(Boolean) ? vectors : null;
  }
  return null;
}

/**
 * Validate an optional normal-mode block. Both the flat Gaussian layout
 * (`[dx0, dy0, dz0, dx1, ...]`, length 3N) and a per-atom vector layout are
 * accepted. Anything inconsistent is reported as unavailable with a notice,
 * never silently animated.
 */
export function describeModes(modes, atomCount = null) {
  if (!modes || !Array.isArray(modes.frequencies) || !Array.isArray(modes.displacements)
    || modes.frequencies.length === 0 || modes.displacements.length !== modes.frequencies.length) {
    return { available: false, notice: NO_MODES_NOTICE, frequencies: [], displacements: [], imaginaryIndices: [], defaultIndex: 0, atomCount };
  }
  let count = atomCount;
  if (!Number.isInteger(count) || count <= 0) {
    const first = modes.displacements[0];
    if (!Array.isArray(first) || first.length === 0) {
      return { available: false, notice: INVALID_MODES_NOTICE, frequencies: [], displacements: [], imaginaryIndices: [], defaultIndex: 0, atomCount: null };
    }
    const vectorLayout = first.every((entry) => Array.isArray(entry) || (entry !== null && typeof entry === 'object'));
    count = vectorLayout ? first.length : Math.max(1, Math.round(first.length / 3));
  }
  const frequencies = modes.frequencies.map((value) => Number(value));
  if (!frequencies.every(finite)) {
    return { available: false, notice: INVALID_MODES_NOTICE, frequencies: [], displacements: [], imaginaryIndices: [], defaultIndex: 0, atomCount: count };
  }
  const displacements = modes.displacements.map((value) => displacementVectors(value, count));
  if (!displacements.every(Boolean)) {
    return { available: false, notice: INVALID_MODES_NOTICE, frequencies: [], displacements: [], imaginaryIndices: [], defaultIndex: 0, atomCount: count };
  }
  const imaginaryIndices = [];
  frequencies.forEach((frequency, index) => {
    if (frequency < 0) imaginaryIndices.push(index);
  });
  let defaultIndex = 0;
  if (imaginaryIndices.length > 0) {
    defaultIndex = imaginaryIndices.reduce(
      (lowest, index) => (frequencies[index] < frequencies[lowest] ? index : lowest),
      imaginaryIndices[0],
    );
  }
  return {
    available: true,
    notice: null,
    frequencies,
    displacements,
    imaginaryIndices,
    defaultIndex,
    atomCount: count,
  };
}

/**
 * Displacement for one animation frame. The mode is normalised so its largest
 * atomic vector moves exactly `amplitude` Å at phase π/2; the direction and
 * relative signs come straight from the supplied mode. No mode data means
 * `null`, never a fabricated frame.
 */
export function modeFrame(modes, index, phase, amplitude = 0.6) {
  if (!modes?.available) return null;
  const mode = modes.displacements[index];
  if (!Array.isArray(mode)) return null;
  let peak = 0;
  for (const vector of mode) peak = Math.max(peak, Math.hypot(vector.x, vector.y, vector.z));
  const factor = peak > 0 ? (amplitude * Math.sin(phase)) / peak : 0;
  return mode.map((vector) => ({ x: vector.x * factor, y: vector.y * factor, z: vector.z * factor }));
}

/**
 * Resolve the parsed geometry (and any optional modes) attached to a calc
 * node. The current project schema stores `{ file, size }` on `output`; a
 * caller that has the full parse may attach it as `node.output.parsed` or
 * `node.parsed`. Missing geometry resolves to `null` so the inspector shows no
 * viewer rather than an empty/fake one.
 */
export function resolveStructure(node) {
  if (!node) return null;
  // A conformer block has no run to parse: the geometry it would show is the
  // member the user picked, taken from the ensemble summary it carries.
  if (node.type === 'conformers') {
    const atoms = node.output?.selected?.atoms;
    if (!Array.isArray(atoms) || atoms.length === 0) return null;
    const geometry = { atoms, source: `conformer ${node.output.selected.id}` };
    let prepared;
    try {
      prepared = prepareGeometry(geometry);
    } catch {
      return null;
    }
    return { geometry: prepared, rawGeometry: geometry, modes: describeModes(null, prepared.atomCount), source: geometry.source };
  }
  if (node.type !== 'calc') return null;
  const parsed = node.output?.parsed ?? node.parsed ?? null;
  const geometry = parsed?.finalGeometry ?? parsed?.geometry?.final ?? null;
  if (!geometry || !Array.isArray(geometry.atoms) || geometry.atoms.length === 0) return null;
  let prepared;
  try {
    // Bonds stated by the source file travel with the project molecule. They
    // are only attached when the atom counts match: a relaxed geometry with a
    // different atom count cannot inherit the original topology safely.
    const statedBonds = Array.isArray(node.molecule?.bonds) ? node.molecule.bonds : [];
    const sameShape = statedBonds.length > 0 && geometry.atoms.length === node.molecule?.coords?.length;
    prepared = prepareGeometry(sameShape ? { atoms: geometry.atoms, bonds: statedBonds } : geometry);
  } catch {
    return null;
  }
  const modes = describeModes(
    parsed?.modes ?? parsed?.normalModes ?? node.modes ?? null,
    prepared.atomCount,
  );
  return { geometry: prepared, rawGeometry: geometry, modes, source: geometry.source ?? null };
}

/* ── Canvas renderer ──────────────────────────────────────── */

function mixWithWhite(hex, amount) {
  const value = String(hex || '').replace('#', '');
  if (value.length !== 6) return hex;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const mix = (channel) => Math.round(channel + (255 - channel) * amount);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/**
 * Create a canvas viewer. The canvas is the only DOM dependency; the returned
 * API is inert when a 2D context is unavailable (for example a headless
 * preview), so the inspector never throws over a missing canvas backend.
 */
export function createStructureViewer(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  const context = canvas.getContext('2d');
  if (!context) return null;

  let prepared = null;
  let modes = describeModes(null);
  let modeIndex = 0;
  let amplitude = finite(options.amplitude) ? options.amplitude : 0.6;
  let yaw = options.yaw ?? -0.42;
  let pitch = options.pitch ?? 0.28;
  let zoom = 1;
  let phase = 0;
  let playing = false;
  let destroyed = false;
  let raf = null;
  let lastFrameTime = null;
  let dragging = false;
  let dragLast = null;
  let hovered = null;
  let lastProjection = [];
  let lastCamera = null;
  let lastViewport = { width: 1, height: 1 };

  const handlePointerDown = (event) => {
    if (!prepared) return;
    dragging = true;
    dragLast = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture?.(event.pointerId);
    canvas.style.cursor = 'grabbing';
  };

  const handlePointerMove = (event) => {
    if (!prepared) return;
    if (dragging && dragLast) {
      yaw += (event.clientX - dragLast.x) * 0.012;
      pitch = clamp(pitch + (event.clientY - dragLast.y) * 0.012, -1.45, 1.45);
      dragLast = { x: event.clientX, y: event.clientY };
      draw();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let found = null;
    for (const atom of lastProjection) {
      if (Math.hypot(atom.sx - x, atom.sy - y) <= atom.screenRadius + 4) {
        if (!found || atom.depth > found.depth) found = atom;
      }
    }
    if (found?.index !== hovered?.index) {
      hovered = found;
      canvas.style.cursor = found ? 'pointer' : 'grab';
      draw();
    }
  };

  const endDrag = (event) => {
    dragging = false;
    dragLast = null;
    canvas.style.cursor = hovered ? 'pointer' : 'grab';
    if (event?.pointerId !== undefined) canvas.releasePointerCapture?.(event.pointerId);
  };

  const handlePointerLeave = () => {
    if (hovered) {
      hovered = null;
      draw();
    }
  };

  const handleWheel = (event) => {
    if (!prepared) return;
    event.preventDefault();
    zoom = clamp(zoom * Math.exp(-event.deltaY * 0.0012), 0.25, 8);
    draw();
  };

  const handleDoubleClick = () => {
    yaw = options.yaw ?? -0.42;
    pitch = options.pitch ?? 0.28;
    zoom = 1;
    draw();
  };

  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', handlePointerLeave);
  canvas.addEventListener('wheel', handleWheel, { passive: false });
  canvas.addEventListener('dblclick', handleDoubleClick);

  let observer = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
  }

  function syncCanvasSize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || canvas.clientWidth || 640));
    const height = Math.max(1, Math.round(rect.height || canvas.clientHeight || 320));
    const ratio = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2.5) : 1;
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    lastViewport = { width, height };
    return lastViewport;
  }

  function displacedGeometry() {
    const frame = modes.available ? modeFrame(modes, modeIndex, phase, amplitude) : null;
    if (!frame) return prepared;
    return {
      ...prepared,
      atoms: prepared.atoms.map((atom, index) => ({
        ...atom,
        cx: atom.cx + frame[index].x,
        cy: atom.cy + frame[index].y,
        cz: atom.cz + frame[index].z,
      })),
    };
  }

  function drawHoverLabel(atom, width, height) {
    const text = `${atom.element}${atom.index + 1}  ${atom.atom.x.toFixed(3)}, ${atom.atom.y.toFixed(3)}, ${atom.atom.z.toFixed(3)} Å`;
    context.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const textWidth = context.measureText(text).width;
    const boxWidth = textWidth + 14;
    const boxHeight = 22;
    let x = atom.sx + atom.screenRadius + 8;
    if (x + boxWidth > width - 4) x = atom.sx - atom.screenRadius - 8 - boxWidth;
    x = clamp(x, 4, Math.max(4, width - boxWidth - 4));
    const y = clamp(atom.sy - boxHeight / 2, 4, Math.max(4, height - boxHeight - 4));
    context.fillStyle = 'rgba(8, 13, 20, .94)';
    context.strokeStyle = 'rgba(148, 163, 184, .35)';
    context.lineWidth = 1;
    context.beginPath();
    context.rect(x, y, boxWidth, boxHeight);
    context.fill();
    context.stroke();
    context.fillStyle = '#e9edf4';
    context.textBaseline = 'middle';
    context.fillText(text, x + 7, y + boxHeight / 2 + 0.5);
  }

  function drawModeCaption(width) {
    if (!modes.available) return;
    const frequency = modes.frequencies[modeIndex];
    const label = `ν = ${frequency.toFixed(1)} cm⁻¹${frequency < 0 ? ' (imaginary)' : ''}`;
    context.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.fillStyle = frequency < 0 ? '#fbbf24' : '#98a3b3';
    context.textBaseline = 'top';
    context.fillText(label, 10, 8);
    if (width > 220) {
      context.fillStyle = '#64748b';
      context.fillText(`mode ${modeIndex + 1}/${modes.frequencies.length}`, 10, 23);
      // The amplitude is the peak atomic displacement of the drawing, in Å.
      context.fillText(`amplitude ${amplitude.toFixed(2)} Å`, 10, 38);
    }
  }

  function draw() {
    if (destroyed || !prepared) return;
    const { width, height } = syncCanvasSize();
    context.clearRect(0, 0, width, height);
    const rotation = rotationOf(yaw, pitch);
    const camera = fitCamera(prepared, {
      width,
      height,
      padding: width < 260 ? 8 : 16,
      rotation,
      extraMargin: modes.available ? amplitude : 0,
    });
    camera.zoom = zoom;
    const geometry = displacedGeometry();
    const projected = projectAtoms(geometry, camera);
    lastProjection = projected;
    lastCamera = camera;

    const bondWidth = clamp(0.1 * camera.scale * zoom, 1.5, 9);
    const orderedBonds = prepared.bonds
      .map((bond) => ({
        bond,
        a: projected[bond.a],
        b: projected[bond.b],
        depth: (projected[bond.a].depth + projected[bond.b].depth) / 2,
      }))
      .sort((left, right) => left.depth - right.depth);

    for (const entry of orderedBonds) {
      const { a, b } = entry;
      const gradient = context.createLinearGradient(a.sx, a.sy, b.sx, b.sy);
      gradient.addColorStop(0, mixWithWhite(a.color, 0.08));
      gradient.addColorStop(0.5, '#5f6b7a');
      gradient.addColorStop(1, mixWithWhite(b.color, 0.08));
      context.strokeStyle = gradient;
      const offsets = bondOffsets(Number(entry.bond?.order) || 1);
      const dx = b.sx - a.sx;
      const dy = b.sy - a.sy;
      const length = Math.hypot(dx, dy) || 1;
      const nx = -dy / length;
      const ny = dx / length;
      const gap = bondWidth * (offsets.length > 1 ? 0.85 : 0);
      context.lineWidth = offsets.length > 1 ? Math.max(1, bondWidth * 0.42) : bondWidth;
      context.lineCap = 'round';
      for (const offset of offsets) {
        const ox = nx * gap * offset;
        const oy = ny * gap * offset;
        context.beginPath();
        context.moveTo(a.sx + ox, a.sy + oy);
        context.lineTo(b.sx + ox, b.sy + oy);
        context.stroke();
      }
    }

    const orderedAtoms = [...projected].sort((left, right) => left.depth - right.depth);
    for (const atom of orderedAtoms) {
      const radius = Math.max(1.5, atom.screenRadius);
      const gradient = context.createRadialGradient(
        atom.sx - radius * 0.35,
        atom.sy - radius * 0.38,
        Math.max(0.5, radius * 0.15),
        atom.sx,
        atom.sy,
        radius,
      );
      gradient.addColorStop(0, mixWithWhite(atom.color, 0.55));
      gradient.addColorStop(0.55, atom.color);
      gradient.addColorStop(1, mixWithWhite(atom.color, 0));
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(atom.sx, atom.sy, radius, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = 'rgba(4, 8, 14, .65)';
      context.lineWidth = radius > 4 ? 1 : 0.6;
      context.stroke();
    }

    if (hovered) {
      const current = projected.find((atom) => atom.index === hovered.index);
      if (current) {
        context.strokeStyle = '#c4b5fd';
        context.lineWidth = 1.5;
        context.beginPath();
        context.arc(current.sx, current.sy, Math.max(3, current.screenRadius) + 3, 0, Math.PI * 2);
        context.stroke();
        drawHoverLabel(current, width, height);
      }
    }
    drawModeCaption(width);
  }

  function tick(time) {
    if (!playing || destroyed) return;
    if (!canvas.isConnected) {
      playing = false;
      raf = null;
      return;
    }
    const delta = lastFrameTime === null ? 0 : Math.min(0.05, (time - lastFrameTime) / 1000);
    lastFrameTime = time;
    phase += delta * Math.PI * 1.15;
    draw();
    raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(tick) : null;
  }

  function setGeometry(geometry, nextModes = null) {
    prepared = prepareGeometry(geometry);
    modes = nextModes && typeof nextModes.available === 'boolean'
      ? nextModes
      : describeModes(nextModes, prepared.atomCount);
    modeIndex = modes.available ? modes.defaultIndex : 0;
    phase = 0;
    zoom = 1;
    hovered = null;
    lastProjection = [];
    draw();
    return prepared;
  }

  function setModes(nextModes) {
    modes = nextModes && typeof nextModes.available === 'boolean'
      ? nextModes
      : describeModes(nextModes, prepared?.atomCount ?? null);
    modeIndex = modes.available ? modes.defaultIndex : 0;
    phase = 0;
    draw();
    return modes;
  }

  function setMode(index) {
    if (!modes.available) return false;
    const value = Number(index);
    if (!Number.isInteger(value) || value < 0 || value >= modes.frequencies.length) return false;
    modeIndex = value;
    phase = 0;
    draw();
    return true;
  }

  function play() {
    if (!modes.available || playing) return false;
    playing = true;
    lastFrameTime = null;
    if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(tick);
    return true;
  }

  function pause() {
    playing = false;
    lastFrameTime = null;
    if (raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    raf = null;
    draw();
  }

  /**
   * The current view as an SVG, with no captions or controls — just the atoms,
   * the bonds and a scale bar whose length is taken from the camera, so the
   * figure states its own scale.
   */
  function exportSvg({ scale = 2 } = {}) {
    if (!prepared || !lastCamera || lastProjection.length === 0) return null;
    const { width, height } = syncCanvasSize();
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    const bondWidth = clamp(0.1 * lastCamera.scale * zoom, 1.5, 9) * scale;
    const bonds = prepared.bonds.map((bond) => {
      const a = lastProjection[bond.a];
      const b = lastProjection[bond.b];
      const offsets = bondOffsets(Number(bond.order) || 1);
      const dx = b.sx - a.sx;
      const dy = b.sy - a.sy;
      const length = Math.hypot(dx, dy) || 1;
      const gap = bondWidth * (offsets.length > 1 ? 0.85 : 0);
      const width = (offsets.length > 1 ? Math.max(1, bondWidth * 0.42) : bondWidth).toFixed(1);
      return offsets.map((offset) => {
        const ox = (-dy / length) * gap * offset;
        const oy = (dx / length) * gap * offset;
        return `<line x1="${((a.sx + ox) * scale).toFixed(1)}" y1="${((a.sy + oy) * scale).toFixed(1)}" x2="${((b.sx + ox) * scale).toFixed(1)}" y2="${((b.sy + oy) * scale).toFixed(1)}" stroke="#5f6b7a" stroke-width="${width}" stroke-linecap="round"/>`;
      }).join('');
    }).join('');
    const atoms = [...lastProjection]
      .sort((left, right) => left.depth - right.depth)
      .map((atom) => `<circle cx="${(atom.sx * scale).toFixed(1)}" cy="${(atom.sy * scale).toFixed(1)}" r="${(Math.max(1.5, atom.screenRadius) * scale).toFixed(1)}" fill="${atom.color}" stroke="#04080e" stroke-width="${(atom.screenRadius > 4 ? 1 : 0.6) * scale}"><title>${atom.element || ''}</title></circle>`)
      .join('');
    // One ångström measured with the same camera the atoms were drawn with.
    const bar = Math.max(8, lastCamera.scale * scale);
    const barY = h - 14 * scale;
    const scaleBar = `<g><line x1="${14 * scale}" y1="${barY}" x2="${14 * scale + bar}" y2="${barY}" stroke="#111827" stroke-width="${1.2 * scale}"/>`
      + `<text x="${14 * scale}" y="${barY - 5 * scale}" font-family="ui-sans-serif, system-ui" font-size="${9 * scale}" fill="#111827">1 Å</text></g>`;
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
      + `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
      + `<rect width="${w}" height="${h}" fill="#ffffff"/>`
      + bonds + atoms + scaleBar
      + '</svg>';
  }

  function fit() {
    yaw = options.yaw ?? -0.42;
    pitch = options.pitch ?? 0.28;
    zoom = 1;
    hovered = null;
    draw();
  }

  function destroy() {
    destroyed = true;
    pause();
    observer?.disconnect();
    canvas.removeEventListener('pointerdown', handlePointerDown);
    canvas.removeEventListener('pointermove', handlePointerMove);
    canvas.removeEventListener('pointerup', endDrag);
    canvas.removeEventListener('pointercancel', endDrag);
    canvas.removeEventListener('pointerleave', handlePointerLeave);
    canvas.removeEventListener('wheel', handleWheel);
    canvas.removeEventListener('dblclick', handleDoubleClick);
  }

  return {
    setGeometry,
    setModes,
    setMode,
    setAmplitude(value) {
      amplitude = clamp(Number(value) || 0, 0.05, 2);
      draw();
    },
    play,
    pause,
    fit,
    draw,
    isPlaying: () => playing,
    getPrepared: () => prepared,
    getModes: () => modes,
    getCamera: () => ({ yaw, pitch, zoom }),
    getViewport: () => ({ ...lastViewport }),
    exportSvg,
    destroy,
  };
}

/* ── Inspector integration ────────────────────────────────── */

let activeViewer = null;

function legendFor(geometry) {
  const counts = new Map();
  for (const atom of geometry.atoms) {
    if (!counts.has(atom.element)) counts.set(atom.element, { atom, count: 0 });
    counts.get(atom.element).count += 1;
  }
  const legend = document.createElement('div');
  legend.className = 'structure-legend';
  for (const { atom, count } of counts.values()) {
    const item = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.style.background = atom.color;
    const label = document.createElement('b');
    label.textContent = `${atom.element} ×${count}`;
    item.append(swatch, label);
    legend.append(item);
  }
  return legend;
}

/**
 * Mount the viewer in a calc node's inspector. The caller passes the inspector
 * root right after replacing its innerHTML, so the panel is inserted into the
 * freshly rendered scroll area. Nodes without a parsed final geometry get no
 * panel at all.
 */
export function mountStructureViewer(inspectorEl, node) {
  if (typeof document === 'undefined') return null;
  if (activeViewer) {
    activeViewer.destroy();
    activeViewer = null;
  }
  if (!inspectorEl || !node || (node.type !== 'calc' && node.type !== 'conformers')) return null;
  const resolved = resolveStructure(node);
  if (!resolved) return null;

  const scroll = inspectorEl.querySelector('.inspector-scroll');
  const template = document.getElementById('structure-viewer-template');
  const panel = template?.content?.firstElementChild?.cloneNode(true) ?? null;
  if (!scroll || !panel) return null;

  const canvas = panel.querySelector('[data-structure-canvas]');
  const source = panel.querySelector('[data-structure-source]');
  const notice = panel.querySelector('[data-structure-notice]');
  const modesRow = panel.querySelector('[data-structure-modes]');
  const modeSelect = panel.querySelector('[data-structure-mode]');
  const amplitudeInput = panel.querySelector('[data-structure-amplitude]');
  const playButton = panel.querySelector('[data-structure-play]');
  const fitButton = panel.querySelector('[data-structure-fit]');
  const exportButton = panel.querySelector('[data-structure-export]');
  const legendSlot = panel.querySelector('[data-structure-legend]');
  if (!canvas || !source || !notice || !modesRow || !modeSelect || !playButton || !fitButton || !legendSlot) {
    return null;
  }

  const block = scroll.querySelector('.code-block');
  if (block?.parentNode) block.parentNode.insertBefore(panel, block.nextSibling);
  else scroll.insertBefore(panel, scroll.firstChild);

  const viewer = createStructureViewer(canvas);
  if (!viewer) {
    notice.hidden = false;
    notice.textContent = 'Canvas rendering is unavailable in this environment.';
    return null;
  }
  activeViewer = viewer;
  viewer.setGeometry(resolved.rawGeometry, resolved.modes);

  const label = panel.querySelector('.section-label');
  if (label) label.textContent = node.type === 'conformers' ? 'Chosen conformer' : 'Final geometry';
  panel.setAttribute('aria-label', node.type === 'conformers' ? 'Chosen conformer viewer' : 'Parsed structure viewer');
  const sourceLabel = resolved.source ? `${resolved.source} orientation` : 'source unknown';
  source.textContent = `${resolved.geometry.atomCount} atoms · ${resolved.geometry.bonds.length} bonds · ${sourceLabel}`;
  legendSlot.append(legendFor(resolved.geometry));
  canvas.setAttribute('aria-label', `${resolved.geometry.atomCount}-atom parsed final geometry; drag to rotate, wheel to zoom`);

  if (resolved.modes.available) {
    modesRow.hidden = false;
    notice.hidden = true;
    resolved.modes.frequencies.forEach((frequency, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `${index + 1} · ${frequency.toFixed(1)} cm⁻¹${frequency < 0 ? ' (imaginary)' : ''}`;
      modeSelect.append(option);
    });
    modeSelect.value = String(resolved.modes.defaultIndex);
    modeSelect.addEventListener('change', () => {
      viewer.setMode(Number(modeSelect.value));
      playButton.textContent = 'Play';
    });
    amplitudeInput?.addEventListener('input', () => {
      viewer.setAmplitude(Number(amplitudeInput.value));
    });
    playButton.addEventListener('click', () => {
      if (viewer.isPlaying()) {
        viewer.pause();
        playButton.textContent = 'Play';
      } else if (viewer.play()) {
        playButton.textContent = 'Pause';
      }
    });
    panel.dataset.modes = 'present';
  } else {
    modesRow.hidden = true;
    notice.hidden = false;
    notice.textContent = resolved.modes.notice;
    panel.dataset.modes = 'absent';
  }

  fitButton.addEventListener('click', () => viewer.fit());
  exportButton?.addEventListener('click', async () => {
    const svg = viewer.exportSvg({ scale: 3 });
    if (!svg) return;
    const desktop = globalThis.window?.desktop ?? null;
    if (!desktop?.saveText) return;
    await desktop.saveText({ suggestedName: 'structure-figure.svg', text: svg });
  });
  return viewer;
}
