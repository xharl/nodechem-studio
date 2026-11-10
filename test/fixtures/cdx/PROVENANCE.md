# CDX fixture provenance

The three `.cdx` files are the example inputs from
[quantaosun/cdx-to-smiles-extractor](https://github.com/quantaosun/cdx-to-smiles-extractor),
tagged `examples/input/cdx/`, MIT-licensed. They are real ChemDraw binary
documents, not files written by this project.

The paired `.cdxml` files were produced from those exact `.cdx` files with
[pycdxml](https://github.com/kienerj/pycdxml)'s `cdxml_converter.read_cdx()` and
`write_cdxml_file()` on 2026-11-10. They are the independent conversion used by
`test/cdx.test.js` to compare atom order, elements, coordinates (within the
CDX fixed-point rounding of 1/65536 page units), bonds and charges. The app's
reader never calls pycdxml; it parses the binary tags directly in `src/shared/cdx.js`.

The molecules are aspirin, caffeine and ibuprofen. The drawings carry no
explicit hydrogens; the reader preserves exactly the heavy-atom graph the
files state, as the CDXML reader does.
