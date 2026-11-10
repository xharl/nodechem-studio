# Changelog

All notable changes to NodeChem Studio are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), the version scheme is
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), and every date is the release date.

The history starts at **0.2.1**, the first release after this repository was prepared for public use.
0.1.0 was published and then withdrawn; it is not listed. Sections for released versions summarise
what the build contains — the GitHub release for each tag carries the long form.

## [0.5.1] - 2026-11-10

Thirty-nine non-merge commits since 0.5.0. There is no format change: `schemaVersion` stays 3, and a
0.5.0 project opens unchanged.

### Added

- **The PySCF engine** (#269) — a fixed Python deck and a JSON record on stdout, running in the same
  queue as the other engines: HF/DFT single points, optimisations and frequencies, MP2, CCSD,
  CCSD(T) and CASSCF single points, and PCM solvation on a single point. **PySCF TD-DFT** singlet
  roots with oscillator strengths (#296).
- **ORCA beyond a single point** — NMR shieldings and spin-spin couplings (#284), TD-DFT excited
  states with oscillator strengths (#285), Raman and VCD spectra (#288), and a transition-state
  search, IRC and relaxed scan (#286).
- **A cclib converter sidecar** (#273): a foreign log is converted to Chemical JSON by a
  user-installed interpreter, so NWChem, GAMESS and Q-Chem output can be imported as
  `kind: "imported"` records.
- **A Multiwfn analysis sidecar** in the Analyse block: QTAIM basin integration, ESP surface
  statistics, ELF/LOL cubes and RDG–NCI points from a **user-installed** Multiwfn 3.8 binary, in
  `-silent` batch mode. The binary is never bundled; every `run.json` records its version, the exact
  menu script, the input SHA-256 and the required citation (#270).
- **ONIOM result parsing** (#67): extrapolated energies, gridpoint components, layer counts and
  link-atom cuts, with a layer SCF never shown as the ONIOM total.
- **ROA intensities and invariants** read from a Gaussian log (#127).
- **ChemDraw binary `.cdx` drawings** imported as one record per fragment (#221).
- **Explicit solvent clusters** in a `prepare` block (#228).
- **A validation matrix** over the reference cases, tabulated by the CLI, with PySCF ladder rungs
  executed when a case carries a molecule (#230).
- **App-wide machine settings**, stored outside the project (#252).
- **A floating run console** that remembers its position (#253).
- **Matrix element requests** (`rwf`) from a Gaussian block (#247 Tier 1), and more of what an fchk
  carries — Job Status, character fields and MO dimensions (#244, #245, #246).

### Changed

- **ADR 0002 defines the explorer**, the sixth program role: a program that navigates a potential
  energy surface exposed by a calculator and returns a saddle, path or profile. It amends ADR 0001
  §2.5 and adds a gradient/Hessian capability declaration to the engine contract.

### Fixed

- The engine settings table in `docs/guide/engines.md` listed ORCA without `TD-DFT`, `Opt=TS`, `IRC`
  or `Scan` after #286 implemented them, and still called the `.gbw` hand-off unimplemented; both now
  match `src/shared/engines/orca.js` and `electron/runner/checkpoint.js`.
- The packaged app ships `src/data`, so its JSON reference tables resolve (#299).
- The run console is scoped to the open project, and a project swap clears queue history.
- Companion binaries are taken from `PATH`, and a signalled child is reported instead of passing.
- Psi4 and the schema resolve label/key method names, and a null prepare energy can be saved.
- A dry run no longer spawns a prepare converter.
- Psi4 writes its scratch files to the run's own `scratch/` folder instead of `/tmp`, a launch whose
  scratch filesystem has less than 1 GiB free is refused before it starts, and a run that still
  exhausts the disk records `scratch.exhausted` with the folder and the free space (#283).
- `ncs run` no longer stops a healthy queue on a fixed one-hour default: `--timeout` is the
  watcher's clock and each task keeps the project's `runner.timeoutSeconds` budget. A queue stopped
  by the watcher is left `paused` with its running task `interrupted`, so a later run resumes it
  (#305).

## [0.5.0] - 2026-11-09

Seventy-three non-merge commits since 0.4.0. The one breaking change is
the schema bump to 3; a saved 0.4.0 project is refused by version, not migrated.

### Added

- **Tautomer enumeration** through an external RDKit sidecar (`scripts/tautomer-enumerator.py`):
  set a Generate block to *Produces → Tautomers* and it enumerates the tautomer set of the input
  geometry, labels every candidate `t1`, `t2`, … with canonical SMILES and formula, and refuses a
  multiplicity other than 1. No energies, populations or pruning until a calculation runs (#226).
- **ML scorers** as a role rather than an engine: `rankBy` on Generate, `provider` on Calculate, and
  an ML relax on Prepare. AIMNet2 through a sidecar, with a name-based domain guard, explicit eV/Å
  units, mandatory provenance and `comparableWithQuantumChemistry: false` on every result.
- **A `prepare` block** — deterministic tool calls that change chemistry or geometry without a route
  (ADR 0001 step 4).
- **Ensemble input** through input blocks, so a family can start from a file of structures
  (ADR 0001 step 3).
- **DP4 and DP4+** candidate ranking from a committed parameter bank: the three DP4+ variants,
  Boltzmann weighting, the missing-nucleus rule, and a stated verification boundary (#165).
- **EPR**: spin populations, Fermi-contact hyperfine couplings and a g-tensor that is *refused by
  name* rather than filled with 2.0023 (#168); ORCA hyperfine and spin-spin coupling tables import
  into the same rows (#222).
- **NMR spin-spin couplings**: requested from Gaussian, read from the log, drawn, and cited with
  their reference and source column (#147).
- **Wavefunction analysis**: QTAIM bond critical points and an NCI/RDG figure (#59); a slice and an
  isosurface viewport; an isosurface coloured by electrostatic potential (#164); `ncs cube` to write
  a cube from a run or a wavefunction file, in either unit (#145).
- **Excited states**: root selection, vertical emission, an NTO chain and an ES-optimisation report;
  Psi4 TD-DFT with the table Psi4 actually prints (#166); transition dipoles, point-dipole coupling
  of a dimer and charge-transfer character from the transition density (#173).
- **Radiative rate and lifetime** from oscillator strengths (#170).
- **Structure blocks**: several records combined into one complex with fragment labels (#188), a
  repeat unit expanded into n-mers as a homologous series (#169), and one-atom graph edits through a
  derivative block (#189).
- **An in-app UFF force field** (energies, gradients, a guarded minimiser) and an **Open Babel
  MMFF94** conformer stage, so a Generate block no longer needs CREST to produce shapes (#144).
- **A cost estimate before a run** — wall time and core-seconds with the uncertainty stated, every
  coefficient derived from a log committed to this repository (#143).
- **A Compute block** for safe arithmetic across records, including CBS extrapolation (#175).
- **Spin-state sweeps** surfaced in the inspector, the queue, the results panel and the report (#186).
- **A wall-clock timeout** per task, recorded as timed out rather than failed (#177).
- **A measured-spectrum overlay** on the computed sticks, with the overlay file hashed (#184).
- **Interoperability**: a SMILES reader; NWChem, GAMESS and Q-Chem deck export from the window and
  from `ncs convert` / `ncs export-input` (#148); a CDXML drawing imported as one record per fragment
  (#139).
- **Psi4 DDX implicit solvation** (`PCM`, `COSMO`), with the two energies the log prints kept apart
  (#167), and a core-correlation choice on MP2/CCSD/CCSD(T) (#174).
- **ORCA DLPNO-CCSD(T)** single points, with the PNO preset recorded (#227).
- **Report figure sets** (`basic`, `surfaces`, `none`) and the measured error bar instead of a
  literature average (#229).
- **A real project menu** with recent projects (#149).

### Changed

- **`schemaVersion: 3` — the block taxonomy (ADR 0001), a breaking format change.** Six data stages
  (`input`, `prepare`, `generate`, `calculate`, `analyse`, `output`) plus two axes that are not
  stages (`condition`/`loop`/`merge` for control, `note` for annotation). A 0.4.0 project is refused by
  version; finish or export it in 0.4.0 before upgrading. There is no migration.
- **Run-record v2**: an imported number is a `kind: "imported"` record, and `$defs.runRecord` is the
  v1 body verbatim, so an old document still validates and still exports at `--schema-version 1`.
- **The Generate block** names what it produces (`conformers` or `tautomers`) instead of implying a
  shape search for every generator.

### Fixed

- **Gaussian solvation** is recorded as the log prints it — model and terms — instead of being
  inferred from the route (#223).
- **Psi4 reports the MP2 total**, not the SCS total (#159).
- **A restart artifact is validated against the engine that owns it** with the engine's own file
  pattern, and the run console seeds the executable from engine detection (#231, #233).
- **A TD-DFT block can be saved again**, and the job-type enum cannot drift from the schema (#181).
- **An optional settings key survives a save** (#173, #174).
- **Block states follow the restored queue** after a restart (#160).
- **Surface numbers refresh** when the renderer starts (#156).
- **UFF conformer generation returns the ranked members**, not the raw trials (#144).

### Documentation and tests

- **ADR 0001** specifies the taxonomy and records that it is implemented.
- **`docs/PROJECT-FORMAT.md`** catches up with every setting the schema reads.
- **One captured real-output fixture per parser branch** is now enforced: each parser exports the
  branches it can take, and `test/fixtureCoverage.test.js` fails on a branch no fixture reaches
  (#176).
- **This changelog.**

## [0.4.0] - 2026-11-08

The first release with a format that holds several flows, and with real ORCA and Psi4 execution.

- **Schema v2**: `flows[]` of input → calculation → output blocks, `dataset` inputs driving one run
  per record, `barrier` edges holding a stage, output blocks writing HTML/CSV/JSON/ZIP with a SHA-256
  manifest. A v1 project migrates with a byte-identical plan.
- **Execution follows the branch**: fan-out with per-member checkpoints (`opt~c1`, `freq~c1`,
  `opt_c1.chk`), `runner.maxParallel` for a family, and a partial family run that reports its own
  verdict and exit code.
- **ORCA executes** end to end (builder, preflight, log import, `.gbw` hand-off); **Psi4** is
  first-class (Psithon builder, real-log parser, SAPT, stdout runner), fixed against Psi4 1.11.
- **Gaussian correctness** from a 25-case sweep on real G16 Rev A.03 output: hyphenated `def2-*`
  routes, GenECP in l301, the opt-freq checkpoint link, an ASCII route for `ωB97X-D`, and the
  frequency, trajectory and post-HF/composite energy blocks.
- **Analysis**: frontier orbitals with Koopmans descriptors, cube and fchk ingest, VCD with signed
  rotational strengths, constrained optimisation, QST2/QST3 and `ModRedundant` lines, Eyring rates,
  scan barriers, pKa and redox cycles, Helgaker CBS extrapolation, benchmarks and Boltzmann-weighted
  observables.
- **Interoperability**: cube, formatted checkpoint, Molden, WFN/WFX, JCAMP-DX and ChemDraw CDXML
  readers; `ncs convert` to extxyz/xyz/SDF/JCAMP-DX/Molden; `ncs cache` typed arrays; QCSchema
  `AtomicResult` against the vendored MolSSI v2 schemas; a versioned run record, `ncs export` and a
  stdlib-only Python client.
- **Provenance**: an imported ensemble names its program, version, method and source hash; energies
  carry their unit; a number another program computed is a `kind: "imported"` record; a CDXML import
  is flagged as a 2D depiction.

## [0.3.0] - 2026-11-08

- **Conformer and protomer ensembles**: CREST (GFN2/GFN-FF) or a multi-XYZ import, ranked by energy,
  pruned by window and RMSD, with Boltzmann populations; more than one surviving protomer forbids an
  automatic choice (#30).
- **Input**: PDB, PDBQT, MOL2, cJSON and Gaussian-log frames with a record picker and bond orders
  preserved (#79).
- **Analysis**: RRHO thermochemistry at any T and p, pinned to Gaussian's printed table, with a sweep
  workbench and CSV export (#70); NMR shielding (#61), Raman activities with a measured overlay
  (#76), emission templates and ECD rotatory strengths (#75); IRC/scan/ΔG‡/pKa cycles (#62); spin
  states with `Stable=Opt` and D4 (#69); method ladders with a spread gate (#26).
- **Per-block engine selection** with cross-engine geometry hand-off and recorded refusals (#63).
- **Judgement**: conformer-spread validity check, per-check pass/fail/not-applicable, the workflow
  report and dataset export, structural diff, three-way merge and the shared-file save guard (#74).
- **Interface**: one token contract and three themes (#52); animated normal modes, Kabsch/Horn
  superposition and SVG figures (#71).

## [0.2.1] - 2026-11-08

The first clean build after the repository was prepared for public release; it supersedes the
withdrawn 0.2.0 tester build.

- One workflow queue at a time; a double-click cannot create two queues.
- The title-bar chip reports the real version, from the build and from `app:info`.
- Every inspector and drawer control carries an explicit label.
- Validity context survives a restart.
- Parsed geometry is attached to the finished node, so the structure viewer is reachable.
- xTB runs show their mRRHO note instead of Gaussian-only corrections.
- Non-finite frequencies fail the gates.
- Per-block charge and multiplicity are honoured.
- `.ncs` files open from the desktop, "Open with", `file://` arguments and macOS `open-file`.
- Packaged provenance records the commit the build came from.

[0.5.1]: https://github.com/xharl/nodechem-studio/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/xharl/nodechem-studio/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/xharl/nodechem-studio/releases/tag/v0.4.0
[0.3.0]: https://github.com/xharl/nodechem-studio/releases/tag/v0.3.0
[0.2.1]: https://github.com/xharl/nodechem-studio/releases/tag/v0.2.1
