# Provenance — `psi4-ddx` (issue 167)

A gas-phase / DDX-PCM pair at one level, plus the same solvated deck run in an
image **without** pyddx, which is the evidence for what the addon is and is not.

| Field | Value |
| --- | --- |
| Engine | Psi4 1.11 (`Psi4 1.11 release`, `Git: Rev {} zzzzzzz`) |
| Solvation addon | ddX 1.0.0 (`pyddx` 1.0.0, conda-forge `linux-64`, py312) |
| Base image | `docker.io/psi4/psi4@sha256:2a11303d50f7` (`psi4/psi4:1.11`) |
| Image used | local `psi4-ddx:1.11` = the base image + the pyddx `.so` copied into `/opt/conda/lib/python3.12/site-packages` (recipe below) |
| Command | `psi4 -i water-gas.dat -o water-gas.out`, `psi4 -i water-pcm.dat -o water-pcm.out`, `psi4 -i water-pcm-fchk.dat -o water-pcm-fchk.out` |
| Captured | 2026-11-09 on xeyve |
| Molecule | water, 3 atoms, charge 0, singlet — O (0, 0, 0.1173), H (0, 0.7572, −0.4692), H (0, −0.7572, −0.4692) Å |
| Level | RHF/6-31G\*, `scf_type df`, `energy('scf')` |
| Environment | `ddx_radii_set uff` (Ψ4's default), `ddx_radii_scaling 1.1` |

## Files

| File | What it is | sha256 |
| --- | --- | --- |
| `water-gas.dat` | the builder's deck, solvation off | `f05f370b0aaddd1fed02c0c142ab8005296bce027667050f06fc3ac2f82c449b` |
| `water-gas.out` | its log, gas phase | `b54abd352dbd0062dd4f43e33df98fad8e4edf01a2b511f9feeabdb4f652c199` |
| `water-pcm.dat` | the builder's deck, solvation on (`PCM`, `Water`) | `71ff69794f99aa2ac03a0994c87fdb8a5a22b8da417eee91de5afafe5ba051d9` |
| `water-pcm.out` | its log: gas-phase SCF, then the DDX-PCM SCF | `c7e252fa7989712046add600771c691652ff361c9d447c5cfd75e1332e1c2e01` |
| `water-pcm-fchk.dat` | the same deck with `return_wfn=True` and a `fchk` line added by hand | `fa46bd72ce9951ec16ebd5d334a1a2bd6595eab097cb5ccddeda528eaddbd57f` |
| `water-pcm-fchk.out` | its log — the same three energies | `d7ab9ef95e3d0b143f491f6fcbc21243944c4e75713bfe3a890d42c7bd2a111c` |
| `water-pcm.fchk` | the solvated wavefunction, from that run | `11b21c9edae2fce09ca7a8aa12551a253f80ddb39aa3363b7ef2a6334d2ee938` |
| `water-pcm-no-pyddx.out` | `water-pcm.dat` run in the **base** image: `ModuleNotFoundError: Python module ddx not found` | `5e9c4364ef1a7bb680846160b98e9d07907ebc5b62320a14bbf972ebd4fbca34` |
| `make-decks.mjs` | regenerates the two builder decks from `buildPsi4Input` | `440fc7e97a190dafe5d3536b57be72b500f89f7f59ff3da94a2d86383b1d189e` |

Nothing in the logs was edited, trimmed or reordered. `water-pcm-fchk.dat` is the
only hand-touched deck: `E_solv = energy('scf')` became
`E_solv, wfn = energy('scf', return_wfn=True)` and `fchk(wfn, 'water-pcm.fchk')`
was appended, so the fixture ships the solvated density beside the log. The app
does not write those two changes for a closed-shell block.

`test/psi4Solvation.test.js` re-runs `buildPsi4Input` and asserts both committed
decks are byte-identical to what the builder writes today — a deck that drifts
from its fixture fails the suite instead of quietly invalidating the energies.

## Numbers these logs pin

| Quantity | Value |
| --- | --- |
| gas phase (RHF/6-31G\*) | −76.010478658918117 Eh |
| in DDX-PCM water | −76.018719371410768 Eh |
| ΔE(solv) = solvated − gas | −0.008240712492651 Eh = −5.17 kcal/mol |
| `DD Solvation Energy` (solute–solvent interaction, a different quantity) | −0.008887466630479 Eh = −5.58 kcal/mol |

The gas-phase energy inside `water-pcm.out` is identical to the standalone
`water-gas.out` to all 15 printed decimals, which is what makes the pair a
difference of two calculations rather than a difference of two runs of the same
one.

## How the image was built

`pyddx` publishes **no wheel** for this Python and the image has no Fortran
compiler, so `pip install pyddx` fails at the CMake step (`Failed building wheel
for pyddx`); the layer was unpacked from conda-forge instead:

```dockerfile
FROM psi4/psi4:1.11
USER root
COPY pyddx.cpython-312-x86_64-linux-gnu.so /opt/conda/lib/python3.12/site-packages/
COPY pyddx-1.0.0.dist-info /opt/conda/lib/python3.12/site-packages/pyddx-1.0.0.dist-info
RUN /opt/conda/bin/python -c "import pyddx; print('pyddx', pyddx.__version__)"   # -> 1.0.0
USER 57439:57439
```

The `.so` and `.dist-info` came from
`https://conda.anaconda.org/conda-forge/linux-64/pyddx-1.0.0-py312h63963cf_0.conda`
(562 261 bytes), unpacked with `zstandard` + `zipfile`; nothing else in the image
changed. Psi4 1.11's own option table is unchanged by this: `DDX` and its 22
`DDX_*` options are in the base image, which is why the base image *recognises*
the keyword and then fails to import the module — see `water-pcm-no-pyddx.out`.

## What the base image says without pyddx

```
raise ModuleNotFoundError('Python module ddx not found. Solve by installing it: `conda install -c conda-forge pyddx` or `pip install pyddx`')
ModuleNotFoundError: Python module ddx not found. ...
*** Psi4 encountered an error. Buy a developer more coffee!
```

So `psi4/psi4:1.11` ships Psi4, and `DDX` as a recognised option, but not the
solver. The capability entry in `psi4.js` says this in `solvation.requires`, and
`docs/guide/engines.md` repeats it where a user sets the block up.
