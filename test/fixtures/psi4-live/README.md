# Psi4 1.11 — runs produced in this repository

These files were produced by **Psi4 1.11** (the official `psi4/psi4:1.11`
container image) from the inputs beside them. The inputs were written by
`buildPsi4Input`, so the pair proves the builder writes a script Psi4 accepts and
the parser reads what Psi4 1.11 prints.

| Input | Job | Result |
|---|---|---|
| `water-sp.dat` | B3LYP/def2-SVP single point | `-76.35815199866961` Eh, SCF converged in 7 cycles |
| `water-opt.dat` | B3LYP/def2-SVP optimisation | complete in 3 steps, `-76.35832576761888` Eh |
| `water-freq.dat` | B3LYP/def2-SVP frequencies | 3 modes, ZPVE `0.02168016` Eh, H `-76.33269184`, G `-76.35410402` |
| `uhf.dat` | water cation, doublet, UKS | `-75.90190402047804` Eh |
| `sapt.dat` | SAPT0 on a water dimer | total `-4.15242375` mEh (`-2.60568524` kcal/mol) |

`psi4-docker` wraps the container so the app's `Psi4Runner` can spawn it; the
end-to-end run is described in `docs/guide/engines.md`.

Psi4 1.9+ changed three blocks from the 1.1–1.4 files in `../real/`:
`Energy and wave function converged.`, `Optimizer: Optimization complete!`
(no step count), a `Freq [cm^-1]` table instead of the `#  #` list, and
`Total G, Gibbs energy at`. The parser accepts both shapes, and these files are
what proves the new one.
