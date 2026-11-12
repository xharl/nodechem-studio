"""`stereoisomers` — enumerate stereoisomers as distinct molecules (ADR 0003 §3.5).

`EnumerateStereoisomers` copies the input conformer onto every candidate, so the
geometry policy is explicit: only the candidate identical to the input keeps the
input coordinates (`geometry.source: "input"`); every other candidate is
embedded with ETKDGv4 (`"etkdgv4"`). Carrying the input geometry onto an inverted
centre would label a different molecule with the original structure.
"""


def _canonical(mol):
    from rdkit import Chem

    return Chem.MolToSmiles(Chem.RemoveHs(mol), isomericSmiles=True)


def _coords(mol):
    conformer = mol.GetConformer()
    out = []
    for index, atom in enumerate(mol.GetAtoms()):
        position = conformer.GetAtomPosition(index)
        out.append({"element": atom.GetSymbol(), "x": float(position.x), "y": float(position.y), "z": float(position.z)})
    return out


def _embed(mol, seed):
    from rdkit.Chem import AllChem

    params = AllChem.ETKDGv3()
    params.randomSeed = seed
    params.numThreads = 1
    if AllChem.EmbedMolecule(mol, params) != 0:
        return None
    return mol


def run(request):
    from ..common import fail, molecule_from_request

    try:
        from rdkit import Chem
        from rdkit.Chem import rdMolDescriptors
    except ImportError as error:
        fail("capability-missing", f"This RDKit build does not expose EnumerateStereoisomers: {error}.", op="stereoisomers")

    options = request.get("options") if isinstance(request.get("options"), dict) else {}
    max_candidates = options.get("maxCandidates", 16)
    seed = options.get("seed", 1)
    if isinstance(max_candidates, bool) or not isinstance(max_candidates, int) or not 1 <= max_candidates <= 128:
        fail("bad-input", "options.maxCandidates must be an integer between 1 and 128.", op="stereoisomers")
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 0x7FFFFFFF:
        fail("bad-input", "options.seed must be an integer between 0 and 2147483647.", op="stereoisomers")

    mol, _charge, _multiplicity = molecule_from_request(request.get("molecule"), op="stereoisomers")
    try:
        # A request may carry both a SMILES (authoritative for stereo) and the
        # geometry it came from. When the atom order matches exactly, the
        # coordinates are attached, so the input-identical candidate can keep
        # them instead of being re-embedded.
        source = request.get("molecule") if isinstance(request.get("molecule"), dict) else {}
        request_atoms = source.get("atoms")
        if (mol.GetNumConformers() == 0 and isinstance(request_atoms, list)
                and len(request_atoms) == mol.GetNumAtoms()):
            from rdkit.Geometry import Point3D

            if all(atom.GetSymbol() == str(item.get("element") or "").strip()
                   for atom, item in zip(mol.GetAtoms(), request_atoms)):
                conformer = Chem.Conformer(mol.GetNumAtoms())
                for index, item in enumerate(request_atoms):
                    conformer.SetAtomPosition(index, Point3D(float(item["x"]), float(item["y"]), float(item["z"])))
                mol.RemoveAllConformers()
                mol.AddConformer(conformer, assignId=True)
    except Exception:  # noqa: BLE001 - a bad atom list must not invent coordinates
        pass
    try:
        from rdkit.Chem.EnumerateStereoisomers import EnumerateStereoisomers, StereoEnumerationOptions

        # An imported geometry may carry a configuration that only 3D reveals.
        # Without this, the "identical to the input" candidate cannot be found.
        if mol.GetNumConformers() > 0:
            Chem.AssignStereochemistryFrom3D(mol)
        base = Chem.RemoveHs(mol)
        input_smiles = _canonical(base)
        has_input_coords = base.GetNumConformers() > 0
        # Enumerate every configuration of the graph, not only the centres the
        # input left unassigned: the question is "which stereoisomers exist",
        # and the input's own configuration is one of them (it keeps its
        # coordinates). `RemoveStereochemistry` is what makes the enumerator
        # reconsider a centre the 3D geometry already labelled.
        enumerable = Chem.Mol(base)
        Chem.RemoveStereochemistry(enumerable)
        enumerator = EnumerateStereoisomers(
            enumerable,
            options=StereoEnumerationOptions(onlyUnassigned=False, unique=True, maxIsomers=max_candidates),
        )
        isomers = list(enumerator)
    except Exception as error:  # noqa: BLE001 - RDKit raises several unrelated types
        fail("coverage-refused", f"RDKit could not enumerate stereoisomers: {error}.", op="stereoisomers")

    if not isomers:
        fail("coverage-refused", "RDKit enumerated no stereoisomers for this molecule.", op="stereoisomers")

    truncated = len(isomers) >= max_candidates
    candidates = []
    seen = set()
    rejected = 0
    for index, isomer in enumerate(isomers):
        smiles = Chem.MolToSmiles(isomer, isomericSmiles=True)
        if smiles in seen:
            rejected += 1
            continue
        seen.add(smiles)
        candidate = Chem.AddHs(isomer)
        source = "etkdgv4"
        if smiles == input_smiles and has_input_coords:
            # The identical candidate keeps the input geometry. A conformer must
            # be on the molecule the coordinates came from, not the enumeration
            # copy, so it is copied by atom order (the enumerator preserves it).
            try:
                candidate.RemoveAllConformers()
                candidate.AddConformer(Chem.Conformer(mol.GetConformer()), assignId=True)
                source = "input"
            except Exception:  # noqa: BLE001 - fall back to an honest embedding
                candidate = Chem.AddHs(isomer)
        if source != "input":
            embedded = _embed(candidate, seed)
            if embedded is None:
                fail(
                    "op-failed",
                    f"RDKit could not embed stereoisomer {index + 1} ({smiles}).",
                    op="stereoisomers",
                )
            candidate = embedded
        candidates.append(
            {
                "label": f"s{len(candidates) + 1}",
                "smiles": smiles,
                "formula": rdMolDescriptors.CalcMolFormula(candidate),
                "atoms": _coords(candidate),
                "geometry": {"source": source},
            }
        )

    if not candidates:
        fail("coverage-refused", "RDKit enumerated only duplicate stereoisomers.", op="stereoisomers")

    return {
        "program": "RDKit",
        "options": {"maxCandidates": max_candidates, "seed": seed},
        "result": {
            "candidates": candidates,
            "truncated": truncated,
            "rejected": [],
        },
    }
