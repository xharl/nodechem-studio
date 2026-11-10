# Feature map — what the supported programs offer, and what NodeChem does with it

Status of this document: audit as of **2026-11-09**, against the working tree that contains
schemaVersion 3 (ADR 0001), the `prepare` block, the scorer role, RDKit conformers and tautomer
enumeration. Issues #222, #226, #227, #229 and #231 have closed since the map was first drafted;
#228 (explicit solvation) remains open; #230 (validation harness) now has recorded and live PySCF paths. It records capabilities, not keywords:
"feature" means something a computational chemist selects — a job type, a property, a method
family, a correction or a workflow primitive. Every Gaussian keyword, ORCA `%block` and Psi4
`set` option is not enumerated; that would be a manual, not a map.

**How a status was decided**

- **Implemented** — the builder writes the input *and* the parser reads the result into a record.
- **Keyword-only** — the input can be produced, but the result is not parsed into structured data.
- **Absent** — no builder path and no parser.
- **N/A** — the program does not offer it.

Evidence is the module that implements the feature. Where the status was taken from documentation
rather than a live run, the engine's own guide says so (`docs/guide/engines.md`).

---

## 1. Gaussian 16 (commercial)

Program capabilities from Gaussian's published job-type and model-chemistry lists.

| Capability | Program | NodeChem | Evidence / note |
|---|---|---|---|
| Single point | SP | **Implemented** | `gaussianInput.js`, `gaussianOutput.js` |
| Geometry optimisation | Opt | **Implemented** | with convergence control and force-constant choice |
| Frequency + thermochemistry | Freq | **Implemented** | RRHO and quasi-RRHO, standard state |
| Optimise then frequency | Opt Freq | **Implemented** | |
| Transition-state search | Opt=TS | **Implemented** | `tsForceConstants.js`, CalcFC/CalcAll/ReadFC |
| Synchronous transit (QST2/QST3) | Opt=QST2/QST3 | **Implemented** | extra structures stored in the block |
| Reaction path following | IRC | **Implemented** | `reactionPath.js` |
| Relaxed PES scan | Scan | **Implemented** | `reactionPath.js` |
| **IRCMax** | IRCMax | **Absent** | finds the maximum along a path; no builder path |
| **Polarizabilities / hyperpolarizabilities** | Polar | **Absent** | zero occurrences of `Polar` as a job type in `src/` |
| **Direct dynamics (BOMD)** | BOMD | **Absent** | `bomd`/`admp` absent from `src/` |
| **Direct dynamics (ADMP)** | ADMP | **Absent** | same |
| **Excitation-energy transfer** | EET | **Absent** | no EET job type |
| **Forces on nuclei** | Force | **Absent** | no job type |
| **Molecular volume** | Volume | **Absent** | the `Volume` hits in `src/` are cube-file geometry, not this job |
| Population analysis only | Density=Checkpoint / Guess=Only | **Keyword-only** | `Guess=Only` appears in the builder; no population-only workflow |
| Wavefunction stability | Stable=Opt | **Implemented** | `routePresets.js`, schema |
| TD-DFT / CIS excited states | TD | **Implemented** | SP and Opt; roots and states validated |
| Excited-state optimisation | Opt TD | **Implemented** (unverified shape) | parsed from documented layout, `verified: false` |
| **EOM-CCSD** | EOM-CCSD | **Absent** | no method path |
| **CASSCF / MCSCF** | CASSCF | **Absent** | `CASSCF`/`MCSCF` absent from `src/` |
| **ONIOM / QM-MM** | ONIOM | **Absent** | no multi-layer model |
| Compound methods | G4, CBS-QB3, CBS-APNO, W1 | **Implemented** | `routePresets.js` (route keywords, not method/basis pairs) |
| Counterpoise / BSSE | Counterpoise | **Implemented** | `validityChecks.js`, parser |
| NBO analysis | Pop=NBO | **Implemented** | parsed from the log |
| Hirshfeld / MK charges | Pop | **Implemented** | `gaussianOutput.js` |
| ESP / electrostatic potential | cube | **Implemented** | `esp.js`, `cubeFile.js` |
| Multiwfn sidecar (QTAIM basins, ESP surface, ELF/LOL cubes, RDG–NCI) | wfn/wfx/fchk/molden/cube | **Implemented** — user-installed Multiwfn 3.8, not bundled | `multiwfn.js`, `multiwfnRunner.js` |
| QTAIM / AIM analysis | wavefunction | **Implemented** | `qtaim.js` (from fchk/wfn) |
| NCI analysis | — | **Implemented** | `nci.js` |
| NMR shieldings | NMR=GIAO | **Implemented** | `nmr.js` |
| NMR spin-spin couplings | NMR=(GIAO,SpinSpin) | **Implemented** | `nmr.js`, 1-based tables |
| NMR spin-rotation | — | **Absent** | not parsed |
| VCD rotational strengths | Freq=VCD | **Implemented** | `vcd.js` |
| Raman activities | Freq=Raman | **Implemented** | `raman.js` |
| **ROA** | Freq=ROA | **Implemented (G09 E.01 fixture)** | `roa.js`; three geometries, `RC180`, signed card; G16 B.01+ unverified |
| ECD / exciton coupling | TD | **Implemented** | `ecd.js`, `exciton.js` |
| Hyperfine couplings | open-shell output | **Absent** | no hyperfine branch in `gaussianOutput.js`; the EPR card is fed by Psi4 and ORCA only |
| **Spin-orbit coupling** | — | **Absent** | only referenced in `epr.js` prose |
| **Relativistic (DKH/ZORA)** | — | **Absent** | one `DKH` mention in `validityChecks.js` |
| **Anharmonic frequencies** | Freq=Anharmonic | **Absent** | zero occurrences |
| Implicit solvation | PCM / SMD / CPCM | **Implemented** | `projectSchema.js` solvation models |
| **Explicit / micro-solvation** | `prepare.kind = "solvate"` | **Implemented (deterministic placement)** | seeded rigid-template cluster (#228); not equilibrated, not a free energy |
| **Explicit solvent MD / equilibration** | — | **Absent** | no MD engine; implicit solvation remains the continuum model |
| ECP / GenECP | GenECP | **Implemented** | `ecp.js`, `ecpData.js` (def2, SDD subsets) |
| Coordinate constraints | ModRedundant | **Implemented** | `constraints.js` |
| Checkpoint chaining | %OldChk, Geom=Check | **Implemented** | `checkpoint.js` |

---

## 2. ORCA 6.1 (free academic)

| Capability | Program | NodeChem | Evidence / note |
|---|---|---|---|
| Single point | SP | **Implemented** | `engines/orca.js`, real 6.1 fixture |
| Optimisation | Opt | **Implemented** | |
| Frequency + thermochemistry | Freq | **Implemented** | QRRHO recorded |
| Optimise then frequency | Opt Freq | **Implemented** | |
| DLPNO-CCSD(T) single point | DLPNO-CCSD(T) | **Implemented** | PNO threshold recorded; real log fixture |
| **NMR shieldings (GIAO)** | `! NMR` + `%EPRNMR` | **Absent** | `ORCA_UNSUPPORTED_JOB_TYPES` lists `NMR`; the TE agent hit this |
| NMR spin-spin couplings | `%EPRNMR … SSALL` | **Keyword-only** | couplings are parsed from *imported* logs (issue 222), but the builder never requests them |
| **TD-DFT / excited states** | TD-DFT, SOC | **Absent** | refused by name |
| **Transition-state search** | OptTS | **Absent** | refused by name |
| **IRC** | `%irc` | **Absent** | refused by name |
| **Relaxed PES scan** | Scan | **Absent** | refused by name |
| **NEB / path search** | `%neb` | **Absent** | no builder path |
| **Molecular dynamics** | MD module | **Absent** | no builder path |
| **CASSCF / NEVPT2 / MRCI** | multireference | **Absent** | zero occurrences |
| **EOM-CCSD** | EOM | **Absent** | one mention in `orcaProperties.js`, not a job |
| **XAS / XES** | spectroscopy | **Absent** | no parser or builder |
| **Mössbauer / ZFS** | EPR module | **Absent** | hyperfine and g-tensor only |
| **ROA / VCD / Raman** | `%elprop` | **Absent** | no builder path |
| **Population analysis (NBO/ESP)** | `%output` | **Absent** | refused by name |
| **QM/MM** | QMMM | **Absent** | no layer model |
| **Relativistic (DKH/ZORA/X2C)** | `! DKH` etc. | **Absent** | not written |
| **DLPNO gradients / multilevel** | DLPNO-Multilevel | **Absent** | single point only |
| **EDA / LED** | `%eda` | **Absent** | no builder path |
| EPR hyperfine + g-tensor | `%eprnmr` | **Keyword-only** | parsed from imported logs, not requested |
| Dispersion | D3/D4 | **Implemented** | keyword mapping |
| Implicit solvation | CPCM / SMD | **Implemented** | `%cpcm` |
| ECP | def2-ECP | **Implemented** | via def2 basis; SDD refused by name |
| Restart hand-off | `.gbw`, `%moinp` | **Implemented** | queue transfer |
| Resources | `%pal`, `%maxcore` | **Implemented** | |

---

## 3. Psi4 (LGPL-3.0)

| Capability | Program | NodeChem | Evidence / note |
|---|---|---|---|
| SP / Opt / Freq / Opt Freq | yes | **Implemented** | `engines/psi4.js` |
| TD-DFT (vertical) | TDSCF | **Implemented** | states per irrep documented |
| SAPT0 | SAPT0 | **Implemented** | interaction energy, `extras.sapt` |
| **SAPT2 / SAPT2+ / SAPT2+(3)** | yes | **Absent** | only SAPT0 in the method list |
| CCSD / CCSD(T) | yes | **Implemented** | core-correlation choice |
| **FNO-CCSD(T)** | yes | **Absent** | not in the method list |
| **EOM-CCSD** | yes | **Absent** | not in the method list |
| **ADC(2)** | yes | **Absent** | not in the method list |
| **CASSCF / MCSCF** | yes | **Absent** | not in the method list |
| **DMRG** | via CheMPS2 | **Absent** | not in the method list |
| **Counterpoise / BSSE** | `bsse_type` | **Absent** | no builder path (Gaussian has it) |
| **CBS extrapolation driver** | `psi4.driver.cbs` | **Implemented (app-side)** | `cbs.js` does a Helgaker two-point extrapolation from *any* engine's ladder; Psi4's own driver is unused |
| **Analytic CC gradients** | yes (CCSD) | **Absent** | the program has them; the builder never writes an Opt at CC level |
| Frequencies at CC | not available | **N/A** | refused by documentation |
| EPR hyperfine (density-only) | fchk spin density | **Implemented** | `epr.js` |
| **g-tensor** | no | **N/A** | refused by name (Psi4 has no SOC module here) |
| Implicit solvation | DDX PCM/COSMO | **Implemented** | needs `pyddx`; two SCFs |
| **SMD / CPCM / LPB in Psi4** | not DDX | **N/A** | refused by name |
| **NMR** | no implementation | **N/A** | Psi4 forum confirms; ADR-relevant when choosing an NMR engine |
| **IRC / NEB / TS search** | partial | **Absent** | not in the builder |
| **Constraints** | OptKing | **Absent** | no builder path |

---

## 4. xTB (LGPL)

| Capability | Program | NodeChem | Evidence / note |
|---|---|---|---|
| GFN0 / GFN1 / GFN2 / GFN-FF | yes | **Implemented** | `engines/xtb.js` |
| SP / Opt / Freq / Opt Freq | yes | **Implemented** | optimisation levels exposed |
| Implicit solvation | ALPB / GBSA | **Implemented** | |
| Threads / restart | yes | **Implemented** | |
| **Molecular dynamics** | `--md` | **Absent** | no builder path |
| **Metadynamics** | `--metadynamics` | **Absent** | no builder path |
| **NEB** | `--path` | **Absent** | no builder path |
| **Relaxed scan** | `--scan` | **Absent** | no builder path |
| **UV-Vis (sTDA)** | `--stda` | **Absent** | no builder path |
| **Constraints / fixed atoms** | `--fix` | **Absent** | not exposed |
| **Explicit solvent** | `--solvent` shell | **Implemented (placement only)** | `prepare.kind = "solvate"`; no equilibration |
| **Population / charges output** | yes | **Keyword-only** | result parsing is energy/frequency oriented |

---

## 5. Generators and scorers

| Tool | NodeChem | Note |
|---|---|---|
| CREST conformer search | **Implemented** | `conformers.js`, fan-out |
| Open Babel MMFF94 conformers | **Implemented** | issue 144 |
| In-app UFF | **Implemented** | `uff.js` |
| Imported ensembles | **Implemented** | with provenance |
| RDKit ETKDGv3 generator | **Implemented** | `rdkit` is a `CONFORMER_GENERATORS` entry |
| ML scorer (AIMNet2 et al.) | **Implemented (branch)** | `scorer.js`, `mlRelax.js`, `scorerRunner.js`; ADR §2.10 |
| Tautomer/protomer enumeration | **Implemented** | `tautomers.js` + `tautomerRunner.js`, RDKit ruleset (issue #226) |
| `prepare` block (embed 3D, relax) | **Implemented (branch)** | ADR §2.9; `mlRelax.js` |
| Descriptors / fingerprints | **Absent** | no RDKit descriptor path |
| Validation harness across reference cases | **Implemented** | `validationMatrix.js`, `ncs validation`; `--run` executes PySCF rungs (issue #230) |
| cclib foreign-log conversion | **Implemented** | `scripts/ncs_cclib.py`, `ncs convert --format cjson` (issue #273); cclib is user-installed |
| Uncertainty reporting | **Implemented** | `uncertainty.js` (issue #229) |

---

## 6. The gaps worth fixing, ranked

Effort is engineering time, not calendar, and assumes the parser work is done against a real log.

| Rank | Gap | Why it matters | Effort |
|---|---|---|---|
| 1 | **ORCA NMR job** (shieldings + couplings) | the free engine cannot do NMR at all; TE hit this on Will's project; the analysis side (DP4, TMS references, spectra) already exists | ~3 days |
| 2 | **ORCA TD-DFT** | ORCA users cannot do UV-Vis/ECD; the excited-state analysis already exists for Gaussian and Psi4 | ~4 days |
| 3 | **ORCA TS / IRC / Scan** | no reaction paths at all on ORCA, although the Gaussian path logic is written | ~1 week |
| 4 | **Explicit / micro-solvation** (#228) | implicit models miss specific H-bonds; the record cannot even say "implicit only" today | 1–2 weeks |
| 5 | **Validation harness** (#230) | recorded and live PySCF paths are implemented; Gaussian/ORCA/Psi4 live rungs remain | — |
| 6 | **Gaussian Polar** (polarizability, hyperpolarizability) | a single keyword job; completes the property set on the licensed engine | ~3 days |
| 7 | **Psi4 SAPT2 family** | SAPT0 is the cheapest rung; interaction-energy analysis is the app's strength | ~1 week |
| 8 | **ONIOM / QM-MM** | whole class of papers; needs a layer/region model, not just a keyword | 2–4 weeks |
| 9 | **CASSCF / NEVPT2** (ORCA) | the one method family with no representation; T1 diagnostic already exists | ~2 weeks |
| 10 | **BOMD / ADMP** (Gaussian) and **MD** (ORCA/xTB) | would need a trajectory model and viewer; the app has no dynamics at all | 1–3 weeks |
| 11 | **EOM-CCSD / ADC** | excited-state accuracy beyond TD-DFT | 1–2 weeks |
| 12 | **xTB scan / NEB / sTDA** | cheap reaction paths and UV-Vis without a licence | 3–5 days each |
| 13 | **Relativistic (DKH/ZORA/X2C)** | heavy elements are currently ECP-only | ~1 week |
| 14 | **Anharmonic frequencies** | improves thermochemistry and spectra | 1–2 weeks |

Deliberately not a gap: **Psi4 NMR** (does not exist), **Psi4 SMD/CPCM** (not DDX models),
**Psi4 CC frequencies** (no analytic Hessian). ROA has a G09 fixture and a reader; G16 B.01+ is
unverified, not absent.

---

## 7. Limits of this map

- It is a capability map, not a keyword audit. Gaussian's `Polar` and ORCA's `%elprop` cover more
  than the rows above.
- "Implemented" means the code path exists and is tested; for several Gaussian job types the guide
  itself records that no licensed run has produced a log (`docs/guide/engines.md`, QST2/QST3,
  Opt TD). A capability can be implemented and still unproven.
- No live run was made for this audit. Statuses come from the repository at the commit named above.
