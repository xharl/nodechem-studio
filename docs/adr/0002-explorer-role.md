# ADR 0002 — Explorers: the sixth program role

Status: proposed · Amends ADR 0001 §2.5 (roles) and clarifies §2.10

## 1. Context

ADR 0001 named five program roles: **engine**, **generator**, **scorer**,
**converter**, **analysis helper**. That vocabulary covers every program the app
spawns today except one class, and the exception is visible in the code:

- `TS`, `IRC` and `Scan` are job types, but they are not methods. A Gaussian
  `Opt=TS` run and a Psi4 `optimize` run answer different questions with the
  same block type, and neither program is interchangeable with the other at
  that level.
- `src/shared/mlRelax.js` already relaxes a geometry on an ML potential with a
  hand-rolled optimiser. It is, in everything but name, a path algorithm
  driving a scorer. The role exists in the code; it is just unnamed.
- The app cannot currently say "use Sella on the PySCF surface" or "run this
  IRC with pysisyphus instead of ORCA", because the algorithm and the energy
  source are fused into one engine choice.

The distinction the taxonomy is missing is not about programs, it is about
**what question a program answers**:

| Role | Question | Contract input | Contract output |
|---|---|---|---|
| Engine | What is the energy and gradient at this geometry? | method, basis, geometry | one record + log |
| Generator | Which distinct structures exist? | structure, search settings | ensemble |
| Scorer | How does this structure rank? | geometry | energy, forces, charges |
| **Explorer** | **Where do I go next on this surface?** | **calculator + start (and end)** | **saddle, path, or profile** |
| Converter | How do I read this file? | bytes | record |
| Analysis helper | What does this record mean? | geometry or record | numbers |

An explorer produces no energies of its own. It consumes a potential energy
surface and returns a route across it. That is why it cannot be an engine: it
has no route keyword, no method, no basis and no termination record.

## 2. Decision

Add a sixth role, **explorer**: a program that navigates a potential energy
surface exposed by a *calculator* and returns a stationary point, a path, or a
profile.

```text
calculator (engine | scorer) ──▶ explorer ──▶ saddle | path | profile
        energy(x), gradient(x)        + evidence: steps, gradients, convergence
```

The explorer never supplies an energy that becomes a result. Energies in the
record are always attributed to the calculator, with the explorer recorded as
the algorithm that chose the geometries.

**Name.** *Explorer* is chosen over *driver* (collides with the process driver
/ runner vocabulary), *optimiser* (excludes NEB, IRC and scans, which are not
optimisation), and *searcher* (collides with conformer search in `generate`).
Alternatives are in §9.

**Relationship to the generator.** Both search geometries, but their contracts
differ, and ADR 0001's rule — one block per output contract — still decides:

- A **generator** takes a structure and returns an **ensemble** of candidate
  minima. It may use gradients internally (CREST does), but its output is a
  set, not a path.
- An **explorer** takes a **calculator** and returns a **path or a saddle**.
  Its defining input is the energy source, not the structure.

## 3. The calculator contract

An explorer is only as capable as the calculator under it. The capability must
be declared, checked before the run, and refused by name when absent:

```js
{
  id: 'pyscf',
  energies: true,
  gradients: 'analytic' | 'numeric' | 'none',
  hessians: 'analytic' | 'numeric' | 'none',
  access: 'in-process' | 'subprocess',
}
```

Rules:

1. **Gradients are a capability, not an option.** Every saddle, IRC, NEB and
   GSM algorithm requires gradients. A calculator that reports
   `gradients: 'none'` may only host energy-only algorithms.
2. **The engine registry gains the declaration.** It is the sixth artifact
   every engine needs, alongside the input renderer, output parser, capability
   table, restart handler and termination classifier.
3. **A scorer is a calculator.** ADR 0001 §2.10 already routes `prepare.relax`
   through an ML potential with forces; under this ADR that relaxation is an
   explorer over a scorer. The scorer gains no new role.
4. **One calculator per exploration.** Changing level of theory mid-path
   (xTB screen then DFT refine) is a separate feature, not a v1 behaviour.

## 4. Where it appears

No new block type. Exploration is a setting on blocks whose job type is already
a path calculation:

```js
node.calculate.task = 'TS' | 'IRC' | 'Scan'
node.calculate.explorer = {
  id: 'engine-native' | 'sella' | 'pysisyphus',
  method: 'bern-y' | 'rfo' | 'gsm' | 'neb' | 'dimer',
  parameters: { maxSteps, trustRadius, ... },
}
```

- `id: 'engine-native'` is the default and reproduces today's behaviour
  (Gaussian `Opt=TS`/`IRC`/`Scan`, ORCA `OptTS`/`IRC`/`Scan`).
- The block's output contract does not change: `calculate` still produces one
  record. What changes is that the record now carries how the geometry was
  found.
- `prepare.relax` is the same pattern with a scorer as the calculator; it keeps
  its block type because it is still 1→1.

## 5. Cost model decides eligibility

| Calculator | Access | Cost per step | Eligibility |
|---|---|---|---|
| PySCF | Python import | milliseconds–seconds, in-process | default for exploration |
| Psi4 | Python import (`psi4`) | in-process | eligible |
| xTB | subprocess | ~10–100 ms | eligible with a step cap |
| Gaussian | subprocess + parse | seconds–minutes | opt-in, small systems, warning |
| ORCA | subprocess + parse | seconds–minutes | opt-in, small systems, warning |

A subprocess calculator pays process startup, scratch setup and parsing on
**every step**. The preflight must show the estimated number of steps and warn
before the run, and the queue must record each step so a runaway is visible
rather than inferred from a wall clock.

## 6. Provenance and verification

1. **The explorer's parameters are part of the record:** id, version, algorithm,
   step count, convergence criterion, trust radius, and the calculator identity
   (method, basis, program, version).
2. **The reported energy is the calculator's.** `energyUnit` and `energyMethod`
   come from the calculator; the explorer may not relabel a value.
3. **A stationary point is verified, never trusted.** Before the block passes a
   gate, the returned geometry is re-evaluated by a single point at the same
   calculator. For a saddle, a Hessian must show exactly one imaginary mode
   unless the explorer itself produced the Hessian.
4. **Disagreement is a failure.** If the explorer's final energy and the
   verification single point differ beyond the calculator's convergence
   tolerance, the run fails rather than reporting the more convenient number.
5. **Termination is mapped, not invented.** Explorers report
   `converged | max_steps | line_search_failed | calculator_failed | cancelled`
   and the app's classifier consumes that vocabulary unchanged.

## 7. What does not change

- Engines keep their contract. An engine that hosts an explorer is still
  spawned, logged and classified exactly as before.
- Blocks keep their cardinality (ADR 0001 §2.3). `calculate` stays 1→1;
  `prepare` stays 1→1.
- Scorers keep §2.10. Exploration adds a consumer, not a role.
- The project molecule stays ambient; no explorer input becomes project state.

## 8. Schema

`schemaVersion: 3` has not shipped, so this folds into it rather than bumping
again:

- `node.calculate.explorer` (optional; absent means `engine-native`)
- `run.json` gains `exploration: { id, version, method, parameters, steps,
  converged, termination, calculator }`
- `run.json` gains `verification: { energy, imaginaryModes, method }` for the
  confirming single point

## 9. Alternatives considered

1. **Make Sella/pysisyphus engines.** Rejected by the same test that excluded
   Open Babel, RDKit and ML potentials: no route, no method, no termination
   record. An engine slot would be filled with a fake route and empty gates.
2. **Add a block type per algorithm** (`sella` block, `pysisyphus` block).
   Rejected: the output contract is identical, and the algorithm is not the
   user's decision axis at that point in the graph.
3. **Keep exploration inside the engine adapter** (as `Opt=TS` is today).
   Rejected: it fuses algorithm and level of theory, which is exactly the
   confusion this ADR removes, and it makes "same surface, different algorithm"
   impossible to express.
4. **Fold the explorer into the scorer role.** Rejected: a scorer answers one
   point, an explorer answers a sequence. Different contracts, different
   failure modes, different cost.

## 10. Consequences

**Good**

- Level of theory and algorithm become independent choices.
- Open engines (PySCF, Psi4, xTB) can offer TS/IRC/scan they do not implement.
- The ML relaxation already in `mlRelax.js` gets a name and a gate.
- Each new algorithm is one sidecar plus a capability declaration, not a new
  block or a new engine.

**Costs**

- Every engine must declare gradient and Hessian capability, and the registry
  must enforce it.
- Every exploration doubles the final cost by one verification single point
  (and a Hessian for saddles).
- Subprocess calculators impose a hard cost ceiling on system size.
- Explorers are not resumable in v1: a failed run restarts from the last
  accepted geometry.

**Risks**

- A calculator with numeric gradients could be used for a saddle search and
  produce a plausible but wrong stationary point. Mitigation: numeric gradients
  are refused for saddle searches unless the user opts in, and the verification
  Hessian still has to show one imaginary mode.

## 11. Rollout

1. **This ADR** — vocabulary and contract.
2. **Capability declaration** — engines and scorers declare gradients and
   Hessians; preflight refuses incompatible combinations by name.
3. **PySCF calculator** (depends on the PySCF engine, #269) — in-process,
   analytic gradients.
4. **Sella sidecar** — saddle search on PySCF; one small case in CI.
5. **pysisyphus sidecar** — IRC, NEB, GSM on PySCF/Psi4.
6. **Subprocess calculators** — Gaussian and ORCA behind an explicit opt-in.

## 12. Open questions

- **Verification belongs to the gate or the explorer?** This ADR puts it in the
  gate so it cannot be skipped; a case exists for making it part of the
  explorer's contract so every caller gets it.
- **Does an exploration count as one queue job or N?** This ADR says one job
  with N steps; the scheduler (#64) may want per-step records for fairness.
- **Restart files:** explorers that can serialise their state (some do) would
  make long searches recoverable. Not in v1.
- **Multi-level exploration** (xTB path, then DFT refinement along the path) is
  a natural next step and deliberately out of scope here.
