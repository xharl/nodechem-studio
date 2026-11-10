# Results

Two questions get answered separately, and that separation is the most important idea in this app:

- **Did the job run?** → **gates**. Normal termination, SCF convergence, the frequency record, the
  final energy. A gate result is `pass`, `fail` or `unknown`. Missing evidence is `unknown`, never
  `pass`.
- **Is the result defensible?** → **validity checks**. Charge/multiplicity parity, spin
  contamination, geometry sanity, imaginary-mode count, method/basis compatibility, counterpoise
  coverage, optimisation convergence. A check that does not apply to the selected engine (for
  example method/basis compatibility under xTB) is reported as **not applicable**, which is
  different from **unknown** ("the question applies but there is no evidence") and is never a pass.

- **How does it differ from the run before?** → **Compare**. Under a finished run, pick another
  run; the panel shows both values, the signed difference (comparison minus baseline) and flags a
  comparison across different methods, bases or engines instead of presenting it as a re-run.
  A value one run did not report stays *not reported*.

- **How do I get every run into a spreadsheet?** → **Export run dataset** in the overflow menu,
  as CSV or JSON. One row per finished run: engine, job type, method, basis, dispersion,
  solvation, status, gate and validity verdicts, energies, imaginary count, SCF cycles, elapsed
  time, dry-run flag and both hashes. A run that carries wavefunction files fills the HOMO/LUMO
  cells when the log printed no orbital table, and adds the cube statistics, the charge-sum check,
  the spin state and a digest per file. Missing values are empty cells, never zeros; a dry run
  stays flagged. The JSON envelope carries a schema version and the app version.

- **What is in this folder of old logs?** → **Batch import logs…** in the overflow menu. Pick a
  folder and every `.log`/`.out` file is parsed with the same parser a live run uses, then listed
  with its status, engine, level of theory, final energy, free energy, imaginary count and failure
  cause. The scan is read-only — nothing is imported into the project — and a file over 32 MB or
  one that cannot be read is listed as skipped with the reason.

- **How long will it take?** → the block card and **Run → Setup** show a range in wall time and
  core-seconds before anything is queued, with the confidence and the number of measured points
  behind it. A block the model cannot price says why. The estimate adds no key to the project and
  no key to `run.json`; see [Workflows → Cost estimate](workflow.md#cost-estimate).

A run can execute correctly and still be scientifically unsupported. The record states both, and
validity findings never change `gates.overall`.

## The results panel

When a run finishes, or when you select a finished run in **Recent runs** or in the queue, the panel
below the output shows what the parser actually reported:

- the **engine** that ran, and the run status,
- the **excited states** table when the job printed a TD record (energy in eV, wavelength, f and
  the dominant transitions), with a simulated UV-Vis curve whose Gaussian broadening is printed
  as an explicit FWHM — the caption says it is a simulation, not a measured spectrum. The same
  table carries a **radiative rate `k_r` and radiative lifetime `τ_r` per state**, derived from
  the printed f, with the relation and its limits printed under the table (see
  [Radiative kinetics](#radiative-kinetics-from-oscillator-strengths)). A **Psi4
  TD-DFT** run fills the same cards from Psi4's excitation table; that table also carries the
  rotatory strength in both length and velocity form, and the card prints the state's irrep and the
  allocation Psi4 used (see *Engines → Psi4*: a state request is split across irreducible
  representations, so a small request can contain no bright state at all),
- the **gate list** with its verdict and evidence,
- parsed values — termination, SCF energy and cycles, frequencies and the imaginary count, final
  energy, charges, thermochemistry when present,
- `not reported` for a field the parser did not find. It is never guessed, and an absent value is
  never rendered as zero,
- a **FIXTURE** badge on a dry-run record and a **truncated** badge when the output exceeded the
  capture limit, next to the numbers the badge affects.

The panel is a pure function of one `run.json` record: it reads no disk and invents nothing.

## Method sensitivity

Three questions get their own evidence: how far a number moves with the method, how it compares with a cited reference, and what an ensemble average is worth.

### Complete-basis-set extrapolation

A method ladder that varies the **basis set** at one level of theory can be extrapolated to the complete-basis-set (CBS) limit. The form is named on the result and is the Helgaker two-point correlation extrapolation:

```
E_corr(X) = E_corr,CBS + A · X^-3
```

`X` is the cardinal number of the basis (double-zeta 2, triple-zeta 3, quadruple-zeta 4, …). The exponent is specific to the **correlation** energy, not a universal `X^-3` fitted to the total energy. The SCF component is not extrapolated — two points cannot determine the exponential SCF fit — so the SCF energy is taken from the largest rung and the result says `SCF largest rung (def2-QZVP), not extrapolated`. The pair used is printed (`def2-TZVP → def2-QZVP`, with both `X` values).

The extrapolation is refused, with the missing input named, when:

- fewer than two rungs are present (the message names the only rung supplied);
- the two rungs share a cardinal number (`def2-TZVP` and `def2-TZVPP` are both `X = 3`);
- the rungs come from different basis families (`def2` and `cc-pVXZ` are not interchangeable);
- the rungs are at different levels of theory;
- the method has no tabulated correlation exponent (CBS extrapolation is limited to MP2, MP3, MP4, CCSD, CCSD(T), QCISD and QCISD(T));
- a rung in the pair has no SCF energy, so its correlation energy cannot be separated.

Only `cc-pVXZ`, `aug-cc-pVXZ` and `def2-XZVP`/`def2-XZVPP` carry a cardinal number here. A Pople basis such as `6-311G(d,p)` is not assigned a made-up `X`. With more than two rungs the two highest cardinal numbers are used, and the pair is shown.

A CBS estimate is still an estimate. The number is printed with the **ladder spread** it came from — for example `ladder spread 1.24 kcal/mol over 2 rungs (def2-TZVP, def2-QZVP)`. That spread is the spread of the rungs, not the uncertainty of the extrapolated limit; the report labels it as such.

### Benchmark comparison

`src/shared/benchmark.js` compares computed geometries with the shipped `experimental-bond-lengths` dataset: eight small molecules whose equilibrium bond lengths (`r_e`) come from the NIST Computational Chemistry Comparison and Benchmark DataBase (CCCBDB), Release 22. Every entry carries its source, CAS number, primary citation, level of theory (`experimental r_e`) and units (ångström). The provenance test walks every entry, so a value without a citation cannot ship.

The summary reports, per property:

- the number of computed points `n`;
- MAE and RMSE;
- the maximum absolute error;
- the mean **signed** error (systematic bias) and the spread of the signed errors (maximum minus minimum).

A reference entry the tool could not compute is kept in the result as `not computed` with the reason — no geometry with that composition, a different composition, or the wrong number of perceived bonds. It is never dropped, because dropping it would make the coverage look better than it is. Bond perception uses the Cordero covalent radii already shipped for the geometry check.

**Scope.** This change ships the comparison module and its dataset. The `ncs benchmark --dataset <name>` subcommand named in the issue is not wired yet; the module's `benchmarkSummaryText()` is the CLI-shaped surface.

### Boltzmann-weighted observables

`boltzmannWeightedObservables()` in `src/shared/conformers.js` averages observables over the **retained** conformer ensemble. The observables are exactly those the parser already produces per conformer:

| Observable | Unit | Source |
| --- | --- | --- |
| Energy | Eh | `parsed.finalEnergy.hartree` |
| Gibbs free energy | Eh | `parsed.thermochemistry.freeEnergyHartree` |
| HOMO–LUMO gap | eV | `parsed.orbitals.alpha.gapEv` |

The result is labelled **ensemble-averaged** at the stated temperature, and the population table is printed beside it. Every member must carry the Boltzmann population the conformer search assigned, and those populations must sum to 1; a missing population is a refusal, never a silent re-normalisation. An observable a member did not report is omitted from the average (with the member named) rather than averaged over a subset.

An average is marked **converged** when the largest retained population is at least 95%. When it is not, the **unweighted** mean is shown beside the weighted one, so a reader can see how much the weighting is doing. Conformer-weighted spectra remain out of scope: this is an average of per-conformer scalars, not a simulated spectrum.

### Error bars

A value that came from a ladder or an ensemble is shown with its spread and what the spread is over:

- **Results panel** — a **Method sensitivity** card shows the ladder rungs, the spread, the CBS estimate (or `CBS not reported` and why), the population table and the ensemble-averaged observables with `spread … over N retained conformers`. A run expanded from a Generate block also shows its population and the retained-ensemble spread.
- **Workflow report** — the ladder section prints the CBS form, pair and ladder spread; the conformer section prints the population column and the ensemble-averaged table with weighted SD and the unweighted column.
- **Dataset export** — appended columns: `conformer_ensemble_spread_kcal`, `conformer_ensemble_temperature_k`, `ladder_spread_kcal`, `ladder_spread_over`, `ladder_cbs_hartree`, `ladder_cbs_spread_kcal`, `ladder_cbs_form`. A missing block is an empty cell; an unavailable CBS estimate never writes a number.

A ladder whose rungs did not all run keeps its existing verdict `unknown`, and no mean is taken over the rungs that happened to finish.

**The uncertainty module.** `src/shared/uncertainty.js` assembles the report's *Uncertainty* section from the numbers a queue already recorded; it is pure and the report is its only caller. Three rules hold:

- **Method spread** is the max − min of the final energies of the rungs that carried a parsed energy, in kcal/mol. It is `measured` only with at least two such rungs; one rung — or two declared with one unparsed — prints `not measured` and the reason. No mean over rungs is returned, and no table of literature error bars is consulted.
- **Conformer spread** prints the lowest member at 0.00 kcal/mol and the Boltzmann-weighted value above it, side by side, with the retained spread and the largest population. The lowest member is never replaced by the average; the population table is the one the search assigned, and a member without a population is a refusal rather than a re-normalisation.
- **Barrier to rate** calls `eyringRate()` at the recorded barrier and at barrier ± the error recorded with the path, so the factor is the app's own arithmetic and the temperature is printed with it. At 298.15 K one kcal/mol is a factor **5.41** in k. When no barrier error was recorded the row says `not measured`; the report reads `reaction.barrierErrorKcal` and `reaction.barrierErrorSource` when a producer writes them.

Each measured row yields one *what would change the conclusion* sentence, computed from the number beside it: a ladder's headroom against its tolerance, the 95 % population at which one conformer is representative, or the rate ratio the barrier error cannot resolve.

## Spin-state comparison

A block with **Spin states** switched on runs one calculation per multiplicity over the same
geometry. Each state is its own `run.json`; the comparison is written once, to the queue record
(`queue.spins.<nodeId>`), when every state has finished.

Open any state's run and the panel carries a **Spin-state comparison** card: multiplicity, that
state's queue status, final energy, ΔE to the lowest computed state in kcal/mol, and ⟨S²⟩. The lowest
row is marked *lowest computed*.

- The card compares **only the multiplicities that were run**, on **one geometry**, at the block's
  level of theory. It is not a ground-state determination, and it says so rather than implying a
  molecular ground state that was never computed.
- A state that failed or timed out keeps its row, labelled with the queue's status and its error, and
  a *Not ranked* line names it. It is not dropped and no energy is invented for it.
- Two states with the same energy are reported as a tie, not ordered.
- The comparison lives on the queue record, so it appears when the run is opened from the console of
  the queue that produced it. A `run.json` on its own is one state, and is shown as one state.

## Gates

| Gate | Required | Passes when |
| --- | --- | --- |
| Output complete | yes | The parser covered the whole output, not a truncated window |
| Normal termination | yes | The engine's own termination record says normal |
| SCF record | yes | The SCF converged (the energy and cycle count are shown) |
| Optimization completed | job-dependent | An optimising job reports `Optimization completed` |
| Imaginary mode count | frequency jobs | Exactly one for `Opt=TS`, none for `Freq` / `Opt Freq` |
| Imaginary magnitude | frequency jobs | The imaginary mode is at least as large as the configured floor |
| Frequency record | frequency jobs | A frequency section was parsed |
| Thermochemistry record | when required | Thermochemistry was requested and found |
| Final energy record | when required | A final energy was requested and found |
| Composite energy | composite jobs | The log carries the method-specific composite summary; the SCF/post-HF component energies are never accepted as the composite result |

Which gates are required comes from the block's **Gates** checkboxes in the inspector, so the record
states exactly what the block asked for. A required gate that cannot be judged makes the task
`needs-review` and blocks its dependents. It is never silently promoted to a pass.

The **Composite energy** gate is added automatically when the echoed route names a composite method
(`G4`, `G4MP2`, `CBS-QB3`, …). It passes only on the method's own summary block. A log that
terminated normally but contains only SCF or post-HF energies from the component links fails it:
those numbers are ingredients, not the composite answer.

## Validity checks

Eleven checks, implemented as pure functions in `src/shared/validityChecks.js`. They run before a job
(project **Validate** and run start) and after it (`run.json` → `gates.validity`).

| Check | What it verifies | Phase | A failure is |
| --- | --- | --- | --- |
| `charge-multiplicity` | Electron-count parity; unpaired electrons ≤ electrons; a restricted reference that contradicts an open-shell multiplicity | pre, post | error — blocks export and run |
| `spin-contamination` | `S**2` before and after annihilation against `S(S+1)`; the deviation is recorded | post | error above 0.50, warning above 0.10 |
| `geometry-sanity` | Atom clashes, implausibly short contacts, stretched bonds, angle anomalies against covalent-radius sums | pre | error for a clash, warnings otherwise |
| `imaginary-frequencies` | Exactly one imaginary mode for `Opt=TS`, none for `Freq`/`Opt Freq`, and the magnitude floor | post | error |
| `method-basis-compatibility` | Heavy elements in a basis with no ECP; semi-empirical methods given a basis; composite methods given a separate method/basis; empirical dispersion added twice | pre, post | error for the ECP gap and composite conflicts, warnings otherwise |
| `counterpoise-bsse` | `Counterpoise=N` has fragment labels 1..N on every atom, and the output carries a counterpoise summary; BSSE is reported separately from the interaction energy | pre, post | error for a fragment mismatch or a missing summary on a completed job |
| `opt-convergence` | A frequency job only claims a minimum when its optimisation reported completion | pre, post | reported as a failure; does not block the run |
| `excited-state-root` | An `Opt` with TD states names `tdRoot` inside the states it computed; a `Pop=NTO` block reads a checkpoint from a block that has a TD record | pre | error — blocks the run (the project still opens, so the field can be fixed) |

Findings carry `{ id, status, message, evidence, severity }`. A check never passes on a missing
value: no geometry, no SCF method or no parsed record yields `unknown`, which is reported as such.

Thresholds, exactly as exported by the module: clash at 0.55 × the covalent-radius sum, short bond
0.75, long-bond warning 1.20 (bond cut-off 1.30), linear angle 170° at O/S centres, acute angle 40°,
spin contamination 0.10 / 0.50, and a 50 cm⁻¹ imaginary-mode floor. The geometry check uses a
single-bond covalent-radius table (Cordero et al. 2008); an element outside that table makes the
check `unknown` rather than passing it.

Every check can be switched off per block under **Validity checks** in the inspector. The choice is
stored in the project (`settings.disabledChecks`) and survives save and reopen; a disabled check is
omitted from the result, never reported as a pass.

**Scope.** These checks are offline and use only the project and the parsed output. Rules that need
more than those two inputs — standard-state declaration, conformer coverage, comparable-energy
bookkeeping, IRC endpoint identity — are not implemented. xTB records are judged by the subset that
applies to them: charge/multiplicity, geometry sanity, imaginary modes and optimisation convergence.
The Gaussian-route checks are reported as *not applicable* for xTB, never as a pass.

## Thermochemistry

A frequency job's thermochemistry is read from the log and shown in its own panel: the reported
thermal corrections and free energy, with the conversion factors and standard-state treatment stated
rather than implied. Where the parser finds no thermochemistry section, the panel says so.

xTB's free energy already uses mRRHO; the app adds no quasi-harmonic or standard-state correction on
top of it.

## Composite methods

`CBS-4M`, `CBS-QB3`, `CBS-APNO`, `G1`, `G2`, `G3`, `G4` and `G4(MP2)` are **job types**, not method
strings. Selecting one writes a single route keyword — `#p CBS-QB3`, `#p G4`, `#p G4MP2` — with no
`method/basis` pair and no additional `Opt`. Gaussian expands that keyword into its documented
sequence of geometry, frequency and single-point links; writing `CBS-QB3/6-31G(d)` or appending
`Opt` is a different, invalid route, so the builder refuses a block that still carries a method,
basis, dispersion, solvation, TD, population, custom keyword or a conflicting option.

The parsed answer for a composite run is the method's own summary block, for example:

```
 CBS-QB3 (0 K)=        -39.069832 CBS-QB3 Energy=           -39.066969
 CBS-QB3 Enthalpy=     -39.066025 CBS-QB3 Free Energy=      -39.088192
```

`finalEnergy` is the **(0 K)** value, because that is the composite electronic energy including the
model's scaled zero-point term. `Energy`, `Enthalpy` and `Free Energy` are kept separately in
`composite` — they differ by the thermochemical corrections the model applies. A log without the
summary reports **no** composite energy, even if its component links printed SCF or CCSD(T) numbers:
the Composite energy gate fails (or is `unknown` for a truncated parse) rather than promoting a
component energy to the answer.

**Scope.** The app writes the route keyword and reads Gaussian's final summary; it does not yet expand
the recipe into one queue task per link, so per-step provenance is not exposed here. `W1`, `W1U`,
`W1BD` and the less common G3 variants are refused for now because their summary output has not been
verified.

## Counterpoise and BSSE

Turn on **Counterpoise** for a fragment job and give the fragment count `N`. Every atom must carry a
fragment label `1..N`, and `molecule.fragments` must agree with `N`; otherwise the input builder and
the `counterpoise-bsse` validity check refuse the block. The route gets `Counterpoise=N`, each atom
is written as `O(Fragment=1)`, and a per-fragment charge/spin pair is written when the fragments are
not all at the complex's charge state.

The counterpoise summary is read as five distinct numbers:

- **corrected complex energy** — the complex in the full dimer basis;
- **sum of fragments** — the monomers in that same basis (Gaussian prints their sum, not one line per
  monomer, so individual monomer energies are not claimed);
- **BSSE energy** — `E(complex, raw) − E(complex, corrected)`, the basis-set superposition correction;
- **raw interaction energy** and **corrected interaction energy** in kcal/mol, as printed.

BSSE is a basis-set incompleteness correction, **not** an estimate of the total interaction error,
and it is **not** `corrected complex − sum of fragments` (that difference is the corrected
interaction energy). The app reports BSSE separately from the interaction energy and names the
basis; it does not add or hide it. Monomer **deformation** terms are not available in the
counterpoise block — they need separate monomer optimisations — so the app does not show them.
Counterpoise is refused with SCRF solvation, TD/population/frontier-orbital/Stability analyses
(Gaussian cannot produce molecular orbitals from it) and with IRC, Scan, NMR or composite job types.

## Thermochemistry at another temperature or pressure

Gaussian prints one table, at the temperature and pressure in the route. To ask what happens at
350 K and 0.1 atm you cannot correct that table — you have to rebuild the partition function from
the constants the output already carries: molecular mass, the three rotational constants, the
symmetry number and the frequencies.

`src/shared/thermoSweep.js` does exactly that (`thermoAt`, `thermoGrid`, `thermoCsv`). It is pinned
against Gaussian's own table: on a real Gaussian 09 frequency job the recomputed translational,
rotational and vibrational entropies reproduce the printed values to within rounding (40.502,
28.143 and 23.205 cal/mol/K), and the enthalpy and Gibbs corrections reproduce
`0.186976` and `0.143335` Ha exactly.

Every term is itemised — zero-point, translational (3kT/2), rotational (3RT/2), vibrational thermal,
pV = RT, and −TΔS — so a table can show each line and each can be switched off. Pressure enters
only through the translational partition function, and the code proves it: dropping from 1 atm to
0.1 atm changes the translational entropy by exactly `R ln 10`.

When the output lacks the constants the result is `{ available: false, missing: [...] }`. There is no
fallback to the printed table, because a table at 298.15 K is not an answer about 350 K.

### In the app

A run whose output carries those constants gets a **Thermochemistry** card with a workbench:

- **T / K** and **p / atm** inputs, defaulting to the printed conditions;
- six switches — zero-point, translational, rotational, vibrational thermal, pV = RT, −TΔS — so each
  contribution can be read on its own;
- an itemised table whose footer is `Σ correction to G` in kcal/mol and the resulting `G` in hartree;
- **Export CSV**, generated from the same data object as the table, so the file and the screen cannot
  disagree (three decimals, same term labels, plus T, p and the standard state);
- a **Generate** picker: select two or more finished runs that report a free energy and get
  Boltzmann populations and the ensemble free energy at the current temperature.

Two statements stay on the card wherever the numbers go: the standard state of the *printed* table
(298.15 K, 1 atm), and that electronic excitation is not modelled — the electronic partition function
is the ground-state degeneracy, as in Gaussian's own table.

The ensemble is a calculation over runs you select; it assumes they are conformers of one species at
one level of theory and says so. Nothing in the app generates conformers yet — see the conformer
issue.

## Reaction energetics

An `IRC` job gets a **Reaction path** card with the profile, the table and a **path gate**:

- `path-present` — the summary exists;
- `single-maximum` — one plateau of highest points, which is how an IRC summary prints the barrier (near the top the printed energies repeat, so a maximum is a run of points, not one index);
- `endpoints-below-maximum` — the path descends on both sides;
- `maximum-in-interior` — `unknown` when the maximum sits on an endpoint, because the path may be truncated;
- `endpoint-is-a-minimum` — always `unknown`: an IRC summary cannot show that an endpoint is a minimum. That needs a frequency job at the endpoint, and the check says so instead of assuming it.

A `Scan` block gets the located extremum. A one-dimensional scan is fitted with a parabola through the highest point and its two neighbours, and the fitted coordinate is printed with the three points it came from; a maximum on the boundary, or neighbours that do not form a concave top, are reported as a grid node with the reason. A two-dimensional scan (two parameters that actually vary) draws a heatmap and reports the highest grid node — no interpolation between nodes.

**Barriers are never printed alone.** `pathBarrier` attaches the level of theory and the thermochemical treatment, and the card prints "not recorded" when the run did not carry them. The number on the card is a potential-energy difference on the computed points, not ΔG‡.

**ΔG‡** needs two runs: an `Opt=TS` (with `Freq`) block and the block that supplies the reactant free energy. An IRC block declares the latter:

```json
"referenceNodeId": "reactant-freq"
```

The queue then writes `reactions.<ircNodeId>` = `ΔG‡ = G(TS) − G(reactant)` in kcal/mol with the scheme named in the string, and the workflow report prints it next to the number. Undeclared or missing free energies produce a reason, never a number.

**Rates.** When the queue has a ΔG‡ for the path, the reaction card reports `k` at the run temperature with its unit: `s⁻¹` for a unimolecular reaction, `M⁻¹s⁻¹` for a bimolecular one. The molecularity is the reactant block's fragment count — the declared fragment strings, or the per-atom fragment labels when those are absent — and it is never assumed. A reactant block that declares neither gets `k = not reported` with the reason, because a rate without a unit is not a rate. Beside the number the card prints:

- the small temperature table: 298.15 K and the run temperature, deduplicated, or an explicit list when one is supplied (a ΔG‡ computed at one temperature is reused at the others, which assumes ΔH‡ and ΔS‡ are constant over the range — the caption says so);
- the Arrhenius fit (`Ea`, `ln A`, `R²`) when the table has at least three points over at least 10 K, refused otherwise with the count or the range that blocked it;
- the Eyring expression, the transmission coefficient (1) and the free-energy block ΔG‡ came from, plus whether ZPE and thermal corrections are included;
- `not reported` for a null rate — never zero.

A barrier taken from a ΔE rather than a ΔG is labelled **electronic-energy estimate** and is never presented as a transition-state-theory rate.

**Scan barrier.** A scan card reports the located extremum as a **scan barrier**, with the grid step as its resolution (`± <step> <coordinate> grid`). It says plainly that this is not a transition-state barrier: a scan surface has a grid extremum, not a saddle point, it carries no ΔG‡, and no rate is derived from it.

**pKa and E° cycles.** `src/shared/pka.js` implements the two practical cycles:

- **pKa** from an isodesmic cycle: `pKa = pKa(reference) + [ΔG(sample) − ΔG(reference)] / 1.364 kcal mol⁻¹`. The cycle needs the acid, its conjugate base, a reference acid/base pair and the solvent; the card names the conversion (1.364 kcal mol⁻¹ per pKa unit = 2.303 RT at 298.15 K) and prints the reference with its citation. Reference acids ship in `src/data/pkaReferences.json`, each with its pKa, solvent, temperature, ionic strength and source.
- **E°** from `E°(sample) = E°(reference) + [ΔG(reference) − ΔG(sample)] / (nF)`, with `n` derived from the charge on each side (or given explicitly), `F = 23.0605 kcal mol⁻¹ V⁻¹`, and the reference couple taken from `src/data/redoxReferences.json`. Both couples need computed free energies at the same level of theory; the library supplies the measured offset that anchors them to SHE, and the card states that offset. An absolute potential is never computed from a single free energy.

Missing reference, missing solvent, a solvent mismatch, or a species without a frequency job gives `not reported` with the missing block named — never a pKa or an E° from an electronic energy alone.

## Spin density and EPR

An open-shell calculation produces a **Spin density / EPR** card with three
things, and it says which of them a particular engine can actually deliver.

**Spin populations.** Mulliken and Löwdin populations per atom, in electrons
(α − β), computed from the unrestricted `Spin SCF Density` block of the run's
checkpoint — `D^s = D^α − D^β`. The card names the scheme and the block, and
prints the sum with the number it must equal (`n_α − n_β`, 1 for a doublet). That
sum is the internal check: if it is not n_α − n_β, the density was read wrong and
no population on the card is trustworthy. On CH3· (UB3LYP/6-31G*) the carbon
carries +1.1552 e and each hydrogen −0.0518 e (Mulliken; Löwdin +1.0814 e and
−0.0272 e), summing to 1.000000.

The same α − β density is available as a **field** (`epr.spinDensityOnGrid`), on
the same grid contract an orbital or an ESP uses, so it can be written as a cube
and drawn as a two-lobe surface. It is a pointwise evaluation of the density, not
a quadrature, and it is signed.

**Fermi-contact hyperfine coupling.** For each nucleus with a spin,

```
A_iso = (2 μ0 / 3) · g_e μ_B g_N μ_N · ρ_spin(R_nucleus) / h
```

reported in MHz and in gauss (`B = h ν / (g_e μ_B)`), with the isotope named — a
¹³C coupling is reported for a carbon nucleus because ¹³C is the isotope with
I = ½, and the card says *not the natural isotope*. Nuclei with no tabulated
g-factor in this build are listed as **no nuclear data**, never as zero.

This is a **density-only estimate**, and the card says so in full: it is the spin
density the calculation produced at the nucleus, so it omits core polarisation
beyond what that density already carries, spin-orbit contributions to the
coupling, and relativistic / finite-nuclear-size corrections. The size of that
approximation is visible in the one comparison everyone knows: for the hydrogen
atom, the non-relativistic formula with the exact constants gives 1422.8 MHz
where the measured 21 cm line is 1420.4058 MHz — 0.17 %, which is the omitted
relativistic correction. For CH3·, UB3LYP/6-31G* gives −70.80 MHz (−25.26 G) for
the protons against a measured 23.04 G. Read the table as *where the spin sits and
what its order of magnitude is*, not as a spectrum to be assigned line by line.

**The g-tensor is refused, by name.** Psi4 has no g-tensor property in the module
set this app writes (it needs a spin-orbit treatment of the wavefunction), and
ORCA — which does compute one — is not installed. The card prints that refusal:
no value, no `≈ 2.0023`, no empty cell. `PSI4_CAPABILITIES.epr.gTensor` is `false`
with the reason, so a settings dialog cannot offer it either.

An **imported ORCA log** is a different case (issue 222): when it prints
`Hyperfine couplings ... YES`, the parser reads ORCA's own `A(iso)` in MHz for
each nucleus, its `A(SD)` dipolar components and the 3×3 total HFC matrix into
the same `epr.hyperfine[]` rows, with the isotope and nuclear spin the log
states. ORCA's `SAI` spin-Hamiltonian convention and signs are carried as
printed. ORCA prints no spin populations, so that table is absent rather than
empty, and the card says the couplings came from the hyperfine block. A
`g-Tensor (aka g-matrix) ... YES` run that prints the `ELECTRONIC G-MATRIX`
block carries that tensor; a `NO` is a refusal by name. The log prints no gauss
column, so the gauss value is arithmetic on the printed MHz with
`g_e = 2.0023` (2.00231930436256 in the constants table) and the record says it
was not cross-checked against the log.


**A closed-shell molecule prints `no unpaired electrons`** — not an empty table.
The words are the answer: a closed-shell wavefunction has no spin density, and a
zero-filled population table would claim a calculation that never happened.

**How the numbers reach `run.json`.** A Psi4 open-shell single point is written
with `E, wfn = energy('…', return_wfn=True)` and a `fchk(wfn, '…fchk')` line, so
the checkpoint lives beside the log; the runner reads it, the EPR block is
computed from it, and the whole block — populations, couplings, method statement,
caveat and the g-tensor refusal — is carried in `parsed.epr`. It is passed into
the canonical result whole rather than field by field, because a population
without its scheme and caveat is a number with its provenance removed. An
open-shell run with no checkpoint reports **not available** with the reason; it
does not show empty tables.

## NMR: shieldings, shifts and couplings

An `NMR` job produces an **NMR** card with every atom's isotropic shielding, anisotropy and tensor
eigenvalues, the gauge Gaussian used (GIAO), and a simulated spectrum.

Gaussian reports **absolute** isotropic shieldings in ppm. A chemical shift is
`σ_reference − σ_isotropic`, and the reference must be computed at the same level of theory — there is
no universal TMS number. The card therefore starts in absolute mode. Entering a reference in the
**σ_ref** field *and* its provenance in the field beside it converts the table and the figure to
shifts; the caption and every row's **Source** column print the reference and where it came from.
Without a provenance the shift column stays empty and the card prints the refusal — a σ_ref with no
stated method, basis or citation is a borrowed number, not a reference. Without any reference the
figure says *absolute shielding*, because it is not a spectrum in ppm shift.

Each row's **Source** column states the origin of the number: `this run · Gaussian 09 D.01 · GIAO`
for a shielding, and `reference: σ_ref = 31.9 ppm at B3LYP/sto-3g — TMS, …` once a shift exists. The
provenance may name the calculation that produced σ_ref (method, basis, solvent) or the experiment
that states it; either way it is printed, never implied.

Broadening is a Lorentzian with a FWHM you set in the card (default 0.10 ppm) and the caption always
states it, along with the number of nuclei in the trace. VCD/ROA rotational strengths and
conformer-weighted spectra are not implemented; see the Raman section below for what is.

### Referencing: a shift carries its source

`src/shared/nmrReferences.js` holds the rule, `src/data/nmrReferences.json` the data: **a shift exists
only when a reference for that exact method and basis exists.** Anything else returns `δ = null` with
the reason `no reference for ωB97X-D/def2-TZVP` — a level is never borrowed from a neighbouring one,
and an absent shielding or reference is never read as zero.

Two modes, both explicit:

- **single** — `δ = σ_ref − σ`, with σ_ref the reference nucleus (TMS, CFCl₃, H₃PO₄, …) computed at
  the same level of theory.
- **linear** — `δ = a·σ + b`, with `a` and `b` fitted at the level they are stored with. The fit is
  not extrapolated to another level.

`shiftFor({ level, nucleus, sigma, reference, references })` returns
`{ delta, mode, citation, reason, source }`, so a shift cannot be obtained without the mode and the
citation that produced it: `source` is the line the table prints, and it is null exactly when `delta`
is. `reference` is the caller's own value, `{ ppm, provenance, level? }`; a stated level must match
the run's level or the shift is refused (`the reference is at …, the run is at …`), and a σ_ref with
no provenance is refused by name. An entry without a citation is refused **by name** when the dataset
loads; so is an entry missing its level, its retrieved date or a finite coefficient, and so is an
entry whose nucleus this app does not read — only ¹H, ¹³C, ¹⁵N, ¹⁹F, ³¹P and ²⁹Si are supported.

The shipped dataset is **empty on purpose**. A reference shielding is a run at a level, not a
constant: computing σ(TMS) for every supported functional and basis is a campaign of its own, and
shipping a number borrowed from another level — or from a paper that does not state one — would be
exactly the fabricated quantity this app refuses. Adding an entry requires a citation; the JSON file
says so at the top.

### Spin–spin couplings

`NMR=(GIAO,SpinSpin)` asks Gaussian for the coupling tables. Gaussian allows the option for
**Hartree–Fock and DFT only**, and its cost is roughly **twice a frequency job** at the same level — a
run to plan for, not a checkbox to tick by habit.

The log prints the four contributions to J (Fermi contact, spin–dipole, paramagnetic and diamagnetic
spin–orbit), then two totals: `Total nuclear spin-spin coupling K (Hz)` and `... J (Hz)`. J is the
coupling in hertz; K is the reduced constant, the same numbers with the two nuclear moments divided
out. `parseCouplings` reads both tables and never converts one into the other: the conversion needs
the gyromagnetic ratios of the two nuclei, which the log does not print. For one pair of elements the
J/K ratio is fixed, and that is what the module keeps — two printed quantities, not one derived
number.

Each table is **lower-triangular** and printed in five-column chunks: within a chunk, a row carries
only the columns of that chunk that are ≤ the row number, so nothing above the diagonal exists in the
file. The matrix is filled symmetrically from those printed values, and the diagonal is 0 only
because the log prints it as 0. A pair the log does not print stays **absent** — `NaN` in the
`Float64Array`, `null` from `couplingAt()` — never 0, because a 0 would claim a computed coupling the
run never produced. `verified` reports whether the printed rows matched their column headers and
every printed diagonal was zero; `complete` reports whether the J matrix covers every pair. A partial
table is never presented as a whole molecule's coupling network.

Units and sign travel with the result: `units: 'Hz'` and a `convention` string that states the sign is
as printed by Gaussian and never normalised, so a table cannot show the numbers without them.

The **NMR** card draws the pairs in a **Spin–spin couplings** table with the nuclei named by element and
Gaussian's 1-based index (`C2–C1`), J in Hz and the reduced K exactly as printed, and states how many
of the possible pairs were printed. A run whose route did not ask for `NMR=(GIAO,SpinSpin)` says so —
an absence, not a zero matrix. The same pairs, matrices and indexing note are written to
`run.json` (`parsed.nmr.couplings`, plain arrays with `null` for an unprinted pair) and printed in the
workflow report's **NMR** section, together with the level of theory and the reference the record
carries, if any. A record without a reference prints *no reference was recorded* and leaves δ empty.

ORCA prints the same physical quantity in a different layout (issue 222): a **full symmetric**
`SUMMARY OF ISOTROPIC COUPLING CONSTANTS (Hz)` table, in six-column chunks, with every row printing
every column of its chunk. `parseOrcaSpinSpin` reads it into the same `nmr.couplings` object, so the
card and the report draw ORCA without a branch. Two differences are carried with the numbers rather
than left to a reader to assume: ORCA numbers nuclei from **0** (Gaussian from 1), so `indexing` says
so; and the ORCA logs print J in Hz and the per-pair `gnA`/`gnB` constants but **no reduced K table**,
so `kMatrix` is `null` and `kUnits` says "not printed" rather than deriving a K the log never showed.
Every summary pair is checked against the per-pair `Total … iso=` value printed in the same log; on
the committed DVB fixture all 190 pairs agree at the log's print precision.


## Raman activities

Turn on **Raman** in a frequency block's inspector (it adds `=Raman` to the frequency keyword:
`Freq=Raman`, `Opt Freq=Raman`). The block is refused on a non-frequency job and on an xTB block,
because neither can carry the keyword.

The **Raman** card lists, per mode, the frequency, the scattering activity in **Å⁴/amu** and the
depolarisation ratio for plane-polarised light, exactly as Gaussian prints them.

The figure is the **activity** broadened with a Lorentzian whose FWHM you set in cm⁻¹ (default 12),
normalised to the strongest peak. It is *not* a scattering cross-section: converting activities to a
measured intensity needs the excitation wavelength, a temperature-dependent population factor and the
collection geometry, none of which the log carries. The caption names the quantity, the units, the
FWHM and the normalisation so the figure cannot be read as something it is not.

**Overlay a measured spectrum.** Drop a two-column file (`wavenumber intensity`, comma, semicolon, tab
or space separated, header lines and `#` comments skipped) into the card. The measured series is drawn
dashed behind the simulation, scaled so its strongest point matches the simulated maximum, and the
caption prints the factor that was applied — an overlay whose heights were silently rescaled would
invite a comparison that is not available.

## VCD rotational strengths

Turn on **VCD** in a frequency block's inspector (it adds `=VCD` to the frequency keyword:
`Freq=VCD`, `Opt Freq=VCD`; with Raman also on, one keyword carries both: `Freq=(Raman,VCD)`). The
block is refused on a non-frequency job and on an xTB block.

The **VCD** card lists, per mode, the frequency, the rotational strength <em>R</em> in
**10⁻⁴⁴ esu² cm²**, the dipole strength in 10⁻⁴⁰ esu² cm², and the E–M angle in degrees, exactly as
Gaussian prints them.

Three things the card refuses to smooth over:

- **_R_ is signed.** The figure is the signed Lorentzian sum around a **zero line**, normalised to
  the strongest |_R_| — not to the strongest positive band, which would hide half the spectrum. The
  caption counts the positive and negative bands.
- **The representation may be unstated.** Gaussian 16 (Rev A.03, at least) prints the unit and no
  velocity/length label. Velocity and length rotational strengths agree only in a complete basis, so
  the record keeps `representation: null` and the card says "not stated in the output" instead of
  picking one. If a revision does print a label, it is read and shown.
- **Nothing is converted into an instrument intensity.** As with Raman, the plotted quantity is the
  printed rotational strength, not an absorbance.

ROA is read from the same frequency section: `ROA1`, `ROA2` and `ROA3` are the three scattering
geometries the log names, `RC180` is the degree of circularity, and the results card plots one
chosen geometry as a signed curve. The pinned fixture is a Gaussian 09 E.01 log; Gaussian 16
B.01+ is not claimed because no public log of that revision was found.

## Emission

**Emission from S1 (template).** Start from the **Emission from S1 (Opt then TD)** template: the
first block emits `TD=(NStates=1,Root=1) Opt`, which relaxes the S1 surface, and the second runs TD at
that minimum on a checkpoint edge. The results panel labels the lowest excitation of the second block
as the **vertical emission from the excited-state minimum** and prints the block it came from. It is
not the adiabatic 0–0 energy: that also needs the zero-point energy of both surfaces, which this
workflow never computes.

The label is derived from the workflow, not from the log — the same excitation table means absorption
at the ground-state minimum and emission at the excited minimum, and only the graph knows which one
was run.

**Emission (vertical) block.** Add **Emission (vertical)** from the palette. It is a single-point
block pinned to the emitting state:

```
#p <method>/<basis> SP TD=(NStates=n,Root=1)
```

and its **Vertical emission** card prints three numbers from the log's `Excited State 1` row:

- `λ_em` (nm),
- `E` (eV),
- `f` (oscillator strength).

The card labels them **vertical emission from the optimised excited state**. A value the log does not
carry is printed as *not reported* with the reason (for example "the output carries no excited-state
table"), never filled in.

**What the card does not report.** Fluorescence lifetime, fluorescence quantum yield, and a Stokes
shift against an experimental band maximum. Gaussian 16 does not print the first two for this
workflow, and the third needs a measured spectrum the run does not contain. The **Excited states**
card does print a radiative-only lifetime for every state it parsed — an upper bound on the observed
lifetime, not a fluorescence lifetime; the next section says exactly what it leaves out. The card
also says the number is a vertical energy at one geometry, **not** the adiabatic 0–0 energy.

**Which geometry it used.** A **checkpoint** edge hands the optimised geometry over (`Geom=Check`)
and the card says so. A **normal ordering edge** does not: in this app an ordinary edge orders the
run but the block still uses its own input (project, dataset or conformer) geometry. The card records
that and prints *No checkpoint edge supplies the geometry* rather than calling a project geometry an
optimised excited state. If the block is not connected to an excited-state optimisation at all, the
card says the vertical-emission reading is not supported by the graph it ran in.

## Radiative kinetics from oscillator strengths

A TD calculation prints an oscillator strength for each excited state. That one number fixes the
Einstein A coefficient of the same transition, so the **Excited states** card adds two columns beside
the printed values:

| Column | Meaning |
| --- | --- |
| `k_r` (s⁻¹) | spontaneous-emission rate of that state, from the printed f |
| `τ_r` (radiative) | `1 / k_r`, in ns/µs/ms as the magnitude needs |

The relation is printed under the table, because the number is meaningless without it:

```
k_r = 2π e² ν² f / (3 ε₀ mₑ c³) = 0.22234 · ν̄² · f = 2.2234 × 10¹³ · f / λ²   (s⁻¹)
```

with f the dimensionless length-form oscillator strength the TD job printed and λ in nm. The 1/3 is
the isotropic average over molecular orientations; f as printed already sums the degenerate
components of that state. `ν̄` comes from the **wavelength column** (`ν̄ = 1 × 10⁷ / λ(nm)` cm⁻¹) —
the number the log prints in the same row as f. When a parser reported energy but no wavelength the
card uses `ν̄ = E(eV) × 8065.544` cm⁻¹ instead, and says so; the two routes differ only by the
rounding of the printed digits.

The prefactor is evaluated from the SI constants in `src/shared/kinetics.js` rather than typed from
prose, and the tests pin it against two measured transition probabilities — Na 3s→3p
(6.25 × 10⁷ s⁻¹ at 589 nm, f = 0.982) and H Ly-α (6.265 × 10⁸ s⁻¹ at 121.567 nm, f = 0.4162) — to
within 1 %. A 300 nm state with f = 1.0 comes out at 2.47 × 10⁸ s⁻¹, τ_r = 4.05 ns.

**What is on the card is the radiative lifetime, and nothing else.** Spontaneous emission is the
only channel in the Einstein A coefficient. Non-radiative decay (internal conversion), intersystem
crossing and phosphorescence (which need spin–orbit coupling), and conical intersections or
non-adiabatic dynamics (which need surface hopping) are **not modelled**, and the card names all
three under the table. The observed lifetime is therefore at most τ_r: a measured decay can only be
shorter. No field named `lifetime` is filled from this calculation; the module returns
`radiativeLifetimeSeconds` and leaves `observedLifetimeSeconds` null with the reason, and the card
never prints the word *lifetime* without *radiative* in front of it.

Two more cases are reported instead of being smoothed over:

- **f = 0** (a symmetry-forbidden or spin-forbidden transition in this calculation) gives
  `k_r = 0` and `τ_r = not finite (f = 0)`. The state can still decay by the channels above; it has
  no one-photon radiative channel in this approximation.
- **No f, or no wavelength and no energy** prints *not reported* with the reason, never zero.

The level of theory travels with the numbers: the card prints the functional/basis it read from the
run's provenance, or `Level of theory: not recorded for this run.` when the record carries none. The
rates are exactly as good — and as limited — as that level: a TD-DFT f is a vertical, single-geometry
quantity with no vibronic structure and no solvent shift, and the caption of the UV-Vis figure
already says the curve is a simulation.

**Measured decay traces are not overlaid.** Comparing "measured 3 ps, computed radiative 40 ns"
needs a transient-absorption series (time versus ΔA) imported beside the computed states, with its
own axis and unit discipline. That is **not built**: the only measured-series overlay in the app
today is the Raman card's single `.jdx` slot, which draws an energy-axis trace against a vibrational
figure (see [Spectra](spectra.md)). A time-resolved trace shares no axis with the excitation table,
so it needs its own surface rather than a reused slot — and this card does not pretend otherwise.

## Exciton coupling of a dimer (Psi4, route A)

A dimer's UV-Vis spectrum is not the sum of its monomers: two transition dipoles couple, the
monomer states split (Davydov), and a donor/acceptor pair can show a charge-transfer band that has no
monomer analogue. The app computes the first two — the cheapest half of issue 173 — from two
recorded transition dipoles and the geometry that places them.

**What it needs, in order:**

1. A **complex** block (issue 188) whose two members are the chromophores. Its members become
   fragments 1 and 2, and each member's atom count travels with the run.
2. A **Psi4 TD-DFT** block on that complex, with the opt-in that records transition dipoles
   (`recordTransitionDipoles`; not in the block inspector yet, and see the note below).
3. The run itself: the results panel then shows an **Exciton coupling** card beside *Excited states*.

**Why an opt-in at all.** Psi4's TDSCF table carries energies, oscillator strengths and rotatory
strengths but **no transition-dipole vector**. |μ| can be recovered from f; its *direction* cannot,
and the direction is what a coupling is made of. The vector does exist on the returned
wavefunction, so the opt-in adds this to the deck after the energy call:

```python
E, wfn = energy('td-b3lyp', return_wfn=True)          # one call, and it returns the wavefunction
for _ncs_name in wfn.array_variables():
    if 'ELECTRIC TRANSITION DIPOLE MOMENT (LEN)' not in _ncs_name:
        continue
    _ncs_v = wfn.array_variable(_ncs_name).to_array()
    …
    psi4.core.print_out('NCS-TDM ROOT %d %s %.10f %.10f %.10f a.u.' % (…))
```

Two details in that block are there because the obvious version does not work on Psi4 1.11:
`print` writes to the process's stdout, which the runner does not keep, so every record goes through
`psi4.core.print_out`; and `wfn.get_array(name)` does not exist — `wfn.array_variable(name)` does.
`set tdscf_print` does **not** print the dipole either (tried at level 3). A block that does not opt
in produces exactly the input it did before, and its log gains no line.

**What the card prints**, all units explicit:

| quantity | meaning |
|---|---|
| Chromophore 1 / 2 | the paired state, its energy in eV, f, and \|μ\| in debye |
| Separation r | the centre-of-mass distance between the two members, in ångström |
| Coupling J | `J = 5030.0 · (μ̂₁·μ̂₂ − 3(μ̂₁·r̂)(μ̂₂·r̂)) · \|μ₁\|\|μ₂\| / r³`, in cm⁻¹, sign kept |
| Davydov split 2\|J\| | the two components, below and above the monomer energy |
| Validity r/extent | the ratio, the threshold (3), the larger chromophore extent, and a verdict |

The card states the approximation on every run, including the part that matters most: **point-dipole
coupling does not describe charge-transfer character.** A CT band has no monomer analogue, so a model
built from two monomer-like dipoles cannot produce one. Route B — the same transition density the run
already computed — is described in the next section, and when it is present the card says where this
J stops being the right model.

**The pairing rule.** Only states that carry **both** a recorded dipole vector and a non-zero
oscillator strength can couple, and the card pairs the two lowest such states. A dark state (f = 0)
is never paired and no dipole is reconstructed from f. When fewer than two states qualify the card
says so, and prints no J.

The two dipoles are states of **this run**, which for a complex TD job are the supersystem's states.
When each is localised on one chromophore the pair is the two chromophore transitions and J is a
prediction; when a state is delocalised over both fragments the pair is not two chromophore
transitions and the number is a consistency check. Separately computed monomer states (the issue's
original route A) would remove that ambiguity and are not wired: no run record links a dimer to its
two monomer runs yet.

**Refusals instead of numbers:**

- a plain monomer run (no complex record) — `not modelled: no dimer geometry`, because there is no
  second chromophore and no separation vector;
- a zero dipole vector, a complex whose atom counts disagree with the geometry it was built from, or
  two chromophores at the same point — the module's refusal, quoted on the card;
- a complex of three or more members couples fragments 1 and 2 only, and says which members are not
  part of the number;
- a run reopened from disk: the member provenance reaches the card from the queue task, and `run.json`
  does not carry it yet, so a saved dimer run shows `not modelled: no dimer geometry` until that
  identity is written into the record.

Below `r/extent = 3` the number is still printed, but the verdict is *estimate only* and the note
names the supersystem route: at that separation the multipole expansion has no small parameter.

**Opt-in availability.** The builder reads `recordTransitionDipoles` from the block's settings and
refuses it on a job that is not TD-DFT. The project schema lists the key so a value is not reported
as a typo, but it does not yet round-trip it through the block inspector; a saved project drops the
key until that one-line change lands. Recorded dipoles are therefore visible today for a block whose
settings carry the flag (hand-edited project, or a builder call), and absent — never guessed — for
every other run.

## Charge-transfer character of an excited state (Psi4, route B)

The question route A cannot answer is: *how much of this excitation moves an electron from one
fragment to the other?* The answer comes from the transition density of the same TD run — not from a
second calculation and not from the dipoles.

**Where the numbers come from.** The opt-in above writes three records into the log, all measured
quantities of the run:

| record | what it carries |
|---|---|
| `NCS-CTFRAG <natoms> <label per atom>` | which fragment each atom belongs to, as the block declared it |
| `NCS-TDM ROOT <n> <irrep> x y z a.u.` | the transition dipole vector of state *n* |
| `NCS-TDMAT ROOT <n> <nocc> <nvir> tda` … `NCS-TDMAT END <n>` | the Tamm–Dancoff amplitudes X, row-major over occupied × virtual |

The deck also calls `fchk(wfn, ...)`, so the run's checkpoint sits beside its log and supplies the
**MO coefficients**, the **electron counts** and the **Gaussian basis**. From those three the analysis
builds the one-particle transition density in the atomic-orbital basis,

```
D^{0I}_{μν} = Σ_{i∈occ} Σ_{a∈vir} C_{μi} X_{ia} C_{νa},
```

and the AO overlap **S** analytically from the basis (the same Gaussian-overlap machinery the ESP
card uses). Nothing is read from the engine's own density object: the density is reconstructed from
what the engine printed and checked, which is why a mismatched checkpoint is detectable rather than
silently wrong.

**The partition.** Two fragments, so the natural partition is Mulliken's, and the analysis does it in
both the Mulliken and the Löwdin metric:

| symbol | definition | range |
|---|---|---|
| Ω_AB | `Σ_{μ∈A} Σ_{ν∈B} (D S)_{μν} (S D)_{νμ}`, the fraction of the transition density with its hole on A and its particle on B | 0…1, `Σ_AB Ω_AB = 1` |
| CT fraction | `Ω₁₂ + Ω₂₁` — the part of the excitation that is inter-fragment | 0…1 |
| Ω (local), also written Ω_AA | `Ω₁₁ + Ω₂₂` — the on-fragment part | 0…1, `CT + Ω = 1` |
| Λ | `Σ_A √(Ω_AA)` — the Plasser–Lischka delocalisation index, evaluated over fragments instead of atoms | 0…√2; 1 = the excitation sits on one fragment, 0 = hole and particle are on different fragments |
| Δq | `Σ_{μ∈1} (ρ_particle)_{μμ} − Σ_{μ∈1} (ρ_hole)_{μμ}` in electrons | −1…+1; the net charge fragment 1 gained |

with `ρ_hole = D S Dᵀ` and `ρ_particle = Dᵀ S D`, so that `tr(ρ_hole S) = tr(ρ_particle S) = 1`.
The Löwdin variant replaces D with `S^{1/2} D S^{1/2}`, the same `S^{1/2}` the spin-population code
uses. The card prints the fraction, Ω, Λ, Δq **and the partition's name**, because a Mulliken and a
Löwdin fraction are not the same number; `partitionSpread` is the largest disagreement between the
two over all states, and on the committed fixtures it is 0.004 (ethylene dimer) and 0.011
(ammonia–water). When that spread is large, the card says the value depends on the partition.

**What the numbers mean — and what they do not.** They characterise **the transition density at this
level of theory**. They are not an observable, not a measurement, and not a property of the molecule:
a different functional, basis or geometry moves them. The card says so in the same paragraph, and
names the level (`TD-B3LYP def2-SVP`, from the run's provenance).

**Δq is not the fraction.** They coincide only when the transfer runs one way. In a homodimer every
state has hole and particle spread equally over both fragments, so an excitation can be 99 %
inter-fragment with **Δq = 0** — charge moved in both directions with equal weight. Both committed
fixtures exist to keep that distinction in view.

**Where it appears.** The **Exciton coupling** card gains one row per paired state beside the
point-dipole J:

```
Charge transfer (state 2)   98.2 % of the excitation is inter-fragment · Ω = 0.018 ·
                            Λ = 0.19 · Δq = +0.00 e · Löwdin partition
```

and when either paired state is more inter-fragment than not (local fraction < 0.5), or has |Δq| ≥
0.5 e, the card prints, in place of a footnote:

> Charge transfer is large for state 2: the transition density is not two point dipoles, so J above
> is printed with that caveat and is not a prediction for this pair.

Those two thresholds are the module's, exported as `CT_LOCAL_FRACTION_LIMIT` and
`CT_TRANSFER_LIMIT_E`, and they are stated on the card rather than tuned.

**Refusals, never zeros:**

| situation | the card says |
|---|---|
| monomer run, no second fragment | `not modelled: no dimer geometry` |
| no amplitude block in the log (block did not opt in) | `not modelled: no transition density was recorded for any state` |
| no checkpoint beside the log | `not modelled: no wavefunction (the run has no checkpoint)` |
| a truncated amplitude block | `not modelled: state <n> holds <k> amplitudes for a <i>×<a> block` |
| amplitudes that do not sum to 1 | `not modelled: the <partition> partition of state <n> sums to <s> instead of 1` |
| RPA (non-TDA) amplitudes | `not modelled: state <n> records a transition density that is not TDA` |
| a checkpoint of a different molecule | `not modelled: atom <k> is <X> in this run and <Y> in the checkpoint` |
| three or more fragments | `not modelled: the analysis is a two-fragment model and the run declares <n> fragments` |

A state with no density is left out of `chargeTransfer.states`; it never appears with a fraction of 0.

**Cost.** None beyond the opt-in: the amplitudes are already computed by the TD step, the checkpoint
is written anyway, and the analysis is a 16×80×160 matrix product per state.

**Fixtures.** `test/fixtures/psi4-ct/` carries two whole runs (deck, log, checkpoint, README with the
image, version, command, geometry and sha256): a slipped cofacial ethylene dimer (CT up to 0.99 with
Δq = 0) and an ammonia–water complex (Δq = +0.83 e for state 1, −0.28 e for state 7). The numbers in
`test/chargeTransfer.test.js` are recomputed from the definitions rather than compared with stored
constants.

**Cross-check.** The same states recomputed inside Psi4, with Psi4's own `S` and MO coefficients and
no code from this repository, agree with the card to ≈2×10⁻⁶ — the precision the log records the
amplitudes to. That is the evidence that the analytic overlap and the checkpoint's orbital order
describe the same density the engine used.

## Natural transition orbitals

`Pop=NTO` is the second job of a two-job chain. Gaussian needs the transition density from a TD job
in a checkpoint, so the app writes:

```
#p <method>/<basis> SP TD=(NStates=n) Density=(Check,Transition=k)     ← writes the checkpoint
#p <method>/<basis> Guess=Only Pop=NTO                                  ← reads it, over a checkpoint edge
```

`Transition=k` is set by **NTO transition** (`ntoTransition`) on the TD block; **NTO analysis**
(`nto`) ticks the second block, which is created from the palette as *NTO analysis*.

The refusals are errors, not warnings:

- `Pop=NTO` with no checkpoint edge names the missing edge.
- `Pop=NTO` whose checkpoint source has no TD record (`tdStates` 0) is refused with the source block
  named.
- The NTO block may not carry TD itself, and `Transition=k` may not exceed the number of states the
  TD job computed.

**The printed NTO table is not parsed.** No real NTO log exists in this repository, so the orbital
eigenvalue/occupation layout has not been verified. The results card shows the two-job route and
states that the NTO pair is *not reported*; it does not guess a table format. The chain and its
refusals are usable today; the table appears when a real log can be committed as a fixture.

## ECD

A TD job prints rotatory strengths in two conventions, `R(velocity)` and `R(length)`. They agree only
in a complete basis, so the ECD card asks which one to plot and prints the choice, the printed unit
(10⁻⁴⁰ erg·esu·cm/Gauss) and the broadening. The curve is signed: a positive band and a negative band
are the two signs of the Cotton effect. No Δε is computed — that needs a band shape and an instrument
calibration the log does not carry.

If every printed rotatory strength is zero, the card says the molecule is **achiral** rather than
showing a flat line with no explanation.

## Reaction paths and scans

An `IRC` job and a `Scan` job produce a **Reaction path** / **Potential-energy scan** card, read from
the summary table Gaussian prints at the end of the job — not re-integrated from the individual
steps:

- the profile curve, with energies relative to the lowest computed point;
- the highest point and how far above the lowest it sits, in kcal mol⁻¹;
- a table of points with the reaction coordinate (IRC) or the scanned parameter (scan) and both the
  relative and absolute energies.

An IRC table prints energies *relative to the transition state*; the card recovers the absolute
energy from the header line Gaussian prints above the table and shows both. A job with neither
block gets no card, and the app never fills the gap with a straight line.

The barrier shown for the path itself is a potential-energy difference on the computed points. It is
**not** ΔG‡, it carries no thermochemical correction, and no rate constant is derived from it. A rate
comes only from the queue's ΔG‡ verdict for the same path (see **Rates** above), which needs a
frequency job at the saddle point and at the reactant; a scan has no such verdict.

## Structure viewer

A parsed final geometry is drawn as a ball-and-stick model in the inspector, with bond perception
from covalent radii and a **Fit** control for the bounding box.

### Normal-mode animation

A frequency job's displacement blocks are parsed (`src/shared/normalModes.js`) and the panel animates
the selected mode. Each frame normalises the mode so its **largest atomic displacement is exactly the
amplitude**, and the canvas caption prints `amplitude X.XX Å` next to the frequency — the amplitude is
stated, not implied. Amplitude runs 0.1–1.5 Å.

The block format is easy to get wrong: each line is `component atom element` followed by **one number
per mode**, three lines per atom in component order. A parser that assumes three numbers per mode
reads a column of zeros and animates nothing visible.

A mode is offered only when its block covers every atom. Missing atoms are counted as
`incomplete` and those modes are dropped; an output with no displacement blocks says
`Normal modes not present in this output.` and shows a static geometry — it never invents motion.

### Optimisation replay

Every geometry Gaussian printed is paired with the SCF energy that preceded it (`trajectory.js`). The
results panel draws energy against step and lists one row per step with its energy and its
coordinates. The reference is the **lowest energy recorded**, not the first geometry, and a geometry
that had no preceding energy (the input structure, for example) is shown as a gap and `not reported`
rather than at zero. At most 80 steps are kept in a run record; the number left out is stated.

### Two-run superposition

Results → **Superposition** compares the current structure with another run, but only one that has the
same atoms in the same order. It reports the RMSD in Å over the atoms used, draws both structures
projected on `xy` after alignment, and lists the five largest per-atom deviations. The RMSD is a plain
per-atom RMSD after optimal rotation (Kabsch via Horn's quaternion method) — it is **not**
mass-weighted, and the card says so.

### Figures

**Save figure…** writes an SVG of the current view at 3× with no captions or controls: atoms, bonds
and a scale bar measured with the same camera as the drawing, labelled `1 Å`.

## Wavefunction files

A run can also carry the `.fchk` and `.cube` files a Gaussian job produced. The app reads them
offline (it never calls `formchk` or `cubegen`): the checkpoint supplies the geometry, orbital
energies, charges and electron counts, and the cube supplies a scalar field with its extrema and the
voxel each occurs at. From those it derives a HOMO/LUMO gap, the spin state implied by the
alpha/beta counts, and a charge-sum check against the total charge.

The numbers are summarised in the run record next to the file digests, and the dataset export gains
a column group for them. The **Wavefunction view** card at the bottom of the results surface draws
the field: a plane slice or an isosurface, evaluated from the basis the record carries, or from a
`.cube` you open from the card. There is still no ESP colour map and no QTAIM analysis.
[Wavefunctions](wavefunction.md) describes the format, the units rule (a negative grid count means
Å), the angular conventions the renderer uses and exactly what is deferred.

## Methods text

Every run can produce a methods paragraph written from the record: engine and version, method,
basis, dispersion, solvation, grid, SCF settings, job type, and the app version and commit. It
refuses two kinds of dishonest sentence:

- it will not describe a dry-run fixture as a calculation;
- when the log carries no version banner, it writes "version not recorded in run.json" instead of
  assuming one.

## Run bundles

**Export run bundle** writes a folder (not a zip) next to a parent directory you choose:

```
<bundle>/
  methods.md        the methods paragraph
  README.md         what the bundle is and how to verify it
  <input>           the exact input file
  <output>          the exact parsed output
  manifest.json     kind, version, and a SHA-256 for every other file
```

`manifest.json` hashes every file so `sha256sum` can verify the copy without a proprietary archive
reader. The target folder must be absent or empty; a second export to the same folder is refused
rather than overwriting a bundle you may already have shared. Names are validated in the shared
layout module, so a bundle can never write outside its own folder.

## What a result does not prove

- That the level of theory was appropriate for the chemistry.
- That a converged optimisation found the structure you meant.
- That a single imaginary mode is the mode you wanted.

The gates and checks are designed to keep those questions visible, not to answer them for you.

## Frontier orbitals

Gaussian prints orbital eigenvalues only when the route asks for it, so a block carries a
**Frontier-orbital descriptors** setting that writes `Pop=Full`. When the log contains the print, the
results panel adds a card with the HOMO and LUMO in hartree and eV, and the quantities derived from that
pair:

| Quantity | Definition |
| --- | --- |
| Gap | E(LUMO) − E(HOMO) |
| Ionisation potential | −E(HOMO) |
| Electron affinity | −E(LUMO) |
| Chemical potential, μ | (IP + EA)/2 |
| Electronegativity, χ | −μ |
| Hardness, η | (IP − EA)/2 |
| Softness, σ | 1/η |
| Electrophilicity, ω | μ²/(2η) |

Two things the panel is explicit about:

- **These are Koopmans' estimates from orbital energies**, not ΔSCF ionisation potentials or electron
  affinities. The two differ by several tenths of an eV, and a paper that reports "IP" may mean either.
- **An open-shell job keeps the alpha and beta manifolds apart.** Each has its own frontier pair, so each
  gets its own column; the panel never averages them into one gap.

`Pop=Full` cannot share a route with `Pop=NBO`, `Pop=Hirshfeld` or `Pop=MK` — Gaussian would print only one
analysis. The conflict is reported as a blocking pre-run finding, and the input builder refuses to write the
route, rather than silently dropping one of the two. Run the charges and the orbitals in separate blocks.

A log without the print is reported as **not printed**, never as a zero gap: the card is absent, and the
dataset export leaves the `homo_ev`, `lumo_ev`, `gap_ev` and `hardness_ev` cells empty. A run that also
carries a formatted checkpoint is the exception for the first three: the checkpoint holds the same
converged orbitals, so those cells are filled from it (see [Wavefunctions](wavefunction.md)).

## Next

[Projects and runs on disk →](project-files.md)

## Figures in the results panel

Spectra, orbital levels and convergence curves are drawn by the shared figure module
(`src/shared/figures/`) rather than by panel-local code, so the panel and the workflow report show
the same picture of the same numbers. Every figure states its broadening and its units, and carries
an accessible name (`role="img"` with a `<title>` and `<desc>`); a measured trace imported over a
computed spectrum is dashed and named in the caption, never merged into the computed curve.
