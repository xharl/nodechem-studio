# cclib fixtures — provenance

These logs are copied from the public **cclib-data** repository
(https://github.com/cclib/cclib-data), used as read-only test inputs for the
sidecar in `scripts/ncs_cclib.py`. cclib-data is distributed under the
BSD-3-Clause licence; the logs remain the work of the programs that produced
them.

| File | Program | Level | Source |
| --- | --- | --- | --- |
| `gamess-water-mp2.log` | GAMESS-US 2014.r1 | RHF/STO-3G then MP2 | `GAMESS/GAMESS-US2014/water_mp2.out` |
| `nwchem-hydrogen-hf.log` | NWChem 6.0 | UHF/cc-pVDZ | `NWChem/NWChem6.0/hydrogen_atom_UHF_cc-pVDZ.out` |
| `qchem-water-ccsdt.log` | Q-Chem 4.2.0 | CCSD(T)/STO-3G | `QChem/QChem4.2/water_ccsd(t).out` |
| `gamess-truncated.log` | GAMESS-US 2014.r1 | same as above, truncated at 5,000 bytes | derived from `gamess-water-mp2.log` |

The three `.cjson` files were produced by:

```sh
cclib 1.8.1
python scripts/ncs_cclib.py convert test/fixtures/cclib/gamess-water-mp2.log \
  test/fixtures/cclib/gamess-water-mp2.cjson --json
```

and likewise for the other two. They are **real cclib conversions**, not
hand-written stand-ins: the geometry, charge, final energy and origin in each
file came from the log. `test/cclib.test.js` re-runs the conversion when
`NCS_CCLIB_PYTHON` names an interpreter with cclib; otherwise it validates the
committed cjson through the app's importer and skips the process-spawning
cases, so a normal `npm test` never requires Python or cclib.
