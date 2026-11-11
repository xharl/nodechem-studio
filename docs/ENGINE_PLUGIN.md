# Engine plugins

The engine layer is a seam, not a switch statement. `src/shared/engines/registry.js`
exposes `registerEngine(spec)`: a host hands it a descriptor and receives a
frozen engine object shaped like the static five, without editing
`src/shared/engines/index.js` or rebuilding the app.

The five shipped engines — Gaussian 16, xTB, ORCA, Psi4 and PySCF — remain in
the static registry and keep working exactly as before. The seam is additive: it
is how a new engine is described, not a replacement for the built-ins.

## The spec

```js
import { registerEngine } from './src/shared/engines/registry.js';

const engine = registerEngine({
  id: 'mopac',
  label: 'MOPAC',
  extensions: { input: '.mop', output: '.out' },
  buildArgv: ({ inputName }) => [inputName],
  parseOutput: (text) => ({ canonicalVersion: 1, engine: 'mopac', lineCount: text.split('\n').length }),
  gates: (parsed) => ({
    overall: parsed.lineCount > 0 ? 'pass' : 'unknown',
    gates: [{ name: 'Output complete', required: true, result: parsed.lineCount > 0 ? 'pass' : 'unknown', detail: null }],
  }),
});
```

| Key | Required | Type | Contract |
| --- | --- | --- | --- |
| `id` | yes | string | Lowercase slug (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`), unique across static and plugin engines. A static id cannot be shadowed. |
| `extensions` | yes | object | `{ input, output }`, each a dot-prefixed extension matching `^\.[A-Za-z0-9]+$` such as `.mop` / `.out`. Used to accept safe basenames. |
| `buildArgv` | yes | function | `({ inputName, outputName, settings, molecule }) => string[]`. Called by the host to build the process argv; the returned array is checked, and a non-array or a non-string member is refused. |
| `parseOutput` | yes | function | `(text, options) => object`, the canonical result (see `src/shared/engines/canonical.js`). Missing values are `null`, never zero. |
| `gates` | yes | function | `(parsed, options) => { overall, gates: [{ name, required, result, detail }] }`. `overall` is `pass`, `fail` or `unknown`; a gate result may also be `skipped`, which is not a pass. |
| `label` | no | string | Display name; defaults to `id`. |
| `capabilities` | no | object | Extra provenance; `id`, `label`, `inputExtension` and `outputExtension` are filled in. |
| `detect` | no | function | `(settings) => boolean`. Defaults to `() => false`; the seam does not guess which block belongs to which engine. |
| `toCanonical` | no | function | `(parsed) => canonical`. Defaults to identity, for a parser that already returns the canonical shape. |

The descriptor contract itself is versioned: `ENGINE_SPEC_VERSION` is `1`, and every
registered engine carries it as `specVersion`.

## Refusals

`registerEngine` validates the whole spec **before** touching the registry. An
incomplete spec throws `EngineSpecError` (code `engine-spec-invalid`) whose
message names the key, and whose `missing` array lists the absent ones:

```text
Engine spec "mopac" is invalid: missing "gates" (a function).
```

A refused registration leaves the registry untouched: there is no half-registered
engine that fails later inside a run. `validateEngineSpec(spec)` returns
`{ ok, problems, missing }` without registering, for a host that wants to show a
form error.

## What registration returns

A frozen object with the runner-facing shape:

| Member | Meaning |
| --- | --- |
| `id`, `label`, `plugin`, `specVersion` | Identity; `plugin: true` marks a seam engine. |
| `capabilities` | `id`, `label`, `inputExtension`, `outputExtension` plus your fields. |
| `acceptsInputName(name)`, `acceptsOutputName(name)` | Safe basename check for the declared extensions. |
| `buildArgv(context)` | Your builder, with its return value checked. |
| `parseOutput(text, options)`, `parse` | Your parser, under both names the runner uses. |
| `gates(parsed, options)` | Your gate builder. |
| `detect(settings)`, `toCanonical(parsed)` | Your hooks, or the safe defaults. |

`engineIds()`, `listEngines()` and `resolveEngine(id)` see the static engines
first and then the plugins; `pluginEngine(id)` and `pluginEngineIds()` see only
the seam, in registration order. `unregisterEngine(id)` removes a plugin; it
returns `false` for a static id, which cannot be removed. Registering an id that
is already taken throws `EngineSpecError` as well, with a `duplicate` problem on
`id`.

## A parser should return the canonical record

Gates and condition fields only ever read the canonical shape documented in
`src/shared/engines/canonical.js`: `canonicalVersion`, `engine`, `program`,
`status`, `terminationCode`, `termination`, `complete`, `scf`, `optimization`,
`frequencies`, `thermochemistry`, `finalEnergy`, `extras`, `lineCount`, plus the
optional sections an engine may supply (`sapt`, `solvation`, `excitedStates`,
`raman`, `vcd`, `epr`, `chargeTransfer`, `dlpno`). If your program's parser has its own
vocabulary, write `toCanonical(parsed)` and keep `parseOutput` in that
vocabulary — every consumer downstream reads only the canonical form.

## Limits

- **No sandbox.** A plugin is JavaScript the host imported, with the host's
  privileges. The seam validates shape, not behaviour; do not load a plugin you
  would not run directly.
- **No user-directory auto-loader in this build.** `registerEngine` is the
  contract; a host is responsible for importing the module (from a test, a CLI
  runner, or a future extension directory) and calling it. There is no
  `plugins/` folder that the Electron app scans today.
- **The desktop queue still resolves the built-in engines through
  `index.js`.** A plugin is visible to a host that asks the registry; wiring it
  into the engine picker and the queue is the next step, not something this
  seam claims to have done.
- Plugin engines cannot shadow a built-in id, by design: a project that says
  `engine: "gaussian"` must keep meaning Gaussian 16.

## Next

[Scripting against NodeChem Studio →](SCRIPTING.md)
