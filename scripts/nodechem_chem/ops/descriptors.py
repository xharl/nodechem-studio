"""`descriptors` — the curated `nodechem-1` set (ADR 0003 §3.1).

Every value is 2D/topological. A molecule RDKit cannot sanitise is a refusal of
the whole request (`coverage-refused`, `bad-input`), never a row of zeros; an
individual descriptor the build cannot compute is a `capability-missing`
refusal, because a table with a silent hole is worse than no table.
"""


def _formal_charge(mol):
    """Sum of formal charges, as an integer."""
    return int(sum(atom.GetFormalCharge() for atom in mol.GetAtoms()))


def run(request):
    from ..common import fail, mol_identity, molecule_from_request

    try:
        from rdkit.Chem import Crippen, Descriptors, Lipinski, QED, rdMolDescriptors
        from rdkit.Chem.Scaffolds import MurckoScaffold
    except ImportError as error:
        fail(
            "capability-missing",
            f"This RDKit build does not expose the descriptor modules: {error}.",
            op="descriptors",
        )

    molecule = request.get("molecule")
    mol, _charge, _multiplicity = molecule_from_request(molecule, op="descriptors")
    identity = mol_identity(mol)

    try:
        descriptors = {
            "formula": rdMolDescriptors.CalcMolFormula(mol),
            "exactMass": Descriptors.ExactMolWt(mol),
            "molWeight": Descriptors.MolWt(mol),
            "logP": Crippen.MolLogP(mol),
            "tpsa": rdMolDescriptors.CalcTPSA(mol),
            "hbd": Lipinski.NumHDonors(mol),
            "hba": Lipinski.NumHAcceptors(mol),
            "rotatableBonds": rdMolDescriptors.CalcNumRotatableBonds(mol),
            "ringCount": rdMolDescriptors.CalcNumRings(mol),
            "aromaticRingCount": rdMolDescriptors.CalcNumAromaticRings(mol),
            "fsp3": rdMolDescriptors.CalcFractionCSP3(mol),
            "qed": QED.qed(mol),
            "formalCharge": _formal_charge(mol),
            "inchiKey": identity["inchiKey"],
            "murckoScaffold": MurckoScaffold.MurckoScaffoldSmiles(mol=mol),
        }
    except Exception as error:  # noqa: BLE001 - RDKit raises several unrelated types
        fail(
            "op-failed",
            f"RDKit failed while computing the descriptor set: {error}.",
            op="descriptors",
        )

    return {
        "program": "RDKit",
        "options": {"descriptorSet": "nodechem-1"},
        "result": {"identity": identity, "descriptors": descriptors},
    }

