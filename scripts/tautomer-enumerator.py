#!/usr/bin/env python3
"""Tautomer/protomer enumerator sidecar (issue #226).

One JSON object on stdin, one JSON object on stdout. Nothing is read from
argv: the app spawns this file with `shell: false` and writes the request to
the child's stdin, exactly like `aimnet2-scorer.py`.

Request
-------

    {"protocol": "nodechem-tautomers/1",
     "title": "acetylacetone",
     "charge": 0,
     "multiplicity": 1,
     "atoms": [{"element": "O", "x": 0.0, "y": 0.0, "z": 0.0}, ...],
     "options": {"ruleset": "rdkit-default",
                 "maxCandidates": 16,
                 "maxTransforms": 1000,
                 "relaxGeometry": true,
                 "removeSp3Stereo": false,
                 "removeBondStereo": false}}

Response (success)
------------------

    {"protocol": "nodechem-tautomers/1",
     "ok": true,
     "program": "RDKit",
     "version": "2026.09.1",
     "ruleset": "rdkit-default",
     "options": {...echoed, with defaults filled in...},
     "input": {"title", "charge", "multiplicity", "atomCount",
               "formula", "smiles"},
     "candidates": [{"id": "t1", "label": "t1", "rank": 1,
                     "smiles": "...", "formula": "...", "atomCount": 15,
                     "heavyAtomCount": 7,
                     "geometry": {"source": "input", "hydrogens": "rdkit-addhs",
                                  "relaxation": "UFF", "converged": true},
                     "atoms": [{"element": "O", "x": ..., ...}, ...]}],
     "rejected": [{"smiles": "...", "reason": "..."}]}

Response (refusal)
------------------

    {"protocol": "nodechem-tautomers/1", "ok": false,
     "error": {"code": "rdkit-missing", "message": "..."}}

A refusal exits 2, so a shell user sees a failure; the app reads the JSON on
stdout either way and never treats a refusal as an empty success.

Chemistry
---------

The enumerator is RDKit's `rdMolStandardize.TautomerEnumerator` — the same
transform set the RDKit community ships, parameterised by MaxTautomers,
MaxTransforms and the stereo-removal flags. Bond orders are perceived from the
input geometry with `rdDetermineBonds.DetermineBonds` (the structure arrives
as XYZ with no bond table), and the hydrogens are re-added per candidate with
`addCoords=True` because a tautomer moves them.

Scope, stated rather than approximated:

  * no pH-dependent protonation (no Epik/Dimorphite, no pKa model): a charge
    state is an input, not something this file guesses;
  * multiplicity must be 1 — `DetermineBonds` assumes a closed shell, so an
    open-shell molecule is refused instead of being given invented bonds;
  * each candidate is a distinct molecule. They are not conformers, and this
    file computes no energies and no Boltzmann populations.
"""

import json
import math
import sys

PROTOCOL = "nodechem-tautomers/1"
PROGRAM = "RDKit"
RULESETS = ("rdkit-default",)

DEFAULT_OPTIONS = {
    "ruleset": "rdkit-default",
    "maxCandidates": 16,
    "maxTransforms": 1000,
    "relaxGeometry": True,
    "removeSp3Stereo": False,
    "removeBondStereo": False,
}

MAX_ATOMS = 1000
MAX_CANDIDATES = 200
MAX_TRANSFORMS = 100000


def fail(code, message, detail=None):
    payload = {"protocol": PROTOCOL, "ok": False, "error": {"code": code, "message": message}}
    if detail:
        payload["error"]["detail"] = str(detail)
    print(json.dumps(payload))
    sys.exit(2)


def read_request():
    try:
        request = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        fail("bad-request", f"Invalid JSON request: {error}")
    if not isinstance(request, dict):
        fail("bad-request", "The request must be one JSON object.")
    if request.get("protocol") != PROTOCOL:
        fail(
            "protocol-mismatch",
            f"This sidecar speaks {PROTOCOL}; the request declared {request.get('protocol')!r}.",
        )
    return request


def normalize_options(raw):
    provided = raw if isinstance(raw, dict) else {}
    options = dict(DEFAULT_OPTIONS)
    ruleset = provided.get("ruleset", DEFAULT_OPTIONS["ruleset"])
    if ruleset not in RULESETS:
        fail(
            "unknown-ruleset",
            f"Ruleset {ruleset!r} is not implemented; this sidecar offers {', '.join(RULESETS)}.",
        )
    options["ruleset"] = ruleset

    def bounded(name, low, high):
        value = provided.get(name, DEFAULT_OPTIONS[name])
        if isinstance(value, bool) or not isinstance(value, int):
            fail("bad-request", f"options.{name} must be an integer.")
        if value < low or value > high:
            fail("bad-request", f"options.{name} must be between {low} and {high}.")
        return value

    options["maxCandidates"] = bounded("maxCandidates", 1, MAX_CANDIDATES)
    options["maxTransforms"] = bounded("maxTransforms", 1, MAX_TRANSFORMS)
    for name in ("relaxGeometry", "removeSp3Stereo", "removeBondStereo"):
        value = provided.get(name, DEFAULT_OPTIONS[name])
        if not isinstance(value, bool):
            fail("bad-request", f"options.{name} must be true or false.")
        options[name] = value
    return options


def xyz_block(atoms):
    lines = [str(len(atoms)), "nodechem tautomer enumeration"]
    for atom in atoms:
        lines.append(
            "{element} {x:.6f} {y:.6f} {z:.6f}".format(
                element=atom["element"], x=atom["x"], y=atom["y"], z=atom["z"]
            )
        )
    return "\n".join(lines) + "\n"


def main():
    request = read_request()
    options = normalize_options(request.get("options"))

    atoms = request.get("atoms")
    if not isinstance(atoms, list) or not atoms:
        fail("bad-request", "The request contains no atoms.")
    if len(atoms) > MAX_ATOMS:
        fail("bad-request", f"The request has {len(atoms)} atoms; the limit is {MAX_ATOMS}.")
    for index, atom in enumerate(atoms):
        if not isinstance(atom, dict) or not isinstance(atom.get("element"), str):
            fail("bad-request", f"Atom {index + 1} has no element symbol.")
        for axis in ("x", "y", "z"):
            value = atom.get(axis)
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
                fail("bad-request", f"Atom {index + 1} has no finite {axis} coordinate.")

    charge = request.get("charge", 0)
    multiplicity = request.get("multiplicity", 1)
    if isinstance(charge, bool) or not isinstance(charge, int) or abs(charge) > 10:
        fail("bad-request", "charge must be an integer between -10 and 10.")
    if isinstance(multiplicity, bool) or not isinstance(multiplicity, int) or not 1 <= multiplicity <= 10:
        fail("bad-request", "multiplicity must be an integer between 1 and 10.")
    if multiplicity != 1:
        fail(
            "open-shell-unsupported",
            f"Multiplicity {multiplicity} is not supported: bond orders are perceived for a closed-shell "
            "molecule, and guessing them for an open shell would invent a structure. Run the neutral "
            "closed-shell form, or supply a bond table.",
        )

    try:
        from rdkit import Chem, RDLogger
        from rdkit.Chem import AllChem, rdMolDescriptors
        from rdkit.Chem.MolStandardize import rdMolStandardize
        from rdkit.Chem import rdDetermineBonds
    except ImportError as error:
        fail(
            "rdkit-missing",
            f"RDKit is not installed in this interpreter: {error}. Point the tautomer sidecar at a "
            "Python with rdkit (BSD-3) installed; CI uses a fake sidecar and needs none.",
        )

    # RDKit logs kekulisation warnings for legitimate tautomers; they are not
    # errors and must not pollute the JSON stream (stdout is the protocol).
    RDLogger.DisableLog("rdApp.*")

    import rdkit

    raw = Chem.MolFromXYZBlock(xyz_block(atoms))
    if raw is None:
        fail("bond-perception-failed", "RDKit could not read the geometry as an XYZ block.")
    try:
        rdDetermineBonds.DetermineBonds(raw, charge=charge)
        Chem.SanitizeMol(raw)
    except Exception as error:  # noqa: BLE001 - RDKit raises several unrelated types
        fail(
            "bond-perception-failed",
            "RDKit could not perceive bonds and bond orders from this geometry at "
            f"charge {charge}: {error}. Supply a molecule with a bond table, or a cleaner geometry.",
        )

    # Tautomer transforms move hydrogens, so they run on the heavy-atom graph
    # with implicit hydrogens and the H's are re-added per candidate. Running
    # them on an explicit-H molecule duplicates hydrogens (measured with RDKit
    # 2026.09.1: C5H5NO became C5H6NO on every candidate).
    heavy = Chem.RemoveHs(raw)
    heavy_smiles = Chem.MolToSmiles(heavy)
    heavy_formula = rdMolDescriptors.CalcMolFormula(heavy)
    input_conformer = Chem.Conformer(heavy.GetConformer()) if heavy.GetNumConformers() else None
    input_symbols = [atom.GetSymbol() for atom in heavy.GetAtoms()]

    enumerator = rdMolStandardize.TautomerEnumerator()
    # Ask for one more than we will keep: reaching that cap is how we know the
    # set was truncated, without parsing RDKit's log.
    enumerator.SetMaxTautomers(options["maxCandidates"] + 1)
    enumerator.SetMaxTransforms(options["maxTransforms"])
    enumerator.SetRemoveSp3Stereo(options["removeSp3Stereo"])
    enumerator.SetRemoveBondStereo(options["removeBondStereo"])
    try:
        enumerated = list(enumerator.Enumerate(heavy))
    except Exception as error:  # noqa: BLE001
        fail("enumeration-failed", f"RDKit's tautomer enumerator failed: {error}")

    candidates = []
    rejected = []
    seen = set()
    truncated = len(enumerated) > options["maxCandidates"]
    for mol in enumerated:
        smiles = Chem.MolToSmiles(mol)
        if smiles in seen:
            rejected.append({"smiles": smiles, "reason": "duplicate of an earlier candidate (same canonical SMILES)"})
            continue
        seen.add(smiles)
        if len(candidates) >= options["maxCandidates"]:
            continue
        index = len(candidates)
        symbols = [atom.GetSymbol() for atom in mol.GetAtoms()]
        notes = []
        # The enumerator preserves atom indices for the transforms it applies,
        # so the input heavy-atom coordinates can be carried over when the
        # element sequence still matches. When it does not, the geometry is
        # re-embedded rather than paired with the wrong atoms.
        if symbols == input_symbols and input_conformer is not None:
            geometry_source = "input"
            mol.RemoveAllConformers()
            mol.AddConformer(Chem.Conformer(input_conformer), assignId=True)
        else:
            geometry_source = "etkdg"
            notes.append("heavy-atom order changed; geometry re-embedded with ETKDGv3")
            mol.RemoveAllConformers()
            AllChem.EmbedMolecule(mol, randomSeed=0xF00D)
        full = Chem.AddHs(mol, addCoords=True)
        relaxation = None
        converged = None
        if options["relaxGeometry"] and full.GetNumConformers() and AllChem.UFFHasAllMoleculeParams(full):
            status = AllChem.UFFOptimizeMolecule(full, maxIters=200)
            relaxation = "UFF"
            converged = status == 0
            if status != 0:
                notes.append("UFF relaxation did not converge in 200 steps; the geometry is a starting point")
        elif options["relaxGeometry"]:
            notes.append("UFF has no parameters for this molecule; hydrogen positions are RDKit's addCoords guess")
        conformer = full.GetConformer()
        out_atoms = []
        for atom_index, atom in enumerate(full.GetAtoms()):
            position = conformer.GetAtomPosition(atom_index)
            out_atoms.append({
                "element": atom.GetSymbol(),
                "x": round(position.x, 6),
                "y": round(position.y, 6),
                "z": round(position.z, 6),
            })
        label = f"t{index + 1}"
        candidates.append({
            "id": label,
            "label": label,
            "rank": index + 1,
            "smiles": smiles,
            "formula": rdMolDescriptors.CalcMolFormula(full),
            "atomCount": full.GetNumAtoms(),
            "heavyAtomCount": full.GetNumHeavyAtoms(),
            "geometry": {
                "source": geometry_source,
                "hydrogens": "rdkit-addhs",
                "relaxation": relaxation,
                "converged": converged,
            },
            "notes": notes,
            "atoms": out_atoms,
        })

    if not candidates:
        fail("no-candidates", "RDKit returned no tautomer candidates for this structure.")

    try:
        from importlib.metadata import version as package_version
        rdkit_version = package_version("rdkit")
    except Exception:  # noqa: BLE001 - a source build reports no distribution
        rdkit_version = getattr(rdkit, "__version__", "unreported")

    print(json.dumps({
        "protocol": PROTOCOL,
        "ok": True,
        "program": PROGRAM,
        "version": str(rdkit_version),
        "ruleset": options["ruleset"],
        "options": options,
        "input": {
            "title": str(request.get("title") or ""),
            "charge": charge,
            "multiplicity": multiplicity,
            "atomCount": len(atoms),
            "formula": heavy_formula,
            "smiles": heavy_smiles,
        },
        "truncated": truncated,
        "candidates": candidates,
        "rejected": rejected,
    }))


if __name__ == "__main__":
    main()
