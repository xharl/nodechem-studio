# DP4+ parameter bank — provenance

`dp4plus-qm.json` is a transcription of the error-fit tables shipped with the
MIT-licensed **DP4+ reference implementation**. Nothing in this directory was
fitted, rounded, interpolated or reconstructed by hand: every number is a cell
value from the workbook named below, written at full double precision by
`scripts/build-dp4-bank.py`, and `src/shared/dp4.js` reads it with no
third-party code and no network access.

| Field | Value |
| --- | --- |
| Package | `dp4plus_app` 2.2.3 (PyPI sdist `dp4plus_app-2.2.3.tar.gz`) |
| Upstream | https://github.com/RosarioCCLab/DP4plus-App |
| Licence | MIT — “Copyright (c) 2022 Maria M. Zanardi & Ariel M. Sarotti” (`LICENCE` in the sdist) |
| Archive SHA-256 | `1c1107e388a853b8242a758024d0dda7a356705a11887f5cf303b607deea4d05` |
| Workbook | `src/dp4plus_app/parameters_bank/data_base_QM.xlsx` |
| Workbook SHA-256 | `94f53aa073f1be810c460b40daad95e19aca49cd686d28b3484930a805b284b0` |
| Licence file SHA-256 | `50103ca8c4c357f0557a8586f12a6fdb72c10f6c4091a473990af09232e50d0f` |

The archive itself is **not** committed — it is 65 MB, and the app does not need
it. What is committed is the 39 KB subset that the calculation reads.

## What was converted, and what was not

Converted, from `data_base_QM.xlsx`:

* the 24 DP4+ **QM level fits** — 12 functional/basis pairs × {gas phase, PCM} —
  each carrying the six Student-t rows the paper defines: `Csp2`, `Csp3`,
  `Hsp2`, `Hsp3` (unscaled, split by hybridisation) and `Csca`, `Hsca` (scaled),
  each as `(df, mean, scale)`. In the workbook the column is named `n`; it is
  the degrees of freedom of the t distribution, and the reference passes it to
  `scipy.stats.t(n)` as such;
* the 12 **standard tables** (shielding of the standard, σ(TMS), per level and
  per solvent: `GAS`, `CHCl3`, `CH2Cl2`, `CCl4`, `H2O`, `MeOH`, `MeCN`, `DMSO`,
  `THF`, `Pyridine`, `Acetone`, `Benzene`), which turn an absolute shielding
  into a shift.

**Not** converted: `data_base_MM.xlsx` (MM-DP4+, 36 levels), `data_base_xTB.xlsx`
(3 xTB levels) and `data_base_Custom.xlsx` (the user-trained custom level). They
are separate modes of the reference application and none of them has been
exercised here, so shipping their numbers would be shipping an untested claim.
A level outside this file is refused by name (`level-not-in-bank`) rather than
approximated. Classic DP4 (Smith & Goodman, *JACS* 2010) is likewise **not** in
this bank: its parameters are a different fit, and the module refuses `variant:
'dp4'` instead of relabelling a DP4+ number.

## Regenerating

```sh
curl -sSLO https://files.pythonhosted.org/packages/source/d/dp4plus-app/dp4plus_app-2.2.3.tar.gz
sha256sum dp4plus_app-2.2.3.tar.gz   # must print the archive hash above
tar xzf dp4plus_app-2.2.3.tar.gz
python3 scripts/build-dp4-bank.py dp4plus_app-2.2.3 src/shared/data/dp4plus-qm.json dp4plus_app-2.2.3.tar.gz
```

The script reads the workbook with `openpyxl`; it is a developer tool and no
runtime code depends on it.

## Test fixture

`test/fixtures/dp4/example-nmr-only.json` is the reference package's own
`examples/example_nmr_only` study, reduced to the numbers a DP4+ calculation
needs (per conformer: the isotropic shieldings and the SCF energy; plus the
experimental shifts and the atom assignment from
`0_Correlation Isom 01.xlsx`). Built with
`python3 scripts/build-dp4-bank.py --example dp4plus_app-2.2.3
test/fixtures/dp4/example-nmr-only.json`.

The package's manual calls this study synthetic — “not based on real-world
data” — and publishes no numeric result table for it, only the statement that
isomer 01 is the correct structure. The test therefore reproduces the
**reference procedure** (an independent transcription of `dp4_module.py` and
`correlation_module.py` run over the same shieldings), checks that isomer 01
wins, and states in `test/dp4.test.js` that this is a reproduction of the
reference implementation rather than of a published table. The separate
consistency checks (probabilities sum to one, a zero-error candidate dominates,
a corrupted candidate loses) are labelled as such.

## Citation

Grimblat, N.; Zanardi, M. M.; Sarotti, A. M. *Beyond DP4: An Improved
Probability for the Stereochemical Assignment of Natural Products*. J. Org.
Chem. **2015**, 80 (24), 12526–12534. doi:10.1021/acs.joc.5b02396

The reference implementation asks to be cited for the app itself through its
own publication (DP4+App, *J. Nat. Prod.* 2023 — see the package README for the
exact reference). The t-fit procedure and the parameters transcribed here come
from the 2015 paper above; the app is the distribution channel for the tables.
