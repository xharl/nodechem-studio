# Gaussian solvation fixtures

Two public Gaussian 16 C.01 single-point logs, copied unmodified from cclib's
regression corpus. They are the evidence for issue 223: a solvated run and a
vacuum run of water must not parse to the same record.

## Source

| File | URL |
| --- | --- |
| `water_hf_solvent_smd.log` | https://github.com/cclib/cclib/blob/master/data/Gaussian/basicGaussian16/water_hf_solvent_smd.log |
| `water_hf_solvent_smd.com` | https://github.com/cclib/cclib/blob/master/data/Gaussian/basicGaussian16/water_hf_solvent_smd.com |
| `water_hf_solvent_pcm.log` | https://github.com/cclib/cclib/blob/master/data/Gaussian/basicGaussian16/water_hf_solvent_pcm.log |
| `water_hf_solvent_pcm.com` | https://github.com/cclib/cclib/blob/master/data/Gaussian/basicGaussian16/water_hf_solvent_pcm.com |

Fetched from `master` on 2026-11-09. The logs are 23 kB each.

## Licence

cclib is distributed under the **BSD 3-Clause License**:
https://github.com/cclib/cclib/blob/master/LICENSE

The Gaussian program itself is licensed separately by Gaussian, Inc. These
files are program output, redistributed by cclib for parser testing; they are
not Gaussian software.

## SHA-256

```
a5b1650a0124e5fd93c4cdd27d924a56d8dff50870b9afbd81e18bb4da639d2d  water_hf_solvent_pcm.com
5e2897a6728f00ea0430369dd7e455b93c33588d92fc87a12790ab67d393200d  water_hf_solvent_pcm.log
78b09617a12e07435d0856188199e29db3fcf3e28c4411a6bc992ea92197465e  water_hf_solvent_smd.com
66ff77399a3502d52ccd9d24dacaa8fcf4be9b4d90b7b83763809e2d8ea566db  water_hf_solvent_smd.log
```

## What each log prints

`water_hf_solvent_smd.log`

- line 87 — route: `SCRF=(SMD, Solvent=Toluene`
- lines 179–195 — PCM header: `Model : PCM.`, `Atomic radii : SMD-Coulomb.`,
  `Cavity type : VdW (van der Waals Surface) (Alpha=1.000).`,
  `Solvent : Toluene, Eps= 2.374100 Eps(inf)= 2.238315`
- lines 217–218 — `PCM non-electrostatic energy = -0.0013470649 Hartrees.`
- line 356 — `SMD-CDS (non-electrostatic) energy (kcal/mol) = -0.85`
- line 350 — `SCF Done: E(RHF) = -74.9673020784 A.U.`

`water_hf_solvent_pcm.log`

- line 87 — route: `SCRF=(PCM, Solvent=Toluene`
- lines 179–195 — PCM header: `Model : PCM.`, `Atomic radii : UFF (Universal Force Field).`,
  `Cavity type : Scaled VdW (van der Waals Surface) (Alpha=1.100).`,
  `Solvent : Toluene, Eps= 2.374100 Eps(inf)= 2.238315`
- line 348 — `SCF Done: E(RHF) = -74.9663496977 A.U.`
- no non-electrostatic term is printed.

`test/gaussianSolvation.test.js` reads these numbers directly. The SMD model is
taken from the route because Gaussian prints `Model : PCM.` inside an SMD run;
the header value is kept as `headerModel`.
