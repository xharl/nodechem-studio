# NodeChem Studio

NodeChem Studio is a desktop workbench for designing a complete computational-chemistry workflow as a
graph — not a front end for one program. Blocks are the stages of the workflow (input, prepare,
generate, calculate, analyse, output); the program behind a block is a separate choice. Every run
writes a folder with the exact input, the raw output and a provenance record you can hash and share.

Five engines run in-app, and each block picks its own:

| Engine | Licence | Level of theory |
| --- | --- | --- |
| **Gaussian 16** | Commercial — licensed separately by Gaussian, Inc. | DFT and wavefunction methods with explicit basis sets, down to `Opt=TS`, IRC and scans |
| **ORCA** 5/6 | Free for academic use — licensed separately by FACCTs | DFT and wavefunction methods including DLPNO-CCSD(T), plus TD-DFT, NMR and Raman/VCD, from a simple `.inp` |
| **Psi4** 1.4+ | Open source (LGPL-3.0) | DFT, wavefunction methods, SAPT and TD-DFT from a Psithon `.dat` |
| **PySCF** 2.x | Open source (Apache-2.0) | HF/DFT, MP2, CCSD(T) and CASSCF from a fixed Python deck, with PCM solvation on a single point |
| **xTB** (GFN0/GFN1/GFN2/GFN-FF) | Open source (LGPL) | Fast semi-empirical and force-field methods |

Any other program still joins the graph, at the edge its role allows:

| How a program joins | What it gets you |
| --- | --- |
| Run in-app | the five engines above: the input is built, the output is parsed, the same validity gates apply |
| Deck export | NWChem, GAMESS and Q-Chem through `ncs export-input` / `ncs convert`; a setting that cannot be spelled is refused by name, not dropped |
| Output import | any program's finished result as a `kind: "imported"` record, labelled `imported, not run here — <program> <version>`; foreign logs through cclib (**0.5.1**), plus QCSchema, cube, fchk, Molden, WFN/WFX and binary ChemDraw `.cdx` (**0.5.1**) |
| Sidecar role | CREST, Open Babel or RDKit as a generator, AIMNet2 as a scorer, Multiwfn as an analysis helper, cclib as a converter |

A project can mix all of them: an xTB pre-optimisation feeding a Gaussian frequency job is a normal
graph, with the hand-off refused when the receiving block cannot accept the geometry. The app bundles
no engine. It drives installations you already have, on the machine they are installed on. Without
any, the dry run exercises the whole pipeline on a labelled fixture.

![NodeChem Studio: node graph with the Reactant frequency inspector open](docs/images/studio-overview.png)

**Status: v0.5.1 — early preview.** Released 2026-11-10. 0.5.0 shipped on 2026-11-09; 0.5.1 adds the
PySCF engine, ORCA NMR/TD-DFT/Raman/VCD and transition-state, IRC and scan searches, a Multiwfn
analysis sidecar, a cclib converter for foreign logs, ONIOM and ROA result parsing, and binary
ChemDraw import. **The format is unchanged:** `schemaVersion` stays 3, a 0.5.0 project opens here as
it is, and a 0.4.0 project is still refused by version, not migrated.
[`CHANGELOG.md`](CHANGELOG.md) records what changed.
What has *not* been proven is a run driven by this app: no licensed Gaussian job and no real xTB job
has been executed by the project's automated tests. On 2026-11-08 a peer run did execute 25
app-written cases on Gaussian 16 Rev A.03 (Windows), and those logs now pin the parsers as fixtures;
driving the same job from the app's own run console remains unverified. Read
[Current limitations](#current-limitations) before you trust a result.

## What it does

The bullets marked **0.5.1** are the changes in this release, **0.5.0** the previous one; everything
unmarked shipped in 0.4.0.

- **Graph workflows** — blocks for each data stage (input, prepare, generate, calculate, analyse,
  output), for control (condition, loop, merge) and for notes, connected by dependency, checkpoint
  and branch edges. Undo/redo, three starting templates, and a save guard that refuses to overwrite a
  file changed on disk since it was opened. **0.5.0:** the ADR 0001 taxonomy behind
  `schemaVersion: 3`, which adds a `prepare` stage for deterministic tool calls and lets an input
  block carry an ensemble. **0.5.1:** explicit solvent clusters as a `prepare` step, and machine
  settings stored outside the project.
- **A durable queue** — runs blocks in dependency order, survives a restart, reconciles an
  interrupted task instead of calling it complete, and records branch decisions and attempts.
  **0.5.0:** a wall-clock limit per task recorded as *timed out*, and an estimate of wall time and
  core-seconds before a queue starts, with the uncertainty stated.
- **Five engines, chosen per block** — Gaussian 16 job types down to `Opt=TS`, IRC and scans; xTB
  with GFN0/1/2 and GFN-FF, solvation, threads and restart hand-off; ORCA 5/6 with `Opt`, `Freq`,
  TD-DFT, NMR, Raman/VCD, CPCM/SMD and `.gbw` hand-off; Psi4 with HF, DFT, MP2, CCSD(T), SAPT0 and
  TD-DFT; PySCF with HF/DFT, MP2, CCSD(T), CASSCF, TD-DFT and PCM — each judged by the same
  validity protocol where the checks apply. **0.5.0:** ORCA `DLPNO-CCSD(T)` single points and its
  hyperfine and spin-spin coupling tables imported from the log, and Psi4 TD-DFT and DDX solvation.
  **0.5.1:** PySCF joins as a fifth engine (including TD-DFT and CASSCF single points), ORCA gains
  NMR, TD-DFT, Raman/VCD and `OptTS`/IRC/scan, and Psi4 writes its scratch to the run's own folder.
- **Families of molecules** — a project holds several flows; a Dataset input block drives a whole
  family of records through one designed graph, one run per record (optionally in parallel), and a
  `barrier` connection holds a stage until every record has finished it. Output blocks write HTML,
  CSV, JSON or ZIP artifacts with a SHA-256 manifest, and every flow gets its own HTML report plus a
  combined one.
- **Conformer and protomer ensembles** — a Generate block runs CREST (GFN2 or GFN-FF), an in-app
  UFF search and minimiser, an Open Babel MMFF94 genetic-algorithm search, or imports a
  multi-XYZ, ranks the members by energy, prunes by energy window and RMSD, and refuses to choose a
  protomer for you. MM ensembles record their force field and kcal/mol unit, so a force-field number
  is never read as a Hartree one. A downstream block runs the member you picked, and `run.json` records which one
  it was. Fan-out follows the branch, so `generate → calculate → calculate` runs once per retained member,
  each reading its own checkpoint. CREST, Open Babel and RDKit are not bundled.
- **Tautomer sets — 0.5.0.** Set Generate to *Produces → Tautomers* and an RDKit sidecar enumerates
  the tautomers of the input geometry. Every candidate is labelled `t1`, `t2`, … with its canonical
  SMILES and formula, and carries no energy, population or prune until a calculation has run on it. A
  multiplicity other than 1 is refused, because the bond perception behind the enumeration assumes a
  closed shell.
- **Optional ML scorer — 0.5.0.** AIMNet2, or a sidecar of your own, can re-rank a Generate ensemble,
  run a Calculate single point, or relax a Prepare block, behind a name-based domain guard and
  mandatory provenance. A score is labelled `comparableWithQuantumChemistry: false` everywhere it
  appears, and torch plus the weights are yours to install.
- **Structure blocks — 0.5.0.** Several records combined into one labelled complex, a repeat unit
  expanded into a homologous series, and one-atom graph edits, each recorded as the structure it
  produced rather than as a number.
- **Wavefunction analysis** — cube, formatted checkpoint, Molden, WFN/WFX and QCSchema ingest, with a
  slice and an isosurface viewport. **0.5.0:** an isosurface coloured by electrostatic potential,
  QTAIM bond critical points, an NCI/RDG figure, and `ncs cube` to write a cube from a run or a
  wavefunction file. **0.5.1:** a Multiwfn 3.8 analysis sidecar (QTAIM basins, ESP statistics,
  ELF/LOL cubes, RDG–NCI points), `rwf` matrix-element requests from a Gaussian block, and the fchk
  job-status, character and MO-dimension fields.
- **Results you can defend** — gates answer "did it run", validity checks answer "is it
  defensible", an offline signature table explains known engine failures, and any two finished runs
  can be compared without recomputing anything.
- **Spectra and thermochemistry** — simulated UV-Vis from TD-DFT states, NMR shielding and spin-spin
  couplings with their references, Raman activities with a measured overlay, ECD rotatory strengths;
  IRC paths, scans, barriers, ΔG‡ and a pKa cycle; RRHO at any temperature and pressure with sweeps,
  conformer ensembles and CSV export. **0.5.0:** spin populations and Fermi-contact hyperfine
  couplings (a g-tensor is refused, not invented), and DP4/DP4+ probabilities over candidate
  structures from a committed parameter bank. **0.5.1:** ORCA NMR shieldings, spin-spin couplings,
  TD-DFT, Raman and VCD tables read from the log, and ROA intensities and invariants from a Gaussian
  log.
- **Structure viewer** — normal-mode animation from real displacement blocks, optimisation
  trajectory replay, Kabsch/Horn superposition with RMSD, and SVG figure export.
- **Reports and export** — a self-contained `report.html` per flow and a combined document across
  flows with a figure set (`basic`, `surfaces`, `none` — the same three `ncs report --figures`
  takes), `report.json`, dataset CSV/JSON with a versioned envelope, and run bundles with a per-file
  SHA-256 manifest.
- **Provenance** — `run.json` records the exact input hash, the parsed output, the engine's method
  block and the app version; a run bundle adds `methods.md` and a per-file SHA-256 manifest. An
  imported ensemble names its program, version, method and source hash, and energies carry their
  unit, so an MMFF94 number is never read as a Hartree one. A number another program computed is a
  `kind: "imported"` record in run-record v2 — labelled `imported, not run here — <program>
  <version>`, never mistaken for a run this app performed.
- **Three themes** — *current*, *graphite*, *paper*, from one token contract; the type scale is
  fixed and not themed.
- **Headless CLI** — `ncs validate`, `build-input`, `run`, `report`, `validation`, `export`, `record`,
  `diff`, `merge`, `convert`, `export-input`, `cache`, `qcschema`, plus `smiles` and `cube`
  (**0.5.0**); `ncs run --json` carries the kinetics summary and exits 5 when a family run is
  partial. `diff`, `merge`, `qcschema`, `cache`, `export`, `export-input`, `smiles` and
  `record import` are deliberately CLI-only, and every command's home is listed in
  [Headless CLI](docs/guide/cli.md).
- **Local only** — no account, no telemetry, and no network code beyond the update check you
  trigger yourself.

## Install

| Platform | How |
| --- | --- |
| Windows 10/11 x64 | Run `nodechem-studio-0.5.1-x64.exe` from the release. Per-user install, unsigned — SmartScreen warns once. |
| Linux x64 | `chmod +x nodechem-studio-0.5.1-x86_64.AppImage` and run it. Unsigned. |
| From source | Node 22+, then `npm ci && npm run dev`. |

Neither artifact installs an engine. Both are unsigned; `SHA256SUMS`, a
CycloneDX SBOM and a build-provenance attestation accompany every release. See
[Install](docs/guide/install.md) for the data directory and requirements, and
[how to verify your download](docs/guide/install.md#verify-your-download).

## First five minutes

1. Launch the app. The seeded Diels–Alder project opens with **Dry run (fixture output)** checked.
2. Select **Reactant frequency**, click **Run**, then **Run selected block**. No engine is needed.
3. Read the gate verdict and the results panel. A dry run is a labelled fixture, not a calculation.
4. Click **Run workflow** to watch the queue walk the graph, evaluate the condition and skip the
   branch it did not release.
5. **Save** to write a `.ncs` project.

[Your first project →](docs/guide/first-project.md) walks through it with the exact UI labels.

## Documentation

| Page | What it covers |
| --- | --- |
| [Documentation index](docs/guide/README.md) | Reading order and every reference page |
| [Install](docs/guide/install.md) | Artifacts, requirements, data locations, verifying a download |
| [Your first project](docs/guide/first-project.md) | Dry run, workflow, own geometry, saving |
| [The canvas](docs/guide/canvas.md) | Blocks, connections, states, inspector |
| [Flows, datasets and stages](docs/guide/flows.md) | Several graphs per project, a family of records, barrier stages |
| [Datasets and input blocks](docs/guide/datasets.md) | Importing a family, one run per record, outputs for the set |
| [Engines](docs/guide/engines.md) | Gaussian 16, xTB, ORCA, Psi4 and PySCF — job types, defaults, setup, what each parser proves |
| [Feature map](docs/FEATURE-MAP.md) | What each engine offers, what the app implements, and every gap that is still open |
| [Conformers and protomers](docs/guide/conformers.md) | CREST, UFF, Open Babel and RDKit tautomer enumeration, imports, ranking, choosing a member |
| [ML scorers](docs/guide/scorers.md) | The AIMNet2 sidecar, its domain guard, units and provenance |
| [Workflows](docs/guide/workflow.md) | Queue, conditions, loops, checkpoints, timeouts, cluster export |
| [Results](docs/guide/results.md) | Gates, validity checks, thermochemistry, EPR, viewer, bundles |
| [Reports](docs/guide/reports.md) | The per-flow report, the combined report, figure sets, the measured error bar |
| [Output blocks](docs/guide/outputs.md) | CSV, JSON, HTML and ZIP artifacts with a hashed manifest |
| [DP4 and DP4+](docs/guide/dp4.md) | Candidate ranking from computed and measured shifts, and what the verification does not show |
| [Analyse blocks](docs/guide/analyse.md) | Safe arithmetic over results, the field vocabulary, CBS extrapolation |
| [Wavefunctions](docs/guide/wavefunction.md) | Cube, fchk, Molden, WFN and WFX — what each contains and what is read |
| [Spectra](docs/guide/spectra.md) | Reading a JCAMP-DX file, and the overlay on computed sticks |
| [Converters](docs/guide/converters.md) | `ncs convert`: extxyz, xyz, SDF, JCAMP-DX, Molden, and the deck exporters |
| [Projects and runs on disk](docs/guide/project-files.md) | `.ncs` file, run folders, provenance |
| [Appearance](docs/guide/appearance.md) | The three themes, what a theme may change, the font bundle |
| [Headless CLI](docs/guide/cli.md) | Every `ncs` command and its exit codes |
| [Output corpus](docs/guide/parser-corpus.md) | The real engine logs the parsers are tested against, and the gaps |
| [Troubleshooting](docs/guide/troubleshooting.md) | Symptom → cause → action |
| [FAQ](docs/guide/faq.md) | Short answers |
| [Privacy and licensing](docs/guide/privacy-and-licensing.md) | What leaves the machine, and what the licence grants |
| [Changelog](CHANGELOG.md) | What each release contains, and what is still unreleased |

Normative references: [`docs/PROJECT-FORMAT.md`](docs/PROJECT-FORMAT.md) (the `.ncs` document and the
on-disk layout), [`docs/adr/0001-block-taxonomy.md`](docs/adr/0001-block-taxonomy.md) (the six data
stages behind `schemaVersion: 3`), [`docs/SCRIPTING.md`](docs/SCRIPTING.md) (run-record v2, `ncs
export`, the Python client), [`docs/ENGINE_PLUGIN.md`](docs/ENGINE_PLUGIN.md) (the `registerEngine`
contract), [`docs/CLUSTER_EXPORT.md`](docs/CLUSTER_EXPORT.md) (SLURM/PBS export),
[`docs/THEME_ENGINE.md`](docs/THEME_ENGINE.md) (the token contract and the three themes),
[`docs/REPORT_GENERATOR.md`](docs/REPORT_GENERATOR.md) (the workflow report),
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) (phased plan).

## Requirements

- **App:** Windows 10/11 x64, or a modern Linux x64 distribution. macOS runs from source; there is no
  packaged macOS build.
- **Real Gaussian run:** a licensed Gaussian 16 installation on the same machine and operating
  system. Windows uses the console `g16.exe`; Linux and macOS use `g16` with Link 1 (`l1`) beside
  it. A Windows licence does not authorise a Linux binary and may not be used under WSL.
- **Real xTB run:** an `xtb` executable (`xtb.exe` on Windows) plus its `share/xtb` parameters, or
  `XTBPATH` pointing at them. No licence file.
- **Real ORCA run:** ORCA 5 or 6 installed in one directory, with the `orca` driver
  (`orca.exe` on Windows) selected by its full path — ORCA's parallel driver must be called by
  full pathname, and preflight warns when it is not. Free for academic use; you accept ORCA's
  licence yourself.
- **Real Psi4 run:** Psi4 1.4 or newer with a `psi4` executable and `PSIDATADIR` set (a conda
  install does both). DDX solvation additionally needs the `pyddx` addon in the same environment,
  which Psi4 does not ship.
- **Real PySCF run:** PySCF 2.x in a Python 3.9+ environment (`pip install pyscf geometric`; conda
  works too), selected by its interpreter path rather than a bare `python3`. A bare `python3` is
  accepted and resolved against `PATH`. CASSCF needs the active space declared on the block; PCM,
  C-PCM and TD-DFT need no extra package.
- **Sidecars (all optional):** CREST (`crest`) for a GFN conformer search, Open Babel 3 (`obabel`)
  for an MMFF94 search, a Python with `rdkit` for tautomer enumeration, a Python environment with
  `torch` + AIMNet2 weights for the ML scorer, a Python with `cclib` for a foreign log, and a
  **Multiwfn 3.8** binary for the Analyse block. Each is pointed at from the run console or Settings;
  none is bundled, and a missing one fails the block by name instead of producing a result.
- **Building from source:** Node.js 22 or newer, npm 10 or newer.

No Gaussian binaries or licence files are included in this repository, in the installer, or in any
release artifact; neither is any xTB, ORCA, Psi4 or PySCF installation, any sidecar, or any model
weight.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite + Electron development loop |
| `npm start` | Electron against `dist/` |
| `npm test` | Vitest unit and runner tests |
| `npm run check` | Syntax-check every shipped module (tree walk over `electron/`, `src/`, `bin/`, `scripts/`) |
| `npm run build` | Vite production renderer build |
| `npm run dist` | Vite build + NSIS installer (run on Windows) |
| `npm run dist:linux` | Vite build + unsigned AppImage (run on Linux) |
| `npm run bundle` | Source hand-off tarball/zip with a checksum manifest |

## Project layout

```
electron/          main process: dialogs, IPC, run manager, queue, engine runners
bin/ncs.js         the headless CLI (`ncs`), one handler per command
src/renderer/      graph canvas, inspector, run console, results and structure views
src/shared/        pure modules: input builders, parsers, schema, control flow, validity
src/shared/engines/ Gaussian 16, xTB, ORCA, Psi4 and PySCF descriptors, capabilities, canonical results
src/shared/interop SMILES reader and the NWChem/GAMESS/Q-Chem deck exporters
schemas/           the run-record JSON Schemas (v1 and v2) and the vendored QCSchema set
scripts/           optional sidecars (tautomer enumerator, AIMNet2 scorer, cclib converter) and the DP4 bank builder
clients/python/    the stdlib-only Python client for `ncs export`
test/              Vitest suites, including the real-output fixture corpus
docs/              documentation; the user guide lives in docs/guide/, decisions in docs/adr/
```

`CHANGELOG.md` records what each release contains.

## Current limitations

- **No real Gaussian run has been recorded by this app.** On 2026-11-08 a peer run executed 25
  cases written by this builder on Gaussian 16 Rev A.03 (Windows) and their logs are now fixtures, so
  the parsers are pinned against real output; the runner and preflight are still covered only by unit
  tests against fake executables, and the Windows acceptance run (GN-001) is only partly met.
- **No real xTB run has been executed by this app's runner.** A real xTB 6.6.1 `--ohess` log is
  committed as a parser fixture (`test/fixtures/real/xtb-6.6.1-water-optfreq/`, captured on xeyve),
  so the parser is pinned against output from a release the app does not ship; the end-to-end suite
  still only runs when `XTB_BIN` points at a real binary.
- **Sidecars are driven, not bundled, and not all have been run here.** CREST argues, ranks and
  fails by name but has not been executed in this checkout; Open Babel 3.2.x is refused before
  spawning, because that series segfaults in `--conformer` and the queue reads `obabel -V` to say
  so by version (#239); the RDKit tautomer enumerator and the AIMNet2 scorer are exercised against
  recorded sidecar answers, not against a live RDKit or torch install. None of the four is required
  for the rest of the app to work.
- **No packaged macOS build.** The runner and preflight support macOS; there is no build to sign or
  test.
- **Cross-engine geometry hand-off is incomplete (#326).** When the upstream block ran on a different
  engine, the next block is rebuilt from that run's parsed final geometry only if it is a **Gaussian
  or PySCF** block. A **Psi4, ORCA or xTB** block keeps the geometry it was planned with — the queue
  task still records a `geometryHandoff` and the workflow report prints it, but `run.json` carries no
  such field — so an xTB pre-optimisation feeding a Psi4 single point computes at the unoptimised
  structure and reports `completed`. Chain onto Gaussian or PySCF until this is fixed.
- **xTB validity checks are narrower than Gaussian's.** xTB has no route, basis or ECP to inspect, so
  the Gaussian-only checks are reported as *not applicable* (never as a pass). Charge/multiplicity,
  geometry sanity, imaginary modes and optimisation convergence are judged for both engines.
- **ROA is read, but only a G09 log is pinned.** The parser handles the three printed
  scattering geometries, their invariants and `RC180`; the fixture is a real Gaussian 09 E.01
  `Freq=ROA` log. No public Gaussian 16 B.01+ ROA log was found, so that revision remains
  unverified and the card does not claim it.
- **No g-tensor is computed.** A log that prints one is imported; a log that says `NO` is refused by
  name rather than filled with the free-electron value, so an EPR card can be missing a field it
  would be wrong to invent.
- **Multiscale scope.** xTB **GFN-FF** is the supported force-field pre-optimisation path: run a
  GFN-FF xTB block, then pass its geometry to a Gaussian/ORCA/Psi4 block through the normal geometry
  edge. **ONIOM result parsing is supported** (extrapolated energy, gridpoint components, layer
  counts and link-atom cuts), but **ONIOM/QM-MM input construction, molecular dynamics,
  docking/QSAR and GAFF-style force-field parameterisation are not implemented** (#67); the app
  does not write a route it cannot run and parse.
- **Join policy `any` still waits for every input.**
- **Validity thresholds are documented choices, not calibrated against real logs.** The parsers are
  checked against committed real output — Gaussian 09 and 16, ORCA 5.0 and 6.1, Psi4 1.11 — including
  truncated and SCF-failed files, and a declared parser branch that no fixture reaches fails CI
  (#176); the thresholds themselves (covalent-radius ratios, spin contamination, imaginary-mode
  floors) remain engineering choices.
- **Periodic systems are out of scope.** No unit cells, k-points, band structures or plane-wave
  engines. A `.cif`, `.poscar`/`.vasp` or `.cell` file is refused with a message saying so, rather
  than being parsed as if its asymmetric unit were a molecule. That decision is closed (#66) and
  would only be revisited alongside a periodic engine backend (#67).
- **One block at a time, several records in parallel.** Blocks run in dependency order, one task at a
  time; records inside one family run up to `runner.maxParallel` concurrently (default 1). There is
  still no scheduler that runs two *blocks* at once, and cluster execution happens by exporting
  scripts, not by submitting them (#64).
- **Unsigned builds.** No auto-update, no crash reporting, no code signing.
- **No remote execution, submission, cloud API or telemetry.** This is intentional.

## Collaboration model

NodeChem Studio is **single-user and local**: no accounts, no server, no shared store. A project is
one `.ncs` file, and the app refuses to overwrite a file that changed on disk since it was opened
(hash check, with a message telling you to reopen or save under a new name). A name that already
ends in `.ncs` keeps that one suffix rather than gaining a second, saving over a file this session
did not open asks first, and the next save dialog opens in the folder the last save used.

Two people *can* work on the same project on a shared drive, reconciled rather than live-synced:

```
ncs diff theirs.ncs mine.ncs
ncs merge base.ncs mine.ncs theirs.ncs --out merged.ncs
```

The merge is structural, keyed by block id: edits to different blocks or different fields merge, and
overlapping edits are refused with a per-field conflict report (exit 5) instead of a silent
last-write-wins. See [Headless CLI](docs/guide/cli.md#collaborating-on-a-project).

## Safety and licensing

NodeChem Studio is free software under the **Apache License 2.0** (see [`LICENSE`](LICENSE)). That
licence covers this repository's code and documentation; it does not grant any right to
Gaussian, which is licensed separately by Gaussian, Inc.

- Gaussian is commercial and platform-bound. This project only drives an installation you are
  licensed to use on that machine.
- xTB is LGPL and, like Gaussian, is not bundled — you install it yourself.
- ORCA is free of charge for academic use under FACCTs' own terms, which you accept yourself; no
  ORCA binary, licence file or source is shipped here.
- Psi4 is LGPL-3.0 and not bundled. The DDX solvation addon (`pyddx`) is installed separately.
- Sidecars and model weights — CREST, Open Babel, RDKit, AIMNet2 — keep their own licences and are
  not redistributed.
- Dry run is the default. It produces a file headed `FIXTURE OUTPUT` and never claims to be a
  calculation.
- Run records stay under Electron's `userData` directory. No run data is uploaded.

Full detail: [Privacy and licensing](docs/guide/privacy-and-licensing.md).

## Contributing

Bug reports, corrected documentation and pull requests are welcome. Read
[`CONTRIBUTING.md`](CONTRIBUTING.md) first — it covers the build, the test gate and the rules that
keep the fixture/real-run distinction intact. Security reports go through
[`SECURITY.md`](SECURITY.md), not a public issue.

When you report a run problem, attach the run folder
(`%APPDATA%\nodechem-studio\runs\<runId>` on Windows, `~/.config/nodechem-studio/runs/<runId>` on
Linux) zipped, minus anything you are not licensed to share. The exact input, output and `run.json`
are what make a defect reproducible.

## Licence

[Apache License 2.0](LICENSE). Gaussian 16 is licensed separately by Gaussian, Inc.; nothing here
grants rights to it.
