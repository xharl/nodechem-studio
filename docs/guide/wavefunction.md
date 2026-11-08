# Wavefunctions: cubes, formatted checkpoints and Molden files

The results panel reads the Gaussian log. A log is a report *about* a calculation; it does not
carry the wavefunction itself. Three files do:

| File | Written by | What it holds |
| --- | --- | --- |
| `.fchk` (formatted checkpoint) | `formchk run.chk run.fchk` | Scalars and arrays: geometry, orbital energies, charges, electron counts, total energy, and the basis/MO arrays the Molden writer needs |
| `.cube` | `cubegen` | One scalar field sampled on a regular 3D grid, plus the nuclei |
| `.molden` | ORCA (`orca_2mkl -molden`), Psi4 (`psi4.molden(wfn)`), PySCF, Q-Chem, GAMESS via Molden2AIM, or this app's own `ncs convert job.fchk --format molden` | Atoms, the Gaussian basis, spherical/Cartesian markers, and the molecular-orbital coefficients |

This page describes what the app reads from each, what it deliberately refuses, and what it does
**not** do yet. Everything on this page happens offline on files you already have; the app never
runs `formchk`, `cubegen` or an external quantum-chemistry program for you.

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
| `Shell types`, `Number of primitives per shell`, `Shell to atom map` | The basis, for the Molden writer (#113) |
| `Primitive exponents`, `Contraction coefficients`, `P(S=P) Contraction coefficients` | The contracted Gaussian primitives |
| `Alpha MO coefficients`, `Beta MO coefficients` | The orbital coefficient matrices |

Polarisabilities and the two-electron integrals are still ignored: nothing in the app reads them,
and they are large enough that copying them would make a checkpoint read feel slow for no result.

## What a Molden file contains

Molden is line-oriented, with `[Section]` headers:

```
[Molden Format]
[Title]
water, B3LYP/def2-SVP
[Atoms] Angs
O 1 8 0.00000000 0.00000000 0.00000000
H 2 1 0.75700000 0.58600000 0.00000000
[5D]
[GTO]
1 0
s 3 1.00
  130.70932000 0.15432897
  ...
sp 3 1.00
  0.70000000 -0.09996723 0.15591627
  ...
[MO]
 Sym= A1
 Ene= -20.551234
 Spin= Alpha
 Occup= 2.0000
  1 0.99400000
  ...
```

The parts the reader uses:

- **`[Atoms] Angs` or `[Atoms] AU`.** One row per atom: element symbol, atom index, atomic number,
  x, y, z. The unit is part of the header; the reader converts AU (bohr) to Å once and refuses a
  header that names neither unit.
- **`[GTO]`.** One atom block (`1 0`) per atom, then shell rows (`s 3 1.00`) and primitive rows
  (`exponent coefficient`). All exponents and coefficients are in atomic units. A combined `sp`
  shell has **two** coefficients per primitive; the split form this app's writer emits (a bare `s`
  followed by a bare `p` with the same exponents) is recombined into one `sp` shell.
- **`[5D]`, `[7F]`, `[9G]` and compound `[5D10F]`-style markers.** These decide whether a d, f or g
  shell contributes five/seven/nine spherical functions or six/ten/fifteen Cartesian ones.
- **`[MO]`.** `Sym=`, `Ene=` (hartree), `Spin=` (`Alpha`/`Beta`), `Occup=`, then one
  `basis-function-index coefficient` row per function.

`[Title]`, a comment line directly under `[Molden Format]`, and the optional scale factor in a
shell row are accepted. `[FREQ]`, `[FR-COORD]`, `[INT]` and `[GEOMETRIES]` are ignored: the app takes
vibrational and geometry data from its own engine-output parsers.

### Spherical or Cartesian changes the basis size

The markers are not decoration. A d shell is six functions unless the file says `[5D]`; then it is
five. The Molden specification also defines `[5D]` as shorthand for five d **and** seven f
functions, while `[7F]` means six d and seven f — so the reader treats `5D` as an explicit d choice
plus an implied f choice, and lets an explicit `10F` override the implication. `[5D10F]` is
spherical d with Cartesian f; `[5D7F]` is the same as `[5D]`. An absent marker means Cartesian.

A marker that disagrees with the `[MO]` coefficient vector is refused rather than expanded: if the
file says `[5D]` and an orbital carries six coefficients for that shell, the error states how many
coefficients arrived, how many functions the marker implies, and which marker was used.

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
  charges and electron count imply);
- the shell table, primitive exponents, contraction coefficients and MO coefficient matrices, for
  the Molden writer.

From a **Molden file**:

- the atoms, in Å, from either `[Atoms] Angs` or `[Atoms] AU`;
- the shells in the same signed convention a checkpoint uses (`0` s, `1` p, `-1` sp, and the sign of
  d/f/g saying spherical or Cartesian), with the marker deciding the function count;
- each MO's symmetry label, energy (hartree), spin, occupation and coefficient vector;
- the alpha/beta electron counts when the occupations determine them. A restricted closed-shell file
  (every occupation 0 or 2) yields one alpha and one beta electron per occupied spatial orbital; an
  unrestricted file uses its separate spin blocks. A file with no beta block and a singly occupied
  orbital leaves the beta count **absent**, because Molden does not say whether that electron is
  paired or not.

The result has the same field names as the checkpoint reader (`shellTypes`, `primitivesPerShell`,
`primitiveExponents`, `contractionCoefficients`, `alphaMOCoefficients`, `orbitalEnergies`, …), so
`orbitalGap`, `spinFromElectrons` and `shellsFromFchk` accept it without a Molden branch. A field
Molden cannot carry — total charge, multiplicity, partial charges, total energy — is absent and is
named in `missing`; it is never filled with zero.

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

- `artifacts`: one entry per file with its kind (`cube`, `fchk` or `molden`), its name, its
  **SHA-256** and its size in bytes — the same provenance idea as `inputSha256` and `outputSha256`;
- `cube`: dimensions, origin, axes, spacing, cell volume, atom count and the statistics above;
- `fchk`: which fields were found and which were missing, the optional scalars, and the derived
  gap, spin and charge blocks.

The Molden reader returns the same fchk-shaped object (`format: 'molden'`), so a caller can pass it
straight to `orbitalGap`, `spinFromElectrons` or `shellsFromFchk`. `wavefunctionRecord` puts it in
the same `fchk` summary block, with `format: 'molden'` naming the reader that produced it; no
Molden-specific spreadsheet columns exist yet.

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

A Molden file contributes the same gap and spin cells through the `fchk` summary block, but it has no
`molden_sha256` column yet: its digest lives in the record's `artifacts` array and nowhere in the
spreadsheet. The `fchk_sha256` cell stays empty because the artifact's kind is `molden`, not `fchk`.

The frontier-orbital columns exist because the log reader added them (#81); the checkpoint does not
add a second set. When the log printed its `Pop=Full` table that print wins, because it is the
calculation's own; when it did not, the checkpoint's `Orbital Energies` fill the same cells. The
Koopmans descriptors that need more than the pair — hardness, softness, electrophilicity — remain
log-only.

A run without wavefunction files leaves the checkpoint columns **empty**. A value that could not be
computed — no orbital energies, no charges — is also an empty cell; the reason is in the record,
not in the spreadsheet.

## What the readers refuse

The readers are bounded, and they say what they refused instead of returning a partial answer.

- **Size.** A cube over 64 M characters, or a grid over 4 M points, is refused with the limit in the
  message; an fchk or a Molden file over 64 M characters likewise. Cubes are parsed in memory: this
  is a desktop app, not a node with 64 GB.
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

For a Molden file, the refusals name the section and the offending value:

- **No header.** A file whose first line is not `[Molden Format]` is refused; the message quotes the
  line it found instead.
- **`[STO]`.** Slater orbitals are refused by name. This reader expands Gaussian primitives only.
- **A shell beyond `g`.** A `[GTO]` shell labelled `h` or higher is refused with the label; dropping
  it would shift every coefficient after it.
- **An out-of-range atom.** A `[GTO]` atom block whose index is not in the `[Atoms]` table is refused
  with both numbers.
- **A count mismatch.** A shell that declares three primitives and has two, an `s` primitive with two
  coefficients, or an `sp` primitive with one is refused with the shell label and the line.
- **A marker that contradicts the coefficients.** If `[5D]` makes a shell five functions and the
  `[MO]` block carries six, the error reports the coefficient count, the basis size and the marker.
- **A truncated `[MO]` block.** An orbital that ends before the basis is covered is refused with how
  many coefficients arrived and how many functions the basis has.
- **A bad coefficient index.** An index outside `1..nbf`, or one repeated in the same orbital, is
  refused with the index.

A missing field is different from a broken one: it is simply **absent**. Nothing is zero-filled, and
the record lists the missing field names so a reader can see what the file did not contain. A Molden
file has no total charge, multiplicity, partial charges or total energy, so those keys are absent
from its parsed object and named in `missing`; deriving a charge from the geometry would be an
invention, not a read.

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
- **Rendering the coefficients.** The fchk and Molden readers now carry the MO coefficient matrix,
  but no marching-cubes renderer turns it into an orbital isosurface. An orbital cube from `cubegen`
  is read fine; the app cannot generate one.
- **Molden's vibrational sections.** `[FREQ]`, `[FR-COORD]`, `[INT]` and `[GEOMETRIES]` are ignored;
  frequencies come from the engine output parsers, not from a Molden file.
- **Molden in the CLI and the window.** The shared reader is wired into `readWavefunction`, but
  `ncs convert job.molden --format xyz|sdf|qcschema` and the window's file picker are not. The
  shared reader is the piece both would call.
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
