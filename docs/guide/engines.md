# Engines

NodeChem Studio drives two calculation engines. **The engine is a project-level choice**: open
**Molecule → Defaults** and pick **Engine**. Every calculation block in the project is then built for
that engine, so choose it before you build a workflow. A saved project keeps the engine it saved;
the app never switches one behind your back.

One project, one engine. If you need a Gaussian level of theory for one step and a cheap GFN
pre-screen for another, use two projects and pass the geometry between them.

## Gaussian 16 — licensed commercial software

Gaussian 16 is a general-purpose electronic-structure program. In this app it gives you:

- **DFT and wavefunction methods** — B3LYP, M06-2X, ωB97X-D, PBE0, MP2, CCSD(T) — with an explicit
  basis set: def2-SVP, def2-TZVP, 6-31G(d), 6-311+G(d,p), cc-pVTZ or SDD.
- **Dispersion** (D3(BJ) or D3), **SCF** tightening, **integration grid**, **population analysis**
  (NBO, Hirshfeld, MK charges), **implicit solvation** (PCM, SMD, CPCM) and **verbosity**.
- **Job types**: `SP`, `Opt`, `Opt Freq`, `Freq`, `Opt=TS`, `IRC` and `Scan`.
- **Excited states (TD-DFT/CIS)**: `TD=(NStates=N)` on an `SP` or `Opt` block, with singlets,
  triplets or a 50/50 run. The output's excitation energies, wavelengths, oscillator strengths and
  dominant transitions are parsed into the results panel. Other job types cannot carry `TD`, and
  the input builder refuses them rather than writing a route that fails.
- **Transition-state control**: force constants (`CalcFC`, `CalcAll`, `ReadFC`), optimisation
  convergence (`Tight`, `VeryTight`) and the derived UltraFine grid.
- **Checkpoint hand-offs** between blocks (`%OldChk` plus `Geom=Check` and `Guess=Read`).
- **Thermochemistry** from a frequency job, read out of the log.
- **Validity checks** — the six pre/post-run checks in [Results](results.md#validity-checks).

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
- **Implicit solvation**: `ALPB` or `GBSA` with Water, Dichloromethane, THF, Toluene or
  Acetonitrile. The inspector exposes both models; the builder emits `--alpb <solvent>` or
  `--gbsa <solvent>` and the choice is recorded in `run.json`.
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

## Which settings belong to which engine

| Setting | Gaussian 16 | xTB |
| --- | --- | --- |
| Level of theory | Method + basis set | `--gfn 0/1/2` or `--gfnff` |
| Basis set, dispersion, SCF, grid, population | Used | Ignored — fields hidden and stripped from the payload |
| Solvation | PCM / SMD / CPCM, Water…Acetonitrile | ALPB / GBSA, Water…Acetonitrile |
| Job types | SP, Opt, Opt Freq, Freq, Opt=TS, IRC, Scan | SP, Opt, Opt Freq, Freq |
| Optimisation control | `Opt=Tight`/`VeryTight`, force constants | `--opt <level>` / `--ohess <level>` |
| Resources | `Memory` + unit, `Cores (nproc)`, checkpoint file | `Threads (OMP_NUM_THREADS)` |
| Checkpoint hand-off | `%OldChk` + `Geom=Check`/`Guess=Read` | Copies `xtbrestart` into the downstream run folder |
| Validity checks | Six checks, pre and post run | Four applicable checks; Gaussian-only ones reported *not applicable* |
| Dry run | Labelled `FIXTURE OUTPUT` fixture | Labelled `FIXTURE OUTPUT` fixture |

A dry run is a fixture for both engines: it writes a synthetic file headed `FIXTURE OUTPUT`, starts
no process, and is never a calculation.

## Next

[Workflows →](workflow.md)
