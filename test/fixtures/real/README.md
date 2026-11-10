# Real engine output files

Every file here is output a real program printed. Nothing in this directory is hand-written: a log
that has to be trimmed is a new file with `-trimmed` in its name and a note saying what was removed.

## Layout (issue 176)

New captures live in a folder named `<engine>-<version>-<molecule>-<job>` with a `PROVENANCE.md`
beside the log naming the engine, version, command line, host, molecule, level of theory and the
log's sha256. `test/fixtureCoverage.test.js` fails when a fixture folder has no `PROVENANCE.md`, when
its version is missing from the parser's exported `<ENGINE>_SUPPORTED_VERSIONS`, or when a declared
parser branch is reached by no log here.

Older files sit flat in this directory and are described by the tables below; the same test fails if
one of them is not named (literally, or by a glob row) in this README.

| Folder | Engine | Version | Reaches (parser branches) |
| --- | --- | --- | --- |
| `psi4-1.11-water-mp2/` | Psi4 | 1.11 | `mp2` — the canonical total beside a 3.8 mEh-distant SCS total |
| `psi4-1.11-water-ccsdt/` | Psi4 | 1.11 | `ccsd(t)` — with the CCSD total in the same log |
| `psi4-1.11-water-freq/` | Psi4 | 1.11 | `freq-reference` — six displaced `Total Energy =` rows |
| `psi4-1.11-water-scf/` | Psi4 | 1.11 | `scf-final` — real run cut after `@DF-RHF Final Energy:` |
| `xtb-6.6.1-water-optfreq/` | xtb | 6.6.1 | `scc`, `opt-converged`, `frequencies`, `thermochemistry`, `opt-freq` |
| `orca-5.0-dvb-ir/` | ORCA | 5.0.1 | `scf`, `frequencies`, `thermochemistry` |
| `orca-5.0-water-mp2/` | ORCA | 5.0.0 | `final-single-point` |
| `orca-6.1-water-dlpno/` | ORCA | 6.1.1 | `dlpno-header`, `dlpno-ccsd(t)` — real DLPNO-CCSD(T) header, PNO cutoff, correlation and triples energies |
| `psi4-mp2-freeze-core/` | Psi4 | 1.11 | `mp2` — frozen-core vs all-electron pair (issue 174) |

## Gaussian

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
| `g09-dvb-nmr.log` | complete Gaussian 09 Rev D.01 log added in #61; its header names `/home/osl/test/Benzene/NMR/G09/dvb_nmr.log` and no public source repository was recorded then | `NMR=(SpinSpin)` at B3LYP/sto-3g on divinylbenzene (C₁₀H₁₀, 20 atoms): shieldings, the four J contributions and both coupling totals |
| `g16-*.{log,out}` | `cclib/cclib`, `data/Gaussian/basicGaussian16/` | Gaussian 16: `Opt`, `Freq`, `SP`, `TD` |
| `g16-h4s2-irc.log` | `CQPES/Model-Zoo`, `H4S2-CC-2024/gau/ts-1-irc.log` | full IRC job (Gaussian 16) |
| `g09-dvb-gopt-unconverged.log` | `cclib/cclib-data`, `Gaussian/Gaussian09/` | optimisation that ran out of steps and exited with an epigraph |
| `g16-meoh-scf-error.log` | `jvalegre/aqme`, `Example_workflows/QCORR_processing_QM_outputs/QCORR_1/` | SCF non-convergence |
| `g16-dvb-ir-truncated.out` | first 120 000 bytes of `g16-dvb-ir.out` | truncated file (derived, not a complete job) |
| `g09-dvb-un-sp.log` | `cclib/cclib`, `data/Gaussian/basicGaussian09/dvb_un_sp.log` | unrestricted single point: ⟨S²⟩ line and annihilation block |
| `g09-dvb-un-sp-b.log` | `cclib/cclib`, `data/Gaussian/basicGaussian09/dvb_un_sp_b.log` | second unrestricted single point, used to confirm the ⟨S²⟩ reader |
| `g16-propyleneoxide-vcd.out` | generated for this repository on 2026-11-08 (see below) | `#p B3LYP/6-31G(d) Opt Freq=(VCD) EmpiricalDispersion=GD3BJ`, (S)-propylene oxide, 10 atoms, 24 modes |

Each excerpt starts at the header line Gaussian prints before the table and ends
at the closing dashes (the relaxed scan ends at its last parameter row).

Attribution: the source repositories are public; the excerpts are reproduced for
parser testing only. Gaussian itself is licensed separately by Gaussian, Inc.

## `g16-propyleneoxide-vcd.out` — the first VCD log

Issue #78 could not find a Gaussian `Freq=(VCD)` output anywhere public, so this
one was produced for the repository rather than downloaded:

| | |
|---|---|
| Program | Gaussian 16, Rev A.03, `EM64W-G16RevA.03 17-Dec-2016` (Windows x64) |
| Route | `#p B3LYP/6-31G(d) Opt Freq=(VCD) EmpiricalDispersion=GD3BJ` |
| Molecule | (S)-propylene oxide, C₃H₆O, 10 atoms — a small chiral molecule |
| Starting geometry | RDKit ETKDG embedding + MMFF94 optimisation, written as Cartesian input |
| Result | `Optimization completed`, `Normal termination`, 24 modes (3N−6), no imaginary modes |
| Machine | 8 cores, 8 GB, 1 min 9 s wall time |
| Run by | Will (licensed Gaussian 16 user), 2026-11-08, at his instruction |
| Full log | kept whole (302 kB) because the VCD rows sit inside the frequency section, not in a standalone table |

What the block looks like (this is the layout the parser is written against):

```
 Harmonic frequencies (cm**-1), IR intensities (KM/Mole), Raman scattering
 activities (A**4/AMU), depolarization ratios for plane and unpolarized
 incident light, reduced masses (AMU), force constants (mDyne/A),
 Dipole strengths (10**-40 esu**2-cm**2),
 Rotational strengths (10**-44 esu**2-cm**2),
 E-M angle = Angle between electric and magnetic dipole transition moments (deg),
 and normal coordinates:
                      1                      2                      3
 Frequencies --    212.7138               365.0224               411.8010
 IR Inten    --      0.5246                 3.7138                 4.3208
 Dip. str.   --      9.8394                40.5893                41.8584
 Rot. str.   --      3.9145               -12.6414                -2.0675
 E-M angle   --     70.6644               123.5470                97.0148
  Atom  AN      X      Y      Z        X      Y      Z        X      Y      Z
```

Two observations this fixture settled, both now asserted in `test/vcd.test.js`:

1. Rev A.03 prints **no velocity/length representation label** for the rotational
   strength row — only the unit. #78 assumed the output states it; it does not,
   so the record keeps `representation: null` and the card says so.
2. The row is `Rot. str. --` / `Dip. str. --` (abbreviated), not
   `Rotational strengths ---`. A parser written from the section prose header
   would silently read nothing.

ROA (`Freq=ROA`) is a Gaussian 16 **B.01+** feature and cannot be produced on an
A.03 licence, so no ROA fixture is included and no ROA reader is claimed.
| `g16-h2o-raman.out` | `exa-analytics/exatomic` (`exatomic/static/gaussian/g16-h2o-321g-freq.out`), G16, `Freq=Raman` on water | Raman activities 11.4937 / 95.6630 / 44.0813 Å⁴/amu and both depolarisation ratios; the file contains the short and the long layout of the same table |
| `g16-dvb-td.out` | `cclib/cclib` (`data/Gaussian/basicGaussian16/dvb_td.out`), G16 TD-DFT on divinylbenzene | Rotatory-strength block in both conventions (velocity and length); **achiral**, so every value is printed as zero — it proves the column layout, not the signs |


## Gaussian 16 A.03 (Windows) — runs produced by this app

| File | Route the app wrote | Result |
|---|---|---|
| `g16-a03-water-sp.out` | `#p B3LYP/6-31G(d) SP EmpiricalDispersion=GD3BJ Pop=NBO` | −76.4093047918 Eh, 9 SCF cycles, normal termination |
| `g16-a03-water-optfreq.out` | `#p B3LYP/6-31G(d) Opt Freq EmpiricalDispersion=GD3BJ` | 5 optimisation frames, 3 modes, ZPE 0.021164 Eh |

Both were produced by Gaussian 16 **Rev A.03** (`EM64W-G16RevA.03 17-Dec-2016`) on a licensed
Windows machine, from inputs written by `buildGaussianInput`, and returned by the peer run of
2026-11-08. They matter because they are the first logs that came out of *this* builder, and because
G16 A.03 prints a displacement table (`Atom AN  X Y Z`) and an `IR Inten --` line that the older
`g16-dvb-ir.out` fixture does not — that fixture carries a G09-shaped block, so a parser tuned to it
passes the suite and fails on every real G16 frequency job.

## Psi4

Verbatim Psi4 outputs from the Psi4 project's own test suite and two public
repositories. They are complete files, not excerpts, so the parser sees the
block order a real run produces.

| File | Source | Job | Psi4 version |
|---|---|---|---|
| `psi4-scf1.out` | `psi4/psi4`, `tests/scf1/output.ref` | RHF/cc-pVQZ single point | 1.1rc3.dev5 |
| `psi4-dft-freq.out` | `psi4/psi4`, `tests/dft-freq/output.ref` | B3LYP/6-31G* frequencies + thermochemistry | 1.1rc3.dev5 |
| `psi4-opt1.out` | `psi4/psi4`, `tests/opt1/output.ref` | optimisation that converges, then one that does not | 1.1rc3.dev5 |
| `psi4-opt2.out` | `psi4/psi4`, `tests/opt2/output.ref` | two converged optimisations (allene, DZ) | 1.1rc3.dev5 |
| `psi4-mp2-1.out` | `psi4/psi4`, `tests/mp2-1/output.ref` | MP2/6-31G(d,p) | 1.1rc3.dev5 |
| `psi4-cc1.out` | `psi4/psi4`, `tests/cc1/output.ref` | CCSD/6-31G(d,p) | 1.1rc3.dev5 |
| `psi4-sapt1.out` | `psi4/psi4`, `tests/sapt1/output.ref` | SAPT0/cc-pVDZ on a dimer | 1.1rc3.dev5 |
| `psi4-io-error.out` | `ReactionMechanismGenerator/RMG-Py`, `arkane/data/psi4/IO_error.out` | ADC job that dies in PSIO | 1.4a1.dev75 |

The flat files above come from Psi4's own test suite. The `psi4-1.11-*` folders were produced for
this repository inside the official `psi4/psi4:1.11` image (see each folder's `PROVENANCE.md`). A
later Psi4 release that changes a block shape should be added as a new folder rather than editing
one.
