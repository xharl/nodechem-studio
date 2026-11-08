# Workflows

A workflow is the graph of blocks you drew on the canvas. Running it means queueing every
calculation block and letting the scheduler decide what may start.

## The queue

Open **Run** and click **Run workflow**. The queue panel shows each task, its status and — for a
condition — the branch it released.

- Tasks run **one at a time**, in stable topological order, in a single local process.
- The queue is **persisted** under `<userData>/queues/<queueId>/queue.json`. Close the app mid-run,
  reopen it, and an interrupted task is reconciled on startup instead of being reported as complete.
- **Pause** stops after the current task; **Resume** continues; **Cancel all** stops the run.

Task statuses you will see:

| Status | Meaning |
| --- | --- |
| `pending` | Waiting for its ordering predecessors |
| `running` | Started |
| `completed` | Finished and the gates passed |
| `failed` | The engine failed, or a required gate failed |
| `needs-review` | A required gate could not be judged — never a pass |
| `blocked` | An upstream task failed, was cancelled, or an output bundle stopped the queue |
| `skipped` | The condition did not release this branch |
| `interrupted` | The app stopped while the task was running; reconciled on restart |
| `cancelled` | Stopped by **Cancel all** |

### What counts as an ordering constraint

| Edge | Ordering? |
| --- | --- |
| `dependency` | Yes |
| `checkpoint` | Yes — and it also stages the upstream checkpoint |
| `branch` (`true` / `false`) | Yes, until the condition releases exactly one of them |
| `loop` | **No.** A loop edge is control flow; treating it as a dependency would make every retry graph cyclic |

A task never starts before every ordering predecessor completed. A note counts as satisfied when
skipped. A failed, blocked or `needs-review` predecessor blocks its dependents rather than letting
them run on stale inputs.

## Conditions

A **Condition** block evaluates a small, safe expression over the upstream parsed result and releases
exactly one branch. The other subtree is marked `skipped`.

The expression language is deliberately tiny — no `eval`, no property access, no function calls
beyond `abs()` — so a project file can never execute anything:

```
expr    := or
or      := and ('or' and)*
and     := not ('and' not)*
not     := 'not' not | comparison
compare := sum (('=='|'!='|'>='|'<='|'>'|'<') sum)?
sum     := product (('+'|'-') product)*
product := unary (('*'|'/') unary)*
unary   := '-' unary | primary
primary := number | 'true' | 'false' | identifier | 'abs' '(' expr ')' | '(' expr ')'
```

Fields you may reference:

| Field | Type | Source |
| --- | --- | --- |
| `normalTermination`, `errorTermination` | boolean | Termination record |
| `scfConverged`, `scfFailed` | boolean | SCF record |
| `optimizationCompleted`, `stationaryPoint` | boolean | Optimisation record |
| `modeCount`, `imaginaryCount` | number | Frequency record |
| `minImaginary`, `absMinImaginary` | number | Frequency record |
| `freeEnergy`, `finalEnergy` | number | Thermochemistry / final energy |
| `gatePass`, `gateFail` | boolean | The run's gate verdict |

An unknown field makes the comparison **unknown**, never false. The condition block's **Unknown
policy** decides what happens then:

| Policy | Effect |
| --- | --- |
| `Block both branches` (default) | Neither branch is released; the decision is recorded as unknown |
| `Treat unknown as FALSE` | The FALSE branch is released, and the record says the value was unknown |
| `Treat unknown as TRUE` | The TRUE branch is released, and the record says the value was unknown |

A syntax error is reported as an error; an empty expression is unknown, not a pass.

Example, from the seeded project: `imaginaryCount == 1 and absMinImaginary >= 50` — exactly one
imaginary mode, at least 50 cm⁻¹.

## Loops

A **Loop** block retries its target up to **max attempts** (1–10) and records each attempt and the
exit reason. The loop edge itself is not an ordering constraint, so a retry graph stays acyclic for
the scheduler.

## Checkpoint hand-off

A checkpoint edge between two calculation blocks does two things: it orders them, and it stages the
upstream engine artifact into the downstream run folder.

| Engine | Artifact | What the downstream task receives |
| --- | --- | --- |
| Gaussian 16 | the `.chk` file | The checkpoint is copied into the run folder; the route gains `%OldChk`, `Geom=Check` and `Guess=Read` |
| xTB | `xtbrestart` | The restart file is copied into the run folder, where xTB reads it automatically |

Rules that apply to both:

- A real run **fails** when the declared upstream artifact is missing or empty — it does not invent
  one.
- A **dry run** stages a clearly labelled fixture instead, and the record says so.
- Artifact names are validated before any path join; a name that could escape the run directory is
  refused.
- A name mismatch fails with a message naming the artifact the engine actually expects (for xTB:
  `xtbrestart`, not `.chk`).

`ReadFC` on a Gaussian transition-state block requires a hand-off from a `Freq` or `Opt=CalcFC`
block; validation refuses the combination otherwise.

## Cluster export

Overflow menu (**⋯**) → **Export SLURM script set** or **Export PBS script set** writes an offline
submission folder: one scheduler script per calculation block plus a submit-all wrapper, with graph
ordering expressed as scheduler dependencies (`afterok`).

- `dependency`, `checkpoint` and `branch` edges become dependencies; `loop` edges are ignored.
- A declared checkpoint hand-off is always a dependency, even without a drawn checkpoint edge.
- Scheduler resources come from the route: `%NProcShared` → `--cpus-per-task` / `ppn`, `%Mem` →
  memory directives (MW converted at 64-bit words), scratch → `$TMPDIR`.
- Condition and loop nodes cannot be scheduled, and the export warns instead of pretending they can.
- The generated files contain **no network or submission primitives** — you submit them yourself.

**Import cluster results** turns returned outputs into run records with parsed termination and
gates. A returned error termination is never imported as a pass, and a missing output is reported
instead of being fabricated. The folder and manifest format is defined in
[`docs/CLUSTER_EXPORT.md`](../CLUSTER_EXPORT.md).

## Method ladders

A calculation block can run the same system at two to four levels of theory and be judged on how
far the results spread. Set `settings.ladder` on the block in the project file:

```json
"ladder": {
  "enabled": true,
  "toleranceKcal": 3,
  "rungs": [
    { "label": "B3LYP", "method": "B3LYP", "basis": "def2-SVP", "dispersion": "GD3BJ" },
    { "label": "PBE0",  "method": "PBE0",  "basis": "def2-SVP", "dispersion": "" },
    { "label": "M06-2X","method": "M06-2X","basis": "def2-SVP", "dispersion": "" }
  ]
}
```

The block becomes one task per rung (`<nodeId>.r1`, `.r2`, …), each with its own input file, run
folder and provenance. A dependency on the block waits for every rung; a checkpoint hand-off uses
the **primary** rung and records `ladderPrimary: true` on the downstream task, so a consumer never
picks a rung silently.

One gate covers the group, written to the queue record as `ladders.<nodeId>`:

- spread ≤ tolerance → **pass**;
- spread > tolerance → **fail**, and the rungs are marked `needs-review` so the workflow stops;
- a rung that did not run or reported no final energy → **unknown**, never a pass over the rungs
  that did run.

The spread is `(max − min) × 627.5095 kcal/mol` over the rung final energies. It measures
sensitivity; it is not an average, and no single "consensus" energy is invented from it. The workflow
report prints one table per ladder with each rung's energy and ΔE, alongside the verdict.

## Workflow report

**Report…** in the queue header writes two files for the finished queue:

- `report.html` — a self-contained document (no scripts, no network) with the outcome summary, one
  row per block (status, gate and validity verdicts, engine, level of theory, final energy, free
  energy, imaginary count, elapsed time), the methods paragraph for each block that has a run, and
  the input/output SHA-256 prefixes.
- `report.json` — the same model with a schema version, for a script or an archive.

A value a run did not report is printed as *not reported*; a dry-run task is labelled **FIXTURE**
wherever its numbers appear. The report is rebuilt from the queue record and the run folders, so it
does not depend on the app still being open.

## What stops a workflow

- An **Output bundle** block stops the queue with a recorded reason: output bundling is not
  implemented yet, so the app refuses rather than writing a half-bundle.
- A required gate that cannot be judged (`needs-review`) blocks dependents.
- A failed task blocks dependents until you fix the cause and queue again.

There is no retry-on-failure beyond an explicit Loop block, and no concurrent local scheduler: one
engine process at a time, by design.

## Next

[Results →](results.md)
