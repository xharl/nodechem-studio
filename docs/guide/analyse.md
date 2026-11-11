# Analyse blocks: arithmetic across results

A run produces numbers; a **protocol** does arithmetic with them. The Analyse block is the block that
takes results from other blocks, evaluates an expression over them, and produces a derived value
that cards, reports and downstream blocks read like any other result.

It is what makes a focal-point protocol (the CBS limit), a reaction energy (ΔE, ΔG‡, BDE) or a
convergence study expressible inside the graph instead of in a shell script after the run.

## What it is

- **Inputs**: one or more upstream blocks, each read through the same field vocabulary the CSV
  writer uses — `finalEnergyHartree`, `gibbsHartree`, `imaginaryCount`, `gapEv`, …
- **Expression**: a small, safe arithmetic language. No JavaScript, no `eval`, no globals: only
  numbers, `+ - * /`, parentheses, unary minus and a fixed function set.
- **Output**: one derived value per record of the block's scope, carried on the block's card, in the
  queue record, in the report, and in the block's own `run.json` as `kind: "derived"`.

A derived value is **never** presented as a quantum-chemical result. It has no parsed output block,
it never enters an energy column, and every card and report row names the values it was built from.

The block has two modes (issue 165), chosen with **What this block computes** in the inspector:

| `analyse.mode` | Computes |
| --- | --- |
| absent, or `"expression"` (the default) | the arithmetic this page describes — one value per record |
| `"dp4"` | DP4+ probabilities over candidate structures, from the NMR shields of the wired blocks' runs; see [DP4 and DP4+ probabilities](dp4.md) |

A project that never asks for `"dp4"` saves and plans exactly as it did before the mode existed.

A third mode, `"multiwfn"`, runs a **user-installed Multiwfn** binary as an external analysis
sidecar (issue 270). It is additive: the expression and DP4+ modes are unchanged, and a project that
never selects it saves exactly as it did. [Multiwfn analyses](#multiwfn-analyses) describes it,
including the licence and the parts that need your binary to validate.

## Multiwfn analyses

Multiwfn is the de facto reference implementation for wavefunction analyses the app does not
compute itself. The block runs it in **batch mode** — a fixed stdin menu script and `-silent`, never
the interactive GUI — and normalises the text it prints into a JSON record. Multiwfn is **not
bundled**: you install it, choose the binary in the run console (or `ncs run --multiwfn <path>`),
and the record says which binary ran.

### Licence and citation

Multiwfn is free for academic and non-profit use with citation; commercial use needs the author's
permission. Every result card and every `run.json` carries:

> Tian Lu, Feiwu Chen, *J. Comput. Chem.* **2012**, *33*, 580–592. doi:10.1002/jcc.22885

The app does not redistribute the binary. Check Multiwfn's own terms before packaging this app for
other users.

### Version pin

The menu numbers are pinned to **Multiwfn 3.8**. They are transcribed from the 3.8 manual examples
(topology analysis, basin analysis, quantitative molecular surface, grid export and NCI), and a
different release renumbers them. A binary whose banner is not a 3.8 banner is refused by name — the
block does not guess that a newer menu still means the same thing. A point release inside the band
(`3.8.1`, `3.8(dev)`) is accepted, because the banner says the menus are the same generation; a
banner the block cannot read at all is its own refusal, since "unknown version" is not permission to
use 3.8 menu numbers.

### Analyses in v1

| `analysis` | Reads | Parameters | Normalised result |
| --- | --- | --- | --- |
| `qtaim` | `.wfn`, `.wfx`, `.fchk`, `.molden` | `grid` = basin grid quality 1–4 (default 2) | `basins` (population, volume, volume at ρ > 0.001), `atomicCharges`, `criticalPoints`, and a comparison with the in-app `qtaim.js` when the input is a formatted checkpoint |
| `esp` | `.wfn`, `.wfx`, `.fchk`, `.molden`, `.cube` | `grid` (points per axis, default 80), `isovalue` (density surface, default 0.001 a.u.) | `volume`, `surfaceArea` (overall/positive/negative), `potential` (min/max and averages, a.u. and kcal/mol), `polarity` |
| `elf` | `.wfn`, `.wfx`, `.fchk`, `.molden` | `grid` (points per axis, default 80) | an ELF cube and its value range, mean and grid |
| `lol` | `.wfn`, `.wfx`, `.fchk`, `.molden` | `grid` (points per axis, default 80) | a LOL cube and its value range, mean and grid |
| `rdg` | `.wfn`, `.wfx`, `.fchk`, `.molden` | `grid` = NCI grid quality 1–4 (default 2), `isovalue` (RDG s, default 0.5), `rhoCutoff` (default 0.05 a.u.) | `points` in the sign(λ₂)ρ / RDG plane, ranges and attractive/repulsive counts |

An analysis that is not in this table is refused by name. A format the analysis does not read (a
cube for QTAIM, for example) is refused with both the file and the formats it does read.

### Input

Exactly one of:

- `input.nodeId` — an upstream block wired into the analyse block; its run folder supplies the first
  `.fchk`/`.wfx`/`.wfn`/`.molden`/`.cube` in the order the analysis prefers;
- `input.runId` — a specific upstream run id in the same queue;
- `input.path` — a project-relative path, e.g. `wavefunctions/water.fchk`. It may not be absolute or
  contain `..`, so a project keeps its own data inside its folder.

A block with no input source, two sources, or an unsupported extension is refused at save time. A
run folder with no readable wavefunction, a file that is empty, a formatted checkpoint without a
density matrix, and a missing or non-3.8 Multiwfn binary are each **named failures**; none is
reported as `unknown`.

### What the record holds

The block writes its own `run.json` under the queue's `analyse/` folder, with:

- `provenance.version` — the Multiwfn version read from its banner;
- `provenance.menuVersion` and `provenance.menuScript` — the pinned 3.8 recipe and the exact bytes
  fed to stdin;
- `provenance.input.sha256` — the SHA-256 of the wavefunction the run read;
- `provenance.citation`, `provenance.licence`, `provenance.executable` and `provenance.argv`;
- `multiwfn` — the normalised result, and `analyse` — the block's declaration and one-line summary.

The results card and the workflow report print the same normalised numbers and the same provenance;
neither reads the raw transcript.

### QTAIM compared with the in-app analysis

When the input is a formatted checkpoint, a QTAIM run also records `multiwfn.comparison`, matching
each Multiwfn `(3,-1)` critical point to the in-app `qtaim.js` bond by connected atom labels (with a
0.1 Å coordinate fallback). The stated tolerances are ρ 1×10⁻³ e·bohr⁻³, ∇²ρ 1×10⁻² e·bohr⁻⁵,
ellipticity 1×10⁻² and BCP position 0.05 Å. Every difference is printed; a mismatch is not averaged
away. The in-app code integrates **no basins**, so basin populations have no in-app counterpart and
are not compared — the card says so.

### What is not validated yet

This build's Multiwfn tests use **synthetic transcripts** written in Multiwfn 3.8's printed layout.
They prove the parser, the menu script, the provenance and the refusal paths; they do **not** prove
that a real Multiwfn 3.8 binary agrees with the in-app QTAIM on a real wavefunction, nor that the
menu numbers are right for a binary other than the one they were transcribed from. A first run
against your installed 3.8 binary is the validation step; if it prints a different table, the parser
refuses rather than inventing a number, and the raw `multiwfn.out` is kept beside `run.json` for the
fix.

### Wiring it

1. Add an Analyse block and choose **Multiwfn analysis of a wavefunction** under *What this block
   computes*.
2. Choose the analysis, then exactly one input: an upstream block, a run id, or a project-relative
   path.
3. Set the parameters the analysis lists. The inspector shows the exact pinned menu script.
4. Choose the **Multiwfn** binary in the run console (or pass `--multiwfn` to `ncs run`) and queue
   the workflow. A dry run spawns nothing and records that the sidecar did not run.

## Wiring an analyse block

1. Wire the blocks whose results it reads into the analyse block with ordinary dependency edges.
   Only wired-in blocks can supply a number; a block that is not wired cannot be named.
2. Declare an **input** for each number: a name (`E4`, `G`, `n`), a field, and the upstream block it
   comes from. When exactly one block feeds the analyse block, the source may be left empty.
3. Write the expression using those names, e.g. `fit_cubic_inverse(E4, 4, E2, 2)`.
4. Read the preview. It is computed by the same evaluator, from the same records, that the plan and
   the queue use — the number in the inspector is the number the run will write.

## Fields

A field is a column of the dataset export, so an analyse input and a CSV column name the same
quantity:

| Field | Unit |
| --- | --- |
| `finalEnergyHartree` | Hartree |
| `gibbsHartree` | Hartree |
| `ladderCbsHartree` | Hartree |
| `fchkTotalEnergyHartree` | Hartree |
| `gapEv`, `homoEv`, `lumoEv`, `hardnessEv` | eV |
| `conformerRelativeKcal`, `conformerSpreadKcal`, `ladderSpreadKcal` | kcal/mol |
| `scfCycles`, `imaginaryCount`, `conformerPopulation`, `unpairedElectrons` | dimensionless |
| `elapsedSeconds` | s |
| `mullikenChargeSum`, `mullikenChargeDeviation` | e |

A field a record does not carry is **null**, never zero.

## The expression language

```
expression := term (('+' | '-') term)*
term       := unary (('*' | '/') unary)*
unary      := ('+' | '-') unary | primary
primary    := number | name | name '(' [expression (',' expression)*] ')' | '(' expression ')'
```

`−`, `×` and `÷` may be typed instead of `-`, `*` and `/`; so may an en dash (as a minus) and a middle
dot (as a times), which is what a formula pasted out of a paper usually carries. Numbers may be
written `2`, `-2.5`, `.5`, `1.0e-3`.

| Function | Arity | Result |
| --- | --- | --- |
| `sum(a, …)` | 1+ | sum; accepts a record set |
| `mean(a, …)` | 1+ | arithmetic mean; accepts a record set |
| `min(a, …)`, `max(a, …)` | 1+ | extremes; accept a record set |
| `sqrt(x)` | 1 | square root (a negative argument is refused) |
| `abs(x)` | 1 | absolute value |
| `fit_cubic_inverse(E_A, X_A, E_B, X_B)` | 4 | two-point X⁻³ extrapolation |
| `extrapolate_CBS(E_A, X_A, E_B, X_B)` | 4 | the same fit, under the protocol's name |
| `hartree_to_kcal(E)`, `kcal_to_hartree(E)` | 1 | the only unit conversions, stated on the result |

Arithmetic on a record set is refused; reduce it with `sum`, `mean`, `min` or `max`.

## CBS extrapolation

The two-point inverse-cube limit is built in, because the formula and its assumptions belong in one
place where they can be tested:

```
E_CBS = (E(X)·X³ − E(Y)·Y³) / (X³ − Y³)
```

`extrapolate_CBS(E4, 4, E2, 2)` reads two energies at two cardinal numbers. Both cardinal numbers
must be positive and different; a zero, negative or repeated cardinal number is refused by name. The
formula is written into the result's notes, and the report repeats it, so a reader never mistakes the
extrapolated number for one an engine printed.

The fit is arithmetic on total energies. It is not the same thing as the correlation-energy
extrapolation on a method ladder, which is a separate, more careful calculation described in
[Reports](reports.md); an analyse block is the general tool, and it trusts the expression you write.

## Units

Unit propagation is deliberately conservative:

- a sum, difference, mean, min or max keeps the unit only when every operand agrees;
- an expression that multiplies or divides two **inputs** with units gets no unit at all — the block
  will not claim Hartree² or a dimensionless ratio it cannot justify;
- the CBS and conversion helpers state their unit outright, and refuse an argument whose declared
  unit makes the call impossible (eV into a Hartree fit, or a count into either).

## Per-record mode

An analyse block inside a dataset's scope evaluates **once per record**, exactly as a calculation block
runs once per record: one derived value per molecule, per record row. An input declared with
`scope: records` instead reads every record of its upstream block at once, which is how `sum`,
`mean`, `min` and `max` produce a family-wide number.

## Refusals

Nothing is guessed and nothing is zero:

- a field a record does not carry: `not computed: finalEnergyHartree missing for record mol-2` — the
  other records keep their values;
- a block whose upstream has not run yet is **waiting**, not wrong: the task is blocked with the
  block it is waiting for;
- division by zero, a non-finite result, an unknown function, a wrong arity, an unknown identifier,
  unbalanced parentheses, a trailing token, a character that is not part of the language: each is
  refused by name, with its position in the expression;
- an empty expression, one longer than 2000 characters, or more than 24 declared inputs is refused at
  save time — a protocol is a line, not a script.

## Where the value appears

- **Inspector**: the expression, the input table, the live preview, and the refusal or value.
- **Card**: the derived value with its unit, its expression, and every input (record, field, value,
  unit).
- **Queue and `run.json`**: the block writes its own record with `kind: "derived"` and an `analyse`
  block carrying the expression, the resolved inputs and the value — and no `parsed` block, so
  nothing can read it as a run.
- **Report**: a "Derived quantity" section with the methods sentence that states the expression the
  value came from.

## Next

- [Reports](reports.md) — the record-grouped per-flow report and the combined report across flows.
- [Workflows](workflow.md) — the queue, conditions, loops, checkpoint hand-off, cluster export.
- Back to the documentation index: [README](README.md).
