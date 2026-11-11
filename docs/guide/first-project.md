# Your first project

This page takes you from a cold start to a finished, saved result without needing Gaussian, xTB, or
a licence of any kind. Everything here runs the **dry run**, which is a labelled fixture.

## 1. Open the app

NodeChem Studio starts on a seeded project called **Diels–Alder TS verification**. It is a real
workflow, not a screenshot: seven blocks, seven connections, one loop.

| Block | Job | Role in the example |
| --- | --- | --- |
| Reactant optimization | `Opt` | Relax the reactant geometry |
| Reactant frequency | `Freq` | Confirm it is a minimum |
| TS guess optimization | `Opt=TS` | Find the saddle point |
| TS frequency | `Freq` | Read the imaginary mode |
| True saddle? | Condition | Test the frequency result |
| IRC path | `IRC` | Follow the reaction path (TRUE branch) |
| Re-guess TS | Loop | Retry the saddle search (FALSE branch) |

The status bar at the bottom of the canvas summarises block states — **Passed**, **Ready**,
**Needs review**, **Blocked** — next to one line of plain text about the project. The canvas badges
show the project's saved state; live status during a run is in the queue panel
(see [Workflows](workflow.md)).

### Start from a template

**New project** in the **⋯** menu opens a chooser. Pick a recipe and it replaces the graph in memory;
**Save** then asks for a new `.ncs` path. If the current project has unsaved changes, the chooser
asks before discarding them.

| Template | Blocks | Starting point |
| --- | --- | --- |
| Reactant optimization + frequency | 2 | `Opt` → `Freq`, with the frequency block requiring zero imaginary modes |
| Transition-state search | 4 | Reactant `Opt` → `Opt=TS` with `CalcFC` → `Freq`, plus a checkpoint hand-off and a note explaining the route |
| Emission from S1 (Opt then TD) | 3 | `Opt` with `TD=(NStates=1,Root=1)` → a TD single point at that minimum, plus a note on what the energy is |
| Single-point energy + NBO charges | 1 | One `SP` job with `Pop=NBO`; no frequency gates |

The TS template's frequency block requires exactly one imaginary mode at or above 50 cm⁻¹. The
emission template reports a **vertical** emission energy, not a 0-0 energy. **Blank project** is also
in the list: one empty optimisation block you configure before it runs. The four recipes are checked
in under [`examples/`](../../examples/README.md) as `.ncs` files, so you can open one directly with
**Open**.

## 2. Run one block

1. Click the **Reactant frequency** block on the canvas. The inspector on the right shows its job
   settings, gates and validity checks.
2. Click **Run** in the top bar. The local run console opens.
3. **Dry run (fixture output)** is checked. Leave the executable field empty — a dry run starts no
   process and needs no engine.
4. Click **Run selected block**.

The console reaches `completed`, prints the captured output, and then shows:

- the **gate verdict** for the block (normal termination, SCF record, imaginary modes…),
- the **Results** panel with the parsed values,
- `not reported` wherever the fixture does not contain a value.

The output is a synthetic file headed `FIXTURE OUTPUT` and the record is marked
`provenance.kind: "fixture"`. A dry run is never presented as a calculation, and none of its numbers
are chemical results.

## 3. Run the whole workflow

Click **Run workflow** in the console. The queue runs blocks in dependency order, one at a time by
default (the **Parallel tasks** field in **Run → Setup** raises that; see the [FAQ](faq.md)):

1. Reactant optimization → Reactant frequency.
2. TS guess optimization → TS frequency (a checkpoint hand-off between the two).
3. The **True saddle?** condition evaluates the TS frequency result and releases exactly one branch.
4. The branch it did not take is marked `skipped`; a block whose input never arrives is `blocked`,
   not silently run.

While it runs you can **Pause**, **Resume**, and **Cancel all**. The queue is durable: close the app
mid-run, reopen it, and the interrupted task is reconciled instead of being reported as complete.
Details, including the condition grammar, are in [Workflows](workflow.md).

## 4. Read the result

Select a finished run in **Recent runs** or in the queue. The results panel shows what the parser
actually found, with the engine named, fixture/truncated badges where they apply, and the validity
findings kept separate from the gate verdict. See [Results](results.md).

## 5. Save the project

Click **Save**. A new project prompts for a path and writes a `.ncs` file — canonical JSON, fixed key
order, byte-stable when nothing changed. The **unsaved changes** pill beside the project name
disappears.

Three details of that dialog are worth knowing. The name you choose carries exactly one `.ncs`
(`foo` becomes `foo.ncs`, `foo.ncs` stays as typed, and a doubled `foo.ncs.ncs` is collapsed to one);
saving over a file the app has not read or written this session asks first; and the next save dialog
opens in the folder the last save used.

`.ncs` is the only project extension the app accepts. The format is defined in
[`docs/PROJECT-FORMAT.md`](../PROJECT-FORMAT.md).

## 6. Use your own geometry

Open **Molecule** in the top bar. The drawer has two tabs — **Structure** and **Charge & fragments** —
plus a **Records** tab when the project holds a dataset with more than one record.

- **Structure** — import a `.xyz`, `.mol`, `.sdf`, `.mol2`, `.pdb`/`.pdbqt`, `.cjson`, `.gjf`, `.com`
  file, a ChemDraw `.cdxml`/`.cdx` drawing, or a Gaussian `.log`/`.out` (its optimisation frames become
  selectable records), with the file picker or by drag-and-drop. Element symbols, finite coordinates
  and charge/multiplicity parity are validated; Z-matrix input is refused rather than guessed.

  A file that holds more than one structure — a multi-record `.sdf`, a multi-frame `.xyz` — shows a
  **Record** selector, so you choose which one becomes the project's molecule instead of the first
  being taken silently. A `.mol`/`.sdf` that states its bonds keeps them, orders included: the 3D
  viewer draws double and triple bonds as such, and its caption says whether the bonds came from the
  file or were perceived from distances.
- **Charge & fragments** — total charge, multiplicity, fragment bookkeeping and the per-atom fragment
  partition (the labels Psi4 SAPT splits the complex at).

The project-wide route defaults are **not** in this drawer. Open **Project settings…** in the **⋯**
menu: **Engine**, the method and basis pair (or the xTB Hamiltonian and optimisation level), memory,
cores and a preview of the route a new block would be given. New blocks snapshot these defaults when
they are added; changing them later does not rewrite an existing block.

Until you import a structure, the runner uses a clearly labelled demo water geometry. Every
calculation block builds its input from the imported geometry, so one molecule drives the whole
graph.

## 7. Switch to a real engine

When you are ready to run something real:

- **xTB** — set **Engine** to `xTB (GFN-xTB)` in **Project settings…**, then pick your `xtb`
  executable in **⋯ → Settings… → Engines** (or in the run console, for one run). No licence is
  involved. Follow [Setting up xTB](engines.md#setting-up-xtb).
- **Gaussian 16** — point the run console at your licensed console executable (`g16.exe`,
  or `g16` on Linux/macOS), run **Preflight**, then uncheck **Dry run**. Follow
  [Running a real Gaussian job](engines.md#running-a-real-gaussian-job).

Read [Engines](engines.md) before your first real run: the engine can be set per block (or left to
the project default), route settings the chosen engine does not use are ignored rather than guessed
at, and a Gaussian-only request on an xTB block is refused before the run starts.

## What "done" looks like

- A saved `.ncs` project with your geometry.
- A run folder under `<userData>/runs/<runId>/` containing the exact input, the raw output and
  `run.json`.
- A gate verdict you can defend, and validity findings you have read rather than dismissed.

Nothing leaves the machine at any point.

## Next

[The canvas →](canvas.md)
