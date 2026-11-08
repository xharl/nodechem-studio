# Datasets and input blocks

A **dataset** is a named, ordered set of molecule **records** stored inside the project. An
**input block** binds a flow to one dataset and makes the rest of that flow run once per enabled
record. The graph is still the workspace: there is no "for each" block to draw and no second
canvas. The dataset is the loop.

```
input block ──▶ optimise ──▶ frequency ──▶ output
   enols        (mol1)       (mol1)        one table
  12 records     (mol2)       (mol2)
                 …            …
```

A flow without an input block runs once on the project molecule, exactly as every v1 project did.

## Importing a dataset

Select an input block and use **Import dataset file…** in the inspector. The file picker accepts:

| Format | What one record is |
| --- | --- |
| `.sdf` | Everything up to a `$$$$` terminator; the first line is the label and `M  CHG` sets the formal charge |
| `.xyz` | One frame: a count line, a comment line (the label), then the atom lines |
| `.csv` | Rows grouped by `id`/`label` (one atom per row), or repeated `x1,y1,z1,…` columns (one record per row) |
| `.json` | An array of records, or an object with a `records` array |

Every record needs coordinates. **A file with no geometry is refused**: this app does not invent a
structure, embed a SMILES string or fill in a demo molecule. Bad records are skipped and named in
the toast; if nothing usable remains, nothing is imported.

The supported record shape, as JSON:

```json
[
  {
    "id": "acetylacetone-enol",
    "label": "acetylacetone (enol)",
    "charge": 0,
    "multiplicity": 1,
    "enabled": true,
    "coords": [
      { "element": "C", "x": 0.0, "y": 0.0, "z": 0.0 }
    ]
  }
]
```

A CSV may carry one atom per row:

```csv
id,label,charge,multiplicity,element,x,y,z
water,Water,0,1,O,0,0,0.1173
water,Water,0,1,H,0,0.7572,-0.4692
```

or one record per row with repeated atom groups:

```csv
id,label,charge,multiplicity,element1,x1,y1,z1,element2,x2,y2,z2
water,Water,0,1,O,0,0,0,H,0,0,0.97
```

The CSV needs an `element` column (or `element1`, `element2`, … beside the coordinates). A file with
`x,y,z` but no element column is refused rather than guessed at.

When the file picker is unavailable, the same inspector has a **Paste records instead** field: paste
the SDF, XYZ, CSV or JSON text, choose a format (or let it detect), and import. This is also what
keeps the browser preview usable without the desktop bridge.

## Records in the inspector

The input inspector lists every record with its label, charge, multiplicity and an **on** checkbox.
Unchecking a record keeps it in the project file but removes it from the next plan; it is not
deleted. The block card shows `enabled / total` and the dataset's format.

Importing into a bound input block **replaces** that dataset's records and source in place, so the
graph keeps pointing at the same dataset id. Importing into an unbound block creates a new dataset
named after the file, with a unique id slug.

## What a run does

The planner expands one task per enabled record for every block downstream of the input:

| Situation | Task id |
| --- | --- |
| one record | `opt` — unchanged from v1 |
| several records | `opt~mol1`, `opt~mol2` |
| conformer fan-out inside a record | `opt~mol1~c2` |

`dependency` edges hand off within the same record. A `barrier` edge waits for the source block to
be terminal for **every enabled record** before the next block starts, which is how a stage fence is
drawn without a group abstraction. Independent records may overlap when the run console's
**Parallel tasks** value (or `runner.maxParallel` in the project) is above 1; the default of 1 is the
sequential behaviour every earlier project had.

A record that fails blocks only its own downstream tasks. The other records continue, the flow
finishes as **partial**, and the run console's record table names the failed records and the first
error. This is deliberate: a 200-molecule screen that lost three records is neither a pass nor a
total failure.

## Limits

| Limit | Value |
| --- | --- |
| Records per dataset | 2 000 |
| Atoms per record | 1 000 |
| Planned tasks per flow | 5 000 (`records × blocks`) |
| Flows per project | 32 |

If a plan hits the task cap, disable some records or split the family across flows; the error names
the product that hit it.

## Output blocks

An output block names the artifact a flow produces. The inspector offers:

| Kind | Artifact |
| --- | --- |
| `html` | the workflow report, one section per record |
| `csv` | an RFC 4180 table, one row per record × block |
| `json` | `{ schemaVersion, generatedAt, records[], runs[] }` |
| `zip` | run bundle(s) plus manifest and checksums |

The path is relative and must stay inside the output folder (no `..`), and its extension must match
the kind. **Include** chooses one artifact for the whole flow or one per record. **Include manifest**
adds the SHA-256 list beside the artifact.

## Next

- [Workflows](workflow.md) — the queue, barrier edges, checkpoint hand-off and cluster export.
- [Projects and runs on disk](project-files.md) — where the datasets and per-record run folders live.
