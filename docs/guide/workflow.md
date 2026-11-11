# Workflows

A workflow is the graph of blocks you drew on the canvas. Running it means queueing every
calculation block and letting the scheduler decide what may start.

## The queue

Open **Run** and click **Run workflow**. The queue panel shows each task, its status and — for a
condition — the branch it released.

Before the queue starts, preflight checks the machine facts the flow depends on. It checks **the
engines this flow's blocks run**, one row each, and lists the engines it does not run as `SKIP` with
the reason: a Psi4/ORCA workflow starts on a machine with no Gaussian licence, and Gaussian's absence
stays visible without blocking it. A failing row keeps its text in the status bar, not only in the
toast that disappears.

- Tasks run in stable topological order in a single local process, **one at a time** by default. The
  run console's **Parallel tasks** (or `runner.maxParallel` in the project) lets independent tasks run
  concurrently, up to that number; the plan's edges are the barrier, so a task still waits for every
  ordering predecessor.
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
| `blocked` | An upstream task failed, was cancelled, or could not be judged (`needs-review`, `timed out`) |
| `skipped` | The condition did not release this branch |
| `interrupted` | The app stopped while the task was running; reconciled on restart |
| `cancelled` | Stopped by **Cancel all** |
| `timed out` | Stopped at its wall-clock limit; the output was **not** parsed |

A failed row carries its reason in the row itself — wrapped, clamped to two lines, and expandable
from the keyboard; the `title` tooltip keeps the full text as a secondary copy. The same reason is
written to the console log as `Workflow failed — …`, and the hint line under **Setup** reports the
outcome. For the three common causes the row — and the hint line — also offers the fix: a missing
executable focuses the matching Setup field, an unselected conformer opens and focuses the Generate
block's member control, and a failed gate focuses the gate row.

The header and the Queue tab belong to the **project on screen**. Opening another project resets the
header to `idle · 0/0 · no run`; a queue event from a project that is not visible never changes it.
**Recent runs** names the project and start time of each queue-produced run. If the newest queue
belongs to another project, the header says `last run: <project> (other project)` instead of showing
that queue's status as if it were the open project's.

## Time limits

A hung engine must not hold a queue slot, so every task has a wall-clock limit. The limit is read
from four places, in this order:

1. the block's own **Time limit (s)** in its inspector;
2. the project's **Task time limit** in **Run → Setup**, beside *Parallel tasks*;
3. the **Settings → Runs → Task time limit** default, when the project names none;
4. the built-in default, **3600 s**.

The project setting is optional and is only written to the file when you set it — a project saved
before this existed serialises byte-identically, and the default applies at run time.

When a task reaches its limit the engine's **whole process tree** is stopped: `SIGTERM` first (a
program with a checkpoint may want to write one), then `SIGKILL` after a two-second grace period.
On Windows the tree is stopped with `taskkill /T /F`. The tree is then checked until it is gone, and
`run.json` records what the kill reported.

The outcome is `timed out`, which is **not** `failed`: the engine never gave a verdict, the queue
stopped waiting. Recording it as a failure with exit code 143 would make the report unable to tell
"the engine said no" from "we gave up". `run.json` carries:

```json
"status": "timed out",
"parsed": null,
"gates": null,
"timeout": { "limitSeconds": 60, "elapsedSeconds": 60.4, "lastOutput": " SCF Done:  E(RB3LYP) = …" }
```

`parsed` and `gates` are `null` on purpose: a log cut off mid-block is a fragment, not a result, and
it is never parsed. The queue row shows the elapsed time against the limit while a task runs, and
the block card and Next Action say it timed out and to raise the limit — there is no output to
review. Dependents are blocked, because there is no result to hand on.

Because a limit has to be chosen before the run, **Setup** names the blocks whose own parameters make
a long run likely — many excited states, an IRC path, a transition-state search, counterpoise, a
frequency job on a large system, a CREST search. That list is about shape, not duration; the
estimated duration is separate and is described next.

## Cost estimate

Before a workflow is queued, the Setup pane and every calculation card show a **range** for how long
the run will take, in wall time on the machine's core count, plus the core-seconds it will consume.
It is deliberately not a single number.

```
Estimated 12 min–47 min on 8 cores at 4 at a time · low confidence (3 points) · 5 of 5 tasks priced.
```

The model is fitted to logs that ship with the app, not to a vendor's benchmark:

| Engine | Measured jobs | What the fit uses |
| --- | --- | --- |
| Gaussian 16 | water/6-31G(d) SP, Opt, Freq; DVB/STO-3G SP, Opt, Freq, TD (5 states) | CPU and wall seconds printed by the program |
| Psi4 | water/def2-SVP MP2, CCSD(T), B3LYP Freq | user+system seconds; wall time |
| ORCA | water/STO-3G MP2; DVB/STO-3G frequency | wall time only — ORCA does not print CPU seconds here, so core-seconds equal wall seconds |
| xTB | water Opt+Freq | wall time |

Everything the logs do not settle is written down as an assumption on the card (hover it) and in
the module:

- cost scales as **Nbf³** for the SCF-sized jobs and **atom²** for xTB. Three small molecules cannot
  determine the exponent; N³ is the middle of the documented range and is labelled.
- a new DFT single point is assumed to take the **9 SCF cycles** the water anchor took; a tighter
  SCF setting adds 3.
- an optimisation is assumed to take **5 steps**; the two measured ones took 4 and 5. The measured
  per-step costs differ by a factor of seven, so the range is that measured spread — not a
  comfortable ±10 %.
- wall time divides core-seconds by `cores × 0.65`, plus a 1 s startup floor. 0.65 is an assumption;
  the water single point ran at roughly 0.3 and the 20-atom frequency job at 1.0.
- the queue's wall total is the sum over dependency levels. A level takes the larger of its slowest
  task and `tasks / concurrency × mean`, so a level cannot finish before its slowest task, and a
  5 % contention allowance is added per extra concurrent task.

Confidence follows the number of measured points behind the class: 20 or more is `high`, 5–19
`medium`, fewer than 5 `low`. The first release is `low` for everything and prints the count, as in
the example above.

**Warnings.** If the estimate exceeds the limit that will actually apply to the task (the block's
own limit, then the project's, then 3600 s), the card says the queue will stop it at that limit. If
the total is longer than an overnight run (8 hours), Setup says so — a low bound over 8 hours is
the case worth waking up to.

**Refusals.** A task the model cannot price shows a sentence instead of a number:

- a composite method (G4, CBS-QB3, …) is a toolchain of links this model does not describe;
- an engine with no committed timing measurement;
- a job type with no measurement on that engine (for example Gaussian IRC, ORCA Opt);
- a basis or element outside the basis-function table, or a geometry with no composition.

Psi4 TD-DFT is the one priced-but-unmeasured case: no Psi4 TD-DFT log is committed, so its range is
scaled from Psi4's smallest measured job by **atom count only**, says so on the card, and is wide.


Under `ncs run`, a project's `runner.timeoutSeconds` is used, and a queue with a timed-out task
exits with the engine-failure code (4) rather than reporting success.

### What counts as an ordering constraint

| Edge | Ordering? |
| --- | --- |
| `dependency` | Yes |
| `checkpoint` | Yes — and it also stages the upstream checkpoint |
| `branch` (`true` / `false`) | Yes, until the condition releases exactly one of them |
| `barrier` | Yes — across records: waits for the source block in every enabled record |
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

A **Loop** block retries its target up to **max attempts** (1–10 in the inspector; a hand-edited
project may state up to 99) and records each attempt and the exit reason. The loop edge itself is not
an ordering constraint, so a retry graph stays acyclic for the scheduler.

## Merges

A **Merge** block joins two or more branches into one. It completes when **every** upstream branch
has settled, records how many inputs it collected, and keeps the stored `policy` (`all` by default)
in the queue record — readiness itself always waits for all of them, because a downstream run on
half a branch would silently consume a partial input. A branch that failed or timed out blocks the
merge instead of releasing it. This is also how a conformer fan-out is collected again.

## Checkpoint hand-off

A checkpoint edge between two calculation blocks does two things: it orders them, and it stages the
upstream engine artifact into the downstream run folder.

| Engine | Artifact | What the downstream task receives |
| --- | --- | --- |
| Gaussian 16 | the `.chk` file | The checkpoint is copied into the run folder; the route gains `%OldChk`, `Geom=Check` and `Guess=Read` |
| xTB | `xtbrestart` | The restart file is copied into the run folder, where xTB reads it automatically |
| ORCA | `<job>.gbw` | The `.gbw` is copied into the run folder and the input gains `%moinp "<job>.gbw"` |
| Psi4, PySCF | none | Neither declares a restart file, so the edge is meant to carry the upstream parsed geometry — applied for PySCF, not yet for Psi4 (see below) |

Rules that apply to all:

- A real run **fails** when the declared upstream artifact is missing or empty — it does not invent
  one.
- A **dry run** stages a clearly labelled fixture instead, and the record says so.
- Artifact names are validated before any path join; a name that could escape the run directory is
  refused.
- A name mismatch fails with a message naming the artifact the engine actually expects (for xTB:
  `xtbrestart`, not `.chk`).

### Cross-engine edges

When the two blocks name **different** engines there is no checkpoint to carry: the edge hands over
the upstream run's parsed final geometry (`parsed.finalGeometry.atoms`) and, for the receivers that
have a rewrite, rebuilds the downstream deck from it. A **Prepare** block handing its structure to a
calculate block calls the same rewrite function.

Only two receivers have a rewrite: Gaussian (`replaceInputGeometry`) and PySCF
(`replacePyscfGeometry`).

**Known limitation (#326).** A receiving ORCA, Psi4 or xTB block keeps the geometry its deck was
planned with — the project geometry — while the queue task still records `geometryHandoff` with the
upstream run id and atom count. That field says a hand-off was read, not that the deck changed; the
workflow report prints it (`geometry from <block> · <engine> → <engine>, N atoms`) and the run still
reports `completed`. Until this is fixed, optimise with Gaussian or PySCF, or compare the deck in the
run folder with the upstream geometry.

`ReadFC` on a Gaussian transition-state block requires a hand-off from a `Freq` or `Opt=CalcFC`
block; validation refuses the combination otherwise.

## Cluster export

Overflow menu (**⋯**) → **SLURM script set…** or **PBS script set…** (offered when the project has a
calculation block) writes an offline submission folder: one scheduler script per calculation block
plus a submit-all wrapper, with graph ordering expressed as scheduler dependencies (`afterok`).

- `dependency`, `checkpoint` and `branch` edges become dependencies; `loop` edges are ignored.
- A declared checkpoint hand-off is always a dependency, even without a drawn checkpoint edge.
- Scheduler resources come from the route: `%NProcShared` → `--cpus-per-task` / `ppn`, `%Mem` →
  memory directives (MW converted at 64-bit words), scratch → `$TMPDIR`.
- Condition, loop and merge nodes cannot be scheduled, and the export warns instead of pretending
  they can: a condition's downstream work is exported with an unconditional dependency, a loop's
  retries are not exported, and a merge's calculation inputs become direct dependencies.
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

## Spin-state sweeps

Multiplicity defines the electronic state, so a sweep is a set of separate runs over the same
geometry rather than one job with a setting. It is opt-in on a calculation block: **Spin states** in
the inspector, off by default. Switching it on writes

```json
"spinSweep": { "enabled": true, "multiplicities": [1, 3, 5] }
```

A project that never switches it on keeps `"spinSweep": null` and is byte-identical to one written
before the control existed.

The inspector offers only the multiplicities the block's electron count allows — an even count gets
odd multiplicities (`1, 3, 5…`), an odd count gets even ones (`2, 4, 6…`) — up to `SPIN_SWEEP_MAX`
(6) states. A stored multiplicity that the electron count cannot have is shown struck through and
named in the inspector rather than silently dropped; the planner will not run it. A sweep needs two
distinct states, so the last two cannot be unticked; turn the switch off instead.

The block then becomes `<nodeId>.m1`, `.m3`, `.m5`, each with its own input, multiplicity in the
molecule block, run folder and provenance. The block's card says `spin states 1, 3, 5` in its footer,
and each queue row names its state (`m3 · state 2/3`) as well as the task title
(`Single-point energy — multiplicity 3`).

When every state has finished, `queue.spins.<nodeId>` carries the table — multiplicity, final energy,
ΔE in kcal/mol, ⟨S²⟩ — and the results panel of any state in the sweep renders it as **Spin-state
comparison**, with the lowest row marked *lowest computed*. The workflow report prints the same table
as one section per swept block.

- The **lowest computed** state is the lowest energy among states that actually reported one. Nothing
  is extrapolated to a multiplicity that did not run, and the table is not a ground-state
  determination: every state ran at one geometry and one level of theory, so another geometry, another
  level, or a state outside the sweep is outside the comparison. The card, the results panel and the
  report all say so.
- A state that failed, timed out or was cancelled keeps its row and is named with the queue's own
  status (and its error). It is never dropped, and no energy is invented for it.
- A degeneracy is reported as a degeneracy; the lowest multiplicity is not picked silently.
- ⟨S²⟩ comes from the annihilation output Gaussian prints (`after`), falling back to the SCF line, and
  is `null` for a restricted reference — which has S² = 0 by construction but where nothing was read.
- A block cannot be both a method ladder and a spin sweep; the plan refuses the combination instead of
  running the cross product.

## Wavefunction stability

`"stableOpt": true` adds `Stable=Opt` to the route. The run then carries a **Wavefunction stability**
gate: `pass` when Gaussian says the wavefunction is stable under the perturbations considered, `fail`
when it reports an internal instability (with the re-run instruction in the gate detail), and
`unknown` when the output contains no stability analysis — never a pass by default.

## Dispersion

`EmpiricalDispersion=` accepts `GD3BJ`, `GD3` and `D4`. D4 has a revision floor: Gaussian 16 rev.
C.01. A D4 job that comes back from an older revision gets a **Dispersion supported** gate failure
naming both the requirement and the revision the output reported (for example
`Gaussian 16 rev. A.03`), rather than a silently ignored keyword. When the output does not state a
version the gate is `unknown`.

## Workflow report

**Report…** in the queue header writes two files for the finished queue: the HTML you name in the save
dialog (default `workflow-<queueId>.html` in your documents folder) and the same model beside it as
`<name>.json`:

- the HTML — a self-contained document (no scripts, no network) with the outcome summary, one
  row per block (status, gate and validity verdicts, engine, level of theory, final energy, free
  energy, imaginary count, elapsed time), the methods paragraph for each block that has a run, and
  the input/output SHA-256 prefixes. A flow that iterates over a dataset groups those same block
  tables under one row per record.
- the JSON — the same model with a schema version, for a script or an archive.

A value a run did not report is printed as *not reported*; a dry-run task is labelled **FIXTURE**
wherever its numbers appear. The report is rebuilt from the queue record and the run folders, so it
does not depend on the app still being open.

## What stops a workflow

- An **Output** block writes its artifact when its inputs are done: `html`, `csv`, `json` or `zip`
  under the output folder, with a SHA-256 entry appended to the run manifest. A path that would
  escape the output folder, or an extension that does not match the kind, is refused before the queue
  starts.
- A required gate that cannot be judged (`needs-review`) blocks dependents.
- A failed task blocks dependents until you fix the cause and queue again.

There is no retry-on-failure beyond an explicit Loop block. Concurrency is the run console's
**Parallel tasks** value and nothing more — there is no second local scheduler — so the number of
engine processes at once is what that setting says, and 1 unless you changed it.

## Next

[Results →](results.md)
