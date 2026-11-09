# Psi4 1.11 — electrostatic potential and density, two oracles

Fixtures for issue 164: the density matrix in a formatted checkpoint, the
electrostatic potential computed from it, and Psi4's own `esp` cube to check that
potential against. Everything here is a **capture**, committed verbatim — no edit,
no reformat, no reorder.

| File | What it is |
| --- | --- |
| `esp-water.py` | The exact input script for the water capture |
| `esp-water.out` | Psi4's own output for that script |
| `water-esp.fchk` | `psi4.fchk(wfn)` — carries `Total SCF Density`, R N=171 |
| `Psi_a_5_5-A.cube` | `psi4.cubeprop` — the HOMO (orbital 5) |
| `ESP.cube` | `psi4.cubeprop` — `Property: ESP [Eh/e]`, Psi4's own potential |
| `Dt.cube` | `psi4.cubeprop` — `Property: Dt [e/a0^3]`, the total density |
| `he.py` | The input script for the helium control |
| `he.out` | Psi4's own output for it |
| `he-sto3g.fchk` | He/STO-3G checkpoint: one s function, 3 primitives, `D(1,1) = 2` |
| `he-ESP.cube` | He `esp` cube on a 17×17×17 grid at 0.5 bohr |

sha256 of every file:

| Digest | File |
| --- | --- |
| `40c59b93f358014ecb6ca33627c6f86e3b10086fb7f01843a84597358f2f8ed9` | `esp-water.py` |
| `0566ce191c67113329c1d7e07446ee868a694109e10657bd0f4f0abe1cf3a66e` | `esp-water.out` |
| `afc97a0ec353fc152410f615fd6de5c93e0095d33bbe27dd7f48c2f841964750` | `water-esp.fchk` |
| `c022c081e35053ad25dbf4d3b066072ecae5eb8483df6e21c30551a1e900732e` | `Psi_a_5_5-A.cube` |
| `6d7a446b64632c4f9229a29e309c017e1ce2ec0206d4925e3866012dfb1b9a8e` | `ESP.cube` |
| `21cd50a641d26d7e1c1a13e8b8cd9b57e2337c6d9b23b0c299af35dd97eb8557` | `Dt.cube` |
| `d663210506315b602e5cb1dc4200811553d27f5b0db72c37d82b57e122c337fe` | `he.py` |
| `d8898d39858d65f592432bfa67bcc8521a23c719462b84fd85509ec1fa96c7af` | `he.out` |
| `9b604e20d1d54d1e1dc24ff3259e3e9252532f7b2275aa85394f2de5bf7597c9` | `he-sto3g.fchk` |
| `9d2788acdb27cae33e7af38e1fd0fbc15c6f597660cf0c9f205034db5606309b` | `he-ESP.cube` |

## How they were produced

`psi4/psi4:1.11` (image `psi4/psi4:1.11`), run on 2026-11-09:

```
docker run --rm -v <scratch>:/w -w /w psi4/psi4:1.11 psi4 -i esp-water.py -o esp-water.log
docker run --rm -v <scratch>:/w -w /w/h psi4/psi4:1.11 psi4 -i he.py -o he.log
```

`water-esp.fchk` is byte-identical to `test/fixtures/psi4/water-b3lyp-631gd.fchk`
(same sha256, `afc97a0e…`): the same calculation, re-run, reproduces the file. The
cube it accompanies is new, not a copy.

## The water calculation

- Water, `O 0 0 0`, `H ±0.757 0.586 0` Å, `symmetry c1`.
- B3LYP/6-31G*, RHF reference, density fitting, `puream True` (5D d, the same
  convention the `test/fixtures/psi4` capture needed — Psi4's default for 6-31G*
  is 6 Cartesian d and its own flag/count then disagree).
- Total energy **-76.406808853438122 Eh**; 10 electrons, 18 basis functions.
- Grid, from Psi4's own `CubicScalarGrid` block and repeated in each cube header:
  **29×21×24 = 14616 points**, origin (-5.6, -4.0, -4.170242) bohr, step 0.4 bohr
  (0.2117 Å), positive counts so the distances in the files are bohr.
- All four files are on **that one grid**: the HOMO, the density and the ESP are
  sampled at the same points, which is what makes the comparison a comparison and
  not an interpolation.

## The helium control

He/STO-3G is one s function with three primitives, so the density is spherically
symmetric and its potential has a closed form that neither Psi4 nor this app has
to be trusted for: each primitive pair is a Gaussian of exponent γ whose potential
is (π/γ)^{3/2}·erf(√γ r)/r. `test/esp.test.js` evaluates that reference by 1-D
radial quadrature — no Boys function, no basis algebra — and compares both
implementations against it.

Grid: 17×17×17 at 0.5 bohr, origin (-4, -4, -4), `E = -2.8079133544929400 Eh`.

## What the comparison says (measured, 2026-11-09)

**The density matrix.** `electronDensityAt()` reproduces `Dt.cube` from
`Total SCF Density` to **worst |Δρ| = 8.8e-4 e/bohr³** over all 14,616 points, at
ρ = 147.91 where the cube writes six significant digits. That pins the triangle
order: a transposed or column-major triangle would not land on Psi4's own density.

**The potential, against Psi4's `esp` cube** (water, the shared grid):

| | Value |
| --- | --- |
| Worst \|ΔV\| | **1.66e-3 Eh** (1.04 kcal/mol) |
| Mean \|ΔV\| | 4.4e-4 Eh |
| Where the worst is | (0.00, ±1.69, −1.15) Å, **2.0 Å from the nearest nucleus**, where V = −0.046 Eh |
| Near a nucleus (< 0.5 Å) | worst \|ΔV\| 1.13e-3 Eh |

The worst point is *not* at a nucleus: it is out where the potential itself is
small, so the same absolute deviation is 3.6 % there and 7e-6 relative at the
oxygen nucleus (V = 151 Eh). In other words the deviation is roughly constant in
absolute terms, not a scaling error — a constant factor would show as a constant
*relative* error, and it is not one: `V(app)/V(psi4)` is 1.0000 ± 0.0003.

**Who owns that 1.7e-3.** The helium control answers it. On points more than
0.5 bohr from the nucleus:

| | Worst deviation from the exact potential |
| --- | --- |
| This implementation | **3.7e-10 Eh** (mean 1.6e-11) |
| Psi4's `esp` cube | **5.6e-3 Eh** (mean 2.6e-3) |

So the residual on water is Psi4's, not the reader's: its cube carries a
quadrature/box error of a few 1e-3 Eh, while the analytic basis sum here is exact
to the last few digits for an s-only basis (and, by construction, for s/p/d/f).
That is why the test's tolerance is stated as **2e-3 Eh** — it is the oracle's
error bar, not the implementation's. `test/esp.test.js` asserts both numbers, so
the claim stays measured: if either implementation changes, one of the two
assertions fails.

## Licence

Psi4 is LGPL-3.0. These are output data files, not Psi4 source or binaries, and
nothing here is linked into the app.
