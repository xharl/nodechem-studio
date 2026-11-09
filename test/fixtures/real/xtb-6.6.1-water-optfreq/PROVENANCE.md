# Provenance — `xtb-6.6.1-water-optfreq`

| Field | Value |
| --- | --- |
| Engine | xtb |
| Version | 6.6.1 |
| Binary | `xtb-6.6.1-linux-x86_64` release tarball from `grimme-lab/xtb`, `8d0f1dd` |
| Command | `xtb water.xyz --ohess gfn2` (geometry `water.xyz` beside this file) |
| Captured | 2026-11-08 on xeyve, host run with `XTBPATH` pointing at the release's `share/xtb` |
| Molecule | water, 3 atoms |
| Level | GFN2-xTB, `--ohess` (optimise, then analytical Hessian) |
| sha256 | `d96d0458c18816c342ffba1b033f42c211ea0b45d438dffaf4141fae4174d91f` |

Unedited stdout (xTB writes no result file). The run is the coverage fixture for `Opt Freq`: it
carries a converged optimisation (`*** GEOMETRY OPTIMIZATION CONVERGED AFTER 4 ITERATIONS ***`,
line 295), the projected frequencies (line 417), and the thermochemistry block
(`| TOTAL FREE ENERGY   -5.068037277878 Eh |`, line 566) in a single log.

The module was written against xtb 6.8.0; this capture is 6.6.1, so every line it keys on is now
pinned by a log from a release the app does not ship. `XTB_SUPPORTED_VERSIONS` names both.

Branches this log reaches: `scc`, `opt-converged`, `frequencies`, `thermochemistry`, `opt-freq`.
