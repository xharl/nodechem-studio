# Psi4 1.11 TD-DFT fixtures (ethylene, B3LYP/6-31G\*)

Two real runs of the **same job**, differing only in how the excited states were requested. They exist
because that difference turned out to matter more than the numbers: Psi4 splits a state request across
the point group's irreducible representations, and a request smaller than the irrep count can return a
table with no bright state in it (issue 166).

## Provenance

| Field | Value |
| --- | --- |
| Program | Psi4 1.11, Docker image `psi4/psi4:1.11` |
| Generated | 2026-11-08, on xeyve, via `docker run --rm -v …:/w -w /w psi4/psi4:1.11 psi4 -i <deck> -o <log>` |
| Molecule | ethylene, C₂H₄, `C 0 0 ±0.6695`, `H 0 ±0.9289 ±1.2321` (Å), charge 0, singlet |
| Method | B3LYP / 6-31G\* (`6-31g*` → `6-31G*`), `scf_type df`, reference RHF |
| Job | TD-DFT (`set tdscf_states …`, `energy('td-b3lyp')`) |

| File | Deck | What it is |
| --- | --- | --- |
| `ethylene-b3lyp-631gd-5states.log` | `…-5states.dat` | `set tdscf_states 5` — the scalar request |
| `ethylene-b3lyp-631gd-16states.log` | `…-16states.dat` | `set tdscf_states [2, 2, 2, 2, 2, 2, 2, 2]` — two per irrep |

The `.dat` decks are the exact inputs; the logs are verbatim stdout. Nothing was trimmed.

## What the two runs show

**Scalar request, 5 states.** Psi4's `==> Requested Excitations <==` block records how the count was
allocated: one state each in Ag, B1g, B2g, B3g and Au, and **zero in B1u**. The resulting five states
are all symmetry-forbidden:

```
1  Ag->B1g (1 B1g)  0.31247 au   8.50279 eV  f = 0.0000
2  Ag->B2g (1 B2g)  0.35756 au   9.72962 eV  f = 0.0000
3  Ag->Au  (1 Au)   0.41871 au  11.39379 eV  f = 0.0000
4  Ag->B3g (1 B3g)  0.43489 au  11.83395 eV  f = 0.0000
5  Ag->Ag  (1 Ag)   0.49263 au  13.40525 eV  f = 0.0000
```

Ethylene's bright π→π\* state is **B1u**, and B1u was allocated nothing. A user who asked for "5 states"
and got five zero-oscillator strengths would reasonably conclude the calculation was broken.

**Per-irrep request, 16 states.** With two states in each of the eight D₂h irreps, the table starts
with the state that should be there:

```
1  Ag->B1u (1 B1u)  0.30267 au   8.23612 eV  f = 0.3501 (length)  0.3603 (velocity)
…
10 Ag->B1u (1 B1u)  0.46657 au  12.69596 eV  f = 0.4183 (length)  0.4104 (velocity)
11 Ag->B2u (1 B2u)  0.47903 au  13.03502 eV  f = 0.2597 (length)  0.2733 (velocity)
```

The two strongest transitions in the table are both **B1u**, at 8.24 eV (f = 0.3501) and 12.70 eV
(f = 0.4183) — neither of which the scalar five-state request computed at all.

## Consequences for the app

- The builder writes `set tdscf_states N` from the block's **States** field and states in the
  inspector that N is allocated across irreps in point-group order, so the number is not a promise of
  the N lowest.
- The card reports the state table Psi4 actually computed, with the per-irrep allocation alongside it,
  and never claims a selection the engine did not make.
- `set tda` is **not** a Psi4 option (fatal error); the option is `tdscf_tda`, and it is not written.
- `td-hf` at the default `tdscf_maxiter 60` failed to converge in one irrep
  (`Could not converge TDSCF solver (singlet excitations in irrep B2g)`); `td-b3lyp` at 6-31G\*
  converged. A non-converged solver must surface as a failed run, not an empty table.
