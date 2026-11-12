#!/usr/bin/env python3
"""NodeChem chemistry sidecar — one process, one protocol, one op per request.

ADR 0003 §2.1. One JSON object on stdin, one JSON object on stdout. Nothing is
read from argv: the app spawns this file with `shell: false` and writes the
request to the child's stdin, exactly like `tautomer-enumerator.py`.

Request
-------

    {"protocol": "nodechem-chem/1", "op": "probe", "options": {}}

    {"protocol": "nodechem-chem/1", "op": "descriptors",
     "molecule": {"title": "aspirin", "charge": 0, "multiplicity": 1,
                  "smiles": "CC(=O)Oc1ccccc1C(=O)O",
                  "atoms": [{"element": "C", "x": 0.0, "y": 0.0, "z": 0.0}, ...]},
     "options": {}}

Response (success)
------------------

    {"protocol": "nodechem-chem/1", "op": "probe", "ok": true,
     "program": "RDKit", "version": "2026.9.1",
     "capabilities": {"etkdgv4": true, ...}}

Response (refusal)
------------------

    {"protocol": "nodechem-chem/1", "op": "probe", "ok": false,
     "error": {"code": "rdkit-missing", "message": "..."}}

A refusal exits 2, so a shell user sees a failure; the app reads the JSON on
stdout either way and never treats a refusal as an empty success. The codes are
the ADR's: rdkit-missing, capability-missing, coverage-refused, size-refused,
bad-input, op-failed.
"""

import json
import os
import sys

# A script launched by absolute path has its own directory on sys.path; an
# embedded interpreter or a wrapper may not. Pin it so `nodechem_chem` imports
# in every launch mode, packaged or development.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from nodechem_chem import PROTOCOL  # noqa: E402
from nodechem_chem.common import fail, read_request  # noqa: E402
from nodechem_chem.ops import descriptors, probe  # noqa: E402

# Every op implemented in this build. The app refuses an unimplemented op before
# spawning, so reaching the fall-through below means the wire and the script
# disagree — which is a bad request, not a silent partial answer.
OPS = {
    "probe": probe.run,
    "descriptors": descriptors.run,
}


def main():
    request = read_request()
    op = request.get("op")
    if not isinstance(op, str) or not op.strip():
        fail("bad-input", "The request carries no op.")
    op = op.strip()
    handler = OPS.get(op)
    if handler is None:
        fail(
            "bad-input",
            f"op {op!r} is not implemented in this build; this sidecar offers {', '.join(sorted(OPS))}.",
            op=op,
        )
    payload = handler(request)
    payload.setdefault("program", "RDKit")
    # Provenance is required on every answer (ADR §2.4). The probe reports the
    # version itself; every other op gets the same value from the same build.
    if not payload.get("version"):
        from nodechem_chem.common import rdkit_version

        import rdkit

        payload["version"] = rdkit_version(rdkit)
    payload.update({"protocol": PROTOCOL, "op": op, "ok": True})
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
