"""`conformers` — ETKDGv4 + MMFF94/UFF conformer search (ADR 0003 §3.4).

Returns every embedded/optimised geometry with its force-field energy and
convergence flag. It does **not** apply the energy window, RMSD prune or
retention cap: those belong to the app's shared curation, so an RDKit search is
ranked by the same code as CREST and Open Babel.
"""


def run(request):
    from ..common import fail, molecule_from_request

    try:
        from rdkit import Chem
        from rdkit.Chem import AllChem
    except ImportError as error:
        fail("capability-missing", f"This RDKit build does not expose ETKDG/force fields: {error}.", op="conformers")

    options = request.get("options") if isinstance(request.get("options"), dict) else {}

    def integer(key, fallback, minimum, maximum):
        value = options.get(key, fallback)
        if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
            fail("bad-input", f"options.{key} must be an integer between {minimum} and {maximum}.", op="conformers")
        return value

    nconf = integer("nconf", 50, 1, 200)
    seed = integer("seed", 1, 0, 0x7FFFFFFF)
    max_heavy = integer("maxHeavyAtoms", 60, 1, 100)
    threads = integer("threads", 1, 1, 8)
    prune_raw = options.get("pruneRms", 0.5)
    if isinstance(prune_raw, bool) or not isinstance(prune_raw, (int, float)) or not 0 <= float(prune_raw) <= 5:
        fail("bad-input", "options.pruneRms must be a number between 0 and 5.", op="conformers")
    prune_rms = float(prune_raw)
    force_field = str(options.get("forceField") or "MMFF94")
    if force_field not in ("MMFF94", "UFF"):
        fail("bad-input", "options.forceField must be MMFF94 or UFF.", op="conformers")

    mol, _charge, _multiplicity = molecule_from_request(request.get("molecule"), op="conformers")
    try:
        mol = Chem.AddHs(Chem.RemoveHs(mol))
    except Exception:  # noqa: BLE001 - an unusual valence keeps its explicit hydrogens
        mol = Chem.AddHs(mol)
    heavy = mol.GetNumHeavyAtoms()
    if heavy > max_heavy:
        fail(
            "size-refused",
            f"This molecule has {heavy} heavy atoms; the RDKit conformer search is capped at "
            f"{max_heavy}. A larger flexible molecule is not offered as an open-ended search.",
            op="conformers",
        )

    params = AllChem.ETKDGv4()
    params.randomSeed = seed
    params.pruneRmsThresh = prune_rms
    params.numThreads = threads
    try:
        ids = list(AllChem.EmbedMultipleConfs(mol, numConfs=nconf, params=params))
    except Exception as error:  # noqa: BLE001 - RDKit raises several unrelated types
        fail("coverage-refused", f"RDKit could not embed this molecule: {error}.", op="conformers")
    if not ids:
        fail("coverage-refused", "RDKit embedded no conformers for this molecule.", op="conformers")

    actual_force_field = force_field
    warnings = []
    energies = {}
    converged = {}
    try:
        if force_field == "MMFF94" and AllChem.MMFFHasAllMoleculeParams(mol):
            results = AllChem.MMFFOptimizeMoleculeConfs(mol, maxIters=500, numThreads=threads)
        elif force_field == "MMFF94":
            actual_force_field = "UFF"
            warnings.append("MMFF94 has no parameters for this molecule; UFF was used instead.")
            results = AllChem.UFFOptimizeMoleculeConfs(mol, maxIters=500, numThreads=threads)
        else:
            results = AllChem.UFFOptimizeMoleculeConfs(mol, maxIters=500, numThreads=threads)
    except Exception as error:  # noqa: BLE001 - RDKit raises several unrelated types
        fail("op-failed", f"RDKit could not optimise the embedded conformers: {error}.", op="conformers")
    for conformer_id, entry in zip(ids, results):
        # RDKit returns (converged: int, energy: float) per conformer, in order.
        energies[conformer_id] = float(entry[1])
        converged[conformer_id] = int(entry[0]) == 0

    conformers = []
    for conformer_id in ids:
        conformer = mol.GetConformer(conformer_id)
        atoms = []
        for index, atom in enumerate(mol.GetAtoms()):
            position = conformer.GetAtomPosition(index)
            atoms.append(
                {
                    "element": atom.GetSymbol(),
                    "x": float(position.x),
                    "y": float(position.y),
                    "z": float(position.z),
                }
            )
        conformers.append(
            {
                "atoms": atoms,
                "energyKcal": energies[conformer_id],
                "converged": converged[conformer_id],
            }
        )

    if len(conformers) < nconf:
        warnings.append(
            f"ETKDGv4 returned {len(conformers)} of {nconf} requested geometries "
            f"(RMSD pruning at {prune_rms} Å)."
        )

    return {
        "program": "RDKit",
        "options": {
            "nconf": nconf, "seed": seed, "pruneRms": prune_rms, "forceField": force_field,
            "maxHeavyAtoms": max_heavy, "threads": threads,
        },
        "result": {
            "conformers": conformers,
            "forceField": actual_force_field,
            "embedding": "ETKDGv4",
            "seed": seed,
            "threads": threads,
            "heavyAtomCount": heavy,
            "requested": nconf,
            "convergedCount": sum(1 for entry in conformers if entry["converged"]),
            "fallback": "uff" if actual_force_field != force_field else "",
            "warnings": warnings,
        },
    }
