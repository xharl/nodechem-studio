# NodeChem Studio documentation

NodeChem Studio is a desktop app for building and running computational-chemistry workflows as a
graph. You place calculation blocks on a canvas, connect them, and run either the whole workflow or
a single block. Each run writes a folder you can inspect, hash and hand to someone else.

It drives five engines:

| Engine | Licence | What it is |
| --- | --- | --- |
| **Gaussian 16** | Commercial, licensed separately by Gaussian, Inc. | DFT and wavefunction calculations with explicit basis sets |
| **xTB** (GFN0/GFN1/GFN2/GFN-FF) | Open source, LGPL | Fast semi-empirical and force-field calculations |
| **ORCA** 5/6 | Free for academic use, licensed separately by FACCTs | DFT and wavefunction calculations from a simple `.inp` |
| **Psi4** 1.4+ | Open source, LGPL-3.0 | DFT, wavefunction and SAPT calculations from a Psithon `.dat` script |
| **PySCF** 2.x | Open source, Apache-2.0 | DFT and wavefunction calculations, CASSCF and PCM from a fixed Python deck |

The app never bundles any engine. It drives an installation you already have.

## Reading order

If you are new, read these in order:

1. [Install](install.md) — get the app onto a machine, and learn where it keeps its files.
2. [Your first project](first-project.md) — open the seeded project, run the dry run, read the result.
3. [The canvas](canvas.md) — blocks, connections, the inspector, and what the node colours mean.
4. [Flows, datasets and stages](flows.md) — several graphs in one project, a family of molecules
   through the same blocks, and the barrier that waits for a whole stage.
5. [Datasets and input blocks](datasets.md) — import a family of geometries and run the graph once
   per record, with outputs for the whole set.
6. [Engines](engines.md) — choose Gaussian 16, xTB, ORCA, Psi4 or PySCF, and know which settings belong to
   which.
7. [Conformers, tautomers and protomers](conformers.md) — search or import an ensemble, enumerate
   tautomers, then choose the shape a later block runs.
8. [ML scorers](scorers.md) — the optional ranking layer, its domain guard and units.
9. [Workflows](workflow.md) — the queue, conditions, loops, checkpoint hand-off, cluster export.
10. [Results](results.md) — the results panel, gates, validity checks, methods text, run bundles.
11. [Output blocks and artifacts](outputs.md) — write CSV, JSON, HTML or a zip bundle, with a hashed
    manifest.
12. [Reports](reports.md) — the record-grouped per-flow report and the combined report across flows.
13. [Projects and runs on disk](project-files.md) — the `.ncs` file and the run folder.
14. [Appearance](appearance.md) — the three themes, what a theme may change, and the font bundle.

Reference pages:

- [DP4 and DP4+ probabilities](dp4.md) — candidate ranking from computed and measured NMR
  shifts: the parameter bank and its provenance, the three DP4+ variants, Boltzmann weighting,
  the missing-nucleus rule, and what the verification does and does not show.
- [Analyse blocks](analyse.md) — safe arithmetic over upstream results: the expression language, the
  field vocabulary, CBS extrapolation, per-record values and the refusals that name a missing field.
- [Troubleshooting](troubleshooting.md) — symptom, cause, action.
- [FAQ](faq.md) — short answers to the questions testers ask first.
- [Wavefunctions](wavefunction.md) — what a `.cube`, an `.fchk`, a `.molden`, a `.wfn` and a `.wfx`
  contain, what the app reads from them, and which analyses are still deferred.
- [Converters](converters.md) — `ncs convert`: extxyz, xyz, SDF and JCAMP-DX, and the conventions
  each one carries.
- [Spectra](spectra.md) — reading a JCAMP-DX file: `X++(Y..Y)`, `XYPOINTS`, DIF/DUP compression,
  units, and the refusals that name the section.
- [Output corpus](parser-corpus.md) — the real Gaussian logs the parser is tested against, and the
  gaps it does not cover yet.
- [Privacy and licensing](privacy-and-licensing.md) — the one outbound call (an update check you
  trigger), and what the licence does and does not grant.
- [Headless CLI](cli.md) — every `ncs` command (`validate`, `build-input`, `run`, `report`,
  `validation`, `export`, `record`, `diff`, `merge`, `convert`, `export-input`, `smiles`,
  `qcschema`, `cache`, `cube`) and its exit codes.
- [Scripting and the record schema](../SCRIPTING.md) — `run.json` as a versioned contract,
  `ncs export`, and the stdlib-only Python client.
- [Engine plugins](../ENGINE_PLUGIN.md) — the `registerEngine` spec, its refusals, and why
  the built-in five do not move.

Normative references, for people reading code or writing tooling:

- [`docs/PROJECT-FORMAT.md`](../PROJECT-FORMAT.md) — the `.ncs` document and the on-disk layout.
- [`docs/adr/0001-block-taxonomy.md`](../adr/0001-block-taxonomy.md) — the six data stages behind
  `schemaVersion: 3`.
- [`schemas/run-record.v2.schema.json`](../../schemas/run-record.v2.schema.json) — the current
  run-record contract (JSON Schema draft 2020-12); `run-record.v1.schema.json` beside it is the body
  an imported record nests, and is still what `--schema-version 1` exports.
- [`docs/CLUSTER_EXPORT.md`](../CLUSTER_EXPORT.md) — the SLURM/PBS export folder and manifest.
- [`docs/IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md) — phased plan and remaining work.
- [`docs/FEATURE-MAP.md`](../FEATURE-MAP.md) — what each engine offers, what the app implements,
  and every gap that is still open.
- [`CHANGELOG.md`](../../CHANGELOG.md) — what each release contains, and what is still unreleased.
- [`README.md`](../../README.md) — the project landing page.

## What this documentation is careful about

Three things, because a wrong claim in a chemistry tool is expensive:

- **Dry run is a fixture.** Wherever the docs say "dry run", they mean a synthetic file headed
  `FIXTURE OUTPUT`. It exercises the parser and the queue. It is never a calculation, and no number
  from it is a chemical result.
- **Unverified paths are named as unverified.** The parsers are tested against committed real output
  from Gaussian 09 and 16, ORCA 5.0 and 6.1, Psi4 1.11, and PySCF 2.15 JSON records (see
  [Output corpus](parser-corpus.md)); a
  peer run in November 2026 also drove 25 cases written by this builder through Gaussian 16 Rev A.03,
  and those logs are fixtures now. This project's own automated tests have never executed a licensed
  Gaussian job, and no engine binary ships with the app. The docs say that where it matters instead of
  implying a validated pipeline.
- **Nothing is reported that the output did not contain.** The results panel prints
  `not reported` for a missing value, and the docs describe that behaviour rather than smoothing
  over it.

## Where to report a problem

Report bugs and documentation errors through the repository's issue tracker; read
[`CONTRIBUTING.md`](../../CONTRIBUTING.md) first. Security problems go through
[`SECURITY.md`](../../SECURITY.md) instead of a public issue.

Attach the run folder, zipped:

```
%APPDATA%\nodechem-studio\runs\<runId>        Windows
~/.config/nodechem-studio/runs/<runId>        Linux
```

It contains the exact input, the raw output, `run.json` and the gate evidence — enough to reproduce
a defect without guessing. Remove anything you are not licensed to share.
