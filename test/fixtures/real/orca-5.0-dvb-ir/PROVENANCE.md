# Provenance — `orca-5.0-dvb-ir`

| Field | Value |
| --- | --- |
| Engine | ORCA |
| Version | 5.0.1 |
| Source | `cclib/cclib`, `data/ORCA/basicORCA5.0/dvb_ir.out`, blob `6e8d06b350d7`, fetched 2026-11-08 |
| Command | not recorded by cclib; the input is `dvb_ir.inp` in the same directory of that repository (`! BP86 def2-SVP def2/J RIJCOSX Opt Freq`) |
| Captured | ORCA 5.0.1 release build, per the log's own `Program Version 5.0.1 - RELEASE -` line |
| Molecule | divinylbenzene (dvb), 18 atoms |
| sha256 | `deb64567281a4673849812a63fc7b1147c33d1c4ad3b67f6b3bf7ec03ab1046c` |

Verbatim file from cclib's test data — not produced on this host: ORCA needs a licence
registration, and no ORCA binary exists in this environment. It is committed because it is the first
*real* ORCA log in the corpus: the parser's ORCA line shapes were previously taken from the 6.0
manual and tested only against synthetic text. This one pins
`FINAL SINGLE POINT ENERGY` (line 1150), `VIBRATIONAL FREQUENCIES` (1289),
`Total Enthalpy ... -381.86823907 Eh` (2158) and `Final Gibbs free energy ... -381.91112705 Eh`
(2217).

Branches this log reaches: `scf`, `frequencies`, `thermochemistry`.
