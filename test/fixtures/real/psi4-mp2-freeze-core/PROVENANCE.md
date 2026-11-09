# Provenance — `psi4-mp2-freeze-core`

| Field | Value |
| --- | --- |
| Engine | Psi4 |
| Version | 1.11 |
| Image | `psi4/psi4:1.11` (Docker) |
| Command | `psi4 -i frozen-core.dat -o frozen-core.log`, `psi4 -i all-electron.dat -o all-electron.log` |
| Captured | 2026-11-09, inside the image on xeyve |
| Molecule | water, 3 atoms, charge 0, singlet |
| Level | RHF reference, `set scf_type df`, `set mp2_type df`, basis cc-pVQZ, `set freeze_core true` vs `false` |
| sha256 | `0ec80b256d72d391f71005edaba0466e57885e1f2cb8d5016a8303a593125b95` (`frozen-core.log`), `a1dfc8bd906e8135626431bcfdb3c2dd0c0339e0addf6f7de0cd71b0ec5fb0fa` (`all-electron.log`) |

Verbatim stdout, nothing trimmed; the `.dat` decks beside the logs are the exact inputs. The pair
documents issue 174 (frozen-core vs all-electron MP2) and doubles as a #159 regression: each log
carries `DF-MP2` and `DF-SCS-MP2` totals, and the parse must report the former.

See `README.md` in this folder for the measured gap (30.48 mEh) and the reference numbers.

Branches these logs reach: `mp2`.
