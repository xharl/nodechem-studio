# Troubleshooting

Symptom → cause → what to do. If a run failed, the run folder is the evidence: read `run.json`
first, then the raw output. Do not edit the parser to make a gate pass — the gate is telling you
something.

## Preflight

Preflight prints `PASS` / `FAIL` / `WARN` lines and a header: `Preflight · ready` or
`Preflight · issues found`. Hard checks decide `ok`; warnings never do.

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
| `WARN  Scratch path contains spaces` | The scratch path has a space | Use a space-free path; the runner uses yours unchanged |
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
| `truncated` badge | Output exceeded the 32 MiB capture limit | Reduce output verbosity, or run a smaller job; "Output complete" stays `unknown` |
| Queue stuck at `interrupted` | The app stopped while a task ran | **Resume**; the task is re-queued rather than assumed complete |
| `Output` task failed | The artifact path escapes the output folder, or its extension does not match the kind | Pick a project-relative path whose extension matches `html`/`csv`/`json`/`zip` |
| No imaginary modes but the job is a TS | The run did not reach a saddle | Check the geometry and the force-constant choice before re-running |

## Input and validation

| Message | Cause | Action |
| --- | --- | --- |
| `xTB cannot run "Opt=TS"` | The block's job type needs Gaussian | Change the job type, or switch the project engine |
| `xTB does not implement SMD` | A Gaussian solvation model in an xTB project | Choose `ALPB` or `GBSA` |
| `Solvent "X" has no ALPB parameter in xTB` | Solvent outside xTB's parameter set | Pick one of the five offered solvents |
| `N electrons (charge C) is incompatible with multiplicity M` | Charge/multiplicity parity | Fix charge or multiplicity |
| `ReadFC requires a checkpoint hand-off from a Freq or Opt=CalcFC block` | `ReadFC` without usable force constants | Add the checkpoint edge, or choose `CalcFC` |
| `The structure has no atoms.` | Empty or unparsed file | Check the file; Z-matrix input is refused |
| `Atom N has an unknown element symbol` | Unsupported symbol | Use a standard element symbol |
| `Atom N (X) has a non-finite or out-of-range coordinate` | Corrupt coordinate | Re-export the geometry |
| `Charge must be an integer between -10 and 10` | Out of range | Fix the charge |

## Files

| Symptom | Cause | Action |
| --- | --- | --- |
| A `.json` file will not open | The app accepts `.ncs` only | Rename to `.ncs` if it is a NodeChem project |
| "This project was saved by a newer version" | `schemaVersion` above the build's | Update the app; the reader will not guess |
| Save refused | Malformed project after edits, or a blocked validity finding | Read the reported paths; a blocking finding must be fixed before export or run |
| A run's `.chk` is missing downstream | The upstream run did not produce it, or it was empty | Re-run the upstream block; a real run fails rather than inventing a checkpoint |
| Bundle export refused | The target folder already exists and is not empty | Choose a new folder name |

## Nothing works and you need to send a report

Send `run.json`, the input file, the raw output and the exact console text. If the problem is a
queue decision, send the run's `queues/<queueId>/queue.json` as well. Do not send a screenshot of a
number without the record that produced it.

## Next

[FAQ →](faq.md)
