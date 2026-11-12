# Plan-equivalence fixtures (issue 367)

These are the **full** `buildWorkflowPlan()` payloads for the five shipped
examples, serialized with `JSON.stringify(plan, null, 2)` from the commit before
the planner indexes were hoisted (`9075e5e`).

`test/planIndexes.test.js` rebuilds each plan and compares it deep-equal and then
byte for byte. Any change to a task id, task order, input text, gate, hash or
ordering edge shows up as a diff here; regenerate a file only when a deliberate
change to the plan is part of the PR, and say why in the body.

The compact `test/fixtures/example-plan-golden.json` stays: it covers the
schema-v3 rename, while these files pin the whole plan so a refactor that is
meant to be behaviour-neutral can be proven so.
