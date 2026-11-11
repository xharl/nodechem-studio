# The canvas

The graph **is** the workspace. A project is a set of blocks and the connections between them; the
workflow queue runs that graph in dependency order.

## Blocks

**Add block** opens the palette. Search filters on title, note and type; `Ctrl`/`Cmd`+`K` opens it
from anywhere.

| Group | Block | What it is |
| --- | --- | --- |
| Calculations | Optimization | Geometry minimum |
| | Optimization + frequency | One job, two stages |
| | Frequency | Thermochemistry and modes |
| | IRC path | Forward / reverse intrinsic reaction coordinate |
| | PES scan | Coordinate scan |
| | Single point | Energy at a geometry |
| | Population analysis | Charges and orbitals |
| | Emission (vertical) | TD at the optimised excited-state geometry ([details](results.md#emission)) |
| | NTO analysis | Second job of the `Pop=NTO` chain ([details](results.md#natural-transition-orbitals)) |
| Structure | Prepare structure | Embed 3D or UFF-relax one structure ([details](conformers.md#preparing-one-structure-first)) |
| | Generate structures | Search or import a conformer / protomer ensemble, rank and choose one ([details](conformers.md)) |
| Control flow | Condition | TRUE / FALSE branches |
| | Loop | Retry with max attempts |
| | Join | Merge branches |
| | Analyse | Safe arithmetic over upstream results; DP4+ probabilities ([details](analyse.md)) |
| Data | Dataset input | Run the graph once per record ([details](datasets.md)) |
| | Ensemble input | Read an external multi-XYZ ensemble ([details](conformers.md#sources)) |
| | Output file | HTML, CSV, JSON or ZIP artifact ([details](outputs.md)) |
| Project | Note | Annotation on the canvas |
| | Checkpoint hand-off | Applied to a connection, not a block |

New blocks snapshot the project's current defaults. Changing the defaults afterwards does not
rewrite blocks that already exist — that is deliberate, so a saved workflow keeps the route it was
built with.

Two limits matter in practice: an **Output file** block writes its artifact (HTML, CSV, JSON or ZIP)
but only under the output folder — a path that would escape it is refused — and a **Join** with
policy `any` still waits for every input before it is ready.

## Connections

Drag from a block's output port to another block's input port. Which ports a block has depends on
its type:

- **Output** (right edge) on an ordinary block, and **output below** (bottom edge) once that block
  already carries a downward connection,
- **TRUE** and **FALSE** ports on a Condition,
- a **loop back** port on a Loop,
- a **dataset output** port on the right of a Dataset or Ensemble input, and only an input port on
  an **Output file**, which is terminal.

The legend under the canvas names the edge types:

| Edge | Colour in the legend | Meaning in the queue |
| --- | --- | --- |
| dependency | solid blue | Ordering constraint |
| checkpoint | dashed teal | Ordering **and** a checkpoint hand-off |
| true | solid green | Ordering on the branch the condition released |
| false | dashed amber | Ordering on the branch the condition released |
| loop | dashed violet | Control flow only — **not** an ordering constraint |

The two branch edges are one `branch` type, labelled TRUE or FALSE on the edge itself. A drawn
dependency edge is tinted by the state of the block it feeds — teal when it passed, red when it needs
review, faded when it is blocked — so the legend shows the colour of an edge to a block that has not
run yet.

A `loop` edge is not a dependency, otherwise every retry graph would be cyclic. An ordinary cycle is
refused when you draw it. **Validate** re-checks the whole graph and reports blocking findings
without making the project unsaveable.

## Block states

The canvas badge shows where a block stands:

| Badge | Meaning |
| --- | --- |
| Passed | The last run of this block completed and its gates passed |
| Ready | Inputs are satisfied; it can run |
| Needs review | A gate or check could not be judged — never treated as a pass |
| Blocked | An upstream block failed, was cancelled, or the graph path never released |
| Timed out | The queue stopped it at its wall-clock limit; the output was not parsed, so there is nothing to review |

These badges reflect the project's **saved** state. During a queue run, trust the workflow queue
panel instead: it is the live status of each task, including `skipped` and `interrupted`.

## The inspector

Selecting a block fills the inspector. The same fields are grouped the same way for every
calculation block:

| Group | Fields |
| --- | --- |
| Job | Engine (or *Project default*), `Provider` for an ML scorer instead of an engine, job type, title, `Time limit (s)`, the fields a job type adds (IRC direction, optimisation convergence, force constants, SCF reference), and `Memory` + unit, `Cores (nproc)` and `Checkpoint file` — those last three are **Gaussian only**, while a PySCF block gets `Threads (OMP_NUM_THREADS)` in their place |
| Method & basis | Route preset, method, basis set, dispersion, SCF convergence, integration grid, population analysis, frontier-orbital descriptors, output verbosity, matrix element file — ORCA, Psi4 and PySCF each list their own methods and bases here |
| Molecule | Charge, multiplicity |
| Solvation | Implicit solvation switch, model, solvent (the models are the engine's own) |
| xTB | Hamiltonian, optimisation level, `Threads (OMP_NUM_THREADS)` — **xTB only** |
| Gates | Normal termination, SCF record, imaginary modes, `Min \|ν\|`, thermochemistry, post-HF final energy |
| Extra keywords | Free route keywords — Gaussian only |
| Validity checks | Per-block switches for the checks in [Results](results.md#validity-checks); the group is not shown on an xTB block |
| Dependencies | Incoming edges, the upstream blocks they come from, and the checkpoint hand-off |

Groups that only apply to some blocks appear with them: constraints and QST structures on a Gaussian
optimisation, the excited-state fields on a Gaussian block, and NMR shieldings on an `NMR` job. The
Raman, VCD and ROA switches sit in every Gaussian block and stay disabled until the job is a
frequency job, because they add to the `Freq` keyword rather than define the job.

Selecting a **connection** opens its own inspector: the endpoints, the edge type, and on a checkpoint
edge a **Clear hand-off** button — a plain dependency offers **Pass checkpoint** when the upstream
block leaves a restart file. Selecting empty canvas shows the project inspector — name, next action,
readiness counts, the molecule summary, the project defaults with **Edit defaults**, and the
validation summary.

Which fields appear is decided per engine, not by hand: in an xTB project the Gaussian resource
fields are hidden **and** stripped from the run payload, so a hidden field can never turn up in an
argv. See [Engines](engines.md#which-settings-belong-to-which-engine).

## Layout controls

The inspector is docked on the right at every width; below 1150 px it floats inside the window
instead of taking a column, and below 820 px it becomes a bottom sheet. Its header carries the
**compact/wide** toggle (⇤ / ⇥), and the topbar's **Molecule** button opens the molecule drawer
(**Project settings…** in the **⋯** menu holds the route defaults). The canvas keeps its own zoom
(**−**, **+**, **Fit** and a percentage readout).

## Keyboard

| Key | Action |
| --- | --- |
| `Ctrl`/`Cmd`+`K` | Open the block palette and search |
| `Ctrl`/`Cmd`+`,` | Open **Settings…** (machine and application settings) |
| `Ctrl`/`Cmd`+`Z` | Undo the last project edit |
| `Ctrl`/`Cmd`+`Shift`+`Z` or `Ctrl`/`Cmd`+`Y` | Redo |
| `Esc` | Close the drawer, the project or app menu, the palette — or cancel a pending connection |
| `Enter` / `Space` | On a focused block: select it. On a focused port: start a connection, then finish it on the target block |
| `Tab` | Move focus between blocks and ports |

Removal is explicit rather than a keystroke: **Delete** in the block inspector removes a block,
**Duplicate** copies one, and a selected connection offers **Remove connection**.

## Next

[Engines →](engines.md)
