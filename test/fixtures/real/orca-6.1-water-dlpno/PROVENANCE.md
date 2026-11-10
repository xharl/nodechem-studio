# Provenance — `orca-6.1-water-dlpno`

| Field | Value |
| --- | --- |
| Engine | ORCA |
| Version | 6.1.1 |
| Source | `dhwan0112/dhk.github.io`, `guides/orca/examples/03-dlpno-ccsdt/water.out`, fetched 2026-11-09 |
| Command | `orca water.inp > water.out` (the input deck is not published with the log; the echoed route is `! DLPNO-CCSD(T) cc-pVTZ cc-pVTZ/C TightSCF`) |
| Captured | ORCA 6.1.1 release build, per the log's own `Program Version 6.1.1  -  RELEASE   -` line |
| Molecule | water, 3 atoms, charge 0, singlet |
| Level | DLPNO-CCSD(T)/cc-pVTZ with the cc-pVTZ/C correlation-fitting basis, NormalPNO (`TCutPNO` 3.330e-07), TightSCF |
| sha256 | `c49b7081c8bc930fd7e2691b4061e5a6997c98e94ff4b9599ea48a366547e58e` |
| Licence | none declared by the source repository; reproduced unmodified for parser testing only |

Verbatim file from a public ORCA user guide's example directory — not produced on this host (ORCA is
licence-registered and no ORCA binary exists here). It is the first *real* ORCA 6.x DLPNO-CCSD(T)
log in the corpus. The source repository declares no licence, so the file is kept unmodified and is
used only to pin the parser's line shapes; it is not redistributed as part of the application.

Lines the parser keys on:

- `DLPNO SETTINGS (2015 fully linear scaling implementation)` at line 1011, with
  `TCutPNO:           3.330e-07` at line 1016 (NormalPNO).
- `DLPNO BASED TRIPLES CORRECTION` at line 1385.
- `Triples Correction (T)                     ...     -0.007477978` at line 1465.
- `Final correlation energy                   ...     -0.275822870` at line 1466.
- `E(CCSD)                                    ...    -76.324481361` at line 1467.
- `E(CCSD(T))                                 ...    -76.331959339` at line 1468.
- `FINAL SINGLE POINT ENERGY       -76.331959339263` at line 1508.
- `****ORCA TERMINATED NORMALLY****` at line 1709.

The input echo at line 226 names `DLPNO-CCSD(T)` and `cc-pVTZ cc-pVTZ/C`, but no `RIJCOSX`/`RI-JK`
keyword: this log therefore pins what ORCA prints when the RI approximation is left to the program,
which is exactly the case the builder avoids by writing `RIJCOSX` and `def2/J` explicitly.

Branches this log reaches: `dlpno-header`, `dlpno-ccsd(t)`.
