# Gaussian Node Studio

A local-first desktop workspace for Gaussian 16. The graph is the primary surface: every
calculation, condition, loop, merge, and output is a node; parameters live in a contextual
inspector that never hides the canvas.

This is a **new, standalone codebase**. It is not the `xharl/GaussianHelper` web app and it
does not import that app's UI. The pure-JavaScript Gaussian input/output logic is intentionally
small enough to be reviewed and ported independently.

## Status: v0.1 local runner slice

What works today:

- Electron + Vite shell with the node-first UI.
- Add/select/drag nodes, connect ports, rewire, zoom, pan, validate.
- Per-node inspector covering the route, SCF, optimization, frequency gates, population, IRC,
  scan, fragments, resources, and checkpoint fields.
- **One selected calculation** can be built into a Gaussian `.gjf` and run locally, or the whole
  workflow can be queued: calculation blocks run in dependency order, one at a time, with a
  durable queue that survives an app restart.
- Condition nodes evaluate a small, safe expression over the upstream parsed result
  (`imaginaryCount == 1 and abs(nu) >= 50`) and release exactly one branch; loops retry their
  target up to `maxAttempts` with a recorded exit reason; a gate that cannot be judged stops the
  branch for human review — it never auto-passes.
- Checkpoint hand-offs add `%OldChk` **and** `Geom=Check Guess=Read` to the route, and the queue
  copies the upstream `.chk` into the downstream run folder before the process starts. A missing
  or empty checkpoint fails that task with a recorded reason instead of running without it.
- Local runner writes an immutable run folder (`run.json`, input, output, scratch).
- Output parser detects termination, SCF, optimization, frequencies/imaginary modes,
  thermochemistry and the final correlated energy; gates are evaluated from the output, never
  from the exit code. The runner discovers whether Gaussian wrote `<input>.out` or `.log` and
  records which file it parsed.
- **Dry run** writes a labelled synthetic log, so the full UI and gate path can be tested
  without a Gaussian licence.
- Native project Open/Save through Electron dialogs. Files carry `schemaVersion: 1`,
  are validated before anything renders, and unversioned v0.1 files migrate on open.

What is deliberately not in v0.1:

- Automatic DAG execution is limited to the queue: one Gaussian process at a time, no
  concurrent local jobs.
- Merge `any` policy is recorded but readiness still waits for every input.
- Output bundling; output nodes stop the queue with a recorded reason.
- Native `.mol`/`.sdf`/`.xyz` parsing; the runner currently uses a small demo water geometry.
- Installer and code signing.
- Any remote execution, job submission, telemetry, or network call.

## Requirements

- Node.js 22 or newer (Node 26 is fine).
- npm 10 or newer.
- For a real run: a licensed Gaussian 16W installation on the **same Windows PC**. The console
  executable is normally `C:\G16W\g16.exe`; `g16w.exe` is the GUI and is not used.
- No Gaussian binaries, licence files, or scratch data are included in this repository or in
  the hand-off bundle.

## Quick start

```bash
npm install
npm test
npm run dev
```

`npm run dev` starts Vite on `127.0.0.1:5173` and then Electron. The Electron window loads the
renderer from the dev server.

Production-style preview from the built files:

```bash
npm run build
npm start
```

`npm start` opens Electron against `dist/index.html`. It does not start Vite.

## First run on a new machine

1. Start with **Dry run** checked (the default).
2. Select a calculation node, for example **Reactant frequency**.
3. Open **Run** in the top bar.
4. Leave the executable blank; the dry run does not need it.
5. Click **Run selected block**.
6. Confirm the run console shows `completed` and the gates from the synthetic fixture.

For a real run:

1. Open the run console and click **Browse** next to *Gaussian executable*.
2. Select the licensed console executable, normally `C:\G16W\g16.exe`.
3. Set a scratch directory with no spaces if possible, for example `C:\G16W\SCRATCH`.
4. Click **Preflight**. It checks the executable, Link 1, the run directory, scratch directory,
   platform, and host resources.
5. Uncheck **Dry run** and run a **small** job with the owner's permission.
6. Inspect the generated input and output in the run folder. The app never treats exit code 0
   as proof of success; it reads the Gaussian termination record and gates.

## Project files

A project is a single JSON document. The on-disk format is `schemaVersion: 1`.

- Validation happens in the main process before the renderer receives anything: a malformed
  project is refused with the failing paths instead of half-rendering.
- Files written by v0.1 (no `schemaVersion`) are migrated on open: missing defaults are filled,
  structural problems still fail. The status bar and the dialog report the migration.
- A file from a newer app version is rejected with an explicit message. Never downgrade by
  editing `schemaVersion` by hand.
- Saves are canonical: fixed key order, normalized numbers, trailing newline. Opening and saving
  an unchanged project is byte-stable.
- Limits: 8 MB per file, 2000 nodes, 4000 connections, 64 fragments. Unknown fields are dropped
  on save with a warning.

The schema lives in `src/shared/projectSchema.js`; tests for every node kind, migration, and
rejection case are in `test/projectSchema.test.js`.

## Project layout

```
electron/
  main.js                 app lifecycle, dialogs, IPC, preflight
  preload.cjs             contextBridge API
  runner/
    gaussianRunner.js     spawn + tail one Gaussian process
    runManager.js         run folders, records, dry-run fixture, gates
    queue.js              durable workflow queue + scheduler
    checkpoint.js         checkpoint staging into the downstream run folder
    outputDiscovery.js    finds the .out/.log Gaussian actually wrote
src/
  renderer/
    app.js                node graph, inspector, palette, run console
    styles.css            node-first visual system
  shared/
    gaussianInput.js      deterministic .gjf builder
    gaussianOutput.js     parser + gate evaluator
    projectSchema.js      schema v1, validation, migration, canonical save
    workflowGraph.js      stable topological order + readiness rules
    controlFlow.js        safe condition expression + loop semantics
    fixtureOutput.js      labelled synthetic output for dry runs
test/                     Vitest suites
docs/
  IMPLEMENTATION_PLAN.md  phased plan and task queue
  COLLABORATION.md        working agreement for Will's Hermes
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite + Electron development loop |
| `npm start` | Electron against `dist/` |
| `npm test` | Vitest unit and runner dry-run tests |
| `npm run check` | `node --check` on the Electron and shared modules |
| `npm run build` | Vite production renderer build |
| `npm run bundle` | Build a hand-off tarball/zip with a checksum manifest |

## Safety and licensing

- Gaussian is commercial software. This project only **drives an installation the user is
  licensed to use on that machine**.
- Do not copy a Gaussian installation to another computer, and do not run a Windows licence
  under WSL or a Linux build on a Windows licence.
- Confirm with the licence holder whether other users or remote access are permitted before
  using this app on a shared machine.
- Dry run is deliberately the default. It produces a file headed `FIXTURE OUTPUT` and never
  claims to be a Gaussian result.
- Run records stay under Electron's `userData/runs` directory. No run data is uploaded.

## Collaboration

The hand-off bundle is built for the Hermes instance on Will's Windows machine. See
[`HANDOFF.md`](HANDOFF.md) for the setup and the first task, and
[`docs/COLLABORATION.md`](docs/COLLABORATION.md) for the branch/PR protocol.
