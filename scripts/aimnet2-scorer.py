#!/usr/bin/env python3
"""AIMNet2 scorer sidecar (ADR 0001 §2.10).

Reads one JSON object from stdin:

    {"model": "aimnet2", "charge": 0, "multiplicity": 1,
     "frames": [{"id": "c1", "atoms": [{"element": "O", "x": 0, ...}]}]}

Writes one JSON object to stdout with provenance and one energy per frame:

    {"model": "aimnet2", "version": "...", "weightsSha256": "...",
     "dtype": "float32", "device": "cpu", "cutoffAngstrom": 5.0,
     "charge": 0, "multiplicity": 1,
     "results": [{"id": "c1", "energyEv": -123.4, "forces": [[...], ...]}]}

stdout is the JSON channel and nothing else may write to it: `torch`, `warp` and
`aimnet` print banners on import and on calculator construction ("Warp 1.19.0
initialized: …"), so this process sends `sys.stdout` to stderr before importing
anything and keeps the real handle in `CONTRACT_STDOUT` for the single result
object (issue 317).

This file is optional: `aimnet` and `torch` live in a separate venv, and the app
never installs them. The published distribution is `aimnet` (module
`aimnet.calculators`); a fork that ships the module as `aimnet2` is still
accepted. Point AIMNET2_WEIGHTS at the weights file and run this script with that
venv's python. Without them it exits 2 with a clear message; it does not
fabricate an energy.
"""

import hashlib
import json
import os
import sys

# Before the first import that can print: a library banner on the JSON channel
# breaks the parent's JSON.parse even when the calculation itself succeeded.
CONTRACT_STDOUT = sys.stdout
sys.stdout = sys.stderr

ELEMENTS = [
    "H", "B", "C", "N", "O", "F", "Si", "P", "S", "Cl",
    "As", "Se", "Br", "I",
]
ATOMIC_NUMBERS = {
    "H": 1, "B": 5, "C": 6, "N": 7, "O": 8, "F": 9, "Si": 14, "P": 15,
    "S": 16, "Cl": 17, "As": 33, "Se": 34, "Br": 35, "I": 53,
}
EV_TO_KCAL = 23.060548867
EV_TO_HARTREE = 0.03674932217565499


def fail(message, code=2):
    print(message, file=sys.stderr)
    sys.exit(code)


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_calculator():
    """The calculator class and the distribution that provided it.

    `aimnet` is the published name (PyPI 0.2.6, module `aimnet.calculators`);
    `aimnet2` is only tried if that import fails, for a fork or a future rename.
    """
    try:
        from aimnet.calculators import AIMNet2Calculator
        return AIMNet2Calculator, "aimnet"
    except ImportError:
        pass
    try:
        from aimnet2 import AIMNet2Calculator
        return AIMNet2Calculator, "aimnet2"
    except ImportError as error:
        fail(
            "Neither `aimnet` nor `aimnet2` is importable in this interpreter "
            f"({error}). Use the optional scorer venv (pip install aimnet torch) "
            "and point the run console at this script with that venv's python."
        )


def package_version(name):
    try:
        from importlib.metadata import version
        return version(name)
    except Exception:
        return "unreported"


def main():
    if "--model" not in sys.argv or sys.argv[sys.argv.index("--model") + 1] != "aimnet2":
        fail("This sidecar only implements --model aimnet2.")
    try:
        request = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        fail(f"Invalid JSON request: {error}")

    frames = request.get("frames") or []
    if not frames:
        fail("The request contains no frames.")
    for frame in frames:
        for atom in frame["atoms"]:
            if atom["element"] not in ATOMIC_NUMBERS:
                fail(f"Element {atom['element']} is outside the AIMNet2 model card.")

    weights = os.environ.get("AIMNET2_WEIGHTS", "").strip()
    if not weights or not os.path.isfile(weights):
        fail("AIMNET2_WEIGHTS must name the weights file; install aimnet and torch in a separate venv.")

    try:
        import torch
    except ImportError as error:
        fail(f"torch is not installed in this interpreter: {error}. Use the optional scorer venv.")

    AIMNet2Calculator, package = load_calculator()

    device = os.environ.get("AIMNET2_DEVICE", "cpu")
    dtype = "float64" if torch.get_default_dtype() == torch.float64 else "float32"
    cutoff = float(os.environ.get("AIMNET2_CUTOFF", "5.0"))
    calculator = AIMNet2Calculator(weights)

    charge = float(request.get("charge", 0))
    multiplicity = int(request.get("multiplicity", 1))

    results = []
    for frame in frames:
        atoms = frame["atoms"]
        numbers = torch.tensor(
            [ATOMIC_NUMBERS[atom["element"]] for atom in atoms],
            dtype=torch.long,
        ).unsqueeze(0)
        coords = torch.tensor(
            [[float(atom["x"]), float(atom["y"]), float(atom["z"])] for atom in atoms],
            dtype=torch.get_default_dtype(),
        ).unsqueeze(0)
        # aimnet 0.2.x reads one *batched* structure per call: every tensor
        # carries the batch dimension, and `mult` is part of the batch.
        data = {
            "coord": coords,
            "numbers": numbers,
            "charge": torch.tensor([charge], dtype=torch.get_default_dtype()),
            "mult": torch.tensor([multiplicity], dtype=torch.long),
        }
        output = calculator(data, forces=True)
        energy_ev = float(output["energy"].reshape(-1)[0])
        forces = output.get("forces")
        results.append({
            "id": str(frame["id"]),
            "energyEv": energy_ev,
            "energyKcal": energy_ev * EV_TO_KCAL,
            "energyHartree": energy_ev * EV_TO_HARTREE,
            **({
                # The answer is batched too: (1, N, 3) -> (N, 3) for the caller.
                "forces": forces.detach().cpu().reshape(len(atoms), 3).tolist(),
            } if forces is not None else {}),
        })

    payload = json.dumps({
        "model": "aimnet2",
        "version": package_version(package),
        "weightsSha256": digest(weights),
        "dtype": dtype,
        "device": device,
        "cutoffAngstrom": cutoff,
        "charge": int(charge),
        "multiplicity": multiplicity,
        "results": results,
    })
    print(payload, file=CONTRACT_STDOUT)
    CONTRACT_STDOUT.flush()


if __name__ == "__main__":
    main()
