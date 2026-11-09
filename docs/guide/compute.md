# Compute blocks: arithmetic across results

A run produces numbers; a **protocol** does arithmetic with them. The Compute block is the block that
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

## Wiring a compute block

1. Wire the blocks whose results it reads into the compute block with ordinary dependency edges.
   Only wired-in blocks can supply a number; a block that is not wired cannot be named.
2. Declare an **input** for each number: a name (`E4`, `G`, `n`), a field, and the upstream block it
   comes from. When exactly one block feeds the compute block, the source may be left empty.
3. Write the expression using those names, e.g. `fit_cubic_inverse(E4, 4, E2, 2)`.
4. Read the preview. It is computed by the same evaluator, from the same records, that the plan and
   the queue use — the number in the inspector is the number the run will write.

## Fields

A field is a column of the dataset export, so a compute input and a CSV column name the same
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

`−`, `×` and `÷` may be typed instead of `-`, `*` and `/`. Numbers may be written `2`, `-2.5`, `.5`,
`1.0e-3`.

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
[Reports](reports.md); a compute block is the general tool, and it trusts the expression you write.

## Units

Unit propagation is deliberately conservative:

- a sum, difference, mean, min or max keeps the unit only when every operand agrees;
- an expression that multiplies or divides two **inputs** with units gets no unit at all — the block
  will not claim Hartree² or a dimensionless ratio it cannot justify;
- the CBS and conversion helpers state their unit outright, and refuse an argument whose declared
  unit makes the call impossible (eV into a Hartree fit, or a count into either).

## Per-record mode

A compute block inside a dataset's scope evaluates **once per record**, exactly as a calculation block
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
  refused by name, with its position in the expression.

## Where the value appears

- **Inspector**: the expression, the input table, the live preview, and the refusal or value.
- **Card**: the derived value with its unit, its expression, and every input (record, field, value,
  unit).
- **Queue and `run.json`**: the block writes its own record with `kind: "derived"`, the expression,
  the resolved inputs and the value — and no `parsed` block, so nothing can read it as a run.
- **Report**: a "Derived quantity" section with the methods sentence that states the expression the
  value came from.

## Next

- [Reports](reports.md) — the record-grouped per-flow report and the combined report across flows.
- [Workflows](workflow.md) — the queue, conditions, loops, checkpoint hand-off, cluster export.
- Back to the documentation index: [README](README.md).
