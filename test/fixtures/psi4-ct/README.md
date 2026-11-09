# Charge-transfer fixtures (issue 173, route B)

Two supersystem TD-DFT runs, committed whole (input deck, output log, checkpoint),
because the charge-transfer analysis in `src/shared/chargeTransfer.js` cannot be
tested without a transition density that a real engine wrote. A hand-made density
would test the code against itself.

Neither file was edited after the run. The decks are exactly what
`buildPsi4Input` wrote — `build.mjs` and `build-heterodimer.mjs` regenerate them
from the same geometry, settings and fragment labels, so a diff between a
regenerated deck and the committed one is a diff in the builder.

## Image, version, command

```
docker run --rm -v <this directory>:/w -w /w psi4/psi4:1.11 \
  psi4 -i ethylene-dimer-td.dat -o ethylene-dimer-td.log
```

`psi4 --version` → `1.11`. Host: Linux x86_64, container `psi4/psi4:1.11`
(Python 3.12, NumPy 2.x). The checkpoint is the one the deck's own
`fchk(wfn, ...)` call wrote, in the same working directory.

Level of theory, both runs: RHF reference, TD-B3LYP/def2-SVP, `scf_type df`,
`e_convergence`/`d_convergence` 1e-8, **Tamm–Dancoff** (`tdscf_tda true`), C1
symmetry, no solvent, no dispersion correction.

## Geometry 1 — slipped cofacial ethylene dimer (12 atoms, 6 + 6)

Two planar ethylenes in the xy plane, 3.60 Å apart along z, the second slipped by
1.40 Å along x. C–C = 1.339 Å, C–H = 1.086 Å, H–C–C = 121.3° (the ideal ethylene
geometry, not re-optimised). 160 basis functions, 16 occupied, 20 states.

```
fragment 1 (z = 0)                    fragment 2 (z = 3.60, x + 1.40)
C   0.669500  0.000000  0.000000      C   2.069500  0.000000  3.600000
C  -0.669500  0.000000  0.000000      C   0.730500  0.000000  3.600000
H   1.232100  0.923600  0.000000      H   2.632100  0.923600  3.600000
H   1.232100 -0.923600  0.000000      H   2.632100 -0.923600  3.600000
H  -1.232100  0.923600  0.000000      H   0.070500  0.923600  3.600000
H  -1.232100 -0.923600  0.000000      H   0.070500 -0.923600  3.600000
```

The two fragments are the **same molecule**, so an excitation that moves an
electron from one to the other is equally likely to move it back: the CT fraction
is large and the net charge Δq is exactly 0. That is the point of keeping this
fixture — it separates "how much of the excitation is inter-fragment" from "how
much charge actually moved", which a single number cannot do.

| root | eV | f | CT | Ω | Λ | Δq/e | Mulliken CT |
|---|---|---|---|---|---|---|---|
| 1 | 6.7559 | 0.0000 | 0.955 | 0.045 | 0.301 | 0.000 | 0.957 |
| 2 | 6.8424 | 0.0535 | 0.982 | 0.018 | 0.191 | 0.000 | 0.984 |
| 3 | 8.0900 | 0.0210 | 0.291 | 0.709 | 1.191 | 0.000 | 0.291 |
| 4 | 8.2582 | 0.0000 | 0.021 | 0.979 | 1.399 | 0.000 | 0.020 |
| 5 | 8.2868 | 0.0001 | 0.010 | 0.990 | 1.407 | 0.000 | 0.009 |
| 6 | 8.4581 | 0.0000 | 0.049 | 0.951 | 1.379 | 0.000 | 0.049 |
| 7 | 8.6328 | 0.0000 | 0.225 | 0.775 | 1.245 | 0.000 | 0.225 |
| 8 | 8.6659 | 0.0000 | 0.079 | 0.921 | 1.357 | 0.000 | 0.078 |
| 9 | 8.9037 | **1.0712** | 0.033 | 0.967 | 1.390 | 0.000 | 0.031 |
| 10 | 8.9237 | 0.0000 | 0.009 | 0.991 | 1.408 | 0.000 | 0.008 |
| 11 | 9.0280 | 0.0000 | 0.785 | 0.215 | 0.656 | 0.000 | 0.782 |
| 12 | 9.1733 | 0.0011 | 0.984 | 0.016 | 0.179 | 0.000 | 0.985 |
| 13 | 9.1767 | 0.0000 | 0.982 | 0.018 | 0.187 | 0.000 | 0.984 |
| 14 | 9.2636 | 0.0000 | 0.403 | 0.597 | 1.093 | 0.000 | 0.405 |
| 15 | 9.3604 | 0.0019 | 0.298 | 0.702 | 1.185 | 0.000 | 0.294 |
| 16 | 9.5456 | 0.0032 | 0.400 | 0.600 | 1.095 | 0.000 | 0.404 |
| 17 | 9.6372 | 0.0009 | 0.989 | 0.011 | 0.145 | 0.000 | 0.991 |
| 18 | 9.6726 | 0.0000 | 0.049 | 0.951 | 1.379 | 0.000 | 0.047 |
| 19 | 9.7437 | 0.0002 | 0.041 | 0.959 | 1.385 | 0.000 | 0.041 |
| 20 | 9.9379 | 0.0000 | 0.764 | 0.236 | 0.688 | 0.000 | 0.764 |

State 9 is the bright state (the ethylene B1u-like π→π*), 97 % on-fragment:
CT 0.03, Λ 1.39. States 1, 2, 12, 13, 17 are nearly pure inter-fragment
excitations (CT ≥ 0.98, Λ ≤ 0.19). Roots 12 and 13 are 3 meV apart — the
near-degenerate pair the card must report as two states and never merge.

The partition spread (largest |CT(Löwdin) − CT(Mulliken)| over all states) is
0.0043, which is why the analysis can report one number and say the two
partitions agree to a few thousandths.

## Geometry 2 — ammonia–water (7 atoms, 4 + 3)

Ammonia donating to water along z. N–H = 1.012 Å, H–N–H = 107.0°, N···H = 1.980 Å,
N···O = 2.950 Å, O–H = 0.970 Å, H–O–H = 104.5°. 53 basis functions, 9 occupied,
12 states. The fragments differ in size and in chemistry, so the transfer has a
direction and a sign.

```
N   0.000000  0.000000  0.000000
H   0.000000  0.939372  0.376464
H  -0.813520 -0.469686  0.376464
H   0.813520 -0.469686  0.376464
O   0.000000  0.000000 -2.950000
H   0.000000  0.000000 -1.980000
H   0.926500  0.000000 -3.189000
```

| root | eV | f | CT | Ω | Λ | Δq/e | Mulliken CT |
|---|---|---|---|---|---|---|---|
| 1 | 6.7317 | 0.0035 | 0.827 | 0.173 | 0.436 | **+0.827** | 0.820 |
| 2 | 7.3320 | 0.0912 | 0.207 | 0.793 | 1.001 | +0.113 | 0.196 |
| 3 | 7.9454 | 0.0105 | 0.159 | 0.841 | 0.926 | +0.159 | 0.154 |
| 4 | 8.9812 | 0.0079 | 0.742 | 0.258 | 0.714 | +0.732 | 0.738 |
| 5 | 9.1945 | 0.0004 | 0.993 | 0.007 | 0.102 | +0.992 | 0.993 |
| 6 | 9.2450 | 0.0002 | 0.998 | 0.002 | 0.065 | +0.995 | 0.998 |
| 7 | 9.4016 | 0.0402 | 0.510 | 0.490 | 0.990 | **−0.280** | 0.513 |
| 8 | 9.5862 | 0.0318 | 0.195 | 0.805 | 1.074 | +0.098 | 0.185 |
| 9 | 9.6189 | 0.0217 | 0.230 | 0.770 | 1.117 | +0.055 | 0.222 |
| 10 | 10.6333 | 0.0910 | 0.418 | 0.582 | 0.916 | −0.255 | 0.420 |
| 11 | 11.3716 | 0.0042 | 0.902 | 0.098 | 0.394 | +0.896 | 0.903 |
| 12 | 11.4187 | 0.0023 | 0.909 | 0.091 | 0.346 | +0.908 | 0.910 |

State 1 runs the transfer one way only (water → ammonia): the other cross block
is < 0.01, so CT ≈ |Δq| = 0.827 e. State 7 is the counter-example that keeps the
distinction honest — CT 0.510 but Δq = −0.280 e, because both directions carry
weight and partly cancel. State 6 is the purest CT state in either fixture
(CT 0.998, Λ 0.065).

Partition spread: 0.0109.

## Files

```
ethylene-dimer-td.dat   a4f4e7168558981c1d7ed8b7ae794f565a20a886fa0d7b61387a4086f118fcbf
ethylene-dimer-td.log   baf10411eb1d22af796366f66ffb5fee3b383c5d9c36a45996271678dc22c300
ethylene-dimer-td.fchk  02864a94c246957b4394f95a18a79b8ce77cabe402b6dd6385197c682230186f
ammonia-water-td.dat     e49f7d5f8879cd3a6a356103a28f5641c67f8b6d7ccdaa1cd28bdf9dc1e47e96
ammonia-water-td.log    21e427bc7e717cf11476562ffd3640cc2a5292e98d73e56b6f2d273beb2900a1
ammonia-water-td.fchk   15afd9d1c6f3e8f287a2dae3ba974c3811caaa4e76ab90dc0c9b143bf92015de
```

`sha256sum -c` against the list above is the check that the logs are the ones
the numbers in the tables came from.

## What is recorded in the log

The deck writes three records that the parser reads back, all through
`psi4.core.print_out` (a plain `print` never reaches the log — measured, issue
173):

```
NCS-CTFRAG  12 1 1 1 1 1 1 2 2 2 2 2 2          fragment of each atom
NCS-TDM ROOT 9 A 0.000000 -0.772431 0.000000 a.u. the transition dipole vector
NCS-TDMAT ROOT 9 16 80 tda                       the amplitudes, 16 rows × 80
<1280 amplitudes, row-major over occupied then virtual>
NCS-TDMAT END 9
```

## Independent check

The same run recomputed inside Psi4 — its own `wfn.S()` and `wfn.Ca()`, NumPy, no
code from this repo — reproduces the numbers above to ≈2×10⁻⁶ (the difference is
the 8 decimal places the log records the amplitudes to). That check is what
establishes that the analytic overlap built from the checkpoint's basis and the
checkpoint's MO order describe the same density the engine used; it lives in the
issue thread, not in the repository, because it needs Psi4 to run.
