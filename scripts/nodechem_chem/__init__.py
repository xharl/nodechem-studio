"""Shared protocol and molecule helpers for the NodeChem chemistry sidecar.

ADR 0003 §2.1. The entry point owns dispatch; this package owns the wire rules
that every op must obey, so a new op cannot invent a second refusal shape or a
second way to read a molecule.
"""

PROTOCOL = "nodechem-chem/1"

# The ADR's refusal vocabulary. Client-side validation has its own codes; these
# are the ones a sidecar may print.
REFUSAL_CODES = (
    "rdkit-missing",
    "capability-missing",
    "coverage-refused",
    "size-refused",
    "bad-input",
    "op-failed",
)
