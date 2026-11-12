# Conformers and protomers

A Generate block answers a question a single imported geometry cannot: *which shape did I
actually calculate?* Two conformers of the same molecule can differ by 2–10 kcal/mol, which is
often more than the method difference being studied. The block searches or imports an ensemble,
ranks it, and lets you choose the member that downstream blocks run.

**"Protomer" is the source's own label, not something this app decides.** The value is copied
from the `protomer=` token CREST writes, or from the comment of an imported frame — that is, from
whatever the program that produced the ensemble printed. The app groups and refuses to choose
across labels it can compare, but it does not know what the label means chemically: two members
with different labels may be protomers, tautomers, or a mislabelled pair. Say which when you
report the result; an ensemble that mixes labels never gets one picked automatically.

A **tautomer** block is the one exception, and it is not a label the app found: it enumerated the
candidates itself, so it writes `t1`, `t2`, … and the SMILES for each. Those labels are this app's
own (RDKit's enumeration order), not a claim copied from a file.

## Where it sits in a workflow

```
Structure (imported geometry)  →  Generate  →  Calculate (Opt+Freq)  →  Output
```

Add the block from the palette under **Structure**. Its output is an ensemble summary, not a
calculation: it has no route, no gates and no termination record, and it is deliberately not an
engine. A calculation block downstream of it runs the selected member's geometry instead of the
project geometry.

## Preparing one structure first

A **Prepare structure** block is the 1→1 stage: `relax` minimises one structure with the in-app UFF
engine (or Open Babel MMFF94, or the AIMNet2 sidecar), `embed3d` turns a SMILES into one 3D
structure with `obabel --gen3d`, and `solvate` adds a deterministic explicit solvent cluster around
the current geometry. It never enumerates protonation states, tautomers or conformers — those are
sets, and sets belong to Generate. A Calculate block wired from Prepare runs on its written
`prepared.xyz`, not on the geometry the workflow was planned with.

### Explicit solvent clusters

`solvate` places rigid solvent molecules (water, methanol or acetonitrile) on a Fibonacci shell
around the solute. The block records the solvent, molecule count, seed, shell thickness, minimum
atom distance and composition, so the same inputs rebuild the same cluster. The placement is not a
molecular-dynamics run and is not equilibrated: a single cluster is not bulk solvent, and the
record says so. The cluster is a starting geometry for a calculation, not a solvation free energy;
implicit solvation in the calculate block remains the continuum model.

## Sources

A Generate block either searches (`settings.source = "search"`) or ranks an ensemble that an
**Ensemble input** block read (`settings.source = "imported"`). The input owns the file, its energy
unit and its provenance; the generate block owns ranking and selection.

| Source | What happens |
| --- | --- |
| `crest` (search) | The app runs the CREST executable you chose in the run console, with `--gfn2` (or `--gfnff`) and `--nci`, plus `--chrg`/`--uhf` when charge or multiplicity are non-default. Each search runs in its own folder under the queue directory: the starting geometry is staged there as `ensemble.xyz`, so `crest_conformers.xyz`, `crest.energies` and `crest.out` land beside the file CREST was given. |
| `uff` (search) | The app generates the ensemble here, with UFF, and needs no external binary. See [Generating with UFF](#generating-with-uff-in-app) for what it does and does not claim. |
| `obabel` (search) | The app runs the Open Babel executable you chose in the run console: `obabel ensemble.xyz -O obabel_conformers.xyz --conformer --nconf N --ff MMFF94 --score energy --writeconformers`, then a second pass (`--energy --append Energy`) that attaches one MMFF94 energy to every frame. The search log and the scored ensemble stay in the queue folder. Open Babel is not bundled. |
| `rdkit` (search, tautomers only) | Set **Produces** to *Tautomers*. The app spawns the RDKit tautomer sidecar you chose in the run console and asks it for the tautomer set of the input geometry. See [Tautomers](#tautomers-and-protomers-rdkit) — this route produces different *molecules*, not conformers, and is never treated as a search over shapes. |
| `imported` (input) | Wire an **Ensemble input** block into the generate block and set the source to *Rank a wired ensemble input*. The input reads the multi-XYZ once; the generate block ranks that record. A `crest.energies` file beside it (or `<stem>.energies`) supplies energies for frames whose comment does not carry one. |

The app never bundles CREST. If the generator is `crest` and no executable is configured, the
queue refuses to start and says so; it does not fabricate an ensemble.

## Generating with Open Babel (MMFF94)

The `obabel` route is the force-field stage for machines with no CREST, and the
one that carries **electrostatics**. It is an external program like CREST: point
the run console at `obabel`, and the block spawns it.

- **It is a genetic-algorithm search scored on energy**, not an RMSD-diverse
  sample: `--score energy`. Open Babel's default is RMSD diversity, which picks
  shapes for being different from each other rather than for being low in
  energy.
- **Energies are evaluated in a second pass.** Open Babel's search log prints
  the best energy per generation, not one per conformer (verified on 3.1.0), so
  the app runs `--energy --append Energy` over the generated ensemble and reads
  one number per frame.
- **The numbers are kcal/mol and the record says so**: `energyUnit:
  "kcal/mol"`, `energyMethod: "MMFF94"` (or `MMFF94s` / `UFF`). An MM energy is
  not a total electronic energy and is never stored in a Hartree field.
- **The force field is the block's `method`.** `MMFF94`, `MMFF94s` and `UFF`
  are the choices, and the same value is written to `--ff`; there is no second
  `ff` key. A project saved before this rule (with `method: "gfn2"` on an
  Open Babel block) still opens: its `ff` value, or MMFF94, becomes the method.
- **Open Babel 3.2.x cannot run this search.** That series segfaults in
  `--conformer` on every molecule tested (3.1.0 runs the same command), so the
  queue reads `obabel -V` before spawning and refuses 3.2.x by version, naming
  the workaround: install 3.1.x or use the in-app UFF search. A signalled child
  is a failed search, never a completed one with an empty ensemble.
- **MMFF94 does not cover every element.** It is parameterised for H, C, N, O,
  F, Si, P, S, Cl, Br and I. An atom outside that list is refused by name before
  Open Babel is spawned; the alternative is a plausible-looking energy for a
  molecule the force field never described. This check belongs to the MMFF
  fields — a UFF search is parameterised across the periodic table and is not
  refused for an element MMFF94 lacks.
- **This is not Spartan's stage.** Spartan uses MMFF94/DLFF03 with its own
  search protocol. Re-running the same molecule with Open Babel MMFF94 is a
  different, reproducible search: on a real 84-atom 2,4-DHI-IQ ensemble the two
  ranked differently (Spearman ρ = 0.66, a near-constant ≈11 kcal/mol offset).
  The provenance line names the force field so the two are never confused.
- `MMFF94s` is offered as a separate choice because it is a different claim
  about the geometry (delocalised trigonal nitrogen flattened), not a default.

## Generating with UFF (in-app)

The `uff` route exists for machines with no CREST, and for pre-relaxing a structure before a real
calculation. It is a small, documented search — not a stand-in for CREST's basin hopping:

- **Torsion grid.** The app perceives the rotatable bonds (single, not in a ring, between two heavy
  atoms that each carry another heavy neighbour, never an amide C–N), writes the current torsion
  angle of each, and sets each one in turn to `current + k × step` for `k = 0 … 360/step − 1`. The
  grid resolution is 120° by default (60°, 90° or 180° can be chosen) and every combination is run
  in a fixed odometer order. There is no Monte-Carlo component and **no random number is drawn** —
  so there is no seed, and the same input gives the same ensemble, member for member, on every run.
- **Relaxation.** Every trial is minimised with UFF (`optimizeUff`: L-BFGS to a 0.05 kcal/mol/Å
  maximum force component, at most 800 steps per trial). A trial that stops at that cap is reported
  as such, and its last energy is shown, not called a minimum.
- **Deduplication.** Relaxed trials are sorted by energy and a trial is dropped when its
  **heavy-atom RMSD** to an already-kept member is below the block's RMSD threshold (0.5 Å by
  default). The number of collapsed trials is recorded in the ensemble's `search` record.
- **Ranking.** The survivors are ranked by the same code the CREST and import routes use, so the
  window, the population column, the spread and the table behave identically.
- **Trial cap.** The grid is `(360/step)^(rotatable bonds)`; above `maxTrials` (200 by default) it
  is truncated in the same fixed order and the ensemble says the grid was incomplete.
- **No rotatable bonds.** A rigid molecule yields exactly one member: the input geometry relaxed
  with UFF. The block says that this is a pre-relaxation, not a search.
- **Refusals.** An element outside UFF's table here (H, C, N, O, F, P, S, Cl, Br, I) is refused by
  name — e.g. `Atom 3 is Si, which UFF here does not type` — never silently treated as carbon.

**These are force-field structures and a UFF ranking, not QM results.** Every member stores its
energy in `energyKcal` (unit `kcal/mol`, method `UFF`) and `energyEh` stays `null`, because a UFF
energy is not a total electronic energy. A UFF number is not comparable with a Hartree value
anywhere in this app, and the ensemble's `search` record states that beside the numbers. What the
route cannot do, it does not pretend to do:

- **No electrostatics.** UFF here has no charge term, so polar molecules and salts are ranked
  worse than a method with one would rank them.
- **No ring-conformer sampling.** Ring bonds are never turned, so a flexible ring (and especially a
  macrocycle) keeps the conformation it arrived with; only its exocyclic torsions are searched.
- **Bond perception is a fallback.** With no bond table (an XYZ import) the app perceives
  connectivity at 1.3× the covalent-radius sum and treats every bond as single. An sp2 or aromatic
  atom is then typed as sp3, and the ensemble carries a warning saying so. Import an SDF or a
  project with bonds for a trustworthy UFF result.
- **It is not CREST and not MMFF94.** The geometries differ from GFN2/MMFF94 minima by roughly
  0.1–0.5 Å; the deliverable is "reproducible, documented, different".


## Tautomers and protomers (RDKit)

A tautomer set is not a conformer set. Two conformers are the same molecule; two tautomers are
different molecules with the same formula, and the question "which one" is answered by a
calculation per candidate, not by a shape search. Set **Produces** to *Tautomers* on a Generate
block and the block changes accordingly:

- **The enumerator is external.** `scripts/tautomer-enumerator.py` drives RDKit's
  `rdMolStandardize.TautomerEnumerator` (BSD-3; RDKit is not bundled and not installed by this app).
  The installed build ships the script under `resources/scripts/`; a source checkout uses the
  repository file. Point the run console's **Tautomer sidecar** at a Python that has `rdkit` — or at
  the interpreter with **Tautomer script** naming the file. The sidecar reads one JSON object on
  stdin (XYZ, charge, multiplicity, title, options) and writes one JSON object on stdout; the request
  is kept in the task folder as `request.json`, and the raw answer as `tautomers.json`.
- **Bonds come from the geometry.** The structure arrives as XYZ with no bond table, so the sidecar
  perceives bonds and bond orders with RDKit's `rdDetermineBonds`. Multiplicity other than 1 is
  refused: the perception assumes a closed shell, and guessing an open-shell structure would invent
  a molecule.
- **Each candidate carries a starting geometry.** When the heavy-atom order still matches the input,
  the input's coordinates are carried over; otherwise the sidecar re-embeds the candidate with
  ETKDGv3 and records that. With `relaxGeometry` on (the default) each candidate is then relaxed
  with UFF for at most 200 steps when UFF types the molecule, and the record says whether that
  converged.
- **Every candidate is labelled** `t1`, `t2`, … in the enumerator's order, with its canonical SMILES
  and formula. The block stores them as `tautomers: [...]` on the ensemble and `tautomer` on each
  member; the table and the report show both, so two rows are never told apart only by rank.
- **No energies, no populations, no pruning.** A candidate arrives without a number: the energy
  window, the RMSD prune and the Boltzmann column do not apply, and the block says so in a warning.
  The table's ΔE column is empty at this stage on purpose.
- **Fan-out is on by default.** The candidate set fans out through the same member mechanism as a
  conformer ensemble: one calculate task per candidate, each built from that candidate's geometry,
  and a downstream `Opt → Freq` chain stays per member. **Fan out** can be switched off only if you
  also pick a member, because one run of c1 answers nothing about t2.
- **The report shows the spread.** When the fanned-out runs finish, the report's tautomer section
  lists the candidates and prints *Energy spread across the candidate set: N kcal/mol* from their
  final energies at the level they ran at — and states that they are not Boltzmann-averaged.
- **Provenance is recorded in `origin`**: `program` (RDKit), `version`, `ruleset`
  (`rdkit-default`), the option set (`maxCandidates`, `maxTransforms`, `relaxGeometry`,
  `removeSp3Stereo`, `removeBondStereo`) and `sourceSha256`, the digest of the geometry that was
  enumerated. A candidate set without those facts could not be reproduced.

**Out of scope, and refused rather than approximated:** pH-dependent protonation (Epik,
Dimorphite-DL, pKa models). Charge and multiplicity are inputs. A tautomer block also cannot import
an ensemble, cannot use CREST/UFF/Open Babel, and cannot ask an ML scorer to rank the set — ranking
tautomers is a calculate-block job.

## Imported ensembles: what the blocks record

An imported ensemble is not a result this app computed. The **Ensemble input** block therefore
records where it came from, and says so on the card, in the inspector, and above the ensemble table,
whose caption states the unit and method being shown:

- **origin** — `program`, `version` and `method` as declared on the input block, plus
  `sourceSha256`, the SHA-256 digest of the file's bytes taken when the input ran. The declared
  fields are written by you; the hash is written by the queue and cannot be typed in.
- the input's summary carries that origin, so the claim survives save/load and does not depend on
  the queue folder. The generate block that ranks it records `generator` as the declared program
  when there is one (`imported` otherwise); a CREST search records `crest` (and a dry run
  `fixture`) instead.

What it proves: *this file, with these bytes, produced this table*, and that you have stated which
program and method produced the file. What it does **not** prove: that the file is what you say it
is. The digest fixes the bytes, not the provenance — anyone can type `Spartan` in the program box,
and the app has no way to check a file written by another program. The hash is also not a signature:
re-exporting the same conformers changes it. Report the origin as the source's claim, not as this
app's verification.

An imported ensemble owns no method: the generate block's settings store `method: ""`, because the
method that produced the file's energies is the input's `energyMethod` (free text, e.g. `MMFF94`),
shown next to the unit. `gfn2` therefore never appears in an imported block's provenance.

## Energy units (Hartree vs kcal/mol)

An imported file may carry absolute energies in Hartree (an SCF or xTB total) or in kcal/mol (an MM
force-field energy). The two are different claims: `−0.00064 Ha` looks like a molecular total energy,
and comparing it with an SCF result is meaningless. Set **Energies are in** to match the file before
running the block.

- `energyUnit` is `hartree` (the default, and what every file written before this field existed
  meant) or `kcal/mol`; `energyMethod` names what produced the numbers.
- A `kcal/mol` member stores its energy in `energyKcal` and leaves `energyEh` **null** — the number
  is never moved into a field that names the other unit. `relativeKcal` keeps its meaning in both
  cases: kcal/mol relative to the lowest member, which is what the window, the populations and the
  spread all use.
- The only conversion in the code is explicit: `HARTREE_KCAL` (627.5094740631) turns a Hartree
  difference into kcal/mol for the ΔE column. Nothing is converted *into* Hartree.
- An ensemble whose members disagree on unit or method is **flagged, not averaged**: the block
  reports `mixedEnergies`, prints *mixed energy units/methods — not averaged*, and reports neither
  populations nor a spread, because a Boltzmann average over an MM and an SCF energy would be a
  number no method supports. The members stay visible, with their own unit and method.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Energy window | 10 kcal/mol | Members above the lowest energy by more than this are pruned and labelled `energy`. |
| RMSD threshold | 0.5 Å | Members whose best-fit RMSD to an already-kept member is below this are pruned and labelled `rmsd`. |
| Keep at most | 20 | Hard cap, applied after the energy window and the RMSD prune, in that order; the rest are labelled `count`. |
| Temperature | 298.15 K | Boltzmann populations in the table. They describe the ensemble, not a free energy. |
| Spread warning | 2 kcal/mol | If the retained ensemble spans more than this, the downstream calculation's validity report carries a warning. |
| Fan out | off (on for tautomers) | When on, every retained member becomes its own task downstream instead of one chosen geometry. See below. |
| Produces | `conformers` | `conformers` or `tautomers`. Setting `tautomers` fixes the generator to `rdkit`, clears the xTB method, turns fan-out on and treats *Keep at most* as the candidate cap. |
| Tautomer ruleset | `rdkit-default` | Tautomer block only: the transform set the sidecar applies. Recorded in `origin.ruleset`. |
| Torsion grid | 120° | `uff` route only: the angle between trial values. Written to the project only when set. |
| Max trials | 200 | `uff` route only: the cap on relaxed trials. A grid above it is truncated and labelled as such. |
| Conformers (`--nconf`) | 20 | `obabel` route only: how many conformers the search is asked for (1–1000). |
| Rank by | energy from the source | When set to an ML scorer, that model's energies rank the ensemble instead of the source energy. See [Scorers](scorers.md). |

Charge and multiplicity are sent to CREST (`--chrg`, `--uhf` as 2S) and to the tautomer sidecar,
which keeps both in `request.json`. The UFF route ignores them: UFF here has no charge term.

## Reading the table

Each row is one member: id, energy relative to the lowest, Boltzmann population, RMSD to the
lowest, and the protomer label when the source provided one. Pruned members stay visible with the
reason they were dropped — hiding them would make the ensemble look cleaner than it was.

Press **use** on any kept row to make that member the geometry downstream blocks run. The choice is
stored in the project with the member's atoms, so it survives a restart and does not depend on the
queue folder still existing.

## Fanning the ensemble out

Choosing one member answers *which shape ran*; it does not answer *how much the answer moves with
the shape*. Turn on **Fan out** when the question is the second one. The block then stops carrying
a single geometry:

- the block becomes one task per retained member, keyed `<blockId>~<memberId>`;
- every calculation downstream of it — wired directly or reached through a chain — becomes one task
  per member too, and each task is built from that member's atoms, not from the selected one;
- connections between two fanned-out blocks pair member to member, so member `c2` never waits on `c1`;
- a merge block after the fan-out waits for every member (there is no partial-ensemble mode yet).

The search itself does not run again: the ensemble is already stored in the project, so each member
task writes its geometry into its own folder (`member.xyz`, `conformers.json`) and the downstream
run's `run.json` names the member it ran. Fan-out needs a stored ensemble, so run the block once
with fan-out off (or on, with the ensemble absent) before expanding it.

A fresh `Generate → Calculate` project can be queued as it stands: the plan runs the
search first and marks the calculation **pending**, because its input can only be built from a
member geometry. The queue fails that pending calculation with the “no selected conformer” reason
instead of substituting the project geometry; the next **Run workflow** builds it from the stored
ensemble and the chosen member (a single-protomer ensemble is chosen automatically). To run the
search alone without deleting the downstream block, select the Generate block and use **Run
selected block** — it queues just that block's search and stores the ensemble in the project.

Fan-out is refused when the ensemble mixes protomers and no member is chosen: comparing protonation
states in one ΔE table is not a conformer comparison. With a member chosen, only the kept members of
that protomer are fanned out.

The fan follows the branch, not just one edge. `conformers → opt → freq` runs one optimisation and
one frequency per retained member (`opt~c1`, `freq~c1`, …), even though only the optimisation is
wired to the ensemble. A record in scope adds its segment to every task id (`opt~m3~c1`). Each stage
reads its own member's artefacts:

- on a **dependency** edge the downstream input is built from that member's geometry;
- on a **checkpoint** edge it reads that member's checkpoint — `opt~c1` writes `opt_c1.chk`, and
  `freq~c1` reads exactly that file, never a shared `opt.chk`.

A block that mixes a fanned branch with an unfanned one, or receives two different ensembles, is
refused before queueing and names both branches: one run cannot be per-member and single-geometry at
the same time. Collect the members with a merge block when one downstream run is what you want.

The workflow report groups the fanned-out runs by member and reports ΔE at the level the runs
actually used, with the search-level ΔE shown alongside. Populations are not recomputed at the
target level: the report reuses the populations the search recorded, at the search temperature, and
labels the average that way.

## Protomers

When more than one protomer survives pruning, the block refuses to choose automatically: picking a
protonation state by energy alone would silently decide the chemistry. The block turns to
**Needs review**, no member is selected, and a downstream calculation refuses to build its input
until you choose one. The validity check reports the same condition.

Protomer labels are read from the frame comment (`protomer=A` or `tautomer=A`). A file without
labels is treated as one protomer, which is what a plain conformer search produces.

## Deriving a related structure by one edit

A protomer search explores states; a single-atom derivative — the fluorinated analogue, the
deprotonated form, the ²H isotopologue — is a graph edit on a structure that already exists, with its
parent recorded.

`src/shared/derivative.js` is that edit engine. It applies one of `substitute`, `add`, `remove`,
`isotope`, `protonate` or `deprotonate` to a molecule that states its bonds, and returns a new record
instead of changing the input. Atom indices are 1-based, as they are everywhere in the project, and
each edit is recorded in the provenance with the index it used, the before/after element and the
resulting formula.

What the record claims, and what it does not:

- **Geometry.** A substituted atom keeps the direction of the bond it replaces, with the new bond set
  to the sum of the two Cordero covalent radii; an added atom goes opposite the parent's existing
  bonds (the bisector when there are several). Every coordinate the edit did not touch is copied bit
  for bit. The result is a topology with a plausible starting geometry, **not a minimum**, so the
  record carries `needs optimisation` and has to be optimised before it is compared with anything.
- **Chemistry.** `protonate`/`deprotonate` require the resulting charge and multiplicity: they are
  never inferred. A pair that disagrees with the electron count is refused rather than written.
- **Refusals.** An out-of-range atom, a substitution on an atom that is not a single bond, a valence
  overrun, an `add` to a full-valence atom, an isotope the element does not have, and a molecule that
  states no bonds (the valence check would be a guess) are all refused by name, with the atom index
  and element.

The structure block is now wired: an `input` block with `kind: "derivative"` and an `input.edits` list
expands one record per edit at plan time, so a substituent scan, a protonated/deprotonated pair or an
isotopologue series is one block whose records every downstream block runs over. The inspector edits
the list and shows the resulting formula and `needs optimisation` as soon as the edits are valid; an
invalid one shows the engine's refusal verbatim. See
[Datasets — Derivatives](datasets.md#derivatives) for the block and its refusals.

## Groups: ensembles that belong to one study

A block ranks one ensemble, so a study with eleven distributions of one system — or one ensemble per
tautomer — cannot be one block. Set **Group id** on each block that belongs to the same study and the
blocks are visibly related without inventing a new document type or a cross-block ranking.

- The id is a plain token: 1–32 letters, digits, `.`, `_` or `-`, starting with a letter or digit. You
  type it on the block. A block with no id stands alone, and nothing is inferred from titles, protomer
  labels or position on the canvas — two blocks are grouped only if you wrote the same id on both.
- It is stored on the block's settings and copied into the ensemble summary (and `conformers.json`), so
  one block's artifacts can say it belongs with others. A group id that is not a plain token is refused
  by name when the project is validated; it is never trimmed into a different claim, and an empty id is
  simply no group.
- The card and the inspector print `group <id>` and how many blocks in the flow share it. The project
  inspector lists each group with its member blocks and each block's protomer label. The workflow report
  puts the grouped ensembles under one heading that names the group; every ensemble keeps its own
  subsection, its own table, its own unit, method and protomer label.

What the group claims: **these blocks belong to the same study**. What it does not claim: that they are
the same molecule, that a protomer label is right, or that their energies are comparable. Energies across
protonation states are not comparable without a proton reference, and the report never averages across a
group — a group is a heading, not a result.

## Dry run

A dry run produces a three-member labelled fixture whose every frame is headed
`FIXTURE ensemble — dry run, not a conformer search (member N)`. It exercises ranking, pruning, the
table and the selection path with no CREST binary. No number from it is a chemical result.

## Provenance

The member a run used is recorded in `run.json` as `conformer { nodeId, title, generator, id,
relativeKcal, population, protomer, spreadKcal }`. A result can therefore never be read as if it had
come from the imported geometry.

## UFF: the in-app force field (engine only)

UFF (Rappé et al., *J. Am. Chem. Soc.* 1992, 114, 10024) is the plan for generating an ensemble
with no external binary, because one documented parameter set covers every element it types. The
force field itself now lives in `src/shared/uff.js`: atom typing, bond stretch, angle bend,
torsion, inversion and Lennard-Jones energies in kcal/mol, an analytic gradient in kcal/mol/Å
checked against central finite differences (worst relative error below 1e-5 on water, hydrogen
peroxide, formamide, butane and benzene), and a minimiser that reports `converged: false` with its
reason instead of presenting a partial relaxation as a minimum.

It is a search route, not a separate program: the block selects it with `generator: "uff"`.
Imported ensembles come through an ensemble input, not a generator.

What a UFF result is, stated here rather than in a footnote:

- **kcal/mol, not Hartree.** A UFF energy is a force-field energy. It is not a molecular total
  energy and it cannot be compared with a CREST/GFN2 or Gaussian energy — not by difference, not by
  ranking. Anything built on it must record `energyUnit: kcal/mol` and `method: UFF`.
- **Electrostatics are off.** The nonbonded term is Lennard-Jones only, so polar molecules,
  zwitterions and salts are under-ranked. A search without electrostatics is weaker and says so.
- **It is not MMFF94 and not GFN-FF/GFN2.** UFF geometries differ from GFN2/MMFF94 minima by
  0.1–0.5 Å in the usual case. Reproducibility is the deliverable, not agreement.
- **Typing is by element and bond order only.** An element outside H, C, N, O, F, P, S, Cl, Br, I
  is refused by name. A conjugated single bond (amide, ester, aniline) is typed from its single
  bonds and relaxes pyramidal, with a warning naming the atom. The group-5 inversion barrier (P) is
  not implemented, and neither are the 3-/4-membered-ring angle corrections.

## Limits

- CREST has not been exercised against a real binary in this container; the wrapper, the argument
  construction and the failure paths are tested, and a missing executable fails loudly.
- The search uses CREST's gas-phase defaults for its level; solvation is not passed to CREST.
- Imported files must carry an energy in each frame comment (a bare negative Hartree value is
  accepted) or come with a sibling `crest.energies`/`<stem>.energies` — an ensemble with neither
  cannot be ranked.

## Next

- [Results](results.md) — what the downstream run reports, including the conformer warning.
- [Workflows](workflow.md) — how the queue orders blocks and refuses an unbuilt input.
