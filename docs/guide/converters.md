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

## What is not written yet

- **Cube downsampling.** A `.cube` is read at full resolution; the reader caps it at 4 M voxels and
  64 MB of text, and refuses a larger field rather than subsampling it silently.
- **Export from the window.** The CLI writes files; the results panel has no export button yet
  beyond the structure viewer's SVG figure.

## Next

- [Spectra: reading a JCAMP-DX file](spectra.md) — the other direction: `X++(Y..Y)`, `XYPOINTS` and
  the compression markers an imported `.jdx` may carry.
- [Wavefunctions: cubes, formatted checkpoints and Molden files](wavefunction.md) — what the
  wavefunction files hold.
- [Results and analysis](results.md) — the numbers a run reports before export.
- [Command line](cli.md) — the rest of `ncs`.

Back to the [documentation index](README.md).
