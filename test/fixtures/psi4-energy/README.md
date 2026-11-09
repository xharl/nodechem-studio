# Psi4 1.11 correlated-energy fixtures

Real logs, not synthetic. They exist because issue #159 showed the MP2 branch of
`src/shared/engines/psi4.js` reading the **SCS-MP2** total as the result of an MP2 job: Psi4 1.11
prints a `DF-MP2 Energies` banner followed by a `DF-SCS-MP2 Energies` banner whose line also
contains the words `Total Energy`, so a plain last-match found the wrong method's number.

## Provenance

| Field | Value |
| --- | --- |
| Program | Psi4 1.11 (Docker image `psi4/psi4:1.11`, digest pulled 2026-11-08) |
| Host | xeyve, Linux, via `docker run --rm -v …:/w -w /w psi4/psi4:1.11 psi4 -i <deck> -o <log>` |
| Generated | 2026-11-08 |
| Molecule | water, `O 0 0 0.1173`, `H 0 ±0.757 -0.4692`, charge 0, singlet |
| Basis | def2-SVP |
| Reference | RHF, `scf_type df` |
| Calculation | `energy(...)` — MP2 (with `mp2_type df`), CCSD, CCSD(T) |

The `.dat` decks beside each log are the exact inputs; the log is the verbatim stdout, unedited.
`sha256sum` of the logs at generation:

```
56c3d32f918e6b79…  mp2.log
570ade0d1bc4108f…  ccsd.log
a52b51b56c083262…  ccsdt.log
```

## What each log contains

```
mp2.log    §238  Total Energy (SCF)   =  -75.9609364137418623 [Eh]   <- the SCF block
           §322  Total Energy           =  -76.1644174279037287 [Eh]   <- canonical MP2 (DF-MP2)
           §331  SCS Total Energy       =  -76.1606265225481280 [Eh]   <- NOT the result of an MP2 job
ccsd.log   §479  * MP2 total energy    =  -76.164558850575290
           §485  * CCSD total energy   =  -76.173908391493654
ccsdt.log  §479  * MP2 total energy    =  -76.164558850575290
           §485  * CCSD total energy   =  -76.173908391493654
           §511  * CCSD(T) total energy =  -76.176912084901602
```

These are the numbers the tests assert. They were read out of the files, not chosen to make the
code pass: the MP2/SCS pair is 3.79 mEh apart, which is why the bug was worth a fixture.

## Note on `ccsd.log`

It was produced by editing the MP2 deck, so it carries no `mp2_type df`; its MP2 summary line is the
conventional (non-density-fit) value and differs from `mp2.log` in the fifth decimal. That is
correct behaviour for two different MP2 implementations, and the test uses each log's own numbers.
