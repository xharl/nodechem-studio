# Synthetic Multiwfn transcripts

**None of these files was produced by Multiwfn.** They are hand-written in the
text layout Multiwfn 3.8 prints, so the normaliser in `src/shared/multiwfn.js`
can be tested without the user's binary. No number here is a chemical result and
no test claims agreement with a real Multiwfn run.

| File | Exercises |
| --- | --- |
| `qtaim.out` | the four-column "Total result" basin table, the normalised atomic-charge block, and `CPprop.txt`-style critical-point blocks |
| `esp.out` | the `Summary of surface analysis` block: area, volume, ESP extrema and averages, variance, MPI |
| `elf.cube` | a 4×4×4 ELF cube with a known value range |
| `nci.txt` | `sign(lambda2)rho` / RDG scatter points, with a comment header |

The QTAIM critical-point densities are deliberately close to the in-app
`qtaim.js` result for `test/fixtures/esp/water-esp.fchk` (ρ ≈ 0.35605,
∇²ρ ≈ −1.8667, ε ≈ 0.02393). That makes the *comparison code* testable; it is
not evidence that Multiwfn and `qtaim.js` agree on a real run. That comparison
needs the user's Multiwfn 3.8 binary, and the guide says so.
