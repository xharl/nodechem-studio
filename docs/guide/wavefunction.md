# Wavefunctions: cubes, formatted checkpoints, Molden, WFN and WFX files

The results panel reads the Gaussian log. A log is a report *about* a calculation; it does not
carry the wavefunction itself. Five files do:

| File | Written by | What it holds |
| --- | --- | --- |
| `.fchk` (formatted checkpoint) | `formchk run.chk run.fchk` | Scalars and arrays: geometry, orbital energies, charges, electron counts, total energy, and the basis/MO arrays the Molden writer needs |
| `.cube` | `cubegen` | One scalar field sampled on a regular 3D grid, plus the nuclei |
| `.molden` | ORCA (`orca_2mkl -molden`), Psi4 (`psi4.molden(wfn)`), PySCF, Q-Chem, GAMESS via Molden2AIM, or this app's own `ncs convert job.fchk --format molden` | Atoms, the Gaussian basis, spherical/Cartesian markers, and the molecular-orbital coefficients |
| `.wfn` (traditional AIM wavefunction) | Gaussian (`output=wfn`), GAMESS, Q-Chem, ORCA, Molden2AIM and other AIM-era writers | Atoms, an uncontracted Cartesian Gaussian basis, orbital energies and occupations (occupied orbitals only) |
| `.wfx` (AIM extended wavefunction) | AIMAll; Gaussian 09 B.01 and later (`output=wfx`); Multiwfn | The same data as WFN in tagged sections, plus explicit electron counts, spin types, total energy, virial ratio and optional ECP core-density (EDF) sections |

This page describes what the app reads from each, what it deliberately refuses, and what it does
**not** do yet. Everything on this page happens offline on files you already have; the app never
runs `formchk`, `cubegen` or an external quantum-chemistry program for you.

## What a cube contains

A Gaussian cube is plain text with five parts:

1. two comment lines (a title and, usually, the loop order `OUTER LOOP: X, …`);
2. `NATOMS OX OY OZ` — the atom count and the grid origin;
3. three rows describing the grid: `count vx vy vz` — the point count and the step vector itself,
   four numbers per row, one row per axis;
4. one row per atom: `atomicNumber nuclearCharge x y z`;
5. `nx · ny · nz` values, **x varying fastest** (Fortran order).

That is the order `cubegen` and Psi4's `cubeprop` both write (#153). An earlier revision of this
reader had parts 3 and 4 swapped and expected a five-number grid row (`count spacing vx vy vz`); that
non-standard dialect is still read, but only when line 4 has five tokens, and the read is marked with
a warning so the two are never silently confused.

The step vector is what the format states, so it is used as written: a row of `2 0.2 0 0` means two
points 0.2 bohr apart along x, i.e. a 0.106 Å spacing. Multiplying it by the count again would square
the spacing (#155), and the Wavefunction view reported 0.2 bohr as 0.021 Å before that was fixed.

One further difference is worth knowing. Gaussian writes the values with x varying fastest; Psi4's
`cubeprop` writes the same header and then z fastest. A file whose **first line is Psi4's own
`Psi4 Gaussian Cube File.`** declares its writer, so the reader reorders that file's values to the
x-fastest contract everything else here uses, and records `valuesOrder: 'c-order'` in the parsed
result. A cube whose title was edited can be read with `parseCube(text, { valuesOrder: 'fortran' })`.

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

## What a WFN file contains

A WFN file is the older AIM interchange format (Bader/AIMPAC lineage). It is line-oriented:

```
synthetic water
GAUSSIAN              6 MOL ORBITALS     21 PRIMITIVES        3 NUCLEI
  O    1    (CENTRE  1)   0.00000000  0.00000000  0.22142907  CHARGE =  8.0
  H    2    (CENTRE  2)   1.43044242  0.00000000 -0.96097163  CHARGE =  1.0
  H    3    (CENTRE  3)  -1.43044242  0.00000000 -0.96097163  CHARGE =  1.0
CENTRE ASSIGNMENTS    1  1  1  … (one per primitive function)
TYPE ASSIGNMENTS      1  1  1  … (AIM type codes: 1 S, 2-4 PX PY PZ, 5-10 D…)
EXPONENTS   1.3070932D+02  … (one per primitive function)
MO    1     MO 0.0        OCC NO =     2.0000000  ORB. ENERGY =   -20.240200
   1.00000000D-2  …
END DATA
 THE  HF ENERGY =       -75.987654321000 THE VIRIAL(-V/T)=   2.00412345
```

**The header has two forms, and the reader decides which from the header itself.**

- **3-line header**: the title block, the count line, then the first nucleus row. There is no
  electrostatic-potential data.
- **5-line header**: the same, but with a two-line `MEP` block inserted after the count line — a
  `MEP <count>` row and its values. The block is the **molecular electrostatic potential at each
  nucleus**, in hartree/e. The reader keeps the values in `mep.values`, reports `header.form:
  '5-line'`, and derives nothing from them: no gradient, no Hessian. A file without the block is
  read normally with `mep.present: false` and a warning saying the data is absent.

The count line's label is not always `GAUSSIAN` — GAMESS, MOLPRO, ADF and TONTO files carry their
own — and the title block can be many lines long (archived files often begin with a mail header).
The reader finds the count line wherever it is and records `header.program` and
`header.titleLines`.

### The two basis orderings

WFN stores a basis **primitive function by primitive function**, not shell by shell. Two tables
are accepted, and they are distinguished by what the table looks like — never by trying one parse
and falling back:

- **Gaussian ordering** (`basisOrdering: 'gaussian'`): `CENTRE ASSIGNMENTS`, `TYPE ASSIGNMENTS` and
  `EXPONENTS`, one entry per Cartesian component of every primitive. The integer type codes are the
  AIM order, which is exactly the Cartesian order this app uses. The table is **decontracted**: one
  shell per primitive, a contraction coefficient of 1, and the MO coefficients permuted from the
  file's component-major order (`px₁ px₂ …, py₁ py₂ …, pz₁ pz₂ …`) into the shell-major order the
  checkpoint path uses. No coefficient is averaged or dropped, and `numberOfBasisFunctions` equals
  the number of primitive functions.
- **Labelled ordering** (`basisOrdering: 'non-gaussian'`): the older shell table, a row such as
  `  1  1  'S'` or `  2  1  'SP'` followed by one `exponent coefficient [coefficient]` row per
  primitive. `s`, `p` and `sp` are mapped onto the checkpoint shell order because their component
  order is unambiguous. A **`d`, `f` or higher shell is refused**: a one-letter label does not say
  whether the six d functions are `xx yy zz xy xz yz` or another program's order, and a coefficient
  attached to the wrong component is wrong science with no visible symptom.

Both formats are **Cartesian-only**: there is no spherical marker, so a d shell is six functions and
an f shell ten. The parsed object says `spherical: { d: false, f: false, g: false }` rather than
guessing.

### Orbitals

Each MO is introduced by `MO <index>` with `OCC NO =` and `ORB. ENERGY =` fields; the older form is
`'MO' <index> <occupation> <energy>`. The coefficient run has one value per primitive function (or
per basis function in the labelled ordering) and is checked against the basis: a short or long run
is refused with both numbers. The optional Multiwfn `$MOSPIN` block, when present, labels each
orbital `1` (alpha), `2` (beta) or `3` (alpha and beta); its absence simply means no orbital carries
a spin label.

## What a WFX file contains

WFX is AIMAll's extended format: sections of `<Tag>` … `</Tag>` lines, XML-like but deliberately not
XML. Tags stand alone on their lines, may contain spaces, are case-insensitive, and the sections may
appear in any order. The reader indexes the sections and looks each one up by name.

| Section | Used for |
| --- | --- |
| `<Number of Nuclei>`, `<Number of Primitives>`, `<Number of Occupied Molecular Orbitals>` | The counts every other section is checked against |
| `<Nuclear Names>`, `<Atomic Numbers>`, `<Nuclear Charges>`, `<Nuclear Cartesian Coordinates>` | The geometry, converted from bohr to Å once |
| `<Net Charge>`, `<Number of Electrons>`, `<Number of Alpha Electrons>`, `<Number of Beta Electrons>`, `<Electronic Spin Multiplicity>` | The charge and spin state, stated rather than derived |
| `<Primitive Centers>`, `<Primitive Types>`, `<Primitive Exponents>` | The basis, through the same decontraction as WFN |
| `<Molecular Orbital Occupation Numbers>`, `<Molecular Orbital Energies>` | Energies and occupations; **fractional occupations are kept as written** (natural orbitals are not rounded) |
| `<Molecular Orbital Spin Types>` | `Alpha and Beta`, `Alpha` or `Beta`, which decides the alpha and beta coefficient matrices |
| `<Molecular Orbital Primitive Coefficients>` | One `<MO Number>` block per orbital, each with one coefficient per primitive |
| `<Energy = T + Vne + Vee + Vnn>`, `<Virial Ratio (-V/T)>` | The total energy and virial ratio |

The specification is version 1.0.x and files do not usually state a version. A `<Version>`,
`<WFX Version>` or `<Format Version>` section is accepted when present; a major version other than 1
is **refused by name**, because a different major version may lay out the coefficients differently
and reading it as 1.x would be a guess.

`<Additional Electron Density Function (EDF)>` sections (ECP core density) are not applied. The
parsed object says `edf: { present: true, used: false }` so a caller can see that a density rebuilt
from this record would omit the ECP-modeled core electrons. Nuclear gradients are not read, and none
is invented.

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

From a **WFN file**:

- the atoms and nuclear charges, in Å, from the nucleus table (bohr converted once);
- the header form (`3-line` or `5-line`), the program label and the number of title lines;
- the `MEP` values when the file carries them, or an explicit `mep.present: false` with the reason;
- the basis in the checkpoint's shell layout. The Gaussian ordering is decontracted one shell per
  primitive with the MO coefficients permuted to shell-major order; the labelled ordering maps `s`,
  `p` and `sp` shells directly and refuses `d` and higher;
- each MO's energy, occupation, optional `$MOSPIN` spin label and coefficient vector;
- the `END DATA` total energy and virial ratio.

From a **WFX file**:

- the atoms, names, atomic numbers and nuclear charges, in Å;
- the basis through the same decontraction as WFN;
- each MO's energy, occupation and spin type, with `Alpha and Beta`/`Alpha` orbitals in the alpha
  matrix and `Beta` orbitals in the beta matrix;
- the net charge, electron counts, multiplicity, total energy and virial ratio that the file states;
- `edf: { present, used: false }` when ECP core-density sections exist, so their absence from any
  density rebuilt from this record is visible rather than silent.

The WFN and WFX objects use the checkpoint's field names, so `orbitalGap`, `spinFromElectrons` and
the shell decoder need no branch for them either. Fields the format cannot carry — partial charges,
a virial ratio in WFN's older files, spherical markers — are absent and named in `missing`.

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

- `artifacts`: one entry per file with its kind (`cube`, `fchk`, `molden`, `wfn` or `wfx`), its name,
  its **SHA-256** and its size in bytes — the same provenance idea as `inputSha256` and `outputSha256`;
- `cube`: dimensions, origin, axes, spacing, cell volume, atom count and the statistics above;
- `fchk`: which fields were found and which were missing, the optional scalars, and the derived
  gap, spin and charge blocks.

The Molden reader returns the same fchk-shaped object (`format: 'molden'`), so a caller can pass it
straight to `orbitalGap`, `spinFromElectrons` or `shellsFromFchk`. `wavefunctionRecord` puts it in
the same `fchk` summary block, with `format: 'molden'` naming the reader that produced it; no
Molden-specific spreadsheet columns exist yet. WFN and WFX do the same with `format: 'wfn'` and
`format: 'wfx'`; their summary block also carries `header`, `basisOrdering` and `mep` (WFN) or
`version` and `edf` (WFX), so the provenance that changes how the numbers should be read stays with
the record.

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

## A picture of the field: slices and isosurfaces

The results surface has a **Wavefunction view** card. It evaluates one orbital, or the density, on a
uniform grid from the basis the record already carries, and draws either a plane slice or an
isosurface. Nothing calls `cubegen` and nothing needs a network; the arithmetic is
`src/shared/volume.js` and `src/shared/marchingCubes.js`.

What the card offers:

- **Field**: every alpha MO in the record, or the electron density summed over the occupied ones.
  The HOMO is preselected when the occupations are known.
- **View**: a plane slice (xy, xz or yz, an offset slider, iso lines drawn on top, a legend that
  states the field, the plane and the value range) or an isosurface (orbit, zoom, a ± lobe toggle,
  and PNG / binary STL export).
- **Grid**: 0.2, 0.3 or 0.5 Å. The chosen spacing is printed under the picture, and so is the
  coarsening when the 4-million-point cap forced one.
- **Open .cube…**: a cube from any program goes through the same slice and surface code. The values
  are used as written and the unit is labelled "file units", because a cube does not state its own.

### The numbers under the picture

| Line | Why it is there |
| --- | --- |
| grid, spacing | The resolution the picture was drawn at — a blocky surface is a coarse grid, not a bad orbital |
| evaluated in … s (worker / main thread) | Which thread did the work; a 3-second pause should never be a mystery |
| ∫\|ψ\|²dV (bohr³) | ≈1 for a normalised occupied orbital; below 1 means the box is too small or the grid too coarse |
| ∫ρ dV (e) | The electron count the density actually integrates to |

### Units and normalisation, stated because a wrong constant is a wrong picture

- Exponents are in bohr⁻², so every point is converted to bohr before it touches an exponent, and
  the values are **atomic units**: an orbital amplitude in bohr^{−3/2}, a density in e/bohr³. The
  grid geometry stays in Å, and `cellVolumeBohr3` is provided so `Σ values × cellVolumeBohr3` is the
  integral with no unit slip at the call site.
- Primitives are normalised Cartesian Gaussians,
  `N = (2α/π)^{3/4} √[(4α)^l / ((2i−1)!!(2j−1)!!(2k−1)!!)]`, and a contraction coefficient
  multiplies a *normalised* primitive — the Gaussian/Molden convention. Nothing is renormalised
  afterwards: doing so would move every coefficient relative to the others.
- Pure d and f shells are the standard real solid harmonics: `3z²−r², xz, yz, x²−y², xy` for 5D, and
  `z(5z²−3r²), x(5z²−r²), y(5z²−r²), z(x²−y²), xyz, x(x²−3y²), y(3x²−y²)` for 7F, in that order,
  which is the order Molden and Gaussian store the coefficients in. Their scale is computed from the
  exact monomial overlap metric, not from a table.
- Cartesian f and g shells have two orderings in the wild. `gaussian` (Molden, Gaussian, this app's
  Molden reader) is the default; `aim` is the WFN/WFX order documented in `aimBasis.js`. d is
  identical in both, so this only matters once an f shell is present.
- A shell type the evaluator does not implement is **refused by name**, never zero-filled:

  ```
  the h shell (shell type 5) is not implemented (shell 1); only s, p, sp, d, f and Cartesian g shells are evaluated.
  the spherical g shell (shell type -4, 9 functions) is not implemented (shell 1); the nine-component order is not verified across writers, so it is refused rather than guessed. A Cartesian g shell (15 functions) is evaluated.
  ```

  The spherical g set is refused on purpose: writers disagree about the nine-component order, and a
  coefficient attached to the wrong angular function has no visible symptom. Cartesian 15G is
  evaluated.

### The isosurface

`extractSurface(field, iso)` meshes the level set `{f = iso}`. For `iso > 0` the enclosed region is
`{f > iso}`; for `iso < 0` it is `{f < iso}`. Normals come from the **gradient of the field** by
central differences, interpolated along each cut edge, and they point away from the enclosed region
— so `+0.02` and `−0.02` are the two phases of an orbital, coloured differently and lit
consistently. The mesh is closed by construction (every mesh edge is shared by exactly two
triangles) and the test suite asserts it rather than trusting it.

A skewed (non-orthogonal) grid is refused: the gradient transform assumes perpendicular axes, and a
wrong normal is invisible in a picture.

The viewport is lazy. It creates no WebGL2 context until a mesh exists, and when there is no context
it prints `surface view unavailable: no WebGL2 context` and keeps the triangle counts, the isovalue
and the grid on screen. A blank canvas would claim the orbital has no surface, which is false.

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

For a WFN file:

- **No count line.** A file with no `… MOL ORBITALS … PRIMITIVES … NUCLEI` line is refused; the
  message quotes the line form it needs, and the reader does not assume the count line is line 2
  (a title block can be arbitrarily long).
- **A nucleus table that does not match.** A table shorter than the declared nucleus count, an
  out-of-order row, or a row that is not a nucleus row is refused with the declared and found counts.
- **An MEP block that does not fit.** It must hold exactly one value per nucleus: a short block names
  both numbers, and an overlong one is refused because the block and the nucleus table disagree.
- **A count mismatch.** A basis table that ends before `PRIMITIVES` values, a coefficient block
  shorter or longer than the basis, or an MO count that disagrees with the number of `MO` blocks is
  refused with both numbers.
- **A basis table it does not recognise.** Neither `CENTRE ASSIGNMENTS` nor a labelled shell row:
  refused instead of guessed.
- **A labelled d/f/g shell.** Refused by name, for the component-order reason above.
- **A non-numeric token.** Refused with the line number, in the nucleus table, basis tables, the
  `MEP` block and the coefficient runs alike.

For a WFX file:

- **A version outside 1.x.** Refused by name, with the version the file states.
- **A non-GTO keyword set.** Refused; the reader handles Cartesian Gaussian primitives only.
- **A count that disagrees.** Nucleus, primitive and orbital counts are checked against every array,
  and the error names the section and both numbers. A coefficient block that ends early is refused
  as `MO n has X coefficients but <Number of Primitives> says Y`.
- **An unclosed or mismatched tag.** Refused with the tag name and line, so a truncated WFX is not
  read as a shorter molecule.
- **A file without the required sections.** `<Number of Nuclei>`, `<Number of Primitives>`,
  `<Number of Occupied Molecular Orbitals>`, `<Nuclear Charges>`, the coordinates and the
  coefficient block are required; the message names the missing one.

A missing field is different from a broken one: it is simply **absent**. Nothing is zero-filled, and
the record lists the missing field names so a reader can see what the file did not contain. A Molden
file has no total charge, multiplicity, partial charges or total energy, so those keys are absent
from its parsed object and named in `missing`; deriving a charge from the geometry would be an
invention, not a read.

## Making a cube without Gaussian

`ncs cube` evaluates one orbital from a wavefunction the app already reads and writes a cube file —
no `cubegen`, no Gaussian installation, no network:

```
ncs cube <run-dir|wavefunction> --orbital homo|lumo|n=<i> --out file.cube
    [--grid 0.2] [--padding 3] [--json]
```

- The input is a run folder holding exactly one `.fchk`, `.molden`, `.wfn` or `.wfx` file, or that
  file directly. A folder with two candidates is refused with both names: the command does not pick.
- `--orbital homo` is the last orbital with a non-zero occupation, `lumo` the first with none, and
  `n=<i>` the 1-based index the file's own orbital order prints. Occupations come from the file; a
  restricted checkpoint that states none gets them from `Number of alpha electrons` (2 each), which
  is the one derived number in the command and the reason `homo`/`lumo` mean anything there.
- `--grid` is the spacing in Å (default 0.2) and `--padding` the margin added on every side of the
  atom bounding box (default 3). If the 4-million-point ceiling forces a coarser grid, the spacing
  actually used is printed, never the requested one.
- The values are written in **atomic units**, as the evaluator produced them (an orbital amplitude
  in bohr^-3/2), in the standard layout above: Å in the header (negative counts), the grid rows
  first, four numbers each, then the atoms, then the values six per line in `%12.5E` with x fastest.

What the command prints is what the picture should be checked against, and `--json` carries the same
fields:

| Field | Meaning |
| --- | --- |
| `orbital`, `energyEh` | The MO that was evaluated and the energy the file states. No energy in the file means `energyEh: null` and an `energyNote` beginning `not available:` — never a 0 |
| `grid.spacing`, `grid.points`, `grid.capped`, `grid.note` | The grid actually used, including the coarsening when the cap forced one |
| `integral.value` | ∫\|ψ\|²dV over the box, in bohr³ — **not** 1.0, and its `note` says why: a finite box does not integrate to exactly 1 because the density outside it is not counted. A value well below 1 means the padding is too small or the grid too coarse |

```
$ ncs cube dvb-g16-b3lyp-sto3g.fchk --orbital homo --grid 0.2 --padding 3 --out homo.cube
wavefunction: /…/dvb-g16-b3lyp-sto3g.fchk (fchk)
orbital: MO 35 (homo), occupation 2.000
energy: -0.153073 Eh
grid: 0.200 Å, 78×58×31 = 140244 points
integral: ∫|ψ|²dV = 0.999992 over 1121.952 Å³ — |psi|^2 over the finite grid box; a finite box does not integrate to exactly 1, because the density outside it is not counted.
wrote: homo.cube (1824551 bytes)
```

(That transcript is the DVB fixture in `test/fixtures/fchk/`, run at 0.2 Å. The same orbital at 0.6 Å
with `--padding 2` integrates to 1.106 and at 0.3 Å with `--padding 3` to 0.997: the coarse grid, not
the orbital, and the reason the spacing is printed.)

### The Psi4 cross-check

An implementation that disagrees with an independent one draws a wrong picture convincingly, so the
evaluator and the writer are checked against Psi4 1.11. `test/fixtures/psi4/` holds a water
B3LYP/6-31G* SCF computed in the official `psi4/psi4:1.11` image (spherical 5D d functions, which is
what Gaussian uses for Pople bases), the formatted checkpoint `psi4.fchk` wrote, and the HOMO cube
`psi4.cubeprop` wrote — both verbatim, unmodified. The README beside them states the input, the
version, the date and the energy.

`test/cubeWriter.test.js` parses that cube, evaluates the same MO from the same checkpoint with
`src/shared/volume.js` on the grid the cube declares, aligns the arbitrary MO phase, and reports the
largest disagreement. **Measured: max |Δψ| = 8.5 × 10⁻⁷ a.u.** over 56×41×47 points (the fixture's
six-digit values alone leave a few 10⁻⁷) against a required bound of **1 × 10⁻³ a.u.** — and the
overlap of the two fields is 0.9999999, so the comparison is of the same orbital rather than of two
unrelated ones.

That test is also the proof of the two reader fixes above: the fixture is a stock Psi4 cube, with the
grid rows before the atoms, four numbers per grid row, and the values in Psi4's order. It cannot be
read at all by the pre-#153 reader, and it would be read as a transposed field by a reader that
ignored Psi4's value order.

## What is not here yet

The ingest half of issue #59 is implemented. The visual half is not, and this page would rather say
so than show a picture that implies otherwise:

- **Isosurfaces in the report.** The app draws them (`## A picture of the field` above); the report
  renders figures from data, and a surface in the report is a later workstream.
- **ESP colour-mapped surfaces and colour bars.** Requires a molecular surface and a colour scale,
  neither of which exists yet.
- **QTAIM/AIM critical points, bond paths and basin charges.** A separate analysis with its own
  numerical requirements.
- **NCI/RDG surfaces, ELF/LOL, deformation density.** Also separate analyses, not another cube read.
- **Cube *density* and ESP cubes from the CLI.** `ncs cube` writes one orbital; the density
  (`Σ occᵢ|ψᵢ|²`) and an ESP cube need a different evaluator or the density matrix, which `fchk.js`
  does not parse yet.
- **Reading a cube whose values are in an unstated order.** Only Psi4's own title triggers the
  reorder; a cube re-saved with another tool's title is read x-fastest, as the format says, and the
  reader does not guess further.
- **Molden's vibrational sections.** `[FREQ]`, `[FR-COORD]`, `[INT]` and `[GEOMETRIES]` are ignored;
  frequencies come from the engine output parsers, not from a Molden file.
- **Molden in the CLI and the window.** The shared reader is wired into `readWavefunction`, but
  `ncs convert job.molden --format xyz|sdf|qcschema` and the window's file picker are not. The
  shared reader is the piece both would call.
- **WFN/WFX in the CLI and the window.** `ncs convert job.wfn|job.wfx --format molden|xyz` is not
  implemented; only `detectWavefunctionFormat`/`readWavefunction` accept the two formats. WFN and
  WFX carry occupied orbitals only, so a Molden file written from them would have no virtuals.
- **WFX/WFN emission.** Reading is the half this page covers; nothing writes either format back.
- **Applying WFX EDF data.** ECP core-density sections are detected and reported, but not added to
  any density, so a density rebuilt from a WFX with an EDF would omit those core electrons.
- **WFN gradients.** None is read, because the traditional format does not carry one; the WFX
  gradient sections are likewise left unread.
- **Attaching checkpoints and Molden files from the UI.** The cube picker in the wavefunction view
  is wired; choosing an fchk or a Molden file when a run finishes, and writing the block into
  `run.json`, still belongs to the run-writer.
- **Multiwfn hand-off.** Generating a Multiwfn input deck and reading its text report back is the
  cheaper route for the analyses above, and is not implemented.

Every one of those is listed in issue #59, so the gap between "what is read" and "what is drawn"
stays visible instead of being discovered by a user who expected a picture.

## Next

- [Results](results.md) — the panel these values belong to.
- [Projects and runs on disk](project-files.md) — the run folder and `run.json`.
- [Output corpus](parser-corpus.md) — the real logs the parser is tested against.

Back to the [documentation index](README.md).
