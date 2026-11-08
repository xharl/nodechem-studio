# Scripting against NodeChem Studio

Three things make the workbench usable from a script:

- a **versioned schema** for the `run.json` record the app already writes;
- **`ncs export`**, which returns those records as one JSON envelope;
- a **Python client** in `clients/python/` that reads run folders and calls the
  CLI, standard library only.

There is also an engine plugin seam for hosts that need a fifth engine; it has
its own contract in [Engine plugins](ENGINE_PLUGIN.md).

## The record contract

Every run folder contains `run.json`. The published description is
[`schemas/run-record.v1.schema.json`](../schemas/run-record.v1.schema.json)
(JSON Schema draft 2020-12, `x-nodechem.schemaVersion: 1`). The same record is
written by the local runner and by the cluster importer, so the schema covers
both shapes.

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
| `engine` | string | `gaussian`, `xtb`, `orca`, `psi4` or a plugin id. Absent on cluster imports. |
| `argv` | string[] \| null | Arguments passed to the executable. |
| `outputBytes` | object \| null | `size`, `bytesRead`, `truncated` and the `windows` the parser received. |
| `inputSha256` | string \| null | SHA-256 of the input file on disk. |
| `outputSha256` | string \| null | SHA-256 of the parsed output. |
| `app` | object | `version` and `commit` of the build. Absent on cluster imports. |
| `conformer` | object | The ensemble member this run was built on. |
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
  old export stays reproducible.
- **Minor change** — editing the same file, no `schemaVersion` change: adding
  an optional field in the same commit as the writer that emits it, adding an
  enum value, or clarifying a description. Every record that validated before
  still validates.
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
- `--schema-version` defaults to `1`. An unknown version exits 2 and prints the
  path of the version it does ship; it does not print a partial envelope.
- One record that does not conform refuses the whole export: stderr carries
  `{ "ok": false, "code": "record-invalid", "failures": [...] }` with a JSON
  pointer per error, and stdout stays empty.
- `--out <file>` writes the envelope and prints the path, like `ncs report`.

This is additive: `ncs report`, the CSV/JSON dataset export inside the app and
the run folders themselves are unchanged.

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

## What is not here

- No REST or socket server, and no way to drive the Electron window.
- No notebook execution inside the app; a notebook imports the client above.
- CLI refusals are machine-readable through their **exit codes** (see
  [Headless CLI](guide/cli.md)) and, for `ncs export`, through the
  `code: "record-invalid"` envelope. Other commands print a sentence only.
- A plugin is JavaScript the host imported: the seam validates its shape, not
  its behaviour, and provides no sandbox.

## Next

[Headless CLI →](guide/cli.md)
