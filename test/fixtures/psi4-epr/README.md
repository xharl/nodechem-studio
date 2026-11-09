# Psi4 1.11 — CH3· open-shell EPR fixture (issue 168)

A real unrestricted calculation of the methyl radical, kept so the EPR module's
tests read a committed spin density instead of running Psi4 in CI.

| Field | Value |
|---|---|
| Engine | Psi4 |
| Version | Psi4 1.11 |
| Image | `psi4/psi4:1.11` (official image, 2.36 GB) |
| Molecule | CH3·, C₃ᵥ-ish planar geometry, charge 0, multiplicity 2 (doublet) |
| Method | UB3LYP / 6-31G* (Psi4 spells the basis `6-31G*`, 6 Cartesian d functions) |
| Job | single point, `energy('b3lyp', return_wfn=True)` then `fchk(wfn, …)` |
| Result | `Total Energy = -39.8382603139090889` Eh, SCF converged, `@Spin Contamination Metric: 3.709863845E-03` |

The input is **not** hand-written: it is what `buildPsi4Input` writes for a
doublet single point, which is the point of keeping it — the builder's own script
is the one Psi4 accepted.

## Command

Run from the folder holding these files, with the container's `/w` mounted on it:

```
docker run --rm -v /home/xeyve/.hermes/cache/scratch/psi4td:/w -w /w \
  psi4/psi4:1.11 psi4 -i ch3-ub3lyp-631gd.dat -o ch3-ub3lyp-631gd.log
```

The `fchk(wfn, 'ch3-ub3lyp-631gd.fchk')` line inside the input is what produces
the checkpoint; Psi4 1.11 writes it in the working directory.

## Geometry (Å)

```
C   0.000000   0.000000   0.000000
H   0.000000   1.079000   0.000000
H   0.932984  -0.539500   0.000000
H  -0.932984  -0.539500   0.000000
```

## Files and SHA-256

| File | Bytes | SHA-256 |
|---|---|---|
| `ch3-ub3lyp-631gd.dat` | 471 | `3f0a1760a0d5ca8747ef6a38fbf50d410195d5ea0f124afe24c49a00d39b786c` |
| `ch3-ub3lyp-631gd.log` | 13970 | `4fdbbea50f9243d10b15a3fc85aa1e222ddd86e967b9cca7fe3414e165cb04fb` |
| `ch3-ub3lyp-631gd.fchk` | 26862 | `8e80f390fdb2536993dab4fbbb66a4aa7778f960ca838b5b327acb0ca94b8b6c` |

## What the checkpoint carries, and what the tests read

`Number of basis functions = 21` (C: 3s 2p 1d Cartesian; each H: 2s).
`Number of alpha electrons = 5`, `Number of beta electrons = 4`, so the spin
density this file holds is a one-electron `D^α − D^β` in the `Spin SCF Density`
block (231 values, lower triangle), beside `Total SCF Density` and both MO
coefficient sets.

`Pure/Cartesian d shells = 1` here means **Cartesian** for a Psi4-written
checkpoint (21 functions, not 20); `volume.js` resolves that ambiguity from the
file's own function count, which is what makes this fixture readable by the
orbital, ESP and population code alike.

The numbers `test/epr.test.js` pins from this file are measured, not chosen:
Mulliken populations C `+1.1552`, H `−0.0518` each (sum `1.0000000`), Löwdin
C `+1.0814`, H `−0.0273`; spin density at the nuclei C `+0.10932` bohr⁻³,
H `−0.015839` bohr⁻³; Fermi contact H `−70.80 MHz = −25.26 G`,
¹³C `+122.90 MHz = +43.85 G`. The hydrogen coupling is the one experimental
comparison available for this module: the gas-phase methyl radical's proton
coupling is 23.04 G, so the density-only value is ~10 % high at this level —
which is the honest size of the approximation, not a calibration.
