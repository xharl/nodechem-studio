# Conformers and protomers

A conformer block answers a question a single imported geometry cannot: *which shape did I
actually calculate?* Two conformers of the same molecule can differ by 2–10 kcal/mol, which is
often more than the method difference being studied. The block searches or imports an ensemble,
ranks it, and lets you choose the member that downstream blocks run.

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
| `crest` | The app runs the CREST executable you chose in the run console, with `--gfn2` (or `--gfnff`) and `--nci`, plus `--chrg`/`--uhf` when charge or multiplicity are non-default. |
| `import` | The app reads a multi-XYZ file you point it at. Use this when CREST ran elsewhere, or when a collaborator sent the ensemble. |

The app never bundles CREST. If the generator is `crest` and no executable is configured, the
queue refuses to start and says so; it does not fabricate an ensemble.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Energy window | 10 kcal/mol | Members above the lowest energy by more than this are pruned and labelled `energy`. |
| RMSD threshold | 0.5 Å | Members whose best-fit RMSD to an already-kept member is below this are pruned and labelled `rmsd`. |
| Keep at most | 20 | Hard cap after sorting by energy; the rest are labelled `count`. |
| Temperature | 298.15 K | Boltzmann populations in the table. They describe the ensemble, not a free energy. |
| Spread warning | 2 kcal/mol | If the retained ensemble spans more than this, the downstream calculation's validity report carries a warning. |

Charge and multiplicity are sent to CREST (`--chrg`, `--uhf` as 2S) and travel with the summary.

## Reading the table

Each row is one member: id, energy relative to the lowest, Boltzmann population, RMSD to the
lowest, and the protomer label when the source provided one. Pruned members stay visible with the
reason they were dropped — hiding them would make the ensemble look cleaner than it was.

Press **use** on any kept row to make that member the geometry downstream blocks run. The choice is
stored in the project with the member's atoms, so it survives a restart and does not depend on the
queue folder still existing.

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
  accepted) or be accompanied by nothing else — an ensemble without energies cannot be ranked.

## Next

- [Results](results.md) — what the downstream run reports, including the conformer warning.
- [Workflows](workflow.md) — how the queue orders blocks and refuses an unbuilt input.
