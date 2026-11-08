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
ncs run <project.ncs> --out <dir> [--dry-run] [--executable <path>] [--crest <path>] [--timeout <seconds>]
ncs diff <a.ncs> <b.ncs> [--json]
ncs merge <base.ncs> <ours.ncs> <theirs.ncs> --out <file>
```

- `validate` prints the schema errors, warnings and the pre-run validity findings as JSON. Every
  shipped example validates with exit 0.
- `build-input` prints the exact input text for one node — the same bytes the queue would write —
  without running anything. Use `--out` to write it to a file.
- `run` queues the workflow, waits for it to finish and prints a JSON summary: the queue status and,
  per task, the run id, the run status, the gate verdict and the run folder.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The workflow finished and every run passed its gates. |
| 1 | The command was used incorrectly. |
| 2 | The project does not validate, or a task could not be built. |
| 3 | A run finished but its gates failed — the result exists and needs review. |
| 4 | A run or the queue failed outright; nothing usable was produced. |
| 5 | A merge found overlapping edits; nothing was written. |

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

If the workflow contains a conformer block, `ncs run` also needs CREST unless the block imports its
ensemble:

```
ncs run my-project.ncs --out ./runs --executable /opt/g16/g16 --crest /opt/crest/crest
```

Cluster export refuses a project that contains a conformer block — the export would otherwise build
its first calculation from the project geometry rather than the member you chose.

## What is not here yet

- The proposed stable, versioned JSON schemas for the canonical result and the run record are not
  frozen as a public API; the project file already carries a `schemaVersion`, the run record does not.
- There is no separate client library for reading run folders: the run folder is ordinary JSON and
  text, and `ncs run` prints the summary a script needs.

## Next

[Projects and runs on disk →](project-files.md)
