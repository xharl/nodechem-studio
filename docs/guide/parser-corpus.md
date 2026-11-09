# Output corpus: what the parser is tested against

The Gaussian parser reads text a program wrote years apart, on machines with
different revisions. Testing it only against hand-written fixtures tests the
fixtures. This page records the real logs committed under
`test/fixtures/real/` and, just as importantly, what is still not covered.

Every file was produced by Gaussian and published in a public repository; the
project did not run Gaussian itself. Provenance per file is in
`test/fixtures/real/README.md`. Numbers are asserted in
`test/realCorpus.test.js` — a parser change that moves one is a regression.

## Covered

| Revision | Job | File | What is asserted |
| --- | --- | --- | --- |
| G09 D.01 | `Opt` that ran out of steps | `g09-dvb-gopt-unconverged.log` | `error` status, no convergence, cause is the step report (not Gaussian's epigraph) |
| G09 | `Freq` | `g09-dvb-ir.out` | energy, zero imaginary modes, Gibbs correction |
| G09 | `SP` | `g09-dvb-sp.out` | energy; no thermochemistry invented |
| G09 | `TD` | `g09-dvb-td.out` | five excited states with oscillator strengths |
| G09 | MP2, CCSD, CIS | `g09-water-*.log` | post-HF energy, CIS excited-state table |
| G16 | `Opt` | `g16-dvb-gopt.out` | convergence, stationary point, final energy |
| G16 | `Freq` | `g16-dvb-ir.out` | imaginary count, Gibbs correction, gates pass |
| G16 | `SP`, `TD` | `g16-dvb-*.out` | energy, five excited states |
| G16 | `IRC` (LQA, both directions) | `g16-h4s2-irc.log` | path summary, 19 points, reference energy |
| G16 | SCF failure | `g16-meoh-scf-error.log` | `error` status and the sentence naming the failure |
| — | truncated file | `g16-dvb-ir-truncated.out` | `incomplete`, never a pass |
| G09/G16 | relaxed and rigid scans | `scan-relaxed.log`, `scan-unrelaxed.log` | parameter table, extremum |

## Not covered

The corpus is honest about its gaps; a missing row here is a known blind spot,
not a claim that the parser handles the case:

- `Opt=TS` and a `Freq` with exactly one imaginary mode (a true saddle).
- `--Link1--` multi-step jobs produced by Gaussian itself.
- NMR shielding and Raman activities (the parser reads neither).
- Solvation models printing extra sections, and `PCM`/`SMD` output.
- Gaussian 03 and 98 revisions, and any Windows-formatted output.
- Files larger than the 32 MiB parse limit; completeness is covered by the
  synthetic truncation test instead.

Adding a case is cheap: drop the log in a `test/fixtures/real/<engine>-<version>-<molecule>-<job>/`
folder with a `PROVENANCE.md` beside it, add its row to this table and its numbers to
`test/realCorpus.test.js`.

## One captured log per parser branch (issue 176)

The rule is mechanical, not a habit. Each parser exports the list of branches it can take —
`PSI4_PARSE_BRANCHES`, `GAUSSIAN_PARSE_BRANCHES`, `XTB_PARSE_BRANCHES`, `ORCA_PARSE_BRANCHES` — and
every entry names the printed line the branch keys on, the releases that print it, and a `taken()`
predicate that reads the field the parse itself resolved. `test/fixtureCoverage.test.js` parses every
log in this corpus and fails when a declared branch is reached by none of them, printing a
branch → fixture table so the gap is visible in the run output.

Two fixtures are worth naming because they are the ones the old suite could not have caught:

| Fixture | Why |
| --- | --- |
| `psi4-1.11-water-mp2/mp2.log` | Psi4 1.11 prints `DF-MP2 Energies` and then `DF-SCS-MP2 Energies`; both rows say `Total Energy`, 3.8 mEh apart. The `mp2` branch must take the first. `scs-mp2-only` is the refusal branch for a log that only has the second. |
| `psi4-1.11-water-scf/scf-head-trimmed.out` | a real 1.11 run cut right after `@DF-RHF Final Energy:`; the only way the `scf-final` fallback is reached in the wild. |

Three branches are declared `blocked:` in their parsers — an ORCA optimisation log (no ORCA licence
here; cclib's is 514 kB), a Gaussian composite-method log and a Gaussian `Counterpoise` log (no
Gaussian licence here, and none in the public corpora used) — and one is `derived:` (the SCS-only
refusal, built by mangling the MP2 log inside the test). They print as named GAPs; none is a pass.

`XTB_SUPPORTED_VERSIONS`, `PSI4_SUPPORTED_VERSIONS`, `GAUSSIAN_SUPPORTED_VERSIONS` and
`ORCA_SUPPORTED_VERSIONS` sit next to the regexes they describe. The coverage test refuses a folder
fixture whose `PROVENANCE.md` names a release missing from that list, so a new engine release has to
be read rather than discovered from a wrong number.

Back to the documentation index.
