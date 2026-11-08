# QCSchema fixtures — synthetic, not results

Every document here is **hand-built for tests**. None of them came from a Gaussian,
Psi4, ORCA or xTB run, and none of the numbers is a computed result:

- `provenance.creator` says `NodeChem Studio test fixture (synthetic)`,
- `provenance.version` is `0.0.0-fixture`,
- `extras.nodechem.synthetic` is `true`.

The water geometry is the one the app's dry-run fixture writes (the same O/H/H
positions as `examples/single-point.ncs`), converted to bohr by the constant in
`src/shared/qcschema.js`; the energy `-76.0` is the fixture output's placeholder, not a
calculation. Do not cite these files as evidence that anything ran.

| File | What it exercises |
| --- | --- |
| `water-energy.qcschema.json` | A minimal valid `qcschema_output`: energy only, no wavefunction, no derivatives. |
| `water-gradient.qcschema.json` | `driver: gradient` — the gradient travels in `return_result`, not in `properties`. |
| `water-input.qcschema.json` | A bare `qcschema_input`, read for its molecule (no energy to read). |

The documents validate against `schemas/qcschema/v2/qc_schema_output.schema` (and the
molecule against `v2/qc_schema_molecule.schema`) through `validateQcschemaOutput()` — the
tests assert that rather than trusting it.
