# Provenance — `psi4-1.11-water-freq`

| Field | Value |
| --- | --- |
| Engine | Psi4 |
| Version | 1.11 |
| Image | `docker.io/psi4/psi4@sha256:5064c27a248d1b96ae13758d78569d310df196a8b0879b9118d8bdadf32e0748` |
| Command | `psi4 -i freq.dat -o freq.log` (deck `freq.dat` beside this file) |
| Captured | 2026-11-08 on xeyve, `docker run --rm psi4/psi4:1.11` |
| Molecule | water, 3 atoms, charge 0, singlet |
| Level | B3LYP/def2-SVP, `scf_type df`, `frequency("b3lyp")` (3-point finite differences, 6 displacements) |
| sha256 | `a6b04953d7e22a00b2a1c4f77f901cf93466d087b851baff8feadff0dde724bb` |

Unedited stdout — 180 kB because Psi4 prints the full SCF block for the reference and every
displaced geometry. It exists because a frequency job prints `Total Energy =` once per displaced
point (lines 341, 846, 1351, 1856, 2361, 2864), so a last-match reader reports a displaced geometry
rather than the reference; the thermochemistry block's
`Total E, Electronic energy at well bottom` is the number the job results in.

Branches this log reaches: `freq-reference`.
