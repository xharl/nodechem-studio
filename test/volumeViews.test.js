import { describe, expect, it } from 'vitest';
import {
  colourCoverage,
  colourRange,
  divergingColor,
  isoContours,
  legendLines,
  sequentialColor,
  sliceRaster,
} from '../src/renderer/sliceView.js';
import { NO_WEBGL2_MESSAGE, cameraMatrices } from '../src/renderer/surfaceViewer.js';
import { basisOf, orbitalList } from '../src/renderer/wavefunctionViewport.js';

/**
 * The renderers' arithmetic, without a canvas.
 *
 * A palette or a contour that is off by a row still looks like a picture, so
 * these are the assertions that keep the picture honest. The WebGL2 path
 * itself cannot be exercised here — this container has no GPU and Node has no
 * canvas — but the camera matrices can: they are the one part of the viewer
 * whose correctness is a number rather than a visual impression.
 */


function slice({ values, width, height, signed = true, min = -1, max = 1, plane = 'xy', unit = 'a.u.' }) {
  return {
    plane,
    index: 1,
    offset: 0.5,
    width,
    height,
    values: Float64Array.from(values),
    min,
    max,
    signed,
    unit,
    label: 'MO 4',
    axes: [[0.5, 0, 0], [0, 0.5, 0]],
    origin: [0, 0, 0.25],
  };
}

describe('the slice palette', () => {
  it('fades to the background at zero and gives the two phases opposite hues', () => {
    // Zero is transparent, so the theme supplies the background; a fixed colour
    // here would be wrong on one of the three themes.
    expect(colourCoverage(0)).toBe(0);
    expect(colourCoverage(0.5)).toBeGreaterThan(0.9);
    expect(colourCoverage(-1)).toBe(1);
    const negative = divergingColor(-0.8);
    const positive = divergingColor(0.8);
    expect(negative[2]).toBeGreaterThan(negative[0]);
    expect(positive[0]).toBeGreaterThan(positive[2]);
  });

  it('colours a signed slice symmetrically about zero, whatever the data range', () => {
    const range = colourRange(slice({ values: [-0.2, 0.05, 0, 0], width: 2, height: 2, min: -0.2, max: 0.05 }));
    // The smaller side still gets the full ramp: a lobe must not look weak
    // because the other phase happens to be bigger.
    expect(range.min).toBeCloseTo(-0.2, 12);
    expect(range.max).toBeCloseTo(0.2, 12);
  });

  it('is sequential, and non-negative, for a density', () => {
    expect(colourCoverage(0)).toBe(0);
    const bright = sequentialColor(1);
    expect(bright[0] + bright[1] + bright[2]).toBeGreaterThan(300);
    const range = colourRange(slice({ values: [0, 0.4], width: 2, height: 1, signed: false, min: 0, max: 0.4 }));
    expect(range.min).toBe(0);
    expect(range.max).toBe(0.4);
  });
});

describe('the slice raster', () => {
  const plane = slice({ values: [-0.5, 0, 0, 0.5], width: 2, height: 2, min: -0.5, max: 0.5 });
  const { rgba, width, height } = sliceRaster(plane, { width: 2, height: 2 });

  it('writes four pixels in row-major, bottom row first', () => {
    expect(width).toBe(2);
    expect(height).toBe(2);
    expect(rgba).toHaveLength(16);
    // Coverage carries the zero level: the two zero samples are transparent,
    // the two lobes are opaque. Raster row 0 is the slice's *top* row, so the
    // alphas read (zero, lobe), (lobe, zero).
    expect([...rgba.filter((_, at) => at % 4 === 3)]).toEqual([0, 255, 255, 0]);
  });

  it('puts the lowest row of the slice at the bottom of the image', () => {
    // Row 0 of the slice is (values 0, 0 → the negative one at column 0), and
    // it belongs at the *bottom* of the canvas, i.e. the last raster row.
    const bottomLeft = rgba.slice(8 + 0, 8 + 3);
    expect(bottomLeft[2]).toBeGreaterThan(bottomLeft[0]);
  });

  it('scales without inventing detail: the raster keeps the number of samples it was given', () => {
    const scaled = sliceRaster(plane, { width: 40, height: 40 });
    expect(scaled.rgba).toHaveLength(40 * 40 * 4);
    // Nearest sampling means only the four source colours appear.
    const seen = new Set();
    for (let at = 0; at < scaled.rgba.length; at += 4) seen.add(`${scaled.rgba[at]},${scaled.rgba[at + 1]},${scaled.rgba[at + 2]}`);
    expect(seen.size).toBeLessThanOrEqual(3); // negative, the zero colour, positive
  });
});

describe('iso contours', () => {
  it('finds a straight line where a linear ramp crosses the level', () => {
    // A 3×3 slice whose value is the column index: the contour at 1.5 is the
    // vertical line between columns 1 and 2.
    const values = [];
    for (let row = 0; row < 3; row += 1) for (let column = 0; column < 3; column += 1) values.push(column);
    const segments = isoContours(slice({ values, width: 3, height: 3, min: 0, max: 2 }), 1.5);
    expect(segments.length).toBeGreaterThan(0);
    for (const [x0, y0, x1, y1] of segments) {
      expect(x0).toBeCloseTo(1.5, 12);
      expect(x1).toBeCloseTo(1.5, 12);
      expect(y1 - y0).toBeCloseTo(1, 12);
    }
    // Two cells high, so one segment per cell row.
    expect(segments).toHaveLength(2);
    expect(segments.map(([, y0]) => y0).sort()).toEqual([0, 1]);
  });

  it('returns nothing when the level misses the plane', () => {
    const values = [1, 1, 1, 1];
    expect(isoContours(slice({ values, width: 2, height: 2, min: 1, max: 1 }), 5)).toEqual([]);
    expect(isoContours(slice({ values, width: 2, height: 2 }), Number.NaN)).toEqual([]);
  });

  it('closes a ring through a peak', () => {
    const values = [0, 0, 0, 0, 1, 0, 0, 0, 0];
    const segments = isoContours(slice({ values, width: 3, height: 3, min: 0, max: 1 }), 0.5);
    // Four crossings around the centre, joined into a closed diamond.
    expect(segments).toHaveLength(4);
    const ends = new Set();
    for (const [x0, y0, x1, y1] of segments) {
      ends.add(`${x0.toFixed(2)},${y0.toFixed(2)}`);
      ends.add(`${x1.toFixed(2)},${y1.toFixed(2)}`);
    }
    expect(ends).toEqual(new Set(['0.50,1.00', '1.00,0.50', '1.50,1.00', '1.00,1.50']));
  });
});

describe('the slice legend', () => {
  it('states the field, the plane and its offset in Å, and the range', () => {
    const lines = legendLines(slice({ values: [-0.3, 0.2], width: 2, height: 1, min: -0.3, max: 0.2 }), { iso: 0.02 });
    expect(lines[0]).toBe('MO 4 · a.u.');
    expect(lines[1]).toContain('plane xy at z = 0.250 Å');
    expect(lines[1]).toContain('index 1');
    expect(lines[2]).toContain('diverging about zero');
    expect(lines[2]).toContain('-0.300');
    expect(lines[3]).toBe('iso lines at ±0.020 a.u.');
  });

  it('names a density as a sequential field', () => {
    const lines = legendLines(slice({
      values: [0, 1], width: 2, height: 1, signed: false, min: 0, max: 1, unit: 'e/bohr^3',
    }));
    expect(lines[0]).toBe('MO 4 · e/bohr^3');
    expect(lines[2]).toContain('sequential');
  });

  it('records a plane that had to move to the nearest grid plane', () => {
    const lines = legendLines(
      slice({ values: [0, 1], width: 2, height: 1 }),
      { planeNote: 'nearest grid plane, 0.140 Å from the atoms' },
    );
    expect(lines[1]).toContain('nearest grid plane, 0.140 Å from the atoms');
  });
});

/** Apply a column-major 4×4 to a point and divide by w. */
function project(matrix, [x, y, z]) {
  const out = [];
  for (let row = 0; row < 4; row += 1) {
    out.push(matrix[row] * x + matrix[4 + row] * y + matrix[8 + row] * z + matrix[12 + row]);
  }
  return { x: out[0] / out[3], y: out[1] / out[3], z: out[2] / out[3], w: out[3] };
}

describe('the orbit camera', () => {
  it('puts the centre of the mesh in the middle of the view, in front of the camera', () => {
    const camera = cameraMatrices({ centre: [1, 2, 3], radius: 2, aspect: 1.5 });
    const centre = project(camera.mvp, [1, 2, 3]);
    expect(centre.x).toBeCloseTo(0, 6);
    expect(centre.y).toBeCloseTo(0, 6);
    expect(centre.w).toBeGreaterThan(0);
    expect(Math.abs(centre.z)).toBeLessThan(1);
  });

  it('keeps the whole mesh on screen and pushes a distant point off it', () => {
    const camera = cameraMatrices({ centre: [0, 0, 0], radius: 1, distance: 2.4, aspect: 1 });
    const edge = project(camera.mvp, [1, 0, 0]);
    expect(edge.w).toBeGreaterThan(0);
    expect(Math.abs(edge.x)).toBeLessThan(1);
    const far = project(camera.mvp, [6, 0, 0]);
    expect(Math.abs(far.x)).toBeGreaterThan(1);
  });

  it('is a proper rotation, so the lighting does not flip with the orbit', () => {
    const { rotation } = cameraMatrices({ yaw: 0.9, pitch: -0.4 });
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        let dot = 0;
        for (let at = 0; at < 3; at += 1) dot += rotation[at * 3 + row] * rotation[at * 3 + column];
        expect(dot).toBeCloseTo(row === column ? 1 : 0, 6);
      }
    }
  });

  it('states the missing-GPU message instead of leaving a blank canvas', () => {
    expect(NO_WEBGL2_MESSAGE).toBe('surface view unavailable: no WebGL2 context');
  });
});

describe('the orbital list a record offers', () => {
  const parsed = {
    numberOfBasisFunctions: 2,
    numberOfAlphaElectrons: 1,
    numberOfBetaElectrons: 1,
    orbitalEnergies: [-0.5, 0.2],
    alphaMOCoefficients: [0.9, 0.1, -0.3, 0.8],
  };

  it('slices the flat alpha matrix into columns and marks the occupied MO doubly', () => {
    const list = orbitalList(parsed);
    expect(list).toHaveLength(2);
    expect(list[0].coefficients).toEqual([0.9, 0.1]);
    expect(list[1].coefficients).toEqual([-0.3, 0.8]);
    expect(list[0].occupation).toBe(2);
    expect(list[1].occupation).toBe(0);
    // A density built from these adds up to the electron count, not to a guess.
    expect(list.reduce((total, orbital) => total + orbital.occupation, 0)).toBe(2);
  });

  it('uses the occupations Molden carries when they are there', () => {
    const molden = {
      orbitals: [
        { spin: 'Alpha', energy: -0.5, occupation: 2, coefficients: [1, 0] },
        { spin: 'Beta', energy: -0.5, occupation: 0, coefficients: [1, 0] },
        { spin: 'Alpha', energy: 0.2, occupation: 0, coefficients: [0, 1] },
      ],
    };
    const list = orbitalList(molden);
    expect(list).toHaveLength(2);
    expect(list.map((orbital) => orbital.occupation)).toEqual([2, 0]);
  });

  it('reports zero occupations when the file states no electron count', () => {
    const list = orbitalList({ ...parsed, numberOfAlphaElectrons: undefined, numberOfBetaElectrons: undefined });
    expect(list.every((orbital) => orbital.occupation === 0)).toBe(true);
  });

  it('finds the basis of a checkpoint-shaped record and refuses one without a basis', () => {
    expect(basisOf({ parsed })).toBeNull();
    const record = {
      parsed: {
        shellTypes: [0],
        primitivesPerShell: [1],
        shellToAtomMap: [1],
        primitiveExponents: [1.2],
        contractionCoefficients: [1],
        numberOfBasisFunctions: 1,
      },
    };
    const basis = basisOf(record);
    expect(basis.shells).toHaveLength(1);
    expect(basis.numberOfBasisFunctions).toBe(1);
    expect(basisOf({ parsed: { numberOfAtoms: 3 } })).toBeNull();
  });
});
