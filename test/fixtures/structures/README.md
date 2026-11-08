# Structure-import corpus

Real files from public sources, used to test `src/shared/structureImport.js` and the 3D viewer.
Every file here is **unmodified except where the table says otherwise**, and every one is small
enough to keep in the repository.

| File | Format | Source | Licence | What it exercises |
|---|---|---|---|---|
| `pubchem-5molecules.sdf` | SDF, 5 records | PubChem PUG-REST, CIDs 2244, 2519, 3672, 5904, 5957, 3D conformers (`pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/2244,2519,3672,5904,5957/SDF?record_type=3d`) | PubChem data, public domain | Multi-record import with titles, bond blocks and orders (aspirin, caffeine, ibuprofen, penicillin G, ATP). Heavy-atom counts 21 / 24 / 33 / 41 / 47. Penicillin G adds S, ATP adds P |
| `1crn.pdb` | PDB, 1 model | RCSB PDB `files.rcsb.org/download/1CRN.pdb` — crambin, 1.5 Å | CC0 1.0 | Fixed-column `ATOM` records, 327 atoms, and 6 `CONECT` lines for its three disulfides; the single-model PDB case (#79) |
| `1l2y-first-2-models.pdb` | PDB, 2 of 38 models | RCSB PDB `1L2Y.pdb`, **truncated** to the first two `MODEL` blocks to keep the repository small | CC0 1.0 | Multi-`MODEL` PDB: a record picker must offer 2 entries, not 38 and not 1. Trp-cage, 304 atoms per model |
| `1crn.cif` | CIF | RCSB PDB `files.rcsb.org/download/1CRN.cif` | CC0 1.0 | The periodic refusal: this must be rejected **by name**, not parsed as a cluster (#66) |
| `rdkit-sulfonate.mol2` | MOL2 | RDKit `Code/GraphMol/FileParsers/test_data/Sulfonate.mol2` | BSD-3-Clause | Tripos header, `@<TRIPOS>ATOM` / `@<TRIPOS>BOND`, 8 atoms, 7 bonds; the file begins with `#` comments, which used to be sniffed as a `.gjf` route |
| `rdkit-noxide.mol2` | MOL2 | RDKit `Code/GraphMol/FileParsers/test_data/Noxide.mol2` | BSD-3-Clause | Charged/zwitterionic MOL2 with atom types and bond block |
| `g16-dvb-gopt-frames.xyz` | XYZ, 6 frames | **Derived** from `test/fixtures/real/g16-dvb-gopt.out` (already in this repository) by `parseTrajectory()`; geometry, element and energy are Gaussian's, only the container changed | Same as the parent log (from `cclib/cclib`) | Multi-frame XYZ: a frame picker must offer 6 entries of 18 atoms each |

## Retrieval

Downloaded 2026-11-08 with `curl` from the URLs above. `1l2y-first-2-models.pdb` was produced with
`awk '/^MODEL/{m++} m<=2' 1L2Y.pdb`, which keeps the first two complete models and nothing else; the
other files are byte-identical to their sources.

## State of play

- **Parsed today:** the SDF (5 records, bonds and orders) and the derived XYZ (6 frames).
- **Refused today, by name:** `.cif` (periodic, decision #66) and `.pdb` / `.mol2` (not implemented,
  tracked in #79). Both refusals name the reason; `test/structureCorpus.test.js` pins that text so a
  silent regression to "Unrecognised structure format" fails the suite.
- **Not here yet:** PDBQT, cJSON, a `.gjf`/`.com` from a third party (the repository's own examples
  cover the builder side), and a MOL2 with a protein-sized atom count.

When #79 lands PDB and MOL2 support, the two refusal assertions in `test/structureCorpus.test.js`
become positive assertions over these same files — the fixtures do not need to change.
