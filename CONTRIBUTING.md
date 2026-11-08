# Contributing to NodeChem Studio

Thanks for taking the time. This is a small, opinionated project; the rules below are what keeps it
honest.

## Before you start

- **Bugs and documentation errors**: open an issue.
- **Security problems**: do not open an issue. Follow [`SECURITY.md`](SECURITY.md).
- **Large features**: open an issue describing the problem first. The app has a deliberately small
  surface, and a feature that breaks the invariants below will be declined however good the code is.

## Ground rules

The product invariants are in [`AGENTS.md`](AGENTS.md); they apply to humans as much as to coding
agents. The ones that decide most reviews:

1. **Local execution only.** No remote submission, no cloud API, no telemetry. The Vite dev server on
   `127.0.0.1` is the only network use.
2. **Never bundle Gaussian.** No binaries, licence files, or Gaussian data in the repository or in a
   release artifact. The app drives an installation the user is licensed for.
3. **The dry run is a fixture.** It writes `FIXTURE OUTPUT`; nothing may present it as a calculation.
4. **Gates come from parsed output, never exit codes.** A missing value is `unknown`, never `pass`.
5. **Unknown is not pass.** Anywhere: gates, validity checks, conditions, results.
6. **The renderer has no Node.** It talks to the main process only through the preload bridge.
7. **No shell, ever.** Spawn with an argument array, `shell: false`.

## Development

```bash
npm ci
npm test            # Vitest
npm run check       # node --check on main-process and shared modules
npm run build       # Vite production renderer build
npm run dev         # Vite + Electron
```

The gate for a pull request is all three of `npm test`, `npm run check` and `npm run build` passing
on the branch. CI runs them on Linux; the Windows and Linux packaging workflows are manual or tag
triggered.

A change that touches user-facing behaviour also updates the page in [`docs/guide/`](docs/guide/) that
it makes untrue. Five things are enforced rather than remembered: every settings key returned by
`defaultSettings()` or `DEFAULT_CONFORMER_SETTINGS` must appear in
[`docs/PROJECT-FORMAT.md`](docs/PROJECT-FORMAT.md), every page in `docs/guide/` must be linked from
its index, and `test/docs.test.js` also checks links, version chips and the no-network scan. A
feature whose prose is missing fails CI like a broken test.

## What not to commit

- `.env` files, keys, tokens, licence strings.
- Gaussian binaries, `g16.exe`, `l1.exe`, licence files, or any Gaussian output you are not licensed
  to redistribute.
- Real run folders or project files containing someone else's data.
- Generated build output (`dist/`, `release/`) — both are ignored.

## Style

- Plain JavaScript, ES modules, no framework in the renderer.
- Comments explain *why* a rule exists, especially where chemistry or licensing constrains the code.
- Tests are named after the behaviour they protect, and a bug fix lands with the test that would have
  caught it.
- No drive-by reformatting in a fix PR; it makes the diff unreviewable.

## Pull requests

- One concern per pull request, with the reasoning in the description.
- Say what you verified and how. "Tests pass" is not enough for a change that touches the parser, the
  gate evaluator or the input builder: quote the output or the failing case you exercised.
- If a claim cannot be verified in this environment (a licensed Gaussian run, a Windows install), say
  so instead of implying it was tested.

## Licence

By contributing you agree that your contribution is licensed under the Apache License 2.0, the same
terms as the rest of the repository.
