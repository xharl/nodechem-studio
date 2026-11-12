"""`probe` — what this RDKit build can actually do.

ADR 0003 §2.1: a probe, not a version parse. Every flag is produced by importing
and touching the API once; a version string is recorded for provenance but never
compared against a minimum. The same RDKit build reports `2026.9.1` through
`importlib.metadata` and `2026.09.1` through `rdkit.__version__`, which is
exactly why a version comparison is not a contract.
"""

import importlib
import platform
import sys


def _has(module_name, attribute):
    """True when `module_name.attribute` exists; never raises."""
    try:
        module = importlib.import_module(module_name)
        value = getattr(module, attribute)
        return callable(value) or value is not None
    except Exception:  # noqa: BLE001 - a missing API is a false flag, not a crash
        return False


def run(request):  # noqa: ARG001 - the probe takes no parameters
    try:
        import rdkit
        from rdkit import Chem  # noqa: F401
        from rdkit.Chem import AllChem, Draw  # noqa: F401
    except ImportError as error:
        from ..common import fail

        fail(
            "rdkit-missing",
            f"RDKit is not installed in this interpreter: {error}. Point the chemistry sidecar at a "
            "Python with rdkit (BSD-3) installed; CI uses a fake sidecar and needs none.",
        )

    from ..common import disable_rdkit_logs, rdkit_version

    disable_rdkit_logs()

    capabilities = {
        "etkdgv4": hasattr(AllChem, "ETKDGv4") and hasattr(AllChem, "EmbedMultipleConfs"),
        "embedMultipleConfs": hasattr(AllChem, "EmbedMultipleConfs"),
        "mmff": hasattr(AllChem, "MMFFOptimizeMoleculeConfs") and hasattr(AllChem, "MMFFHasAllMoleculeParams"),
        "uff": hasattr(AllChem, "UFFOptimizeMoleculeConfs") and hasattr(AllChem, "UFFHasAllMoleculeParams"),
        "determineBonds": _has("rdkit.Chem.rdDetermineBonds", "DetermineBonds"),
        "drawSvg": hasattr(Draw, "MolToSVG"),
        "molHash": _has("rdkit.Chem.rdMolHash", "MolHash"),
        "standardize": _has("rdkit.Chem.MolStandardize.rdMolStandardize", "Cleanup"),
        "fmcs": _has("rdkit.Chem.rdFMCS", "FindMCS"),
        "shapeHelpers": _has("rdkit.Chem.rdShapeHelpers", "ShapeTanimotoDist"),
        "cipLabeler": _has("rdkit.Chem.rdCIPLabeler", "AssignCIPLabels"),
    }

    return {
        "program": "RDKit",
        "version": rdkit_version(rdkit),
        "capabilities": capabilities,
        "python": sys.version.split()[0],
        "platform": platform.system().lower(),
    }
