# Reports

NodeChem Studio writes **HTML only**. A report is one self-contained file: inline CSS, no scripts,
no external assets and no network request. It opens in any browser, can be attached to a draft, and
can be printed by the reader if a PDF is wanted — the app does not ship a renderer.

There are two reports:

- the **per-flow report** an `html` output block writes, and
- the **combined report** that puts several flows in one document with an index.

Both are built from the queue record and the per-run `run.json` files. A value a run did not report
is printed as `not reported`; nothing is inferred.

## The per-flow report

A flow that iterates over a dataset groups its tasks by record. The report has:

1. **Outcome** — task counts, the gate verdict, the task failures, and the names of any records
   that need attention.
2. **Records** — one row per dataset record: status, gates, final energy, ΔE against the first
   completed record, and the method/basis pairs used. ΔE is recomputed from the reported energies
   in kcal mol⁻¹; a record with no energy leaves the cell as `not reported`.
3. **One section per record** — the record's own task table and its failed blocks named with the
   error. A record is `completed` when every block completed, `partial` when some blocks completed
   and some failed, and `failed` when nothing usable came out.
4. **Method ladders, conformer ensembles, spin sweeps and reaction energetics** — unchanged from
   the single-molecule report, printed after the record sections.
5. **Provenance** — run ids and the input/output SHA-256 prefixes.

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
ncs report ./runs --flow barrier            # → ./runs/reports/index.html
ncs report ./runs --out ./report.html       # explicit destination
```

`ncs report` reads the newest `<out-dir>/queues/*/queue.json` (per flow when several flows ran),
rebuilds the model from the run records those tasks point at, and writes HTML. With one flow it
writes the per-flow document; with several it writes the combined document. The queue folder is the
source of truth: no live project is needed.

## What the report can and cannot prove

- It proves which blocks ran, which record each belonged to, what each run reported, and what the
  queue's gates decided at the time the queue finished.
- It cannot prove that the engine actually ran (a fixture is labelled `FIXTURE`), that the
  calculation is scientifically correct, or that a value absent from `run.json` was never measured.
- It is a view of the recorded evidence, not an independent audit. The run folder and its hashes are
  the evidence; the report is how a person reads it.

## Next

[Projects and runs on disk →](project-files.md)
