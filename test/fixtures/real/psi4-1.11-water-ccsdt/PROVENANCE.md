# Provenance — `psi4-1.11-water-ccsdt`

| Field | Value |
| --- | --- |
| Engine | Psi4 |
| Version | 1.11 |
| Image | `docker.io/psi4/psi4@sha256:5064c27a248d1b96ae13758d78569d310df196a8b0879b9118d8bdadf32e0748` |
| Command | `psi4 -i ccsdt.dat -o ccsdt.log` (deck `ccsdt.dat` beside this file) |
| Captured | 2026-11-08 on xeyve, `docker run --rm psi4/psi4:1.11` |
| Molecule | water, 3 atoms, charge 0, singlet |
| Level | RHF/def2-SVP, `scf_type df`, `energy("ccsd(t)")` |
| sha256 | `31e6b7f72be8abd82e9cbeedae30d2f395da30d45731e413acab96d01364dd19` |

Unedited stdout. One log carries three correlated totals, which is why it pins the `ccsd(t)` branch:
`Total CCSD energy (file100) = -76.173909340210344` (line 501) and
`* CCSD(T) total energy = -76.176913586227926` (line 511). The parser must take the last one and
label it `ccsd(t)`, not `ccsd`.

Branches this log reaches: `ccsd(t)`.
