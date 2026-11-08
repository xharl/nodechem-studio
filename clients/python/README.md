# `nodechem` — Python client

A small client for the run folders `ncs run --out` writes and for the `ncs`
CLI. Standard library only: no `pip install`, no `requests`, no network.

Requires Python 3.8+ and, for the CLI calls, the same Node runtime the CLI needs.

## Use it from a checkout

There is no install step. Put the package on `sys.path`:

```python
import sys
sys.path.insert(0, "clients/python")
import nodechem

result = nodechem.validate("examples/single-point.ncs")
if not result["ok"]:
    raise SystemExit(result["errors"])
```

`Client` resolves the CLI from `NODECHEM_NCS` (or `NCS`), then `ncs` on `PATH`,
then `bin/ncs.js` in the checkout this package lives in. Pass `cli=` to any call
to override it — an `ncs` path, a `bin/ncs.js` path, or an argv list.

## API

```python
client = nodechem.Client(out_dir="/tmp/ncs-runs")   # records live in <out_dir>/runs

client.validate("project.ncs")        # dict: ok, errors, warnings, validity, schemaVersion
client.list_runs()                    # [dict]: id, path, status, engine, title, gates, ...
client.read_record(run_id)            # dict: the run.json, unchanged
client.export()                       # [dict]: every record, from `ncs export`
client.export_document()              # dict: the envelope (schema path, version, records)
```

Module-level `validate()`, `list_runs()`, `read_record()` and `export()` do the
same with a default client rooted at the current directory.

`validate()` returns the CLI's payload for an invalid project (`ok: False` and
the `errors` array) because that is a complete answer. Anything that prevents
an answer — a usage error, an engine failure, a crash — raises `CliError`.
`export()` raises `CliError` for any refusal, so a script never receives the
records that happened to be readable.

```python
try:
    records = nodechem.export("/tmp/ncs-runs", schema_version=1)
except nodechem.CliError as error:
    print(error.exit_code, error.detail)   # 2, "unsupported run-record schema version ..."
```

## Units

Records hold the numbers the engine printed, untouched: energies in Hartree,
frequencies in cm⁻¹, masses in amu, thermochemistry in the units the parser
reports (the Gaussian parser keeps its kcal/mol and cal/mol/K tables). This
client never converts a value or fills a missing one; a `null` is "not
reported", never zero.

## Self-test

```bash
python3 clients/python/test_client.py
```

It runs against `clients/python/tests/fixtures/` with a temporary stand-in CLI:
no Node, no network. When a checkout with `examples/single-point.ncs` and Node
is available, one extra test calls the real CLI.
