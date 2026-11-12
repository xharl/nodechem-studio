# The chemistry sidecar (RDKit)

RDKit is a toolkit, not an engine. NodeChem Studio spawns it as one external Python sidecar for every
chemistry operation it needs — enumeration, descriptors, standardisation, integrity checks and
depictions — and records the library, its version and the parameters with every answer.

RDKit is **not bundled and not installed by this app**. It is BSD-3 licensed and user-installed:

```bash
python3 -m pip install rdkit
```

The app ships the sidecar script with the installed build (under `resources/scripts/`), so no manual
download is required. A source checkout uses `scripts/nodechem-chem.py` directly.

## One protocol

The sidecar reads one JSON object on stdin and writes one JSON object on stdout:

```json
{"protocol": "nodechem-chem/1", "op": "probe", "options": {}}
```

```json
{"protocol": "nodechem-chem/1", "op": "probe", "ok": true,
 "program": "RDKit", "version": "2026.9.1",
 "capabilities": {"etkdgv4": true, "determineBonds": true}}
```

A refusal is a typed answer, never an empty result:

```json
{"protocol": "nodechem-chem/1", "op": "probe", "ok": false,
 "error": {"code": "rdkit-missing", "message": "RDKit is not installed in this interpreter: ..."}}
```

| Code | Meaning |
| --- | --- |
| `rdkit-missing` | the interpreter has no importable `rdkit` |
| `capability-missing` | the probe flagged an API this op needs |
| `coverage-refused` | an element, charge or multiplicity the op will not model |
| `size-refused` | a molecule beyond the op's stated limit |
| `bad-input` | malformed request, refused before RDKit runs |
| `op-failed` | RDKit raised; the message is carried through |

## The probe

Settings → Tools has one interpreter field for chemistry and a **Probe RDKit** action. The probe
imports the script once and touches each API it will need; Settings shows the version and any
capability that failed. The version string is recorded, never compared: the same build reports
`2026.9.1` through `importlib.metadata` and `2026.09.1` through `rdkit.__version__`, so capability
flags decide what may run.

A machine without RDKit is not an error state for the app: every chemistry block refuses with
`rdkit-missing` and says which interpreter it tried. CI does not install RDKit; the test suite
replays committed fixtures through a fake sidecar.

## Ops

| Op | Used by | Answer |
| --- | --- | --- |
| `probe` | Settings → Tools | version and capability flags |
| `descriptors` | `analyse.mode = "chem"` | the curated `nodechem-1` set for one molecule |
| `standardize` | `prepare.kind = "standardize"` | one cleaned structure, plus the change log and stereo audit |

Each answer records `program`, `version`, `op` and the parameters that change it. A repeated
structure is answered from the run-local `chem-cache.json`; the record says whether the value was a
cache hit.

## Choosing the interpreter

The sidecar runs under whichever Python the Tools settings name. It needs RDKit; a distribution
Python without `pip` cannot provide it. Point the field at the interpreter that actually imports
RDKit and press **Probe** — the answer names the interpreter, the RDKit version and the capability
flags, and a build without the standardiser refuses with `capability-missing` rather than
pretending the op ran.

## What ships, and where

`electron-builder` copies `scripts/**/*.py` through `extraResources` to `resources/scripts/`. The
main process resolves `nodechem-chem.py` there when packaged and from the repository when running
from source. Nothing inside the asar is executed.

## Related

- [Conformers, tautomers and protomers](conformers.md) — the tautomer block and its own protocol.
- [Reports](reports.md) — how a chemistry record's provenance appears in a report.

## Next

- [Conformers, tautomers and protomers](conformers.md) — the block kinds the sidecar serves today.

## Back

- [Install](install.md) — where the app and its companions live on a machine.
