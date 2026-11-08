# Workflow report — specification

**Status:** proposal, not implemented. Review before PR 1.
**Trigger:** a queue reaches a terminal state (`completed`, `needs-review`, `cancelled`, `failed`).
**Deliverable:** one self-contained `report.html`, one `report.json` model, optional `report.pdf` — a reader who never saw the app can tell **what ran, what it produced, and whether the result is defensible**.

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
| `report.html` | The document a human reads or prints | Single file: inline CSS, embedded images only (`data:`), **no JavaScript**, no external references, `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">` |
| `report.json` | The model the HTML was rendered from | JSON-serialisable, schema-versioned (`reportVersion: 1`), stable key order, absolute paths allowed here only (they never reach the HTML) |
| `report.pdf` | Optional | Chromium `webContents.printToPDF` from a hidden sandboxed window loading the local HTML; header/footer templates carry page numbers (Chromium ignores `@page` margin boxes) |

- Location: `userData/reports/<queueId>/` — a report spans runs, so it does not belong inside any one run folder. `Export report…` copies the folder to a user-chosen destination.
- Size: warn at 2 MB, hard cap 8 MB. Over the cap, large per-atom tables move to `appendix.json` and the HTML says where.
- Determinism: same queue + same run records ⇒ byte-identical HTML apart from `meta.generatedAt`. Enforced by a frozen-clock snapshot test.

---

## 4. Anatomy

```
┌ page 1 ──────────────────────────────────────────────────────────────┐
│ NodeChem Studio            WORKFLOW REPORT              v0.3.0       │
│ Diels–Alder TS verification                                          │
│ 7 blocks · Gaussian 16 · 2026-11-08 03:14 → 03:52 · 38 min          │
│                                                                      │
│  VERDICT   PASSED WITH REVIEW        6 passed · 1 needs review        │
│  FINAL     −76.408 217 Eh            TS frequency · block B4          │
│            ΔE‡ 21.4 kcal/mol         electronic, no ZPE               │
│                                                                      │
│  ┌ workflow graph (static SVG, 7 nodes, state-coloured) ┐            │
│  └──────────────────────────────────────────────────────┘            │
├ page 2 ──────────────────────────────────────────────────────────────┤
│ 1 What happened      ordered table: block · type · start · dur ·     │
│                      status · gates · attempt · hand-off             │
│ 2 Final result       target block card, headline values, formula     │
│ 3 Results by block   one card per completed block (parsed values)    │
│ 4 Validity           errors / warnings / unknowns with evidence     │
│ 5 Provenance         engine, executable, argv/route, hashes,          │
│                      app version + commit, parse coverage            │
│ 6 Artifacts          files, sizes, sha256                            │
│ 7 Caveats            what is missing, what was not judged, why      │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.1 Cover

Project name, workflow id (short), terminal status, start/finished timestamps, wall-clock duration, engines used, app version and commit (`run.json#app`), block/edge counts. Banner when any run is a fixture or truncated — the banner states it applies to the whole document.

### 4.2 Verdict and final result

- **Verdict** = `gates.overall` of the target block, plus the queue's task counts by status. Wording: `passed`, `passed with review`, `failed`, `cancelled`.
- **Final result** = the target block's key numbers. Default target: the sink block (no outgoing non-loop edge). Configurable later (§13).
- Headline values are chosen by job type, not by what happens to be present: opt → final energy + convergence; freq → imaginary count + lowest mode; TS → imaginary mode + magnitude; SP → energy.

### 4.3 What happened

Ordered by `task.startedAt`, one row per task:

| Block | Type | Engine | Start | Duration | Status | Gates | Attempt | Hand-off |
|---|---|---|---|---|---|---|---|---|

`Attempt` comes from `task.attempts` (`queue.js:517`); `history` (bounded to 20 at `queue.js:748`) supplies the prior attempt rows. Hand-off shows `checkpointFrom` with the source run id. Skipped/blocked tasks state the reason from `task.reason`/`task.error` — “blocked by B3 (needs review)”, not a bare status.

### 4.4 Results by block

Reuse the results-card vocabulary (`Run`, `Program & route`, `Energy`, `Thermochemistry`, `Frequencies`, `Charges & dipole`, `Resources`, `T1`) so the report and the app never disagree about what a field means. Each card header names the block and its run id. Missing fields render `not reported` — never blank, never zero.

### 4.5 Validity

Grouped by severity: errors, warnings, unknowns, each with `id`, `message`, `evidence` and the check that produced it. Unknowns are listed explicitly — an unjudged check is a fact about the result, not a silence.

### 4.6 Provenance

Per block: engine and version line as parsed, executable path (basename + hash, full path only in `report.json`), the exact route/method block or xTB argv, input/output sha256, parse coverage windows, `provenance.kind` (`real` / `fixture`). Document level: app version + commit, report version, generation timestamp.

### 4.7 Artifacts

Every file the workflow produced, relative to the queue folder, with bytes and sha256, plus the run folder id. No absolute paths in HTML; `report.json` keeps them so a maintainer can debug.

---

## 5. Derived values — the integrity core

The report may compute differences. It may not compute them silently or from incomparable numbers.

A derived value is rendered only when **all** hold:

1. Both source blocks have `status: completed` and `gates.overall: pass`;
2. Same engine, method, basis, dispersion and solvation model (compared field by field, not by string);
3. Both parses are complete (`parsed.complete !== false`) and not fixture runs;
4. The required energy is present in both records (no `null` arithmetic);
5. Charge and multiplicity match across the compared blocks.

Otherwise the value is **omitted** and one line says why:

> ΔE‡ not reported — methods differ (B3LYP/def2-SVP vs ωB97X-D/def2-TZVP).

Rendering rules:

- Hartree → kcal/mol: `× 627.5094740631`, formula and inputs printed under the value.
- Electronic energy differences are labelled `electronic, no ZPE`; free-energy differences require thermochemistry in both records at the same T and P, and state `ΔG‡ at 298.15 K, 1 atm`.
- Display precision: 8 dp for Eh, 1 dp for cm⁻¹, 1 dp for kcal/mol. No silent truncation of significant digits.
- Numbers are formatted with `toFixed`, never `toLocaleString` — the report must not change with the OS locale.

---

## 6. Rendering

- **Pure functions only.** `reportModel(input) → model`, `reportHtml(model) → string`. No DOM, no `fs`, no `Date.now()` inside the renderer (time enters through the model).
- **Escaping.** Every interpolation passes through one `esc()` implementation extracted from `resultsView.js`. Free text from logs (error cause, termination line) is additionally length-capped (500 chars) and stripped of control characters. A block title of `<img src=x onerror=…>` renders as text; a test asserts it.
- **Style.** The report has its own fixed paper style, independent of app themes — a dark-mode user must not get a dark PDF. Serif for prose, sans for tables, mono for numbers; A4 and Letter via `@page`, 18 mm margins, `thead { display: table-header-group }`, no background fills behind text, table rules hairline.
- **Fonts.** v1 uses a system serif/sans stack so the file stays small and portable. Embedding the bundled Plex faces as base64 (+350–450 KB) is an option once the theming work lands — the report must never fetch a font.
- **No charts in v1.** The graph is static SVG generated from the queue snapshot coordinates; anything more waits for real demand.

---

## 7. Generation flow

### 7.1 Graph layout

Canvas coordinates live in the project, not the queue, and the project may have changed since the run. The report therefore lays out `queue.edges` itself:

- longest-path layering (nodes with no incoming edge at layer 0), condition/loop nodes on their own row;
- stable ordering inside a layer by `startedAt`, then `nodeId`, so two runs of the same workflow draw the same picture;
- 220 × 96 px boxes, 60 px horizontal and 90 px vertical gaps, cubic edges, arrowheads on directed edges, branch edges labelled `true`/`false`, checkpoint edges dashed.

Deterministic and independent of the canvas: the caption says the diagram is a projection of the run graph, not a screenshot of the editor. Passing the project's coordinates as a hint is a later refinement, not v1.

### 7.2 Trigger

- **On demand:** “Generate report” in the queue panel, for any finished queue.
- **On completion:** optional checkbox `Generate report when the workflow finishes` (default on for new installs), fired from the queue's terminal transition.

### 7.3 Writer

`electron/runner/workflowReport.js`:

1. Read `queue.json`; for each task with `runId`, read `run.json` from the run folder; missing record → task marked `record unavailable`, report still produced with a caveat;
2. Build the model (`src/shared/report/reportModel.js`);
3. Render HTML (`src/shared/report/reportHtml.js` + `reportCss.js`);
4. Write `report.json`, `report.html`, then `report.pdf` if requested;
5. Return paths to the renderer; the UI offers *Open* and *Show folder*, no modal.

Failure is loud and local: if rendering throws, no partial HTML is written, the queue panel shows the error, and the run records are untouched. A report never mutates run data.

---

## 8. Integrity rules (testable)

1. Every displayed value traces to `report.json`, which traces to a `run.json` field or a declared derivation.
2. `null` renders `not reported`; absent ≠ zero.
3. Gate verdicts and validity findings are copied verbatim; the report never re-evaluates.
4. Fixture and truncated provenance propagate to the cover banner and every affected card.
5. Derived values obey §5 or are omitted with a reason.
6. No JavaScript, no external URL, no `<script>`, no `javascript:` href in the output.
7. Deterministic: same inputs + frozen clock ⇒ identical bytes.
8. No absolute user paths in HTML; they exist only in `report.json`.

---

## 9. Size and performance

- Reads `run.json` only — never the raw logs — so a 200 k-line output costs the same as a 2 k-line one.
- Charge/dipole per-atom tables cap at 120 rows per scheme; beyond that, `report.json` carries all rows and the HTML renders the first 60 and the last 60 with a counted gap.
- A 50-block workflow reads ≤50 small JSON files and renders synchronously; the budget is 200 ms of CPU and no I/O beyond those reads.
- The PDF path spawns one hidden window, prints, and destroys it; it must be closed in a `finally`.

---

## 10. Tests

`test/reportModel.test.js`
- Golden model from a fixture queue: statuses, counts, verdict, target selection.
- Missing `run.json` → `record unavailable` + caveat, no throw.
- Derived ΔE‡ present when comparable; omitted with the exact reason when method, basis, dispersion, solvation, charge, multiplicity or completeness differ.
- Fixture/truncated flags propagate.
- Unknown validity findings survive.

`test/reportHtml.test.js`
- Escaping: hostile title/error strings render inert; no `<script>`; CSP meta present.
- No `http://`, `https://`, `fetch`, `XMLHttpRequest` in the output (extends the existing no-network guard).
- Print CSS present: `@page`, `table-header-group`, no theme-variable dependency.
- Snapshot: frozen clock → stable HTML hash.

`test/reportFiles.test.js`
- Writer produces `report.html` + `report.json` in a temp dir; JSON parses; `reportVersion` present.
- HTML is a single file (no relative asset references).
- Failure path writes nothing.

`test/docs.test.js` additions
- `docs/guide/report.md` exists, is linked from the guide index, and every example path resolves.

Acceptance criteria are the same list, plus a manual read-through of one real-looking 7-block fixture report on screen and printed to PDF at A4.

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
| **3** | Auto-generate on completion, `report:workflow` IPC, PDF via `printToPDF`, export action | Convenience + print |
| **4** | `docs/guide/report.md`, README screenshot, `examples/` report fixture | Public surface |

Each PR is independently shippable. PR 0 and PR 1 change no pixels; PR 2 changes no data.

---

## 12. Non-goals

- DOCX, LaTeX, Markdown output; user-supplied HTML templates.
- Sending or uploading a report anywhere (no network capability, ever).
- Re-judging results, recomputing gates, or “fixing” a failed run in prose.
- Charts, spectra plots, orbital renderings.
- Multi-workflow aggregate reports.

---

## 13. Open questions

1. **Target block:** default to the sink, or let the project pin a `report.targetNode` in settings (and show it in the inspector as “Final result”)?
2. **Auto-generate default:** on for new installs, or always on-demand until the format has proven itself?
3. **PDF by default** at completion, or only when the user asks? PDF costs a hidden window and ~1 s.
4. **Plex embedding:** keep the system stack (small, portable, slightly different on each OS) or embed the app's faces (+400 KB, pixel-stable)?
5. **Report location:** `userData/reports/<queueId>/` as specified, or inside the queue folder so `queue.json` and its report travel together?
