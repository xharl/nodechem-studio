# Psi4 1.11 MP2 core-correlation pair (water, cc-pVQZ)

Two runs of the same job, differing only in `set freeze_core`. They are the evidence for
issue 174: without the keyword every MP2/CCSD(T) number this app produced was
**all-electron**, 30 mEh away from the frozen-core values the extrapolation literature is
written in.

## Provenance

| Field | Value |
| --- | --- |
| Program | Psi4 1.11, Docker image `psi4/psi4:1.11` |
| Generated | 2026-11-09, `psi4 -i <deck> -o <log>` inside the image |
| Molecule | water, H₂O (O 0 0 0.1173; H 0 ±0.757 −0.4692), charge 0, singlet |
| Method | MP2, density-fitted (`set scf_type df`, `set mp2_type df`), RHF reference |
| Basis | cc-pVQZ |
| Difference | one line: `set freeze_core true` vs `set freeze_core false` |

The `.dat` decks are the exact inputs; the `.log` files are verbatim stdout. Nothing was trimmed.

## The numbers

| level | total energy (Eh) | line |
| --- | --- | --- |
| DF-MP2, frozen core | **−76.3476092976907097** | `Total Energy` in the `DF-MP2 Energies` banner |
| DF-MP2, all-electron | **−76.3780890602055536** | same line in `all-electron.log` |
| gap | 0.030479762 Eh = **30.48 mEh** (19.1 kcal/mol) | |

## Why this pair matters twice

1. **The setting works.** The frozen-core run reproduces the reference in issue 174
   (−76.347609) to the printed digit.
2. **It is a regression fixture for the #159 defect.** Both logs also print a
   `DF-SCS-MP2 Energies` banner, whose total (−76.3464255463388639) sits **1.18 mEh**
   from the frozen-core MP2 answer. A parser that takes the last `Total Energy` line
   reports the SCS number and looks plausible — which is exactly what happened before
   #159. Reading `all-electron.log` as −76.378089 and `frozen-core.log` as −76.347609
   means the banner scoping still works with three totals in one file.
