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
| Control flow | Condition | TRUE / FALSE branches |
| | Loop | Retry with max attempts |
| | Join | Merge branches |
| Project | Output bundle | A publishable output folder |
| | Note | Annotation on the canvas |
| | Checkpoint hand-off | Applied to a connection, not a block |

New blocks snapshot the project's current defaults. Changing the defaults afterwards does not
rewrite blocks that already exist — that is deliberate, so a saved workflow keeps the route it was
built with.

Two limits matter in practice: the **Output bundle** block stops the queue with a recorded reason
(output bundling is not implemented yet), and a **Join** with policy `any` still waits for every
input before it is ready.

## Connections

Drag from a block's output port to another block's input port. Which ports a block has depends on
its type:

- **Output** (right edge) and **output below** (bottom edge) on ordinary blocks,
- **TRUE** and **FALSE** ports on a Condition,
- a **loop back** port on a Loop.

The legend under the canvas names the edge types:

| Edge | Colour | Meaning in the queue |
| --- | --- | --- |
| dependency | grey | Ordering constraint |
| checkpoint | teal | Ordering **and** a checkpoint hand-off |
| true | green | Ordering on the branch the condition released |
| false | amber | Ordering on the branch the condition released |
| loop | violet | Control flow only — **not** an ordering constraint |

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

These badges reflect the project's **saved** state. During a queue run, trust the workflow queue
panel instead: it is the live status of each task, including `skipped` and `interrupted`.

## The inspector

Selecting a block fills the inspector. The same fields are grouped the same way for every
calculation block:

| Group | Fields |
| --- | --- |
| Job | Job type, title, `Memory` + unit, `Cores (nproc)`, `Checkpoint file` — the three resource fields are **Gaussian only** |
| Method & basis | Route preset, method, basis set, dispersion, SCF convergence, integration grid, population analysis, output verbosity |
| Molecule | Charge, multiplicity |
| Solvation | Implicit solvation switch, model, solvent |
| xTB | Hamiltonian, optimisation level, `Threads (OMP_NUM_THREADS)` — **xTB only** |
| Gates | Normal termination, SCF record, imaginary modes, `Min |ν|`, thermochemistry, post-HF final energy |
| Extra keywords | Free route keywords |
| Validity checks | Per-block switches for the six checks in [Results](results.md#validity-checks) |
| Dependencies | Incoming edges and the upstream blocks they come from |

Selecting a **connection** opens its own inspector: an ordinary dependency, or a checkpoint edge
where you choose the upstream block and whether the hand-off is enabled. Selecting empty canvas
shows the project inspector — name, molecule summary and the same defaults the drawer edits.

Which fields appear is decided per engine, not by hand: in an xTB project the Gaussian resource
fields are hidden **and** stripped from the run payload, so a hidden field can never turn up in an
argv. See [Engines](engines.md#which-settings-belong-to-which-engine).

## Layout controls

The bottom-left **View** bar switches the inspector between **Docked** and **Overlay**, and offers
**Wide inspector** and **Molecule drawer** shortcuts. Below it, the run console docks to the bottom
of the window; the canvas keeps its own zoom (**−**, **+**, **Fit** and a percentage readout).

## Keyboard

| Key | Action |
| --- | --- |
| `Ctrl`/`Cmd`+`K` | Open the block palette and search |
| `Ctrl`/`Cmd`+`Z` | Undo the last project edit |
| `Ctrl`/`Cmd`+`Shift`+`Z` or `Ctrl`/`Cmd`+`Y` | Redo |
| `Esc` | Close the drawer, overflow menu, palette or run console — or cancel a pending connection |
| `Enter` / `Space` | On a focused block: select it. On a focused port: start a connection, then finish it on the target block |
| `Tab` | Move focus between blocks and ports |

Removal is explicit rather than a keystroke: **Delete** in the block inspector removes a block,
**Duplicate** copies one, and a selected connection offers **Remove connection**.

## Next

[Engines →](engines.md)
