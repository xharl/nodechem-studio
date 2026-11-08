# Wavefunctions: cubes and formatted checkpoints

The results panel reads the Gaussian log. A log is a report *about* a calculation; it does not
carry the wavefunction itself. Two files do:

| File | Written by | What it holds |
| --- | --- | --- |
| `.fchk` (formatted checkpoint) | `formchk run.chk run.fchk` | Scalars and arrays: geometry, orbital energies, charges, electron counts, total energy |
| `.cube` | `cubegen` | One scalar field sampled on a regular 3D grid, plus the nuclei |

This page describes what the app reads from each, what it deliberately refuses, and what it does
**not** do yet. Everything on this page happens offline on files you already have; the app never
runs `formchk` or `cubegen` for you.

## What a cube contains

A Gaussian cube is plain text with five parts:

1. two comment lines (a title and, usually, the loop order `OUTER LOOP: X, …`);
2. `NATOMS OX OY OZ` — the atom count and the grid origin;
3. one row per atom: `atomicNumber nuclearCharge x y z`;
4. three rows describing the grid: `count spacing vx vy vz`, one per axis;
5. `nx · ny · nz` values, **x varying fastest** (Fortran order).

The units are not written anywhere. They are encoded in the sign of the first grid count: a
**negative** count means the atom rows, origin and spacing are in **Å**; a **positive** count means
**bohr**. Most tools that write cubes for other programs use the negative form; `cubegen` itself
writes bohr. This is the single most common way to read a cube wrongly, so the reader decides once,
from the first grid row, and converts once — a coordinate is never multiplied by 0.529 twice.

The values themselves carry no unit either. A density cube usually holds electrons/bohr³, an
orbital cube the wavefunction amplitude, an ESP cube a potential in hartree/e. The app does not
label them: it reports the numbers it read and leaves the interpretation to the file that produced
them.

## What a formatted checkpoint contains

An `.fchk` is a text dump of a binary checkpoint: a label padded to column 43, a type letter (`I`
integer, `R` real), then either one value or `N= <count>` followed by the data. The subset the app
reads is the one the results surface can use:

| Field | Used for |
| --- | --- |
| `Number of atoms`, `Atomic numbers`, `Current cartesian coordinates` | The geometry, converted from bohr to Å |
| `Orbital Energies`, `Orbital Energies, spin 2` | HOMO/LUMO and the gap, per spin channel |
| `Number of alpha electrons`, `Number of beta electrons`, `Number of electrons` | Which orbital is the HOMO, and the spin state |
| `Mulliken Charges`, `ESP Charges` | Charge-sum sanity check |
| `Charge`, `Multiplicity` | The stated total charge and spin multiplicity |
| `Total Energy`, `Virial Ratio` | The energy the checkpoint belongs to, and its virial check |
| `Number of basis functions` | The size of the orbital space, for context |

Everything else — MO coefficients, shell and basis information, polarisabilities — is ignored. That
is a decision, not an omission: see [what is not here yet](#what-is-not-here-yet).

## What the app extracts

From a **cube**:

- the grid dimensions, origin, per-axis spacing and cell volume, in Å;
- the atoms, in Å;
- minimum, maximum, mean and largest magnitude of the values, each with the **voxel** it occurs at,
  so an electron-density cube can be sanity-checked (a density is non-negative and its maximum sits
  on a nucleus);
- one plane of the grid (`cubeSlice`), for a future 2D view;
- the value at an arbitrary point (`cubeValueAt`), trilinear by default, `null` outside the grid;
- an isosurface summary at a chosen isovalue: how many grid points lie above and below it, what
  fraction of the cell that is, and the box the surface covers;
- a suggested isovalue that encloses a requested fraction of the grid — a percentile of |value|, not
  a chemical recommendation.

From an **fchk**:

- the geometry, in Å;
- the HOMO–LUMO gap, in hartree, eV and kcal/mol, together with the orbital indices and energies it
  came from;
- the spin state implied by the alpha/beta counts: unpaired electrons, S, multiplicity and S(S+1);
- the sum of the partial charges against the total charge the file states (or the one its nuclear
  charges and electron count imply).

### The gap is an orbital-energy gap

The gap is the difference between two Kohn–Sham (or Hartree–Fock) orbital energies. It is **not** the
fundamental gap, and it is **not** an excitation energy — a TD-DFT vertical excitation is a different
quantity and the app reports it separately from the log. When the app shows this number it says
which two orbitals it came from.

The spin value has the same caveat: S(S+1) is exact only for a pure spin state. The SCF ⟨S²⟩ in the
log can be larger when the determinant is spin-contaminated, and the two numbers must not be
confused.

### Charge-sum sanity

A Mulliken population analysis sums to the total electron count by construction. So if the charge
array adds up to something more than a hundredth of an electron away from the total charge, the
array and the rest of the file describe different systems — a mixed-up checkpoint, a truncated
write, or charges from another job. The check reports the sum, the expected charge, the deviation
and whether it is inside the tolerance; it does not "fix" the charges.

## Where the values go

A finished run can carry a `wavefunction` block in its `run.json`. It is produced by
`src/shared/wavefunction.js` and holds:

- `artifacts`: one entry per file with its kind (`cube` or `fchk`), its name, its **SHA-256** and its
  size in bytes — the same provenance idea as `inputSha256` and `outputSha256`;
- `cube`: dimensions, origin, axes, spacing, cell volume, atom count and the statistics above;
- `fchk`: which fields were found and which were missing, the optional scalars, and the derived
  gap, spin and charge blocks.

The grid itself is never copied into `run.json`. A 100³ cube is a million numbers; the record keeps
the summary and the hash, and the file stays where it is.

`datasetExport.js` turns that block into columns, appended after the existing ones so an old
spreadsheet template keeps its column positions:

| Column | Meaning |
| --- | --- |
| `fchk_sha256`, `cube_sha256` | File digests |
| `cube_dims` | Grid size, `41x41x41` |
| `cube_min`, `cube_max`, `cube_mean` | Value statistics, in the cube's own units |
| `homo_ev`, `lumo_ev`, `gap_ev` | The frontier orbitals — filled from the checkpoint when the route did not ask for `Pop=Full` |
| `fchk_total_energy_hartree` | The energy the checkpoint carries |
| `mulliken_charge_sum`, `mulliken_charge_deviation` | The charge check |
| `spin_multiplicity`, `unpaired_electrons` | The spin state |

The frontier-orbital columns exist because the log reader added them (#81); the checkpoint does not
add a second set. When the log printed its `Pop=Full` table that print wins, because it is the
calculation's own; when it did not, the checkpoint's `Orbital Energies` fill the same cells. The
Koopmans descriptors that need more than the pair — hardness, softness, electrophilicity — remain
log-only.

A run without wavefunction files leaves the checkpoint columns **empty**. A value that could not be
computed — no orbital energies, no charges — is also an empty cell; the reason is in the record,
not in the spreadsheet.

## What the readers refuse

Both readers are bounded, and both say what they refused instead of returning a partial answer.

- **Size.** A cube over 64 M characters, or a grid over 4 M points, is refused with the limit in the
  message; an fchk over 64 M characters likewise. Cubes are parsed in memory: this is a desktop app,
  not a node with 64 GB.
- **Truncation.** A data block shorter than `nx·ny·nz` is an error that states how many values
  arrived. A grid with *more* values than it declares is refused too — that is a second dataset
  appended to the first, and reading only the first would silently drop a field.
- **Multi-value cubes.** `NVAL > 1` is refused by name. One cube carries one quantity here.
- **Bad tokens.** A non-numeric token is an error with the **line number**, in the header and in the
  data block alike.
- **Inconsistent arrays.** An fchk whose `Atomic numbers`, `Mulliken Charges` or coordinate array
  disagrees with `Number of atoms` is refused: the reader and the file disagree, and guessing which
  is right would turn a parsing bug into a chemistry result.
- **Not a checkpoint.** A binary `.chk` is refused with the reason and the fix (`formchk`).

A missing fchk field is different from a broken one: it is simply **absent**. Nothing is zero-filled,
and the record lists the missing field names so a reader can see what the file did not contain.

## What is not here yet

The ingest half of issue #59 is implemented. The visual half is not, and this page would rather say
so than show a picture that implies otherwise:

- **Orbital isosurfaces.** No marching-cubes mesh, no positive/negative phase colours, no isovalue
  control in the viewer. The grid summary and the suggested isovalue exist so the renderer has
  something to start from.
- **ESP colour-mapped surfaces and colour bars.** Requires a molecular surface and a colour scale,
  neither of which exists yet.
- **QTAIM/AIM critical points, bond paths and basin charges.** A separate analysis with its own
  numerical requirements.
- **NCI/RDG surfaces, ELF/LOL, deformation density.** Also separate analyses, not another cube read.
- **MO coefficients and arbitrary orbital cubes.** The fchk reader deliberately skips the coefficient
  matrix; an orbital cube from `cubegen` is read fine, but the app cannot generate one.
- **Attaching the files from the UI.** The parsers, the record block and the export columns are in
  place; choosing the files when a run finishes and writing the block into `run.json` belongs to the
  run-writer, not to this module.
- **Multiwfn hand-off.** Generating a Multiwfn input deck and reading its text report back is the
  cheaper route for the analyses above, and is not implemented.

Every one of those is listed in issue #59, so the gap between "what is read" and "what is drawn"
stays visible instead of being discovered by a user who expected a picture.

## Next

- [Results](results.md) — the panel these values belong to.
- [Projects and runs on disk](project-files.md) — the run folder and `run.json`.
- [Output corpus](parser-corpus.md) — the real logs the parser is tested against.

Back to the [documentation index](README.md).
