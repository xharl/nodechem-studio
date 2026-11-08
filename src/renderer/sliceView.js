/**
 * A 2D slice of a volume, as a canvas plus a legend that states what is shown.
 *
 * The pure part is above `createSliceView`: `sliceRaster` turns a plane of
 * values into RGBA bytes and `isoContours` turns the same plane into polylines.
 * Neither touches a DOM, so both are tested in Node — the colours and the
 * contour positions are numbers, and a picture that disagrees with them is the
 * only thing left to check by eye.
 *
 * The legend is DOM text, not pixels. A rendered caption cannot be selected,
 * searched or read by a screen reader, and "the plane and the value range" is
 * exactly the text a reader needs in order to check the picture.
 *
 * Colour rules, because they are part of the contract:
 * - a **signed** field (an orbital) uses a diverging map centred on zero, so
 *   the node appears as the background and the two phases as different hues;
 * - a **non-negative** field (a density) uses a sequential map from the
 *   background upwards. A diverging map on a density would imply a negative
 *   lobe that does not exist.
 */

import { nearestGridPlane, planeThroughAtoms, sliceOfField } from '../shared/volume.js';

/**
 * The palette is a list of RGB triples, not CSS strings: the canvas gets the
 * numbers directly, no literal colour enters the source (the project keeps
 * every colour in the theme files), and alpha carries the "near zero" part of
 * the scale so the field fades into whatever background the theme paints.
 */
const DIVERGING_STOPS = [
  [-1, [47, 111, 214]],
  [-0.55, [157, 198, 255]],
  [-0.06, [120, 130, 145]],
  [0.06, [130, 124, 118]],
  [0.55, [255, 208, 138]],
  [1, [217, 106, 31]],
];

/** Sequential: a viridis-like ramp, dark to light. */
const SEQUENTIAL_STOPS = [
  [0, [14, 17, 22]],
  [0.25, [31, 78, 90]],
  [0.5, [46, 139, 126]],
  [0.75, [168, 217, 75]],
  [1, [245, 240, 106]],
];

/**
 * Opacity for a value: the background is the zero level. Without this the
 * zero region would be a fixed dark patch, which is wrong on the light theme
 * and implies a third phase that does not exist.
 */
function coverage(t) {
  return Math.min(1, Math.abs(t) * 5);
}

const PLANE_NAMES = ['xy', 'xz', 'yz'];

function mixStops(stops, t) {
  if (!Number.isFinite(t)) return BACKGROUND;
  if (t <= stops[0][0]) return stops[0][1];
  if (t >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  for (let index = 1; index < stops.length; index += 1) {
    const [high, highColor] = stops[index];
    if (t > high) continue;
    const [low, lowColor] = stops[index - 1];
    const span = high - low || 1;
    const f = (t - low) / span;
    return [
      Math.round(lowColor[0] + (highColor[0] - lowColor[0]) * f),
      Math.round(lowColor[1] + (highColor[1] - lowColor[1]) * f),
      Math.round(lowColor[2] + (highColor[2] - lowColor[2]) * f),
    ];
  }
  return BACKGROUND;
}

/** Colour for a signed value: `t` runs from −1 (full negative) to +1. */
export function divergingColor(t) {
  return mixStops(DIVERGING_STOPS, Number.isFinite(t) ? t : 0);
}

/** 0…1 opacity that carries the zero level: transparent at zero, opaque away. */
export function colourCoverage(t) {
  return coverage(Number.isFinite(t) ? t : 0);
}

/** Colour for a non-negative value: `t` runs from 0 to 1. */
export function sequentialColor(t) {
  return mixStops(SEQUENTIAL_STOPS, Math.max(0, Number.isFinite(t) ? t : 0));
}

/** The symmetric range a signed slice is coloured against. */
export function colourRange(slice) {
  if (slice.signed) {
    const magnitude = Math.max(Math.abs(slice.min), Math.abs(slice.max));
    return { min: -magnitude, max: magnitude, magnitude };
  }
  return { min: Math.min(0, slice.min), max: slice.max, magnitude: Math.abs(slice.max) || 1 };
}

/**
 * RGBA bytes for one slice, row 0 at the *lowest* value of the row axis.
 *
 * `values[row * width + column]` is the layout `sliceOfField` produces; the
 * raster is written top-down with row 0 at the bottom of the canvas, which is
 * what "y up" means to a reader looking at an xy plane.
 */
export function sliceRaster(slice, { width = slice.width, height = slice.height } = {}) {
  const range = colourRange(slice);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const scaleX = (slice.width - 1) / Math.max(1, width - 1);
  const scaleY = (slice.height - 1) / Math.max(1, height - 1);
  for (let row = 0; row < height; row += 1) {
    // Nearest sample: a slice of a coarse grid must not be blurred into a lie
    // about where the node is. The canvas scales it with smoothing later.
    const sourceRow = Math.min(slice.height - 1, Math.round(row * scaleY));
    const targetRow = height - 1 - row;
    for (let column = 0; column < width; column += 1) {
      const sourceColumn = Math.min(slice.width - 1, Math.round(column * scaleX));
      const value = slice.values[sourceRow * slice.width + sourceColumn];
      const t = slice.signed
        ? (range.magnitude > 0 ? value / range.magnitude : 0)
        : (range.max > 0 ? value / range.max : 0);
      const colour = slice.signed ? divergingColor(t) : sequentialColor(t);
      const at = (targetRow * width + column) * 4;
      rgba[at] = colour[0];
      rgba[at + 1] = colour[1];
      rgba[at + 2] = colour[2];
      rgba[at + 3] = Math.round(255 * coverage(t));
    }
  }
  return { rgba, width, height, range };
}

/**
 * Marching squares on one slice: the segments where the plane crosses `level`.
 *
 * One value in, segments out; the caller decides how many levels to draw and in
 * which colour. Coordinates are in grid units (`column`, `row`), so a caller can
 * map them to pixels with the same transform it used for the raster.
 */
export function isoContours(slice, level) {
  const value = Number(level);
  if (!Number.isFinite(value)) return [];
  const { width, height, values } = slice;
  if (width < 2 || height < 2) return [];
  const segments = [];
  const at = (column, row) => values[row * width + column];
  const crossing = (a, b, pa, pb) => {
    const span = b - a;
    const t = span === 0 ? 0.5 : (value - a) / span;
    return Math.min(1, Math.max(0, t));
  };
  for (let row = 0; row < height - 1; row += 1) {
    for (let column = 0; column < width - 1; column += 1) {
      // Corners in cyclic order: (0,0), (1,0), (1,1), (0,1).
      const corners = [
        [at(column, row), column, row],
        [at(column + 1, row), column + 1, row],
        [at(column + 1, row + 1), column + 1, row + 1],
        [at(column, row + 1), column, row + 1],
      ];
      const inside = corners.map(([cornerValue]) => cornerValue > value);
      if (inside.every(Boolean) || inside.every((flag) => !flag)) continue;
      const cuts = [];
      for (let corner = 0; corner < 4; corner += 1) {
        const next = (corner + 1) % 4;
        if (inside[corner] === inside[next]) {
          cuts.push(null);
          continue;
        }
        const [a, ax, ay] = corners[corner];
        const [b, bx, by] = corners[next];
        const t = crossing(a, b, ax, ay);
        cuts.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
      }
      const present = cuts.filter(Boolean);
      if (present.length === 2) {
        segments.push([present[0][0], present[0][1], present[1][0], present[1][1]]);
      } else if (present.length === 4) {
        // Alternating corners: pair each cut with the one around an inside
        // corner, the same rule the isosurface uses.
        for (let corner = 0; corner < 4; corner += 1) {
          if (!inside[corner]) continue;
          const previous = cuts[(corner + 3) % 4];
          const current = cuts[corner];
          if (previous && current) segments.push([previous[0], previous[1], current[0], current[1]]);
        }
      }
    }
  }
  return segments;
}

const number = (value) => (Math.abs(value) >= 1000 || (Math.abs(value) < 0.001 && value !== 0)
  ? value.toExponential(2)
  : value.toFixed(3));

/**
 * The legend lines: what the field is, which plane this is, the range the
 * colours span, and where the iso lines sit. Newline-joined by the caller into
 * one `<p>`, or by this function into a single string.
 */
export function legendLines(slice, { iso = null, planeNote = '' } = {}) {
  const range = colourRange(slice);
  const planeAxis = slice.plane === 'xy' ? 'z' : slice.plane === 'xz' ? 'y' : 'x';
  const offset = slice.origin[['x', 'y', 'z'].indexOf(planeAxis)];
  const lines = [
    `${slice.label || 'field'} · ${slice.unit || 'a.u.'}`,
    `plane ${slice.plane} at ${planeAxis} = ${number(offset)} Å`
      + `${slice.index !== undefined ? ` (index ${slice.index})` : ''}${planeNote ? ` · ${planeNote}` : ''}`,
    slice.signed
      ? `range ${number(range.min)} … ${number(range.max)} ${slice.unit || ''} · diverging about zero`
      : `range 0 … ${number(range.max)} ${slice.unit || ''} · sequential`,
  ];
  if (iso !== null && Number.isFinite(iso) && iso !== 0) {
    lines.push(`iso lines at ±${number(Math.abs(iso))} ${slice.unit || ''}`);
  }
  return lines;
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Mount a slice view: plane picker, offset slider, iso input, canvas, legend.
 *
 * Nothing is drawn until `setField` has a field, and the canvas only exists
 * after `host` is in the document (a canvas created off-document still measures
 * zero, which is how a "blank panel" bug looks).
 */
export function createSliceView(host, { doc = globalThis.document, atoms = null } = {}) {
  if (!host || !doc) return null;

  const root = el(doc, 'div', 'slice-view');
  const controls = el(doc, 'div', 'slice-controls');
  const planeLabel = el(doc, 'label', 'slice-control');
  planeLabel.append(el(doc, 'span', null, 'Plane'));
  const planeSelect = el(doc, 'select');
  for (const name of PLANE_NAMES) {
    const option = el(doc, 'option', null, name);
    option.value = name;
    planeSelect.append(option);
  }
  planeLabel.append(planeSelect);

  const offsetLabel = el(doc, 'label', 'slice-control');
  offsetLabel.append(el(doc, 'span', null, 'Offset'));
  const offsetInput = el(doc, 'input');
  offsetInput.type = 'range';
  offsetInput.min = '0';
  offsetInput.max = '1';
  offsetInput.step = '0.01';
  offsetInput.value = '0.5';
  const offsetValue = el(doc, 'output', 'slice-number', '0.50');
  offsetLabel.append(offsetInput, offsetValue);

  const isoLabel = el(doc, 'label', 'slice-control');
  isoLabel.append(el(doc, 'span', null, 'Iso'));
  const isoInput = el(doc, 'input');
  isoInput.type = 'number';
  isoInput.step = '0.001';
  isoInput.value = '';
  isoLabel.append(isoInput);

  // A plane through three atoms: three 1-based atom numbers, because that is
  // what the rest of the app shows ("atom 3"), not zero-based indices.
  const atomRow = el(doc, 'div', 'slice-atom-plane');
  const atomInputs = [0, 1, 2].map((slot) => {
    const input = el(doc, 'input');
    input.type = 'number';
    input.min = '1';
    input.step = '1';
    input.value = String(slot + 1);
    input.setAttribute('aria-label', `atom ${slot + 1} of the plane`);
    return input;
  });
  const atomButton = el(doc, 'button', 'button is-quiet', 'Plane through atoms');
  atomButton.type = 'button';
  atomRow.append(...atomInputs, atomButton);
  const atomNote = el(doc, 'p', 'slice-note');
  atomNote.hidden = true;

  controls.append(planeLabel, offsetLabel, isoLabel, atomRow);

  const frame = el(doc, 'div', 'slice-frame');
  const canvas = el(doc, 'canvas', 'slice-canvas');
  canvas.width = 320;
  canvas.height = 260;
  canvas.setAttribute('role', 'img');
  const legend = el(doc, 'div', 'slice-legend');
  legend.setAttribute('data-role', 'slice-legend');
  frame.append(canvas, legend);
  root.append(controls, frame);
  host.append(root);

  let field = null;
  let plane = 'xy';
  let offset = 0.5;
  let iso = null;
  let planeNote = '';
  let note = '';

  let atomList = Array.isArray(atoms) ? atoms : null;
  const updateAtomControls = () => {
    const ready = Array.isArray(atomList) && atomList.length >= 3;
    atomButton.disabled = !ready;
    atomInputs.forEach((input, slot) => {
      input.disabled = !ready;
      if (ready && Number(input.value) > atomList.length) input.value = String(Math.min(atomList.length, slot + 1));
    });
    atomRow.hidden = !ready;
  };

  /** A CSS variable resolved against the canvas, or `null` when unreadable. */
  const themeColour = (name) => {
    try {
      const value = doc.defaultView?.getComputedStyle?.(canvas)?.getPropertyValue?.(name);
      const trimmed = String(value ?? '').trim();
      return trimmed || null;
    } catch {
      return null;
    }
  };

  const context = () => {
    try {
      return canvas.getContext('2d');
    } catch {
      return null;
    }
  };

  const render = () => {
    if (!field) return null;
    const slice = sliceOfField(field, { plane, offset });
    const cssWidth = canvas.clientWidth || canvas.width;
    const cssHeight = canvas.clientHeight || canvas.height;
    const width = Math.max(2, Math.min(640, Math.round(cssWidth)));
    const height = Math.max(2, Math.min(640, Math.round(cssHeight)));
    canvas.width = width;
    canvas.height = height;
    const { rgba, range } = sliceRaster(slice, { width, height });
    const ctx = context();
    if (ctx) {
      const image = new ImageData(rgba, width, height);
      ctx.putImageData(image, 0, 0);
      // Iso lines, mapped from grid coordinates to pixels. Row 0 of the raster
      // is at the bottom, so the pixel y is flipped here too.
      const levels = [];
      if (Number.isFinite(iso) && iso !== 0) {
        levels.push(iso);
        if (slice.signed) levels.push(-iso);
      }
      if (levels.length) {
        ctx.save();
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        for (const level of levels) {
          // The iso lines take the theme's own lobe tones; a literal colour
          // here would be invisible on one of the three themes.
          const named = level > 0 ? '--tone-orange-14' : '--tone-blue-118';
          ctx.strokeStyle = themeColour(named) ?? ctx.strokeStyle;
          ctx.beginPath();
          for (const [x0, y0, x1, y1] of isoContours(slice, level)) {
            ctx.moveTo((x0 / (slice.width - 1)) * width, height - (y0 / (slice.height - 1)) * height);
            ctx.lineTo((x1 / (slice.width - 1)) * width, height - (y1 / (slice.height - 1)) * height);
          }
          ctx.stroke();
        }
        ctx.restore();
      }
    }
    legend.replaceChildren(...legendLines(slice, { iso, planeNote }).map((line) => el(doc, 'p', null, line)));
    if (note) legend.prepend(el(doc, 'p', 'slice-note', note));
    canvas.setAttribute(
      'aria-label',
      `${slice.label || 'field'} on the ${plane} plane, ${slice.width} by ${slice.height} samples, `
      + `range ${number(range.min)} to ${number(range.max)}`,
    );
    return { slice, range };
  };

  atomButton.addEventListener('click', () => {
    if (!Array.isArray(atomList) || atomList.length < 3) return;
    const indices = atomInputs.map((input) => Number(input.value) - 1);
    if (indices.some((index) => !Number.isInteger(index) || index < 0 || index >= atomList.length)) {
      atomNote.hidden = false;
      atomNote.textContent = `atom numbers must be 1 to ${atomList.length}`;
      return;
    }
    try {
      atomNote.hidden = true;
      setPlaneThroughAtoms(atomList, indices);
    } catch (error) {
      atomNote.hidden = false;
      atomNote.textContent = String(error?.message ?? error);
    }
  });

  planeSelect.addEventListener('change', () => {
    plane = planeSelect.value;
    planeNote = '';
    render();
  });
  offsetInput.addEventListener('input', () => {
    offset = Number(offsetInput.value);
    offsetValue.textContent = offset.toFixed(2);
    planeNote = '';
    render();
  });
  isoInput.addEventListener('input', () => {
    const value = Number(isoInput.value);
    iso = Number.isFinite(value) ? value : null;
    render();
  });

  /** The plane through three atoms, as far as the grid can express it. */
  function setPlaneThroughAtoms(list, indices) {
    const definition = planeThroughAtoms(list, indices);
    const nearest = nearestGridPlane(field, definition);
    plane = nearest.plane;
    planeSelect.value = nearest.plane;
    offset = nearest.offset;
    offsetInput.value = String(offset);
    offsetValue.textContent = offset.toFixed(2);
    planeNote = nearest.separationAngstrom < 1e-9
      ? 'through atoms'
      : `nearest grid plane, ${nearest.separationAngstrom.toFixed(3)} Å from the atoms`;
    render();
    return nearest;
  }

  updateAtomControls();

  return {
    element: root,
    canvas,
    legend,
    get field() {
      return field;
    },
    setField(next, { iso: nextIso = null, note: nextNote = '' } = {}) {
      field = next;
      note = nextNote ?? '';
      if (Number.isFinite(nextIso)) {
        iso = nextIso;
        isoInput.value = String(Number(nextIso.toPrecision(3)));
      }
      offset = 0.5;
      offsetInput.value = '0.5';
      offsetValue.textContent = '0.50';
      render();
    },
    setPlane(next) {
      if (!PLANE_NAMES.includes(next)) throw new RangeError(`unknown plane "${next}"`);
      plane = next;
      planeSelect.value = next;
      render();
    },
    setOffset(next) {
      const fraction = Math.min(1, Math.max(0, Number(next)));
      offset = Number.isFinite(fraction) ? fraction : 0.5;
      offsetInput.value = String(offset);
      offsetValue.textContent = offset.toFixed(2);
      render();
    },
    setIso(next) {
      iso = Number.isFinite(Number(next)) ? Number(next) : null;
      render();
    },
    /** Choose the plane through three atoms, and say how far it had to move. */
    setPlaneThroughAtoms,
    /** The geometry the atom-plane picker needs; ignored when it is not there. */
    setAtoms(list) {
      atomList = Array.isArray(list) ? list : null;
      updateAtomControls();
    },
    render,
    destroy() {
      root.remove();
    },
  };
}
