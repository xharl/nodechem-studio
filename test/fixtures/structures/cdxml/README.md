# CDXML fixtures

**None of these files came from ChemDraw.** Every one is hand-written CDXML for
`test/cdxml.test.js` (#120): synthetic-but-valid documents that use the element and attribute names
the CDXML DTD defines (`CDXML`, `page`, `fragment`, `n`, `b`, `t`, `fonttable`, `colortable`) so the
reader is tested against the format's contract rather than against one application's output.

They are deliberately small and readable. They are **not** a corpus: the repository has no ChemDraw
export to commit, and a real-export corpus would be a separate task with its own provenance table
(see `../README.md` for the pattern the structure corpus follows).

| File | What it exercises |
|---|---|
| `benzene.cdxml` | One fragment of six unlabelled carbons with six `Order="1.5"` bonds: the single-fragment path and aromatic bonds kept as aromatic |
| `salt.cdxml` | Two fragments, `Na` `+` and `Cl` `-`, each a single labelled node: fragments become separate records, and a charge is read from the label |
| `butane.cdxml` | Four unlabelled nodes and three single bonds: a node with no `<t>` label is carbon |
| `ammonium.cdxml` | `N` with a superscript `+` and four explicit `H` nodes: an explicit charge label, the charge sum, and the electron-parity result |
| `wedge.cdxml` | `WedgeBegin` and `WedgedHashBegin` bonds: stereo is stored as a drawing cue with the narrow end, never as an R/S assignment |
| `refuse-label.cdxml` | A node labelled `CO2H`: refused by name, not read as carbon |
| `cross-fragment-bond.cdxml` | A bond in fragment 1 whose `E` is a node of fragment 2: refused by name; fragment 2 still imports |
| `graphics.cdxml` | A page with arrows, a curve and a caption `<t>`: ignored element types are named in the warnings, and the nearby text names the record |

The `.cdx` refusal is pinned inline in the test (a `.cdx` is binary; committing a fake one would not
make it a better fixture). Nothing here is a ChemDraw drawing, so no coordinate, label or bond in
these files should be quoted as a real ChemDraw export.
