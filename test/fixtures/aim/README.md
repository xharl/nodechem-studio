# Synthetic WFN and WFX fixtures

Every `.wfn` and `.wfx` file in this directory was written by hand for the
reader tests in `test/aim-wfn-wfx.test.js`. **None was produced by AIMAll,
Gaussian, GAMESS, Q-Chem, ORCA, Multiwfn or any other program, and no number
here is a chemical result.** They are internally consistent synthetic text
whose only job is to exercise a header form, a basis ordering, an occupation or
a refusal.

The geometry is a water-like arrangement in bohr, and the exponents and
contraction coefficients resemble an STO-3G basis; that is a convenience for
testing the shell mapping, not a claim that the wavefunction belongs to a real
calculation. The molecular-orbital coefficients are position-coded (0.01,
0.02, … in the file's own primitive order), which is what lets a test see
whether a coefficient vector was permuted correctly.

| File | Exercises |
| --- | --- |
| `water-3line-gaussian.wfn` | 3-line header (no MEP), Gaussian `CENTRE/TYPE/EXPONENTS` ordering, s and p shells |
| `water-5line-mep-gaussian.wfn` | 5-line header with a two-line `MEP` block, same basis |
| `water-3line-labelled.wfn` | 3-line header, labelled shell table (`'S'`, `'SP'`) — the non-Gaussian ordering |
| `water-5line-mep-labelled.wfn` | 5-line header with MEP, labelled shell table |
| `water-d-labelled.wfn` | a labelled `'D'` shell, which the reader refuses because a one-letter label does not state its component order |
| `water.wfx` | WFX 1.x sections: nuclei, primitive table, occupations, energies, spin types, coefficients, energy, virial ratio |

The WFX file and `water-3line-gaussian.wfn` describe the same synthetic
wavefunction on purpose: a test checks that the two readers produce identical
atoms, energies, occupations and coefficient matrices from them.
