# Engines

NodeChem Studio drives five calculation engines. The engine is resolved per block: a calculation
block that names its own engine (inspector → **Engine**) runs on that engine, and a block that leaves
the field at **Project default** follows the project's defaults in **Project settings…**. A saved
project keeps whatever it saved; the app never switches an engine behind your back, and a block
that never set the field keeps following the project default exactly as before.

This is what makes a mixed workflow possible in one project:

- a **GFN2-xTB pre-optimisation** block (cheap, no licence) followed by
- a **Gaussian single point** or optimisation block (B3LYP-D3BJ/def2-TZVP) that starts from the
  pre-optimised geometry.
- an **ORCA** block for the same job on a machine without a Gaussian licence — ORCA 6 is free for
  academic use and reads a simple `.inp` instead of a Gaussian route.

The step that crosses an engine boundary hands over a **geometry**, not a checkpoint: xTB writes its
result to `xtbopt.xyz` instead of printing it, so the downstream block reads the parsed final geometry
from the finished run and rewrites its own deck — Gaussian's molecule specification, PySCF's data
line, Psi4's `molecule { … }` block, ORCA's `* xyz … *` block, or a fresh `.xyz` frame for xTB. Only
the atom rows change: the route, the charge/multiplicity header, fragment separators and anything
after the geometry stay as they were. The queue refuses the hand-off, with a message naming both
blocks, when the upstream run recorded no geometry or when the deck has no geometry block to rewrite
— it never runs the unoptimised structure and calls that a hand-off. Provenance names the source
block and both engines, and the report prints them next to the block.

A setting that belongs to the other engine is refused before the run rather than silently dropped:
TD-DFT states or triplets, `Stable=Opt`, the NMR job type, a composite-method job type, Raman, VCD or
ROA, frontier-orbital descriptors or custom route keywords on an xTB block stop the run with a
message naming the setting. Route fields the xTB engine simply does not use (method, basis, SCF,
grid, population, dispersion) stay ignored, as the inspector already says, so switching an existing
block to xTB does not require clearing the form first.

## Gaussian 16 — licensed commercial software

Gaussian 16 is a general-purpose electronic-structure program. In this app it gives you:

- **DFT and wavefunction methods** — B3LYP, M06-2X, ωB97X-D, PBE0, MP2, CCSD(T) — with an explicit
  basis set: def2-SVP, def2-TZVP, 6-31G(d), 6-311+G(d,p), cc-pVTZ or SDD.
- **Dispersion** (D3(BJ) or D3), **SCF** tightening, **integration grid**, **population analysis**
  (NBO, Hirshfeld, MK charges), **implicit solvation** (PCM, SMD, CPCM) and **verbosity**.
- **Job types**: `SP`, `Opt`, `Opt Freq`, `Freq`, `Opt=TS`, `Opt=QST2`, `Opt=QST3`, `IRC`, `Scan` and
  `NMR`, plus the composite methods — `CBS-4M`, `CBS-QB3`, `CBS-APNO`, `G1`, `G2`, `G3`, `G4` and
  `G4(MP2)` — which are job types of their own rather than a method/basis pair; see
  [Results](results.md#composite-methods).
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
  one: the two agree only in a complete basis. Raman, VCD and ROA combine into one keyword,
  `Freq=(Raman;VCD;ROA)` — written `Freq=(Raman,VCD,ROA)` — and ROA is read per mode with its
  three printed scattering geometries (`ROA1` ICPu/SCPu(180), `ROA2` ICPd/SCPd(90), `ROA3`
  DCPI(180)) plus `RC180`. The pinned ROA fixture is a real Gaussian 09 E.01 log; a G16 B.01+
  log was not found, so that revision is not claimed.
- **Validity checks** — the pre- and post-run checks in [Results](results.md#validity-checks), including
  `excited-state-root` (a root the TD job computes, and a `Pop=NTO` source with a TD record).
- **Effective core potentials.** A basis whose pseudopotentials Gaussian 16 already ships —
  `def2-SVP`, `def2-TZVP`, `SDD`, `LANL2DZ` — is written as the plain route keyword even for a heavy
  atom: the program carries the matching ECP, and no `GenECP` card block is written, because a real
  Gaussian 16 A.03 run rejected such a block at link 301. A basis with no ECP for a heavy element
  (`6-31G(d)` on Pd, say) is a validation error that names the elements and points at `LANL2DZ`,
  `SDD` or a def2 basis, so the app never writes a route Gaussian cannot run. A light-element job is
  written byte-for-byte as before. The repository still carries Basis Set Exchange copies of def2-SVP
  (Ag, Pd, I, Pt, Au) and SDD (Ag, Pd, Pt, Au) with their library name and checksum, and `run.json`
  records an ECP section when an input actually carries one.
- **ONIOM results** — a Gaussian ONIOM log is read: the extrapolated energy is the reported total,
  and the card prints the three gridpoint components, the layer counts, the cuts Gaussian used as
  link atoms and the per-layer charge/multiplicity lines. The reader checks
  `high(model) + low(real) − low(model)` against the extrapolated energy. It does **not** build an
  ONIOM input or invent link atoms; those are still open in #67.

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
  GFN-FF is the supported force-field pre-optimisation path: optimise in an xTB block, then pass
  the geometry to a QM block. It is not ONIOM/QM-MM: there are no layers, link atoms or point
  charges, and no force-field parameterisation (GAFF or otherwise) is written. Those remain out of
  scope in #67.
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
- No Gaussian-route checks. xTB has no route, basis or ECP, so method/basis compatibility, spin
  contamination, frontier-orbital descriptors, the excited-state root check and counterpoise do not
  apply and are reported as **not applicable** — never as a pass. The seven
  checks that do apply run for xTB too: charge/multiplicity parity, geometry sanity, imaginary modes,
  the engine-settings refusal above, solvation evidence, optimisation convergence (read from xTB's own
  convergence banner) and the conformer-ensemble check.
- No TD-DFT excited states, NMR shielding or NBO/ESP population analysis.

**An xTB run is not a substitute for a Gaussian result.** GFN methods are parameterised
semi-empirical approximations: useful for fast screening, conformer searches and pre-optimisation,
but their energies and barriers are not comparable to a DFT or wavefunction calculation. If a
workflow needs a Gaussian level of theory, it needs a licensed Gaussian installation.

### Setting up xTB

1. Install xTB so the executable and its `share/xtb` parameter directory are available (release
   tarballs ship `bin/xtb` beside `share/xtb`). No licence file is needed.
2. Open **Project settings…**, set **Engine** to `xTB (GFN-xTB)`, then choose the **Hamiltonian**
   and **Optimisation level**. The geometry comes from **Molecule… → Structure**; until you import
   a file, the labelled demo water geometry is used.
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

- **Methods** `B3LYP`, `PBE0`, `M06-2X`, `MP2`, `CCSD(T)`, `DLPNO-CCSD(T)` and `HF`, with **basis
  sets** `def2-SVP`, `def2-TZVP` (or `def2-TZVP(PP)`, the same ORCA keyword with the Stuttgart ECPs
  where the all-electron set is not defined), `cc-pVTZ`, `6-31G(d)` (written as ORCA's `6-31G*`) and
  `6-311+G(d,p)`. `DLPNO-CCSD(T)` is a **single point** in this builder — a request for `Opt` or
  `Freq` with it is refused by name — and it carries a **PNO threshold** (`NormalPNO` or `TightPNO`),
  written explicitly so the route preview states the truncation level instead of leaving it to ORCA's
  default. The parsed header, PNO settings and triples correction are pinned to a real ORCA 6.1 log
  (`test/fixtures/real/orca-6.1-water-dlpno/`).
- **Job types** `SP`, `Opt`, `Freq`, `Opt Freq`, `NMR`, `TD-DFT`, `Opt=TS`, `IRC` and `Scan`.
  `Opt Freq` is ORCA's compound job: optimise, then compute the Hessian at the minimum.
- **Opt=TS**: `! OptTS` plus `%geom Calc_Hess true end`. The exact Hessian is not optional here —
  with the Almloef model Hessian ORCA follows the wrong curvature, and the builder therefore always
  writes `Calc_Hess`. A real 6.1.1 NH3 inversion saddle printed `Hessian has 1 negative eigenvalues`,
  `Taking P-RFO step` and a lowest eigenvalue of −0.021825072; the confirming `Freq` on that geometry
  gives exactly one imaginary mode, **−907.22 cm⁻¹**. The parser reads the eigenvalue count, the
  lowest eigenvalue, the P-RFO marker and convergence as `extras.saddle`.
- **IRC**: `! IRC` plus `%irc Direction <both|forward|backward> / MaxIter 50 end`. The app's
  `reverse` maps to ORCA's `backward`. ORCA prints no per-step table during the run; it writes one
  `IRC PATH SUMMARY` at the end, an **ordered list from the backward end through the transition state
  (marked `<= TS`) to the forward end**, with absolute `E(Eh)` and `dE(kcal/mol)` referenced to the TS.
  There is no reaction coordinate column, so `rxCoord` is `null` rather than an invented ordering.
- **Scan**: `! Opt` plus `%geom Scan <B|A|D> <i> <j> = start, end, steps end end`, built from a
  constraint marked `scan` (its starting value, step size and step count). Indices are shifted to
  ORCA's **0-based** atom order. A `%geom Scan` without `! Opt` is silently ignored by ORCA 6.1.1 —
  the banner reads "Single Point Calculation" and no table is printed — and `! Scan` is not a keyword.
  The parser reads the `RELAXED SURFACE SCAN RESULTS` table (`'Actual Energy'` copy only; ORCA prints
  the same numbers twice).
- **NMR**: `! NMR` plus a `%EPRNMR` block listing every NMR-active element in the geometry
  (H, C, N, O, F, P, Si) with `SHIFT`, and `SHIFT, SSALL` when **Spin-spin couplings** is on.
  The parser reads `CHEMICAL SHIELDING SUMMARY (ppm)` — isotropic and anisotropy per nucleus, with
  ORCA's 0-based nucleus numbers shifted to the app's 1-based atom order — and the
  `SUMMARY OF ISOTROPIC COUPLING CONSTANTS J (Hz)` matrix. Pinned to a real ORCA 6.1.1 methanol
  log (`test/fixtures/orca/methanol-nmr.out`): C 141.174, O 342.467 ppm, J(C,H) 179.858 Hz.
- **Raman**: ORCA gives Raman intensities only from a **numerical** Hessian, so the builder writes
  `NumFreq` (replacing `Freq`) plus `%elprop Polar 1 end`. The parser reads the `RAMAN SPECTRUM`
  table: mode, frequency (cm⁻¹), activity (Å⁴/amu) and depolarization. Pinned to a real 6.1.1
  water log: 1596.13 / 3905.14 / 4010.94 cm⁻¹ with activities 6.367 / 74.744 / 34.699.
- **VCD**: `%freq DOVCD true end` on an analytic `Freq` job — ORCA refuses VCD with `NumFreq`, so
  Raman and VCD cannot share one job and the builder refuses the combination by name. The parser
  reads `VCD SPECTRUM CALCULATION` and keeps the **signed** rotational strength
  (1E-44 esu² cm²); the sign is the enantiomer signal. Real 6.1.1 fixture on CHFClBr (9 modes).
- **ROA** is refused by name: ORCA 6 has no ROA implementation. The Gaussian block computes it.
- **TD-DFT**: ORCA 6 takes no `TDDFT` keyword on the route line — it stops with
  `UNRECOGNIZED OR DUPLICATED KEYWORD(S) IN SIMPLE INPUT LINE` — so the builder writes a
  `%tddft` block (`NRoots N`, `TDA false`) and leaves the route alone. The parser reads the
  `TD-DFT EXCITED STATES` table (energies in au/eV/cm⁻¹, `<S**2>`, multiplicity, excitation
  composition) and the electric-dipole absorption table (oscillator strength, transition dipole),
  merging them by state. Only singlets are requested. The log ends with
  `E(tot) = E(SCF) + DE(CIS)` and prints that total as `FINAL SINGLE POINT ENERGY`; the record
  reports the SCF energy as the final energy and keeps the decomposition in
  `excitedStates.totalEnergy`. Pinned to real 6.1.1 logs (`test/fixtures/orca/water-tddft.out`,
  `ethene-tddft.out`).
- **Dispersion** `D3(BJ)` → `D3BJ`, `D3` → `D3ZERO` and `D4` → `D4`.
- **SCF** `Tight` → `TightSCF` / `VeryTight` → `VeryTightSCF`; **grid** `Fine` → `DEFGRID2` /
  `UltraFine` → `DEFGRID3`; optimisation convergence `Tight` → `TightOpt` /
  `VeryTight` → `VeryTightOpt`.
- **Implicit solvation** `CPCM` and `SMD` with Water, Dichloromethane, THF, Toluene or
  Acetonitrile. CPCM is written as `CPCM(SOLVENT)`; SMD is switched on in the documented
  `%cpcm` block with `smdsolvent "SOLVENT"`.
- **Resources**: `Cores (nproc)` becomes `%pal nprocs N end`, and the block's total memory is
  divided by the core count into ORCA's per-process `%maxcore` (MB).
- **Magnetic properties in an imported ORCA log** (issue 222): if the log carries
  `Hyperfine couplings ... YES` and the `ELECTRIC AND MAGNETIC HYPERFINE STRUCTURE` section, the
  parser reads each nucleus's `A(iso)` (MHz), the `A(SD)` dipolar components, the 3×3 total HFC
  matrix and the isotope/spin into the same `epr.hyperfine[]` rows the Psi4 path produces, so the
  EPR card and the report render ORCA without a branch. The sign is the log's own; ORCA states the
  `SAI` spin-Hamiltonian convention. A run whose `g-Tensor (aka g-matrix)` line is `YES` and which
  prints the `ELECTRONIC G-MATRIX` block carries that tensor; a `NO` is refused by name, not
  filled with 2.0023. An `NMR spin-spin couplings ... 1` run is read from
  `SUMMARY OF ISOTROPIC COUPLING CONSTANTS (Hz)` into `nmr.couplings.matrix` in Hz, with
  `kMatrix: null` because the logs print J and the per-pair `gnA`/`gnB` constants but **no reduced
  K table**. ORCA numbers nuclei from **0**, so `indexing` says so explicitly; Gaussian's tables
  are 1-based and the two must not be mixed.

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

- No population analysis (NBO/ESP), `Stable=Opt` or custom route keywords. Those are Gaussian-only
  form fields in this app; a block that carries one is refused with a message naming the field. The
  same refusal covers TD-DFT states or triplets set on a job type that is not `TD-DFT`: ORCA would run
  a plain single point and the record would claim a spectrum that was never computed.
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
2. Open **Project settings…**, set **Engine** to `ORCA 6`, then choose the method and basis. The
   geometry comes from **Molecule… → Structure**.
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
`ORCA finished by error termination in <module>`). An installed **ORCA 6.1.1 (RELEASE)** has since
been run on this project's own host (2026-11-10, `test/fixtures/orca/PROVENANCE.md`), and the NMR,
TD-DFT, Raman, VCD, `Opt=TS`, IRC and scan numbers quoted above are read from those logs — each job's
deck was written by this builder.

Two real ORCA 5.0 logs pin the line shapes of a single point and a frequency job —
`test/fixtures/real/orca-5.0-dvb-ir/` (5.0.1, `FINAL SINGLE POINT ENERGY`, `VIBRATIONAL
FREQUENCIES`, `Total Enthalpy`, `Final Gibbs free energy`) and `test/fixtures/real/orca-5.0-water-mp2/`
(5.0.0, energy and termination), both verbatim files from cclib's test data. The optimisation banner
is the one branch still counted as a gap **in that corpus**: `test/fixtureCoverage.test.js` scans
`test/fixtures/real/`, which carries no captured ORCA optimisation log (issue 176). A real 6.1.1
optimisation log with the `HURRAY` banner is committed outside it — `test/fixtures/orca/nh3-optts.out`,
the saddle search quoted above — so the verdict is exercised against real output, just not by the
coverage table.

The magnetic-property readers added for issue 222 are pinned by two more public logs, both verbatim
and both under `test/fixtures/real-public/`:

- `orca-6.0-nh2-hyperfine/NH2_A.out` (ORCA 6.0.0, radicalpy's MIT-licensed example data) — three
  nuclei, `A(iso)` = 28.4976 (¹⁴N), −61.6134 and −61.5964 MHz (¹H). The test checks the trace of the
  printed 3×3 matrix against `A(iso)` (worst 3.3 × 10⁻⁵ MHz) and
  `A(FC)+A(SD)+A(ORB+DIA)` against `A(Tot)` (worst 1.0 × 10⁻⁴ MHz). The log prints `g-Tensor ... NO`
  and no gauss column, so the gauss value is the stated MHz→G conversion, not a log check.
- `orca-5.0-dvb-spin-spin/dvb_coupling_nmr.out` (ORCA 5.0.4, cclib's BSD-3-Clause corpus) — 20
  nuclei, 190 pairs, J(0,1) = 9.451 Hz. The summary table and every pair block's
  `Total … iso=` value agree for all 190 pairs (worst 0 Hz at print precision); the per-pair
  `gnA`/`gnB` constants agree with the isotope table to 1.26 × 10⁻⁴ relative. No reduced K table is
  printed, so `kMatrix` is null and the record says why.


Execution is still proved only that far: the runner is tested against a stand-in driver script that
prints those fixtures, exits 0 after an error banner, prints nothing, sleeps and gets cancelled. It
proves the spawning, capture, termination and cancellation paths, not how a given installation
behaves.

The first run on an installed ORCA should be a small single point. Check the parsed
`FINAL SINGLE POINT ENERGY`, the SCF cycle count and the termination line against the log; if a
revision prints a different shape, the parser reports the value as `unknown` rather than guessing.
Please report the log.

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
- **Core correlation**: MP2, CCSD and CCSD(T) correlate every electron unless told otherwise, so a
  block has a **Core correlation** choice — *Engine default* (writes nothing, so an existing project
  is byte-identical), *Frozen core* (`set freeze_core true`) or *All-electron* (`set freeze_core
  false`). Frozen core is the convention the focal-point and CBS-extrapolation literature is written
  in, and the difference is not small: on water/cc-pVQZ, DF-MP2 is −76.378089 Eh all-electron and
  −76.347609 Eh frozen core, **30.48 mEh** (19.1 kcal/mol). The choice is recorded in `run.json` as
  `method.freezeCore`; it is refused on HF, SAPT0 and any functional, none of which has a core
  correlation step for the keyword to act on.
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
- **Implicit solvation** through Psi4's **DDX** addon (issue 167): `PCM` or `COSMO` in water,
  dichloromethane, THF, toluene, acetonitrile, methanol, ethanol, chloroform, acetone or DMSO, on a
  UFF cavity with the radii scaled ×1.1. A solvated block is **two single points at one level** in one
  script — the builder writes `set ddx false` and `energy(...)`, then `set ddx true`, `ddx_model`,
  `ddx_solvent` and the cavity, and runs `energy(...)` again. The result card reports the gas-phase
  energy, the solvated energy, their difference **ΔE(solv)**, and separately Psi4's
  `DD Solvation Energy` row — the DDX solute–solvent interaction at the solvated density. They are not
  the same number: on water/6-31G\* they are −5.17 and −5.58 kcal/mol. Solvation is refused by name on
  `Opt`, `Freq`, `Opt Freq`, `TD-DFT`, correlated methods and open-shell single points (a solvated
  block runs two SCFs, so it has no single spin density for the EPR checkpoint).
  **What it is not:** DDX-PCM is not PCMSolver's PCM and not SMD, and neither number is a solvation
  free energy — a ΔG<sub>solv</sub> needs a cavity-formation and thermodynamic treatment this builder
  does not write. Compare a ΔE(solv) with a ΔE(solv), never with a measured ΔG<sub>hyd</sub>.
  **It needs `pyddx`:** DDX is an addon, not part of Psi4 core. `psi4/psi4:1.11` recognises
  `ddx true` and then stops with `Python module ddx not found. Solve by installing it: conda install
  -c conda-forge pyddx`; measured in `test/fixtures/psi4-ddx/water-pcm-no-pyddx.out`.
  The inspector's **Model** menu is still the one shared with the other engines (`PCM`, `SMD`,
  `CPCM`), so a Psi4 block chosen from it can be `PCM`; `SMD` and `CPCM` are refused by name and
  `COSMO` is reachable from the block settings but not yet from that menu.
- **Spin populations and Fermi-contact hyperfine couplings** for an open-shell single point (issue
  168). The builder writes `E, wfn = energy('…', return_wfn=True)` and `fchk(wfn, '<task>.fchk')`, so
  the run leaves a checkpoint beside its log; the parser reads that file's `Spin SCF Density` block and
  computes Mulliken and Löwdin populations and the Fermi contact at each nucleus, in MHz and gauss.
  Both are **density-only** — the card and `docs/guide/results.md` state what that omits. A closed-shell
  job prints `no unpaired electrons`. The **g-tensor is refused by name**: Psi4 has no such property in
  the modules this builder writes, and ORCA is not installed.

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

- **SMD, CPCM and LPB solvation** — the DDX addon writes `pcm` and `cosmo`; SMD and CPCM are not DDX
  models at all, and LPB runs only with a positive `ddx_solvent_kappa` (an ionic strength), which a
  Psi4 block has no field to carry. All three are refused by name with what to choose instead.
- **Solvation free energies** — a solvated single point gives an electronic energy difference and the
  DDX interaction term, not a ΔG. No field on the card or in `run.json` is labelled ΔG.
- **TD-DFT excited states**, **NMR shieldings**, **NBO populations** and **transition-state
  searches** — not written by this builder yet.
- **A separate dispersion correction** — Psi4 takes D3 through the functional name, so choose
  ωB97X-D or B97-D instead of a `-D3BJ` field.
- **Gaussian grid keywords and custom routes** — no equivalent is guessed.
- **Frequencies at CCSD/CCSD(T)** — Psi4 has no analytic Hessian there; run the frequency at DFT
  or MP2 level.
- **Checkpoint hand-off** — Psi4 leaves no restart file this app can hand to another block; the edge
  hands over the parsed final geometry instead and the receiving block's deck is rewritten from it,
  whichever engine it runs. The `.fchk` an open-shell single point
  writes for the EPR block is read by this run's parser and kept with its `run.json`; it is not a
  restart file and is not passed to another block.

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
2. Set **Project settings… → Engine** to `Psi4`, then choose method and basis. The geometry comes
   from **Molecule… → Structure**.
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

**Solvation needs the DDX addon.** Install `pyddx` into the same environment Psi4 runs from —
`conda install -c conda-forge pyddx`, or `pip install pyddx` where a Fortran compiler and the
BLAS/LAPACK headers are present. `psi4/psi4:1.11` does **not** ship it: the deck is accepted, the
`DDX` keywords are recognised, and the run then stops with `Python module ddx not found`, which the
record quotes as the error detail. The solvated fixtures in `test/fixtures/psi4-ddx/` were produced
with pyddx 1.0.0 unpacked into that image; `PROVENANCE.md` beside them has the recipe and the sha256
of every file.

### What this build proves about the Psi4 parser

Two corpora, because the format changed:

- **Psi4 1.1rc3 – 1.4a1**, eight complete logs from Psi4's own test suite and RMG-Py, in
  `test/fixtures/real/psi4-*.out`: HF, B3LYP frequencies with thermochemistry, two optimisations (one
  converged, one that is not), MP2, CCSD, SAPT0 and a PSIO error termination.
- **Psi4 1.11**, five runs produced in this repository by the official `psi4/psi4:1.11` container
  image and kept in `test/fixtures/psi4-live/`: a single point, an optimisation, a frequency job, an
  open-shell UKS run and a SAPT0 dimer. The inputs beside them were written by this app's builder, so
  the pair also proves the generated script is one Psi4 accepts.
- **Psi4 1.11 + DDX**, in `test/fixtures/psi4-ddx/`: water at RHF/6-31G\* gas phase and in DDX-PCM
  water, both from this builder's decks, plus the same solvated deck run in an image **without**
  pyddx — the failure the addon requirement is stated from. The committed decks are asserted
  byte-identical to what the builder writes, so the energies pinned in `test/psi4Solvation.test.js`
  cannot drift away from the code.

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

## PySCF — open source, Apache-2.0

PySCF is an open-source Python electronic-structure package. In this app it gives you:

- **Methods**: HF, B3LYP, PBE0, M06-2X, MP2, CCSD, CCSD(T) and CASSCF.
- **Bases**: def2-SVP, def2-TZVP, cc-pVDZ, cc-pVTZ, 6-31G(d) and STO-3G. For a def2 basis, PySCF supplies the
  matching ECP automatically, so iodine and heavier elements build without a separate ECP field.
- **Job types**: `SP`, `Opt`, `Freq`, `Opt Freq` and `TD-DFT`. Optimisations use geomeTRIC
  (installed with PySCF's `geometric` extra); frequencies use PySCF's analytic Hessian, and the app
  reports 3N−6 modes and the imaginary count.
- **Excited states**: `TD-DFT` runs `tdscf.TDDFT` (full TDDFT, not TDA) for N singlet roots on a
  converged HF/DFT reference, and records each root's energy in Hartree and eV, wavelength,
  oscillator strength and transition dipole. Triplet roots, solvated references and post-HF
  references are refused by name.
- **Implicit solvation**: PCM (IEF-PCM) and C-PCM in water, dichloromethane, THF, toluene,
  acetonitrile, methanol, ethanol, chloroform, acetone or DMSO. It is a single-point setting: the
  deck applies the continuum to the SCF, records the model and solvent, and refuses Opt, Freq and
  Opt Freq by name.
- **CASSCF** with an explicit **Active space** field written as `electrons,orbitals` — for example
  `6,6` for CAS(6,6). The deck builds `mcscf.CASSCF(mf, ncas, nelecas)` on an RHF or ROHF reference
  and records the active space in the result. CASSCF is a single point in this build; Opt, Freq and
  Opt Freq are refused by name.

**The deck is a fixed program.** PySCF input is Python, so the builder does not assemble a script
from project fields. It writes one reviewed deck (`src/shared/engines/pyscfDeck.js`) and passes the
molecule, method, basis, charge, multiplicity, solvation and active space as a single base64-encoded
JSON document. A title containing a quote, a semicolon or `import os` stays a string in that document;
it is never interpolated as a statement. The deck prints a `nodechem.pyscf.v1` JSON record between
`NCS-PYSCF-RESULT-BEGIN` and `NCS-PYSCF-RESULT-END` and writes the same record beside itself as
`<task>.json`. The parser reads that record — energy, SCF convergence and cycle count, MO energies,
geometry, frequencies and Hessian, thermochemistry, excited states, PySCF version, method, basis,
density fitting, active space and solvation — and falls back to PySCF's printed text only for a log the user supplies;
the fallback says `recordSource: text-fallback` and carries no molecular record.

**Which energy is reported.** The record has one `energy` field, set by the job: the SCF total for HF
and DFT (Opt Freq reports the energy at the final geometry), the MP2 total for MP2, the CCSD total for
CCSD and the CCSD(T) total for CCSD(T). The CCSD(T) perturbative correction is also kept as
`extras.triplesCorrection`, so the total is not confused with the CCSD energy it started from.

What a PySCF block will **not** do in this build, each refused by name rather than dropped:

- **Triplet excited states** — the deck writes singlet roots only; a `tdTriplets` request is
  refused by name.
- **Periodic calculations** — `pyscf.pbc` is not used; a `periodic` setting is refused.
- **Relativistic and spin–orbit calculations** — no X2C, DKH or SOC Hamiltonian is written; the
  setting is refused.
- **QM/MM** — no point-charge embedding; the setting is refused.
- **GPU** — the deck selects the CPU build; a `gpu` setting is refused.
- **NMR shieldings** — the NMR job type is refused.
- **A CCSD(T) Hessian** — refused by name. Frequencies are HF/DFT only in v1, and MP2/CCSD/CCSD(T)
  are single points. A frequency at a correlated level needs a method-specific Hessian this deck does
  not write.
- **SMD, CPCM and COSMO** — PySCF's `solvent.PCM` writes PCM and C-PCM; the other models are refused
  by name, and the result is an electronic energy, not a solvation free energy.
- **Checkpoint hand-off** — PySCF leaves no restart file this app hands to another block. The edge
  hands over the upstream parsed geometry instead: it is marked geometry-only and the receiving
  block's deck — PySCF's molecule line among them — is rewritten from it.
- **A method or basis not in the lists above** — refused by name with the supported list. No
  functional or basis is guessed from a Gaussian route.

**Setting up PySCF**

1. Install PySCF 2.x into a Python 3.9+ environment: `pip install pyscf geometric` (or
   `conda install -c conda-forge pyscf geometric`). The app does not bundle Python or PySCF.
2. Set **Project settings… → Engine** to `PySCF`, then choose method and basis. For CASSCF, enter
   the active space on the block.
3. In **Run**, select the Python interpreter that has PySCF — `/usr/bin/python3`, a virtualenv's
   `python`, or a `pyscf-runner` wrapper — with **Browse**. A bare `python3` is accepted and resolved
   on `PATH`, with a warning that an absolute path is more reproducible.
4. **Preflight** checks that the executable exists, that its name is a Python interpreter or
   `pyscf-runner`, that it is runnable on Linux/macOS, and — for a plain interpreter — runs
   `python -c "import pyscf; print(pyscf.__version__)"` so a Python without PySCF fails as
   `No module named 'pyscf'`, not as an unknown engine.
5. **Run it.** The app spawns `python <task>.py` in the run folder. The deck prints the record to
   stdout; the runner also reads `<task>.json`, so a truncated capture still parses. Threads come
   from the block's `nproc` through `OMP_NUM_THREADS`, `MKL_NUM_THREADS`, `OPENBLAS_NUM_THREADS` and
   `NUMEXPR_NUM_THREADS`.

**Provenance of the fixtures.** `test/fixtures/pyscf/` holds records from real PySCF 2.15.0 runs, not
synthetic numbers; `PROVENANCE.md` beside them lists the interpreter, the command and the reference
values. Water at HF/def2-SVP and B3LYP/def2-SVP was also run through the official `psi4/psi4:1.11`
container on the same geometry and density-fitted SCF: the totals agree to **5.6 × 10⁻¹¹** and
**1.7 × 10⁻⁷** Eh respectively. The PCM record matches an independent direct `solvent.PCM` call to all
printed digits, and the CASSCF record matches an independent `mcscf.CASSCF` call to 7 × 10⁻¹⁰ Eh.

What is not proven: an optimisation or frequency at a correlated level (refused, not implemented), a
periodic or relativistic calculation (refused), and any platform other than Linux. A record shape the
parser does not recognise is reported as `unknown`, never guessed.

## Which settings belong to which engine

| Setting | Gaussian 16 | xTB | ORCA 6 | Psi4 | PySCF |
| --- | --- | --- | --- | --- | --- |
| Level of theory | Method + basis set | `--gfn 0/1/2` or `--gfnff` | `! method basis` | `set reference` + method/basis | Recorded method/basis; CASSCF takes an active space |
| Basis set, dispersion, SCF, grid, population | Used | Ignored — fields hidden and stripped from the payload | Mapped to ORCA keywords; population refused | Basis used; unsupported fields refused by name | Basis used; dispersion, SCF, grid and population refused |
| Solvation | PCM / SMD / CPCM, Water…Acetonitrile | ALPB / GBSA, Water…Acetonitrile | CPCM / SMD, Water…Acetonitrile | DDX PCM / COSMO, Water…DMSO | PCM / C-PCM, Water…DMSO |
| Job types | SP, Opt, Opt Freq, Freq, Opt=TS, IRC, Scan, NMR, Opt=QST2/QST3, composite methods | SP, Opt, Opt Freq, Freq | SP, Opt, Opt Freq, Freq, NMR, TD-DFT, Opt=TS, IRC, Scan | SP, Opt, Opt Freq, Freq, TD-DFT | SP, Opt, Opt Freq, Freq, TD-DFT |
| Optimisation control | `Opt=Tight`/`VeryTight`, force constants | `--opt <level>` / `--ohess <level>` | `TightOpt` / `VeryTightOpt`, `DEFGRID2/3` | Psi4 optimizer defaults | geomeTRIC defaults |
| Resources | `Memory` + unit, `Cores (nproc)`, checkpoint file | `Threads (OMP_NUM_THREADS)` | `%maxcore` (MB per core), `%pal nprocs` | `Threads (OMP_NUM_THREADS)` | `Threads (OMP_NUM_THREADS)` |
| Checkpoint hand-off | `%OldChk` + `Geom=Check`/`Guess=Read` | Copies `xtbrestart` into the downstream run folder | `%moinp "<job>.gbw"`; the upstream `.gbw` is copied into this run folder | None; geometry-only hand-off | None; geometry-only hand-off |
| Validity checks | Twelve checks, pre and post run | Seven applicable checks; the Gaussian-only ones reported *not applicable* | Canonical gates on the parsed result; Gaussian-route checks do not apply | Canonical gates on the parsed result | Canonical gates plus named refusals |
| Dry run | Labelled `FIXTURE OUTPUT` fixture | Labelled `FIXTURE OUTPUT` fixture | Labelled `FIXTURE OUTPUT` fixture | Labelled `FIXTURE OUTPUT` fixture | Labelled `FIXTURE OUTPUT` fixture |

A dry run is a fixture for every engine: it writes a synthetic file headed `FIXTURE OUTPUT`, starts
no process, and is never a calculation.

The PySCF and Psi4 "geometry-only hand-off" cells describe what the engine leaves behind. The
receiving block's deck is rewritten from the upstream parsed geometry whichever of the five engines
it runs on; only the atom rows change.

## Next

[Workflows →](workflow.md)
