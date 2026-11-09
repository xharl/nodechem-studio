# Provenance — `psi4-1.11-water-scf`

| Field | Value |
| --- | --- |
| Engine | Psi4 |
| Version | 1.11 |
| Image | `docker.io/psi4/psi4@sha256:5064c27a248d1b96ae13758d78569d310df196a8b0879b9118d8bdadf32e0748` |
| Command | `psi4 -i scf.dat -o scf.log` (deck `scf.dat` beside this file), then `sed -n '1,229p'` |
| Captured | 2026-11-08 on xeyve, `docker run --rm psi4/psi4:1.11` |
| Molecule | water, 3 atoms, charge 0, singlet |
| Level | RHF/def2-SVP, `scf_type df`, `energy("scf")` |
| sha256 | `0ababe941b3709c4e962e566c061851df1a698e58f84c7e50f6dbab11a8d5be0` |

**Derived, not a complete job.** `scf-head-trimmed.out` is the first 229 lines of a real 1.11 run:
verbatim bytes, cut immediately after `@DF-RHF Final Energy:` so the file stops before its
`Total Energy =` row (line 235 of the full log). Nothing was edited, added or reordered — the cut is
what makes the `scf-final` fallback reachable, because a full Psi4 1.11 log always prints the bare
`Total Energy =` and the parser correctly prefers it.

Branches this log reaches: `scf-final`.
