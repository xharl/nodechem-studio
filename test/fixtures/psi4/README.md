# Psi4 1.11 — water B3LYP/6-31G*, HOMO cube and checkpoint

An independent oracle for the cube reader, the orbital evaluator and the cube writer. The captures
were produced by **Psi4 1.11** in the official `psi4/psi4:1.11` container image and are committed
**verbatim** — no edit, no reformat, no reorder. One file here is *not* a capture: the Å member of
the units pair, which is a documented conversion of a captured file and is labelled as such below.

| File | What it is |
| --- | --- |
| `water-b3lyp-631gd.py` | The exact input script |
| `water-b3lyp-631gd.out` | Psi4's own output for that script |
| `water-b3lyp-631gd.fchk` | `psi4.fchk(wfn)` — the wavefunction the test evaluates from |
| `Psi_a_5_5-A.cube` | `psi4.cubeprop(wfn)` — the HOMO, on Psi4's own grid |
| `water-b3lyp-631gd-pair.py` | The input script for the second, coarser capture (the units pair) |
| `water-b3lyp-631gd-pair.out` | Psi4's own output for that script |
| `Psi_a_5_5-A-bohr.cube` | That capture: the HOMO with **positive** counts, so bohr |
| `Psi_a_5_5-A-angstrom.cube` | The same field with **negative** counts, so Å — a conversion, see below |
| `bohr-to-angstrom-cube.py` | The converter that produced it |

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

## The units pair (issue 178)

A cube states no units of its own. The sign of its grid counts is the statement: **positive means
bohr**, **negative means Å**, and a reader that ignores the sign is wrong by the bohr-to-Å factor
everywhere while still producing a picture that looks plausible. This pair exists so that path is
tested against a real writer's output rather than against text written to match the reader.

| | `Psi_a_5_5-A-bohr.cube` | `Psi_a_5_5-A-angstrom.cube` |
| --- | --- | --- |
| Counts | `23 17 20` | `-23 -17 -20` |
| Declared units | bohr | Å |
| Step stated in the file | 0.5 bohr | 0.264589 Å |
| Origin stated in the file | -5.5 -4.0 -4.320242 bohr | -2.910475 -2.116709 -2.286174 Å |
| Read as Å | 0.2645886054515 Å per step | 0.264589 Å per step |

Both read to the same grid: 23×17×20 points, 0.26459 Å apart, in the same box. That is the assertion
that catches a double-applied scale — the same class of defect as the squared spacing of issue 155 —
because each expectation is computed from the units *the file declares*.

**The bohr file is a capture.** The same water calculation as above, cubeprop asked for the same
orbital on a coarser grid (`cubic_grid_spacing [0.5, 0.5, 0.5]`), so the pair is small enough to
carry in the repository; the script is `water-b3lyp-631gd-pair.py`, Psi4's own log is beside it.

```
docker run --rm -v <scratch>:/w -w /w psi4/psi4:1.11 psi4 water-b3lyp-631gd-pair.py
```

Psi4 `1.11`, run on 2026-11-08. `FINAL ENERGY -76.40680885343812`, orbital 5, 18 basis functions —
the same numbers as the full-resolution capture. sha256 of the cube:
`a66b91c9c5a6f17308c1e16202ea8f24c4f1cecce682374dae331fc03c260c7b`.

**The Å file is a conversion, not a second capture**, and the difference matters, so it is stated
plainly. No writer available here emits the negative-count form: Psi4 1.11's `CUBEPROP` module has no
units option at all (its option registry holds `CUBEPROP_TASKS`, `CUBEPROP_ORBITALS`,
`CUBEPROP_BASIS_FUNCTIONS`, `CUBEPROP_ISOCONTOUR_THRESHOLD` and `CUBEPROP_FILEPATH`), Gaussian's
`cubegen` — which writes Å with a negative count when asked — is not installed, and PySCF and ASE both
write bohr. So the Å member was produced from the captured file by `bohr-to-angstrom-cube.py`:

```
python3 bohr-to-angstrom-cube.py Psi_a_5_5-A-bohr.cube Psi_a_5_5-A-angstrom.cube
```

That script multiplies the origin, the three step vectors and the three atom columns by
`0.529177210903` (CODATA 2018, the constant the reader itself uses), negates the three counts, and
copies the value block **byte for byte**. sha256 of the result:
`ad1ce2098a13b51140eb3bb8b3fa62fa8a8d7efb4917eae22101b319771f000b`.

The honest reading of that provenance: the Å file is an oracle for the *convention* (which sign means
which unit, and that the header distances are the ones converted), not for the *scale factor*, and
the placeholder it could have been — a cube hand-written to satisfy the reader — would have proved
nothing at all. `test/cubeUnits.test.js` therefore derives every expected number from the units the
file declares and from the captured bohr file, and also checks that the two members' value blocks are
the same bytes.

## Licence

Psi4 is LGPL-3.0. These are output data files, not Psi4 source or binaries, and nothing here is
linked into the app.
