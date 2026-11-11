# Scripting against NodeChem Studio

Three things make the workbench usable from a script:

- a **versioned schema** for the `run.json` record the app already writes, with
  a second record kind for a number another program computed;
- **`ncs export`**, which returns those records as one JSON envelope;
- a **Python client** in `clients/python/` that reads run folders and calls the
  CLI, standard library only.

There is also an engine plugin seam for hosts that need a fifth engine; it has
its own contract in [Engine plugins](ENGINE_PLUGIN.md), and `ncs qcschema` for
handing a result to another program in a format it already speaks (see
[QCSchema in and out](#qcschema-molssi-in-and-out) below).

## The record contract

Every run folder contains `run.json`. There are two published descriptions:

| Version | File | Knows |
| --- | --- | --- |
| 1 | [`schemas/run-record.v1.schema.json`](../schemas/run-record.v1.schema.json) | a run NodeChem performed |
| 2 | [`schemas/run-record.v2.schema.json`](../schemas/run-record.v2.schema.json) | the v1 run, unchanged, **or** an imported result (`kind: "imported"`) |

Both are JSON Schema draft 2020-12 with `x-nodechem.schemaVersion` set to their
own version. The same run record is written by the local runner and by the
cluster importer, so the run branch covers both shapes. v2 is a tagged union
whose run branch is v1 verbatim: **every v1 document validates unchanged**, and
a run still declares `schemaVersion: 1` because runs are still written to the
v1 contract. `ncs record import` writes the only v2 record shape.

The envelope is **closed**: an unknown top-level field fails validation. That is
deliberate — a writer that gains a field must update the schema in the same
commit, and `ncs export` refuses rather than silently dropping evidence.
Engine-specific evidence is carried in **open** objects (`parsed`,
`provenance`, `provenance.method`, validity finding `evidence`), where each
engine may add keys without a schema change.

### Fields

Required for every record:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Run id, also the run folder name. |
| `status` | `running` \| `completed` \| `failed` \| `needs-review` \| `cancelled` | The run's own outcome, not the queue's. |
| `dryRun` | boolean | True when the output is a labelled fixture. |
| `title` | string | The block title. |
| `inputName` | string | Input file name inside the run folder. |
| `outputName` | string | Output file name inside the run folder. |
| `outputFile` | string \| null | The file the parser read, when it read a file. |
| `outputSource` | string \| null | `file`, `stdout`, `fixture` or `cluster-import`. |
| `truncated` | boolean | True when the parse saw a bounded window, not the whole output. |
| `executable` | string \| null | The binary used; null for a dry run or an import. |
| `scratchDir` | string \| null | Scratch directory the run used. |
| `checkpointHandoff` | object \| null | Staged upstream checkpoint, if any. |
| `provenance` | object | What produced the run; open by engine. |
| `startedAt` | string (date-time) | When the run folder was created. |
| `finishedAt` | string (date-time) \| null | Null while the run is in flight. |
| `exitCode` | integer \| null | Process exit code; null for dry runs and imports. |
| `parsed` | object \| null | The engine's parse; open, with canonical keys when present. |
| `gates` | object \| null | Gate verdict, gate list and validity summary. |
| `error` | string \| null | Why the run failed, in the runner's words. |

Optional:

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | integer (`1`) | Contract version. Absent on records written before the contract and on cluster imports from older builds; a reader must not require it. |
| `engine` | string | `gaussian`, `xtb`, `orca`, `psi4`, `pyscf` or a plugin id. Absent on cluster imports. |
| `argv` | string[] \| null | Arguments passed to the executable. |
| `outputBytes` | object \| null | `size`, `bytesRead`, `truncated` and the `windows` the parser received. |
| `inputSha256` | string \| null | SHA-256 of the input file on disk. |
| `outputSha256` | string \| null | SHA-256 of the parsed output. |
| `app` | object | `version` and `commit` of the build. Absent on cluster imports. |
| `conformer` | object | The ensemble member this run was built on. |
| `record` | object | `{ id, label, datasetId? }` — the dataset record the run ran. Absent (not null) for a single-structure block. |
| `series` | object | `{ parentId, n, count, linkage? }` — the repeat unit a generated member was expanded from. Absent unless the record came from a series block. |
| `spectrumOverlay` | object | An imported measured trace beside the computed sticks: `{ source, sha256, columns, units, points }`. Absent when no trace was imported. |
| `dp4` | object | The DP4+ probabilities a derived `analyse` block recorded. Absent on every run that computed no comparison. |
| `timeout` | object \| null | `{ limitSeconds, elapsedSeconds, lastOutput, tree? }`, present only when the run was stopped at its wall-clock limit. |
| `cache` | object \| null | The typed-array cache written for a real run. |

The `gates` object carries `overall` (`pass`, `fail`, `unknown`), the
individual gate results, `complete`, and a `validity` summary with `findings`
plus the `errors` / `warnings` / `unknowns` subsets. A gate result is `pass`,
`fail`, `unknown` or `skipped`; a skipped gate is not a pass.

### Compatibility policy

`schemaVersion` is the major version.

- **Major change** — adding `run-record.v2.schema.json` and teaching
  `ncs export --schema-version 2`: removing or renaming a field, changing a
  field's type or meaning, changing units, making an optional field required,
  or closing a section that was open. Old schema files stay in the tree so an
  old export stays reproducible, and a document keeps validating against the
  version it was written for. v2 (imported results, below) was published this
  way rather than by loosening v1: v1's envelope is closed and its
  `provenance.kind` enum is closed too, so it had no extension point a second
  record shape could use, and editing it would have changed which documents v1
  accepts.
- **Minor change** — editing a version's file, no `schemaVersion` change:
  adding an optional field in the same commit as the writer that emits it,
  adding an enum value, or clarifying a description. Every record that
  validated before still validates.
- **Readers** must read the fields they know, treat absence as "not recorded"
  and never invent a default. `ncs export` is the producer-side check: it
  refuses a record that does not conform.

## `ncs export`

```
ncs export <out-dir> [--json] [--schema-version <n>] [--out <file>]
ncs export --json --schema-version 1 /tmp/ncs-runs
```

`<out-dir>` is the folder `ncs run --out` wrote; records are read from
`<out-dir>/runs/*/run.json`. The command prints one envelope:

```json
{
  "kind": "nodechem-studio.records",
  "schemaVersion": 1,
  "schema": "/path/to/schemas/run-record.v1.schema.json",
  "generatedAt": "2026-11-08T18:31:07.614Z",
  "outDir": "/tmp/ncs-runs",
  "recordCount": 1,
  "records": [ { "schemaVersion": 1, "id": "…", "status": "completed", "…": "…" } ]
}
```

- `schema` is the absolute path of the schema the records were validated
  against, so a caller can validate the payload without guessing.
- `--schema-version` defaults to the newest version the build ships (currently
  `2`). An unknown version exits 2 and prints the path of the version it does
  ship; it does not print a partial envelope. `--schema-version 1` still
  produces the v1 envelope for records written under v1; it refuses an imported
  record (exit 2, `record-invalid`) rather than dropping the field that says
  what the record is.
- One record that does not conform refuses the whole export: stderr carries
  `{ "ok": false, "code": "record-invalid", "failures": [...] }` with a JSON
  pointer per error, and stdout stays empty.
- `--out <file>` writes the envelope and prints the path, like `ncs report`.

This is additive: `ncs report`, the CSV/JSON dataset export inside the app and
the run folders themselves are unchanged.

## Imported results

A number another program computed — a Spartan single point, a Gaussian job run
on a cluster account, a colleague's ORCA optimisation — can be recorded in the
same place as a run, as a **different kind of record**:

```json
{
  "schemaVersion": 2,
  "kind": "imported",
  "id": "spartan-wb97xd3-def2tzvp",
  "program": "Spartan '26",
  "version": "26.0.1",
  "method": "ωB97X-D3",
  "basis": "def2-TZVP",
  "energy": -2107.7761757,
  "sourceSha256": "9f2c0d5e…",
  "sourceName": "study-01.spartan.out",
  "importedAt": "2026-11-08T19:38:00.000Z"
}
```

It is built deliberately, not parsed out of a foreign log: `ncs record import`
takes the provenance from the caller and writes one record, validated against
`schemas/run-record.v2.schema.json` before it reaches disk.

```bash
ncs record import --program "Spartan '26" --version 26.0.1 \
    --method ωB97X-D3 --basis def2-TZVP --energy -2107.7761757 \
    --source study-01.spartan.out --out /tmp/ncs-runs --id spartan-sp
# -> /tmp/ncs-runs/runs/spartan-sp/run.json
#    imported, not run here — Spartan '26 26.0.1
```

`--source <file>` hashes the file here; `--source-sha256 <hex>` takes a digest
computed on the machine that did the work (name exactly one). `--id` names the
record (default `imported-<program>-<method>`); `--title` and `--notes` are optional free text
carried in the record (`title`, `notes`), and `--source` also stores the file's basename as
`sourceName`. `--out` may be an
`ncs run --out` folder — the record lands in `runs/<id>/run.json` beside the
runs, so `ncs export` and the Python client find it — or a `.json` path for a
standalone results file. `--json` prints the record and the label instead of the
path. A second import never overwrites an existing record (`imported-exists`).

**What the record claims.** This energy, at this level of theory, was computed
by this program at this version, and the source file hashed to this digest.

**What it does not claim.** That the calculation is right, that the geometry is
the one you meant, or that NodeChem ran anything. The hash proves **the file**,
not the calculation; two runs of the same program on the same input can differ.
And the record is not run-shaped on purpose: there is no `status`, `outputFile`,
`gates` or `exitCode`, because none of those happened here.

Every surface that shows the number says so. The results panel, the block card,
the workflow report row and the report's "Imported results" table print
`imported, not run here — <program> <version>` next to it, and the app never
gives an imported record a run status badge. Consumers that build a series from
run records must label or exclude it:

- `buildWorkflowReport(queue, records, { includeImported })` lists every
  imported result either way; `includeImported: true` also puts its value in the
  energy columns, still labelled. The default leaves that column holding only
  numbers this app computed. A record containing an imported result gets no ΔE,
  and a conformer ensemble with an imported member is not Boltzmann-averaged.
- `ncs report <out-dir> --include-imported` is the same switch on the CLI.
- `resultsPanelHtml(record, { includeImported: true, imported: [...] })` shows
  an imported reference energy **beside** the pKa/redox cycles, never inside one.

## Python client

`clients/python/` is a stdlib-only package; there is no install step.

```python
import sys
sys.path.insert(0, "clients/python")
import nodechem

result = nodechem.validate("examples/single-point.ncs")
print(result["ok"], result["errors"])

for summary in nodechem.list_runs("/tmp/ncs-runs"):
    print(summary["id"], summary["status"], summary["gates"])

record = nodechem.read_record(summary["id"], "/tmp/ncs-runs")
print(record["parsed"]["finalEnergy"]["hartree"], "Eh")

records = nodechem.export("/tmp/ncs-runs")            # list of dicts
document = nodechem.Client("/tmp/ncs-runs").export_document()   # envelope
```

`list_runs()` returns one summary dict per run folder, newest first;
`read_record()` returns the `run.json` unchanged; `validate()` returns the
validity payload. A CLI refusal raises `nodechem.CliError` with `exit_code`,
`detail`, `stdout` and `stderr` — `export()` never returns the records that
happened to be readable. Values are not converted: energies stay in Hartree,
frequencies in cm⁻¹, and `null` means "not reported".

The CLI is found through `NODECHEM_NCS`, then `PATH`, then the checkout. See
[`clients/python/README.md`](../clients/python/README.md) and the self-test:

```bash
python3 clients/python/test_client.py
```

## Engine plugins

`src/shared/engines/registry.js` adds `registerEngine(spec)` beside the static
four. A spec carries `id`, `extensions`, `buildArgv`, `parseOutput` and `gates`;
an incomplete spec is refused with an error that names the missing key. The
contract, an example and the limits (no sandbox, no user-directory loader yet)
are in [Engine plugins](ENGINE_PLUGIN.md).

## QCSchema (MolSSI) in and out

`ncs qcschema` turns a finished run into a MolSSI **`qcschema_output`**
(`AtomicResult`) and reads one back. The contract is the published schema, not a
paraphrase of it: `schemas/qcschema/v2/qc_schema_output.schema` is a verbatim copy of
MolSSI/QCSchema (`462d17b`, BSD-3-Clause, provenance in
[`schemas/qcschema/README.md`](../schemas/qcschema/README.md)), and every document the
writer produces is validated against it before it reaches disk. A field the upstream
schema forbids fails in our tests, not in the next program.

### Units

QCSchema is atomic units. The conversion happens once, in
`src/shared/qcschema.js`, and in this direction only:

| Quantity | QCSchema | The app | Conversion |
| --- | --- | --- | --- |
| geometry | bohr, flat `[x1, y1, z1, …]` | angstrom, `{x, y, z}` per atom | × / ÷ `0.529177210903` (CODATA 2018 bohr radius) |
| energy | hartree (`return_result`, `properties.return_energy`) | hartree | none — copied unchanged |
| gradient | Eh/bohr, flat 3N | not parsed from a log | passed through when a caller has one |
| hessian | Eh/bohr², flat (3N)² | not parsed from a log | passed through when a caller has one |

Nothing is ever written into a hartree field in kcal/mol: thermochemistry travels in
`extras` under keys that say `_hartree`, and a frequency count is a count.

### What the export writes

| Field | Emitted | Notes |
| --- | --- | --- |
| `schema_name` / `schema_version` | `qcschema_output`, `2` | |
| `molecule` | `qcschema_molecule` v2 | `symbols`, `geometry` (bohr), `molecular_charge`, `molecular_multiplicity`, `name`; `fragments`, `fragment_charges`, `fragment_multiplicities` only when the caller supplies them. |
| `driver` | `energy`, `gradient` or `hessian` | the highest derivative the run has. |
| `return_result` | the energy, or the derivative | QCSchema's own slot for the requested answer. |
| `properties.return_energy` | the run's final energy | **nothing else** — the published schema closes `properties` (`additionalProperties: false`), so a gradient never goes here even when QCSchema's pydantic model would allow `return_gradient`. |
| `model` | `method`, `basis`, `dispersion` when reported | `basis` is `method-defined` for xTB and composite methods, which have no separate basis set — the sentinel the app's own provenance uses, never an invented basis name. |
| `keywords` | `{}` | the app does not record program parameters in a QCSchema vocabulary. |
| `provenance` | `creator`, `version`, `routine`, `engine`, `method`, `basis`, `run_id` (+ `dispersion`) | open in the schema; a dry run gets `routine: "ncs qcschema export (dry run)"`. |
| `success` | from the parsed status | |
| `error` | only when the failure maps onto `convergence_error` / `memory_error` / `file_error` | any other failure is left out rather than mislabelled. |
| `extras.nodechem` | run id, engine, `dry_run`, job type, termination, program, app version/commit, frequency count, thermochemistry (hartree) | the open block; thermochemistry and frequencies do not fit `AtomicResult`. |
| `wavefunction` | **omitted** | none of the four parsers produces MOs, so none is synthesised. A caller that really has one may pass it through; it is validated like the rest of the document. |

A field the run cannot supply is a **refusal**, not a zero: an export without a final
energy fails with `code: "qcschema-refused"` and `field: "return_result"`, and one
without a charge fails on `molecule.molecular_charge`. Charge and multiplicity come from
the run's own input file (the Gaussian job specification), from `--charge` /
`--multiplicity`, or not at all.

### Reading

`readQcschema(document)` returns a verdict, never a throw:

- `kind: "result"` for a `qcschema_output`: molecule in angstrom, `energyHartree`,
  `gradient`/`hessian` labelled with `Eh/bohr` and `Eh/bohr^2`, `model`, `provenance`,
  `dryRun`, `runId`, and `warnings` for anything a consumer should know (a gradient in
  `return_result`, `success: false`, a dry run).
- `kind: "input"` for a bare `qcschema_input`: its molecule and model, `energyHartree: null`.
- `{ ok: false, code, field, message }` otherwise. `qcschema-unsupported` is a
  `schema_name` that is neither; `qcschema-invalid` is a document that does not conform,
  with the field named — `return_result` when it is absent, `molecule.molecular_charge`
  when the molecule is silent. QCSchema defaults those two fields; the app refuses to
  guess them.

`structureFromQcschema(result)` produces the record the viewer and the converters
already take (`{ format, name, atoms, charge, multiplicity }`), and
`recordPatchFromQcschema(result)` produces only the run-record fields the document can
fill (`engine`, `provenance.method`, `parsed.finalEnergy`). The patch is not a record:
`run.json` needs runner evidence a document does not carry, and nothing is defaulted to
make it look complete.

### `ncs qcschema`

```
ncs qcschema export <run-dir|out-dir> [--run <id>] [--charge <n>] [--multiplicity <n>]
    [--out <file>] [--json]
ncs qcschema import <file> [--out <file.xyz|file.json>] [--json]
```

```bash
ncs run examples/single-point.ncs --out /tmp/runs --dry-run
ncs qcschema export /tmp/runs --json
ncs qcschema import /tmp/runs/runs/<id>/<id>.qcschema.json --out water.xyz
```

`export` takes a run folder (one `run.json`) or an `ncs run --out` folder, where
`--run <id>` chooses among several runs; several runs without `--run` is a refusal
(`qcschema-ambiguous`) that lists them. Without `--out` the document is written beside
the run as `<run-id>.qcschema.json`. `import` prints the read-back payload, or writes it
(`--out file.json`) or the structure (`--out file.xyz`).

Refusals are machine-readable on stderr and exit **2**:

```json
{ "ok": false, "code": "qcschema-refused", "field": "return_result",
  "message": "the run has no final energy, so QCSchema return_result cannot be filled in honestly." }
```

| Code | Meaning |
| --- | --- |
| `qcschema-refused` | the run cannot supply a field the document needs (the field is named). |
| `qcschema-invalid` | the document does not conform to the published schema, or is not JSON. |
| `qcschema-unsupported` | `schema_name` is neither `qcschema_output` nor `qcschema_input`. |
| `qcschema-no-run` | there is no `run.json` at that path. |
| `qcschema-ambiguous` | several runs under the folder; `runs` lists them. |

Usage errors (a missing subcommand, a non-integer `--charge`) exit **1** like the rest
of the CLI, with the command's usage on stderr.

## What is not here

- No REST or socket server, and no way to drive the Electron window.
- No notebook execution inside the app; a notebook imports the client above.
- CLI refusals are machine-readable through their **exit codes** (see
  [Headless CLI](guide/cli.md)) and, for `ncs export`, through the
  `code: "record-invalid"` envelope; `ncs qcschema` adds the `qcschema-*` codes
  above. The other commands print a sentence only.
- A plugin is JavaScript the host imported: the seam validates its shape, not
  its behaviour, and provides no sandbox.

## Next

[Headless CLI →](guide/cli.md)
