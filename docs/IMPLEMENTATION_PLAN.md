# NodeChem Studio — implementation plan

Status: **0.3 feature set implemented; 0.3.0 not yet tagged.** Sections 1–3 and 5 describe the
architecture and the original phase plan; §4 is the v0.1 baseline kept for history, §4b lists what
landed since, and §6b is what remains after 0.3. The only unverified gate is still **GN-001**, a real
licensed Gaussian run (see §6).

## 1. Product target

A desktop application for Windows, Linux and macOS, installed on a machine that has a licensed
Gaussian 16 installation, that lets a computational chemist build a Gaussian workflow as a graph and
run it locally end to end.

Success at v1:

1. Build a project entirely in the node view.
2. Configure every job parameter without leaving the graph.
3. Run the graph in dependency order with a durable queue.
4. Evaluate gates from parsed output, never from exit codes.
5. Hand off checkpoint files only along explicit checkpoint edges.
6. Stop, resume, and recover after a crash without losing run history.
7. Work offline. No remote execution, no cloud dependency, no telemetry.

## 1b. Scope decisions

| Question | Decision | Why |
| --- | --- | --- |
| Periodic systems (CIF/PBC, k-points, bands/DOS, plane-wave engines) | **Out of scope** for the 0.2–0.3 line, decided 2026-11-08 | The product is a graph over molecular Gaussian and xTB jobs. A unit cell needs a different engine, a different result model (k-points, band paths) and a different parser; half-supporting it would produce wrong answers. A `.cif` (or POSCAR/VASP/cell) import is refused by name with a specific message, and the limitation is listed in the README. |

## 2. Hard constraints

| Constraint | Consequence |
| --- | --- |
| Gaussian is licensed per machine and platform | The runner executes only against a local installation on the same operating system. Never copy Gaussian, bundle it, or move a licence between platforms — a Windows licence may not be used under WSL. |
| `g16.exe` is the Windows console runner; `g16` is the Linux/macOS one. `g16w.exe` is the Windows GUI | Spawn the console runner with an argument array, `windowsHide`, no shell. Preflight accepts only the platform's console name and its Link 1 (`l1.exe`/`l1`). |
| `GAUSS_EXEDIR` must point at the install | Resolve the selected executable (including a POSIX symlink) to its installation directory and set `GAUSS_EXEDIR` to that directory per child process; also prepend it to `PATH`. Never hard-code `C:\G16W`. |
| Gaussian scratch uses a shared-memory scratch directory | Use a per-run scratch folder or a user-configured `GAUSS_SCRDIR`; never share a scratch directory between concurrent runs. |
| Gaussian can return exit code 0 after an error termination | Parse the output for `Normal termination` / `Error termination`; gates decide status. |
| A desktop app cannot survive sleep/reboot mid-run | Persist the queue and reconcile orphaned runs on startup; do not pretend a killed process completed. |
| Some parameters are route-level and some are link-level | The builder owns the ordering: Link 0, route, blank line, title, blank line, charge/multiplicity, geometry, optional Link 1. |

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Electron main process                                       │
│  • window + native dialogs                                  │
│  • IPC validation                                           │
│  • RunManager: queue, run folders, child lifecycle          │
│  • GaussianRunner: spawn g16/g16.exe, tail .out, cancel tree│
└───────────────┬─────────────────────────────────────────────┘
                │ contextBridge (preload.cjs)
┌───────────────▼─────────────────────────────────────────────┐
│ Renderer (Vite, no Node integration)                        │
│  • node graph + inspector + palette + run console           │
│  • builds input via src/shared/gaussianInput.js             │
│  • renders parsed output and gates                          │
└─────────────────────────────────────────────────────────────┘
                │ pure functions, no Electron
┌───────────────▼─────────────────────────────────────────────┐
│ Shared domain layer                                         │
│  • gaussianInput.js: deterministic .gjf                     │
│  • gaussianOutput.js: parser + gates                        │
│  • thermochemistry.js: quasi-RRHO + standard-state lines    │
│  • fixtureOutput.js: labelled dry-run fixture               │
└─────────────────────────────────────────────────────────────┘
```

### Why Electron

Since v0.2 the main process also hosts `xtbRunner` (same contract, different engine), the durable
queue with conditions, loops and checkpoint staging, and the report/export writers; `bin/ncs.js`
reuses `buildWorkflowTasks` and `RunManager` so a headless run and a UI run cannot diverge.

- The existing design is HTML/CSS/JS; Chromium gives one rendering target on Windows.
- Node's `child_process` is the runner, native dialogs are straightforward, and packaging is
  well understood.
- Tauri 2 is a later option if installer size or WebView2 policy becomes a problem. The shared
  domain layer and most of the UI are portable.

### Process and data boundaries

- The renderer never touches `child_process`, `fs`, or the network. It sends a validated run
  request over IPC and receives append-only output events.
- A run folder is the durable unit:

```
<userData>/runs/<runId>/
  run.json        immutable record with status, exit code, parsed data, gates,
                  input/output sha256, Gaussian banner, app version/commit and
                  the normalised method block (provenance manifest)
  request.json    request metadata (no full input duplicate)
  <task>.gjf      exact input handed to Gaussian
  <task>.out      raw stdout/stderr or Gaussian output file
  scratch/        GAUSS_SCRDIR for this run
```

- `runId` is generated by the app, never by the renderer. Input and output basenames are
  restricted to safe `[A-Za-z0-9._-]` names.
- The renderer is untrusted for path purposes: it can propose a basename, but the main process
  validates it and joins it under the run directory.

## 4. What existed at v0.1 (historical baseline)

| Area | Implemented | Evidence |
| --- | --- | --- |
| Node-first shell | Full-bleed canvas, palette, contextual inspector, wide inspector, drawers | renderer loads at 1440×900; 7 seeded nodes / 7 edges |
| Graph editing | Add, select, drag, connect, rewire, delete, duplicate, zoom, fit | UI smoke tests; graph state round-trips |
| Parameter parity | Route, SCF, optimization, frequency gates, population, IRC, scan, fragments, resources, checkpoint | inspector groups; wide mode |
| `.gjf` builder | Link 0, route, title, charge/multiplicity, Cartesian coordinates, checkpoint hand-off | `test/gaussianInput.test.js` |
| Output parser | termination, SCF, optimization, frequencies, imaginary modes, the complete thermochemistry block, final correlated energy | `test/gaussianOutput.test.js` |
| Thermochemistry corrections | full thermo block components, quasi-RRHO (Grimme, exposed cutoff) and 1 atm → 1 M standard state as separate toggleable lines | `test/thermochemistry.test.js` |
| Gate evaluator | output completeness, SCF, optimization, frequency, imaginary count/magnitude, thermochemistry | same suite |
| Local runner | spawn the console runner (`g16.exe` on Windows, `g16` on Linux/macOS), platform preflight, tail output, cancel tree, run folder, dry run | `test/preflight.test.js`, `test/runManager.test.js` |
| Durable queue | persisted queue, stable topological order, one task at a time, crash reconciliation, pause/resume/cancel-all | `test/queue.test.js`, `test/workflowGraph.test.js` |
| Checkpoint staging | copies only along checkpoint edges; missing/empty `.chk` fails with a recorded reason; labelled fixture in dry runs | `test/checkpoint.test.js`, `test/queue.test.js` |
| Control flow | safe condition expressions, one-branch release, loop retry/exhaustion, review never auto-passes | `test/controlFlow.test.js`, `test/queue.test.js` |
| Output discovery | finds `<input>.out` or `<input>.log`, records `outputFile`/`outputSource`, prefers a terminated file | `test/outputDiscovery.test.js`, `test/runManager.test.js` |
| Final energy gate | post-HF (`CCSD(T)`, `E(CORR)`, MP2…) or SCF fallback, evaluated as a gate | `test/gaussianOutput.test.js` |
| Validity checks | charge/multiplicity parity, spin contamination vs S(S+1), covalent-radius geometry sanity, TS/minimum imaginary modes, basis/ECP and dispersion compatibility, optimisation-before-Freq; pre-run and post-run, individually disableable | `test/validityChecks.test.js` |
| Structure import | `.xyz`, `.mol`/`.sdf`, `.mol2`, `.pdb`/`.pdbqt`, `.cjson`, `.gjf`/`.com` and Gaussian logs with element/coordinate/parity validation; project-level geometry feeds every `.gjf` | `test/structureImport.test.js`, `test/structureFormats.test.js`, `test/structureCorpus.test.js`, `test/projectSchema.test.js`, `test/gaussianInput.test.js` |
| Dry run | labelled synthetic output, full parser/gate path | run console PASS evidence |
| Persistence | native Open/Save, schema v1 validation, v0.1 migration, canonical save | `test/projectSchema.test.js` |
| Packaging | electron-builder NSIS config; `npm run dist` produces `release/nodechem-studio-0.3.0-x64.exe`; CI workflow builds it on windows-latest. Linux AppImage target plus a `Linux package` CI workflow | `.github/workflows/windows-package.yml`, `.github/workflows/linux-package.yml`, `package.json` |

### Verified gaps

- The graph is seeded with a Diels–Alder demo; the runner uses demo water until a structure is
  imported in the molecule drawer. Structure import is implemented (GN-006).
- The queue runs calculation blocks in dependency order and survives a restart. Conditions
  release one branch, loops retry up to `maxAttempts`, review gates stop dependents; output
  bundles are still unimplemented (see §6b).
- Merge waits for all inputs (the `any` policy is recorded but readiness is still all-inputs);
  output nodes stop with a recorded reason until bundling exists.
- Output discovery and final-energy parsing are implemented (GN-007); heavy logs are read as a
  1 MiB head window plus a 31 MiB tail window, and a truncated parse records `parsed.complete:
  false` with the byte ranges read and cannot pass the gates.
- Project loading validates `schemaVersion: 1` and rejects malformed files before render; queue
  state is persisted, but the canvas still shows its own node states rather than live queue
  status.
- No Windows/Gaussian smoke test yet. The UI and dry-run path are exercised on Linux; the
  main-process runner is covered by Vitest, but real Gaussian execution is untested.
- No real Linux or macOS Gaussian run yet. Platform handling (executable and Link 1 names, POSIX
  executable bit, symlink-resolved `GAUSS_EXEDIR`, scratch warnings) is covered by unit tests
  against fake executables only.
- Validity thresholds (covalent-radius ratios, spin-contamination limits, imaginary-mode
  floors) are documented offline choices. The parser is now pinned by a corpus of twenty real
  Gaussian 09/16 outputs (§4b), but the thresholds themselves have not been calibrated against a
  licensed run; GN-001 remains the gate.
- The NSIS installer exists and CI builds it; it is unsigned and has not been installed on a
  clean Windows VM. No auto-update or crash reporting.

## 4b. What landed after v0.1 — the 0.2 and 0.3 lines

Everything below is implemented and covered by Vitest; none of it has been exercised against a
licensed Gaussian installation (GN-001).

| Area | What landed | Evidence |
| --- | --- | --- |
| Visual identity (#52) | One token contract, three themes (`current`, `graphite`, `paper`), pre-paint boot script, self-hosted IBM Plex with its OFL notice, fixed type scale | `src/renderer/themes/`, `public/theme-boot.js`, `src/renderer/fonts.css`, `docs/THEME_ENGINE.md`, `test/theme.test.js` |
| Editing safety (#56, #74) | Undo/redo for every graph mutation; structural diff, three-way merge keyed by block id, and a save guard for shared `.ncs` files; comparison of any two finished runs | `editHistory.js`, `projectMerge.js`, `runCompare.js`, `test/editHistory.test.js`, `test/projectMerge.test.js`, `test/runCompare.test.js` |
| Drafts and templates | Debounced recovery draft offered at startup, save-before-close dialog, three workflow templates plus a blank project, `examples/` | `draft.js`, `templates.js`, `examples/`, `test/draft.test.js`, `test/templates.test.js` |
| Per-block engines (#63) | A block may name its own engine; cross-engine geometry hand-off with explicit refusals; engine-owned provenance | `engineSettings.js`, `electron/runner/geometryHandoff.js`, `test/multiEngine.test.js`, `test/geometryHandoff.test.js` |
| Excited states (#60, #75) | TD-DFT route and parser, simulated UV-Vis with stated broadening, NTOs, emission template and `Root`, ECD rotatory strengths | `test/tddft.test.js`, `test/ecd.test.js`, `test/wavefunctionStability.test.js` |
| NMR and Raman (#61, #76) | Shielding parser, NMR job type and spectrum card; Raman activities, simulated spectrum and measured-CSV overlay | `nmr.js`, `raman.js`, `overlay.js`, `test/nmr.test.js`, `test/raman.test.js`, `test/overlay.test.js` |
| Reaction energetics (#62) | IRC path gate and plot, scan extremum and surface, barrier with the level of theory stated, ΔG‡ from a declared reactant, pKa cycle | `reactionPath.js`, `test/reactionEnergetics.test.js`, `test/reactionPath.test.js` |
| Thermochemistry (#70) | RRHO at any T and p pinned to Gaussian's own table, workbench card with sweeps, term switches, CSV export and conformer ensembles | `thermoSweep.js`, `test/thermochemistry.test.js`, `test/thermoWorkbench.test.js` |
| Method ladders and ECP (#26, #68) | Ladder blocks with one spread gate per group and a spread table; GenECP routes with bundled SDD and def2-SVP ECP data, iodine, and a refusing check | `methodLadder.js`, `ecp.js`, `ecpData.js`, `test/methodLadder.test.js`, `test/ecp.test.js` |
| Spin states and dispersion (#69) | Spin-state sweeps, `Stable=Opt` gate, D4 with a revision floor | `spinSweep.js`, `dispersion.js`, `test/spinSweep.test.js`, `test/dispersion.test.js` |
| xTB parity (#72) | xTB records judged by the checks that apply to them, the rest reported as not applicable | `validityChecks.js`, `test/validityChecks.test.js` |
| Reporting (#53) | One self-contained `report.html` plus `report.json` per finished queue; graph laid out from queue edges, gates copied not recomputed | `workflowReport.js`, `docs/REPORT_GENERATOR.md`, `test/workflowReport.test.js` |
| Export and CLI (#65, #73) | Dataset CSV/JSON with a versioned envelope; `ncs validate`, `build-input`, `run`, `diff`, `merge` built on the app's own task builder | `datasetExport.js`, `bin/ncs.js`, `test/datasetExport.test.js`, `test/cli.test.js` |
| Viewer (#71) | Normal-mode animation from real displacement blocks, optimisation trajectory replay, Kabsch/Horn superposition with RMSD, SVG figure export | `normalModes.js`, `trajectory.js`, `superpose.js`, `superpositionCard.js` + tests |
| Import and corpus (#27, #28) | Batch indexing of a folder of Gaussian and xTB logs; a golden corpus of twenty real Gaussian 09/16 logs including truncated and SCF-failed cases | `logImport.js`, `test/fixtures/real/`, `test/realCorpus.test.js` |
| Diagnostics and failure explanations (#55) | One-click redacted diagnostics bundle; offline signature table for known engine failures | `diagnostics.js`, `errorSignatures.js`, `test/diagnostics.test.js`, `test/errorSignatures.test.js` |
| Conformer and protomer ensembles (#30) | A Structure block runs CREST (GFN2/GFN-FF) or imports a multi-XYZ, ranks by energy, prunes by window and RMSD, computes Boltzmann populations, refuses an automatic protomer choice, carries the chosen member into downstream inputs and into `run.json` | `conformers.js`, `electron/runner/crestRunner.js`, `test/conformers.test.js`, `test/conformerWorkflow.test.js` |

## 5. Delivery phases

### Phase 0 — Environment and skeleton (done)

- Standalone project, npm scripts, Vite build, Vitest, Electron dependency.
- Shared input/output/fixture modules with tests.
- Renderer loaded from the node-first shell.
- Acceptance: `npm test`, `npm run check`, and `npm run build` pass.

### Phase 1 — Node-first UI and single-task real runner (v0.1, current)

- Graph editing and full inspector.
- One selected calculation can be built and run.
- Dry run and real run share the same parser/gate path.
- Acceptance: on a licensed Windows machine, a dry run passes; a small licensed job produces a run
  folder with a parsed normal termination and gates.
- **GN-001 is the gate for calling v0.1 done.**

### Phase 2 — Project model and safe persistence (done)

- Define a versioned project schema (`schemaVersion: 1`) with explicit validation for nodes,
  edges, settings, molecule, graph coordinates, and run gates.
- Migrate loose v0.1 projects; reject unknown future versions with a clear message.
- Add schema tests and a round-trip test for every node kind.
- Acceptance: malformed project files are rejected before render; a saved project reopens
  byte-stable apart from formatting.

### Phase 3 — Durable queue and DAG execution

- Replace the single-run `RunManager` with a queue that persists `queued/running/completed/
  failed/cancelled/needs-review` transitions.
- Scheduler: stable topological order, one Gaussian process at a time by default.
- Before a dependent task starts, copy the upstream checkpoint to the task's `%OldChk` path
  only when a checkpoint edge exists; never infer it from node order. Add `Geom=Check` and
  `Guess=Read` only when the route does not already set them.
- On app start, mark orphaned `running` records as `interrupted`; never silently resume a
  Gaussian process that no longer exists.
- Add pause/resume, cancel-all, and a run history view.
- Acceptance: a 4-node chain runs unattended; killing the app marks the in-flight task
  interrupted; restart resumes at the next ready task.

### Phase 4 — Conditions, loops, and human review

- Semantics:
  - `condition` evaluates a named gate/field on the upstream result and releases exactly one
    of `true` / `false`.
  - `loop` retries a target up to `maxAttempts` with an explicit backoff and a documented exit
    reason (`passed`, `exhausted`, `cancelled`).
  - A `review` gate stops the graph and waits for a human decision; it never auto-passes.
- Persist branch decisions and attempt counts in `run.json`.
- Acceptance: a failing frequency gate routes to the retry loop; an exhausted loop stops with
  a recorded reason; a review gate blocks dependents.

### Phase 5 — Structure and chemistry fidelity

- Native structure import: `.xyz`, `.mol`, `.sdf`, `.mol2`, `.pdb`/`.pdbqt`, `.cjson`, `.gjf`, `.com`, Gaussian `.log`; validate element symbols,
  atom counts, charge/multiplicity parity, and fragment definitions.
- Validity checks (issue #25, done): electron-count parity, spin contamination against
  S(S+1), covalent-radius geometry sanity, stationarity (one imaginary mode for a TS,
  none for a minimum), basis/ECP and dispersion compatibility, and optimisation
  convergence before a downstream `Freq` may claim a minimum. Each check is a pure
  function returning `{ id, status, message, evidence }`, can be disabled per block
  (`settings.disabledChecks`), runs in project validation (blocking only where a run
  would be meaningless) and in gate evaluation (`gates.validity`, non-blocking).
- Project-level molecule editor; per-node overrides only where Gaussian permits them.
- Route registry with an allow-list and warnings for unknown tokens.
- Geometry source recorded in the provenance manifest for every run.
- Acceptance: imported water and benzene produce byte-deterministic inputs; a bad fragment
  total is rejected with a specific message.

### Phase 6 — Packaging and operations

- Windows installer (electron-builder or Forge), code signing if a certificate exists.
- Linux AppImage target (unsigned), built by CI on `ubuntu-latest`; macOS only where a signing
  identity and a licensed macOS installation exist.
- App version and commit in the About panel and every `run.json`.
- Log rotation and a “open run folder” action.
- Crash-safe queue reconciliation test.
- Acceptance: clean Windows VM installs, dry-runs, and runs a small job without Node installed.

## 6. Task queue

Each task is intentionally small enough for one branch and one review. Use the ID in the branch
and PR title. A task is not done until its acceptance evidence is in the PR.

| ID | Task | Files | Acceptance |
| --- | --- | --- | --- |
| **GN-001** | Windows smoke test of the v0.1 runner | none (report) | `npm test` green; dry run PASS; real small job produces `run.json` with parsed termination; screenshot of run console |
| **GN-002** | Versioned project schema + validation — **implemented** (`src/shared/projectSchema.js`, 44 tests) | `src/shared/projectSchema.js`, `test/projectSchema.test.js`, `electron/main.js` | Invalid project rejected before render; valid project round-trips; tests |
| **GN-003** | Durable queue + topological scheduler — **implemented** (`electron/runner/queue.js`, `src/shared/workflowGraph.js`) | `electron/runner/queue.js`, `runManager.js`, tests | 4-node chain; kill/restart marks interrupted and resumes ready work |
| **GN-004** | Checkpoint staging between tasks — **implemented** (`electron/runner/checkpoint.js`) | `runManager.js`, `gaussianInput.js`, tests | Only checkpoint edges copy `.chk`; missing/corrupt checkpoint fails with a recorded reason |
| **GN-005** | Condition and loop runtime — **implemented** (`src/shared/controlFlow.js`) | `src/shared/controlFlow.js`, scheduler, UI state, tests | Failing gate takes the false branch; retry exhausts; review blocks |
| **GN-006** | Structure import — **implemented** (`src/shared/structureImport.js`, molecule drawer) | `src/shared/structureImport.js`, molecule drawer, tests | `.xyz`, `.mol`, `.sdf` import; bad data rejected |
| **GN-007** | Output file discovery and parser hardening — **implemented** (`electron/runner/outputDiscovery.js`, final energy) | `gaussianRunner.js`, `gaussianOutput.js`, tests | Handles `<input>.out` and `<input>.log`; reports which file was parsed; error termination never passes |
| **GN-008** | Windows packaging — **implemented** (electron-builder NSIS + `windows-package` CI workflow) | `electron-builder` config, `scripts/`, docs | Installer on clean VM; no Node required; dry run works |
| **GN-009** | Validity checks (issue #25) — **implemented** (`src/shared/validityChecks.js`) | `projectSchema.js`, `gaussianOutput.js`, `runManager.js`, `queue.js`, `app.js`, `test/validityChecks.test.js` | Each check has pass/fail fixtures; disabling removes it; `run.json` reports `gates.validity` |

Priority: **GN-001 remains the only unverified gate** (real Windows + licensed Gaussian). GN-002
through GN-009 are implemented and CI-tested on Linux; the Windows installer is built by the
`Windows package` workflow but has not been installed on a clean VM. The Linux AppImage is built by
the `Linux package` workflow but has not been installed on a clean Linux machine, and no real
Linux/macOS Gaussian job has been run.

## 6b. After 0.3

| Item | Status | Where |
| --- | --- | --- |
| Tag and publish 0.3.0 | Release prep: version bump, README/plan refresh, release notes, tag → the two package workflows build the artifacts | `package.json`, `.github/workflows/*-package.yml` |
| GN-001 (real licensed Gaussian run) | **Open** — needs Xavier's Windows machine and licence | §6 |
| Output bundle block | **Open** — an output node stops the queue with a recorded reason; per-run export exists instead | `electron/runner/queue.js` |
| Join policy `any` | **Open** — `any` is recorded but readiness still waits for all inputs | `electron/runner/queue.js` |
| Live queue status on the canvas | **Open** — node cards show project state; the queue panel shows task state | `src/renderer/app.js` |
| macOS package | **Open** — runner supports macOS; there is no build to sign or test | §5 Phase 6 |
| Code signing | **Open** — no certificate; both installers are unsigned | §5 Phase 6 |
| Conformer fan-out into sibling calculations (#80) | **Shipped after 0.3** — one task per retained member, member-paired edges and checkpoints, per-member `run.json`, report grouping. A single run fed by several fanned-out branches is refused (#86). Propagating the fan through a chain (#87) is open | §4b, `src/shared/workflowTasks.js` |
| Engine abstraction + ORCA (#31) | **Partly shipped** — engine interface, ORCA input builder, log parser and preflight are in; ORCA execution needs a stdout-capturing runner (#93), and validity/renderer copy still assume Gaussian | `src/shared/engines/` |
| Molecular builder (#58) | Backlog, no milestone yet | GitHub issue |
| Wavefunction analysis (#59) | **Ingest half shipped** — cube and fchk parsers, derived values, export columns; orbital rendering, QTAIM, NCI and the attach flow remain | `src/shared/wavefunction.js` |
| Composite methods and counterpoise (#77) | **Shipped** — composite job types with a gate that refuses a component energy, counterpoise/BSSE, docs; per-link expansion is not implemented | `src/shared/gaussianOutput.js` |
| Multiscale QM/MM, MD and docking (#67) | **On hold by decision** (2026-11-08) — not scoped or scheduled; the issue stays open | GitHub issue |
| HPC submit/monitor (#64) | **Deferred by decision** (2026-11-08) — no cluster work until the local workflow is settled; cluster export remains the supported path | GitHub issue |
| Release verification (checksums, SBOM, provenance) and the update notice | **Shipped after 0.3** — `src/shared/updateCheck.js`, `scripts/release-assets.mjs`; the workflow steps only run on the next tag | §5 Phase 3, `docs/guide/install.md` |
| VCD/ROA (#78) | **Blocked on data** — needs one real Gaussian `Freq=(VCD)` log to write the parser against | GitHub issue |

## 7. Risks and open questions

| Risk | Mitigation / owner |
| --- | --- |
| Licence does not permit other users or remote access | Confirm with the licence holder before any real run. Record the answer in the project notes, not in code. |
| `C:\G16W\g16.exe` is not the actual path | Preflight + Browse; never hard-code any platform's path. Preflight validates the selected executable's own directory, resolving a POSIX symlink, and reports the `GAUSS_EXEDIR` it will set. GN-001 records the real Windows path. |
| Scratch path spaces break scratch/chk | Prefer `C:\G16W\SCRATCH` or `/scratch/$USER`; preflight warns on spaces on every platform and on NFS/SMB-looking Linux/macOS paths, and never rewrites the path. |
| Gaussian leaves child processes after cancel | `taskkill /T /F` on Windows; verify no `l1.exe`/`g16.exe` remains. |
| Exit code 0 on error termination | Parser/gates are authoritative; add tests for error termination with code 0. |
| Sleep/reboot mid-run | Persist queue; mark orphans interrupted; no fake completion. |
| Large logs exhaust renderer memory | Tail is capped; the final parse reads a 1 MiB head plus a 31 MiB tail window and gates a partial parse as unknown. |
| Demo geometry misleads users | Fixture and demo-water are labelled in the UI and README; GN-006 removes the demo path. |
| Electron cannot be tested in this container | Windows smoke is GN-001; this container already verifies renderer in Chromium and runner in Vitest. |

## 8. Definition of done for v1

- A clean Windows install runs from an installer, not a source checkout.
- The app opens a project, builds a DAG, and runs it locally with no remote calls.
- Every task has a durable run record and a parsed termination.
- Gates are evaluated from output; a failure stops dependents unless a condition/loop says
  otherwise.
- Checkpoint hand-offs are explicit and verified.
- The UI remains node-first: parameters never force a permanent side form.
- `npm test`, `npm run check`, and `npm run build` are green on the branch being reviewed.
- GN-001 is signed off by the licence holder and the change has been reviewed.
