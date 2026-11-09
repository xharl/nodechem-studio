# ADR 0001 — Block taxonomy: six data stages, two axes, one contract per block

- **Status:** Proposed — for review, not yet implemented
- **Date:** 2026-11-09
- **Deciders:** Xavier (product), Hermes (implementation)
- **Supersedes:** the ad-hoc block list in `src/shared/projectSchema.js` (`NODE_TYPES`)

---

## 1. Context

The project format has nine block types, accumulated feature by feature:

```
input · calc · conformers · condition · loop · merge · output · compute · note
```

They are not a taxonomy. `calc` covers nineteen job types; `conformers` covers four
programs (CREST, in-app UFF, Open Babel, RDKit) *and* file import; `compute`
covers arithmetic over records; `pop` and `nto` are analysis-sounding names that
are really engine jobs. Two recent extensions made the problem visible:

- `obabel` was added as a conformer **generator**, not an engine, because the
  engine contract (route → log → termination → canonical parse → gates) cannot
  be honestly filled by a force-field program.
- The same is about to be true of `rdkit` (ETKDGv3 + MMFF94).

Nothing in the file format says what a block *is* — only what program it happens
to call. That makes graph validation ad hoc, the palette inconsistent, and the
UI ambiguous: a force-field step looks like a quantum-chemistry job.

No external projects exist yet, so a breaking schema change is affordable now and
will not be later.

---

## 2. Decision

### 2.1 Six data stages

Every block that moves data through the graph has exactly **one** stage:

| Stage | Consumes | Produces | Runs a program with a route? |
|---|---|---|---|
| `input` | nothing (external data) | structure or ensemble | no |
| `prepare` | one structure | one structure (chemistry or geometry changed) | no — deterministic tool call |
| `generate` | one structure, or one ensemble | ensemble of candidates | optionally (a search) |
| `calculate` | one structure | run record (log, gates, canonical parse) | **yes** |
| `analyse` | ≥1 run record | table / derived series | **no** |
| `output` | ≥1 record or table | artifact (html, csv, json, zip) | no |

### 2.2 Two more axes, not stages

Control flow and annotation do not move data; they shape how the graph runs.
They are separate axes, not a seventh and eighth stage:

- **Control:** `condition`, `loop`, `merge`
- **Annotation:** `note`

### 2.3 Cardinality is part of the contract

| Stage | Cardinality |
|---|---|
| `input` | 0→1 (project/record), 0→N (dataset iteration), 0→1 artifact (ensemble) |
| `prepare` | 1→1 |
| `generate` | 1→N (search) or ensemble→N′ (curate an imported ensemble) |
| `calculate` | 1→1 (a trajectory stays inside one record) |
| `analyse` | N→1, N→N |
| `output` | N→artifact |

Cardinality is what separates `prepare` from `generate`, and it is already what
the queue and fan-out implement — this ADR makes it explicit rather than emergent.

### 2.4 The category never encodes level of theory

- CREST runs GFN2 — a quantum method — and is `generate`.
- An xTB single point is `calculate`.
- RDKit MMFF94 is `prepare` or `generate`, despite being force-field.
- A Gaussian `Pop=NTO` job is `calculate`, even though "analysis" is in its name.

If this rule drifts, CREST and RDKit become ambiguous again.

### 2.5 Program roles are unchanged and orthogonal

- **Engine** — fills the calculation contract: `buildInput`, `parse`,
  `classify`, `checkpointArtifact`, `makeFixture`. Gaussian, ORCA, Psi4, xTB.
- **Generator** — produces structures: argv or in-process call, parser,
  provenance, coverage refusal, version. CREST, UFF, Open Babel, RDKit.
- **Converter** — translates files; never a block, invoked by import/export.
- **Analysis helper** — pure functions over an existing geometry.

### 2.6 Import becomes `input`; ranking stays in `generate`

An imported ensemble is data from outside the project. It enters through an
`input` block with `kind: "ensemble"`; ranking, pruning and selection remain in
`generate`, which owns the candidate-set contract regardless of where the
candidates came from.

```
input(ensemble) ─▶ generate(curate) ─▶ calculate ─▶ analyse ─▶ output
input(molecule) ─▶ generate(search) ─▶ calculate ─▶ analyse ─▶ output
```

**Settings split.** A setting belongs to the stage that owns the fact:

| Setting | Home | Why |
|---|---|---|
| `path`, `format` | `input` | property of the artifact |
| `energyUnit`, `energyMethod` | `input` | declared by whoever produced the file |
| `origin.program`, `origin.version` | `input` | provenance of the artifact |
| `sourceSha256` | `input` | digest of the bytes read |
| `source` (`search` \| `imported`) | `generate` | how candidates arrive |
| `generator` (`crest`/`uff`/`obabel`/`rdkit`) | `generate` | search implementation |
| `method`, `ff`, `nconf`, `seed`, `torsionStepDegrees`, `maxTrials` | `generate` | search knobs |
| `energyWindowKcal`, `rmsdThreshold`, `maxConformers`, `temperature` | `generate` | curation policy |
| `selectedConformerId`, fan-out | `generate` | decision on the curated set |

`input` never runs an engine. The existing rule — reading a file requires no
program — is preserved.

### 2.7 The ensemble is a first-class edge payload

`input` materialises the ensemble record at **run time** (not plan time) and
writes it once; `generate` consumes that record and writes the curated one;
`calculate` consumes only the selected member, never the ensemble. Today this
handoff exists implicitly through `conformers.json` and `conformerForNode`;
under this ADR it becomes part of the block contract and is validated.

### 2.8 The project molecule stays ambient

The project molecule remains project state and counts as the implicit `input`.
An `input` block is required only to iterate a dataset or to ingest an external
artifact. This keeps a minimal project (`molecule → calculate`) valid and avoids
forcing a no-op block into every graph.

### 2.9 `prepare` is new and narrow

`prepare` changes one structure deterministically, without enumeration:

- `embed3d` — SMILES/2D → 3D (Open Babel or RDKit, converter role)
- `relax` — MM relaxation of one structure (Open Babel or RDKit, UFF/MMFF94)

Out of scope for v1, and refused rather than approximated: protonation-state
enumeration and tautomer enumeration — those produce sets and therefore belong
to `generate`.

---

## 3. Schema changes (schemaVersion 3)

Breaking. No compatibility layer: no external projects exist, and two
vocabularies would recreate the ambiguity this ADR removes.

| Today | Becomes | Note |
|---|---|---|
| `calc` | `calculate` | `kind` keeps the job type (`Opt`, `Freq`, `SP`, `Pop`, `NTO`, `TS`, `IRC`, `Scan`, composite) |
| `conformers` | `generate` | `source` + `generator` distinguish search from import |
| `compute` | `analyse` | modes: `aggregate` (CBS, ΔE, ratios), `inspect` (descriptors, RMSD, spectra, DP4) |
| `input` | `input` | `kind` gains `ensemble`; existing kinds (`dataset`, `series`, `derivative`, `complex`) unchanged |
| `output` | `output` | unchanged (`html`, `csv`, `json`, `zip`) |
| `condition`, `loop`, `merge` | unchanged | control axis |
| `note` | unchanged | annotation axis |
| — | `prepare` | new; `kind`: `embed3d`, `relax` |

Settings namespaces follow the type: `node.compute` → `node.analyse`; the
task field `task.conformers` → `task.generate`.

Physical queue layout (`queue/<id>/conformers/<node>/`) is **not** renamed in
the behaviour-neutral phase, so the rename PR produces no output changes. It can
be renamed with the import split.

Implementation references: `src/shared/projectSchema.js:121` (`NODE_TYPES`),
`:248` (`NODE_TYPE_KEYS`), `:21` (`SCHEMA_VERSION`), `electron/runner/queue.js:83`
(`TASK_TYPES`), `electron/runner/queue.js:295` (import branch).

---

## 4. Validation rules this makes declarative

One table replaces the scattered checks:

| Block | Rule |
|---|---|
| `input` | no structure edges in; may read files/datasets; never spawns an engine |
| `prepare` | exactly one structure in; one structure out; no method settings |
| `generate` | one structure in (search) or one ensemble in (imported); ensemble out; owns selection and fan-out |
| `calculate` | one structure in; requires an engine, an executable and a method; record out |
| `analyse` | ≥1 record in; table out; may not spawn a program |
| `output` | ≥1 record/table in; writes an artifact; nothing downstream |
| control | payload unchanged; branch/loop semantics only |
| annotation | no payload |

---

## 5. Alternatives considered

1. **Keep the type strings, add a non-persisted `category` layer.** Cheapest,
   zero migration. Rejected now that breaking changes are affordable: it leaves
   the file format saying `conformers` while the UI says "Generate", and the
   mismatch is permanent.
2. **One block per program** (an Open Babel block, an RDKit block). Rejected:
   identical contracts, duplicated fan-out/selection/provenance, and the program
   is not the user's decision axis at that point in the graph.
3. **Make Open Babel and RDKit engines.** Rejected: no route, no termination
   record, no canonical parse; it would force no-op gates and engine UI that
   does not apply.
4. **Keep import inside `generate`.** Rejected: import is artifact ingestion and
   belongs at the input boundary; keeping it inside a search block is what made
   `conformers` carry two jobs.

---

## 6. Consequences

**Good**

- Palette, inspector, report and validation share one vocabulary.
- `input` gains one meaning: bring data into the graph.
- Force-field steps stop looking like QM jobs.
- An imported Spartan ensemble becomes an artifact with its own provenance node.
- New blocks have a contract to satisfy, not a precedent to copy.

**Costs**

- Breaking schema (`schemaVersion` 2 → 3); in-repo examples rewritten.
- ~342 type-literal occurrences across ~75 files (measured), plus the
  `node.compute`/`task.conformers` property renames.
- The report, cluster export and recent-projects code all key on type strings.
- Any test that pins a type string moves with it.

**Risks**

- A wide mechanical rename can hide semantic drift. Mitigation: the rename lands
  behaviour-neutral, with the full suite green, before any stage semantics change.

---

## 7. Rollout

1. **This ADR** — agreed vocabulary.
2. **Rename + schema v3** — behaviour-neutral: types, namespaces, docs, examples,
   fixtures, tests. CI green before step 3.
3. **Import as `input(ensemble)`** — input run-time task, ensemble record,
   `generate.source`, ranking moved behind the new boundary.
4. **`prepare`** — `embed3d` and `relax` only.
5. **Declarative validation table** — one module, one test per rule.

---

## 8. Open questions

- **Selection: `generate` or `calculate`?** This ADR says `generate`; a case
  exists for selection being an explicit user decision on the ensemble card
  rather than a block setting. Decide before step 3.
- **Single-structure imports** (SDF/MOL/PDB): `input` kind `structure`, same
  run-time task. Not in v1 scope.
- **Tautomers/protomers**: `generate` with `produces: "conformers" | "tautomers"`.
  The contract fits; the schema is not in v1.
- **`analyse` DP4**: evaluation belongs in `analyse`, but the QM shifts it needs
  are `calculate`. Confirm the block reads records only.
