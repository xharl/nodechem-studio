# Provenance — `orca-5.0-dvb-spin-spin`

| Field | Value |
| --- | --- |
| Engine | ORCA |
| Version | 5.0.4 |
| Source | `cclib/cclib`, `data/ORCA/basicORCA5.0/dvb_coupling_nmr.out`, blob `909174cd06ac940b2d0083369a6ec69fe181b404`, fetched 2026-11-09 |
| Command | log echo, lines 161–195: `!  b3lyp sto-3g usesym sp`; `%eprnmr` with `nuclei = all C { shift, ssall};`, `nuclei = all H { shift, ssall};`, `SpinSpinRThresh 50.0` |
| Captured | ORCA 5.0.4 release build, per the log's own `Program Version 5.0.4 -  RELEASE  -` line (line 48) |
| Molecule | divinylbenzene (dvb), 20 atoms, singlet (`Multiplicity                 ... 1`, line 1203) |
| sha256 | `c2724e866bbe743301d073de8e1e383cd6f99bd373e0be0d9466f4aa21f6d176` |

Verbatim file from cclib's regression corpus — not produced on this host: ORCA needs a licence
registration, and no ORCA binary exists in this environment. It is the evidence for issue 222's
NMR half: ORCA 5.0.4 prints a spin-spin coupling summary and no reduced K table.

## Licence

cclib is distributed under the **BSD 3-Clause License**:
https://github.com/cclib/cclib/blob/master/LICENSE

The ORCA program itself is licensed separately by FACCTs; this file is program output,
redistributed by cclib for parser testing, not ORCA software.

## What this log prints

- line 48 — `Program Version 5.0.4 -  RELEASE  -`
- line 1196 — `Treatment of gauge           ... GIAO (approximations 1/2el = 0,0)`
- line 1206 — `NMR spin-spin couplings      ... 1`
- line 1209 — `Number of nuclei for epr/nmr ... 20`
- lines 2062–2075 — `NMR SPIN-SPIN COUPLING CONSTANTS`, `Number of nuclear pairs to calculate something:      190`
- lines 2273–2301 — first pair block (`NUCLEUS A = C    0 NUCLEUS B = C    1`), with
  `gnA =  1.405`, `gnB =  1.405` and `Total … iso=       9.451`
- line 10348 — `SUMMARY OF ISOTROPIC COUPLING CONSTANTS (Hz)`
- lines 10350–10421 — the full symmetric table in four six-column blocks, row/column labels
  `0 C` … `19 H`, diagonal `0.000`
- line 10443 — `****ORCA TERMINATED NORMALLY****`

## What the test reads

`test/orcaCouplings.test.js` pins the 20 nuclei and 190 pairs, the 0-based indexing sentence, and
J values from the summary: J(0,1) = 9.451 Hz, J(0,2) = 45.356 Hz, J(2,6) = 133.670 Hz,
J(18,19) = 0.082 Hz. It checks the two independent printings of the same quantity — the summary
table and each pair block's `Total … iso=` value — for all 190 pairs (worst deviation 0 Hz at the
log's 0.001 Hz print precision), and the per-pair `gnA`/`gnB` constants against the app's isotope
table (worst relative deviation 1.26 × 10⁻⁴, ORCA printing 1.405 for ¹³C against 1.4048236).

The log prints J in Hz but **no reduced K table**. `kMatrix` is therefore `null`, `kUnits` says
"not printed", and the J = K·(γ_i γ_j)/(2π) relation is stated as uncheckable because K is absent
— not silently converted from the gn values.
