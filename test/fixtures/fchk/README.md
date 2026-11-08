# Formatted checkpoints

| File | Source | Job |
|---|---|---|
| `dvb-g16-b3lyp-sto3g.fchk` | `cclib/cclib-data`, `FChk/Gaussian16/dvb_gopt_qchem.fchk` | Gaussian 16, RB3LYP/STO-3G optimisation of divinylbenzene |

The file is committed whole (335 KB) because the point of the Molden writer is
the **basis** and the **MO coefficients**, and an excerpt would cut them off.

What it contains: 20 atoms (10 C, 10 H), 30 shells, 90 primitives, 60 basis
functions, 60 alpha MOs, orbital energies and the electron counts. It exercises
`sp` shells (Gaussian stores 10 of its 30 shells as type `-1`), which is the one
shell type where the Molden writer has to split a shell in two.
