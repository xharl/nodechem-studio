# Converters: getting results into other software

NodeChem's parsers answer "what did the calculation report". Exporting answers a different
question: "how do I get this into the program that will draw it, fit it, or cite it".

`ncs convert` writes five formats, each chosen because a real tool reads it:

| Format | Carries | Read by |
| --- | --- | --- |
| `extxyz` | every geometry in a run, with per-frame energy | ASE, OVITO, VMD, libAtoms |
| `xyz` | every geometry, no metadata columns | nearly everything |
| `sdf` (V2000) | one structure **and its bond table** | RDKit, Open Babel, ChemDraw, Avogadro |
| `jcamp` (`.jdx`) | one spectrum with units and axis limits in the header | Mnova, Origin, spectroscopy tooling |
| `molden` | one structure, its basis and its orbitals | Molden, Avogadro, MacMolPlt, Multiwfn (Molden2AIM), Jmol |

```bash
ncs convert run.log --format extxyz --out run.extxyz
ncs convert run.log --format jcamp --spectrum raman --out raman.jdx
ncs convert ligand.mol2 --format sdf --out ligand.sdf
ncs convert project.ncs --format xyz --out geometry.xyz
ncs convert job.fchk --format molden --out job.molden
```

Add `--json` for a machine-readable summary: format, output path, byte count and the notes the
writer attached.

From the window, **Export as…** in the run console's Tools offers the same formats, Molden included.
A log carries no basis, so Molden needs the job's formatted checkpoint: run `formchk -3` on the
`.chk` (bare `formchk` writes a reduced backward-compatibility subset), copy the `.fchk` beside
`run.json`, and the export reads it. Without one the export refuses with that instruction instead
of writing a Molden file with no basis in it.

## What the engine boundary buys you

The converters never look at a route, a program banner or a keyword. They consume the shapes the
parsers produce — frames, atoms, bonds, spectra — so a second engine inherits every format as soon
as its parser produces the same shapes. That is the whole point of writing them against the record
rather than against Gaussian text.

## Conventions worth stating

**Energy in extxyz is in eV.** ASE reads and writes `energy=` in electronvolts; a hartree value
written there would be wrong by a factor of 27.2 for anyone importing it. The writer emits
`energy=<eV>` and `energy_hartree=<Eh>` side by side, so neither reading loses the original.

**A frame with no parsed energy has no energy key.** Writing `energy=0` would turn "not reported"
into a measurement. The first geometry of an optimisation often precedes its SCF energy, and it is
written without one.

**SDF is refused when the record states no bonds.** A Gaussian log gives atoms and distances; the
bonds are perceived when the structure is drawn. An SDF holding a perceived bond table would look
authoritative and be a guess, so the export stops and points at `extxyz`, which does not claim to
know connectivity. Import a structure file that carries its own bonds (MOL2, SDF, PDB with complete
`CONECT`) and SDF export works.

**Aromatic bonds become type 4.** MOL2 writes aromatic bonds as order 1.5; V2000 has no 1.5 and
uses type 4. The mapping is lossy in the other direction, and the importer maps type 4 back to 1.5,
which is what the round-trip tests check.

**JCAMP axes are declared, not assumed.** A vibrational spectrum is `1/CM`; a UV/Vis spectrum built
from excited states is `NM`; the intensity is `ARBITRARY UNITS` because a broadened spectrum is
normalised rather than measured. A UV/Vis export says which FWHM produced it.

## The run cache (`.ncsr`)

Every view re-parses the log it is showing. That is milliseconds for a small
molecule and tens of megabytes of ASCII for a `.cube`. `ncs cache` writes the parsed values
as typed arrays instead:

```bash
ncs cache run.log --out run.ncsr          # the frames of an optimisation
ncs cache field.cube --out field.ncsr     # one volumetric field
ncs cache run.ncsr --inspect              # what is inside
```

A real six-frame optimisation log (210 729 bytes of text) becomes **1 977 bytes**: coordinates
as `f32`, energies as `f64`, a symbol table and the step numbers. The container is a 12-byte
prefix, a JSON header with a section table, and aligned binary payloads — no zip, no
dependency, no per-value formatting.

Two decisions worth knowing:

- **Energies stay `f64`; coordinates become `f32`.** A coordinate is drawn, an energy is
  compared to the microhartree elsewhere; a cache must not be the reason two analyses disagree.
- **A cube cache is `f64` by default.** Ask for `--precision f32` only when the cache exists to
  be drawn, because a density rounded to single precision moves an isosurface.

Runs made by the app write `trajectory.ncsr` next to `run.json`, and record it in the run
record (`cache.file`, `cache.frames`, `cache.bytes`). A dry run writes none: its output is a
fixture, and a binary file beside it would outlive the label that says so. When a log has no
trajectory, the record says why (`cache.skipped`) instead of writing an empty file.

## Molden: why it starts from a checkpoint, not a log

A log has energies and geometries. Molden needs the **basis functions** and the **MO coefficients**,
and of the files `ncs convert` accepts today only a formatted checkpoint carries them — so
`ncs convert job.fchk --format molden` is the only path, and pointing `--format molden` at a log is
refused with that sentence rather than writing a file whose orbitals are empty.

What the writer does with a checkpoint:

- **Atoms in Angstrom, exponents in atomic units.** The format wants Angstrom in `[Atoms]` and atomic
  units in `[GTO]`; the checkpoint stores Bohr, so the coordinates are converted and the primitives
  are not.
- **`sp` shells are split.** Gaussian stores one shell for the s and p parts of a contracted shell;
  the writer emits a bare `s` and a bare `p` with the same exponents. The function order (s, then
  x, y, z) is unchanged, and readers that mishandle a two-coefficient `sp` line still read the same
  basis.
- **Coefficients are passed through.** Gaussian and Molden order the functions the same way for
  s/p and for Cartesian shells, and both use the 0, +1, −1, +2, −2 ordering for spherical d/f/g.
  Reordering would need a convention table that, if wrong, corrupts every orbital.
- **An unsupported shell is an error.** Molden has no `h`; a checkpoint with one is refused instead
  of dropping six functions and shifting every coefficient after them.
- **Spherical or Cartesian is stated, not assumed.** `[5D]`, `[7F]` and `[9G]` are written when the
  checkpoint's shell types say pure functions, and a basis that mixes both for the same angular
  momentum is refused because one marker cannot express it.

Verified against a real Gaussian 16 checkpoint (`test/fixtures/fchk/`) and read back by **iodata**, an
independent Molden implementation: 60 basis functions, 60 orbitals, MO energies within 5·10⁻⁷ Eh and
coefficients within 5·10⁻⁹ of the checkpoint, 70 electrons.

## Bringing a structure in

The other direction has the same rule: an import is only an import if the app can say what it read.
Every reader below produces the same record — atoms, bonds when the format states them, charge,
multiplicity, and a geometry with a `dimension`.

| Format | What it carries | What it does **not** carry |
| --- | --- | --- |
| `.xyz` | atoms and Cartesian coordinates | bonds, charge, multiplicity |
| `.mol` / `.sdf` | atoms, bonds, orders, `M  CHG` | — (2D files import, flagged as 2D) |
| `.mol2` | atoms, bonds, aromatic bonds, charges | — |
| `.pdb` / `.pdbqt` | atoms (CONECT is reported, not used as topology) | reliable bond orders |
| `.gjf` / `.com` | atoms, charge, multiplicity (Cartesian only) | bond orders |
| `.cdxml` | atoms, bonds, charges, 2D positions | a 3D geometry |
| Gaussian `.log` / `.out` | every frame of the optimisation | bond orders |
| `.nw`, `.inp`, `.qcin` | atoms, charge, multiplicity from a deck this app exported | bond orders |
| `.smi` / `.smiles` | **a bond graph only** — see below | coordinates, which is why it is refused |
| `.cdx` | **nothing** — no reader exists | everything |

**A SMILES string is refused as a geometry, by name.** The reader in
`src/shared/interop/smiles.js` understands the OpenSMILES organic subset: B, C, N, O, P, S, F, Cl,
Br, I and aromatic `b c n o p s`, with branches, ring closures, `.` components, `- = # :`, formal
charges of ±1, explicit H and implicit H by Daylight's valence rule. It stops, naming the token and
its character position, at stereochemistry (`@`, `@@`, `/`, `\`), isotopes, charges above ±1,
aromatic boron and phosphorus, metals, and SMARTS operators. Aromatic bonds stay aromatic (order
1.5): the reader never Kekulises a ring, because assigning double bonds to six letters is a
chemistry claim it cannot check — write the Kekulé form (`C1=CC=CC=C1`) if you want explicit orders.

What it produces is a graph with **no coordinates**. That is why the importer refuses it rather than
accepting it: the structure block, the project format (`geometry.dimension` is `2d` or `3d`) and the
run builder all need atoms at positions, and a structure with an empty coordinate list would run as
the app's demo water molecule. The refusal names the formula it read (for benzene: `C6H6 · 6 atoms ·
6 bonds · charge 0`) and the way forward:

```bash
obabel -ismiles ligand.smi --gen3d -oxyz -O ligand.xyz && echo "import ligand.xyz"
ncs smiles ligand.smi --json          # read the graph without an embedder
ncs smiles 'CC(=O)[O-]'               # one line: formula, atoms, bonds, charge, multiplicity
```

Deck import is CLI-only for now: the project format has no `geometry.format` id for `nwchem`,
`gamess` or `qchem`, so importing one in the window would produce a project that cannot be saved.
The importer says that instead, and `ncs convert job.nw --format xyz` reads it.

`.cdx` is refused for the same kind of reason with a different answer: ChemDraw's binary form has no
public specification, so there is no reader here, and a reader written against a guessed tag stream
would mis-read bond orders. Save the drawing as CDXML (File → Save As → CDXML) and import that.

## Handing a job to NWChem, GAMESS or Q-Chem

Three engines are **export-only**: the app writes their input and does not run them. There is no
queue, no output parser and no gate — the deck is the deliverable.

```bash
ncs export-input project.ncs --node opt-1 --engine nwchem --out opt1.nw
ncs export-input project.ncs --node opt-1 --engine gamess --out opt1.inp
ncs export-input project.ncs --node opt-1 --engine qchem  --out opt1.qcin
ncs export-input project.ncs --node opt-1 --engine nwchem --json

# The same deck, through the converter. Identical bytes: both call one function.
ncs convert project.ncs --node opt-1 --format nwchem --out opt1.nw
```

In the window, select the calculation block and open **Export** in the header. It offers
*NWChem input (.nw)*, *GAMESS input (.inp)* and *Q-Chem input (.qcin)* beside the Gaussian `.gjf`,
each labelled **export only** — this build writes these decks and does not run them. The menu calls
the same exporter the CLI does, so a deck saved from the window is byte-for-byte the deck
`ncs export-input` prints; the test suite asserts that comparison rather than trusting it.

The deck is built from the same settings the Gaussian block would use: job type, method, basis,
charge, multiplicity, memory, and the project geometry. Each engine has a capability table
(`src/shared/interop/*.js`) and **refuses any combination it cannot spell**, naming the field:

| | NWChem | GAMESS (US) | Q-Chem |
| --- | --- | --- | --- |
| job types | sp, opt, freq, saddle | sp, opt, freq | sp, opt, freq |
| job keyword written | `task dft energy\|optimize\|freq\|saddle` (`task scf …` for HF) | `RUNTYP=ENERGY\|OPTIMIZE\|HESSIAN` | `$rem JOBTYPE = sp\|opt\|freq` |
| functionals | HF, B3LYP, PBE0, PBE, M06-2X | HF, B3LYP, PBE, PBE0 | HF, B3LYP, PBE, PBE0, M06-2X, ωB97X-D |
| dispersion | `disp vdw 3`/`4` for BLYP, B3LYP, BHLYP, TPSS, TPSSh | — | `DFT_D` = `D3_ZERO`/`D3_BJ` |
| solvation, TD-DFT, ECP, constraints, TS (GAMESS/Q-Chem) | refused by name | refused by name | refused by name |

The mappings are deliberately narrow and live in one place per program (`METHODS`, `BASES`,
`JOB_TYPES` at the top of `src/shared/interop/{nwchem,gamess,qchem}.js`). A name outside a table is
refused rather than transliterated, because `PBE0` in one manual is not necessarily the string
another program resolves, and a deck that silently means a different functional is worse than an
error.

Refusals are a value, not an error: `ncs export-input` exits 2 and prints
`{ "ok": false, "code": "export-refused", "engine": "...", "message": "..." }` on stderr, so a
script can branch on it. A project with **no geometry** is refused with `export-no-geometry` — the
builder would otherwise substitute the demo water molecule, and a deck that computes water is worse
than no deck. A block that sets Gaussian-only fields (`customKeywords`, `scf`, `grid`, `population`,
`solvation`, `tdStates`, constraints) is refused naming the field, because translating it would be a
guess.

`Opt Freq` is refused as one deck for all three: each program runs one job per input here, so export
the Opt block, import the optimised geometry, and export the Freq block. The deck also states its
units on the line that matters (`UNITS=ANGS` in GAMESS, `units angstroms` in NWChem).

A deck this app wrote can be read back: `ncs convert opt1.nw --format xyz` uses the same reader the
importer uses, and the round-trip test asserts the atoms, charge and multiplicity survive. A deck
carries no bond table, so bonds are not part of that round trip — `.sdf` export is the format that
does carry them.

## What is not written yet

- **Cube downsampling.** A `.cube` is read at full resolution; the reader caps it at 4 M voxels and
  64 MB of text, and refuses a larger field rather than subsampling it silently.
- **Deck import into the window.** The window now writes the three decks, but the reverse trip is
  CLI-only: `projectSchema.js` has no `geometry.format` id for `nwchem`, `gamess` or `qchem`, so a
  project saved with an imported deck could not be reopened. `ncs convert job.nw --format xyz` reads
  one back in the meantime.

## Next

- [Spectra: reading a JCAMP-DX file](spectra.md) — the other direction: `X++(Y..Y)`, `XYPOINTS` and
  the compression markers an imported `.jdx` may carry.
- [Wavefunctions: cubes, formatted checkpoints and Molden files](wavefunction.md) — what the
  wavefunction files hold.
- [Results and analysis](results.md) — the numbers a run reports before export.
- [Command line](cli.md) — the rest of `ncs`.

Back to the [documentation index](README.md).
