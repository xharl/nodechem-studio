# FAQ

**Is it free?**
The app is Apache 2.0. Gaussian 16 is not: it is licensed separately by Gaussian, Inc., and this
project grants no rights to it. xTB is open source (LGPL) and free to install.

**Does it need an internet connection?**
No. There is no telemetry, no cloud API and no background network activity. The single exception is
**Check for updates**, which contacts GitHub only when you ask it to; skip it and the app never opens
a connection. Everything else runs locally. See
[Privacy and licensing](privacy-and-licensing.md).

**Can I use it without any chemistry software installed?**
Yes — the dry run is a labelled fixture. It exercises the graph, the input builder, the parser and
the queue without starting a process. It is never a calculation and its numbers are not results.

**Is the dry run a calculation?**
No. It writes a synthetic file headed `FIXTURE OUTPUT` and the record is marked
`provenance.kind: "fixture"`. Anywhere the docs say "dry run", they mean that fixture.

**Can one project use Gaussian for one block and xTB for another?**
Yes. Set **Engine** on the individual block (inspector → Job → Engine); blocks left at
*Project default* follow **Project settings…** in the **⋯** menu. A GFN2-xTB pre-optimisation can
hand its parsed final geometry to a Gaussian block in the same workflow — the edge carries a
geometry, not a checkpoint.

**Which engines can receive a handed-over geometry?**
All five. A cross-engine edge reads the upstream run's parsed final geometry and rewrites the
downstream deck in place — Gaussian's molecule specification, PySCF's data line, Psi4's
`molecule { … }` block, ORCA's `* xyz … *` block, or a fresh `.xyz` frame for xTB — changing only the
atom rows. A **Prepare structure** block handing its structure to a calculate block takes the same
path. The queue task records `geometryHandoff` and the workflow report prints it; an upstream run
with no parsed geometry, or a deck with no geometry block, refuses the hand-off by name.

**Can it submit to a cluster?**
It can **export** a SLURM or PBS submission folder — one script per calculation block plus a
submit-all wrapper with `afterok` dependencies — and it can **import** the returned outputs as run
records. It never contacts the cluster itself and contains no submission primitives.

**Can it run more than one job at a time?**
Yes, if you raise **Parallel tasks**. It is 1 by default — one engine process at a time, which is the
safe default when each job already uses all the threads it was given. The field in **Run → Setup** (a
new project seeds it from **Settings → Runs**) lets a queue run up to 64 independent tasks at once;
tasks that depend on each other still run in order, and a **Join** still waits for every input. Raise
it only when the machine has the cores and memory for each job at the same time.

**Why does Preflight list an engine as SKIP?**
Because no block in the flow runs it. Preflight checks only the engines the flow actually launches,
one row each, and lists the rest as `SKIP` with the reason — so a Psi4 or ORCA workflow starts on a
machine with no Gaussian licence while Gaussian's absence stays visible instead of blocking it. A
failing row also names the block that needs that engine.

**Why is xTB missing transition states, IRC and scans?**
Because xTB cannot do them. Rather than silently downgrading `Opt=TS` to a single point, the builder
refuses the job type. Use Gaussian for saddle searches.

**Is xTB a cheap substitute for Gaussian?**
No. GFN methods are parameterised semi-empirical approximations: good for screening, conformers and
pre-optimisation, not for energies or barriers comparable to DFT or wavefunction results.

**Why does an xTB run list some validity checks as not applicable?**
Five of the twelve checks inspect Gaussian-only concepts — method/basis compatibility, spin
contamination, frontier-orbital descriptors, the excited-state root/NTO chain and counterpoise — and
xTB has no route, basis, such orbitals, excited states or counterpoise correction, so those are
reported as *not applicable*. That is a distinct state from *unknown*, and never a pass. The other
seven run for xTB too: charge/multiplicity parity, geometry sanity, imaginary modes, engine/settings,
optimisation convergence, solvation evidence and the conformer ensemble.

**Can I run G4 or CBS-QB3?**
Yes — choose the composite method as the block's **job type**, not as a method string. The app writes
the bare Gaussian keyword (`#p G4`, `#p CBS-QB3`, `#p G4MP2`) because the method expands into its own
sequence of links and takes no separate basis. The result is reported only from the method's own
final summary; if the log lacks that summary, the run is not credited with a composite energy. The
list is CBS-4M, CBS-QB3, CBS-APNO, G1, G2, G3, G4 and G4(MP2). W1, W1U and W1BD are real Gaussian
keywords but are not offered, because their summary output has not been verified here.

**Why is BSSE not subtracted from my interaction energy?**
BSSE is reported as its own number, alongside the raw and counterpoise-corrected interaction
energies. It is a basis-set incompleteness correction, not a universal error bar, and the corrected
value is the complex energy in the full fragment basis minus the monomers in that same basis. The
app keeps the terms separate so you can see what was corrected; monomer deformation is not in
Gaussian's counterpoise block and is not shown.

**Why are memory, cores and checkpoint fields missing in an xTB project?**
xTB has no equivalent. It takes `Threads` (`OMP_NUM_THREADS`) instead, and a checkpoint edge copies
`xtbrestart`. The hidden Gaussian fields are also stripped from the run payload, so they cannot leak
into an argv.

**Why is the installer unsigned?**
There is no code-signing certificate for this project. Windows SmartScreen therefore warns on first
launch; choose **More info → Run anyway** and verify the published SHA-256 if you want certainty
about the file.

**Why does Settings say "version unknown" beside an engine?**
The version column prints the version the program states about itself — `xtb version 6.8.0`,
`Version 6.1.1 - RELEASE`, Gaussian's `Rev C.01` — instead of the first line of its `--version`
output, which for xTB is a horizontal rule and for ORCA is ASCII art. When the probe ran but the
output carried no version token, the row says `version unknown` rather than showing a piece of a
banner. A row that was never probed shows no version at all.

**Does it work on macOS?**
The runner and preflight support macOS, and the app runs from source. There is no packaged macOS
build: no signing identity and no licensed macOS Gaussian installation exist to test one.

**Can I run a Windows Gaussian licence under WSL?**
No. Gaussian licences are platform-bound; a Windows licence does not authorise a Linux binary. Use a
native Linux installation with its own licence, or run the Windows build on Windows.

**Where are my runs?**
`%APPDATA%\nodechem-studio\runs\<runId>` on Windows, `~/.config/nodechem-studio/runs/<runId>` on
Linux. Each folder holds the input, the output and `run.json`. **Settings… → Advanced → Data
directory** moves the `runs/` and `queues/` folders somewhere else; it takes effect the next time the
app starts.

**What happens when I save over an existing file?**
**Save** writes back to the file the project was opened from without asking — unless the bytes on
disk changed since the app last read or wrote it, which is refused rather than overwritten. A save
dialog that lands on a file the app has not read or written this session asks before replacing it, and
the dialog opens in the folder the last save used. The name keeps exactly one `.ncs`: `foo` becomes
`foo.ncs`, and a doubled `foo.ncs.ncs` is collapsed rather than extended.

**Can I share a result?**
Yes — zip the run folder, or use **Export run bundle**, which writes the input, the output,
`methods.md`, `README.md` and a `manifest.json` with a SHA-256 per file.

**Why do some numbers say `not reported`?**
Because the parser did not find them. The app never guesses a missing value and never renders one as
zero.

**Can I animate the normal modes?**
Yes, when the output prints normal-mode displacement blocks — Gaussian does for a `Freq` job. The
viewer animates each mode, drops any mode whose block does not cover every atom, and when the output
carries no displacements at all it draws a static geometry and says so rather than inventing motion.

**What happens to my project if I uninstall?**
Nothing. Projects live wherever you saved them, and run records live in the per-user data directory.
Neither is removed by the uninstaller.

## Next

[Privacy and licensing →](privacy-and-licensing.md)
