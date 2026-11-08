"""nodechem -- a dependency-free Python client for NodeChem Studio.

Quick start from a checkout (no install step):

    import sys
    sys.path.insert(0, "clients/python")
    import nodechem

    result = nodechem.validate("examples/single-point.ncs")
    if not result["ok"]:
        raise SystemExit(result["errors"])

    for summary in nodechem.list_runs("/tmp/ncs-runs"):
        print(summary["id"], summary["status"])

    record = nodechem.read_record(summary["id"], "/tmp/ncs-runs")
    print(record["parsed"]["finalEnergy"]["hartree"], "Eh")

The CLI is discovered from ``NODECHEM_NCS``, then ``PATH``, then the checkout
this file lives in. Pass ``cli=...`` to any call to override it.
"""

from .client import (
    DEFAULT_TIMEOUT,
    RECORD_SCHEMA_VERSION,
    Client,
    export,
    list_runs,
    read_record,
    validate,
)
from .errors import CliError, NodeChemError, RecordNotFoundError

__all__ = [
    "Client",
    "CliError",
    "DEFAULT_TIMEOUT",
    "NodeChemError",
    "RECORD_SCHEMA_VERSION",
    "RecordNotFoundError",
    "export",
    "list_runs",
    "read_record",
    "validate",
]

__version__ = "0.1.0"
