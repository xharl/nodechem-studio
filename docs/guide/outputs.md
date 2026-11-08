# Output blocks and artifacts

An **output block** turns the finished runs of a flow into a file you can hand to someone: a table
for a spreadsheet, the workflow report, or a zip of the run folders. It is a collector, not a
calculation — it waits for the blocks upstream of it, then writes its artifact.

## What an output block can write

| `output.kind` | File | Built from |
| --- | --- | --- |
| `csv` | RFC 4180 table | one row per finished run, the same columns as **Export run dataset** |
| `json` | versioned dataset envelope | the same rows, with `schemaVersion`, `generatedAt` and the app version |
| `html` | the workflow report | the record-grouped report described in [Reports](reports.md) |
| `zip` | store-only archive | the queue snapshot, record files and each finished run's `run.json`, input and output |

An output block never derives a number that a run did not report. A missing energy is an empty CSV
cell and `not reported` in HTML — never a zero.

```jsonc
{
  "id": "out1",
  "type": "output",
  "title": "Barrier table",
  "output": {
    "kind": "html",
    "path": "reports/barrier.html",
    "include": "records",   // or "record"
    "bundle": "project.zip",
    "manifest": true
  }
}
```

`path` is relative to the artifact root and may not contain `..` or an absolute prefix. A path that
tries to leave the root fails the task with the reason; nothing is written outside it.

## `include: "records"` and `include: "record"`

- **`records`** (default) writes one artifact for the whole flow. The CSV/JSON contains every
  finished run; the HTML contains every record; the zip contains every run folder the output can
  see.
- **`record`** writes one artifact per dataset record. The record id is inserted before the
  extension: `reports/barrier.html` becomes `reports/barrier-m1.html` and
  `reports/barrier-m2.html`. A record whose blocks all failed still gets a file naming that
  failure, so a partial family cannot lose a record silently.

## Where artifacts land

- In the app, an output block writes under
  `<userData>/queues/<queueId>/artifacts/`, so one queue is still one folder.
- `ncs run … --out <dir>` makes `<dir>` the artifact root: `reports/…` and `manifest.json` land
  beside `queues/`, not inside the queue folder.

Each write appends to `<artifactRoot>/manifest.json`. The manifest is a JSON array, one object per
file:

```json
[
  {
    "path": "reports/barrier-m1.html",
    "sha256": "99ecc886f66e…",
    "bytes": 4628,
    "kind": "html",
    "flowId": "barrier",
    "generatedAt": "2026-11-08T16:54:18.000Z",
    "queueId": "20261108-165418-5z4k1n"
  }
]
```

The path is relative to the artifact root, so the manifest is portable with the folder. The write is
atomic: a crash cannot leave a half-written manifest. Verify a copied folder with:

```bash
cd <artifactRoot>
jq -r '.[] | "\(.sha256)  \(.path)"' manifest.json | sha256sum -c -
```

`jq` is not required; the manifest is ordinary JSON and any reader can compare the hash.

## What is inside the zip

The archive is **store-only** — no compression. The artifacts are text and small, and a
dependency-free writer that any ZIP reader can open was worth more than a few saved kilobytes. It
contains:

```
queue.json
records/<record>.json
flows/<flow>/records/<record>/runs/<runId>/run.json
flows/<flow>/records/<record>/runs/<runId>/<input>
flows/<flow>/records/<record>/runs/<runId>/<output>
manifest.json          # name, byte size and SHA-256 of each file above
SHA256SUMS             # sha256sum-compatible lines
```

`manifest.json` and `SHA256SUMS` are added last, so they cover every other entry. The archive uses
store-only entries, fixed timestamps and UTF-8 names; the bytes for a given file list are
reproducible. The inner `manifest.json` records when the bundle was generated, so two runs of the
same project differ in that timestamp (and in the run ids they name).

## Failures

An output block does not hide a partial run. If one record fails, the other records still write and
the report names the failure; the queue verdict becomes `partial` and `ncs run` exits `5`. If the
write itself fails (permission denied, disk full, a directory where a file should be), the output
task fails with the operating system's message and the queue reports it like any other failure.

## Next

[Reports →](reports.md)
