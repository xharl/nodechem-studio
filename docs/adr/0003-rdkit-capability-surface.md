# ADR 0003 — RDKit beyond tautomers: one chemistry sidecar, six capability families

Status: accepted — design only, no phase implemented yet · implements issue #331

Date: 2026-11-10

## 1. Context

RDKit is already accepted in this stack: BSD-3, user-installed, never bundled, spawned as a
Python sidecar — the same terms as Open Babel and Multiwfn. It is wired for exactly one
job: tautomer enumeration (`scripts/tautomer-enumerator.py`, protocol
`nodechem-tautomers/1`, `src/shared/tautomers.js`, `electron/runner/tautomerRunner.js`).

That is one submodule out of roughly a hundred. The consequences are visible in the app,
not only in the capability list:

- **No cheminformatics layer.** `docs/FEATURE-MAP.md` records "Descriptors / fingerprints:
  absent". A record carries energies, frequencies and provenance, but not a formula, an
  exact mass, a TPSA or a canonical identity. Every downstream comparison therefore
  re-derives structure from coordinates, and every report is a number table with no
  molecule in it.
- **No standardisation step.** Salts, counterions, unassigned stereocentres and
  non-canonical forms are the user's problem before the first block runs. `prepare` has
  `embed3d`, `relax` and `solvate`; none of them cleans the input.
- **No integrity check after a calculation.** A Gaussian optimisation can return a
  different molecule — a proton moved, an atom was lost, a ring opened — and every gate
  still passes, because the gates read termination and sections, never the structure.
- **No depiction.** Reports carry cube-derived figures (`FIGURE_LEVELS` in
  `src/shared/report.js`) and no 2D structure at all.

The growth path is also a trap. The obvious way to add these is one Python script per
capability, which multiplies near-identical runners, protocols, fixtures and version
probes. The tautomer script already contains the protocol that each of them would
re-invent.

Constraints in force:

- No new npm dependency. The runtime stays Electron, Vite, Vitest, concurrently, wait-on.
- The renderer has no Node and no `child_process`; it talks to main through the preload
  bridge (AGENTS.md, hard constraint 6).
- RDKit is not bundled and not installed by the app; a missing interpreter is a refusal,
  never a degradation.
- CI does not install RDKit. Tests replay committed fixtures through a fake sidecar.
- `electron-builder` does not ship `scripts/` (`package.json:45-52`), so even the tautomer
  sidecar needs a manual download today.
- Provenance discipline: no number without a program, a version and the parameters that
  produced it.

## 2. Decision

### 2.1 One sidecar, one protocol, an op registry

Add one optional sidecar, protocol `nodechem-chem/1`:

```json
{"protocol": "nodechem-chem/1", "op": "descriptors", "molecule": {...}, "options": {...}}
```

```json
{"protocol": "nodechem-chem/1", "op": "descriptors", "ok": true,
 "program": "RDKit", "version": "2026.9.1",
 "options": {...}, "result": {...}}
```

- `op` is one of: `probe`, `descriptors`, `standardize`, `embed3d`, `conformers`,
  `stereoisomers`, `integrity`, `depict`, `similarity`.
- One script (`scripts/nodechem-chem.py` plus a small package directory), one Python
  environment, one fixture corpus, one version probe.
- The tautomer protocol stays as it is. Existing projects and run folders keep their
  meaning; the tautomer op is a future migration, not a prerequisite.
- `electron/runner/tautomerRunner.js` is generalised into `SidecarRunner` (spawn,
  argv-typed, stdin JSON, stdout JSON, stderr forwarded, wall clock, `terminateTree`).
  `TautomerRunner` becomes a thin caller. Nothing about a sidecar may be duplicated per
  op.

**Probe, not a version parse.** `op: "probe"` returns the version plus capability flags
(`etkdgv4`, `determineBonds`, `drawSvg`, `shapeHelpers`, …) computed by importing and
touching each API once. Version strings are not a contract: the same RDKit reported
`2026.9.1` through `importlib.metadata` and `2026.09.1` through `rdkit.__version__` in
testing. Settings shows the probed version and the failing capability, not a minimum
number.

### 2.2 Roles are unchanged

ADR 0001 §2.5 stands. RDKit is not an engine, and this ADR does not create a block type.

| Op | Role | Block stage |
|---|---|---|
| `standardize`, `embed3d` | converter | `prepare` (`kind: standardize`, `embed3d`) |
| `conformers`, `stereoisomers` | generator | `generate` (`produces: conformers \| stereoisomers`) |
| `integrity` | analysis helper | `calculate` (post-run gate, no route) |
| `descriptors`, `similarity` | analysis helper | `analyse` |
| `depict` | analysis helper | report/inspector, not a block |

`depict` produces an SVG string in the main process; the renderer receives it over the
existing bridge. No renderer-side RDKit, no WASM.

### 2.3 Refusals are typed and never degrade

| Code | Meaning |
|---|---|
| `rdkit-missing` | the interpreter has no importable `rdkit` |
| `capability-missing` | the probe flagged an API this op needs |
| `coverage-refused` | an element, charge or multiplicity the op will not model |
| `size-refused` | a molecule beyond the op's stated limit |
| `bad-input` | malformed request, refused before RDKit runs |
| `op-failed` | RDKit raised; the message is carried through, never swallowed |

A refusal exits 2 and prints a JSON refusal on stdout, as the tautomer sidecar does. No
op may return an empty table, a fallback geometry or a silently dropped fragment.

### 2.4 Provenance

Every op records `program`, `version`, `op`, the parameters that change the answer and
`sourceSha256` where the input is a file the app wrote. Four additional rules:

- **Descriptors are versioned as a set** (`descriptorSet: "nodechem-1"`). Adding a
  descriptor later bumps the id, so an old report still says which table produced it.
- **Force-field numbers never enter an energy column.** `conformers` records MMFF94 or
  UFF in `origin.method`, exactly as the UFF generator already does; `descriptors`
  records `kind: "cheminformatics"`.
- **Identity is a triple, not one key.** A structure is compared by standard InChIKey
  (composition and stereo), `rdMolHash` `HetAtomTautomer` (constitution, ignoring the
  mobile proton) and the formula with atom counts. Standard InChI alone is not a tautomer
  test in either direction: measured with RDKit 2026.09.1, 2-pyridone and
  2-hydroxypyridine share `UBQKCCHYAOITMY-UHFFFAOYSA-N`, while acetylacetone's keto and
  enol forms share no key at all. A FixedH InChIKey separates both pairs. The 2026.09.1
  API is `rdMolHash.MolHash(mol, rdMolHash.HashFunction.HetAtomTautomer)`; `HashMol` no
  longer exists.
- **Every computed value is cached, and the key is written down.** 2D and topological
  values key on the canonical isomeric SMILES, the charge, `descriptorSet` and the RDKit
  version. 3D values (PMI, radius of gyration, SASA, shape) also key on a geometry hash,
  because one conformer's numbers must never be returned for another. The cache lives in
  the run folder (`chem-cache.json`) so it dies with the run and can be audited; a hit is
  recorded (`cache: { hit: true, key: "…" }`), and a refusal is cached too, so a molecule
  that cannot be sanitised is not retried once per fan-out member. A project-level cache
  may come later; a global one may not, unless version and set id are in its key.

### 2.5 Installation and packaging

- The app continues to require a user-provided Python with `rdkit`; `pip install rdkit`
  is the documented path. RDKit is not added to `package.json` and not bundled.
- `scripts/nodechem-chem.py` (and the tautomer script) ship with the electron-builder
  package via `extraResources` or an explicit `files` entry. The manual download in
  `docs/guide/conformers.md` stops being the only route.
- Settings exposes one interpreter field for chemistry ops, probed once; the run console
  repeats the probe result in preflight.

### 2.6 CI

No RDKit in CI. Each op gets at least one committed fixture (a real answer, recorded with
its version) and a fake sidecar that replays it, exactly as `test/fixtures/tautomers/`
does. A live-RDKit job may exist as an optional, non-blocking workflow; it is not a
required check.

## 3. Capability decisions

### 3.1 `descriptors` — `analyse` mode `chem`

A curated, versioned set rather than the ~420 public entries in `Chem.Descriptors`:
formula, exact mass, MW, logP (Crippen), TPSA, HBD, HBA, rotatable bonds, ring and
aromatic-ring counts, Fsp3, QED, formal charge, InChIKey and Murcko scaffold.

- **Lands in** a new `analyse` mode, one row per upstream record or ensemble member, so it
  feeds reports, CSV and `condition` expressions (`tpsa > 140`) without a new block type.
- **Limits** descriptors are 2D/topological unless stated; a 3D descriptor needs the
  geometry and is labelled as such. A molecule RDKit cannot sanitise is a refused row,
  not a zero.
- **Cached per §2.4** on the structure identity, so a fan-out over sixteen conformers of
  one molecule computes the 2D set once and the report says it was reused.
- **Why here** it is the cheapest visible capability and it closes the FEATURE-MAP gap
  without touching the runner.

### 3.2 `standardize` — `prepare` kind

`rdMolStandardize.Cleanup` as a deterministic 1→1 step: normalize, metal disconnection,
largest-fragment choice and salt removal, charge parent. The record states what changed —
formula and atom count before and after, fragments removed, charge before and after — and
refuses when the operation would delete the only fragment.

`FindMolChiralCenters` / `rdCIPLabeler` add a **stereo audit**: unassigned stereocentres
and unassigned double bonds are reported as validity warnings before a calculation runs.

### 3.3 `embed3d` — `prepare` converter

ETKDGv4 plus MMFF94/UFF as a second converter for `prepare.embed3d`, beside Open Babel.
`converterFor()` gains the branch; the provenance records the embed version, the seed and
the force field. Open Babel stays the default so no existing project changes behaviour.

### 3.4 `conformers` — `generate` generator

ETKDGv4 embedding, MMFF94 or UFF optimisation, then the **existing** curation: energy
window, RMSD prune, retention cap, fan-out. The sidecar returns geometries and energies;
it does not decide what is kept.

- **Measured, one thread** (xeyve, RDKit 2026.09.1): aspirin, 13 heavy atoms, 50 conformers
  — 0.20 s embed, 0.37 s MMFF, 50/50 converged. Caffeine, 14 heavy — 0.14 s + 0.57 s.
  A 62-heavy-atom taxol fragment — 122 s embed, 25 s MMFF, 22/50 converged.
- **Limits** a stated heavy-atom cap with `size-refused`, thread control, and a warning
  that this is a force-field search, not CREST. It is not offered as a replacement for a
  QM search on flexible molecules.
- **Why here** `generate` is already a multi-generator contract; CREST, UFF and Open Babel
  coexist, and the ensemble file, fan-out and provenance are shared.

### 3.5 `stereoisomers` — `generate` candidate kind

`EnumerateStereoisomers` enumerates stereoisomers as its **own** `produces: "stereoisomers"`
value — separate from `tautomers` in the schema, the op and the report. The schema rejects
any generator other than `rdkit`, exactly as it does for tautomers.

The candidate contract is shared (labels, SMILES, per-candidate geometry, fan-out, no
energies, a warning that these are distinct molecules); the **geometry policy is not**.
Measured with RDKit 2026.09.1, `EnumerateStereoisomers` copies the input conformer onto
every candidate: all four stereoisomers of a test molecule carried the same coordinates
(RMSD 0.0000 between them). Carrying those coordinates forward would label an inverted
centre with the geometry of the original. So every candidate except the one identical to
the input is embedded with ETKDGv4, and `geometry.source` records which. The tautomer
carry-over rule must not be reused here.

### 3.6 `integrity` — post-run gate

Perceive the final geometry (`rdDetermineBonds`) and compare it with the molecule the block
was given. The comparison is a **perception from coordinates, not a measurement**, so it
answers three separate questions instead of returning a boolean:

- **composition** — formula and atom counts before and after;
- **constitution** — `HetAtomTautomer` hash and FixedH InChIKey, which ignore the mobile
  proton and the charge form;
- **configuration** — standard InChIKey and isomeric SMILES.

Statuses: `match`, `tautomer-changed`, `stereo-changed`, `connectivity-changed`,
`composition-changed`, `inconclusive`, `not-applicable`.

`inconclusive` is a first-class answer and is never reported as a pass. It covers
perception failure, open-shell records, multi-fragment inputs, and models where the parsed
geometry is not the whole molecule (an ONIOM QM region, QM/MM link atoms).

**Policy — default on, blocking nothing.** The gate is computed for every record, stored
on the record as `structureIntegrity`, shown as a validity warning and as a report column.
It never fails a run by default. A block may opt into `integrity: "fail"`, and only
`composition-changed` and `connectivity-changed` are eligible: a lost atom is almost never
legitimate, while a proton transfer, a tautomerisation or an inverted centre can be the
chemistry the user asked for. Stereo and tautomer changes stay warnings even when refusal
is on.

The default is not "fail" for four reasons. A distance-based heuristic that can be wrong
must not destroy a finished calculation. A false positive teaches users to switch the check
off, and then the real positive is missed. Existing projects would turn red on upgrade.
And termination, SCF convergence and exit code say nothing about identity: the honest claim
is "the run converged, and here is what it converged to", not "the run is invalid".

Scope: jobs with one final geometry (SP, Opt, Freq, Opt Freq, TS) and the endpoint of an
IRC or scan, labelled as a path comparison. Imported records are `not-applicable`; a
counterpoise monomer compares against its own input; ONIOM compares the model region and
says so.

This is the one capability that changes what the app is willing to claim about a finished
calculation, and it is why the ADR exists at all.

### 3.7 `depict` — report and inspector

`Compute2DCoords` (CoordGen) and `Draw.MolToSVG`, with optional substructure highlighting
and a grid for a candidate set. The SVG is produced in main and written into the report
artifact; the inspector shows the same string. No new dependency, no renderer-side
chemistry.

### 3.8 `similarity` — `analyse` over datasets

Morgan/RDKit/MACCS fingerprints, Tanimoto matrices, Butina clustering, Murcko scaffolds,
MCS (`rdFMCS`), R-group decomposition and matched molecular pairs. It answers "which of
these are the same kind of molecule", which the app cannot answer for a dataset today.

## 4. Delivery

Each phase is one PR and one task id; phases 0–3 need no new chemistry, only plumbing and
analysis the app already has slots for.

| Phase | Scope | Acceptance | Effort |
|---|---|---|---|
| 0 | Sidecar consolidation: `SidecarRunner`, op registry, `probe`, packaging | tautomer tests unchanged; existing project yields an identical `conformers.json`; installed build resolves the script | 2–3 d |
| 1 | `descriptors` + `analyse` mode `chem` | curated set on real and fixture records; refusal without RDKit; report and CSV columns | 3–4 d |
| 2 | `standardize` + stereo audit | before/after record; salt removal refused when it empties the molecule; warnings surfaced | 3–5 d |
| 3 | `integrity` gate | every status classified, `inconclusive` included; default warn; opt-in refusal limited to composition and connectivity | 4–6 d |
| 4 | `depict` | SVG in the HTML report and inspector; grid for a candidate set | 2–3 d |
| 5 | `conformers` | size cap, seed and force field recorded; energy-window and RMSD curation reused; CREST comparison on one fixture | 4–6 d |
| 6 | `stereoisomers` | every candidate except the input-identical one is embedded; `geometry.source` recorded; schema refuses a non-RDKit generator | 2–3 d |
| 7 | `similarity` | Tanimoto matrix, clustering and MCS on a dataset fixture | 5–7 d |

Total ~5–6 weeks; phases 0–3 ~3 weeks.

## 5. Consequences

**Positive.** One place to add a chemistry op; one protocol to test; provenance that names
the library, its version and the parameters; an integrity gate that makes a finished run
mean "the same molecule finished"; descriptors and depictions that turn records into
readable reports.

**Negative.** A second Python surface to install and support, and an `analyse` mode that
must never be confused with a calculated property. The fake-sidecar fixtures are a
permanent maintenance cost: every op needs a recorded answer, and a fixture that drifts
from the script is a silent lie.

**Risks.**

- *Scope creep into a molecule editor.* RDKit can generate from SMILES and lay out 2D, but
  it is not an editor. This ADR does not close the builder gap.
- *Descriptor provenance.* A descriptor table without `descriptorSet` and version is not
  reproducible; the versioned-set rule in §2.4 is the mitigation.
- *Force-field results read as QM.* Mitigated by `origin.method`, the existing labels, and
  a warning on every non-QM generator.
- *RDKit version drift.* The probe's capability flags, not a version comparison, decide
  whether an op runs.

## 6. Alternatives rejected

- **RDKit.js in the renderer.** The renderer has no Node by contract, the shipped bindings
  lack the force-field/conformer APIs, and a WASM build would be a second chemistry stack.
- **One script per capability.** Duplicates the protocol, the runner, the version probe and
  the fixtures per feature, and makes every future op a new integration.
- **Make RDKit an engine.** ADR 0001 §2.4: no route, no termination, no gates. It would
  create a fake engine chip and an empty record.
- **Bundle RDKit wheels.** Licence hygiene is fine (BSD-3) but the size and the Python
  version matrix are not; the stack's precedent is user-installed sidecars.
- **A new "chemistry" block type.** The six stages already have homes for every op; a
  seventh block would be a category error, not a capability.

## 7. Non-goals

pH-dependent protonation or pKa models (Epik, Dimorphite-DL are separate tools); spectra;
molecular dynamics; transition-state search; periodic systems; any energy presented as a
QM result; and a molecule builder.

## 8. Decisions taken after review

The first draft left three questions open. Xavier settled them on 2026-11-10:

- **Stereoisomers get their own `produces` value**, not a shared "candidate kind" field.
  The geometry policy differs (§3.5): tautomer coordinates can be carried over, enumerated
  stereoisomers cannot, so the two ops share the ensemble contract but not the
  implementation.
- **Caching is the default, not an option.** Keys and scope are in §2.4: identity plus
  `descriptorSet` and version for 2D values, a geometry hash as well for 3D values, a
  run-local `chem-cache.json`, hits recorded, refusals cached.
- **`integrity` is recorded on every record and refuses nothing by default.** Refusal is
  opt-in per block and limited to composition and connectivity changes; `inconclusive` is
  never a pass and never a failure (§3.6).

Those were the only open questions in the draft; everything in §2–§4 is the decision this
ADR records, and no phase is implemented yet.
