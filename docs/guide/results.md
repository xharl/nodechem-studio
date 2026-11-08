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
more than those two inputs — IRC path verification, standard-state declaration, conformer coverage,
comparable-energy bookkeeping — are not implemented. xTB results are not judged at all: the checks
are Gaussian-route checks, so an xTB record leaves them absent.

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

## NMR shieldings


An `NMR` job produces an **NMR** card with every atom's isotropic shielding, anisotropy and tensor
eigenvalues, the gauge Gaussian used (GIAO), and a simulated spectrum.

Gaussian reports **absolute** isotropic shieldings in ppm. A chemical shift is
`σ_reference − σ_isotropic`, and the reference must be computed at the same level of theory — there is
no universal TMS number. The card therefore starts in absolute mode; entering a reference in the
**σ_ref** field converts the table and the figure to shifts, and the caption prints the reference it
used. Without one, the figure says *absolute shielding*, because it is not a spectrum in ppm shift.

Broadening is a Lorentzian with a FWHM you set in the card (default 0.10 ppm) and the caption always
states it, along with the number of nuclei in the trace. Raman activities, VCD/ROA rotational
strengths and conformer-weighted spectra are not implemented.

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

The parser does not extract normal-mode displacement vectors today, so the animation controls appear
only when a caller supplies explicit mode data. Without it the panel says
`Normal modes not present in this output.` and shows a static geometry — it never invents motion.

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
