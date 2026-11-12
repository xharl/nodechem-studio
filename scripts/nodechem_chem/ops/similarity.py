"""`similarity` — fingerprints, Tanimoto matrix, clusters and scaffolds (ADR 0003 §3.7).

The matrix is the evidence: every pair is reported, so a cluster id can be
checked instead of trusted. MCS has a stated timeout, and a timed-out search is
reported as timed out rather than as a smaller common substructure.
"""


def _mol_from_entry(entry, op):
    from rdkit import Chem
    from rdkit.Chem import rdDetermineBonds

    from ..common import xyz_block

    smiles = str(entry.get("smiles") or "").strip()
    if smiles:
        mol = Chem.MolFromSmiles(smiles)
        if mol is None:
            return None
        return Chem.AddHs(mol)
    atoms = entry.get("atoms")
    if not isinstance(atoms, list) or not atoms:
        return None
    raw = Chem.MolFromXYZBlock(xyz_block(atoms, str(entry.get("label") or "similarity")))
    if raw is None:
        return None
    try:
        rdDetermineBonds.DetermineBonds(raw, charge=int(entry.get("charge", 0) or 0))
        Chem.SanitizeMol(raw)
    except Exception:  # noqa: BLE001 - perception is best-effort per molecule
        return None
    return raw


def run(request):
    from ..common import fail

    try:
        from rdkit import Chem, DataStructs
        from rdkit.Chem import AllChem, rdFMCS, rdMolDescriptors
        from rdkit.Chem.Scaffolds import MurckoScaffold
        from rdkit.ML.Cluster import Butina
    except ImportError as error:
        fail("capability-missing", f"This RDKit build does not expose similarity modules: {error}.", op="similarity")

    options = request.get("options") if isinstance(request.get("options"), dict) else {}
    fingerprint = str(options.get("fingerprint") or "morgan")
    radius = int(options.get("radius", 2))
    nbits = int(options.get("nBits", 2048))
    cutoff = float(options.get("clusterCutoff", 0.6))
    timeout = int(options.get("mcsTimeoutSeconds", 10))
    entries = request.get("molecules")
    if not isinstance(entries, list) or len(entries) < 2:
        fail("bad-input", "The similarity request needs at least two molecules.", op="similarity")

    mols = []
    molecules = []
    for index, entry in enumerate(entries):
        mol = _mol_from_entry(entry if isinstance(entry, dict) else {}, "similarity")
        if mol is None:
            fail(
                "coverage-refused",
                f"Molecule {index + 1} could not be perceived; the similarity matrix would be built from "
                "a partial set, so the whole request is refused.",
                op="similarity",
            )
        mols.append(mol)
        molecules.append(
            {
                "id": str(entry.get("id") or f"m{index + 1}"),
                "label": str(entry.get("label") or entry.get("id") or f"m{index + 1}"),
                "smiles": Chem.MolToSmiles(Chem.RemoveHs(mol), isomericSmiles=True),
                "formula": rdMolDescriptors.CalcMolFormula(mol),
                "scaffold": MurckoScaffold.MurckoScaffoldSmiles(mol=mol),
            }
        )

    fingerprints = []
    for mol in mols:
        # Fingerprint the heavy-atom graph: explicit hydrogens would add H
        # features that depend on how the input was prepared, not on chemistry.
        fp_mol = Chem.RemoveHs(mol)
        if fingerprint == "maccs":
            fingerprints.append(AllChem.GetMACCSKeysFingerprint(fp_mol))
        elif fingerprint == "rdkit":
            fingerprints.append(Chem.RDKFingerprint(fp_mol, fpSize=nbits))
        else:
            generator = getattr(AllChem, "MorganGenerator", None)
            if generator is not None:
                fingerprints.append(generator(radius=radius, fpSize=nbits).GetFingerprint(fp_mol))
            else:
                fingerprints.append(AllChem.GetMorganFingerprintAsBitVect(fp_mol, radius, nBits=nbits))

    count = len(mols)
    matrix = [[1.0] * count for _ in range(count)]
    pairs = []
    distances = []
    for i in range(count):
        for j in range(i + 1, count):
            similarity = float(DataStructs.TanimotoSimilarity(fingerprints[i], fingerprints[j]))
            matrix[i][j] = similarity
            matrix[j][i] = similarity
            pairs.append({"i": i, "j": j, "similarity": similarity})
            distances.append(1.0 - similarity)

    clusters = []
    try:
        groups = Butina.ClusterData(distances, count, 1.0 - cutoff, isDistData=True, reordering=True)
        clusters = [{"id": f"k{index + 1}", "members": [int(member) for member in group]}
                    for index, group in enumerate(sorted(groups, key=lambda group: (-len(group), min(group))))]
    except Exception:  # noqa: BLE001 - a clustering failure must not lose the matrix
        clusters = []

    mcs = None
    try:
        result = rdFMCS.FindMCS([Chem.RemoveHs(mol) for mol in mols], timeout=timeout, threshold=0.7)
        mcs = {
            "smarts": result.smartsString or "",
            "atoms": int(result.numAtoms),
            "bonds": int(result.numBonds),
            "timedOut": bool(getattr(result, "timedOut", getattr(result, "canceled", False))),
        }
    except Exception:  # noqa: BLE001 - MCS is evidence beside the matrix, not a precondition
        mcs = {"smarts": "", "atoms": 0, "bonds": 0, "timedOut": True}

    return {
        "program": "RDKit",
        "options": {
            "fingerprint": fingerprint,
            "radius": radius,
            "nBits": nbits,
            "metric": "tanimoto",
            "clusterCutoff": cutoff,
            "mcsTimeoutSeconds": timeout,
        },
        "result": {
            "molecules": molecules,
            "matrix": matrix,
            "clusters": clusters,
            "pairs": pairs,
            "mcs": mcs,
        },
    }
