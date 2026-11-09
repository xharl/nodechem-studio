# Projects and runs on disk

Two things live on disk: the **project** you edit, and the **run records** the app writes. They are
independent — moving a `.ncs` file does not move its history, and deleting the app's data directory
does not damage a project.

## The project file

| Property | Value |
| --- | --- |
| Extension | `.ncs` — the only extension accepted |
| Content | canonical JSON (the extension names the product, not the encoding) |
| Size cap | 8 MB before parsing |
| Limits | 2 000 blocks, 4 000 connections, 64 fragments, 1 000 atoms |
| Version | `schemaVersion: 1` |

- **Validation before render.** A malformed file is refused with the failing JSON paths instead of
  half-rendering.
- **Migration.** An unversioned v0.1 file migrates on open. A file from a *newer* schema version is
  rejected with an "update the app" message — the reader never guesses at a newer format.
- **Canonical saves.** Fixed key order, normalized numbers, two-space indent, one trailing newline,
  no BOM written (a BOM is tolerated on read). Saving an unchanged project is byte-identical, so
  `.ncs` files diff cleanly in git.
- **Unknown fields** are dropped on save with a warning.
- **Save** writes back to the opened file; a new project prompts for a path. Closing with unsaved
  changes asks before discarding. There is no autosave and no crash-recovery copy of the project.

File naming: a new project is suggested as `<stem>.ncs`, where the stem is the project name
lowercased, accent-folded, stripped to `[A-Za-z0-9._ -]`, whitespace collapsed to dashes and
truncated to 60 characters — `"Réaction de Diels–Alder"` becomes `reaction-de-diels-alder.ncs`.

The normative definition of the document is [`docs/PROJECT-FORMAT.md`](../PROJECT-FORMAT.md).

## The project menu and recent projects

The project name in the top bar opens a menu for the project that is open:

- **Rename project…** changes the name stored in the `.ncs` file; the file name is untouched.
- **Reveal in file manager** shows the saved file. It is disabled until the project has a path.
- **Close project** replaces the open graph with a clean blank project in memory.
- **Open project…** is the same dialog as the one in the application menu.
- **Recent projects** lists the last ten `.ncs` files, newest first. Each row shows the project
  name, its parent folder, the engines its blocks use (`xTB · Psi4 · CREST`) and the file's modified
  date. Selecting a row opens it exactly as **Open project…** does.
- **Clear recent list** forgets every entry.

Opening a project when the current one has unsaved changes asks first, with the same prompt as
starting from a template: Keep editing leaves the open project alone, Discard continues.

The list lives beside the rest of the app's state:

```
<userData>/recent-projects.json
```

It is a list of paths and nothing else — no project content, no runs, no settings — written by the
main process every time a project is successfully opened or saved. Paths are canonicalised
(`realpath`) so the same file opened through a symlink or a different spelling appears once, and the
list is capped at ten with the newest first. It is not a backup: deleting it only forgets the list.

A recorded file that has since been moved or deleted is **not** pruned silently. It stays in the
menu, disabled, tagged `Missing`, with a **Remove** action — so a project that disappeared from a
mounted drive is visible rather than quietly vanishing. Name and engine columns are re-read from the
file when the menu opens; when it cannot be read, the values captured when it was last opened are
shown instead.

## Run folders

Every run gets its own immutable folder:

```
<userData>/runs/<runId>/
```

| File | Gaussian 16 | xTB |
| --- | --- | --- |
| `request.json` | engine, argv, names, settings | same |
| input | `<name>.gjf` | `<name>.xyz` |
| output | `<name>.out`, or `<name>.log` when Gaussian wrote that name | `<name>.out` — the captured stdout |
| `run.json` | status, exit code, parsed record, gates, hashes, provenance | same, with the xTB method block |
| `scratch/` | `GAUSS_SCRDIR` for this run | not used |
| extra | — | `xtbopt.xyz`, `xtbrestart` |

Output capture is capped at 32 MiB and the record carries a `truncated` flag when that limit is hit;
a truncated parse makes the "Output complete" gate `unknown`, not `pass`.

### `run.json` is the provenance record

It contains:

- the run status, exit code and timestamps;
- the parsed record the results panel renders;
- the **gate verdict** and, for Gaussian, the **validity findings** kept beside it;
- the SHA-256 of the exact input written and of the output parsed;
- the engine and version banner (`parsed.program`), the app version and commit;
- a normalised **method block** from the engine that ran — for Gaussian the functional, basis,
  dispersion, solvation, grid and SCF; for xTB the Hamiltonian, optimisation level, built-in
  dispersion, solvation and the exact argv used;
- `provenance.kind: "fixture"` on a dry run, so a synthetic record cannot be mistaken for a
  calculation.

**Verify input** in the run console recomputes the input hash and reports a mismatch if the input
file changed after the run.

## Queue state

```
<userData>/queues/<queueId>/queue.json
```

The queue record holds the task list, each task's status, attempts and error, the condition
decisions and the staged inputs. It is what lets a workflow survive a restart: on startup an
in-flight task becomes `interrupted` and can be resumed, rather than being reported as complete.

## Sharing

A run folder is self-contained. To hand a result to someone else, either zip the folder or use
**Export run bundle**, which copies the input and output, writes `methods.md` and hashes everything
into `manifest.json`. The bundle is a folder so the recipient can verify it with `sha256sum` and read
it without the app.

Nothing is uploaded, and no run data leaves the machine.

## Backups

- **Project**: copy the `.ncs` file. It is the whole document.
- **Runs**: copy `<userData>/runs/`. These are the evidence; without them a gate verdict cannot be
  re-checked.
- The app's data directory is per-user, outside the install folder, and is not removed by an uninstall.

## Next

[Troubleshooting →](troubleshooting.md)
