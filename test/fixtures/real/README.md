# Real Gaussian output excerpts

These files are verbatim excerpts from Gaussian 16 logs published in public
repositories, kept small (the summary block plus its headers). They exist so the
parser is tested against what Gaussian actually prints, not against text written
to match the parser.

| File | Source | Job |
|---|---|---|
| `irc-summary.log` | `CQPES/Model-Zoo`, `H4S2-CC-2024/gau/ts-1-irc.log` | IRC, LQA, both directions |
| `scan-relaxed.log` | `cclib/cclib-data`, `Gaussian/Gaussian09/relaxed_PES_testCO2.log` | `Opt=ModRedundant` relaxed scan over R1 |
| `scan-unrelaxed.log` | `cclib/cclib`, `data/Gaussian/basicGaussian16/dvb_scan_unrelaxed.log` | rigid scan over the D7 dihedral |
| `g09-*.{log,out}` | `cclib/cclib`, `data/Gaussian/basicGaussian09/` | Gaussian 09: `Freq`, `SP`, `TD`, MP2, CCSD, CIS |
| `g16-*.{log,out}` | `cclib/cclib`, `data/Gaussian/basicGaussian16/` | Gaussian 16: `Opt`, `Freq`, `SP`, `TD` |
| `g16-h4s2-irc.log` | `CQPES/Model-Zoo`, `H4S2-CC-2024/gau/ts-1-irc.log` | full IRC job (Gaussian 16) |
| `g09-dvb-gopt-unconverged.log` | `cclib/cclib-data`, `Gaussian/Gaussian09/` | optimisation that ran out of steps and exited with an epigraph |
| `g16-meoh-scf-error.log` | `jvalegre/aqme`, `Example_workflows/QCORR_processing_QM_outputs/QCORR_1/` | SCF non-convergence |
| `g16-dvb-ir-truncated.out` | first 120 000 bytes of `g16-dvb-ir.out` | truncated file (derived, not a complete job) |
| `g09-dvb-un-sp.log` | `cclib/cclib`, `data/Gaussian/basicGaussian09/dvb_un_sp.log` | unrestricted single point: ⟨S²⟩ line and annihilation block |
| `g09-dvb-un-sp-b.log` | `cclib/cclib`, `data/Gaussian/basicGaussian09/dvb_un_sp_b.log` | second unrestricted single point, used to confirm the ⟨S²⟩ reader |

Each excerpt starts at the header line Gaussian prints before the table and ends
at the closing dashes (the relaxed scan ends at its last parameter row).

Attribution: the source repositories are public; the excerpts are reproduced for
parser testing only. Gaussian itself is licensed separately by Gaussian, Inc.
| `g16-h2o-raman.out` | `exa-analytics/exatomic` (`exatomic/static/gaussian/g16-h2o-321g-freq.out`), G16, `Freq=Raman` on water | Raman activities 11.4937 / 95.6630 / 44.0813 Å⁴/amu and both depolarisation ratios; the file contains the short and the long layout of the same table |
