"""`integrity` — perceive the final geometry and compare it with the input.

ADR 0003 §3.6. This is a perception from coordinates, so it answers three
separate questions instead of returning a boolean: composition, constitution
(connectivity + tautomer) and configuration (stereo). `inconclusive` is a
first-class answer for an open shell, a multi-fragment geometry or a perception
failure; it is never reported as a pass.
"""


def _formula_of_atoms(atoms):
    from collections import Counter

    counts = Counter(atom["element"] for atom in atoms)
    order = []
    if "C" in counts:
        order.append("C")
        if "H" in counts:
            order.append("H")
    order.extend(sorted(symbol for symbol in counts if symbol not in order))
    return "".join(symbol + (str(counts[symbol]) if counts[symbol] > 1 else "") for symbol in order)


def _molecule(atoms, charge, op):
    """Perceive bonds from a geometry. Returns (mol, None) or (None, reason)."""
    from rdkit import Chem
    from rdkit.Chem import rdDetermineBonds

    from ..common import xyz_block

    if not atoms:
        return None, "empty-geometry"
    raw = Chem.MolFromXYZBlock(xyz_block(atoms, "integrity"))
    if raw is None:
        return None, "perception-failed"
    try:
        # Connectivity does not exist until the bonds are perceived; counting
        # fragments before this point would call every geometry multi-fragment.
        rdDetermineBonds.DetermineBonds(raw, charge=charge)
        Chem.SanitizeMol(raw)
    except Exception:  # noqa: BLE001 - RDKit raises several unrelated types
        return None, "perception-failed"
    if len(Chem.GetMolFrags(raw, asMols=False, sanitizeFrags=False)) > 1:
        return None, "multi-fragment"
    return raw, None


def _identity(mol):
    from rdkit import Chem
    from rdkit.Chem import rdMolDescriptors, rdMolHash

    def hash_of(function):
        try:
            return rdMolHash.MolHash(mol, function)
        except Exception:  # noqa: BLE001 - an older build may lack one function
            return ""

    def inchi_key(options=""):
        try:
            return Chem.MolToInchiKey(mol, options) if options else Chem.MolToInchiKey(mol)
        except Exception:  # noqa: BLE001 - InChI support can be absent
            return ""

    return {
        "formula": rdMolDescriptors.CalcMolFormula(mol),
        "atomCount": mol.GetNumAtoms(),
        "heavyAtomCount": mol.GetNumHeavyAtoms(),
        "charge": int(sum(atom.GetFormalCharge() for atom in mol.GetAtoms())),
        "fragments": len(Chem.GetMolFrags(mol, asMols=False, sanitizeFrags=False)),
        "smiles": Chem.MolToSmiles(mol, isomericSmiles=False),
        "isomericSmiles": Chem.MolToSmiles(mol, isomericSmiles=True),
        "inchiKey": inchi_key(),
        "fixedHInchiKey": inchi_key("/FixedH"),
        "tautomerHash": hash_of(rdMolHash.HashFunction.HetAtomTautomer),
        "connectivityHash": hash_of(rdMolHash.HashFunction.AnonymousGraph),
    }


def _compare(before, after):
    composition = (
        before.get("formula") == after.get("formula")
        and before.get("atomCount") == after.get("atomCount")
        and before.get("heavyAtomCount") == after.get("heavyAtomCount")
    )
    connectivity = bool(before.get("connectivityHash") and after.get("connectivityHash")) and (
        before["connectivityHash"] == after["connectivityHash"]
    )
    tautomer = bool(before.get("tautomerHash") and after.get("tautomerHash")) and (
        before["tautomerHash"] == after["tautomerHash"]
    )
    configuration = bool(before.get("inchiKey") and after.get("inchiKey")) and (
        before["inchiKey"] == after["inchiKey"]
    )
    comparisons = {
        "composition": composition,
        "connectivity": connectivity,
        "tautomer": tautomer,
        "configuration": configuration,
    }
    if not composition:
        return "composition-changed", None, comparisons
    if not connectivity:
        return "connectivity-changed", None, comparisons
    if not tautomer:
        return "tautomer-changed", None, comparisons
    if not configuration:
        return "stereo-changed", None, comparisons
    return "match", None, comparisons


def run(request):
    from ..common import fail, molecule_from_request

    molecule = request.get("molecule")
    options = request.get("options") if isinstance(request.get("options"), dict) else {}
    policy = options.get("policy", "warn")
    if policy not in ("warn", "fail"):
        fail("bad-input", 'options.policy must be "warn" or "fail".', op="integrity")
    final_atoms = options.get("finalAtoms")
    if not isinstance(final_atoms, list) or not final_atoms:
        fail("bad-input", "The integrity request carries no final geometry.", op="integrity")

    from ..common import request_atoms

    try:
        final_atoms = request_atoms({"atoms": final_atoms}, op="integrity")
    except SystemExit:
        raise

    charge = molecule.get("charge", 0) if isinstance(molecule, dict) else 0
    multiplicity = molecule.get("multiplicity", 1) if isinstance(molecule, dict) else 1
    if isinstance(charge, bool) or not isinstance(charge, int):
        fail("bad-input", "molecule.charge must be an integer.", op="integrity")
    if isinstance(multiplicity, bool) or not isinstance(multiplicity, int) or multiplicity != 1:
        # Open shell: DetermineBonds assumes a closed shell, so the comparison is
        # inconclusive rather than a refusal of the whole request.
        return {
            "program": "RDKit",
            "options": {"policy": policy, "reason": "open-shell"},
            "result": {
                "before": {"formula": _formula_of_atoms(final_atoms), "atomCount": len(final_atoms)},
                "after": {"formula": _formula_of_atoms(final_atoms), "atomCount": len(final_atoms)},
                "status": "inconclusive",
                "reason": "open-shell",
            },
        }

    before_mol, before_reason = _molecule(request_atoms(molecule, op="integrity"), charge, "integrity")
    after_mol, after_reason = _molecule(final_atoms, charge, "integrity")
    if before_mol is None or after_mol is None:
        return {
            "program": "RDKit",
            "options": {"policy": policy, "reason": before_reason or after_reason},
            "result": {
                "before": {"formula": _formula_of_atoms(request_atoms(molecule, op="integrity")), "atomCount": len(request_atoms(molecule, op="integrity"))},
                "after": {"formula": _formula_of_atoms(final_atoms), "atomCount": len(final_atoms)},
                "status": "inconclusive",
                "reason": before_reason or after_reason,
            },
        }

    before = _identity(before_mol)
    after = _identity(after_mol)
    status, reason, comparisons = _compare(before, after)
    return {
        "program": "RDKit",
        "options": {"policy": policy},
        "result": {
            "before": before,
            "after": after,
            "status": status,
            "reason": reason,
            "comparisons": comparisons,
        },
    }
