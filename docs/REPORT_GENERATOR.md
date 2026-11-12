# Workflow report — specification

**Status:** implemented — `src/shared/workflowReport.js` builds the model and the self-contained HTML,
`ncs report` and every `reports[]` entry write it, and the PDF deliverable below was **dropped by
decision** (HTML only). Kept as the design record.
**Trigger:** a queue reaches a terminal state (`completed`, `needs-review`, `cancelled`, `failed`).
**Deliverable:** one self-contained `report.html` and one `report.json` model — a reader who never saw the app can tell **what ran, what it produced, and whether the result is defensible**.

---

## 1. What exists today (and what is missing)

The pieces are already there, per run and per block; nothing joins them into a workflow-level document.

| Exists | Where | What it gives the report |
|---|---|---|
| Per-run record | `run.json` written by `electron/runner/runManager.js:164` | engine, argv, executable, status, exit code, timings, `inputSha256`/`outputSha256`, `provenance{kind, jobType, method, input, output}`, `parsed`, `gates`, `error` |
| Parsed results | `src/shared/gaussianOutput.js` | termination, SCF, energies, frequencies (incl. imaginary), thermochemistry, charges/dipole, T1, resources, error termination, parse coverage windows |
| Gate + validity evaluation | `src/shared/validityChecks.js` (`summarizeValidity`, `runValidityChecks`) | `{overall, findings, errors, warnings, unknowns}` with evidence per finding |
| Existing results renderer | `src/renderer/resultsView.js:534` `resultsPanelHtml(record)` | a **pure** record → HTML function with escaping, `not reported` discipline, FIXTURE/TRUNCATED banners, and the card vocabulary the report should reuse |
| Methods prose | `src/shared/methodsParagraph.js:463` | deterministic publication-style text derived from `run.json` alone |
| Run bundle | `src/shared/runBundle.js` | the precedent for "a folder + manifest + hashes", no zip, `sha256sum`-verifiable |
| Queue record | `electron/runner/queue.js:408` → `queue.json` | `{id, projectName, status, createdAt, finishedAt, reason, options, edges, tasks[]}`; each task has `nodeId`, `title`, `type`, `kind`, `settings`, `attempts`, `checkpointFrom`, `runId`, `runDir`, `status`, `gateVerdict`, `summary`, `startedAt`, `finishedAt`, `error`, `history[]` |

**Two gaps this spec has to close**

1. **No workflow artifact.** Every output is per block; `queue.json` is scheduling state, not a document.
2. **Formatting logic is renderer-private.** `esc`, `hartreeText`, `formatSeconds`, `missingHtml` live inside `resultsView.js`. The report needs the same discipline in `src/shared/`, so PR 0 extracts them (§11).

One smaller gap, not a blocker: tasks already carry `title`, `type`, `kind`, `settings`, `attempts` and `checkpointFrom`, but not canvas coordinates (`nodes[].x/y` live in the project), so the report lays the DAG out itself (§7.1).

---

## 2. The three questions the report answers

1. **What happened?** — the ordered account: blocks, dependencies, retries, hand-offs, timings, failures, what was skipped and why.
2. **What came out?** — the terminal result, in numbers, with the block that produced each one named.
3. **Is it defensible?** — gates, validity findings, unknowns, missing records, fixture/truncated provenance.

Gate verdicts are **copied**, never recomputed. The report is a view over records, not a second judge.

---

## 3. Output contract

| File | Purpose | Rules |
|---|---|---|
| `report.html` | The document a human reads or prints | Single file: inline CSS and inline SVG figures, **no JavaScript**, no external references, no `<script>`, no `http(s)://`; when a model is written beside it, `<html data-model-sha256="…">` and the header meta line name the model's SHA-256 |
| `report.json` | The model the HTML was rendered from | JSON-serialisable, `schemaVersion: 1` (`WORKFLOW_REPORT_SCHEMA_VERSION`) and `kind: "nodechem-studio.workflow-report"`, absolute paths allowed here only (they never reach the HTML). A combined report writes one envelope with `kind: "nodechem-studio.project-report"` and one workflow model per flow under `flows[]`. A task row whose log was read through a window carries `partial: {bytesRead, size, windows}`; `partials` counts those rows and `recordCount` is the denominator behind the header caveat |

- Location: the desktop **Save workflow report…** action writes the file the user names (default
  `<documents>/workflow-<id>.html`) and the model beside it as `<name>.json`, and the HTML names the
  model's SHA-256. `ncs report <out-dir>` writes `<out-dir>/reports/index.html` and `index.json`
  beside it unless `--out <file>` names another path, in which case the model is `<file>.json`;
  `--no-model` writes only the HTML. The digest is the SHA-256 of the exact JSON bytes written, so
  `sha256sum <name>.json` equals both the printed digest and `data-model-sha256`.
- A PDF deliverable was dropped by decision; there is no `printToPDF` path in this build.
- Determinism: same queue + same run records ⇒ byte-identical HTML apart from the generation
  timestamp, which enters through the model. The digest is computed after `generatedAt` is set, so
  it changes only when the document does.

---

## 4. Anatomy

One scrolling HTML page, no cover sheet. Sections are emitted in a fixed order; the analysis sections
appear only when the queue carries that kind of result.

```
Workflow report — Diels–Alder TS verification
Queue q-… · status completed · created … · finished … · generated … · NodeChem Studio 0.5.1
[3 tasks ran as a labelled fixture (dry run). Fixture numbers are test data, not calculations.]
[1 of 4 records was read from a window of the log; values may be missing or stale. Partial: Block A (200000 of 5000000 bytes).]
[Figures — only at the requested level]
[Method ladder / conformer ensemble / spin sweep / DP4 / EPR / NMR / reaction energetics /
 uncertainty / derived quantity / Multiwfn / imported results — only when present]
Outcome     7 task(s): 6 passed, 1 failed, 0 skipped, 0 cancelled, 0 not run.
            Gate verdict: passed.
What ran    Block · Status · Gates · Validity · Engine · Level · E / Eh · G / Eh · Imag. · Elapsed
Methods     one collapsible paragraph per block, only when the caller supplies them
Provenance  Block · Run · Input SHA-256 · Output SHA-256
```

### 4.1 Header line

Queue id, queue status, created and finished timestamps, the generation timestamp, and the version
of the app that wrote the report (`appVersion` in the model). When a model is written beside the
HTML, the line also ends with `model sha256 <digest>`, and `<html>` carries the same value as
`data-model-sha256`. The app **commit** is not printed. A
fixture (dry-run) count note and an imported-results note follow when either applies. When any task
row's log was read through a window, a partial-parse note follows as well: how many records were read
from a window out of how many records had one, the warning that values may be missing or stale, and
the title and byte window of each affected row (for example `head + tail`). A report built only from
complete records prints no such note.

### 4.2 Outcome

One paragraph: the task total and how many passed / failed / skipped / cancelled / never ran, then
`Gate verdict: <verdict>`. A list of failed tasks follows, then a note naming records that failed or
were only partly computed. The verdict is assembled from the queue's task gate verdicts; the report
does not re-evaluate a gate.

### 4.3 What ran

One row per task: **Block · Status · Gates · Validity · Engine · Level · E / Eh · G / Eh ·
Imag. · Elapsed**. The block cell carries a `FIXTURE` label for a dry run, a `PARTIAL` badge when the
record was read through a window of its log, the
`imported, not run here` badge for an imported result, and the member id for a fanned-out run. A
value the run did not produce is printed `not reported` — never blank, never zero.

For a record-scoped queue (a dataset, series, derivative or complex block upstream) the section
becomes a per-record comparison table followed by one section per record, in plan order, each with
its own task table.

### 4.4 Analysis sections

Emitted only when the queue carries the result: method ladder (rungs, spread, verdict), conformer
ensemble at the target level (members, Boltzmann populations, spreads), spin-state sweep, DP4+,
EPR, NMR, reaction energetics, uncertainty summary, derived `analyse` quantities, Multiwfn,
imported results. Each prints its own parameters and, when it cannot compare, the reason (§5).

### 4.5 Provenance

One row per task with a run: block, run id, and a 16-character prefix of the input and output
SHA-256. The full digests, executable paths, argv/route and parse-coverage windows stay in
`report.json`. There is no separate artifacts section, and output file names and sizes are not
printed in the HTML.

---

### 4.8 Figures

The report may carry figures, and each one is a claim with its parameters attached.

| Figure | Built from | Level |
|---|---|---|
| Flow graph | `queue.json` plan order + edges | `basic` |
| IR, Raman, VCD, UV-Vis, ECD, NMR | the parsed columns of `run.json`; broadening is a stated FWHM | `basic` |
| Orbital levels (α, β) | `parsed.orbitals.manifolds`, converted to eV at 27.2114 eV/Ha | `basic` |
| Convergence | `parsed.trajectory` step energies | `basic` |
| Contour slice of a cube | a `.cube` **inside the task's run folder** | `basic` when present |
| NCI diagram | the wavefunction analysis section of the record | `basic` when present |
| Projected isosurface (ψ, or ESP-coloured when the potential is on the same mesh) | the same cube, meshed at 10 % of its largest \|ψ\| and projected from a fixed isometric angle | `surfaces` |

`src/shared/figures/index.js` also registers `spectrum:roa`, `energy` (reaction-energy diagram) and
`correlation` builders; the workflow report does not place those yet, so they are not claimed here.

Rules, enforced in code and asserted in `test/reportFigures.test.js`:

- **Derived, never captured.** A figure is recomputed from the record; a screenshot never enters the report.
- **Self-contained.** Figures are inline SVG with no `xmlns`, no `<script>`, no `href` and no URL of any kind — the document makes no network request, which the tests assert on the generated bytes.
- **Parameters in the caption.** FWHM, isovalue, grid size, plane, units and N are printed beside the picture; a spectrum without its broadening is a picture of an assumption.
- **A content fingerprint.** Every figure carries `data-hash` (FNV-1a of its own markup) so the report can show it is the figure the builder produced. It is a fingerprint, not a security digest.
- **A missing input is stated.** `figure not available: <reason>` — e.g. `no cube file in the run folder`, or `the cube axes are rotated, so an index-space slice would not be an xy plane`.
- **Budget.** 5 MB for the whole figure set by default (`figureBudgetBytes`); once it is reached, further figures are dropped in build order and the document names them.
- `ncs report --figures none|basic|surfaces` selects the level; `none` produces exactly the table-only document of 0.4.0.

## 5. Derived values — the integrity core

The report may compute differences. Each one has a stated comparability rule, and a value that fails
it is omitted with one line saying why, never printed from numbers that do not belong together.

| Derived value | Computed when | Otherwise |
|---|---|---|
| ΔE of a conformer member | exactly one run per retained member at one target level | `Not compared: …` — a second run per member or several levels would mix different calculations |
| ΔE across dataset records | against the first completed record that reported an energy | that row carries no ΔE |
| ΔG‡ of a declared reaction path | the TS and reactant blocks both reported a free energy; the correction scheme is printed beside the number | `ΔG‡ not computed: <reason>`, e.g. no declared reactant block |
| Spin-state ranking | the states share one starting geometry; the level is printed once for the set | `No state reported a final energy, so nothing is ranked`, and each missing state is named |
| Imported energy | listed always; enters an energy column only with `includeImported`, labelled | `not included` |
| `analyse` / DP4 / Multiwfn quantity | the block's own definition was valid at save time and the run produced it | the refusal is printed in full |

Rendering rules:

- Hartree → kcal/mol: `× 627.5094740631` (`HARTREE_KCAL`).
- Precision is fixed per field by the caller: 8 dp for absolute energies, 2 dp for a kcal/mol
  difference, 1 dp for a duration. There is no adaptive rounding.
- Numbers are formatted with `toFixed`, never `toLocaleString` — the report must not change with the
  OS locale.

The report does **not** run a general method/basis/dispersion equality check across blocks: two
blocks at different levels are allowed in one queue, and a derived value that spans them must come
from an `analyse` block whose definition names its inputs.

---

## 6. Rendering

- **Pure functions only.** `buildWorkflowReport(queue, records, options) → model`, `workflowReportHtml(model, { methodsFor, modelDigest }) → string`, `buildProjectReportModel(models, { title, generatedAt }) → document` and `buildCombinedReportHtml(models, { title, generatedAt, modelDigest }) → string`. No DOM, no `fs` inside the renderer (the module lives in `src/shared`); time enters through `generatedAt` in the model, and `serializeReportModel(document)` is the exact JSON text the digest is taken over.
- **Escaping.** Every interpolation passes through the module's own `escapeHtml()`. Free text from logs (error cause, termination line) is additionally length-capped and stripped of control characters. A block title of `<img src=x onerror=…>` renders as text; a test asserts it.
- **Style.** The report has its own fixed paper style, independent of app themes — a dark-mode user must not get a dark PDF-style page. One embedded screen sheet, `REPORT_STYLE`: `system-ui` sans at 13 px on white, mono with `font-variant-numeric: tabular-nums` for numbers, hairline table rules, a 1100 px measure. A second sheet, `REPORT_PRINT_STYLE`, is appended verbatim after it and applies only on paper (#356): `@page { size: A4; margin: 16mm }`; a body that drops the 1100 px measure and its margins for the sheet width; `break-inside: avoid` on rows, figures, warnings and `pre`, and `break-after: avoid` on headings; repeated column headers on a table that spans pages (`display: table-header-group`); and `print-color-adjust: exact` on the fixture/imported badges, the warning stripe and the pass/fail colours, which a browser would otherwise print as bare text. The print sheet adds no content and hides none — no rule in it is `display: none` — so the printed document is the screen document. There is still no `printToPDF` path and no margin box.
- **Fonts.** The report uses the system sans/mono stacks so the file stays small and portable; it does not embed the app's Plex faces and never fetches a font.
- **Figures, not charts.** The figures in §4.8 are inline SVG built from the record — the flow graph included. There is no charting library and no canvas.

---

## 7. Generation flow

### 7.1 Graph layout

Canvas coordinates live in the project, not the queue, and the project may have changed since the run.
The report therefore lays out `queue.edges` itself (`src/shared/figures/dag.js`):

- longest-path layering — a node's column is its longest path from a root, with a defensive pass cap
  so a malformed queue cannot hang the report;
- ordering inside a layer follows the order the tasks are supplied in;
- 116 × 30 px boxes with a 3 px status rail, 46 px horizontal and 12 px vertical gaps, orthogonal
  elbow edges with an arrowhead pointing from a block to the blocks that waited on it. Edges are not
  labelled and are not dashed; the status colour and the status text on each box carry the meaning.

Deterministic and independent of the canvas: the caption says the diagram is a projection of the run
graph, not a screenshot of the editor (`Execution graph · N blocks · counts by status`).

### 7.2 Trigger

- **On demand:** “Generate report” in the queue panel, for any finished queue.
- **On completion:** optional checkbox `Generate report when the workflow finishes` (default on for new installs), fired from the queue's terminal transition.

### 7.3 Writer

`src/shared/workflowReport.js`:

1. `buildWorkflowReport(queue, records, { generatedAt, appVersion, recordInfo, includeImported, figureLevel, volumes, surfaces, figureBudgetBytes, wavefunction })` reads the queue model and the per-task `run.json`; a task with no readable record is still listed, with its values shown as `not reported`, and the report is produced;
2. `workflowReportHtml(model, { modelDigest })` renders the document, `buildProjectReportModel(models, { title, generatedAt })` wraps a combined report's per-flow models, and `buildCombinedReportHtml(models, { title, generatedAt, modelDigest })` stacks one section per flow for a project report;
3. the figure set comes from `src/shared/report.js` — `figureInputsFor(queue, level)` returns cube volumes for `basic` and meshed isosurfaces for `surfaces` — and the builders live in `src/shared/figures/*`;
4. the desktop action writes the HTML and, beside it, `serializeReportModel(model)`; `ncs report` writes the HTML and, unless `--no-model`, the same serialisation of the per-flow model (or the project-report envelope when several flows are combined). The SHA-256 of those exact bytes is passed back into the renderer as `modelDigest` and printed by the document.

Failure is loud and local: if rendering throws, no partial HTML is written, the queue panel shows the error, and the run records are untouched. A report never mutates run data.

---

## 8. Integrity rules (testable)

1. Every displayed value traces to `report.json`, which traces to a `run.json` field or a declared derivation.
2. `null` renders `not reported`; absent ≠ zero.
3. Gate verdicts, and the validity verdict column beside them, are copied verbatim; the report never re-evaluates either. Per-finding detail is not printed — the model carries what the record carried.
4. Fixture provenance reaches the summary note and every affected row; a truncated parse is not yet flagged.
5. Derived values obey §5 or are omitted with a reason.
6. No JavaScript, no external URL, no `<script>`, no `javascript:` href in the output.
7. Deterministic: same inputs + frozen clock ⇒ identical bytes.
8. No absolute user paths in HTML; they exist only in `report.json`.

---

## 9. Size and performance

- Reads `run.json` only — never the raw logs — so a 200 k-line output costs the same as a 2 k-line one.
- Long tables are bounded and say so: a DP4+ candidate prints at most 60 nuclei in a full report (15
  in a compact panel) and states "N more nuclei are in the result object but not printed here".
- A 50-block workflow reads ≤50 small JSON files and renders synchronously.

---

## 10. Tests

`test/workflowReport.test.js`
- Model from a fixture queue: statuses, counts, verdict, target selection.
- A task with no readable `run.json` is still listed, with `not reported` values instead of an invented record; an empty or malformed queue does not throw.
- Derived ΔE‡ present when comparable; omitted with the exact reason when method, basis, dispersion, solvation, charge, multiplicity or completeness differ.
- Fixture provenance is counted and labelled on every affected row.
- Unknown validity findings survive.
- Escaping: a hostile block title renders inert; no `<script>`; no `http(s)://` anywhere in the output.
- Figure levels and the figure size budget: dropped figures are named.

`test/workflowReportRecords.test.js`
- Per-record tasks: dataset record labels, conformer members, imported results labelled and excluded from the energy columns unless `includeImported`.

`test/reportFigures.test.js`
- Spectra and orbital levels are drawn with their parameters in the caption; a figure that cannot be built is named with its reason.
- A cube volume is sliced; an isosurface is projected; a rotated cube is refused by name instead of drawn as an xy plane.
- The 5 MB budget drops figures in build order and names them, and `--figures none` switches them off.
- The generated bytes are script-free, network-free (no `href`/`src` other than `#`) and deterministic.

`test/cliImportedReport.test.js`
- `ncs report --include-imported` lists an imported result and only puts its number in the energy column when the flag is set.

`test/cliReportModel.test.js`
- `ncs report` writes the HTML and `<name>.json` beside it; the JSON parses to the model the HTML was rendered from (re-rendering it produces the same bytes), stdout carries the 64-hex digest of the file, and the digest equals `data-model-sha256` and the header line.
- `--no-model` writes no JSON, prints no digest and leaves the attribute off; `--out <file>.html` puts the model at `<file>.json`.
- A combined report writes the project-report envelope (`kind: "nodechem-studio.project-report"`, `flows[]`) and its digest is the SHA-256 of those bytes.

`test/docs.test.js` additions
- `docs/guide/report.md` exists, is linked from the guide index, and every example path resolves.

Acceptance criteria are the same list, plus a manual read-through of one real-looking 7-block fixture report on screen.

### Acceptance criteria

- [ ] A finished 7-block fixture workflow produces `report.html` + `report.json` with no manual steps.
- [ ] `report.html` opens offline with no console error, contains no `<script>`, no `http(s)://`, no absolute paths.
- [ ] Every numeric cell traces to a field in `report.json`; a missing field renders `not reported`, never `0`.
- [ ] Gate verdicts in the report equal the gate verdicts in `run.json` for every block (no recomputation).
- [ ] A fixture run stamps `FIXTURE OUTPUT` on the cover and on every affected block card.
- [ ] ΔE‡ is rendered when comparable and omitted with the exact stated reason when it is not.
- [ ] Frozen-clock rendering is byte-identical across two runs.
- [ ] Printing to PDF at A4 breaks pages between sections, repeats table headers, and keeps numbers in mono with tabular figures.

---

## 11. Rollout

| PR | Contents | Why this order |
|---|---|---|
| **0** | Extract `esc`, `missingHtml`, `hartreeText`, `formatSeconds`, `formatBytes` from `resultsView.js` into `src/shared/format.js`; results panel keeps its output byte-identical | Removes the duplicate-formatter risk before two renderers exist |
| **1** | `reportModel.js` (statuses, verdict, target selection, derived values) + `reportModel.test.js` | Data correctness without presentation |
| **2** | `reportHtml.js` + `reportCss.js` + golden snapshot; “Generate report” in the queue panel | The document people actually read |
| **3** | Auto-generate on completion, `report:workflow` IPC, export action. (PDF via `printToPDF` was dropped by decision; HTML + JSON only.) | Convenience |
| **4** | `docs/guide/report.md`, README screenshot, `examples/` report fixture | Public surface |

Each PR is independently shippable. PR 0 and PR 1 change no pixels; PR 2 changes no data.

---

## 12. Non-goals

- DOCX, LaTeX, Markdown output; user-supplied HTML templates.
- Sending or uploading a report anywhere (no network capability, ever).
- Re-judging results, recomputing gates, or “fixing” a failed run in prose.
- Interactive charts: the figures in §4.8 are static SVG. 3D orbital renderings and any charting
  library or canvas remain out of scope.
- Multi-workflow aggregate reports (a project report stacks flows; it does not merge unrelated
  projects).

---

## 13. Open questions

1. **Target block:** default to the sink, or let the project pin a `report.targetNode` in settings (and show it in the inspector as “Final result”)?
2. **Auto-generate default:** on for new installs, or always on-demand until the format has proven itself?
3. **PDF by default** at completion, or only when the user asks? PDF costs a hidden window and ~1 s.
4. **Plex embedding:** keep the system stack (small, portable, slightly different on each OS) or embed the app's faces (+400 KB, pixel-stable)?
5. **Report location:** `userData/reports/<queueId>/` as specified, or inside the queue folder so `queue.json` and its report travel together?
