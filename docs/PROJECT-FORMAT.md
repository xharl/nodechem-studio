# NodeChem Studio project format

Status: normative for `schemaVersion: 2`. This document is the contract between
the app and anything that reads or writes a project file.

## 1. File identity

| Property | Value |
| --- | --- |
| Extension | `.ncs` — required, case-insensitive on read |
| MIME type | `application/x-nodechem-studio-project` |
| Encoding | UTF-8 |
| Content | canonical JSON (the extension names the product, not the encoding) |
| Cardinality | one file = one project; no sidecar files required to open it |
| Size cap | 8 MiB before parsing |

There is exactly one accepted extension; any other suffix is refused on open
and on save. The format has no released predecessor, so no alias is maintained.

The extension is registered with the OS through electron-builder
`fileAssociations`, so a double-clicked `.ncs` opens NodeChem Studio.

## 2. Canonical serialization

A saved file is produced by `stringifyProject()` in
`src/shared/projectSchema.js`:

- input is validated and normalized first; an invalid project is never written;
- keys appear in the fixed order defined by the normalizers, so the same
  logical project always serializes to the same bytes;
- `JSON.stringify(project, null, 2)` — two-space indent, `\n` line endings;
- exactly one trailing `\n`;
- no BOM is written; a BOM is tolerated and stripped on read.

Consequence: `open → save` of an unmodified project is byte-identical, which
makes project files diffable in git.

Validation is non-throwing: `parseProjectText()` and `stringifyProject()`
return `{ ok, errors[], warnings[], project, migrated, schemaVersion }`, where
every error carries a JSON path (`nodes[3].settings.basis`).

## 3. Versioning

- `schemaVersion` is currently `2`.
- A file with no `schemaVersion`, or `0`, is treated as v0.1 and migrated by
  filling documented defaults; the result reports `migrated: true`.
- A **v1** file (a single top-level `nodes`/`edges` graph) migrates by wrapping
  that graph in a flow called `main`. Nothing else changes: task ids, run
  folder names and bundle names are identical, so a v1 project plans exactly as
  it did before.
- A file with a version **above** the build's `SCHEMA_VERSION` is rejected with
  an "update NodeChem Studio" message. The app never guesses at a newer format.
- Unknown keys are warnings, not errors, so a forward-compatible reader can
  ignore fields it does not know. Unknown keys are dropped on save.

## 4. Document schema

Top level, all six keys required after normalization:

| Key | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | integer | `1` |
| `name` | string | ≤ 200 chars, defaults to `Untitled project` |
| `molecule` | object | see below; the geometry a flow without an `input` block runs on |
| `defaults` | object | project-wide route defaults |
| `runner` | object | `{ maxParallel }`, 1–64, default 1 (sequential) |
| `datasets[]` | array | named record sets; ≤ 64 (see 4.1) |
| `flows[]` | array | one graph per flow; 1–32 (see 4.2) |
| `reports[]` | array | combined HTML reports across flows; ≤ 16 (see 4.5) |
| `activeFlowId` | string | the flow the app shows; must name a flow |

The file no longer carries a top-level `nodes`/`edges` pair: the graph lives in
`flows[]`. `project.nodes` and `project.edges` still exist **in memory** as
aliases of the active flow, so every reader that predates flows keeps working;
`stringifyProject()` drops them on save. A file that carries both (an in-memory
object written by hand) is read with the top-level pair as the active flow's
graph.

`molecule`:

| Key | Type | Notes |
| --- | --- | --- |
| `smiles` | string | optional |
| `charge` | integer | default 0 |
| `multiplicity` | integer | default 1 |
| `fragments[]` | string[] | ≤ 64, ≤ 400 chars each |
| `coords[]` | object[] | `{ element, x, y, z, fragment? }`, ≤ 1000 atoms, Å; `fragment` is a 1-based counterpoise label |

`defaults`:

| Key | Type | Notes |
| --- | --- | --- |
| `engine` | enum | `gaussian`, `xtb`, `orca` |
| `method` | string | Gaussian functional / xTB method default |
| `basis` | string | Gaussian basis |
| `memory`, `memoryUnit` | string, enum | Gaussian-only |
| `nproc` | integer | 1–1024 |

`nodes[]` — common keys `id`, `type`, `kind`, `title`, `state`, `x`, `y`.
Type-specific payloads:

| `type` | Payload |
| --- | --- |
| `calc` | `settings` (route), `output` (`{ file, size }` or null), `checkpointFrom` (node id or null) |
| `conformers` | `settings` (own key space, below), `output` (ensemble summary or null) |
| `condition` | `condition { expression, unknown, notes }` |
| `loop` | `loop { maxAttempts, mode, target, until }` |
| `merge` | `merge { policy, notes }` |
| `input` | `input { datasetId, recordFilter { field, equals } }` — starts iteration (4.3) |
| `output` | `output { kind, path, include, bundle, manifest, notes }` — writes an artifact (4.4) |
| `note` | `note { text }` |

`calc.settings` accepts exactly these keys — anything else is dropped:

`jobType`, `engine`, `method`, `basis`, `memory`, `memoryUnit`, `nproc`, `checkpoint`,
`charge`, `multiplicity`, `dispersion`, `scf`, `grid`, `population`, `verbosity`,
`solvation`, `solvationModel`, `solvent`, `customKeywords`, `ircDirection`,
`optConvergence`, `forceConstants`, `stableOpt`, `tdStates`, `tdTriplets`, `tdRoot`,
`raman`, `orbitals`, `spinSweep`, `ladder`, `referenceNodeId`, `counterpoise`,
`counterpoiseChargeStates`, `disabledChecks`, `gates`,
`xtbMethod`, `xtbOptLevel`, `xtbThreads`.

`settings.engine` is a per-block override (`gaussian`, `xtb` or `orca`); an empty string means "use
`defaults.engine`". Blocks in one project may therefore run on different engines, and a dependency
edge between them is a geometry hand-off the queue either accepts or refuses with a recorded reason.
`solvationModel` is validated against the engine the block resolves to:

| Resolved engine | Accepted `solvationModel` values |
| --- | --- |
| `gaussian`, `orca` | `PCM`, `SMD`, `CPCM` |
| `xtb` | `ALPB`, `GBSA`; an empty string means "not chosen" and an absent value defaults to `ALPB` |

A Gaussian-only model on an xTB block is a validation error naming the engine and the two xTB
models, because xTB never implements PCM, SMD or CPCM. There is one compatibility exception: a
Gaussian model left on an xTB block whose `solvation` is `false` is an inert placeholder (the
renderer's settings factory writes `PCM` on every block) and is preserved so projects saved before
this rule still open; switching `solvation` on then requires naming ALPB or GBSA. A block with no
engine set — neither `settings.engine` nor `defaults.engine` — validates as Gaussian, exactly as
before.

`ladder` declares method-ladder groups, `referenceNodeId` names the block a barrier or ΔG‡ is
measured against, `tdStates`/`tdTriplets`/`tdRoot` configure excited states, `orbitals` adds the
orbital-eigenvalue print (`Pop=Full` on Gaussian) that the frontier-orbital and Koopmans panel is
read from, and `raman`, `spinSweep`, `stableOpt` and `disabledChecks` switch the corresponding
analysis and validity behaviour.

`jobType` also accepts the composite methods `CBS-4M`, `CBS-QB3`, `CBS-APNO`, `G1`, `G2`, `G3`, `G4`
and `G4(MP2)`. A composite job **must** leave `method`, `basis`, `dispersion`, `solvation`,
`tdStates`, `population`, `orbitals`, `customKeywords`, `raman`, `stableOpt`, `optConvergence` and
`counterpoise` at their defaults; any value there is a conflict and refuses to build the input. The
route is the bare keyword (`#p G4`, `#p G4MP2` for `G4(MP2)`).

`counterpoise` is `0` (off) or the fragment count `2–10`. When it is set, every `coords[]` atom
carries `fragment` in `1..N`, the set of labels must be exactly `1..N`, and `molecule.fragments`
(when non-empty) must have `N` entries. `counterpoiseChargeStates` is optional: an array of
`{ charge, multiplicity }` in fragment order, which is written after the whole-system pair on the
charge/spin line; the fragment charges must sum to `molecule.charge`. Both keys are additive v1
fields — an older build drops them with a warning on save.

`settings.gates`: `termination`, `scf`, `imaginary`, `minMagnitude`, `thermo`,
`finalEnergy`.

`conformers.settings` is a separate key space — route keys cannot leak into a conformer search:
`generator` (`crest` or `import`), `method` (`gfn2` or `gfnff`), `energyWindowKcal`,
`rmsdThreshold`, `maxConformers`, `temperature`, `spreadThresholdKcal`, `selectedConformerId`,
`importPath`, `charge`, `multiplicity`, `fanOut`. Defaults: energy window 10 kcal/mol, RMSD 0.5 Å,
at most 20 conformers, 298.15 K, spread warning at 2 kcal/mol, fan-out off.

`conformers.output` is the ensemble summary written back after a search:

| Key | Notes |
| --- | --- |
| `generator`, `method` | `crest`, `import`, or `fixture` for a dry run |
| `count`, `total` | retained after pruning / frames read |
| `spreadKcal` | highest minus lowest retained member, null when one member |
| `selectedId`, `selected { id, energyEh, relativeKcal, population, protomer, atoms[] }` | the member downstream blocks run |
| `requiresSelection`, `autoSelected`, `protomers[]` | true when more than one protomer survives, which forbids an automatic choice |
| `members[] { id, rank, energyEh, relativeKcal, population, rmsdToLowest, protomer, kept, dropped, atoms[] }` | ranked table; kept members carry their geometry so the choice is offline |
| `pruned { energy, rmsd, count }`, `warnings[]`, `generatedAt` | what was dropped and why |

A calculation block fed by a `conformers` block runs the selected member's geometry. When no member
is selected — including every protomer case — the queue refuses to build its input rather than
falling back to the imported structure.

With `fanOut` on, the block expands into one task per **retained** member (`<nodeId>~<memberId>`) and
each calculation wired directly to it expands the same way, so the ensemble is optimised and reported
per member instead of collapsing to one geometry. Downstream `run.json` records which member a run
belongs to; dataset export carries `conformer_node`, `member`, `relative_kcal`, `population` and
`protomer` columns. Two cases are refused at plan time rather than guessed: an executable block that
would run once while several fanned-out branches feed it (the member it would use is ambiguous), and
the same block fanned over two different ensembles. Fan-out does not yet propagate through a chain —
`conformers → opt → freq` needs issue #87; until then it is refused, not run on the wrong geometry.

`edges[]` — `id`, `from`, `to`, `type` (`dependency`, `checkpoint`, `branch`,
`loop`, `barrier`), plus `branch` (`true`/`false`) on branch edges. Self-edges,
duplicate ids, unknown endpoints and ordinary cycles are rejected; `loop` edges
are the documented way to express a retry cycle. `barrier` is the stage fence
(4.3).

### 4.1 `datasets[]`

A dataset is a named, ordered set of molecule records that an `input` block
iterates. It lives in the project file, so a project is still one document.

| Key | Type | Notes |
| --- | --- | --- |
| `id` | string | 1–64 chars, `[A-Za-z0-9][A-Za-z0-9._-]*`, unique in the project |
| `title` | string | display name |
| `source` | object | `{ kind: 'file' or 'inline', path, format }`; `format` is `sdf`, `xyz`, `csv` or `json`; `path` is relative and has no `..` |
| `fields` | object | optional column mapping `{ label, charge, multiplicity }` read from the file's properties |
| `records[]` | array | at most 2 000, each `{ id, label, charge, multiplicity, coords[], enabled }` |
| `notes` | string | at most 2 000 chars |

A record's `id` uses the node-id grammar because it becomes a task-id segment.
`coords[]` uses the molecule atom shape (`{ element, x, y, z }`, at most 1 000
atoms) and is required: a record with no geometry cannot run and is a
validation error. `charge` (-10 to 10) and `multiplicity` (1 to 10) default to 0
and 1. `enabled: false` keeps the record in the file but out of every run, which
is how a family member is skipped without deleting it.

### 4.2 `flows[]`

| Key | Type | Notes |
| --- | --- | --- |
| `id` | string | 1–64 chars, unique; `main` for a migrated v1 project |
| `title` | string | display name; the flow tab |
| `nodes[]` | array | the node types above, plus `input` |
| `edges[]` | array | endpoints must belong to this flow |

Node ids are unique **within a flow**, so two flows may both contain a block
called `opt`. Edges, `checkpointFrom` and `loop.target` never cross a flow
boundary. A flow with no executable block is not a validation error; the
planner refuses it when someone tries to run it.

### 4.3 Iteration, task ids and `barrier`

A block **downstream of an `input` block** runs once per **enabled** record of
that block's dataset. The dataset is the loop; there is no separate "for each"
block. Task ids carry the record as a second `~` segment, and a conformer member
adds a third:

| Flow | Task ids |
| --- | --- |
| no `input` block (every v1 project) | `opt` |
| `input` then `opt` | `opt~m1`, `opt~m2` |
| `input` then `conformers` (fan-out) then `opt` | `opt~m2~c1` |

A record's `charge` and `multiplicity` are used unless the block sets a value
that differs from the schema default (0 / 1); the default is not treated as an
explicit override, because `defaultSettings()` writes it on every block. The
record's `coords` replace the project geometry for that record's runs.

`input.recordFilter` narrows the family without editing the dataset:
`{ "field": "label", "equals": "enol-3" }` runs that record alone. The field is
one of `id`, `label`, `charge`, `multiplicity`; `charge` and `multiplicity`
compare as numbers, the others as trimmed strings. An empty `field` or `equals`
means "every enabled record" — the default — and an unknown field is refused at
plan time rather than silently matching nothing.

Edge semantics under iteration:

| Type | Expansion |
| --- | --- |
| `dependency` | record to record (`opt~m1` to `freq~m1`); an unscoped block broadcasts (single source) or collects (single consumer) |
| `checkpoint` | the same record and, when fanned out, the same member |
| `barrier` | the **cross product**: every source record orders every consumer record, so `freq` to `sp` means no `sp` starts before *every* `freq` is terminal |
| `branch`, `loop` | unchanged |

A block fed by two different datasets is refused at plan time: there is no
honest pairing between two record sets. A plan is capped at 5 000 tasks, and the
refusal names the product (`60 records × the blocks they feed`).

### 4.4 `output` blocks

| Key | Type | Notes |
| --- | --- | --- |
| `kind` | enum | `html`, `csv`, `json`, `zip`; **no PDF** |
| `path` | string | project-relative artifact path inside the output folder; the extension must match `kind`; no `..` |
| `include` | enum | `records` (one artifact for the whole family, default) or `record` (one per record, `-<recordId>` before the extension) |
| `bundle` | string | v1 compatibility: the zip name when `kind` is `zip` |
| `manifest` | boolean | append the artifact's SHA-256 to the run manifest |
| `notes` | string | at most 2 000 chars |

### 4.5 `reports[]`

A combined HTML report across flows: `{ id, title, kind: 'html', flows: [flowId], path }`.
Per-flow reports are written by `output` blocks; `reports[]` only adds the
document that stitches flows together. `ncs run` writes every `reports[]` entry
after the queue settles, from the queues that run left behind — no second
command. The path is relative to the output folder and may not contain `..`.
Failed and partial records are named in its index, never hidden.

## 5. Limits

| Limit | Value |
| --- | --- |
| File size | 8 MiB |
| Nodes | 2 000 |
| Edges | 4 000 |
| Fragments | 64 |
| Atoms | 1 000 |
| Records per dataset | 2 000 |
| Datasets | 64 |
| Flows | 32 |
| Planned tasks | 5 000 |
| `runner.maxParallel` | 64 |
| Errors reported | 100 |
| Warnings reported | 200 |

## 6. File naming

New projects are suggested as `<stem>.ncs`, where the stem is the project name
lowercased, NFKD-folded (accents become base letters), stripped of anything
outside `[A-Za-z0-9._ -]`, whitespace collapsed to single dashes, truncated to
60 characters, and `untitled` when nothing survives:

```
"Diels–Alder TS / run 2"  →  diels-alder-ts-run-2.ncs
"Réaction de Diels–Alder" →  reaction-de-diels-alder.ncs
```

`src/shared/projectFile.js` is the only module that knows these rules; the
dialogs, the save-path check and the tests all delegate to it.

## 7. On-disk layout

### 7.1 The project document

Lives wherever the user saves it. The app stores no registry, no recent-files
index and no project database — the path held in memory is the only handle, and
nothing outside the file is required to open a project.

### 7.2 Application data directory

`userData`, pinned to `<appData>/nodechem-studio`. The name is a documented
constant of the layout, so the storage location does not depend on how Electron
derives its default directory.

```
<userData>/
  runs/
    <runId>/
      request.json      # what was asked for (engine, argv, names, settings)
      <input>           # the exact bytes handed to the engine (.gjf or .xyz)
      <output>          # the engine's stdout/log as written to disk
      run.json          # status, gates, parsed summary, hashes, provenance
      scratch/          # GAUSS_SCRDIR for this run
  queues/
    <queueId>/
      queue.json        # durable workflow task list and per-task state
```

`runId` and `queueId` are validated before any path join; a record is never
addressed by user-typed text.

### 7.3 Not in the project file

Runs, queues, cluster exports and scratch data are **not** referenced by the
project document beyond `calc.output` (the discovered output file name and
size). Moving a `.ncs` file does not move its run history, and deleting the
app data directory does not damage a project.

## 8. Changing the format

Any change that alters the meaning or shape of an existing field requires a
`schemaVersion` bump and a documented migration. Additive fields that a v1
reader would drop are also a bump, because a save by an older build would lose
them. Update this document in the same commit as the schema change.
