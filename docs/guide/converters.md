# Converters: getting results into other software

NodeChem's parsers answer "what did the calculation report". Exporting answers a different
question: "how do I get this into the program that will draw it, fit it, or cite it".

`ncs convert` writes four formats, each chosen because a real tool reads it:

| Format | Carries | Read by |
| --- | --- | --- |
| `extxyz` | every geometry in a run, with per-frame energy | ASE, OVITO, VMD, libAtoms |
| `xyz` | every geometry, no metadata columns | nearly everything |
| `sdf` (V2000) | one structure **and its bond table** | RDKit, Open Babel, ChemDraw, Avogadro |
| `jcamp` (`.jdx`) | one spectrum with units and axis limits in the header | Mnova, Origin, spectroscopy tooling |

```bash
ncs convert run.log --format extxyz --out run.extxyz
ncs convert run.log --format jcamp --spectrum raman --out raman.jdx
ncs convert ligand.mol2 --format sdf --out ligand.sdf
ncs convert project.ncs --format xyz --out geometry.xyz
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

## What is not written yet

- **Molden.** It needs basis functions and MO coefficients, which the `.fchk` reader does not expose
  yet. A Molden writer built on a guess would put the orbitals in the wrong shells.
- **A binary run cache.** Cube text is several times the size of the array it holds; the reader caps
  a cube at 4 M voxels and 64 MB of text for that reason.
- **Export from the window.** The CLI writes files; the results panel has no export button yet
  beyond the structure viewer's SVG figure.

## Next

- [Wavefunctions: cubes and formatted checkpoints](wavefunction.md) — what the two wavefunction
  files hold, and why Molden is not written yet.
- [Results and analysis](results.md) — the numbers a run reports before export.
- [Command line](cli.md) — the rest of `ncs`.

Back to the [documentation index](README.md).
