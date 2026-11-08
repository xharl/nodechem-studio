/**
 * The primitive-type table shared by the WFN and WFX readers (`wfn.js`,
 * `wfx.js`).
 *
 * Both AIM wavefunction formats describe the basis as a flat list of
 * **primitive functions**, not as shells: one entry per Cartesian component of
 * every primitive Gaussian, with an integer type code from 1 (S) to 56 (H).
 * That is the opposite of the checkpoint's shape, which groups primitives into
 * shells that each carry one contraction coefficient per primitive.
 *
 * The conversion here is a decontraction, and it is deliberately exact rather
 * than approximate: WFN carries an MO coefficient for every primitive function
 * but no contraction coefficients, so the only faithful mapping is one shell
 * per primitive, with a contraction coefficient of 1 and the MO coefficients
 * permuted from the file's component-major order into the shell-major order the
 * checkpoint path uses. Nothing is averaged, dropped or rescaled.
 *
 * The type codes are the AIMAll/Gaussian order documented in the WFX format
 * specification:
 *
 *   1 S
 *   2-4 PX PY PZ
 *   5-10 DXX DYY DZZ DXY DXZ DYZ
 *   11-20 FXXX FYYY FZZZ FXXY FXXZ FYYZ FXYY FXZZ FYZZ FXYZ
 *   21-35 G..., 36-56 H... in the order l, then (ix, iy) ascending
 *
 * Only Cartesian functions exist in these formats. There is no spherical
 * marker to read: a d shell is six functions, an f shell ten, a g shell
 * fifteen. `spherical` is therefore reported as all-false rather than guessed.
 */

import { BOHR_TO_ANGSTROM } from './cubeFile.js';

export class AimFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AimFormatError';
  }
}

/** Cartesian component labels, in the order the AIM formats number them. */
const COMPONENTS = Object.freeze([
  ['S'],
  ['X', 'Y', 'Z'],
  ['XX', 'YY', 'ZZ', 'XY', 'XZ', 'YZ'],
  ['XXX', 'YYY', 'ZZZ', 'XXY', 'XXZ', 'YYZ', 'XYY', 'XZZ', 'YZZ', 'XYZ'],
  [
    'XXXX', 'YYYY', 'ZZZZ', 'XXXY', 'XXXZ', 'XYYY', 'YYYZ', 'XZZZ', 'YZZZ',
    'XXYY', 'XXZZ', 'YYZZ', 'XXYZ', 'XYYZ', 'XYZZ',
  ],
  [
    'ZZZZZ', 'YZZZZ', 'YYZZZ', 'YYYZZ', 'YYYYZ', 'YYYYY', 'XZZZZ', 'XYZZZ',
    'XYYZZ', 'XYYYZ', 'XYYYY', 'XXZZZ', 'XXYZZ', 'XXYYZ', 'XXYYY', 'XXXZZ',
    'XXXYZ', 'XXXYY', 'XXXXZ', 'XXXXY', 'XXXXX',
  ],
]);

function countFor(l) {
  return ((l + 1) * (l + 2)) / 2;
}

/** type code (1-based) → { code, l, component, label }. */
const TYPES = [];
for (let l = 0; l < COMPONENTS.length; l += 1) {
  for (let component = 0; component < COMPONENTS[l].length; component += 1) {
    TYPES.push({
      code: TYPES.length + 1,
      l,
      component,
      label: COMPONENTS[l][component],
    });
  }
}

export function describeAimType(code, where = 'the primitive type table') {
  const type = TYPES[Number(code) - 1];
  if (!type) {
    throw new AimFormatError(
      `${where} has primitive type ${code}; the AIM tables define 1-56 (S through H in Cartesian order).`,
    );
  }
  return type;
}

export function cartesianCount(l) {
  return countFor(l);
}

/**
 * Turn the flat primitive list of a WFN/WFX file into checkpoint-shaped
 * shells.
 *
 * Inputs are the three parallel arrays the formats carry: a 1-based centre per
 * primitive function, a type code per primitive function, and an exponent per
 * primitive function. Output is the field set `fchk.js` produces, plus
 * `permutation`: `permutation[outIndex]` is the input index of the primitive
 * function that the `outIndex`-th basis function corresponds to. A caller
 * applies it to an MO coefficient run with
 * `coeffs.map((_, index) => coeffs[permutation[index]])`.
 *
 * Every shell produced has exactly one primitive and a contraction coefficient
 * of 1. A p shell therefore contributes three basis functions (px, py, pz) and
 * consumes three primitive entries, which is why `numberOfBasisFunctions`
 * equals the number of entries.
 */
export function groupAimPrimitives({
  centres, types, exponents, where = 'the primitive table', atomCount = null,
}) {
  if (!Array.isArray(centres) || !Array.isArray(types) || !Array.isArray(exponents)) {
    throw new TypeError('groupAimPrimitives needs centres, types and exponents arrays.');
  }
  if (centres.length !== types.length || centres.length !== exponents.length) {
    throw new AimFormatError(
      `${where} has ${centres.length} centres, ${types.length} types and ${exponents.length} exponents; `
      + 'the three arrays must be the same length.',
    );
  }
  if (types.length === 0) {
    throw new AimFormatError(`${where} is empty; a wavefunction needs at least one primitive function.`);
  }

  const shells = [];
  const permutation = [];

  let index = 0;
  while (index < types.length) {
    const first = describeAimType(types[index], where);
    const { l } = first;
    const ncart = countFor(l);

    if (l === 0) {
      // Each s entry is one primitive function and therefore its own shell.
      let run = 1;
      while (index + run < types.length && types[index + run] === types[index]) run += 1;
      for (let k = 0; k < run; k += 1) {
        const at = index + k;
        const atom = centres[at];
        if (!Number.isInteger(atom) || atom < 1 || (atomCount !== null && atom > atomCount)) {
          throw new AimFormatError(
            `${where} entry ${at + 1} is centred on atom ${atom}; the file has ${atomCount ?? 'an unknown number of'} nuclei.`,
          );
        }
        shells.push({
          atom,
          type: 0,
          label: 's',
          primitives: [{ exponent: exponents[at], s: 1 }],
        });
        permutation.push(at);
      }
      index += run;
      continue;
    }

    // Collect the component runs of one shell block. The WFN format fixes the
    // type *code* of every Cartesian component but not the order the blocks
    // appear in: real files write f as 11 12 13 17 14 15 18 19 16 20 rather
    // than 11..20. The code is therefore used as the component identity, not
    // the position.
    const runs = [];
    let cursor = index;
    while (cursor < types.length) {
      const type = describeAimType(types[cursor], where);
      if (type.l !== l) break;
      if (runs.some((run) => run.component === type.component)) break;
      let length = 1;
      while (cursor + length < types.length && types[cursor + length] === types[cursor]) length += 1;
      runs.push({ component: type.component, code: types[cursor], start: cursor, length });
      cursor += length;
    }
    if (runs.length !== ncart) {
      throw new AimFormatError(
        `${where} has ${runs.length} component block${runs.length === 1 ? '' : 's'} for a `
        + `${'spdfgh'[l]} shell at entry ${index + 1}; ${ncart} are needed.`,
      );
    }
    const runLength = runs[0].length;
    if (runs.some((run) => run.length !== runLength)) {
      throw new AimFormatError(
        `${where} has unequal component blocks for the ${'spdfgh'[l]} shell at entry ${index + 1} `
        + `(${runs.map((run) => run.length).join(', ')} entries); a shell needs the same primitive count in every component.`,
      );
    }
    for (let k = 0; k < runLength; k += 1) {
      const reference = runs[0].start + k;
      for (const run of runs) {
        const at = run.start + k;
        if (centres[at] !== centres[reference]) {
          throw new AimFormatError(
            `${where} entry ${at + 1} is centred on atom ${centres[at]} but the matching `
            + `${COMPONENTS[l][runs[0].component]} primitive is on atom ${centres[reference]}; a shell cannot span two centres.`,
          );
        }
        const scale = Math.max(1, Math.abs(exponents[at]), Math.abs(exponents[reference]));
        if (Math.abs(exponents[at] - exponents[reference]) > 1e-9 * scale) {
          throw new AimFormatError(
            `${where} entry ${at + 1} has exponent ${exponents[at]} but the matching `
            + `${COMPONENTS[l][runs[0].component]} primitive has ${exponents[reference]}; a shell cannot mix exponents.`,
          );
        }
      }
    }

    for (let k = 0; k < runLength; k += 1) {
      const atom = centres[runs[0].start + k];
      if (!Number.isInteger(atom) || atom < 1 || (atomCount !== null && atom > atomCount)) {
        throw new AimFormatError(
          `${where} entry ${runs[0].start + k + 1} is centred on atom ${atom}; the file has ${atomCount ?? 'an unknown number of'} nuclei.`,
        );
      }
      shells.push({
        atom,
        type: l,
        label: 'spdfgh'[l],
        primitives: [{ exponent: exponents[runs[0].start + k], s: 1 }],
      });
      for (let component = 0; component < ncart; component += 1) {
        const run = runs.find((candidate) => candidate.component === component);
        permutation.push(run.start + k);
      }
    }
    index = cursor;
  }

  const shellTypes = shells.map((shell) => shell.type);
  const primitivesPerShell = shells.map((shell) => shell.primitives.length);
  const shellToAtomMap = shells.map((shell) => shell.atom);
  const primitiveExponents = [];
  const contractionCoefficients = [];
  for (const shell of shells) {
    for (const primitive of shell.primitives) {
      primitiveExponents.push(primitive.exponent);
      contractionCoefficients.push(primitive.s);
    }
  }

  return {
    shells,
    shellTypes,
    primitivesPerShell,
    shellToAtomMap,
    primitiveExponents,
    contractionCoefficients,
    numberOfBasisFunctions: permutation.length,
    permutation,
  };
}

/** `spherical` for a Cartesian-only AIM basis. */
export const AIM_SPHERICAL = Object.freeze({ d: false, f: false, g: false });

/**
 * Read a contracted, labelled shell table (the non-Gaussian ordering accepted
 * by `wfn.js`): a row names the shell, then one `exponent coefficient` row per
 * primitive.
 *
 * Only labels whose component order is unambiguous are returned. `d`, `f` and
 * higher are refused by the caller, because a one-letter label does not state
 * whether the six d components are `xx yy zz xy xz yz` (the Cartesian order
 * this app uses) or another program's order — and a coefficient attached to
 * the wrong component is wrong science with no visible symptom.
 */
export const LABELLED_SHELLS = Object.freeze({
  s: { type: 0, functions: 1, coefficients: 1 },
  p: { type: 1, functions: 3, coefficients: 1 },
  sp: { type: -1, functions: 4, coefficients: 2 },
});

/**
 * Convert one atom's coordinates from bohr to Å, once. The AIM formats store
 * bohr; the rest of the app stores Å.
 */
export function angstromOf(bohr) {
  return bohr * BOHR_TO_ANGSTROM;
}
