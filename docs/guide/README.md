# NodeChem Studio documentation

NodeChem Studio is a desktop app for building and running computational-chemistry workflows as a
graph. You place calculation blocks on a canvas, connect them, and run either the whole workflow or
a single block. Each run writes a folder you can inspect, hash and hand to someone else.

It drives three engines:

| Engine | Licence | What it is |
| --- | --- | --- |
| **Gaussian 16** | Commercial, licensed separately by Gaussian, Inc. | DFT and wavefunction calculations with explicit basis sets |
| **xTB** (GFN0/GFN1/GFN2/GFN-FF) | Open source, LGPL | Fast semi-empirical and force-field calculations |
| **ORCA** 5/6 | Free for academic use, licensed separately by FACCTs | DFT and wavefunction calculations from a simple `.inp` |

The app never bundles any engine. It drives an installation you already have.

## Reading order

If you are new, read these in order:

1. [Install](install.md) — get the app onto a machine, and learn where it keeps its files.
2. [Your first project](first-project.md) — open the seeded project, run the dry run, read the result.
3. [The canvas](canvas.md) — blocks, connections, the inspector, and what the node colours mean.
4. [Engines](engines.md) — choose Gaussian 16 or xTB, and know which settings belong to which.
4b. [Conformers and protomers](conformers.md) — search or import an ensemble, then choose the shape a
   later block runs.
5. [Workflows](workflow.md) — the queue, conditions, loops, checkpoint hand-off, cluster export.
6. [Results](results.md) — the results panel, gates, validity checks, methods text, run bundles.
7. [Output blocks and artifacts](outputs.md) — write CSV, JSON, HTML or a zip bundle, with a hashed
   manifest.
8. [Reports](reports.md) — the record-grouped per-flow report and the combined report across flows.
9. [Projects and runs on disk](project-files.md) — the `.ncs` file and the run folder.
10. [Appearance](appearance.md) — the three themes, what a theme may change, and the font bundle.

Reference pages:

- [Troubleshooting](troubleshooting.md) — symptom, cause, action.
- [FAQ](faq.md) — short answers to the questions testers ask first.
- [Wavefunctions](wavefunction.md) — what a `.cube` and an `.fchk` contain, what the app reads from
  them, and which analyses are still deferred.
- [Converters](converters.md) — `ncs convert`: extxyz, xyz, SDF and JCAMP-DX, and the conventions
  each one carries.
- [Output corpus](parser-corpus.md) — the real Gaussian logs the parser is tested against, and the
  gaps it does not cover yet.
- [Privacy and licensing](privacy-and-licensing.md) — the one outbound call (an update check you
  trigger), and what the licence does and does not grant.
- [Headless CLI](cli.md) — `ncs validate`, `ncs build-input`, `ncs run` and `ncs report`, with its
  exit codes.

Normative references, for people reading code or writing tooling:

- [`docs/PROJECT-FORMAT.md`](../PROJECT-FORMAT.md) — the `.ncs` document and the on-disk layout.
- [`docs/CLUSTER_EXPORT.md`](../CLUSTER_EXPORT.md) — the SLURM/PBS export folder and manifest.
- [`docs/IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md) — phased plan and remaining work.
- [`README.md`](../../README.md) — the project landing page.

## What this documentation is careful about

Three things, because a wrong claim in a chemistry tool is expensive:

- **Dry run is a fixture.** Wherever the docs say "dry run", they mean a synthetic file headed
  `FIXTURE OUTPUT`. It exercises the parser and the queue. It is never a calculation, and no number
  from it is a chemical result.
- **Unverified paths are named as unverified.** The parser is tested against real Gaussian 09 and
  Gaussian 16 outputs published in public repositories (see
  [Output corpus](parser-corpus.md)), but the project has never run Gaussian itself and no xTB
  binary ships with the app. The docs say so where it matters instead of implying a validated
  pipeline.
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
