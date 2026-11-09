# ML scorers

A machine-learned interatomic potential is a **scorer**, not an engine. It returns an energy (and
optionally forces) for a geometry; it has no route, no termination record and no canonical log, so it
cannot satisfy the engine contract. NodeChem Studio keeps it in that role on purpose.

## What a scorer can do

| Consumer | Use |
| --- | --- |
| Generate | `rankBy: "ml:aimnet2"` re-ranks a searched or imported ensemble by the model instead of the source energy. |
| Calculate | A single point: the block stays `calculate`, the provider is a scorer. |
| Prepare | `relax` with an ML potential (forces + BFGS). |

All three consumers share the same sidecar contract, domain guard and conversions:

- Generate: `rankBy`.
- Calculate: `settings.provider` keeps the block a calculate block and writes a scorer run record
  with `parsed.finalEnergy.hartree`; the engine executable is not required.
- Prepare: `converter: "aimnet2"` minimises one structure with the scorer's forces (L-BFGS with a
  line search, displacement cap, and an explicit convergence record).

## Requirements

The scorer is optional and never bundled. It runs in its own Python environment because torch is
large:

```sh
python3 -m venv ~/.venvs/aimnet2
~/.venvs/aimnet2/bin/pip install torch aimnet2
export AIMNET2_WEIGHTS=/path/to/aimnet2_weights.pt
```

Point the run console at `scripts/aimnet2-scorer.py` (or a wrapper that runs it with that venv's
Python). The sidecar reads one JSON request on stdin and writes one JSON object on stdout; see the
file header for the exact shape. Without the weights and the packages it exits 2 with a clear
message and **no energy**.

## Rules the app enforces

- **Domain guard by name, before spawn.** AIMNet2 covers H, B, C, N, O, F, Si, P, S, Cl, As, Se, Br
  and I; an element outside that list is refused with its symbol. Net charge and spin are bounded the
  same way. The app does not extrapolate.
- **Units are explicit.** The model emits eV. The result records `energyEv`, `energyKcal` and
  `energyHartree`; the ranking uses the converted Hartree value, and the original eV number is kept.
  It is never mixed silently with MMFF94 kcal/mol.
- **Provenance is mandatory.** Model, version, weights SHA-256, dtype, device, cutoff, charge and
  multiplicity must all be present, or the result is refused.
- **Never presented as QM.** The summary and every member carry
  `comparableWithQuantumChemistry: false`; the inspector says ML, and the table's method is the model
  label.

## Benchmark

A scorer ships only with the measurement it exists for. `scripts/benchmark-scorer.mjs` takes a JSON
file of incumbent and ML orderings and reports Kendall's tau per system plus the mean:

```sh
node scripts/benchmark-scorer.mjs orderings.json
```

`orderings.json`:

```json
{ "systems": [
  { "id": "system-1", "mm": ["c1", "c3", "c2"], "ml": ["c1", "c2", "c3"] }
] }
```

A tau near 1 means the scorer kept the incumbent order; near -1 means it reversed every pair. The
benchmark is separate from the app so a model is measured, not blessed.

## Next

- [Workflows](workflow.md) — how the queue orders blocks and refuses an unbuilt input.
- [Results](results.md) — how a scored record is reported.

## Back

- [Conformers and protomers](conformers.md) — search or import the ensemble a scorer ranks.
