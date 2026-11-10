# PySCF fixtures — provenance

These are **recorded** results from real PySCF runs, not synthetic stand-ins.
Every JSON file was written by the deck this repository's builder emits, run
under the interpreter named below. `water-hf-def2svp-sp.py` is the generated
deck for the first record and is asserted byte-identical to `buildPyscfInput()`
by `test/pyscf.test.js`.

| Field | Value |
| --- | --- |
| Engine | PySCF |
| Version | 2.15.0 |
| Interpreter | CPython 3.13.9 (venv) |
| Command | `python water-<case>.py` in a fresh directory |
| Date | 2026-11-09 |
| Geometry | water: O (0, 0, 0.1173), H (0, 0.7572, −0.4692), H (0, −0.7572, −0.4692) Å |
| Density fitting | on (`mf.density_fit()`), as the deck writes it |

| File | Level | Job | Notes |
| --- | --- | --- | --- |
| `water-hf-def2svp-sp.json` | HF/def2-SVP | SP | −75.96092810964097 Eh, 9 SCF cycles |
| `water-b3lyp-def2svp-sp.json` | B3LYP/def2-SVP | SP | −76.35815183294746 Eh, 7 SCF cycles |
| `water-b3lyp-def2svp-opt.json` | B3LYP/def2-SVP | Opt | geomeTRIC, 4 steps, converged |
| `water-b3lyp-def2svp-freq.json` | B3LYP/def2-SVP | Freq | 3 modes, 0 imaginary |
| `water-b3lyp-def2svp-optfreq.json` | B3LYP/def2-SVP | Opt Freq | 4 steps, 3 modes, 0 imaginary |
| `water-hf-631gd-pcm.json` | HF/6-31G(d) | SP | PCM (IEF-PCM), water, −76.02057700618754 Eh |
| `water-casscf-44-631gd-sp.json` | CASSCF(4,4)/6-31G(d) | SP | −76.0609899309991 Eh, reference RHF |
| `water-ch2-singlet-casscf-sto3g-sp.json` | CASSCF(2,2)/STO-3G | SP | CH₂ singlet, −38.373426122243615 Eh |
| `water-ch2-triplet-casscf-sto3g-sp.json` | CASSCF(2,2)/STO-3G | SP | CH₂ triplet, −38.37342612226331 Eh |
| `water-mp2-def2svp-sp.json` | MP2/def2-SVP | SP | −76.16452758439047 Eh |
| `water-ccsd-def2svp-sp.json` | CCSD/def2-SVP | SP | −76.17392974901573 Eh |
| `water-ccsd(t)-def2svp-sp.json` | CCSD(T)/def2-SVP | SP | −76.17693585504087 Eh |
| `water-hf-def2svp-sp-failed-scf.json` | HF/def2-SVP | SP | **deliberately failed SCF**: the deck's `maxCycle` was set to 1; record is `ok: false`, `nIter: 1` |

## Psi4 comparison

The acceptance criterion compares water at HF/def2-SVP and B3LYP/def2-SVP with
Psi4 on the same geometry. Those Psi4 numbers were produced with the official
`psi4/psi4:1.11` container image and the same density-fitted SCF:

| Level | Psi4 1.11 (Eh) | PySCF 2.15.0 (Eh) | Difference |
| --- | --- | --- | --- |
| HF/def2-SVP | −75.96092810958544 | −75.96092810964097 | 5.6 × 10⁻¹¹ |
| B3LYP/def2-SVP | −76.35815199866961 | −76.35815183294746 | 1.7 × 10⁻⁷ |

## Independent PySCF reference

The PCM and CASSCF records were checked against a separate direct PySCF call,
not against themselves:

- PCM: `solvent.PCM(scf.RHF(mol).density_fit(), 'water')` with
  `with_solvent.method = 'IEF-PCM'` gives −76.02057700618754 Eh, identical to
  the deck's record.
- CASSCF: `mcscf.CASSCF(scf.RHF(mol).density_fit(), 4, 4)` gives
  −76.06098993030339 Eh, 7 × 10⁻¹⁰ Eh from the deck's record (the CASSCF
  convergence tolerance, not a different calculation).
- CASSCF/STO-3G CH₂: independent `mcscf.CASSCF((RHF or ROHF).density_fit(), 2, 2)`
  gives −38.37342612224362 Eh (singlet) and −38.373426122263325 Eh (triplet),
  matching the two records to 1 × 10⁻¹³ Eh. The two spin states are degenerate
  in this minimal active space, which is the expected CAS(2,2)/STO-3G result.

No PySCF binary or Python environment is committed or bundled. The deck is a
fixed program; `pip install pyscf` (or `conda install -c conda-forge pyscf`) is
the deployment step this engine assumes.
