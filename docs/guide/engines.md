# Engines

NodeChem Studio drives three calculation engines. The engine is resolved per block: a calculation
block that names its own engine (inspector → **Engine**) runs on that engine, and a block that leaves
the field at **Project default** follows **Molecule → Defaults**. A saved project keeps whatever it
saved; the app never switches an engine behind your back, and a block that never set the field keeps
following the project default exactly as before.

This is what makes a mixed workflow possible in one project:

- a **GFN2-xTB pre-optimisation** block (cheap, no licence) followed by
- a **Gaussian single point** or optimisation block (B3LYP-D3BJ/def2-TZVP) that starts from the
  pre-optimised geometry.
- an **ORCA** block for the same job on a machine without a Gaussian licence — ORCA 6 is free for
  academic use and reads a simple `.inp` instead of a Gaussian route.

The step that crosses an engine boundary hands over a **geometry**, not a checkpoint: xTB writes its
result to `xtbopt.xyz` instead of printing it, so the downstream Gaussian block reads the parsed
final geometry from the finished run and rewrites its own molecule specification. The queue refuses
the hand-off, with a specific message, when the upstream run recorded no geometry. Provenance names
the source block and both engines, and the report prints them next to the block.

A setting that belongs to the other engine is refused before the run rather than silently dropped:
a TD-DFT request, a Gaussian checkpoint, `Stable=Opt`, the NMR job type or custom route keywords on
an xTB block stop the run with a message naming the setting. Route fields the xTB engine simply does
not use (method, basis, SCF, grid, population, dispersion) stay ignored, as the inspector already
says, so switching an existing block to xTB does not require clearing the form first.

## Gaussian 16 — licensed commercial software

Gaussian 16 is a general-purpose electronic-structure program. In this app it gives you:

- **DFT and wavefunction methods** — B3LYP, M06-2X, ωB97X-D, PBE0, MP2, CCSD(T) — with an explicit
  basis set: def2-SVP, def2-TZVP, 6-31G(d), 6-311+G(d,p), cc-pVTZ or SDD.
- **Dispersion** (D3(BJ) or D3), **SCF** tightening, **integration grid**, **population analysis**
  (NBO, Hirshfeld, MK charges), **implicit solvation** (PCM, SMD, CPCM) and **verbosity**.
- **Job types**: `SP`, `Opt`, `Opt Freq`, `Freq`, `Opt=TS`, `IRC`, `Scan` and `NMR`.
- **Excited states (TD-DFT/CIS)**: `TD=(NStates=N)` on an `SP` or `Opt` block, with singlets,
  triplets or a 50/50 run. The output's excitation energies, wavelengths, oscillator strengths and
  dominant transitions are parsed into the results panel. Other job types cannot carry `TD`, and
  the input builder refuses them rather than writing a route that fails.
- **Transition-state control**: force constants (`CalcFC`, `CalcAll`, `ReadFC`), optimisation
  convergence (`Tight`, `VeryTight`) and the derived UltraFine grid.
- **Checkpoint hand-offs** between blocks (`%OldChk` plus `Geom=Check` and `Guess=Read`).
- **Thermochemistry** from a frequency job, read out of the log.
- **Validity checks** — the six pre/post-run checks in [Results](results.md#validity-checks).
- **Effective core potentials.** A basis with an ECP (def2 or SDD for any element above krypton)
  written for a heavy atom becomes a `GenECP` route with the basis and pseudopotential blocks
  appended after the molecule. This build ships def2-SVP for Ag, Pd, I, Pt and Au, and SDD (Basis Set
  Exchange "Stuttgart RSC 1997") for Ag, Pd, Pt and Au, taken verbatim from the Basis Set
  Exchange; the run records which
  library and checksum it used. Asking for an element without bundled data is a validation error —
  the app refuses to write a `GenECP` route that Gaussian would reject — and a light-element job is
  written byte-for-byte as before. LANL2DZ is offered as a name but carries no bundled data, so a
  heavy-element job with it is blocked with the same message until its blocks are added.

Gaussian is **licensed separately by Gaussian, Inc.**; the Apache 2.0 licence of this repository
grants no rights to it. The app cannot run Gaussian without a licensed installation on the same
machine and operating system. Windows uses the console `g16.exe`, Linux and macOS use `g16`. A
Windows licence does not authorise a Linux binary, and a Windows licence may not be used under WSL.
No Gaussian binaries or licence files are included, and the app cannot install, bundle or licence
Gaussian for you. Without a licence you can still use the dry run (a labelled fixture) or xTB.

### Running a real Gaussian job

1. Open **Run** and click **Browse** next to the executable field. Choose the licensed console
   executable — `C:\G16W\g16.exe` on Windows, `g16` in the installation directory on Linux and
   macOS. A symlink such as `/usr/local/bin/g16` is resolved to the real installation directory.
2. Set a scratch directory on node-local disk, ideally without spaces: `C:\G16W\SCRATCH`,
   `/scratch/$USER` or `/tmp/g16-scratch`. The runner uses the path unchanged.
3. Click **Preflight**. It checks the platform, the executable and its name for that platform, the
   executable bit (`POSIX`), `GAUSS_EXEDIR` — the directory that actually holds Link 1 (`l1` /
   `l1.exe`) — the run and scratch directories, and host resources. A hard failure blocks the run; a
   warning does not. Scratch warnings are exactly that: warnings about spaces, and about paths that
   look NFS/SMB-mounted on Linux and macOS.
4. Uncheck **Dry run** and run a small job with the licence holder's permission.
5. Read the run folder: `run.json`, the exact `.gjf`, the output, the parsed termination record and
   the gate evidence. **Verify input** recomputes the input hash and reports a mismatch if the
   `.gjf` changed after the run.

If Gaussian reports `Error termination`, stop and read the exact error line. Do not retry blindly,
and do not edit the parser to turn a gate green.

### Default route, and why

New projects start from **B3LYP-D3(BJ)/def2-SVP** (`#p B3LYP/def2-SVP … EmpiricalDispersion=GD3BJ`).
B3LYP has no dispersion term of its own, and leaving it uncorrected silently produces wrong
conformational and interaction energies for exactly the weak interactions most workflows study.

B3LYP-D3(BJ)/def2-SVP was chosen over `r²SCAN-3c` because it is available in every Gaussian 16
revision, keeps the functional and basis independently selectable, and costs little more than the
legacy pair while adding the D3(BJ) correction. `r²SCAN-3c` is an attractive screening composite, but
it depends on a recent Gaussian 16 revision and bundles its own fixed basis, so it is a poorer
compatibility default for a tool that drives an unknown local installation.

Choosing a functional without built-in dispersion defaults **Dispersion** to `D3(BJ)`; a functional
that already carries dispersion, such as ωB97X-D, keeps `None` so the correction is not applied
twice. The inspector's **Route preset** menu keeps a clearly labelled
**Legacy (reproduce a paper)** preset, which restores `B3LYP/6-31G(d)` with no dispersion and
reproduces the pre-change input byte for byte. **Existing project files are never rewritten on open**:
they keep their saved routes, and a block added to a project that saved its own defaults keeps that
project's choice.

### Transition-state searches

A **Transition state** block never emits a bare `Opt=TS`. New TS blocks emit
`#p <method>/<basis> Opt=(TS,CalcFC,NoEigenTest)`, and the inspector's **Force constants** choice
decides where the curvature comes from.

Gaussian's default initial Hessian is a valence-force-field guess, and the G16 manual is explicit
that for optimisations to transition states "some knowledge of the curvature around the saddle point
is essential, and the default approximate Hessian must always be improved". A bare `Opt=TS` either
stalls or walks to a different stationary point.

| Choice | Route | Use |
| --- | --- | --- |
| `CalcFC` (default) | `Opt=(TS,CalcFC,NoEigenTest)` | Normal use: one Hessian at the first point |
| `CalcAll` | `Opt=(TS,CalcAll)` | Expensive; recomputes the Hessian every step |
| `ReadFC` | `Opt=(TS,ReadFC)` | Reuse force constants already on a checkpoint — needs a hand-off from a `Freq` or `Opt=CalcFC` block |
| `Default (unsafe)` | `Opt=TS` | Only to reproduce an old input byte for byte; validation warns |

`ReadFC` needs an explicit checkpoint edge, and validation fails with a specific message when the
block has none or when the upstream block is not a `Freq` or `Opt=CalcFC` job — `Opt` and `SP`
checkpoints contain no Hessian, and an `Opt Freq` Hessian describes a minimum rather than the saddle.
The route is composed in one place (`src/shared/tsForceConstants.js`), so a job type plus its
force-constant choice always produces exactly one `Opt` keyword.

### Optimisation convergence

Gaussian's default optimisation thresholds are loose enough that a following frequency job can be
computed on a geometry that is not converged tightly enough. The **Optimization convergence** select
appears for `Opt`, `Opt Freq` and `Opt=TS` blocks and is composed into the existing job keyword —
there is never a second `Opt=`:

| Choice | `Opt` block | `Opt=TS` with `CalcFC` |
| --- | --- | --- |
| `Default` | `Opt` | `Opt=(TS,CalcFC,NoEigenTest)` |
| `Tight` | `Opt=Tight` | `Opt=(TS,CalcFC,NoEigenTest,Tight)` |
| `VeryTight` | `Opt=VeryTight` | `Opt=(TS,CalcFC,NoEigenTest,VeryTight)` |

An `Opt Freq` block composes to `Opt=Tight Freq`, not `Opt=Tight Opt Freq`. For a DFT method a
tightened optimisation also defaults to `Int=UltraFine`; an explicitly chosen grid wins, and
validation warns when that explicit grid overrides the derived one. The grid is derived at build
time, so `run.json` records the grid that was actually written.

A `Freq` block whose checkpoint hand-off comes from an optimisation left at the default convergence
gets a validation warning naming the upstream block.

## xTB — semi-empirical and force-field methods

xTB is an open-source (LGPL) family of fast approximate methods. In this app it gives you:

- **GFN2-xTB** (default), **GFN1-xTB**, **GFN0-xTB** and the **GFN-FF** force field.
- **Job types** `SP`, `Opt`, `Opt Freq` and `Freq`, with xTB optimisation levels `crude`, `sloppy`,
  `loose`, `lax`, `normal`, `tight`, `vtight`, `extreme`.
- **Implicit solvation**: `ALPB` (analytical linearised Poisson–Boltzmann) or `GBSA` (generalised
  Born with a surface-area term) with Water, Dichloromethane, THF, Toluene or Acetonitrile. ALPB is
  the default and the recommended model for solvation free energies; GBSA is the older
  generalised-Born model, kept for reproducing published GBSA results. The inspector exposes both
  models; the builder emits `--alpb <solvent>` or `--gbsa <solvent>` and the choice is recorded in
  `run.json`. xTB has no `PCM`, `SMD` or `CPCM` — those are Gaussian-only models, and the project
  schema refuses them on a block that resolves to xTB, with a message naming ALPB and GBSA. A
  project saved before that rule may still carry `PCM` on an xTB block whose solvation is off; it
  opens unchanged, but switching solvation on requires choosing `ALPB` or `GBSA`.
- **Threads** via `OMP_NUM_THREADS`, from the `Threads` field in the inspector.
- **Restart hand-off** between blocks: xTB re-reads `xtbrestart` from its working directory, and a
  checkpoint edge copies the upstream run's `xtbrestart` into the downstream run folder.

What xTB does **not** give you here:

- No transition-state search (`Opt=TS`), no IRC and no PES scan. The input builder refuses those
  job types rather than silently downgrading them to a single point.
- No basis set, functional, dispersion, SCF, grid or population-analysis settings. Those fields are
  hidden in an xTB project and stripped from the run payload. GFN2-xTB already includes D4
  dispersion, and xTB's free energy already uses the mRRHO entropy treatment, so the app adds no
  quasi-harmonic or standard-state correction on top of it.
- No Gaussian-route checks. xTB has no route, basis or ECP, so method/basis compatibility and spin
  contamination do not apply and are reported as **not applicable** — never as a pass. The checks
  that do apply run for xTB too: charge/multiplicity parity, geometry sanity, imaginary modes and
  optimisation convergence (read from xTB's own convergence banner).
- No TD-DFT excited states, NMR shielding or NBO/ESP population analysis.

**An xTB run is not a substitute for a Gaussian result.** GFN methods are parameterised
semi-empirical approximations: useful for fast screening, conformer searches and pre-optimisation,
but their energies and barriers are not comparable to a DFT or wavefunction calculation. If a
workflow needs a Gaussian level of theory, it needs a licensed Gaussian installation.

### Setting up xTB

1. Install xTB so the executable and its `share/xtb` parameter directory are available (release
   tarballs ship `bin/xtb` beside `share/xtb`). No licence file is needed.
2. Open **Molecule → Defaults**, set **Engine** to `xTB (GFN-xTB)`, then choose the **Hamiltonian**
   and **Optimisation level**. The geometry comes from the **Structure** tab; until you import a
   file, the labelled demo water geometry is used.
3. Open **Run** and click **Browse** next to *xTB executable*; select `xtb` (or `xtb.exe` on
   Windows). The app looks for parameters in `../share/xtb` relative to the executable. If your
   install is elsewhere, export `XTBPATH` pointing at that directory; preflight accepts either.
4. Leave **Dry run** checked to exercise the labelled fixture, or uncheck it and click
   **Preflight**. For xTB, preflight checks that the executable exists, is named `xtb`/`xtb.exe`,
   and that parameter files were found (or `XTBPATH` is set).
5. Click **Run selected block**. xTB writes its output to **stdout**; the run folder keeps the
   captured stream as `<input>.out`, and xTB also writes `xtbopt.xyz` and `xtbrestart` beside it.

xTB's exit status is `0` on success and `128` on any error stop. The optimised `xtbopt.xyz` is
written to the run folder; it is not automatically loaded back as the project geometry.

## ORCA 6 — free for academic use

ORCA is a general-purpose electronic-structure program from FACCTs (MPI für Kohlenstoffforschung).
It is free of charge for academic use but is **not** Apache-2.0: the repository ships no ORCA binary,
no licence file and no ORCA source. Install ORCA yourself and follow its licence terms.

In this app ORCA gives you:

- **Methods** `B3LYP`, `PBE0`, `M06-2X`, `MP2`, `CCSD(T)` and `HF`, with **basis sets** `def2-SVP`,
  `def2-TZVP`, `cc-pVTZ`, `6-31G(d)` (written as ORCA's `6-31G*`) and `6-311+G(d,p)`.
- **Job types** `SP`, `Opt`, `Freq` and `Opt Freq`. `Opt Freq` is ORCA's compound job: optimise,
  then compute the Hessian at the minimum.
- **Dispersion** `D3(BJ)` → `D3BJ`, `D3` → `D3ZERO` and `D4` → `D4`.
- **SCF** `Tight` → `TightSCF` / `VeryTight` → `VeryTightSCF`; **grid** `Fine` → `DEFGRID2` /
  `UltraFine` → `DEFGRID3`; optimisation convergence `Tight` → `TightOpt` /
  `VeryTight` → `VeryTightOpt`.
- **Implicit solvation** `CPCM` and `SMD` with Water, Dichloromethane, THF, Toluene or
  Acetonitrile. CPCM is written as `CPCM(SOLVENT)`; SMD is switched on in the documented
  `%cpcm` block with `smdsolvent "SOLVENT"`.
- **Resources**: `Cores (nproc)` becomes `%pal nprocs N end`, and the block's total memory is
  divided by the core count into ORCA's per-process `%maxcore` (MB).

The builder writes ORCA's **simple input** — a `!` keyword line, optional `%pal`/`%maxcore`/
`%cpcm`/`%moinp` blocks, and a `* xyz charge multiplicity` coordinate block:

```
! B3LYP def2-SVP Opt Freq D3BJ TightSCF CPCM(WATER)
%pal nprocs 4 end
%maxcore 1024
* xyz 0 1
O     0.000000    0.000000    0.117300
H     0.000000    0.757200   -0.469200
H     0.000000   -0.757200   -0.469200
*
```

What ORCA does **not** give you through this builder:

- No transition-state search, IRC, relaxed PES scan or NMR job. Those need `%geom`, `%irc` or
  `%elprop` blocks, so the input builder refuses them instead of writing a keyword that runs a
  different job.
- No TD-DFT excited states, population analysis (NBO/ESP), Raman activities, `Stable=Opt` or custom
  route keywords. Those are Gaussian-only form fields in this app; a block that carries one is
  refused with a message naming the field.
- No Gaussian `PCM` keyword: ORCA implements CPCM and SMD. `SDD` has no simple-input keyword in
  this builder; use `def2-TZVP`, which carries ECPs for the heavy elements it covers. `ωB97X-D` is
  also refused: ORCA's `wB97X-D3`/`wB97X-D4` are different functionals from the Gaussian keyword, so
  mapping one to the other would silently change the level of theory.
- No Gaussian `.chk` checkpoint hand-off. ORCA's restart file is `<job>.gbw`: the builder writes
  `%moinp "<job>.gbw"`, the queue transfers that file between ORCA blocks, and an ORCA edge that
  names a `.chk` is refused rather than staged under the wrong name. A cross-engine edge still
  hands over a geometry, not a checkpoint.

### Setting up ORCA

1. Install ORCA 6 (or ORCA 5) so the `orca` driver (`orca.exe` on Windows) and its module binaries
   are in one directory. No licence file is needed for academic use, but you must accept ORCA's
   licence yourself.
2. Open **Molecule → Defaults**, set **Engine** to `ORCA 6`, then choose the method and basis. The
   geometry comes from the **Structure** tab.
3. Open **Run** and click **Browse** next to the executable field; select the `orca` driver by its
   **full path** (`/opt/orca/orca`, `C:\ORCA\orca.exe`). ORCA's parallel driver must be called by
   full pathname — preflight warns when it is not.
4. Click **Preflight**. For ORCA it checks the platform, that the executable exists and is named
   `orca`/`orca.exe`, and (on Linux/macOS) that it is executable. ORCA needs no Link 1 and no
   `share/xtb` parameter directory, so those Gaussian/xTB checks do not run.
5. **Run it.** The app spawns the driver as `orca <input>.inp` in the run folder and captures
   **stdout** as the run's output file, which is what `orca job.inp > job.out` would have given you.
   stderr is kept out of that file and stored in the run record (`provenance.orca.stderr`), so a
   driver that fails before ORCA starts still says why. ORCA's side files that the process actually
   wrote — `<job>.gbw`, `<job>.xyz`, `<job>.hess`, `<job>_trj.xyz`, `<job>.property.txt` — are listed
   in `provenance.orca.artifacts`.

   Three behaviours worth knowing:

   - **The exit code is not the verdict.** ORCA can exit 0 after an error banner, so the record's
     status comes from the text (`ORCA TERMINATED NORMALLY` / `ORCA finished by error termination in
     <module>`). A run that exits 0 with an error termination is recorded as failed.
   - **A run that printed nothing is failed, not "needs review".** Saying nothing is not a result;
     the record quotes stderr in that case.
   - **Cancel and timeout stop the whole process group.** ORCA's driver spawns the real modules as
     children; signalling the driver alone leaves them running.

### What this build proves about the ORCA parser

The parser was written from the output shapes documented in the **ORCA 6.0 manual and tutorials**
(`SCF CONVERGED AFTER … CYCLES`, `FINAL SINGLE POINT ENERGY`, the `HURRAY` convergence banner,
`VIBRATIONAL FREQUENCIES`, `THERMOCHEMISTRY AT 298.15K`, `ORCA TERMINATED NORMALLY` and
`ORCA finished by error termination in <module>`). **No live ORCA binary was run for this build.**
Its tests use synthetic fixtures that reproduce those line shapes, so they prove the parser reads
the documented format — not that a particular ORCA 5/6 revision prints it identically.

The same limit applies to execution: the runner is tested against a stand-in driver script that
prints those fixtures, exits 0 after an error banner, prints nothing, sleeps and gets cancelled. It
proves the spawning, capture, termination and cancellation paths, and nothing about ORCA itself.

The first real run should be a small single point. Check the parsed `FINAL SINGLE POINT ENERGY`, the
SCF cycle count and the termination line against the log; if a revision prints a different shape,
the parser reports the value as `unknown` rather than guessing. Please report the log.

Two parser choices are deliberate:

- ORCA prints **all 3N** harmonic modes, including the five or six near-zero translations and
  rotations. The result's frequency count is therefore 3N, and the imaginary count only counts modes
  below −0.001 cm⁻¹ (or marked `***imaginary mode***`).
- ORCA's default thermochemistry uses the quasi-harmonic **QRRHO** entropy treatment, which the
  result records as `entropyTreatment: QRRHO`. The app adds no extra quasi-harmonic or
  standard-state correction on top of it, exactly as for xTB.

If **Dispersion** is set to `None`, the builder writes no dispersion keyword. ORCA 6 may then apply
its own default (D4 for many functionals), so record the `Dispersion correction` line in the log
before comparing energies across engines; the manifest records only the keyword the builder wrote.

## Which settings belong to which engine

| Setting | Gaussian 16 | xTB | ORCA 6 |
| --- | --- | --- | --- |
| Level of theory | Method + basis set | `--gfn 0/1/2` or `--gfnff` | `! method basis` |
| Basis set, dispersion, SCF, grid, population | Used | Ignored — fields hidden and stripped from the payload | Mapped to ORCA keywords; population refused |
| Solvation | PCM / SMD / CPCM, Water…Acetonitrile | ALPB / GBSA, Water…Acetonitrile | CPCM / SMD, Water…Acetonitrile |
| Job types | SP, Opt, Opt Freq, Freq, Opt=TS, IRC, Scan, NMR | SP, Opt, Opt Freq, Freq | SP, Opt, Opt Freq, Freq |
| Optimisation control | `Opt=Tight`/`VeryTight`, force constants | `--opt <level>` / `--ohess <level>` | `TightOpt` / `VeryTightOpt`, `DEFGRID2/3` |
| Resources | `Memory` + unit, `Cores (nproc)`, checkpoint file | `Threads (OMP_NUM_THREADS)` | `%maxcore` (MB per core), `%pal nprocs` |
| Checkpoint hand-off | `%OldChk` + `Geom=Check`/`Guess=Read` | Copies `xtbrestart` into the downstream run folder | `%moinp "<job>.gbw"`; queue transfer not implemented |
| Validity checks | Six checks, pre and post run | Four applicable checks; Gaussian-only ones reported *not applicable* | Canonical gates on the parsed result; Gaussian-route checks do not apply |
| Dry run | Labelled `FIXTURE OUTPUT` fixture | Labelled `FIXTURE OUTPUT` fixture | Labelled `FIXTURE OUTPUT` fixture |

A dry run is a fixture for both engines: it writes a synthetic file headed `FIXTURE OUTPUT`, starts
no process, and is never a calculation. ORCA uses the same fixture path.

## Next

[Workflows →](workflow.md)
