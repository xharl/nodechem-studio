# Provenance — `psi4-1.11-water-mp2`

| Field | Value |
| --- | --- |
| Engine | Psi4 |
| Version | 1.11 |
| Image | `docker.io/psi4/psi4@sha256:5064c27a248d1b96ae13758d78569d310df196a8b0879b9118d8bdadf32e0748` |
| Command | `psi4 -i mp2.dat -o mp2.log` (deck `mp2.dat` beside this file) |
| Captured | 2026-11-08 on xeyve, `docker run --rm psi4/psi4:1.11` |
| Molecule | water, 3 atoms, charge 0, singlet |
| Level | RHF/def2-SVP, `scf_type df`, `mp2_type df`, `energy("mp2")` |
| sha256 | `5e3bc465543fdeb9cfdbc8ac40c1712ccc0b2d4b01bc01a86bafcbca846359b6` |

Unedited stdout. The log is the fixture for issue 159/176: Psi4 1.11 prints the canonical MP2 total
under `==> DF-MP2 Energies <==` (line 321, `-76.1644180801477404 Eh`) and a spin-component-scaled
total under `==> DF-SCS-MP2 Energies <==` (line 330, `-76.1606279369433565 Eh`) whose row also says
`Total Energy`. The parse must report the first and refuse to report the second as an MP2 result.

Branches this log reaches: `mp2`.
