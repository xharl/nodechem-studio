# Psi4 1.11 — water B3LYP/6-31G*, HOMO cube and checkpoint

An independent oracle for the cube reader, the orbital evaluator and the cube writer. Both files
were produced by **Psi4 1.11** in the official `psi4/psi4:1.11` container image and are committed
**verbatim** — no edit, no reformat, no reorder.

| File | What it is |
| --- | --- |
| `water-b3lyp-631gd.py` | The exact input script |
| `water-b3lyp-631gd.out` | Psi4's own output for that script |
| `water-b3lyp-631gd.fchk` | `psi4.fchk(wfn)` — the wavefunction the test evaluates from |
| `Psi_a_5_5-A.cube` | `psi4.cubeprop(wfn)` — the HOMO, on Psi4's own grid |

## How it was produced

`psi4 --version` → `1.11` (image `psi4/psi4:1.11`, run on 2026-11-08 by Xavier Laporte).

```
docker run --rm -i psi4/psi4:1.11 bash -c 'cd /tmp && psi4 water-b3lyp-631gd.py'
```

The script is the one committed beside this README. Re-running it in the same image reproduces both
committed files byte for byte (sha256 of `Psi_a_5_5-A.cube` is
`558553e2751cdf7ba383cfd6f2e43a657e0972c892054a00c54d2693aa44a2be`; of
`water-b3lyp-631gd.fchk`, `afc97a0ec353fc152410f615fd6de5c93e0095d33bbe27dd7f48c2f841964750`).

## The calculation

- Geometry: water, `O 0 0 0`, `H 0.757 0.586 0`, `H -0.757 0.586 0` Å, `symmetry c1`.
- `B3LYP/6-31G*`, RHF reference, density fitting (`scf_type df`).
- **`puream True`**: 6-31G* with spherical (5D) d functions, which is also what Gaussian uses for
  Pople bases. Psi4's default for 6-31G* is 6 Cartesian d functions, and its formatted checkpoint then
  states `Pure/Cartesian d shells 1` while `Number of basis functions` is 19 — the flag and the count
  disagree, so this fixture uses 5D, where `Shell types` carries `-2` and both agree on 18.
- Total energy **-76.40680885343812 Eh**; 10 electrons, 5 alpha, 18 basis functions.
- The cube holds **orbital 5** (`cubeprop_orbitals: [5]`, Psi4's 1-based index) — the HOMO, at
  **-0.290846734 Eh**. Its grid is 56×41×47 points, origin (-5.5, -4.0, -4.170242) bohr, step
  0.2 bohr; positive counts, so the distances in the file are bohr.

## Two things this file proves about the reader

Psi4's cube is the standard Gaussian layout — grid rows of four numbers *before* the atom block —
and our pre-#153 reader refused it on line 4. It also stores its values with the **last axis fastest**,
unlike Gaussian's x-fastest order, so `parseCube` reorders a file whose first line is Psi4's own
title. That ordering is proved inside the fixture itself, without trusting the evaluator: the HOMO is
a 2p on oxygen, and its largest voxel sits 0.22 Å from the O nucleus when the file is read in Psi4's
order and 2.07 Å away when the same bytes are read x-fastest. `test/cubeWriter.test.js` asserts both.

## The comparison it anchors

`test/cubeWriter.test.js` evaluates MO 5 from `water-b3lyp-631gd.fchk` with `src/shared/volume.js`, on
the grid this cube declares, aligns the arbitrary MO phase by the sign of the overlap, and compares.

Measured on 2026-11-08: **max |Δψ| = 8.4969e-7 a.u.** over the 107,912 points, with an overlap of
0.9999999. The plan's bound is 1e-3 a.u.; the remaining difference is the fixture's six-significant-digit
values plus the two independent implementations of the same Gaussian basis.

## Licence

Psi4 is LGPL-3.0. These are output data files, not Psi4 source or binaries, and nothing here is
linked into the app.
