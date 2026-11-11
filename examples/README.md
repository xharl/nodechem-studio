# Example projects

Five `.ncs` files: one per built-in workflow template, plus a reproduction of a
published protocol. They are ordinary schema-v3 projects: open one with
**⋯ → Open project…**, or double-click the file once the desktop build is
associated with `.ncs`.

| File | Template | Blocks |
| --- | --- | --- |
| [`opt-freq.ncs`](opt-freq.ncs) | Reactant optimization + frequency | 2 |
| [`ts-search.ncs`](ts-search.ncs) | Transition-state search | 4 |
| [`apn-fluorescence.ncs`](apn-fluorescence.ncs) | Reproduction of a published TD-DFT solvatochromism protocol ([notes](../docs/reproductions/molecules-29-01808.md)) | 8 |
| [`emission.ncs`](emission.ncs) | Emission from S1 (Opt then TD) | 3 |
| [`single-point.ncs`](single-point.ncs) | Single-point energy + NBO charges | 1 |

The transition-state example also carries a note block explaining the
`Opt=TS`/`CalcFC` route, so its block count is one higher than its three
calculation steps.

The four recipe files are generated from `src/shared/templates.js` with
`stringifyProject(templateProject(id))`, which is why they are canonical JSON and
byte-stable; `apn-fluorescence.ncs` is a hand-written reproduction, not a recipe.
They exist so the templates can be read, diffed and tested outside the app; the
template chooser (**New project**) does not read them from disk. `test/examplePlanIdentity.test.js`
parses all five and asserts that each still produces the task ids, input hashes and
edges recorded in `test/fixtures/example-plan-golden.json`.

Opening an example and saving it writes a new file through the normal save
path. To get back to the untouched recipe, start it again from **New project**.
