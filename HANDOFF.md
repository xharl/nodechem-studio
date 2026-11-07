# Handoff — Gaussian Node Studio v0.1

**For:** the Hermes instance on Will's Windows machine (`will`, `http://192.168.0.16:8642`)
**From:** the Hermes instance on the AI stack (`aistack`)
**Owner:** Xavier. Will is the licensed Gaussian user and the acceptance tester.
**Bundle:** `gaussian-node-studio-v0.1.0.tar.gz` + `.sha256`
**Status:** v0.1 local runner slice; dry run verified in Chromium and Vitest, **not yet on
Windows**.

Read `README.md`, `AGENTS.md`, and `docs/IMPLEMENTATION_PLAN.md` before changing code. This
file is the first-day runbook.

## 1. What this is

A new Electron app that makes a Gaussian 16 workflow a node graph. The graph is the workspace;
the inspector exposes the full job parameter set without leaving the canvas. The app runs
locally on Will's licensed Windows PC. There is no remote execution and no cloud dependency.

**Not in v0.1:** automatic DAG execution, condition/loop runtime, native structure import,
installer. One selected calculation runs at a time. The runner uses a demo water geometry and
labels it as such.

## 2. Safety before anything else

- Do not copy Gaussian, licence files, `g16.exe`, `l1.exe`, or Gaussian data into this repo or
  any bundle. Use the existing installation on Will's PC.
- Confirm with Will that the licence permits this use and, if relevant, other users. Record the
  answer in the project notes; do not guess.
- Dry run is the default and needs no Gaussian executable. Use it first.
- Do not run a real job on a shared machine while someone else is using it without permission.
- Do not expose the Hermes API key, `.env`, or Will's licence details in a message, screenshot,
  commit, or bundle.
- A real run can take minutes to hours. Start with a tiny job and watch it.

## 3. Setup (Windows 10/11)

1. Install Node.js 22+ (LTS is fine) and Git if not present.
2. Unpack the bundle to a short path, for example:

   ```powershell
   mkdir C:\Users\Will\Projects
   tar -xzf gaussian-node-studio-v0.1.0.tar.gz -C C:\Users\Will\Projects
   cd C:\Users\Will\Projects\gaussian-node-studio-v0.1.0
   ```

   If `tar` is unavailable, use 7-Zip on the `.zip`.
3. Verify the checksum (PowerShell):

   ```powershell
   Get-FileHash .\gaussian-node-studio-v0.1.0.tar.gz -Algorithm SHA256
   Get-Content .\gaussian-node-studio-v0.1.0.tar.gz.sha256
   ```

4. Install dependencies and run the suite:

   ```powershell
   npm install
   npm test
   npm run check
   npm run build
   ```

   `npm install` downloads Electron and Vite from npm. It does **not** download Gaussian.

5. Start the app:

   ```powershell
   npm run dev
   ```

   If Electron fails to launch, `npm start` runs against the built `dist/`. Report the exact
   error; do not silence it with `--no-sandbox` in committed code.

## 4. First verification — dry run (no licence needed)

1. The app opens the seeded Diels–Alder project.
2. Click **Run** in the top bar.
3. Leave **Dry run (fixture output)** checked.
4. Select **Reactant frequency** (`r-freq`) on the canvas.
5. Click **Run selected block**.
6. Confirm:
   - run state becomes `completed`;
   - gates show `SCF record · pass`, `Frequency record · pass`, `Imaginary mode count · pass` (0 expected);
   - output begins with `FIXTURE OUTPUT` and says it is not a Gaussian calculation;
   - a run folder exists under Electron's `userData/runs/`.
7. Repeat with **TS frequency** (`ts-freq`, 1 imaginary mode expected). It should also pass.
8. Capture a screenshot of the run console and the run folder path.

This proves the renderer, IPC, run manager, fixture, parser, gates, and run-record path. It does
**not** prove Gaussian execution.

## 5. First real run — small and licensed

Only after Will confirms the licence and is present:

1. Open **Run**.
2. Uncheck **Dry run**.
3. **Browse** to the console executable, normally `C:\G16W\g16.exe`. `g16w.exe` is the GUI;
   do not select it.
4. Set **Scratch directory** to a path without spaces, for example `C:\G16W\SCRATCH`.
5. Click **Preflight**. Everything must be PASS. If `l1.exe` is missing or the path is wrong,
   stop and report; do not guess another install.
6. Select a small calculation node. The current UI uses demo water for all nodes, so choose
   something deliberately small (for example a `Freq` at a modest method/basis) and confirm
   with Will that the route is acceptable.
7. Click **Run selected block**. Watch the output stream.
8. After completion, open the run folder and check:
   - `run.json` status;
   - parsed termination `Normal termination of Gaussian`;
   - gates and their evidence;
   - the actual output filename (`.out` or `.log`);
   - no leftover `g16.exe`/`l1.exe` process.
9. If termination is `Error termination`, report the exact Gaussian error line and stop. Do not
   retry blindly or edit the parser to make it pass.

**GN-001 is complete only when the dry run and one small real run are both evidenced.** If the
licence or machine is not ready, complete the dry run, report the blocker, and keep GN-001 open.

## 6. What to work on next

The task queue is in `docs/IMPLEMENTATION_PLAN.md`. **GN-002 through GN-008 are implemented on
`main`**, and the issue #8 UI/state/accessibility audit is closed. What remains is **GN-001 — the
Windows smoke test on a licensed machine**. The **Windows package** GitHub Actions workflow
(manual dispatch or `v*` tag) builds and uploads an unsigned NSIS installer; it has succeeded on
`main` (latest artifact ~114 MB). Everything in the queue, control-flow, checkpoint and import
paths has only been exercised against a fake runner and fixture outputs so far, so the first real
run is also the first test of those paths.

Rules:

- One task per branch: `gn/<task>` for roadmap work, `fix/<topic>` for defects.
- One PR per task; include tests and evidence.
- Do not add remote execution, telemetry, or a second UI paradigm.
- Do not change the parser to make a failing gate pass.
- Keep dry run the default.

## 7. Sending work back

Preferred, in order:

1. Push a branch to the shared GitHub repository and open a PR with the task ID.
2. If the network/repo is unavailable, create a git bundle:

   ```powershell
   git bundle create gn-002.bundle main..gn/gn-002-project-schema
   ```

   and send the bundle plus `git diff main...gn/gn-002-project-schema` through the exchange.
3. Do not send `node_modules`, `dist`, run folders, full Gaussian logs, or licence data.

Include in the report:

- branch/commit and files changed;
- `npm test`, `npm run check`, `npm run build` output;
- screenshot for UI, run-folder path + `run.json` summary for runner work;
- any decision that needs Xavier (licence, chemistry semantics, dependency).

## 8. Peer network

The host has registered the peer endpoint:

```text
will  http://192.168.0.16:8642  [NO KEY]
```

The endpoint responds, but it needs the matching `API_SERVER_KEY` before authenticated
messaging. Xavier or Will must exchange it out of band, then on the host run:

```bash
hermes peer add will --url http://192.168.0.16:8642 --key <key>
hermes peer list   # must show [key set]
```

Do not paste the key into chat, a commit, a screenshot, or this bundle. Until the key is set,
use the shared folder / bundle path. Do not broadcast to other peers.

## 9. Known limitations to report honestly

- Renderer verified in Chromium at 1440×900, 1366×768, 1100×700 and 390×844; Electron could
  not launch in the Linux build container (no GTK/display). Windows launch is unverified until
  GN-001 runs.
- Output discovery handles `<input>.out` and `<input>.log` and records which file was parsed
  (GN-007).
- Project files are schema v1 and validated before render; v0.1 files migrate on open (GN-002).
- Conditions and loops execute in the queue; `merge any` still waits for all inputs, and output
  bundles stop with a recorded reason (GN-005).
- Structure import supports .xyz/.mol/.sdf/.gjf/.com; the canvas demo graph is Diels–Alder but
  the project geometry is demo water until a structure is imported (GN-006).
- Packaging: electron-builder NSIS config plus a Windows CI workflow; no clean-VM install yet
  (GN-008).

## 10. Bundle manifest

The archive contains only source, tests, docs, and configuration. It excludes `node_modules`,
`dist`, `.git`, run folders, logs, and secrets. `BUNDLE-MANIFEST.txt` lists the SHA-256 of every
included file. The outer `.sha256` covers the archive.

If the manifest or checksum does not match, stop and request a fresh bundle.
