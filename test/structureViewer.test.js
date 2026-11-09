import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  INVALID_MODES_NOTICE,
  NO_MODES_NOTICE,
  boundingBox,
  describeModes,
  detectBonds,
  elementStyle,
  fitCamera,
  modeFrame,
  prepareGeometry,
  projectAtoms,
  resolveStructure,
  rotationOf,
} from '../src/renderer/structureViewer.js';
import { parseStructure } from '../src/shared/structureImport.js';
import { parseGaussianOutput } from '../src/shared/gaussianOutput.js';

const WATER_XYZ = `3
water
O 0.000000 0.000000 0.117300
H 0.000000 0.757200 -0.469200
H 0.000000 -0.757200 -0.469200
`;

const METHANE_XYZ = `5
methane
C 0.000000 0.000000 0.000000
H 0.629118 0.629118 0.629118
H -0.629118 -0.629118 0.629118
H -0.629118 0.629118 -0.629118
H 0.629118 -0.629118 -0.629118
`;

const FE_CL4 = [
  { element: 'Fe', x: 0, y: 0, z: 0 },
  { element: 'Cl', x: 2.3, y: 0, z: 0 },
  { element: 'Cl', x: -2.3, y: 0, z: 0 },
  { element: 'Cl', x: 0, y: 2.3, z: 0 },
  { element: 'Cl', x: 0, y: 0, z: 2.3 },
];

/** Three-atom mode with a flat Gaussian displacement layout. */
const WATER_MODES = {
  frequencies: [-420.5, 610.2, 1580.0],
  displacements: [
    [0.0, 0.30, 0.0, 0.0, -0.15, 0.0, 0.0, -0.15, 0.0],
    [0.0, 0.0, 0.10, 0.0, 0.0, -0.05, 0.0, 0.0, -0.05],
    [0.20, 0.0, 0.0, -0.10, 0.0, 0.0, -0.10, 0.0, 0.0],
  ],
};

function maxVector(vectors) {
  return Math.max(...vectors.map((vector) => Math.hypot(vector.x, vector.y, vector.z)));
}

describe('element mapping', () => {
  it('maps common elements to their covalent radius and CPK colour', () => {
    expect(elementStyle('C')).toEqual({ symbol: 'C', color: '#909090', radius: 0.76, known: true });
    expect(elementStyle('O').radius).toBeCloseTo(0.66, 6);
    expect(elementStyle('O').color).toBe('#ff0d0d');
    expect(elementStyle('H').color).toBe('#f4f7fb');
  });

  it('covers metals so a metal complex has real radii and colours', () => {
    for (const symbol of ['Fe', 'Cu', 'Zn', 'Pd', 'Pt', 'Au']) {
      const style = elementStyle(symbol);
      expect(style.known, symbol).toBe(true);
      expect(style.radius, symbol).toBeGreaterThan(1);
      expect(style.color, symbol).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('falls back safely for an unknown symbol instead of throwing', () => {
    const style = elementStyle('Xx');
    expect(style.known).toBe(false);
    expect(style.radius).toBeGreaterThan(0);
    expect(style.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(() => prepareGeometry([{ element: 'Xx', x: 0, y: 0, z: 0 }])).not.toThrow();
  });
});

describe('geometry preparation from an imported .xyz', () => {
  it('keeps the imported atom order, elements and relative coordinates', () => {
    const structure = parseStructure(WATER_XYZ, { filename: 'water.xyz' });
    const prepared = prepareGeometry(structure);
    const xs = structure.atoms.map((atom) => atom.x);
    const ys = structure.atoms.map((atom) => atom.y);
    const zs = structure.atoms.map((atom) => atom.z);
    const centre = {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
      z: (Math.min(...zs) + Math.max(...zs)) / 2,
    };

    expect(prepared.atomCount).toBe(3);
    expect(prepared.atoms.map((atom) => atom.element)).toEqual(['O', 'H', 'H']);
    prepared.atoms.forEach((atom, index) => {
      const source = structure.atoms[index];
      expect(atom.cx).toBeCloseTo(source.x - centre.x, 10);
      expect(atom.cy).toBeCloseTo(source.y - centre.y, 10);
      expect(atom.cz).toBeCloseTo(source.z - centre.z, 10);
      expect(atom.x).toBe(source.x);
      expect(atom.y).toBe(source.y);
      expect(atom.z).toBe(source.z);
    });

    // The O–H distance is invariant under the centring transform.
    expect(prepared.bonds.length).toBe(2);
    const ohDistances = prepared.bonds.map((bond) => bond.distance).sort();
    const expected = Math.hypot(0.7572, 0.5865);
    expect(ohDistances[0]).toBeCloseTo(expected, 6);
    expect(ohDistances[1]).toBeCloseTo(expected, 6);
  });

  it('centres every prepared atom inside a bounding box symmetric about zero', () => {
    const prepared = prepareGeometry(parseStructure(WATER_XYZ, { filename: 'water.xyz' }));
    for (const axis of ['cx', 'cy', 'cz']) {
      const values = prepared.atoms.map((atom) => atom[axis]);
      expect((Math.min(...values) + Math.max(...values)) / 2).toBeCloseTo(0, 10);
    }
    expect(prepared.box.min.x).toBeCloseTo(-prepared.box.max.x, 10);
    expect(prepared.box.min.y).toBeCloseTo(-prepared.box.max.y, 10);
    expect(prepared.box.min.z).toBeCloseTo(-prepared.box.max.z, 10);
  });

  it('refuses a geometry with no atoms or a non-finite coordinate', () => {
    expect(() => prepareGeometry({ atoms: [] })).toThrow(/at least one atom/i);
    expect(() => prepareGeometry([{ element: 'C', x: 0, y: Number.NaN, z: 0 }])).toThrow(/coordinate/i);
  });

  it('prepares the finalGeometry shape produced by the output parser', () => {
    const text = readFileSync(new URL('./fixtures/synthetic-parser-coverage.out', import.meta.url), 'utf8');
    const parsed = parseGaussianOutput(text);
    expect(parsed.finalGeometry).not.toBeNull();
    const prepared = prepareGeometry(parsed.finalGeometry);
    expect(prepared.atomCount).toBe(4);
    expect(prepared.atoms.map((atom) => atom.element)).toEqual(['C', 'H', 'H', 'H']);
    // Parser-only fields stay available to the caller.
    expect(prepared.atoms[0].atomicNumber).toBe(6);
    // The fixture's optimised geometry is the methyl fragment (C + 3 H), so the
    // viewer must perceive exactly three C–H bonds — not four, and no H–H bond.
    expect(prepared.bonds.length).toBe(3);
    expect(prepared.bonds.every((bond) => bond.a === 0 || bond.b === 0)).toBe(true);
  });
});

describe('bond detection from covalent-radius sums', () => {
  it('finds two O–H bonds in water and no H–H bond', () => {
    const prepared = prepareGeometry(parseStructure(WATER_XYZ, { filename: 'water.xyz' }));
    const pairs = prepared.bonds.map((bond) => [bond.a, bond.b]).sort();
    expect(pairs).toEqual([[0, 1], [0, 2]]);
  });

  it('finds all four C–H bonds in methane', () => {
    const prepared = prepareGeometry(parseStructure(METHANE_XYZ, { filename: 'methane.xyz' }));
    expect(prepared.bonds.length).toBe(4);
    expect(prepared.bonds.every((bond) => [bond.a, bond.b].includes(0))).toBe(true);
  });

  it('does not bond atoms that are farther apart than the radius sum allows', () => {
    const far = [
      { element: 'C', x: 0, y: 0, z: 0, radius: elementStyle('C').radius },
      { element: 'C', x: 3.0, y: 0, z: 0, radius: elementStyle('C').radius },
    ];
    expect(detectBonds(far)).toEqual([]);
    const bonded = [{ ...far[0], x: 1.54 }, far[1]];
    expect(detectBonds(bonded).length).toBe(1);
  });

  it('handles a metal complex without crashing and bonds Fe–Cl contacts', () => {
    const prepared = prepareGeometry(FE_CL4);
    expect(prepared.atomCount).toBe(5);
    expect(prepared.bonds.length).toBe(4);
    expect(prepared.bonds.every((bond) => bond.a === 0 || bond.b === 0)).toBe(true);
    for (const bond of prepared.bonds) {
      const other = bond.a === 0 ? bond.b : bond.a;
      expect(prepared.atoms[other].element).toBe('Cl');
      expect(bond.distance).toBeCloseTo(2.3, 6);
    }
  });
});

describe('bounding box and fit-to-view', () => {
  it('computes the box, centre, size and half-diagonal radius', () => {
    const box = boundingBox([
      { x: -1, y: -2, z: -3 },
      { x: 3, y: 4, z: 5 },
    ]);
    expect(box.min).toEqual({ x: -1, y: -2, z: -3 });
    expect(box.max).toEqual({ x: 3, y: 4, z: 5 });
    expect(box.center).toEqual({ x: 1, y: 1, z: 1 });
    expect(box.size).toEqual({ x: 4, y: 6, z: 8 });
    expect(box.radius).toBeCloseTo(Math.hypot(4, 6, 8) / 2, 10);
  });

  it('fits every atom inside the viewport at an arbitrary rotation', () => {
    const prepared = prepareGeometry(parseStructure(METHANE_XYZ, { filename: 'methane.xyz' }));
    const rotation = rotationOf(0.73, -0.41);
    const width = 400;
    const height = 300;
    const padding = 20;
    const camera = fitCamera(prepared, { width, height, padding, rotation });
    const projected = projectAtoms(prepared, { ...camera, rotation, zoom: 1 });

    expect(camera.scale).toBeGreaterThan(0);
    for (const atom of projected) {
      expect(atom.sx).toBeGreaterThanOrEqual(padding);
      expect(atom.sx).toBeLessThanOrEqual(width - padding);
      expect(atom.sy).toBeGreaterThanOrEqual(padding);
      expect(atom.sy).toBeLessThanOrEqual(height - padding);
    }
  });

  it('uses the bounding box: a wider molecule gets a smaller scale', () => {
    const compact = prepareGeometry([
      { element: 'C', x: 0, y: 0, z: 0 },
      { element: 'C', x: 1.54, y: 0, z: 0 },
    ]);
    const extended = prepareGeometry([
      { element: 'C', x: 0, y: 0, z: 0 },
      { element: 'C', x: 15.4, y: 0, z: 0 },
    ]);
    const rotation = rotationOf(0, 0);
    const compactCamera = fitCamera(compact, { width: 400, height: 300, rotation });
    const extendedCamera = fitCamera(extended, { width: 400, height: 300, rotation });
    expect(extendedCamera.scale).toBeLessThan(compactCamera.scale);
  });

  it('centres the projected bounding box in the viewport', () => {
    const prepared = prepareGeometry(parseStructure(WATER_XYZ, { filename: 'water.xyz' }));
    const rotation = rotationOf(0.4, 0.15);
    const camera = fitCamera(prepared, { width: 321, height: 245, padding: 12, rotation });
    const projected = projectAtoms(prepared, { ...camera, rotation, zoom: 1 });
    const xs = projected.map((atom) => atom.sx);
    const ys = projected.map((atom) => atom.sy);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeGreaterThan(321 / 2 - 30);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeLessThan(321 / 2 + 30);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeGreaterThan(245 / 2 - 30);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeLessThan(245 / 2 + 30);
  });
});

describe('normal-mode availability', () => {
  it('reports the explicit notice when a parsed geometry has no modes', () => {
    const resolved = resolveStructure({
      type: 'calculate',
      output: {
        parsed: {
          finalGeometry: {
            source: 'standard',
            atoms: parseStructure(WATER_XYZ, { filename: 'water.xyz' }).atoms,
          },
        },
      },
    });
    expect(resolved).not.toBeNull();
    expect(resolved.modes.available).toBe(false);
    expect(resolved.modes.notice).toBe(NO_MODES_NOTICE);
    expect(resolved.modes.displacements).toEqual([]);
  });

  it('returns null for a calc node without a parsed geometry instead of faking one', () => {
    expect(resolveStructure({ type: 'calculate', output: { file: 'r_opt.log', size: '1.8 MB' } })).toBeNull();
    expect(resolveStructure({ type: 'condition' })).toBeNull();
    expect(resolveStructure(null)).toBeNull();
  });

  it('carries an optional modes block from the parsed output into the model', () => {
    const resolved = resolveStructure({
      type: 'calculate',
      output: {
        parsed: {
          finalGeometry: {
            source: 'standard',
            atoms: parseStructure(WATER_XYZ, { filename: 'water.xyz' }).atoms,
          },
          modes: WATER_MODES,
        },
      },
    });
    expect(resolved).not.toBeNull();
    expect(resolved.modes.available).toBe(true);
    expect(resolved.modes.frequencies).toEqual(WATER_MODES.frequencies);
    expect(resolved.modes.defaultIndex).toBe(0);
  });

  it('rejects malformed mode data with a notice rather than animating it', () => {
    const short = describeModes({ frequencies: [10], displacements: [[0, 0, 0]] }, 3);
    expect(short.available).toBe(false);
    expect(short.notice).toBe(INVALID_MODES_NOTICE);

    const mismatched = describeModes({ frequencies: [10, 20], displacements: [WATER_MODES.displacements[0]] }, 3);
    expect(mismatched.available).toBe(false);
    expect(mismatched.notice).toBe(NO_MODES_NOTICE);
  });

  it('selects the imaginary mode by default, most negative first', () => {
    const modes = describeModes({
      frequencies: [610, -420.5, -88.2],
      displacements: [WATER_MODES.displacements[1], WATER_MODES.displacements[0], WATER_MODES.displacements[2]],
    }, 3);
    expect(modes.available).toBe(true);
    expect(modes.imaginaryIndices).toEqual([1, 2]);
    expect(modes.defaultIndex).toBe(1);

    const realOnly = describeModes(WATER_MODES, 3);
    expect(realOnly.defaultIndex).toBe(0);
  });

  it('accepts per-atom vector displacements as well as the flat layout', () => {
    const vectorForm = {
      frequencies: [100],
      displacements: [[
        { x: 0, y: 0.3, z: 0 },
        [0, -0.15, 0],
        { x: 0, y: -0.15, z: 0 },
      ]],
    };
    const modes = describeModes(vectorForm, 3);
    expect(modes.available).toBe(true);
    expect(modes.displacements[0][1]).toEqual({ x: 0, y: -0.15, z: 0 });
  });
});

describe('mode-animation frame maths', () => {
  it('peaks at the requested amplitude at phase π/2 and preserves relative signs', () => {
    const modes = describeModes(WATER_MODES, 3);
    const frame = modeFrame(modes, 0, Math.PI / 2, 0.6);
    expect(frame).not.toBeNull();
    expect(maxVector(frame)).toBeCloseTo(0.6, 10);
    expect(frame[0].y).toBeCloseTo(0.6, 10);
    expect(frame[1].y).toBeCloseTo(-0.3, 10);
    expect(frame[2].y).toBeCloseTo(-0.3, 10);
  });

  it('reverses sign at phase 3π/2 and is motionless at phase 0', () => {
    const modes = describeModes(WATER_MODES, 3);
    const reversed = modeFrame(modes, 0, (3 * Math.PI) / 2, 0.6);
    expect(reversed[0].y).toBeCloseTo(-0.6, 10);
    expect(reversed[1].y).toBeCloseTo(0.3, 10);

    const rest = modeFrame(modes, 0, 0, 0.6);
    expect(rest.every((vector) => vector.x === 0 && vector.y === 0 && vector.z === 0)).toBe(true);
  });

  it('scales linearly with amplitude and returns null without mode data', () => {
    const modes = describeModes(WATER_MODES, 3);
    const small = modeFrame(modes, 0, Math.PI / 2, 0.3);
    const large = modeFrame(modes, 0, Math.PI / 2, 0.9);
    expect(maxVector(large)).toBeCloseTo(maxVector(small) * 3, 10);
    expect(modeFrame(describeModes(null, 3), 0, Math.PI / 2, 0.6)).toBeNull();
    expect(modeFrame(modes, 99, Math.PI / 2, 0.6)).toBeNull();
  });
});

describe('renderer contract', () => {
  it('has no network or Node APIs in the viewer module', () => {
    const source = readFileSync(new URL('../src/renderer/structureViewer.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
    expect(source).not.toMatch(/from ['"]node:/);
    expect(source).not.toMatch(/require\s*\(/);
  });
});
