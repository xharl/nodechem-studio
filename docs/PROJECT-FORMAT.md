# NodeChem Studio project format

Status: normative for `schemaVersion: 3`. This document is the contract between
the app and anything that reads or writes a project file.

> **ADR 0001 is in force:** [ADR 0001](adr/0001-block-taxonomy.md) defines the
> block taxonomy (input · prepare · generate · calculate · analyse · output) and
> `schemaVersion: 3`. Version 3 is a breaking vocabulary change with no
> compatibility layer.

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

- `schemaVersion` is currently `3`.
- Version 3 is **breaking** (ADR 0001): the block types are `input`,
  `generate`, `calculate`, `analyse`, `output`, plus the `condition`, `loop`,
  `merge` and `note` axes. A version 1, 2 or unversioned file is **refused by
  version**, not migrated; rebuild the project in this build.
- A file with a version **above** the build's `SCHEMA_VERSION` is rejected with
  an "update NodeChem Studio" message. The app never guesses at a newer format.
- Unknown keys are warnings, not errors, so a forward-compatible reader can
  ignore fields it does not know. Unknown keys are dropped on save.

## 4. Document schema

Top level, all six keys required after normalization:

| Key | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | integer | `3` |
| `name` | string | ≤ 200 chars, defaults to `Untitled project` |
| `molecule` | object | see below; the geometry a flow without an `input` block runs on |
| `defaults` | object | project-wide route defaults |
| `runner` | object | `{ maxParallel, timeoutSeconds? }`, 1–64, default 1 (sequential); `timeoutSeconds` 1–`LIMITS.timeoutSeconds`, absent means the built-in 3600 s applies and is never written back |
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
| `geometry` | object | `{ source, file, format, dimension? }` — `source` is `demo`, `imported` or `manual`, `format` names the reader that produced the coordinates, and `dimension: "2d"` marks a drawing (a CDXML or CDX import) whose bond lengths are page units with every atom at z = 0: a depiction, never a structure to run on unoptimised |

`defaults`:

| Key | Type | Notes |
| --- | --- | --- |
| `engine` | enum | `gaussian`, `xtb`, `orca`, `psi4` |
| `method` | string | Gaussian functional / xTB method default |
| `basis` | string | Gaussian basis |
| `memory`, `memoryUnit` | string, enum | Gaussian-only |
| `nproc` | integer | 1–1024 |

`nodes[]` — common keys `id`, `type`, `kind`, `title`, `state`, `x`, `y`.
`state` is one of `ready`, `running`, `passed`, `review`, `blocked`, `failed`, `skipped`,
`cancelled`, `interrupted`, `timed out` — the last being a block the queue stopped at its wall-clock
limit, which is **not** `failed`: the engine never gave a verdict, so its output is not parsed.
A `calculate` block may also carry `timeoutSeconds`, which overrides `runner.timeoutSeconds` for that
block alone; it is absent unless the block states one, so a project that never set a per-block limit
serialises exactly as before.
Type-specific payloads:

| `type` | Payload |
| --- | --- |
| `calculate` | `settings` (route), `output` (`{ file, size }` or null), `checkpointFrom` (node id or null) |
| `prepare` | `settings { kind, converter, forceField, smiles, charge, multiplicity }`, `output` (one-structure summary or null) — ADR 0001, one structure in and out |
| `generate` | `settings` (own key space, below), `output` (ensemble summary or null) |
| `condition` | `condition { expression, unknown, notes }` |
| `loop` | `loop { maxAttempts, mode, target, until }` |
| `merge` | `merge { policy, notes }` |
| `input` | `input { datasetId, recordFilter { field, equals }, recordId?, series?, edits? }` — starts iteration (4.3); `series` makes it a homologous-series block (4.3.1), `edits` a derivative block (4.3.2). An **ensemble** input is `input { kind: "ensemble", path, format: "xyz", energyUnit, energyMethod, origin { program, version, method }, sourceSha256? }` — it reads an external multi-XYZ at run time (ADR 0001, 4.3.3) |
| `output` | `output { kind, path, include, bundle, manifest, notes }` — writes an artifact (4.4) |
| `analyse` | `analyse { mode?, expression, inputs[] }` — arithmetic over upstream results (issue 175); each input is `{ name, field, source, scope? }`, `field` a dataset-export column key, `source` an upstream block id (empty means the only one), `scope: "records"` reads every record of that block. `mode` is `expression` (the default, and absent when never set) or `dp4`, the DP4+ probability comparison whose definition lives under `dp4` (issue 165), or `multiwfn`, a user-installed Multiwfn sidecar whose definition lives under `multiwfn` (`{ analysis, input: { runId? | nodeId? | path? }, grid?, isovalue?, rhoCutoff? }`, issue 270) |
| `note` | `note { text }` |

`calculate.settings` accepts exactly these keys — anything else is dropped:

`jobType`, `engine`, `method`, `basis`, `memory`, `memoryUnit`, `nproc`, `checkpoint`,
`charge`, `multiplicity`, `dispersion`, `scf`, `grid`, `population`, `verbosity`,
`matrixElement`, `solvation`, `solvationModel`, `solvent`, `customKeywords`, `ircDirection`,
`optConvergence`, `forceConstants`, `stableOpt`, `tdStates`, `tdTriplets`, `tdRoot`,
`emission`, `nto`, `ntoTransition`,
`raman`, `vcd`, `orbitals`, `spinSweep`, `ladder`, `referenceNodeId`, `counterpoise`,
`counterpoiseChargeStates`, `constraints`, `qst`, `disabledChecks`, `gates`,
`xtbMethod`, `xtbOptLevel`, `xtbThreads`, `freezeCore`, `timeoutSeconds`, `provider`,
`recordTransitionDipoles`, `nmrSpinSpin`, `pnoThreshold`, `pyscfActiveSpace`.

`pnoThreshold` is `"NormalPNO"` or `"TightPNO"` and applies only to an ORCA
`DLPNO-CCSD(T)` block. It is absent when never set; the ORCA builder writes
`NormalPNO` explicitly in that case and refuses the key on a method with no PNO
truncation.

`provider` is absent (run the engine) or `"ml:aimnet2"`. With a provider the block stays a
`calculate` block but does not spawn the engine: one structure is scored, `run.json` carries
`engine: "aimnet2"`, `provenance.kind: "scorer"`, `parsed.finalEnergy.hartree` (converted explicitly
from eV) and the scorer's full provenance. No gate is invented; `gates` is null. A task with a
provider does not require an engine executable, but it does require the scorer sidecar.

`settings.engine` is a per-block override (`gaussian`, `xtb`, `orca`, `psi4` or `pyscf`); an empty string means "use
`defaults.engine`". Blocks in one project may therefore run on different engines, and a dependency
edge between them is a geometry hand-off the queue either accepts or refuses with a recorded reason.
`solvationModel` is validated against the engine the block resolves to:

| Resolved engine | Accepted `solvationModel` values |
| --- | --- |
| `gaussian`, `orca` | `PCM`, `SMD`, `CPCM` |
| `psi4` | `PCM`, `COSMO` |
| `pyscf` | `PCM`, `C-PCM` |
| `xtb` | `ALPB`, `GBSA`; an empty string means "not chosen" and an absent value defaults to `ALPB` |

A Gaussian-only model on an xTB block is a validation error naming the engine and the two xTB
models, because xTB never implements PCM, SMD or CPCM. There is one compatibility exception: a
Gaussian model left on an xTB block whose `solvation` is `false` is an inert placeholder (the
renderer's settings factory writes `PCM` on every block) and is preserved so projects saved before
this rule still open; switching `solvation` on then requires naming ALPB or GBSA. A block with no
engine set — neither `settings.engine` nor `defaults.engine` — validates as Gaussian, exactly as
before.

`ladder` declares method-ladder groups, `referenceNodeId` names the block a barrier or ΔG‡ is
measured against, `tdStates`/`tdTriplets`/`tdRoot` configure excited states, `emission` marks a
vertical-emission block (an SP pinned to `TD=(NStates=n,Root=1)`), `nto` marks the second job of the
`Pop=NTO` chain and `ntoTransition` selects the transition density the TD job stores with
`Density=(Check,Transition=k)`, `orbitals` adds the
orbital-eigenvalue print (`Pop=Full` on Gaussian) that the frontier-orbital and Koopmans panel is
read from, `raman` and `vcd` put `=Raman` / `=VCD` on the frequency keyword (`Freq=(Raman,VCD)`
when both are on), and `spinSweep`, `stableOpt` and `disabledChecks` switch the corresponding
analysis and validity behaviour. `vcd` is refused on a job type with no frequency to carry it.

Five keys are opt-in and **absent by default**, each written only after a block states it, so a
project saved before they existed serialises byte for byte as it did: `freezeCore` (`auto`, `true` or
`false`; `auto` writes no line at all, `false` asks for all-electron correlation), `timeoutSeconds`
(the block's own wall-clock limit), `recordTransitionDipoles` (a Psi4 TD block that records the
transition-dipole vector, which a coupling cannot be recovered without), `nmrSpinSpin` (an NMR
block that writes `NMR=SpinSpin` so Gaussian prints the K and J coupling tables) and
`pyscfActiveSpace` (a PySCF CASSCF block's active space, written `electrons,orbitals`, for example
`"6,6"`). A key being listed
above is not the same as being persisted — the reader must also read it — which is the defect class
that silently dropped `freezeCore` and `recordTransitionDipoles` until a round-trip test caught it.

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

`constraints[]` (additive, schema v2) lists frozen coordinates for a Gaussian optimisation:

| Key | Type | Notes |
| --- | --- | --- |
| `kind` | enum | `bond`, `angle`, `dihedral` or `freeze` |
| `atoms` | integer[] | 1-based atom indices in the geometry that is actually written (2, 3, 4 or 1 values); a dataset record's `coords` replace the project geometry |
| `value` | number or null | optional declared target in Å (bond) or degrees (angle/dihedral); it must match the geometry within 0.02 Å / 0.5°, because Gaussian 16 freezes at the geometry value and ignores a value on the line |

They are written as a Gaussian `ModRedundant` section after the molecule specification
(`B 3 7 F`, `A 3 7 9 F`, `D 3 7 9 11 F`, `X 7 F`) and named on the route. An empty array is the
default and changes no input byte. Out-of-range indices, duplicate coordinates, a set that leaves
no internal degree of freedom, and a frozen coordinate on a `Scan` job are validation errors.

`qst` (additive, schema v2) is `null` or `{ structures[] }`: the extra molecule specifications an
`Opt=QST2` or `Opt=QST3` job reads after the block's own geometry.

| Key | Type | Notes |
| --- | --- | --- |
| `label` | string | ≤ 60 chars, used in the section title (`… — structure 2 (product)`) |
| `source` | enum | `copy`, `block` or `file` — where the coordinates were copied from |
| `nodeId` | string | the block the geometry came from, when `source` is `block` |
| `path` | string | the file name the geometry came from, when `source` is `file` |
| `atoms[]` | object[] | `{ element, x, y, z }`, same shape as `molecule.coords` |

The coordinates are stored on the block, not referenced, so a saved project and
`ncs build-input` produce byte-identical text. `Opt=QST2` needs one structure (the product),
`Opt=QST3` two (product, initial TS guess); the block's `molecule` is the reactant. The structures
must have the same atoms in the same order as the block geometry — a mismatch is a validation error
naming the first differing index, and nothing is reordered automatically.

`prepare.settings` is deliberately tiny — no route, no method, no gates:

| Key | Type | Notes |
| --- | --- | --- |
| `kind` | `relax` or `embed3d` | default `relax` |
| `converter` | `uff`, `openbabel` or `aimnet2` | `relax` only; `embed3d` is always `openbabel` |
| `forceField` | `UFF`, `MMFF94` or `AIMNet2` | the force field or scorer the converter uses |
| `smiles` | string | required for `embed3d`; ignored by `relax` |
| `charge`, `multiplicity` | integer | the structure's chemistry, not a method |

A prepare block takes one structure in (the project molecule, or one upstream structure) and writes
one `prepared.xyz`; a calculate block wired from it runs on that geometry. It never enumerates:
protonation-state and tautomer enumeration belongs to `generate`.

`generate.settings` is a separate key space — route keys cannot leak into a conformer search:
`source` (`search` or `imported`, default `search`), `generator` (`crest`, `uff` or `obabel`,
search only), `method`, `energyWindowKcal`, `rmsdThreshold`,
`maxConformers`, `temperature`, `spreadThresholdKcal`, `selectedConformerId`, `rankBy`, `charge`,
`multiplicity`, `fanOut`, `group` (an optional study id shared by blocks that belong together,
1–32 letters, digits, `.`, `_` or `-`; empty means no group). Defaults: source `search`, generator
`crest`, method `gfn2`, energy window 10 kcal/mol, RMSD 0.5 Å, at most 20 conformers, 298.15 K,
spread warning at 2 kcal/mol, fan-out off, no group.

`method` names the method the chosen generator actually runs, so its allowed values belong to
`generator`: `gfn2` or `gfnff` for `crest`, `MMFF94`, `MMFF94s` or `UFF` for `obabel`, and `UFF` for
the in-app `uff` route (fixed). An `imported` block stores `method: ""` — the file's producer owns
that claim, and the input's `energyMethod` carries it. An Open Babel block's `method` is the force
field, and the queue writes `--ff MMFF94` (or `MMFF94s`/`UFF`) from it; the pre-#240 `ff` key is
read as a legacy alias and is not written back, so there is one name per fact. A project written
before this rule stored `gfn2` on every block; on read it is migrated to the generator's real
method (`ff` selects the Open Babel field when present, otherwise `MMFF94`; a `uff` block becomes
`UFF`) rather than refused.

`rankBy` is `""` (rank by the source's own energies) or `"ml:<model>"` (`ml:aimnet2`), which ranks
by the optional scorer sidecar. The sidecar is spawned with the model id and a JSON request on
stdin; it must name its version, weights digest, dtype, device and cutoff. Its eV output is converted
explicitly to kcal/mol and Hartree and is marked `comparableWithQuantumChemistry: false`.

`source` is the ADR 0001 split: a `search` block runs `generator` on one structure; an `imported`
block ranks the ensemble of the single `input` block wired into it and owns **no** file path, energy
unit or provenance. Validation refuses an imported block with zero or several ensemble inputs.
`importPath`, `energyUnit`, `energyMethod` and `origin` are not generate settings any more; they
belong to the ensemble input.

The in-app `uff` route adds two optional keys, present only when the block states them so a project
that never chose the route serialises as before: `torsionStepDegrees` (15–360, default 120) and
`maxTrials` (1–2000, default 200). A `uff` block's `method` is `UFF` (there is no other value for
this generator), and its ensemble always records `energyUnit: kcal/mol` and `energyMethod: UFF`.

`produces` is what the block enumerates: `conformers` (the default, and what a file that omits the
key means) or `tautomers`. A tautomer block is deliberately narrow — `generator` must be `rdkit`,
`source` must be `search`, `rankBy` must be empty, `method` is stored empty, `fanOut` defaults to
true, and `maxConformers` is the candidate cap (default 16). It adds one key, present only in this
mode: `tautomerRuleset` (`rdkit-default`). The candidates are different molecules, so no energy
window, RMSD prune, population or spread is computed at this stage.

`group` is the only cross-block key a `generate` block has: two blocks with the same `group` say they
belong to the same study. It is not a protomer or tautomer judgement, and it never causes energies to
be compared or averaged — a group is a heading, not a result.

`generate.output` is the ensemble summary written back after a search:

| Key | Notes |
| --- | --- |
| `generator`, `method` | `crest`, `uff`, `obabel`, `rdkit`, `imported`, or `fixture` for a dry run. An imported ensemble records the producer's program when declared (`origin.program`), else `imported` |
| `produces`, `tautomers[]`, `truncated` | present only on a tautomer block: `produces: "tautomers"`, the candidate labels `t1, t2, …`, and whether the enumerator's cap cut the set short. Each member then carries `tautomer` and `smiles` |
| `group` | the block's study id, copied from `generate.settings.group`; empty means no group. Per block, never per member |
| `origin { program, version, method, sourceSha256 }` | what produced the ensemble; `crest`/`fixture` for a search run here, the declared program plus the digest of the imported file otherwise. Empty `program` means **not recorded**, never "computed here". A tautomer origin also carries `ruleset`, `protocol` and the enumerator `options` |
| `energyUnit`, `energyMethod` | the unit and producing method of the ensemble's absolute energies (`hartree` by default) |
| `mixedEnergies` | true when the members disagree on unit or method; such an ensemble has no populations and no spread |
| `search` | present only on an in-app `uff` ensemble: `{ method, engine, torsionStepDegrees, rmsdThreshold, trials, trialsPlanned, truncated, rotatableBonds, rotors[], excluded[], deduplicated, unique, relaxMaxIterations, bondSource, randomized, seed, electrostatics, ringSampling, comparableWithQuantumChemistry, energyKind, note }`. It is the record of a torsional grid plus UFF relaxation — no Monte-Carlo, no seed, no electrostatics |
| `count`, `total` | retained after pruning / frames read |
| `spreadKcal` | highest minus lowest retained member, null when one member or when mixed |
| `selectedId`, `selected { id, energyEh, energyKcal, energyUnit, energyMethod, relativeKcal, population, protomer, atoms[] }` | the member downstream blocks run |
| `requiresSelection`, `autoSelected`, `protomers[]` | true when more than one protomer survives, which forbids an automatic choice |
| `members[] { id, rank, energyEh, energyKcal, energyUnit, energyMethod, relativeKcal, population, rmsdToLowest, protomer, kept, dropped, atoms[] }` | ranked table; kept members carry their geometry so the choice is offline. `energyEh` is null on a `kcal/mol` member, and `energyKcal` is null on a Hartree one — the absolute energy is never moved into a field that names the other unit |
| `scorer` | present only when `rankBy` named a model: `{ model, label, version, weightsSha256, dtype, device, cutoffAngstrom, charge, multiplicity, energyKind, comparableWithQuantumChemistry: false }`. Each member also carries its own `scorer { id, energyEv, energyKcal, energyHartree, … }`; the explicit eV value is never overwritten by the converted Hartree number |
| `pruned { energy, rmsd, count }`, `warnings[]`, `generatedAt` | what was dropped and why |

A `calculate` block fed by a `generate` block runs the selected member's geometry. When no member
is selected — including every protomer case — the queue refuses to build its input rather than
falling back to the imported structure.

With `fanOut` on, the block expands into one task per **retained** member (`<nodeId>~<memberId>`), and
the fan follows the branch: every calculation that inherits its geometry or checkpoint — directly
wired or further downstream — expands the same way, so `generate → calculate → calculate` plans `opt~c1`,
`opt~c2`, `freq~c1`, `freq~c2`. On a dependency edge the downstream input is built from that member's
atoms; on a checkpoint edge `opt~c1` writes `opt_c1.chk` and `freq~c1` reads exactly that file.
Downstream `run.json` records which member a run belongs to; dataset export carries `conformer_node`,
`member`, `relative_kcal`, `population` and `protomer` columns. Two cases are refused at plan time
rather than guessed: an executable block that mixes a fanned-out branch with an unfanned one (the
member it would use is ambiguous), and the same block fanned over two different ensembles. The plan
cap names the product it exceeded: records × conformer members × blocks.

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
| `records[]` | array | at most 2 000, each `{ id, label, charge, multiplicity, coords[], bonds[]?, enabled }` |
| `notes` | string | at most 2 000 chars |

A record's `id` uses the node-id grammar because it becomes a task-id segment.
`coords[]` uses the molecule atom shape (`{ element, x, y, z }`, at most 1 000
atoms) and is required: a record with no geometry cannot run and is a
validation error. `charge` (-10 to 10) and `multiplicity` (1 to 10) default to 0
and 1. `enabled: false` keeps the record in the file but out of every run, which
is how a family member is skipped without deleting it. `bonds[]` is optional and
absent by default; when present it uses the molecule bond shape (`{ a, b, order }`,
1-based, `order` 1, 1.5, 2 or 3) and is the topology a derivative block edits —
a record without it is refused by a derivative block rather than given a
perceived one.

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
| `input` then `generate` (fan-out) then `calculate` | `opt~m2~c1` |

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

### 4.3.1 A series block (`kind: "series"`)

A structure block may carry a **series definition** instead of a plain dataset reference. It is the
same `input` node type, with `kind: "series"`: one record is the repeat unit, the linkage rule joins
copy *i* to copy *i+1*, and the range `from … to` says how many copies each member has.

```json
{ "type": "input", "kind": "series",
  "input": { "datasetId": "monomers", "recordId": "monomer",
             "recordFilter": { "field": "", "equals": "" },
             "series": { "from": 1, "to": 4,
                         "linkage": { "donor": 3, "acceptor": 8,
                                      "bondLengthAngstrom": 1.5,
                                      "leaving": [9, 10] } } } }
```

| Key | Type | Notes |
| --- | --- | --- |
| `recordId` | string | the repeat unit, one record id of the block's dataset; absent means "the only enabled record", and more than one candidate is refused |
| `series.from`, `series.to` | integer | required; `from` ≥ 1, `to` ≥ `from`, at most **24** members |
| `series.linkage.donor` | integer | required; 1-based atom index of copy *i* that forms the new bond |
| `series.linkage.acceptor` | integer | required; 1-based atom index of copy *i+1* that forms it |
| `series.linkage.bondLengthAngstrom` | number | required; the new bond's length, 0.5–4 Å |
| `series.linkage.leaving` | integer[] | optional; atoms dropped where a junction forms, ≤ 32, default `[]` |

Both keys are absent by default: a project that never asked for a series saves the same bytes it
did before, and a block whose `kind` is `"series"` without `input.series` is a validation error.

**Expansion is at plan time.** The block yields N ordinary records, one per n, and every consumer of
a record set — fan-out, conformer searches, gates, writers, the report — sees them exactly as it
sees dataset records. Member ids are `<recordId>-n<n>` (`monomer-n3`), so the parent and the n
survive in every task id, run folder and record row. Each generated record carries
`series { parentId, n, count, of, linkage, terminal }` as provenance.

**Geometry.** Each copy of the unit is the unit's own coordinates translated rigidly along the
donor → acceptor axis: every bond length and angle inside a copy is the unit's, and the junction bond
is exactly `bondLengthAngstrom` by construction. The step between copies is the unit's own
donor → acceptor distance plus that bond length — a single-bond-length step would put the donor of
copy *i+1* on the acceptor of copy *i* (0 Å). The generated geometry is **a starting point for
optimisation, not a minimum**.

**Terminal rule.** A leaving atom attached to the donor is dropped from every copy that uses its
donor (all but the first); one attached to the acceptor from every copy that uses its acceptor (all
but the last). The end copies keep their outer leaving groups, so the chain is capped at both ends
and n = 1 is the unit unchanged.

**Refusals** (before any file is written, each naming the atoms): donor = acceptor or outside the
unit; a bond that would exceed the element's standard valence; a leaving atom bonded to anything
other than the linkage atoms; copies that overlap (an atom pair below 0.5 Å); a range above 24 or
below 1; a member above 1 000 atoms. Bonds are perceived from covalent radii and counted as single
bonds, because dataset records store no bond orders — the valence guard therefore catches
over-coordination, not an over-valent multiple bond.

### 4.3.2 A derivative block (`kind: "derivative"`)

A structure block may carry an **edit list** instead of a plain dataset reference. It is the same
`input` node type with `kind: "derivative"`: each edit is applied to a parent record on its own, so
the block yields one record per edit — a substituent scan, a protonated/deprotonated pair, an
isotopologue series.

```json
{ "type": "input", "kind": "derivative",
  "input": { "datasetId": "parents", "recordId": "benzene",
             "recordFilter": { "field": "", "equals": "" },
             "edits": [ { "op": "substitute", "atom": 7, "element": "F" },
                        { "op": "isotope", "atom": 8, "mass": 2 } ] } }
```

| Key | Type | Notes |
| --- | --- | --- |
| `recordId` | string | the parent record; absent means **every enabled record**, one derived record per parent × edit |
| `edits[]` | object[] | required for `kind: "derivative"`; 1–**32** entries, each its own record (they do not chain) |
| `edits[].op` | string | required; `substitute`, `add`, `remove`, `isotope`, `protonate`, `deprotonate` |
| `edits[].atom` | integer | required; 1-based atom index, as written in the parent geometry |
| `edits[].element` | string | an element symbol; used by `substitute` and `add` |
| `edits[].mass` | integer | a mass number; used by `isotope` |
| `edits[].charge`, `edits[].multiplicity` | integer | **required** by `protonate`/`deprotonate`, optional elsewhere |

`kind` and `edits` are absent by default: a project that never asked for a derivative saves the same
bytes it did before, and a block whose `kind` is `"derivative"` without `input.edits` is a validation
error. A block cannot carry both `series` and `edits`.

**Expansion is at plan time**, exactly as for a series, and the shape of the sums is the same: one
ordinary record per edit, each one a real geometry with explicit bonds. Record ids are
`<parentId>-<op><atom>` with the distinguishing argument appended — `benzene-sub7-F`,
`benzene-iso8-2`, `water-rm9`, `water-prot1` — so no id depends on a position in the list. Each
generated record carries `derivative { parentId, operations, atomIndexBase: 1, formula, summary,
geometryStatus }`, and the planned task carries the same object, which is what a run record copies.

**Geometry.** `substitute` keeps the direction of the replaced bond, seen from the atom that stays,
and sets the new bond length to the sum of the two Cordero covalent radii; `add` places the new atom
opposite the parent atom's existing bonds (the bisector when there are several) at the same
radii-sum distance; `remove` and `isotope` move nothing; every other coordinate is copied unchanged.
The geometry is therefore **a topology with a plausible starting geometry, not a minimum**, and
`geometryStatus` says exactly `needs optimisation`.

**Refusals** (by name, before any file is written, with `code`, `atomIndex` and `element` on the
error): a parent that states no bonds; an atom index out of range; a bond referring to a missing
atom; a substitution past the element's valence; `add` to an atom with no free valence; an unknown
isotope; `protonate`/`deprotonate` without a charge or a multiplicity; two edits that produce the
same structure; a record without 3D coordinates. All of them come from the edit engine in
`src/shared/derivative.js` — the schema does not restate them.

### 4.3.3 An ensemble input (`input.kind: "ensemble"`)

ADR 0001 moves external files out of `generate`. An ensemble input names the artifact:

| Key | Type | Notes |
| --- | --- | --- |
| `kind` | `"ensemble"` | the discriminator; dataset inputs omit it |
| `path` | string | multi-XYZ file; relative paths resolve against the project file |
| `format` | `"xyz"` | the only external ensemble format this build reads |
| `energyUnit` | `hartree` or `kcal/mol` | what the file's numbers are; default `hartree` |
| `energyMethod` | string | what produced them, e.g. `MMFF94`; free text |
| `origin { program, version, method }` | object | the producer's declared provenance |
| `sourceSha256` | hex string? | **written by the queue**, not typed in; the digest of the bytes actually read |

The block runs once, before the generate block wired downstream. It writes
`queue/<id>/ensemble/<node>/ensemble.xyz` (the bytes read) and `ensemble.json`
(`{ kind, path, format, energyUnit, energyMethod, origin, sourceSha256,
frameCount, energies[] }`), and stores the summary on the block. The generate
block reads that record; it never opens the original path. A calculate block
may not consume an ensemble input directly — a generate block must rank and
select first.

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
| Series members per block | 24 |
| Edits per derivative block | 32 |
| Atoms in one series member | 1 000 |
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
project document beyond `calculate.output` (the discovered output file name and
size). Moving a `.ncs` file does not move its run history, and deleting the
app data directory does not damage a project.

## 8. Changing the format

Any change that alters the meaning or shape of an existing field requires a
`schemaVersion` bump and a documented migration or an explicit breaking-change
note in an ADR. Additive fields that an older reader would drop are also a bump,
because a save by an older build would lose them. Update this document in the
same commit as the schema change.
