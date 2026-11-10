#!/usr/bin/env python3
"""Convert a foreign quantum-chemistry log to Avogadro Chemical JSON.

This is NodeChem Studio's cclib sidecar (issue 273). It is deliberately a
**converter**, not a parser: cclib does the format work, this script checks the
evidence and writes the one JSON shape `parseCjson()` already imports.

Usage:
    python ncs_cclib.py convert run.log run.cjson
    python ncs_cclib.py convert run.log run.cjson --json
    python ncs_cclib.py --version

cclib is a user-installed dependency (BSD-3). This file never bundles it and
never writes a deck for another program; it only reads a log that has already
finished. A log without cclib's normal-termination evidence is refused rather
than imported with a partial geometry.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile

SCHEMA = "nodechem.cclib.v1"
CJSON_SCHEMA = "chemical json"
SUPPORTED_INPUTS = (".log", ".out", ".log.gz", ".out.gz")
WAVEFUNCTION_INPUTS = (".wfn", ".wfx", ".fchk", ".fch", ".molden", ".chk", ".cube")


class ConversionError(Exception):
    def __init__(self, message: str, code: str = "cclib-convert"):
        super().__init__(message)
        self.code = code


def _version() -> str:
    try:
        import cclib  # type: ignore[import-not-found]  # version probe, deliberately optional
    except ImportError:
        return ""
    return str(getattr(cclib, "__version__", ""))


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _finite(value):
    """A JSON-safe finite number, or None. Never NaN/Infinity in the cjson."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and number not in (float("inf"), float("-inf")) else None


def _last_scalar(value):
    """Last finite scalar in an arbitrarily nested cclib energy array."""
    if value is None:
        return None
    # cclib returns numpy arrays, not lists; normalise without importing numpy
    # (cclib may be built against a different numpy than the app's Python).
    if hasattr(value, "tolist"):
        value = value.tolist()
    if isinstance(value, (list, tuple)):
        for item in reversed(value):
            found = _last_scalar(item)
            if found is not None:
                return found
        return None
    return _finite(value)


def _energy_of(data):
    """Highest-level total energy cclib parsed, with the label it belongs to."""
    for attr, label in (("ccenergies", "CC"), ("mpenergies", "MP2"), ("scfenergies", "SCF")):
        value = _last_scalar(getattr(data, attr, None))
        if value is not None:
            return value, label
    return None, None


def _coords_of(data):
    coords = getattr(data, "atomcoords", None)
    if coords is None or len(coords) == 0:
        raise ConversionError("cclib parsed no atom coordinates; the log carries no geometry.", "cclib-geometry")
    # cclib returns (frames, atoms, 3); the last frame is the final geometry.
    last = coords[-1]
    if len(last) == 0:
        raise ConversionError("cclib parsed an empty final geometry.", "cclib-geometry")
    return [[_finite(x), _finite(y), _finite(z)] for x, y, z in last]


def _element_symbol(number: int) -> str:
    symbols = (
        "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne",
        "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar", "K", "Ca",
        "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn",
        "Ga", "Ge", "As", "Se", "Br", "Kr", "Rb", "Sr", "Y", "Zr",
        "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn",
        "Sb", "Te", "I", "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd",
        "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb",
        "Lu", "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg",
        "Tl", "Pb", "Bi", "Po", "At", "Rn", "Fr", "Ra", "Ac", "Th",
        "Pa", "U", "Np", "Pu", "Am", "Cm", "Bk", "Cf", "Es", "Fm",
        "Md", "No", "Lr", "Rf", "Db", "Sg", "Bh", "Hs", "Mt", "Ds",
        "Rg", "Cn", "Nh", "Fl", "Mc", "Lv", "Ts", "Og",
    )
    if not isinstance(number, int) or number < 1 or number > len(symbols):
        raise ConversionError(f"cclib reported an invalid atomic number {number!r}.", "cclib-atoms")
    return symbols[number - 1]


def _single_job(data):
    """cclib may return one ccData or a list when the source holds several."""
    if isinstance(data, list):
        complete = [entry for entry in data if getattr(entry, "metadata", {}).get("success") is True]
        if not complete:
            raise ConversionError("the file contains no job with normal-termination evidence; "
                                "a truncated or crashed log is not a result.", "cclib-truncated")
        return complete[-1], len(data), len(complete)
    return data, 1, 1 if getattr(data, "metadata", {}).get("success") is True else 0


def convert(input_path: str, output_path: str) -> dict:
    lower = input_path.lower()
    if lower.endswith(WAVEFUNCTION_INPUTS):
        raise ConversionError(
            f"{os.path.basename(input_path)} is a wavefunction/checkpoint file, not a log. "
            "Use the existing .fchk/.molden/.wfn readers; cclib is only for foreign log files.",
            "cclib-wavefunction",
        )
    if not lower.endswith(SUPPORTED_INPUTS):
        raise ConversionError(
            f"{os.path.basename(input_path)} is not a log file this converter accepts "
            f"({', '.join(SUPPORTED_INPUTS)}).",
            "cclib-extension",
        )
    # The native Gaussian parser is calibrated on a real corpus; cclib must
    # never become a second, weaker reader for it.
    if not lower.endswith(".gz"):
        with open(input_path, "rb") as handle:
            head = handle.read(8192)
        if b"Gaussian" in head or b"Entering Link 1" in head:
            raise ConversionError(
                f"{os.path.basename(input_path)} is Gaussian output; NodeChem's native Gaussian parser "
                "is canonical for it and cclib is not used as a second reader.",
                "cclib-native-parser",
            )
    try:
        import cclib  # type: ignore[import-not-found]  # user-installed, never a package dependency
    except ImportError as exc:  # named, not a generic traceback
        raise ConversionError(
            "Python could not import cclib. Install it in the configured interpreter with "
            "`pip install cclib`; cclib is user-installed and is not bundled with NodeChem Studio.",
            "cclib-missing",
        ) from exc

    try:
        parsed = cclib.io.ccread(input_path)
    except Exception as exc:
        raise ConversionError(
            f"cclib could not read {os.path.basename(input_path)}: {type(exc).__name__}: {exc}",
            "cclib-read",
        ) from exc
    if parsed is None:
        raise ConversionError("cclib returned no data for this log.", "cclib-read")

    data, jobs, complete_jobs = _single_job(parsed)
    metadata = getattr(data, "metadata", {}) or {}
    if metadata.get("success") is not True:
        raise ConversionError(
            "the log carries no normal-termination evidence (cclib metadata.success is not true); "
            "a truncated or crashed log is refused rather than imported with a partial geometry.",
            "cclib-truncated",
        )

    coords = _coords_of(data)
    atomnos = list(getattr(data, "atomnos", []))
    if len(atomnos) != len(coords):
        raise ConversionError("cclib's element list and coordinate list disagree in length.", "cclib-atoms")
    energy, energy_kind = _energy_of(data)
    charge = getattr(data, "charge", None)
    try:
        charge = int(charge)
    except (TypeError, ValueError):
        charge = 0
    try:
        multiplicity = int(getattr(data, "mult", None) or 1)
    except (TypeError, ValueError):
        multiplicity = 1

    methods = metadata.get("methods") or []
    method = str(methods[-1]) if methods else ""
    basis = str(metadata.get("basis_set") or "")
    program = str(metadata.get("package") or "unknown")
    version = str(metadata.get("package_version") or "")
    source_sha256 = _sha256(input_path)
    origin = {
        "program": program,
        "version": version,
        "method": method,
        "basis": basis,
        "cclibVersion": _version(),
        "source": os.path.basename(input_path),
        "sourceSha256": source_sha256,
        "jobs": jobs,
        "completeJobs": complete_jobs,
    }
    molecule = {
        "atoms": [{"element": _element_symbol(int(number or 0)), "atomicNumber": int(number or 0)} for number in atomnos],
        "conformer": {"position": [coordinate for atom in coords for coordinate in atom]},
        "bonds": [],
        "formalCharge": charge,
        "multiplicity": multiplicity,
    }
    document = {
        "chemical json": 0,
        "name": os.path.splitext(os.path.basename(input_path))[0],
        "molecule": molecule,
        "properties": {
            "charge": charge,
            "multiplicity": multiplicity,
            "energy": {"total": energy, "kind": energy_kind},
        },
        "origin": origin,
        "ncs": {
            "schema": SCHEMA,
            "sourceSha256": source_sha256,
            "energyKind": energy_kind,
            "jobs": jobs,
            "completeJobs": complete_jobs,
            "warnings": (
                ["cclib did not report a multiplicity; 1 was used."] if getattr(data, "mult", None) is None else []
            ),
        },
    }
    text = json.dumps(document, indent=2, sort_keys=False) + "\n"
    target = os.path.abspath(output_path)
    directory = os.path.dirname(target) or "."
    os.makedirs(directory, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".ncs-cclib-", suffix=".cjson", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(temporary, target)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    return {
        "ok": True,
        "schema": SCHEMA,
        "output": target,
        "bytes": len(text.encode("utf-8")),
        "origin": origin,
        "atoms": len(coords),
        "charge": charge,
        "multiplicity": multiplicity,
        "energyHartree": energy,
        "energyKind": energy_kind,
        "warnings": document["ncs"]["warnings"],
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Convert a foreign quantum-chemistry log to Chemical JSON")
    parser.add_argument("command", nargs="?", choices=("convert",), help="convert <input.log> <output.cjson>")
    parser.add_argument("input", nargs="?")
    parser.add_argument("output", nargs="?")
    parser.add_argument("--version", action="store_true", help="print the cclib version as JSON")
    parser.add_argument("--json", action="store_true", help="print the conversion summary as JSON")
    args = parser.parse_args(argv)

    if args.version:
        version = _version()
        print(json.dumps({"ok": bool(version), "cclibVersion": version,
                          "message": "" if version else "cclib is not importable by this interpreter"}))
        return 0 if version else 3
    if args.command != "convert" or not args.input or not args.output:
        parser.print_usage(sys.stderr)
        return 2
    try:
        summary = convert(args.input, args.output)
    except ConversionError as exc:
        print(json.dumps({"ok": False, "code": exc.code, "message": str(exc)}), file=sys.stderr)
        return 3
    if args.json:
        print(json.dumps(summary, sort_keys=False))
    else:
        print(summary["output"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
