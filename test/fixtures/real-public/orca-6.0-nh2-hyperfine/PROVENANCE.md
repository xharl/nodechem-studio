# Provenance — `orca-6.0-nh2-hyperfine`

| Field | Value |
| --- | --- |
| Engine | ORCA |
| Version | 6.0.0 |
| Source | `Spin-Chemistry-Labs/radicalpy`, `examples/data/NH2_A.out`, blob `f541eecc473d3a796f927cc47928a30c83ab5bc8`, fetched 2026-11-09 |
| Command | log echo, lines 173–183: `!UKS B3LYP EPR-III TightSCF`; `%eprnmr` with `Nuclei = all N { aiso, adip, aorb, fgrad, rho }` |
| Captured | ORCA 6.0.0 release build, per the log's own `Program Version 6.0.0  -   RELEASE  -` line (line 54) |
| Molecule | NH2 radical, 3 atoms, doublet (`Multiplicity       :   2`, line 1054) |
| sha256 | `9bdc286938493fab395bfcedbd060ee056953e360183790013f4c44745c188bd` |

Verbatim file from radicalpy's example data — not produced on this host: ORCA needs a licence
registration, and no ORCA binary exists in this environment. It is committed because it is the
first *real* ORCA hyperfine log in the corpus and the evidence for issue 222's EPR half.

## Licence

radicalpy is distributed under the **MIT License**:
https://github.com/Spin-Chemistry-Labs/radicalpy/blob/master/LICENSE

The ORCA program itself is licensed separately by FACCTs; this file is program output,
redistributed by radicalpy for its examples, not ORCA software.

## What this log prints

- line 54 — `Program Version 6.0.0  -   RELEASE  -`
- line 1025 — `g-Tensor (aka g-matrix)                 ...  NO` (so the record has no g-tensor)
- line 1028 — `Hyperfine couplings                     ... YES (   3 nuclei)`
- lines 1085–1087 — section header `ELECTRIC AND MAGNETIC HYPERFINE STRUCTURE (3 nuclei)`
- line 1105 — `Nucleus   0N : A  : Isotope=   14 I=  1.0 P= 38.5677 MHz/au**3`
- lines 1111–1123 — the 3×3 `Total HFC matrix (all values in MHz)`, `A(FC)`, `A(SD)`,
  `A(ORB+DIA)`, `A(Tot)` and `A(iso)=   28.4976`
- line 1156 — `RHO(0)=    200.881032038 a.u.**-3` (total contact density, not the spin density)
- line 1159 — `Nucleus   1H : A  : Isotope=    1 I=  0.5 P=533.5514 MHz/au**3`,
  `A(iso)=  -61.6134` at line 1177
- line 1213 — `Nucleus   2H : A  : Isotope=    1 I=  0.5 P=533.5514 MHz/au**3`,
  `A(iso)=  -61.5964` at line 1231
- line 1267 — `Hyperfine and quadrupole coupling calculation done in   0.1 sec`
- line 930 — `FINAL SINGLE POINT ENERGY       -55.875432645868`
- line 1380 — `****ORCA TERMINATED NORMALLY****`

## What the test reads

`test/orcaCouplings.test.js` pins the three `A(iso)` values, the `A(SD)` principal values, the
isotopes and nuclear spins, and the two internal checks the log allows: the trace of the printed
3×3 matrix divided by 3 against `A(iso)` (worst deviation 3.3 × 10⁻⁵ MHz), and
`A(FC) + A(SD) + A(ORB+DIA)` against `A(Tot)` (worst deviation 1.0 × 10⁻⁴ MHz, the print
precision). The log prints no gauss column and no free-electron g value, so the MHz→G conversion
cannot be checked against the log; the record says so and uses `g_e = 2.00231930436256`, which
differs from the issue's 2.0023 by 9.6 × 10⁻⁶ relative.
