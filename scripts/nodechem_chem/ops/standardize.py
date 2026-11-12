"""`standardize` — a deterministic 1→1 cleanup (ADR 0003 §3.2).

Normalise, disconnect metals, drop counterions/salts and pick the charge parent.
Every change is reported: formula and atom count before and after, the fragments
removed, and the charge when it moved. A stereo audit runs in the same answer so
an unassigned centre is visible before a calculation runs on the structure.

Refusals, never guesses: a molecule whose valences cannot be sanitised is
`bad-input`; a build without `rdMolStandardize` is `capability-missing`;
an embedding that fails is `op-failed`.
"""


def _formal_charge(mol):
    return int(sum(atom.GetFormalCharge() for atom in mol.GetAtoms()))


def _state(mol):
    """Formula, counts, charge and fragment count for one side of the cleanup."""
    from rdkit import Chem
    from rdkit.Chem import rdMolDescriptors

    fragments = Chem.GetMolFrags(mol, asMols=False, sanitizeFrags=False)
    return {
        "smiles": Chem.MolToSmiles(mol),
        "formula": rdMolDescriptors.CalcMolFormula(mol),
        "atomCount": mol.GetNumAtoms(),
        "heavyAtomCount": mol.GetNumHeavyAtoms(),
        "charge": _formal_charge(mol),
        "fragments": len(fragments),
    }


def _heavy_formula(mol):
    """Hill formula over heavy atoms only, so a protonation change cannot hide a match."""
    counts = {}
    for atom in mol.GetAtoms():
        if atom.GetAtomicNum() <= 1:
            continue
        symbol = atom.GetSymbol()
        counts[symbol] = counts.get(symbol, 0) + 1
    order = []
    if "C" in counts:
        order.append("C")
        if "H" in counts:
            order.append("H")
    order.extend(sorted(symbol for symbol in counts if symbol not in order))
    return "".join(symbol + (str(counts[symbol]) if counts[symbol] > 1 else "") for symbol in order)


def _fragment_list(mol):
    """Every fragment, with the heavy-atom formula used to match it after cleanup.

    A kept fragment can change (acetate becomes acetic acid), so the match is on
    the heavy-atom formula: C2O2 survives, Na+ does not. Matching on the full
    SMILES would report the kept molecule as removed.
    """
    from rdkit import Chem
    from rdkit.Chem import rdMolDescriptors

    out = []
    for fragment in Chem.GetMolFrags(mol, asMols=True, sanitizeFrags=False):
        out.append(
            {
                "smiles": Chem.MolToSmiles(fragment),
                "formula": rdMolDescriptors.CalcMolFormula(fragment),
                "heavyFormula": _heavy_formula(fragment),
                "atomCount": fragment.GetNumAtoms(),
            }
        )
    return out


def _removed_fragments(before_mol, after_mol):
    from collections import Counter

    remaining = Counter(entry["heavyFormula"] for entry in _fragment_list(after_mol))
    removed = []
    for entry in _fragment_list(before_mol):
        key = entry["heavyFormula"]
        if remaining[key] > 0:
            remaining[key] -= 1
        else:
            removed.append({k: entry[k] for k in ("smiles", "formula", "atomCount")})
    return removed


def _stereo_audit(mol):
    """Unassigned stereocentres and double bonds, by atom and bond index."""
    from rdkit import Chem

    try:
        centres = Chem.FindMolChiralCenters(mol, includeUnassigned=True, useLegacyImplementation=False)
    except TypeError:  # older RDKit has no useLegacyImplementation argument
        centres = Chem.FindMolChiralCenters(mol, includeUnassigned=True)
    unassigned_centres = [
        {"atomIndex": int(index), "element": mol.GetAtomWithIdx(int(index)).GetSymbol()}
        for index, label in centres
        if label == "?"
    ]

    unassigned_bonds = []
    try:
        for info in Chem.FindPotentialStereo(mol):
            if info.type != Chem.StereoType.Bond_Double:
                continue
            if info.specified != Chem.StereoSpecified.Unspecified:
                continue
            bond = mol.GetBondWithIdx(int(info.centeredOn))
            unassigned_bonds.append(
                {"beginAtomIndex": int(bond.GetBeginAtomIdx()), "endAtomIndex": int(bond.GetEndAtomIdx())}
            )
    except AttributeError:
        # StereoType/FindPotentialStereo appeared after FindMolChiralCenters; a
        # build without them can still audit centres, and the answer says so.
        return {"unassignedStereocentres": unassigned_centres, "unassignedDoubleBonds": [], "doubleBondsAudited": False}
    return {
        "unassignedStereocentres": unassigned_centres,
        "unassignedDoubleBonds": unassigned_bonds,
        "doubleBondsAudited": True,
    }


def _with_geometry(mol):
    """Return the molecule with explicit hydrogens and a conformer, and its source."""
    from rdkit import Chem
    from rdkit.Chem import AllChem

    if mol.GetNumConformers() and mol.GetNumAtoms() == mol.GetNumHeavyAtoms():
        # Explicit hydrogens were absent but coordinates exist for the heavy
        # atoms: adding H with coordinates is the honest way to keep them.
        mol = Chem.AddHs(mol, addCoords=True)
    else:
        mol = Chem.AddHs(mol)
    if mol.GetNumConformers() and all(
        mol.GetConformer().GetAtomPosition(index) is not None for index in range(mol.GetNumAtoms())
    ):
        return mol, "input"

    params = AllChem.ETKDGv3()
    params.randomSeed = 0xF00D
    if AllChem.EmbedMolecule(mol, params) != 0:
        return None, ""
    return mol, "etkdgv3"


def _atoms(mol):
    conformer = mol.GetConformer()
    out = []
    for index, atom in enumerate(mol.GetAtoms()):
        position = conformer.GetAtomPosition(index)
        out.append(
            {
                "element": atom.GetSymbol(),
                "x": float(position.x),
                "y": float(position.y),
                "z": float(position.z),
            }
        )
    return out


def run(request):
    from ..common import fail, mol_identity, molecule_from_request

    try:
        from rdkit import Chem
        from rdkit.Chem.MolStandardize import rdMolStandardize
    except ImportError as error:
        fail(
            "capability-missing",
            f"This RDKit build does not expose rdMolStandardize: {error}.",
            op="standardize",
        )

    options_raw = request.get("options") if isinstance(request.get("options"), dict) else {}
    options = {}
    for key in ("normalize", "disconnectMetals", "removeFragments", "chargeParent"):
        value = options_raw.get(key, True)
        if not isinstance(value, bool):
            fail("bad-input", f"options.{key} must be true or false.", op="standardize")
        options[key] = value

    mol, _charge, _multiplicity = molecule_from_request(request.get("molecule"), op="standardize")
    try:
        before_mol = Chem.Mol(mol)
        before = _state(before_mol)
        steps = []
        cleaned = mol
        if options["normalize"]:
            cleaned = rdMolStandardize.Normalize(cleaned)
            steps.append("Normalize")
        if options["disconnectMetals"]:
            cleaned = rdMolStandardize.DisconnectOrganometallics(cleaned)
            steps.append("DisconnectOrganometallics")
        if options["chargeParent"]:
            cleaned = rdMolStandardize.ChargeParent(cleaned)
            steps.append("ChargeParent")
        elif options["removeFragments"]:
            cleaned = rdMolStandardize.FragmentParent(cleaned)
            steps.append("FragmentParent")
        Chem.SanitizeMol(cleaned)
    except Exception as error:  # noqa: BLE001 - RDKit raises several unrelated types
        fail(
            "coverage-refused",
            f"RDKit could not standardise this structure: {error}. "
            "The input is kept unchanged; nothing was written.",
            op="standardize",
        )

    if cleaned.GetNumAtoms() == 0:
        fail("coverage-refused", "Standardisation removed every atom.", op="standardize")

    try:
        removed = _removed_fragments(before_mol, cleaned)
        audit = _stereo_audit(cleaned)
    except Exception as error:  # noqa: BLE001 - RDKit raises several unrelated types
        fail("op-failed", f"RDKit failed while auditing the cleaned structure: {error}.", op="standardize")

    with_h, geometry_source = _with_geometry(cleaned)
    if with_h is None:
        fail("op-failed", "RDKit could not build 3D coordinates for the standardised structure.", op="standardize")

    try:
        after = _state(with_h)
        atoms = _atoms(with_h)
        identity = mol_identity(with_h)
    except Exception as error:  # noqa: BLE001 - RDKit raises several unrelated types
        fail("op-failed", f"RDKit failed while writing the standardised structure: {error}.", op="standardize")

    return {
        "program": "RDKit",
        "options": {**options, "steps": steps},
        "result": {
            "before": before,
            "after": after,
            "fragmentsRemoved": removed,
            "stereoAudit": audit,
            "geometry": {"source": geometry_source},
            "atoms": atoms,
            "identity": identity,
        },
    }
