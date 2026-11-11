# Flows, datasets and stages

A project holds one or more **flows** — separate graphs that share the project's
molecule, defaults and datasets. A flow either runs on the single project
molecule (what every project did before flows existed) or iterates a **dataset**
of molecule records through the same blocks.

## Flow tabs

The tab strip above the canvas lists the project's flows.

| Action | Effect |
| --- | --- |
| Click a tab | Switches the canvas, inspector and run console to that flow |
| **Add flow** | Creates an empty flow; node ids are unique per flow, so `opt` may exist in two flows |
| **Duplicate** | Copies the graph without any run results — the way to design a calculation once and vary it |
| **Rename** | Changes the tab title; the id stays stable because task ids and folders use it |
| **Delete** | Refused when it is the last flow |

Flows never share edges: a connection, a `checkpointFrom` or a `loop.target`
must name a block in the same flow. Running a flow plans only that flow's blocks.

## Iterating a family

Add an **Input** block, point it at a dataset, and everything downstream runs
once per enabled record:

```
Input (12 enols) ─▶ Optimise ─▶ Frequencies ─▶ High-level SP ─▶ Report
```

No "for each" block is needed: the dataset is the loop. Task ids carry the
record (`opt~m3`), so every member gets its own run folder, run record and row in
the dataset export. A conformer fan-out inside a record adds a third segment
(`opt~m3~c1`).

A record's charge and multiplicity reach the input unless the block sets a value
other than the schema default; the record's geometry replaces the project's.
Disabling a record in the input inspector drops it from the run without deleting
it from the dataset. For a one-off, a project file can also set the input
block's `recordFilter` (`field` `id`, `label`, `charge` or `multiplicity`) to run
a single member without touching the dataset.

## Conformer fan-out in a chain

A Generate block with **Fan out** on multiplies the whole branch, not just the block wired to it.
`Input ─▶ Generate ─▶ Optimise ─▶ Frequencies` runs `opt~m3~c1` and `freq~m3~c1` for every
retained member, alongside `opt~m3~c2` and `freq~m3~c2`. Each stage keeps the member segment in its
id, builds from that member's geometry on a dependency edge, and reads that member's own checkpoint
on a checkpoint edge (`opt~m3~c1` writes `opt_m3_c1.chk`). A block that mixes a fanned branch with
an unfanned one, or receives two different ensembles, is refused before queueing and names both
branches. See [Conformers](conformers.md#fanning-the-ensemble-out).

## Stages: the barrier edge

A **dependency** edge is a per-record hand-off: `freq~m3` waits for `opt~m3`
only. A **barrier** edge waits for the whole stage:

```
Input ─▶ Optimise ═══barrier═══▶ High-level SP ─▶ Report
```

With a barrier, no `sp` task starts until **every** `opt` task is terminal. Use
it when the next stage needs the machine to itself (for example 4-core
optimisations followed by 32-core single points), when you want to inspect the
stage before committing the next one, or when a comparison table must come from
identical conditions.

The cost is real: a barrier stops pipelining, and the family idles at the fence.
With `maxParallel = 1` — the default — everything is serialised anyway, so a
barrier only changes behaviour once runs overlap.

## Parallel execution

`runner.maxParallel` (project) and the run console's "at a time" field decide how
many tasks may be in flight, up to the schema ceiling of 64. The scheduler does
not look at host cores: preflight reports the logical core count and memory it
detected, and it is your decision whether two 8-core jobs on a 4-core machine is
oversubscription you can afford. A barrier still holds at any value.

The default is 1: an existing project behaves exactly as it did. Raising it makes
independent records and independent branches overlap; ready tasks still start in
plan order, so a run is reproducible.

## Partial results

A family run that loses records is neither a pass nor a failure. The queue
reports **partial** and names the failed records; every record that did finish
keeps its results, export rows and report section. A single-molecule flow keeps
the old contract: any failure is a failure.

The plan is capped at 5 000 tasks. The refusal names the product
(`60 records × 2 conformer members × the blocks they feed`) and suggests
disabling records, turning fan-out off, or splitting the flow.

## What is not here yet

- **Groups** (frames with a per-step scheduling policy) were deferred; the
  barrier edge covers the stated need with one edge type. Nested groups and
  nested iteration are out of scope for the current format.
- **Per-record method overrides**: records carry charge and multiplicity only;
  method and basis stay block settings.
- Run folders stay flat (`runs/<runId>`), with the flow and record recorded in
  `run.json` and in `queues/<id>/records/<recordId>.json`. A per-record folder
  tree would have changed every bundle, comparison and recovery path; the data
  needed to group results is present either way.

## Next

- [Workflows](workflow.md) — the queue, conditions, loops and checkpoint hand-off.
- [Results](results.md) — what a finished run reports.
- [Projects and runs on disk](project-files.md) — the `.ncs` file and the run folder.

[Back to the documentation index](README.md)
