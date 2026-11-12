# Reports

NodeChem Studio writes an **HTML report** and, beside it, the **JSON model** the HTML was rendered
from. The HTML is one self-contained file: inline CSS, no scripts, no external assets and no network
request. It opens in any browser, can be attached to a draft, and can be printed by the reader if a
PDF is wanted — the app does not ship a renderer.

There are two reports:

- the **per-flow report** an `html` output block writes, and
- the **combined report** that puts several flows in one document with an index.

Both are built from the queue record and the per-run `run.json` files. A value a run did not report
is printed as `not reported`; nothing is inferred.

## The model and its digest

`ncs report` and the window's **Save workflow report…** action write the model as `<name>.json` next
to `<name>.html`, and the HTML names that model: `<html data-model-sha256="…">` and the header's
`model sha256 <digest>` are the SHA-256 of the exact JSON bytes written. A reader can therefore prove
that the HTML and the JSON belong together without trusting either file's name:

```bash
sha256sum reports/index.json
# 3f2c…  reports/index.json  — the same 64 characters the HTML prints
```

A per-flow model keeps the schema the window writes (`kind: "nodechem-studio.workflow-report"`,
`schemaVersion: 1`): absolute paths, full digests, argv/route and the parse-coverage windows live
there, never in the HTML. A combined report writes one envelope
(`kind: "nodechem-studio.project-report"`, `schemaVersion: 1`) whose `flows[]` holds one such model
per flow. Re-rendering the JSON with the same `modelDigest` reproduces the HTML byte for byte; the
digest is computed after `generatedAt` is fixed.

`ncs report --no-model` writes only the HTML, with no digest in the header and no
`data-model-sha256`; the window always writes both files.

A per-flow report written **by a workflow block** runs before the queue settles, so the queue restamps
it the moment the verdict exists: the header names the final `status` and the queue's own `finished`
time, and the manifest entry (bytes and SHA-256) is rewritten in place rather than duplicated. A
report written mid-run therefore never says `status running · finished not reported` about a run that
has finished, and `ncs report` on the same folder produces the same header because both read
`queue.json`.

## Figures

A report can carry figures, and every figure is derived from the record it describes — never a
screenshot, never an image file. The set is built by `src/shared/figures/`, the same module the
results panel draws from, so a spectrum in the app and the same spectrum in the report cannot
disagree.

| Figure | Built from |
| --- | --- |
| Flow graph | the queue's plan order and edges |
| IR, Raman, VCD, UV-Vis, ECD, NMR | the parsed columns of `run.json`, broadened at the stated FWHM |
| Orbital levels (α/β) | `parsed.orbitals.manifolds`, converted to eV at 27.2114 eV/Ha |
| Convergence | `parsed.trajectory` step energies |
| Contour slice | a `.cube` file **inside the task's run folder** (axes must be axis-aligned) |
| Projected isosurface | the same cube, meshed at 10 % of its largest \|ψ\| and drawn as flat-shaded vector polygons — a printable copy of the 3D viewport |

Each caption prints what a reader needs to judge the picture — FWHM, isovalue, grid, plane, units,
number of points — plus a short content fingerprint (`figure <hash>`). A figure whose input is
absent says so: `figure not available: no cube file in the run folder`. The whole set is capped at
5 MB; anything dropped for the cap is named in the document.

`ncs report --figures none|basic|surfaces` selects how much is drawn. `none` reproduces the
table-only document of 0.4.0; `basic` and `surfaces` both draw the slab slice when a cube is present,
and `surfaces` adds the projected isosurface.

The window offers the same three names in the select beside **Report…**. `basic` is the default; the
save action writes `<name>.html` and `<name>.json` and the HTML names the model's digest. `surfaces`
also reads the `.cube` files in each run folder and meshes them; `none` omits the figure section. The
choice is per report and is not saved in the project — there is no new settings key, so opening an
old project changes nothing.

A large report shows what it is doing in the queue header — `reading run records`, `reading cube
files`, `meshing surfaces` — with a percentage, and the window's taskbar carries the same fraction.
The save dialog is chosen first, so cancelling it reads nothing. A cube file that has not changed
since the last report (same path, modification time and size) is reused instead of parsed again;
`none` never opens a cube.

## The per-flow report

A flow that iterates over a dataset groups its tasks by record. The report has:

1. **Outcome** — task counts, the gate verdict, the task failures, and the names of any records
   that need attention.
2. **Records** — one row per dataset record: status, gates, final energy, ΔE against the first
   completed record, and the method/basis pairs used. ΔE is recomputed from the reported energies
   in kcal mol⁻¹; a record with no energy leaves the cell as `not reported`.
3. **One section per record** — the record's own task table and its failed blocks named with the
   error. A record is `completed` when every block completed, `partial` when some blocks completed
   and some failed or never ran, `failed` when every block that ran failed, and `incomplete` when
   nothing failed but some blocks never ran.
4. **The first analysis sections, unchanged from the single-molecule report** — method ladders,
   conformer ensembles, spin sweeps, reaction energetics, DP4+ probabilities, EPR and NMR, printed
   after the record sections. A section with nothing to show is omitted rather than printed empty. A
   tautomer Generate block gets a *Tautomer candidates* section: one row per candidate with its label
   and SMILES, and the energy spread across the set at the level the runs were made at. It is never
   Boltzmann-averaged — the candidates are different molecules, and the section says so instead of
   printing a population.
5. **Uncertainty** — the measured error bar, one row per method ladder, retained conformer ensemble
   and reaction path. A ladder contributes the spread across the rungs that actually ran; an
   ensemble contributes the lowest member and the Boltzmann-weighted value side by side; a reaction
   path contributes the rate factor its recorded barrier error buys through Eyring. A quantity with
   nothing measured is printed as `not measured` with the reason — never a literature average. The
   list under the table, *What would change the conclusion*, is derived from each measured number:
   the ladder's headroom against its tolerance, the population a conformer would need to dominate,
   or the rate ratio the barrier error cannot resolve.
6. **Derived quantities, Multiwfn analyses and imported results**, then **Methods**, then
   **Provenance** — run ids and the input/output SHA-256 prefixes.

A v1 project (no dataset) is unchanged: one table of blocks, no record sections.

## The combined report

`buildCombinedReportHtml(models, { title, generatedAt })` concatenates several flow models into one
document. The index at the top is deliberately not just a table of contents:

- each flow links to its section at `#flow-<id>`;
- the row states the queue status, verdict and record counts;
- **failed and partial records are named in the index row**, so a green flow verdict cannot hide a
  batch that lost molecules.

Each flow section is the same content the per-flow report renders, with headings demoted one level
so the document outline stays correct.

## From the command line

```bash
ncs report ./runs --flow barrier            # → ./runs/reports/index.html + ./runs/reports/index.json
ncs report ./runs --out ./report.html       # → ./report.html + ./report.json
ncs report ./runs --no-model                # → ./runs/reports/index.html only
```

`ncs report` reads the newest `<out-dir>/queues/*/queue.json` (per flow when several flows ran),
rebuilds the model from the run records those tasks point at, and writes the HTML plus its JSON model.
With one flow it writes the per-flow document and that flow's model; with several it writes the
combined document and a project-report envelope whose `flows[]` holds every model in the document.
The queue folder is the source of truth: no live project is needed.

It prints the HTML path (the line scripts already read) and then `model sha256 <digest>`. The digest
is the SHA-256 of the JSON file, so `sha256sum` of that file and the value in the HTML are the same
64 characters. `--no-model` omits the second line and the JSON file.

## What the report can and cannot prove

- It proves which blocks ran, which record each belonged to, what each run reported, and what the
  queue's gates decided at the time the queue finished.
- It cannot prove that the engine actually ran (a fixture is labelled `FIXTURE`), that the
  calculation is scientifically correct, or that a value absent from `run.json` was never measured.
- It is a view of the recorded evidence, not an independent audit. The run folder and its hashes are
  the evidence; the report is how a person reads it.

## Next

[Projects and runs on disk →](project-files.md)
