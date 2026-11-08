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
