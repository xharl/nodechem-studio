# Headless CLI

`ncs` runs the same code the app runs, without the window. It is for batch work, CI regression runs
and wiring a project into an existing script.

It is not a second implementation. `ncs validate` calls the project validator, `ncs build-input` and
`ncs run` call the same task builder the **Run workflow** button calls, and execution goes through
the same queue and run managers the desktop app uses. A run folder written by `ncs run` is the folder
the app would have written: `run.json`, the input file, the raw output and the gate evidence.

## Install

The CLI needs a Node runtime; nothing else. From a source checkout:

```
npm install
node bin/ncs.js --help
```

When the package is installed with a `bin` entry, the command is simply `ncs`.

## Commands

```
ncs validate <project.ncs> [--json]
ncs build-input <project.ncs> --node <id> [--out <file>]
ncs run <project.ncs> --out <dir> [--dry-run] [--flow <id>] [--record <id>] [--max-parallel N] [--executable <path>] [--crest <path>] [--obabel <path>] [--tautomer <path>] [--tautomer-script <path>] [--multiwfn <path>] [--scorer <path>] [--settings <file>] [--timeout <seconds>] [--json]
ncs report <out-dir> [--flow <id>] [--include-imported] [--figures basic|surfaces|none] [--out <file>]
ncs validation <cases.json> [--run] [--executable <python>] [--work <dir>] [--timeout <seconds>] [--out <file>] [--json]
ncs export <out-dir> [--json] [--schema-version <n>] [--out <file>]
ncs record import --program <name> --version <v> --method <m> --basis <b> --energy <Eh> (--source <file>|--source-sha256 <hex>) --out <out-dir|file.json> [--id <id>] [--title <text>] [--notes <text>] [--json]
ncs qcschema export <run-dir|out-dir> [--run <id>] [--charge <n>] [--multiplicity <n>] [--out <file>] [--json]
ncs qcschema import <file> [--out <file.xyz|file.json>] [--json]
ncs diff <a.ncs> <b.ncs> [--json]
ncs merge <base.ncs> <ours.ncs> <theirs.ncs> --out <file> [--json]
ncs convert <input> --format <extxyz|xyz|sdf|jcamp|molden|cjson> [--spectrum ir|raman|uv] [--from <log>] [--to <cjson>] [--cclib <python>] [--cclib-script <file>] [--node <id>] [--out <file>] [--json]
ncs convert <project.ncs> --node <id> --format <nwchem|gamess|qchem> [--out <file>] [--json]
ncs export-input <project.ncs> --node <id> --engine <nwchem|gamess|qchem> [--out <file>] [--json]
ncs smiles <file|string> [--name <label>] [--out <file.json>] [--json]
ncs cache <run.log|field.cube> --out <file.ncsr> [--precision f64|f32] [--json]
ncs cache <file.ncsr> --inspect [--json]
ncs cube <run-dir|fchk|molden|wfn|wfx> --orbital homo|lumo|n=<i> --out <file.cube> [--units bohr|angstrom] [--grid <angstrom>] [--padding <angstrom>] [--json]
```

- `validate` prints the schema errors, warnings and the pre-run validity findings as JSON when
  `--json` is given or stdout is not a terminal; on a terminal it prints `<file>: valid` or
  `<file>: invalid` and the errors one per line. Every shipped example validates with exit 0. A path
  that is a directory or does not exist is refused with one line — `ncs: cannot read <path>: is a
  directory` or `not found` — and exit 2.
- `build-input` prints the exact input text for one node — the same bytes the queue would write —
  without running anything. Use `--out` to write it to a file.
- `run` queues the workflow, waits for it to finish and prints a JSON summary: the queue status and,
  per task, the run id, the run status, the gate verdict and the run folder. `--flow` selects a flow
  (the project's active flow is the default), `--record` runs one record's subgraph plus the control
  blocks, and `--max-parallel` overrides `runner.maxParallel`. Output blocks write their artifacts
  under `--out` (`reports/…` and `manifest.json`). The external stages take the same paths the run
  console does: `--crest`, `--obabel`, `--tautomer`, `--tautomer-script`, `--multiwfn` and
  **`--scorer`** (the ML scorer sidecar, for `rankBy`, a calculate `provider` or an `aimnet2` relax).
  Each falls back to Settings → Tools when the flag is absent; a block that needs one and has no path
  fails with a sentence naming the tool it wants, and only the scorer refusal also names its flag
  (`CLI: --scorer <path>`). `--settings <file>` reads a settings file other than the platform
  default; a file named explicitly that is missing or invalid is a usage error, while a missing
  default file is normal on a fresh machine.
  **`--timeout` is the watcher's clock, not a task limit.** Without it the command waits as long as
  the queue needs, because each task already has its own budget (`runner.timeoutSeconds` in the
  project, then Settings → Runs, then 3600 s). Passing `--timeout N` stops the wait after N seconds;
  the running block is stopped, its task is recorded `interrupted` and the queue is left `paused`, so
  a later `ncs run` or the app can resume it; the command itself exits 4. The message names the flag,
  the block that was running and — when the project declares one — the value to pass to finish it.
- `report` rebuilds the HTML report from the newest queue of each flow under `<out-dir>/queues/` and
  writes `<out-dir>/reports/index.html` unless `--out` names another file. `--flow` restricts it to
  one flow; without it every flow that has a queue is combined into one document. `--figures
  basic|surfaces|none` picks the figure set (`basic` is the default; `none` reads no cube at all).
  `--include-imported` also prints an imported result's number in the energy columns, labelled; an
  imported record is listed either way, because dropping it would hide the thing it exists to say.
- `validation` reads a case set that records a method ladder (method, basis, energy in hartree, or
  `null` plus a reason) and prints the per-case spread, the aggregate MAE/RMSE and every
  `not computed` rung. `--run` executes any rung whose energy is `null` with PySCF, in its own
  folder under `--work`, using `--executable` or Settings → Engines → PySCF. Every run that fails or
  is refused (missing molecule, unsupported rung engine) stays in the table as `not computed` with
  its reason, and a `liveRuns` array in `--json` names the run folder. Without `--run` the command
  launches no engine, so a recorded table is reproducible offline. The case file itself is never
  rewritten. The case set is refused as a whole when a reference, a rung or the schema version is
  malformed.
- `export` prints every `run.json` under `<out-dir>/runs/` in one versioned envelope, with the
  absolute path of the schema the records were validated against. `--schema-version` defaults to `2`,
  the record version this build writes; `--schema-version 1` still emits the v1 envelope, because the
  v1 schema is kept unchanged beside it. An unknown version is refused with the path of the version
  this build ships. One non-conforming record refuses the whole export instead of returning the
  readable subset. `--out` writes the envelope to a file and prints its path.
- `convert` turns a finished log (`.log`/`.out`), a formatted checkpoint, a structure file (including
  binary ChemDraw `.cdx`) or a saved
  `.ncs` into a format other software reads: `extxyz`, `xyz`, `sdf`, `jcamp`, `molden` or `cjson`.
  `--spectrum` picks the spectrum written from a log (`ir`, `raman` or `uv`, default `ir`); `molden`
  needs the basis and MO coefficients, so it is only offered for a formatted checkpoint. Without
  `--out` the converted text goes to **stdout** and nothing is written: a read-only-looking
  conversion never invents a path beside the input. Notes (which frame, which unit) go to stderr.
  `--node <id>` on a `.ncs` project exports **that block's** structure — the project geometry, or the
  conformer the block chose. An id that does not exist is refused by name with the ids that do
  (exit 2), and a block that carries no structure (`note`, `analyse`, `output`, …) is refused by name
  rather than answered with the project's molecule; `build-input` and `export-input` give the same
  refusal for the same mistake.
  `--format cjson` is the **cclib sidecar**: it converts a foreign NWChem, GAMESS, Q-Chem, Molpro,
  CFOUR or Dalton log to Avogadro Chemical JSON (geometry, charge, final energy and origin) and then
  validates that `.cjson` through the normal importer. `--from`/`--to` are synonyms for the input and
  output paths. It needs a Python interpreter with cclib: set it in **Settings → Tools → cclib**, pass
  `--cclib <python>`, or use `python scripts/ncs_cclib.py convert run.log run.cjson`. cclib is
  user-installed and is not a package dependency; a missing interpreter is exit 4, a truncated log is
  exit 2 with the reason. Gaussian logs are refused here because the native parser is canonical.
  The same command also writes the three **export-only decks**: `--format nwchem`, `gamess` or
  `qchem` on a `.ncs` project plus `--node <id>`. That is the same text `ncs export-input` and the
  window's **Export** menu write, because all three call one function; a structure file is refused
  by name (`a deck needs a block's settings`) rather than given an invented method and basis.
  `--node` selects the block whose structure is converted, for every form: a structure format writes
  that block's geometry, the deck formats write its route plus that geometry. An id that names no
  block is refused with the block list, and a block that carries no structure (`condition`, `loop`,
  `merge`, `output`, `analyse`, `note`) is refused by name rather than falling back to the project
  molecule. Without `--node`, a structure format converts `molecule.coords`.
- `export-input` writes the input one block would be for an engine the app **exports but does not
  run**: `--engine nwchem`, `gamess` or `qchem`. It uses the block's own settings and the project
  geometry, and refuses with a named reason (exit 2, `code: "export-refused"`) anything it cannot
  spell — solvation, TD-DFT, dispersion on GAMESS, a functional outside its table, `Opt Freq` as one
  deck. A project with no geometry is refused as `export-no-geometry` instead of exporting the demo
  water molecule. `ncs convert opt1.nw --format xyz` reads the deck back. See
  [Converters](converters.md#handing-a-job-to-nwchem-gamess-or-q-chem).
- `smiles` reads a SMILES string or a `.smi` file (the argument is a file when it exists, a string
  otherwise) as a bond graph: formula, atom and bond counts, charge, multiplicity, per-atom implicit
  hydrogens. `--json` prints the graph, `--out` writes it. It never writes coordinates, because a
  SMILES string has none — it exits 2 with `code: "smiles-invalid"` and the offending token and
  character position for anything outside the OpenSMILES organic subset it reads.
- `cache <input> --out <file.ncsr>` writes a parsed run or volumetric field as typed arrays, and
  `ncs cache <file.ncsr> --inspect` prints its header (`--precision f64|f32` picks the array width).
  Opening a trajectory then costs what the numbers cost, not what the log's text costs.
- `cube` evaluates one orbital from a formatted checkpoint, Molden, WFN or WFX file — given directly
  or found in a run folder — and writes a Gaussian cube without `cubegen`: `--orbital homo|lumo|n=<i>`
  (1-based, as the file prints them), `--grid` the spacing in Å (default 0.2), `--padding` the margin
  around the molecule (default 3). It prints the orbital energy, the grid actually used (the
  four-million-point cap may coarsen it) and ∫|ψ|² over the box, which is close to 1 but is not
  claimed to be; `--json` carries the same numbers and `--out` is the file to write. A folder with
  two wavefunction candidates is refused rather than guessed. `--units bohr|angstrom` picks what the
  header declares — Å with negative grid counts, the default and what this command has always
  written, or bohr with positive counts, the form `cubegen` itself writes — and only the header
  changes; the values are the ones evaluated either way. See
  [Wavefunctions](wavefunction.md#making-a-cube-without-gaussian).
- `qcschema export` writes one MolSSI `qcschema_output` (`AtomicResult`) from a finished run, in
  atomic units, validated against the vendored published schema; `qcschema import` reads one back
  and can write its structure as XYZ. Refusals exit 2 with a `qcschema-*` code on stderr. The
  fields and units are in [Scripting against NodeChem Studio](../SCRIPTING.md#qcschema-molssi-in-and-out).

## The window, and the commands that stay on the command line

Every subcommand below is in this build, and the table says where to reach it. The
rows marked **CLI only** are a choice, not a gap: they are pipeline-integrity
tools, or they write a document a script consumes, and a dialog would add a step
without adding a capability. Naming them here is what keeps the window from
looking like it forgot them.

This table is checked against the handler table in `bin/ncs.js` by
`test/cliOnlyCommands.test.js`: a subcommand that appears in the CLI and not in
this table fails the suite, so a new CLI-only capability cannot ship undocumented.

| Command | Where it lives | What it is for |
| --- | --- | --- |
| `ncs validate` | window: **Validate** | Schema errors, warnings and pre-run findings. |
| `ncs build-input` | window: the input preview | The exact bytes the queue would write for one block. |
| `ncs run` | window: **Run workflow** / **Run selected block** | Queue the workflow and run it. |
| `ncs report` | window: **Report…** and the figure set beside it | The HTML report and its JSON model, for the newest queue of each flow. |
| `ncs validation` | **CLI only** | A recorded method ladder across reference cases: per-case spread, aggregate MAE/RMSE, `not computed` preserved. |
| `ncs convert` | window: **Export as…** | A finished run as extxyz, xyz, sdf, JCAMP or Molden. |
| `ncs cube` | window: **Write cube…** on the wavefunction card | One orbital's cube from a checkpoint, without `cubegen`. |
| `ncs smiles` | window: SMILES in the molecule drawer | A SMILES string as a bond graph: formula, charges, hydrogens. |
| `ncs export` | **CLI only** | Every `run.json` in one versioned envelope, with the schema path a script validates against. |
| `ncs record` | **CLI only** | `record import`: a number another program computed, labelled *imported, not run here*. |
| `ncs diff` | **CLI only** | Two projects compared per node and per field. |
| `ncs merge` | **CLI only** | Three-way, node-keyed project merge; a conflict writes nothing. |
| `ncs export-input` | window: **Export** menu → *NWChem / GAMESS / Q-Chem input* | The deck one block would be for NWChem, GAMESS or Q-Chem — engines this build exports but does not run. `ncs convert --format <engine>` writes the same text. |
| `ncs qcschema` | **CLI only** | MolSSI `qcschema_output` in and out, validated against the vendored schema. |
| `ncs cache` | **CLI only** | A run or a volumetric field as typed `.ncsr` arrays; `--inspect` reads the header back. |

The window says the same thing in its About text, so a user who never opens a
terminal is told these exist rather than left to infer their absence.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The workflow finished and every run passed its gates. |
| 1 | The command was used incorrectly — an unknown command, or a flag with no value where one is needed. |
| 2 | The project does not validate, a task could not be built, or a QCSchema document or payload does not conform. |
| 3 | A run finished but its gates failed — the result exists and needs review. |
| 4 | A run or the queue failed outright; nothing usable was produced. |
| 5 | The queue is **partial** (some records finished, some failed), or a merge found overlapping edits and wrote nothing. |

The split between 3 and 4 matters in a script: 3 means "look at the numbers", 4 means "the engine
did not produce a result".

## Collaborating on a project

`.ncs` is JSON with a stable id per block, so two people can work on the same project and reconcile
it without a server:

```
ncs diff their.ncs mine.ncs          # nodes added / removed / changed, per field
ncs merge base.ncs mine.ncs their.ncs --out merged.ncs
```

The merge is structural and keyed by node id. Edits to different blocks, or to different fields of
the same block, merge cleanly. When both sides changed the same field, the merge prints one conflict
per field (`{ kind, id, path, base, ours, theirs }`) and writes nothing — exit 5. A delete on one
side against an edit on the other is a conflict too; nothing is discarded silently.

The app itself refuses to overwrite a project that changed on disk since it was opened, and tells you
to reopen or save under a new name. That is a hash check, not a lock: two machines can still edit the
same file, but the second save is refused instead of destroying the first.

## Dry runs in CI

```
ncs run examples/opt-freq.ncs --out ./ci-runs --dry-run
```

A dry run uses the fixture output, exactly as the app does. It exercises the queue, the parser and
the gates and writes labelled fixture runs; it is **not** a calculation and no number in it is a
chemical result. CI runs the CLI this way because no Gaussian licence or xTB binary is available
there.

## Running for real

Point `--executable` at the licensed binary, or omit it and let the engine's own preflight resolve
the executable the way the app does:

```
ncs run my-project.ncs --out ./runs --executable /opt/g16/g16
```

If the workflow contains a conformer Generate block, `ncs run` also needs the binary that block's
generator spawns: CREST by default, Open Babel for the `obabel` route. The in-app `uff` route spawns
nothing, and a block that imports its ensemble needs neither:

```
ncs run my-project.ncs --out ./runs --executable /opt/g16/g16 --crest /opt/crest/crest --obabel /usr/local/bin/obabel
```

A tautomer block has no in-app route: point `--tautomer` at the RDKit sidecar (and `--tautomer-script`
at `scripts/tautomer-enumerator.py` when the executable is a Python interpreter). Without it the
queue refuses to start rather than substituting the input geometry.

```
ncs run my-project.ncs --out ./runs --executable /opt/g16/g16 --tautomer /opt/rdkit-venv/bin/python --tautomer-script scripts/tautomer-enumerator.py
```

Cluster export refuses a project that contains a Generate block — the export would otherwise build
its first calculation from the project geometry rather than the member you chose.

## Scripting from a shell or a notebook

The run record is a published contract:
[`schemas/run-record.v2.schema.json`](../../schemas/run-record.v2.schema.json) (v1 is kept
unchanged beside it; `--schema-version 1` still emits it). `ncs record import` writes the
imported-result kind — a number another program computed, labelled `imported, not run here`.
`ncs export`
returns `run.json` unchanged inside an envelope that names the schema version and its path, so a
script can validate the payload itself. `clients/python/` is a stdlib-only client for the same
records. Both are documented in [Scripting against NodeChem Studio](../SCRIPTING.md); a host that
wants a fifth engine should read [Engine plugins](../ENGINE_PLUGIN.md).

## What is not here yet

- A REST or socket server; the machine interface is the CLI and the run folder.
- A user-directory plugin loader. `registerEngine(spec)` is the seam, but the desktop queue still
  resolves the built-in engines through `src/shared/engines/index.js`.
- Machine-readable refusal codes on every command. Exit codes are the branch point; `ncs export`
  (`code: "record-invalid"`) and `ncs qcschema` (`qcschema-*`) also emit a `code` in their JSON
  refusal.

## Next

[Projects and runs on disk →](project-files.md)
