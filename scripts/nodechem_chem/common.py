"""Wire helpers shared by every op: request reading, refusals, RDKit plumbing."""

import json
import math
import sys
from typing import NoReturn

from . import PROTOCOL


def fail(code, message, detail=None, op=None) -> NoReturn:
    """Print one refusal object and exit 2. Never returns."""
    payload = {
        "protocol": PROTOCOL,
        "ok": False,
        "error": {"code": str(code), "message": str(message)},
    }
    if op:
        payload["op"] = str(op)
    if detail is not None:
        payload["error"]["detail"] = str(detail)
    print(json.dumps(payload))
    sys.exit(2)


def read_request():
    """Read exactly one JSON object from stdin and check the protocol."""
    try:
        request = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        fail("bad-input", f"Invalid JSON request: {error}")
    if not isinstance(request, dict):
        fail("bad-input", "The request must be one JSON object.")
    if request.get("protocol") != PROTOCOL:
        fail(
            "bad-input",
            f"This sidecar speaks {PROTOCOL}; the request declared {request.get('protocol')!r}.",
        )
    return request


def rdkit_version(rdkit_module):
    """The installed distribution's version, falling back to the module's string.

    The two spell the same build differently (`2026.9.1` versus `2026.09.1`), so
    the value is recorded, never parsed. Capability flags decide what may run.
    """
    try:
        from importlib.metadata import version as package_version

        return str(package_version("rdkit"))
    except Exception:  # noqa: BLE001 - a source build reports no distribution
        return str(getattr(rdkit_module, "__version__", "unreported"))


def disable_rdkit_logs():
    """stdout is the protocol; RDKit's warnings must not pollute it."""
    from rdkit import RDLogger

    RDLogger.DisableLog("rdApp.*")


def request_atoms(molecule, op="op"):
    """Validate and return the atom list of a request molecule."""
    atoms = molecule.get("atoms") if isinstance(molecule, dict) else None
    if not isinstance(atoms, list) or not atoms:
        fail("bad-input", f"The {op} request carries no atoms.", op=op)
    out = []
    for index, atom in enumerate(atoms):
        if not isinstance(atom, dict) or not isinstance(atom.get("element"), str) or not atom["element"].strip():
            fail("bad-input", f"Atom {index + 1} has no element symbol.", op=op)
        for axis in ("x", "y", "z"):
            value = atom.get(axis)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                fail("bad-input", f"Atom {index + 1} has no finite {axis} coordinate.", op=op)
        out.append(
            {
                "element": atom["element"].strip(),
                "x": float(atom["x"]),
                "y": float(atom["y"]),
                "z": float(atom["z"]),
            }
        )
    return out


def xyz_block(atoms, title="nodechem"):
    lines = [str(len(atoms)), str(title)]
    for atom in atoms:
        lines.append(
            "{element} {x:.6f} {y:.6f} {z:.6f}".format(
                element=atom["element"], x=atom["x"], y=atom["y"], z=atom["z"]
            )
        )
    return "\n".join(lines) + "\n"


def molecule_from_request(molecule, op="op"):
    """Build an RDKit mol from the request, or refuse with a typed code.

    A SMILES is authoritative when present (a record may carry one); otherwise
    the geometry is read as XYZ and the bond orders are perceived with
    `rdDetermineBonds`, the same rule the tautomer sidecar applies. Open-shell
    input is refused: `DetermineBonds` assumes a closed shell, and guessing
    bonds for an open shell would invent a structure.
    """
    from rdkit import Chem
    from rdkit.Chem import rdDetermineBonds

    if not isinstance(molecule, dict):
        fail("bad-input", f"The {op} request carries no molecule.", op=op)
    smiles = str(molecule.get("smiles") or "").strip()
    charge = molecule.get("charge", 0)
    multiplicity = molecule.get("multiplicity", 1)
    if isinstance(charge, bool) or not isinstance(charge, int) or abs(charge) > 10:
        fail("bad-input", "molecule.charge must be an integer between -10 and 10.", op=op)
    if isinstance(multiplicity, bool) or not isinstance(multiplicity, int) or not 1 <= multiplicity <= 10:
        fail("bad-input", "molecule.multiplicity must be an integer between 1 and 10.", op=op)
    if multiplicity != 1:
        fail(
            "coverage-refused",
            f"Multiplicity {multiplicity} is not supported: bond orders are perceived for a closed-shell "
            "molecule, and guessing them for an open shell would invent a structure.",
            op=op,
        )

    if smiles:
        mol = Chem.MolFromSmiles(smiles)
        if mol is None:
            fail("bad-input", f"RDKit could not read the SMILES {smiles!r}.", op=op)
        return Chem.AddHs(mol), charge, multiplicity

    atoms = request_atoms(molecule, op=op)
    raw = Chem.MolFromXYZBlock(xyz_block(atoms, str(molecule.get("title") or "nodechem")))
    if raw is None:
        fail("bad-input", "RDKit could not read the geometry as an XYZ block.", op=op)
    try:
        rdDetermineBonds.DetermineBonds(raw, charge=charge)
        Chem.SanitizeMol(raw)
    except Exception as error:  # noqa: BLE001 - RDKit raises several unrelated types
        fail(
            "coverage-refused",
            "RDKit could not perceive bonds and bond orders from this geometry at "
            f"charge {charge}: {error}. Supply a molecule with a bond table, or a cleaner geometry.",
            op=op,
        )
    return raw, charge, multiplicity


def mol_identity(mol):
    """The identity triple ADR §2.4 requires: InChIKey, tautomer hash, formula."""
    from rdkit import Chem
    from rdkit.Chem import rdMolDescriptors, rdMolHash

    try:
        inchi_key = Chem.MolToInchiKey(mol)
    except Exception:  # noqa: BLE001 - InChI support can be absent
        inchi_key = ""
    try:
        tautomer_hash = rdMolHash.MolHash(mol, rdMolHash.HashFunction.HetAtomTautomer)
    except Exception:  # noqa: BLE001 - older RDKit exposes HashMol only
        tautomer_hash = ""
    return {
        "smiles": Chem.MolToSmiles(mol),
        "inchiKey": inchi_key,
        "tautomerHash": tautomer_hash,
        "formula": rdMolDescriptors.CalcMolFormula(mol),
        "atomCount": mol.GetNumAtoms(),
        "heavyAtomCount": mol.GetNumHeavyAtoms(),
    }
