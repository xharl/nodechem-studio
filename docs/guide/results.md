# Results

Two questions get answered separately, and that separation is the most important idea in this app:

- **Did the job run?** → **gates**. Normal termination, SCF convergence, the frequency record, the
  final energy. A gate result is `pass`, `fail` or `unknown`. Missing evidence is `unknown`, never
  `pass`.
- **Is the result defensible?** → **validity checks**. Charge/multiplicity parity, spin
  contamination, geometry sanity, imaginary-mode count, method/basis compatibility, optimisation
  convergence. A check that does not apply to the selected engine (for example method/basis
  compatibility under xTB) is reported as **not applicable**, which is different from **unknown**
  ("the question applies but there is no evidence") and is never a pass.

- **How does it differ from the run before?** → **Compare**. Under a finished run, pick another
  run; the panel shows both values, the signed difference (comparison minus baseline) and flags a
  comparison across different methods, bases or engines instead of presenting it as a re-run.
  A value one run did not report stays *not reported*.

- **How do I get every run into a spreadsheet?** → **Export run dataset** in the overflow menu,
  as CSV or JSON. One row per finished run: engine, job type, method, basis, dispersion,
  solvation, status, gate and validity verdicts, energies, imaginary count, SCF cycles, elapsed
  time, dry-run flag and both hashes. Missing values are empty cells, never zeros; a dry run stays
  flagged. The JSON envelope carries a schema version and the app version.

- **What is in this folder of old logs?** → **Batch import logs…** in the overflow menu. Pick a
  folder and every `.log`/`.out` file is parsed with the same parser a live run uses, then listed
  with its status, engine, level of theory, final energy, free energy, imaginary count and failure
  cause. The scan is read-only — nothing is imported into the project — and a file over 32 MB or
  one that cannot be read is listed as skipped with the reason.

A run can execute correctly and still be scientifically unsupported. The record states both, and
validity findings never change `gates.overall`.

## The results panel

When a run finishes, or when you select a finished run in **Recent runs** or in the queue, the panel
below the output shows what the parser actually reported:

- the **engine** that ran, and the run status,
- the **excited states** table when the job printed a TD record (energy in eV, wavelength, f and
  the dominant transitions), with a simulated UV-Vis curve whose Gaussian broadening is printed
  as an explicit FWHM — the caption says it is a simulation, not a measured spectrum,
- the **gate list** with its verdict and evidence,
- parsed values — termination, SCF energy and cycles, frequencies and the imaginary count, final
  energy, charges, thermochemistry when present,
- `not reported` for a field the parser did not find. It is never guessed, and an absent value is
  never rendered as zero,
- a **FIXTURE** badge on a dry-run record and a **truncated** badge when the output exceeded the
  capture limit, next to the numbers the badge affects.

The panel is a pure function of one `run.json` record: it reads no disk and invents nothing.

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

Which gates are required comes from the block's **Gates** checkboxes in the inspector, so the record
states exactly what the block asked for. A required gate that cannot be judged makes the task
`needs-review` and blocks its dependents. It is never silently promoted to a pass.

## Validity checks

Six checks, implemented as pure functions in `src/shared/validityChecks.js`. They run before a job
(project **Validate** and run start) and after it (`run.json` → `gates.validity`).

| Check | What it verifies | Phase | A failure is |
| --- | --- | --- | --- |
| `charge-multiplicity` | Electron-count parity; unpaired electrons ≤ electrons; a restricted reference that contradicts an open-shell multiplicity | pre, post | error — blocks export and run |
| `spin-contamination` | `S**2` before and after annihilation against `S(S+1)`; the deviation is recorded | post | error above 0.50, warning above 0.10 |
| `geometry-sanity` | Atom clashes, implausibly short contacts, stretched bonds, angle anomalies against covalent-radius sums | pre | error for a clash, warnings otherwise |
| `imaginary-frequencies` | Exactly one imaginary mode for `Opt=TS`, none for `Freq`/`Opt Freq`, and the magnitude floor | post | error |
| `method-basis-compatibility` | Heavy elements in a basis with no ECP; semi-empirical or composite methods given a basis; empirical dispersion added twice | pre, post | error for the ECP gap, warnings otherwise |
| `opt-convergence` | A frequency job only claims a minimum when its optimisation reported completion | pre, post | reported as a failure; does not block the run |

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
- a **Conformer ensemble** picker: select two or more finished runs that report a free energy and get
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

**pKa** is computed from an isodesmic cycle with the constant already defined for the thermochemistry module (1.364 kcal mol⁻¹ per pKa unit at 298.15 K). The helper requires the deprotonation free energy, the reference free energy, the reference pKa and the solvent; missing any of them returns `available: false` with the list of what is missing, because a pKa without its solvent and reference is a free-energy difference with a decimal point moved.

## NMR shieldings


An `NMR` job produces an **NMR** card with every atom's isotropic shielding, anisotropy and tensor
eigenvalues, the gauge Gaussian used (GIAO), and a simulated spectrum.

Gaussian reports **absolute** isotropic shieldings in ppm. A chemical shift is
`σ_reference − σ_isotropic`, and the reference must be computed at the same level of theory — there is
no universal TMS number. The card therefore starts in absolute mode; entering a reference in the
**σ_ref** field converts the table and the figure to shifts, and the caption prints the reference it
used. Without one, the figure says *absolute shielding*, because it is not a spectrum in ppm shift.

Broadening is a Lorentzian with a FWHM you set in the card (default 0.10 ppm) and the caption always
states it, along with the number of nuclei in the trace. VCD/ROA rotational strengths and
conformer-weighted spectra are not implemented; see the Raman section below for what is.

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

## Emission and ECD

**Emission.** Start from the **Emission from S1 (Opt then TD)** template: the first block emits
`TD=(NStates=1,Root=1) Opt`, which relaxes the S1 surface, and the second runs TD at that minimum on a
checkpoint edge. The results panel labels the lowest excitation of the second block as the **vertical
emission from the excited-state minimum** and prints the block it came from. It is not the adiabatic
0–0 energy: that also needs the zero-point energy of both surfaces, which this workflow never computes.

The label is derived from the workflow, not from the log — the same excitation table means absorption
at the ground-state minimum and emission at the excited minimum, and only the graph knows which one
was run.

**ECD.** A TD job prints rotatory strengths in two conventions, `R(velocity)` and `R(length)`. They
agree only in a complete basis, so the ECD card asks which one to plot and prints the choice, the
printed unit (10⁻⁴⁰ erg·esu·cm/Gauss) and the broadening. The curve is signed: a positive band and a
negative band are the two signs of the Cotton effect. No Δε is computed — that needs a band shape and
an instrument calibration the log does not carry.

If every printed rotatory strength is zero, the card says the molecule is **achiral** rather than
showing a flat line with no explanation.

Natural transition orbitals are not implemented; they need the wavefunction analysis tracked in #59.

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

The barrier shown is a potential-energy difference on the computed points. It is **not** ΔG‡, it
carries no thermochemical correction, and no rate constant is derived from it. For a ΔG‡ you need a
frequency job at the saddle point and at each minimum; that work is tracked in the issue tracker.

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

## Next

[Projects and runs on disk →](project-files.md)
