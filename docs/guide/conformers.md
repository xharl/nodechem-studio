# Conformers and protomers

A conformer block answers a question a single imported geometry cannot: *which shape did I
actually calculate?* Two conformers of the same molecule can differ by 2–10 kcal/mol, which is
often more than the method difference being studied. The block searches or imports an ensemble,
ranks it, and lets you choose the member that downstream blocks run.

**"Protomer" is the source's own label, not something this app decides.** The value is copied
from the `protomer=` token CREST writes, or from the comment of an imported frame — that is, from
whatever the program that produced the ensemble printed. The app groups and refuses to choose
across labels it can compare, but it does not know what the label means chemically: two members
with different labels may be protomers, tautomers, or a mislabelled pair. Say which when you
report the result; an ensemble that mixes labels never gets one picked automatically.

## Where it sits in a workflow

```
Structure (imported geometry)  →  Conformer ensemble  →  Opt+Freq  →  Output
```

Add the block from the palette under **Structure**. Its output is an ensemble summary, not a
calculation: it has no route, no gates and no termination record, and it is deliberately not an
engine. A calculation block downstream of it runs the selected member's geometry instead of the
project geometry.

## Two sources

| `generator` | What happens |
| --- | --- |
| `crest` | The app runs the CREST executable you chose in the run console, with `--gfn2` (or `--gfnff`) and `--nci`, plus `--chrg`/`--uhf` when charge or multiplicity are non-default. Each search runs in its own folder under the queue directory: the starting geometry is staged there as `ensemble.xyz`, so `crest_conformers.xyz`, `crest.energies` and `crest.out` land beside the file CREST was given. |
| `import` | The app reads a multi-XYZ file you point it at. Use this when CREST ran elsewhere, or when a collaborator sent the ensemble. A `crest.energies` file beside it (or `<stem>.energies`) supplies the energies for frames whose comment does not carry one. |

The app never bundles CREST. If the generator is `crest` and no executable is configured, the
queue refuses to start and says so; it does not fabricate an ensemble.

## Imported ensembles: what the block records

An imported ensemble is not a result this app computed. The block therefore records where it came
from, and says so on the card, in the inspector and in the ensemble table's caption:

- **origin** — `program`, `version` and `method` as declared on the block, plus `sourceSha256`, the
  SHA-256 digest of the file's bytes taken when the block ran. The declared fields are written by
  you; the hash is written by the queue and cannot be typed in.
- the ensemble summary in the project carries the same origin, so the claim survives save/load and
  does not depend on the queue folder. The ensemble's own `generator` is `import`; a CREST search
  records `crest` (and a dry run `fixture`) instead.

What it proves: *this file, with these bytes, produced this table*, and that you have stated which
program and method produced the file. What it does **not** prove: that the file is what you say it
is. The digest fixes the bytes, not the provenance — anyone can type `Spartan` in the program box,
and the app has no way to check a file written by another program. The hash is also not a signature:
re-exporting the same conformers changes it. Report the origin as the source's claim, not as this
app's verification.

An imported ensemble keeps `gfn2` out of its provenance: `method` on the block is the conformer
*search* method and applies to CREST only. The method that produced an imported file's energies is
`energyMethod` (free text, e.g. `MMFF94`), and it is shown next to the unit.

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
| Keep at most | 20 | Hard cap after sorting by energy; the rest are labelled `count`. |
| Temperature | 298.15 K | Boltzmann populations in the table. They describe the ensemble, not a free energy. |
| Spread warning | 2 kcal/mol | If the retained ensemble spans more than this, the downstream calculation's validity report carries a warning. |
| Fan out | off | When on, every retained member becomes its own task downstream instead of one chosen geometry. See below. |

Charge and multiplicity are sent to CREST (`--chrg`, `--uhf` as 2S) and travel with the summary.

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

A fresh `Conformer ensemble → calculation` project can be queued as it stands: the plan runs the
search first and marks the calculation **pending**, because its input can only be built from a
member geometry. The queue fails that pending calculation with the “no selected conformer” reason
instead of substituting the project geometry; the next **Run workflow** builds it from the stored
ensemble and the chosen member (a single-protomer ensemble is chosen automatically). To run the
search alone without deleting the downstream block, select the conformer block and use **Run
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
actually used, with the search-level ΔE shown alongside. Populations at the target level are not
recomputed yet — that needs an explicit temperature decision for the report.

## Protomers

When more than one protomer survives pruning, the block refuses to choose automatically: picking a
protonation state by energy alone would silently decide the chemistry. The block turns to
**Needs review**, no member is selected, and a downstream calculation refuses to build its input
until you choose one. The validity check reports the same condition.

Protomer labels are read from the frame comment (`protomer=A` or `tautomer=A`). A file without
labels is treated as one protomer, which is what a plain conformer search produces.

## Dry run

A dry run produces a three-member labelled fixture headed `FIXTURE OUTPUT — dry run, not a conformer
search`. It exercises ranking, pruning, the table and the selection path with no CREST binary. No
number from it is a chemical result.

## Provenance

The member a run used is recorded in `run.json` as `conformer { nodeId, title, generator, id,
relativeKcal, population, protomer, spreadKcal }`. A result can therefore never be read as if it had
come from the imported geometry.

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
