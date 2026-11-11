# Troubleshooting

Symptom → cause → what to do. If a run failed, the run folder is the evidence: read `run.json`
first, then the raw output. Do not edit the parser to make a gate pass — the gate is telling you
something.

## Preflight

Preflight prints a header — `Preflight · ready` or `Preflight · issues found` — then one
`PASS` / `FAIL` / `SKIP` line per check, then any `WARN` lines. Only the engines the flow
actually runs are checked: an engine no block uses prints `SKIP  <engine> executable — Skipped —
no block in this flow runs <engine>.` A failing engine row ends with `· needed by <block>` so the
block to change is named. Hard checks decide `ok`; warnings and skips never do.

| Line | Cause | Action |
| --- | --- | --- |
| `FAIL  Gaussian executable configured — Not configured` | The executable field is empty and **Dry run** is unchecked | Browse to `g16.exe` / `g16` |
| `FAIL  Gaussian executable directory readable` | The directory cannot be read | Check permissions on the install directory |
| `FAIL  Gaussian Link 1 present` | `l1` / `l1.exe` is not in the resolved directory | Point at the real installation directory, not a copy of the binary |
| `FAIL  Windows console executable` | You selected `g16w.exe`, the GUI | Use `g16.exe` |
| `FAIL  POSIX console executable` | The file is not named `g16` | Use the installation's console binary or a symlink named `g16` |
| `FAIL  Console executable is runnable` | Missing executable bit | `chmod +x` the binary |
| `FAIL  xTB executable` | The file is not named `xtb` / `xtb.exe` | Rename or point at the real binary |
| `FAIL  xTB parameter files found` | `share/xtb` not found beside the executable | Export `XTBPATH` to the `share/xtb` directory |
| `FAIL  ORCA executable configured` / `Psi4 executable configured` / `Python or pyscf-runner executable configured` — `Not configured` | A block that runs that engine has no executable, and **Dry run** is unchecked | Set it in Settings → Engines, or browse to it |
| `FAIL  ORCA executable` / `FAIL  Psi4 executable` | The file is not named `orca` / `psi4` | Point at the driver inside the installation |
| `FAIL  PySCF importable from this interpreter` | That interpreter cannot import PySCF | Install PySCF in it, or select the `pyscf-runner` wrapper |
| `WARN  PSIDATADIR is not set in this environment` | A bare Psi4 binary cannot find its basis sets | Export `PSIDATADIR`, or use a conda launcher that sets it |
| `WARN  ORCA executable is not an absolute path` | ORCA's parallel driver has to be started by its full pathname | Record the absolute path in Settings → Engines |
| `WARN  Scratch path contains spaces` | The scratch path has a space | Use a space-free path; the runner uses yours unchanged |
| `Psi4 … WRITE failed … No space left on device` | The scratch filesystem is full | Psi4 now writes to the run's own `scratch/` folder (`PSI_SCRATCH`); a run that still fills it records `scratch.exhausted` with the folder and free space. Point the scratch directory at a larger filesystem |
| `WARN  Scratch directory is not node-local disk` | The path looks NFS/SMB-mounted | Move scratch to local disk — Gaussian I/O over a network filesystem is slow and fragile |

`GAUSS_EXEDIR is set per run` is informational: the runner overrides your shell's value so the
selected executable and Link 1 always come from the same directory.

## Running

| Symptom | Cause | Action |
| --- | --- | --- |
| `Open the Electron app to choose an executable.` | You are in the browser preview | Use the desktop app; a file picker needs it |
| Run status `needs-review` | A required gate could not be judged | Read the gate detail; the result is not a pass |
| Run status `blocked` | An upstream task failed or was cancelled | Fix the upstream cause and queue again |
| `Error termination` in the output | The engine stopped | Read the error line in the raw output. Do not retry blindly |
| `No known signature matched this failure. Read the cause line above; nothing is inferred.` | The failure text matched none of the offline signature table | Read the raw output yourself; the app explains only wordings it recognises, and never guesses a cause from prose |
| `truncated` badge | Output exceeded the 32 MiB capture limit | Reduce output verbosity, or run a smaller job; "Output complete" stays `unknown` |
| Queue stuck at `interrupted` | The app stopped while a task ran | **Resume**; the task is re-queued rather than assumed complete |
| Task status `timed out` | It reached its wall-clock limit and the engine's process tree was stopped | Raise **Task time limit** in Setup or the block's **Time limit**, then run again. `run.json` has the limit, the elapsed time and the last output line; `parsed` is `null` because a partial log is not a result |
| `Output` task failed | The artifact path escapes the output folder, or its extension does not match the kind | Pick a project-relative path whose extension matches `html`/`csv`/`json`/`zip` |
| No imaginary modes but the job is a TS | The run did not reach a saddle | Check the geometry and the force-constant choice before re-running |

## Input and validation

| Message | Cause | Action |
| --- | --- | --- |
| `xTB cannot run "Opt=TS"` | The block's job type needs Gaussian | Change the job type, or switch the project engine |
| `xTB does not implement SMD` | A Gaussian solvation model in an xTB project | Choose `ALPB` or `GBSA` |
| `Solvent "X" has no ALPB parameter in xTB` | Solvent outside xTB's parameter set | Pick one of the five offered solvents |
| `N electrons (charge C) is incompatible with multiplicity M` | Charge/multiplicity parity | Fix charge or multiplicity |
| `ReadFC reads force constants from a checkpoint, but this transition-state block has no checkpoint hand-off` | `ReadFC` with no checkpoint edge | Connect a Freq or Opt=CalcFC block as the checkpoint source, or choose `CalcFC`. When the upstream block exists but does not write force constants, the message names it and its job type instead |
| `The structure has no atoms.` | Empty or unparsed file | Check the file; Z-matrix input is refused |
| `Atom N has an unknown element symbol` | Unsupported symbol | Use a standard element symbol |
| `Atom N (X) has a non-finite or out-of-range coordinate` | Corrupt coordinate | Re-export the geometry |
| `Charge must be an integer between -10 and 10` | Out of range | Fix the charge |

## Files

| Symptom | Cause | Action |
| --- | --- | --- |
| A `.json` file will not open | The app accepts `.ncs` only | Rename to `.ncs` if it is a NodeChem project |
| `project uses schema version 4, but this build supports up to 3. Update NodeChem Studio to open it.` | `schemaVersion` above the build's | Update the app; the reader will not guess |
| `project uses schema version 2; this build reads version 3 only.` | An older project file: version 3 replaced the block vocabulary with no compatibility layer | Rebuild the project in this build; there is nothing to migrate |
| Save refused | Malformed project after edits, or a blocked validity finding | Read the reported paths; a blocking finding must be fixed before export or run |
| A run's `.chk` is missing downstream | The upstream run did not produce it, or it was empty | Re-run the upstream block; a real run fails rather than inventing a checkpoint |
| Bundle export refused | The target folder already exists and is not empty | Choose a new folder name |

## Nothing works and you need to send a report

Send `run.json`, the input file, the raw output and the exact console text. If the problem is a
queue decision, send the run's `queues/<queueId>/queue.json` as well. Do not send a screenshot of a
number without the record that produced it.

**⋯ → Save diagnostics…** writes that bundle as one markdown file (schema
`nodechem-diagnostics/1`): version, commit, platform, the engines this build registers and the last
ten run records, with no coordinates and no output text. Your home directory becomes `~`, the app
data directory `<userData>`, every other path `<path>/basename`, and anything shaped like a
credential `<redacted>` — read it before you attach it if you want to check that for yourself.

## Next

[FAQ →](faq.md)
