# DP4 and DP4+ probabilities

DP4+ answers a question a single calculation cannot: *given these candidate structures and one
set of measured shifts, which structure do the numbers favour, and by how much?* The answer is a
probability per candidate, not a verdict about the molecule — it is the probability that the
candidate's computed shifts and the measured shifts came from the same distribution.

**What this page is careful about, first.** The app computes **DP4+**, and it reports which of the
three DP4+ variants produced the number:

| `variant` | Uses | Shown as |
| --- | --- | --- |
| `uns` | unscaled shifts only, split into C/H × sp²/sp³ | *DP4+ unscaled (not classic DP4)* |
| `sca` | scaled shifts only, one fit per element | *DP4+ scaled* |
| `full` (default) | both halves multiplied | *DP4+ full (unscaled × scaled)* |

Classic DP4 (Smith & Goodman, *JACS* 2010) is **not** implemented. Its parameters are a different
t-fit, the bank this app ships does not carry them, and a DP4+ number is never relabelled as DP4:
asking for `variant: 'dp4'` is refused by name. The same rule applies to levels: the bank carries
24 DP4+ levels (12 functional/basis pairs, each in gas phase and in PCM), and a level that is not
in those 24 is refused (`level-not-in-bank`) instead of being approximated with another level's
numbers.

## Where the parameters come from

The error fits are data, not arithmetic. They are transcribed from the MIT-licensed reference
implementation of DP4+ (`dp4plus_app` 2.2.3, `RosarioCCLab/DP4plus-App`) into
`src/shared/data/dp4plus-qm.json`, which records the package name, version, licence, the SHA-256 of
the source archive and of the workbook the numbers were read from. `src/shared/data/PROVENANCE.md`
has the full chain, including what was **not** transcribed (the MM, xTB and Custom banks — separate
modes of the reference application that this app does not exercise).

Each level carries six Student-t fits — `Csp2`, `Csp3`, `Hsp2`, `Hsp3`, `Csca`, `Hsca` — as
`(df, mean, scale)`, plus the standard table (σ(TMS) for C and H) for each solvent the level was
parameterised in. Nothing is interpolated between levels and nothing is defaulted: a level needs
its solvation model stated, and a PCM level needs its solvent, because σ(TMS) is a property of the
solvent.

## What the calculation does

1. **Boltzmann weighting.** Each candidate is an ensemble of conformers. If the conformer block
   stored populations, those are used exactly as recorded at the temperature you pass; otherwise
   the weights are computed from the conformer energies at that temperature. The card prints which
   of the two happened, the temperature, and the member count. A block whose populations do not sum
   to one is refused rather than re-normalised.
2. **Assignment.** Each measured shift is mapped to one or more atoms. Several atoms on one row are
   averaged — that is how a methyl's three protons, or a symmetry-equivalent pair, are handled.
   Equivalent atoms are listed once each; an atom assigned to two rows is refused.
3. **Unscaled shift.** δ = σ_standard − σ_calculated, per nucleus.
4. **Scaled shift.** For each candidate, δ is fitted against the measured shift — one fit for
   carbon, one for hydrogen, as the reference does — and corrected by that fit. A fit with fewer
   than two points, or a flat one, keeps the unscaled shift and the card says so.
5. **Per-nucleus probability.** `P(|T| ≥ |(error − mean) / scale|)` for a Student t with the class's
   degrees of freedom. A nucleus with zero error scores 0.5 — the maximum for one nucleus.
6. **Product and normalisation.** The per-nucleus probabilities multiply into an absolute
   probability per candidate, and the absolute probabilities normalise across candidates. The
   product is summed in log space so twenty-odd small probabilities do not underflow to zero.

Diastereotopic pairs (two measured rows sharing an `exchange` label) are ordered so that the larger
measured shift takes the smaller computed shielding, exactly as the reference's `diasterotopic`
step does.

A measured list with only protons, or only carbons, is allowed: the candidates are then scored on
that one element (the empty product for the other element is 1, which is how the reference's
per-element product behaves), and the card prints `0` for the element that took no part, so the
reader can see it.

## Missing atoms: the documented rule

If a measured nucleus has no computed partner in one candidate — an atom index the shieldings do
not contain — that **candidate is excluded** from the comparison and named with the atom and the
row in the result (`excluded[]`), never scored on fewer nuclei than its rivals. Dropping the
nucleus instead would compare each candidate against a different experiment. If fewer than two
candidates remain, the whole calculation is refused
(`fewer-than-two-scorable-candidates`) rather than reporting a one-candidate "probability".

## Reading the card

The DP4+ card and the workflow report print, for one analysis:

- the level and its standard, the variant, the temperature, and the bank the parameters came from;
- the probability table: per candidate, conformer count, weight source, `p uns`, `p sca`, `p full`,
  and how many nuclei were scored;
- the experimental list (count, C/H split, how many were marked sp²) and the standard shielding;
- the error distribution — the six fits, with the number of nuclei that went through each;
- per-nucleus deviations: measured, unscaled, error, scaled, error, and both probabilities;
- the excluded candidates and why;
- a note that the number is DP4+, not classic DP4, with the citation and the workbook hash.

A candidate whose probability is printed as `0.00` is not absent: it is below the printed
precision, and the unnormalised `p uns` / `p sca` columns show where it actually stands.

## Verification, stated plainly

The reference package publishes no numeric result table for its example study, and its manual
calls that study synthetic. So the test in `test/dp4.test.js` reproduces the **reference
procedure**, not a published table: the shipped `example_nmr_only` study (2 candidates, 40
conformers, 27 shifts at mPW1PW91/6-31+G(d,p) PCM/CHCl3) is run through this module and through an
independent transcription of `dp4_module.py` + `correlation_module.py`, and the percentages agree to
better than 0.001 percentage points (the issue asks for 0.1). The manual states that isomer 01 is
the correct structure, and isomer 01 wins in all three variants. Three further checks are labelled
as consistency checks rather than as a reproduction: the probabilities sum to one, a candidate with
zero error dominates, and a deliberately corrupted candidate loses.

The card never claims more than that: it prints the bank and the level beside the number, so a
reader can see exactly which table produced it.

## Citation

Grimblat, N.; Zanardi, M. M.; Sarotti, A. M. *Beyond DP4: An Improved Probability for the
Stereochemical Assignment of Isomeric Compounds using Quantum Chemical Calculations of NMR
Shifts.* J. Org. Chem. **2015**, 80 (24), 12526–12534. doi:10.1021/acs.joc.5b02396

## Next

- [Spectra](spectra.md) — the measured traces and simulated spectra this comparison reads from.
- [Conformers and protomers](conformers.md) — where the ensemble and its populations come from.
- [Results](results.md) — the panel the DP4+ card appears in.

Back to the documentation index.
