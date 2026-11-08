# Vendored QCSchema JSON Schemas

These files are **verbatim copies** of the published MolSSI QCSchema schemas. They are
not our description of QCSchema; `src/shared/qcschema.js` validates the documents it
writes and reads against them, so a field the upstream schema forbids is a failure here
too.

| File | Source | SHA-256 |
| --- | --- | --- |
| `v2/qc_schema_output.schema` | `qcschema/data/v2/qc_schema_output.schema` | `04a19350485fce8d89c895fed01f5e45151f72fd7a61b784a80034fbbe04738a` |
| `v2/qc_schema_molecule.schema` | `qcschema/data/v2/qc_schema_molecule.schema` | `04550a4218e499419c40fa2f8e88ee90efeb0f5c070bea73bbc12228fd18b87c` |

- Repository: <https://github.com/MolSSI/QCSchema>
- Commit: `462d17bc1e994b81286a91492d70656dca6272e0`
- Licence: BSD 3-Clause, Copyright (c) 2017, The Molecular Science Software Institute
  (<https://github.com/MolSSI/QCSchema/blob/master/LICENSE>).

Upstream ships the schemas minified on one line; the copies keep that byte layout so a
reader can verify them with `sha256sum` and diff them against a checkout of the QCSchema
repository. To update, replace both files and update the table above in the same commit.

Two upstream details that shape the writer in `src/shared/qcschema.js`:

- `properties` is closed (`additionalProperties: false`), so `return_gradient` /
  `return_hessian` are **not** emitted there. `driver` and `return_result` carry the
  derivative instead, which is what QCSchema defines them for.
- `model` requires both `method` and `basis`, while QCSchema's own pydantic model treats
  `basis` as optional. A run with no separate basis (xTB, composite methods) therefore
  says `basis: "method-defined"` — the sentinel the app's provenance already uses — rather
  than inventing a basis-set name or omitting a required field.
