# AGENTS.md — NodeChem Studio

Rules for any coding agent working in this repository. Read this before editing.

## Product invariant

The graph is the workspace. Every change must preserve the node-first model: a full-bleed
canvas with a contextual inspector. Do not replace it with a permanent form column or a wizard.

## Hard constraints

1. **Local execution only.** No remote job submission, no SSH runner, no cloud API, no
   telemetry, no analytics, no runtime network calls. `http://127.0.0.1` for the Vite dev server
   is the only network use.
2. **Never copy, bundle, or redistribute Gaussian.** The app drives an installation the user is
   licensed to use on that machine. Do not add installers, licence files, `g16.exe`, `l1.exe`,
   or Gaussian data to the repo or a bundle.
3. **Dry run is the default.** It writes a synthetic file headed `FIXTURE OUTPUT`. Never present
   fixture data as a real calculation.
4. **Parse output, never trust the exit code.** Gaussian can exit 0 after `Error termination`.
   Gates must be derived from the parsed termination and sections; unknown is not pass.
5. **One job at a time by default.** Gaussian shared-memory parallelism is inside one process.
   Do not add concurrent local jobs without a scheduler and an explicit resource decision.
6. **Renderer has no Node.** It talks to the main process only through the `window.desktop`
   preload bridge. Do not enable `nodeIntegration` or expose `child_process`/`fs` directly.
7. **Paths are untrusted.** Generate run IDs in main; validate input/output basenames against
   `[A-Za-z0-9._-]+`; join under the run directory. Never pass a renderer string to a shell.
8. **No shell.** Spawn the Gaussian console runner (`g16.exe` on Windows, `g16` on Linux/macOS)
   with an argument array, `shell: false`, `windowsHide: true`.
9. **No secrets in the repo.** No API keys, tokens, passwords, `.env` contents, or licence
   strings. Do not print them in logs or test output.
10. **No destructive cleanup.** Do not delete worktrees, branches, run folders, or user files
    without explicit consent. Use a new run folder instead of overwriting a previous one.

## Chemistry correctness

- The input builder owns Link 0, route, title, blank line, charge/multiplicity, geometry, and
  optional Link 1. Preserve the blank-line rules; add a test for any new section.
- Checkpoint hand-offs are explicit edges. Do not infer `%OldChk` from topological order.
  `%OldChk` copies the file; also emit `Geom=Check Guess=Read` unless the route already sets
  them.
- Record the geometry source and provenance for every run. If it is unknown, say unknown.
- Do not fabricate energies, frequencies, thermochemistry, atom counts, or acceptance results.
- If a Gaussian keyword is uncertain, prefer a warning or a documented allow-list over silently
  emitting invalid syntax.

## UI rules

- Selecting a node opens its full parameter set in the inspector; the canvas stays visible.
- The wide inspector is a two-column layout, not a separate page.
- Condition/loop/merge/output/note nodes are first-class graph citizens.
- Keep the responsive breakpoints working at 1440×900, 1100×700, and 390×844.
- Use the existing CSS tokens; do not introduce a second design system.

## Testing and verification

Run, in this order:

```bash
npm test
npm run check
npm run build
```

- New behaviour needs a test. For parser/gate changes, add a synthetic fixture case that proves
  the exact failure mode.
- Do not weaken an existing test to make a change pass. If an old test asserts buggy behaviour,
  change it and explain why in the PR.
- No new dependency without a stated reason and approval. The current runtime is intentionally
  small: Electron, Vite, Vitest, concurrently, wait-on.
- Do not commit `node_modules/`, `dist/`, `.env`, run folders, or logs.
- Do not claim success from a successful spawn or a green build alone. For runner work, include
  the run folder and `run.json` evidence.
- The app runs the **Vite bundle**, not `src/` directly: after editing `src/shared/*`, run
  `npm run build` before launching the app or the previous deck is used. A fixed `constraints.js`
  still wrote the old `S 6 2` line until the bundle was rebuilt (GN-001).

## Branch and PR

- Branch from `main`: `gn/<task-id>-<slug>`.
- One task per PR. Reference the task ID in the title and body.
- Include: goal, files, test commands/results, screenshot for UI, run-folder evidence for
  runner, known limitations.
- Squash merge. Do not force-push `main`. Do not commit directly to `main`.
- If a task changes a boundary in `docs/IMPLEMENTATION_PLAN.md`, update the plan in the same PR.
- User-facing behaviour belongs in `docs/guide/`; update the page a change makes untrue in the same PR,
  and keep `test/docs.test.js` (links, index coverage, version chips, no-network scan) green.

## Platform specifics

### Windows

- The console executable is normally `C:\G16W\g16.exe`; `g16w.exe` is the GUI and must not be
  spawned.
- Set `GAUSS_EXEDIR` to the executable directory and `GAUSS_SCRDIR` to the per-run scratch
  directory. Prepend the executable directory to `PATH`.
- Cancel with `taskkill /PID <pid> /T /F`; verify no `g16.exe`/`l1.exe` remains.
- Avoid spaces in the scratch path. Warn, do not silently rewrite, if the user chooses one.
- Test on Windows before calling a runner task done. This Linux container cannot launch
  Electron (no GTK/display), so renderer checks happen in Chromium and runner checks in Vitest;
  that is not a substitute for GN-001.
- `#run-exe` shows `C:\G16W\g16.exe` as a **placeholder**, not a value: with dry run off, preflight
  fails `Gaussian executable configured — Not configured` until the path is typed, and a dry-run
  preflight (6 checks) never surfaces it. Type the path before judging a real run.

### Linux and macOS

- The console executable is `g16` inside the installation's `g16` directory, with `l1` beside it.
  `g16.exe` is the Windows build and must not be accepted on POSIX.
- Resolve a symlinked `g16` (for example `/usr/local/bin/g16`) to the real installation directory
  and set `GAUSS_EXEDIR` to that directory; prepend it to `PATH`.
- Scratch must be node-local disk. Warn about spaces on every platform and about NFS/SMB-looking
  paths on POSIX; never rewrite the path.
- Cancel with `SIGTERM`, then `SIGKILL` after a grace period.
- A Windows licence may not be used under WSL: do not present WSL as a way to run the Windows
  build. A real Linux install and licence is required, and that path is not exercised in this
  container.
