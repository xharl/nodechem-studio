# Engines

NodeChem Studio drives four calculation engines. The engine is resolved per block: a calculation
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
- **VCD rotational strengths** (#78) — `Freq=VCD` on a `Freq` or `Opt Freq` block, parsed per mode
  with the dipole strength and the E–M angle Gaussian prints beside them. The rotational strength is
  **signed**, and the panel draws it around a zero line instead of a magnitude. Gaussian 16 prints
  the unit (`10⁻⁴⁴ esu² cm²`) but **no velocity/length representation label**, so the record keeps
  `representation: null` and the panel says the representation is not stated rather than choosing
  one: the two agree only in a complete basis. Raman and VCD combine into one keyword,
  `Freq=(Raman,VCD)`. ROA is a Gaussian 16 B.01+ feature and is not read here — this repository has
  no real ROA log to write a parser against, and it does not guess layouts.
- **Validity checks** — the pre- and post-run checks in [Results](results.md#validity-checks), including
  `excited-state-root` (a root the TD job computes, and a `Pop=NTO` source with a TD record).
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

### Optimising an excited state

An `Opt` or `Opt Freq` block can follow one excited state instead of the ground state. Set
**States** (`tdStates`) and **Root** (`tdRoot`) in the inspector's *Excited states (TD)* group; the
route carries both:

```
#p B3LYP/def2TZVP Opt TD=(NStates=3,Root=1)
```

`Root` is the state Gaussian relaxes. It is never inferred and never clamped: **States 3 / Root 0**
is a validation **error**, because that route optimises the ground state while the block reads as an
excited-state optimisation, and **Root 4 / States 3** is an error too, because the TD job never
computes state 4. The message names both fields. The same two refusals are repeated by the input
builder, so a route is never written from a block that skipped project validation.

**What "Optimization completed" means.** Gaussian's own optimisation criteria were met on the
potential-energy surface of the root it followed. The convergence report reads the per-step
`Excited State N:` records and the final table, and its `excited-state` gate passes only when
`Optimization completed` is present **and** the final table carries the requested root. A truncated
log, a missing marker, or a table without that root is reported as **unknown** — never as a pass and
never as a failure.

**What it does not mean.** The geometry is not proven to be a minimum of the excited-state surface:
that needs a frequency job on that surface, which this block does not run. It also does not give the
adiabatic **0–0** energy — the difference between the S1 and S0 minima plus both zero-point energies
— and it says nothing about fluorescence lifetime, quantum yield or a measured Stokes shift. The
vertical emission energy at that geometry is a separate single-point block; see
[Results](results.md#emission).

**No real log for this job type has been seen by this build.** There is no `Opt TD` log in the
repository's test corpus (no fixture contains both `Excited State` and `Optimization completed`), so
the report is parsed from the documented Gaussian layout, carries `verified: false`, and the results
card says *this build has not seen a real log for this job type*. A per-step geometry is
deliberately not returned: reporting `null` is honest where a guessed atom list would not be.

### Constrained optimisation and relaxed scans

A block can hold **coordinate constraints**: a frozen bond length, bond angle, dihedral or atom.
Gaussian reads them from a `ModRedundant` section after the molecule specification, so the builder
names `ModRedundant` on the route and writes one line per constraint:

```
#p B3LYP/6-31G(d) Opt=(CalcFC,ModRedundant)
...
0 1
C   -0.700000     0.000000     0.000000
O    0.700000     0.000000     0.000000
...
B 1 2 F
```

The atom numbers are the 1-based numbers of the geometry that is actually in the file. Under
RFC 0001 a dataset record's coordinates replace the project geometry, so the builder validates
the indices against the written geometry and refuses an out-of-range index with a message naming
the atom and the atom count instead of letting Gaussian abort link 103.

Gaussian 16 freezes the coordinate at the value in the geometry; since G09 C.01 a value on the
`ModRedundant` line is not read. The inspector therefore shows the measured value
("C1–O2 distance, 1.400 Å") and a declared value is a check: it must match the geometry, or the
input is refused rather than silently freezing a different number. To freeze a forming bond at
1.8 Å, import or set a geometry with that bond.

Validation also refuses duplicate constraints (a bond reads the same either way round, an angle
from either end, a dihedral reversed), a constraint set that leaves no internal degree of freedom,
constraints on an engine or job type that has no `ModRedundant` section, and a frozen coordinate
on a `Scan` block — `Scan` steps Gaussian's `Scan` keyword and has no such section.

A constrained optimisation that asks for force constants (`CalcFC` or `CalcAll`) emits them into
the job keyword, which is what makes it a legitimate `ReadFC` source for a later `Opt=TS` block:
the usual route to a saddle is a relaxed scan, then a saddle search that reads the curvature the
scan produced. A constrained saddle search left on the estimated Hessian gets a validation warning.

### QST2 and QST3

`Opt=QST2` and `Opt=QST3` are **job types**. STQN needs two or three complete molecule
specifications in one input — reactant, product, and for QST3 an initial TS guess — so the block
stores the extra structures itself. The inspector's **QST2 / QST3** group copies them from the
block's own geometry, from the parsed final geometry of a finished block, or from a structure file;
the coordinates are snapshotted into the block, so the project file carries them and
`ncs build-input` writes exactly what the app writes.

```
#p B3LYP/6-31G(d) Opt=QST2
...
0 1
C   -0.700000     0.000000     0.000000
...
QST search — structure 2 (product)
0 1
C   -0.700000     0.000000     0.000000
...
```

Gaussian's requirement is that *the order of the atoms is identical within all molecule
specifications*. That mismatch is the classic silent failure — the interpolation pairs atom 4 of
the product with atom 4 of the reactant and walks through a barrier that does not exist — so the
builder refuses it and names the first mismatching index, and it never reorders atoms itself. It
also refuses a missing product (QST2), a missing TS guess (QST3), and a structure whose atom count
differs from the block geometry. `TS` is never combined with `QST2`/`QST3`: Gaussian documents that
the two must not be specified together.

Constraints and QST2/QST3 compose: with constraints, a `ModRedundant` section follows *every*
molecule specification, as Gaussian requires.

**Not proven:** none of this has been run under a licensed Gaussian 16 in this build. The route
text, the section layout and the refusals follow the G16 keyword documentation quoted above, and
they are covered by tests, but no output file has been produced or parsed. Do not treat a job that
plans cleanly as a job that has been shown to converge.

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

## Psi4 — open source, LGPL-3.0

Psi4 is an open-source electronic-structure package. In this app it gives you:

- **Methods**: HF, B3LYP, PBE0, M06-2X, ωB97X-D, B97-D, MP2, CCSD, CCSD(T) and SAPT0.
- **Bases**: def2-SVP/TZVP/QZVP, 6-31G(d), 6-31G(d,p), 6-311++G(d,p), cc-pVDZ/TZVP/QZVP and
  aug-cc-pVDZ.
- **Job types**: `SP`, `Opt`, `Freq`, `Opt Freq` and `TD-DFT` — the four point/geometry jobs, and
  the excited-state one described below.
- **TD-DFT** writes `set tdscf_states N` and `energy('td-<method>')`, and the app parses Psi4's
  excitation table — energy in au and eV, total energy, oscillator strength and rotatory strength in
  both the length and velocity forms. **N is not a promise of the N lowest states:** Psi4 splits the
  request across the point group's irreducible representations in point-group order. Measured on
  D<sub>2h</sub> ethylene at B3LYP/6-31G\*: asking for 5 states allocated one each to Ag, B1g, B2g,
  B3g and Au and **none to B1u**, so all five came back with f = 0; asking for two per irrep returned
  the bright B1u at 8.236 eV (f = 0.3501) and again at 12.696 eV (f = 0.4183). The inspector says so
  beside the States field. Excited-state *optimisation* is refused by name — Psi4 cannot relax an
  excited surface in this build — as is a Root above 1.
- **SAPT0** on a dimer, with the interaction energy split into electrostatics, exchange, induction
  and dispersion.

**Which energy is reported.** A correlated Psi4 job prints several totals in the same log, and the
result is the one the job asked for: the `CCSD(T)` total when that is the method, else the `CCSD`
total, else the canonical (unprefixed) `Total Energy` of the MP2 module. Psi4 1.11 also prints a
spin-component-scaled `SCS Total Energy` beside the MP2 total; the SCS number is **not** reported as
an MP2 result — the two are different methods, 3.8 mEh apart on water/def2-SVP. If you want SCS-MP2
as a method of its own it needs its own method key, and that is not in this build.

Psi4's input is **code** (Psithon, a Python dialect), which is why this engine's builder is stricter
than the others: every line of the script is written by the app, and a project field is never
interpolated as a statement. A title containing a quote lands in a `#` comment, not in a call.

What a Psi4 block will **not** do in this build, each refused by name rather than dropped:

- **Implicit solvation** — Psi4 core has no PCM/SMD; that needs PCMSolver and a separate setup.
- **TD-DFT excited states**, **NMR shieldings**, **NBO populations** and **transition-state
  searches** — not written by this builder yet.
- **A separate dispersion correction** — Psi4 takes D3 through the functional name, so choose
  ωB97X-D or B97-D instead of a `-D3BJ` field.
- **Gaussian grid keywords and custom routes** — no equivalent is guessed.
- **Frequencies at CCSD/CCSD(T)** — Psi4 has no analytic Hessian there; run the frequency at DFT
  or MP2 level.
- **Checkpoint hand-off** — Psi4 leaves no restart file this app can hand to another block; a
  downstream block reads the upstream geometry instead.

Two things the parser does deliberately, because a Psi4 log can mislead:

- **SAPT reports an interaction energy, not a total energy.** The result therefore carries no
  `finalEnergy`; the numbers live under `extras.sapt` in mEh, kcal/mol and kJ/mol. Putting a
  monomer-pair interaction in the same field as a molecular energy would invite the wrong comparison.
- **`Psi4 exiting successfully` is about the process, not the science.** Psi4 prints it even when an
  optimisation inside the run failed with `Could not converge geometry optimization`. The run record
  reports the optimisation as incomplete and lets the gates decide; the termination line is not a
  pass.

### Setting up Psi4

1. Install Psi4 1.4 or newer (conda-forge is the usual route) so a `psi4` executable exists
   (`psi4.exe` on Windows). Psi4 needs `PSIDATADIR` to find its basis sets; a conda installation
   sets it from its launcher.
2. Set **Molecule → Defaults → Engine** to `Psi4`, then choose method and basis. The geometry comes
   from the **Structure** tab.
3. In **Run**, select the `psi4` executable with **Browse**.
4. **Preflight** checks the platform, that the executable exists and is named `psi4`, that it is
   runnable on Linux/macOS, and warns when `PSIDATADIR` is not set in the environment.
5. **Run it.** The app spawns `psi4 <task>.dat` in the run folder. Psi4 1.9+ writes its formatted
   log to `<task>.out` **itself**; older builds print it to stdout. The runner takes whichever exists:
   a non-empty `<task>.out` left by Psi4 is read as the artifact (`outputSource: file`), otherwise the
   captured stdout is written there. A run folder is fresh, so an existing file at that name can only
   be Psi4's own log — and writing the (empty) capture over it would destroy the record.
   stderr is never merged into the artifact and is kept under `provenance.psi4.stderr`. Threads come
   from the block's `nproc` through `OMP_NUM_THREADS` and `MKL_NUM_THREADS`.

An error termination (`Psi4 encountered an error. Buy a developer more coffee!`) is recorded as
failed, and so is a run that printed nothing at all — the record quotes stderr in that case.

### What this build proves about the Psi4 parser

Two corpora, because the format changed:

- **Psi4 1.1rc3 – 1.4a1**, eight complete logs from Psi4's own test suite and RMG-Py, in
  `test/fixtures/real/psi4-*.out`: HF, B3LYP frequencies with thermochemistry, two optimisations (one
  converged, one that is not), MP2, CCSD, SAPT0 and a PSIO error termination.
- **Psi4 1.11**, five runs produced in this repository by the official `psi4/psi4:1.11` container
  image and kept in `test/fixtures/psi4-live/`: a single point, an optimisation, a frequency job, an
  open-shell UKS run and a SAPT0 dimer. The inputs beside them were written by this app's builder, so
  the pair also proves the generated script is one Psi4 accepts.

A live run found a real difference the older logs could not: Psi4 1.9+ writes its log to
`<task>.out` itself rather than to stdout, and the first version of the runner overwrote that file
with an empty capture. The runner now prefers the file Psi4 wrote.

The end-to-end path was exercised the same way: the app's own `RunManager` and `Psi4Runner` spawned a
containerised Psi4 1.11 through a wrapper, and the run record came back `completed`, gates `pass`,
`-76.35815199866961` Eh, 7 SCF cycles, Psi4 `1.11`.

Three blocks changed shape in 1.9+ and the parser accepts both: `Energy and wave function
converged.`, `Optimizer: Optimization complete!` with no step count, the `Freq [cm^-1]` table instead
of the `#  #` list, and `Total G, Gibbs energy at`.

What is still not proven: a 1.11 failure mode other than the ones in the corpus (the 1.1 logs cover
the error banner and a non-converged optimisation), and any platform other than Linux. A block shape
the parser does not recognise is reported as `unknown`, never guessed.

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
