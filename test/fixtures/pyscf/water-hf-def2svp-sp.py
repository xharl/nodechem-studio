#!/usr/bin/env python3
# NodeChem Studio - generated PySCF deck.
#
# This file is a fixed, reviewed Python program. The calculation parameters
# are the base64-encoded JSON document below; no project field is interpolated
# into this script as executable code. Edit and re-run at your own risk.
import base64
import json
import math
import os
import sys
import traceback

_DATA = json.loads(base64.b64decode("eyJzY2hlbWEiOiJub2RlY2hlbS5weXNjZi52MSIsInRpdGxlIjoiaGYtc3AiLCJtZXRob2RLZXkiOiJoZiIsIm1ldGhvZExhYmVsIjoiSEYiLCJ4YyI6bnVsbCwiYmFzaXNLZXkiOiJkZWYyLXN2cCIsImJhc2lzTGFiZWwiOiJkZWYyLVNWUCIsImJhc2lzIjoiZGVmMi1zdnAiLCJlY3AiOmZhbHNlLCJjaGFyZ2UiOjAsIm11bHRpcGxpY2l0eSI6MSwicmVmZXJlbmNlIjoicmhmIiwiam9iVHlwZSI6IlNQIiwiYWN0aXZlU3BhY2UiOm51bGwsInRkU3RhdGVzIjpudWxsLCJzb2x2YXRpb24iOm51bGwsImRlbnNpdHlGaXQiOnRydWUsImdyaWRMZXZlbCI6bnVsbCwibWF4Q3ljbGUiOjEwMCwiY29udlRvbCI6MWUtMTAsIm1heFN0ZXBzIjoxMDAsImhlc3NpYW5NYXhBdG9tcyI6NjAsImF0b21zIjpbeyJlbGVtZW50IjoiTyIsIngiOjAsInkiOjAsInoiOjAuMTE3M30seyJlbGVtZW50IjoiSCIsIngiOjAsInkiOjAuNzU3MiwieiI6LTAuNDY5Mn0seyJlbGVtZW50IjoiSCIsIngiOjAsInkiOi0wLjc1NzIsInoiOi0wLjQ2OTJ9XX0=").decode("utf-8"))
_SCHEMA = "nodechem.pyscf.v1"
_BEGIN = "NCS-PYSCF-RESULT-BEGIN"
_END = "NCS-PYSCF-RESULT-END"


def _clean(value):
    """JSON-safe copy: non-finite floats become null, numpy scalars become numbers."""
    if isinstance(value, dict):
        return {str(key): _clean(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(item) for item in value]
    if isinstance(value, (bool, str)) or value is None:
        return value
    if isinstance(value, int):
        return int(value)
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    return number if math.isfinite(number) else None


def _record_path():
    return os.path.splitext(os.path.abspath(__file__))[0] + ".json"


def _emit(record):
    text = json.dumps(_clean(record), indent=2, sort_keys=True)
    try:
        with open(_record_path(), "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
    except OSError:
        pass
    sys.stdout.write("\n" + _BEGIN + "\n" + text + "\n" + _END + "\n")
    sys.stdout.flush()


def _base_record(data):
    return {
        "schema": _SCHEMA,
        "engine": "pyscf",
        "ok": False,
        "method": data.get("methodLabel"),
        "methodKey": data.get("methodKey"),
        "basis": data.get("basisLabel"),
        "basisKey": data.get("basisKey"),
        "jobType": data.get("jobType"),
        "charge": data.get("charge"),
        "multiplicity": data.get("multiplicity"),
        "reference": data.get("reference"),
        "densityFit": bool(data.get("densityFit")),
        "ecp": bool(data.get("ecp")),
        "activeSpace": data.get("activeSpace"),
        "solvation": None,
        "energy": None,
        "scfEnergy": None,
        "correlationEnergy": None,
        "triplesCorrection": None,
        "converged": False,
        "scfConverged": False,
        "nIter": None,
        "moEnergies": None,
        "nBasis": None,
        "geometry": None,
        "frequencies": None,
        "hessian": None,
        "hessianOmitted": False,
        "optimization": None,
        "thermochemistry": None,
        "excitedStates": None,
        "pyscfVersion": None,
        "warnings": [],
        "error": None,
    }


def _fail(record, stage, exc):
    record["ok"] = False
    record["error"] = {
        "stage": stage,
        "type": type(exc).__name__,
        "message": str(exc),
        "traceback": traceback.format_exc(limit=8).splitlines()[-8:],
    }
    _emit(record)
    return 1


def _reference(data):
    ref = str(data.get("reference") or "").strip().lower()
    if ref not in ("rhf", "uhf", "rohf"):
        ref = "rhf" if int(data.get("multiplicity", 1)) == 1 else "uhf"
    # PySCF's CASSCF takes an RHF/ROHF reference; a UHF reference is not a
    # valid starting point for the orbital optimiser.
    if str(data.get("methodKey")) == "casscf" and ref == "uhf":
        ref = "rohf"
    return ref


def _build_mol(gto, data):
    atoms = []
    for entry in data["atoms"]:
        atoms.append([str(entry["element"]), (
            float(entry["x"]), float(entry["y"]), float(entry["z"]),
        )])
    kwargs = {
        "atom": atoms,
        "basis": data["basis"],
        "charge": int(data["charge"]),
        "spin": int(data["multiplicity"]) - 1,
        "unit": "Angstrom",
        "verbose": int(data.get("verbose", 3)),
    }
    if data.get("ecp"):
        kwargs["ecp"] = data["basis"]
    return gto.M(**kwargs)


def _new_scf(scf, dft, mol, data):
    method = str(data["methodKey"])
    ref = _reference(data)
    if method in ("hf", "mp2", "ccsd", "ccsd(t)", "casscf"):
        maker = {"rhf": scf.RHF, "uhf": scf.UHF, "rohf": scf.ROHF}[ref]
        mf = maker(mol)
    else:
        maker = {"rhf": dft.RKS, "uhf": dft.UKS, "rohf": dft.ROKS}[ref]
        mf = maker(mol, xc=data["xc"])
    if bool(data.get("densityFit")):
        mf = mf.density_fit()
    mf.max_cycle = int(data.get("maxCycle", 100))
    mf.conv_tol = float(data.get("convTol", 1.0e-10))
    if hasattr(mf, "grids") and data.get("gridLevel"):
        mf.grids.level = int(data["gridLevel"])
    return mf


def _apply_pcm(solvent, method, data):
    request = data.get("solvation")
    if not request:
        return method
    wrapped = solvent.PCM(method, request["solvent"])
    # PySCF's own default is C-PCM; the app maps its "PCM" choice to IEF-PCM
    # so the two models are distinct in the record.
    wrapped.with_solvent.method = "IEF-PCM" if request["model"] == "PCM" else "C-PCM"
    return wrapped


def _scf_status(record, mf):
    record["scfEnergy"] = float(mf.e_tot)
    record["scfConverged"] = bool(mf.converged)
    record["nIter"] = int(getattr(mf, "cycles", 0) or 0)
    record["moEnergies"] = [float(value) for value in mf.mo_energy]
    record["nBasis"] = int(mf.mol.nao)


def _geometry(mol):
    coords = mol.atom_coords(unit="Angstrom")
    return [
        {
            "element": mol.atom_symbol(index),
            "x": float(coords[index][0]),
            "y": float(coords[index][1]),
            "z": float(coords[index][2]),
        }
        for index in range(mol.natm)
    ]


def _frequency_record(mf, include_hessian):
    from pyscf.hessian import thermo
    hessian = mf.Hessian().kernel()
    analysis = thermo.harmonic_analysis(mf.mol, hessian)
    values = [float(value) for value in analysis["freq_wavenumber"]]
    imaginary = [value for value in values if value < -0.001]
    record = {
        "count": len(values),
        "values": values,
        "imaginaryCount": len(imaginary),
        "imaginaryValues": imaginary,
        "minImaginary": min(imaginary) if imaginary else None,
    }
    flat = []
    for i in range(hessian.shape[0]):
        for j in range(hessian.shape[1]):
            for k in range(hessian.shape[2]):
                for l in range(hessian.shape[3]):
                    flat.append(float(hessian[i, j, k, l]))
    if include_hessian:
        record["hessian"] = flat
        record["hessianShape"] = list(hessian.shape)
    try:
        values_au = analysis["freq_au"]
        terms = thermo.thermo(mf, values_au, 298.15, 101325)
        record["thermochemistry"] = {
            "zpeHartree": float(terms["ZPE"][0]),
            "enthalpyHartree": float(terms["H_tot"][0]),
            "freeEnergyHartree": float(terms["G_tot"][0]),
            "temperatureK": 298.15,
        }
    except Exception as exc:  # thermochemistry is optional, never the result
        record["thermochemistryError"] = "%s: %s" % (type(exc).__name__, exc)
    return record


def main():
    data = _DATA
    record = _base_record(data)
    stage = "import"
    try:
        import pyscf
        from pyscf import gto, scf, dft, mp, cc, mcscf, solvent
        record["pyscfVersion"] = str(getattr(pyscf, "__version__", "unknown"))

        stage = "molecule"
        mol = _build_mol(gto, data)
        record["nBasis"] = int(mol.nao)
        record["geometry"] = _geometry(mol)

        stage = "scf"
        method = str(data["methodKey"])
        job_type = str(data.get("jobType") or "SP")
        needs_scf = method != "casscf"
        if needs_scf:
            mf = _new_scf(scf, dft, mol, data)
            if data.get("solvation"):
                mf = _apply_pcm(solvent, mf, data)
            mf.run()
            _scf_status(record, mf)
            if not mf.converged:
                record["converged"] = False
                record["error"] = {
                    "stage": "scf",
                    "type": "SCFNotConverged",
                    "message": "SCF did not converge after %d cycles" % record["nIter"],
                }
                record["solvation"] = data.get("solvation")
                _emit(record)
                return 1
            record["energy"] = float(mf.e_tot)
        else:
            # CASSCF needs a converged RHF/ROHF reference.
            mf = _new_scf(scf, dft, mol, data)
            mf.run()
            _scf_status(record, mf)
            if not mf.converged:
                record["error"] = {
                    "stage": "scf",
                    "type": "SCFNotConverged",
                    "message": "SCF did not converge after %d cycles" % record["nIter"],
                }
                _emit(record)
                return 1

        if job_type == "TD-DFT":
            # Singlet roots on a converged HF/DFT reference. Triplets, solvated
            # references and post-HF references are refused by name in the
            # builder; this branch never guesses one.
            if method not in ("hf", "b3lyp", "pbe0", "m06-2x"):
                raise RuntimeError(
                    "PySCF TD-DFT in this build is limited to HF and DFT references; "
                    "%s is refused by name" % data.get("methodLabel")
                )
            if data.get("solvation"):
                raise RuntimeError(
                    "A solvated PySCF reference is a single point in this build; "
                    "TD-DFT on it is refused by name"
                )
            nstates = int(data.get("tdStates") or 0)
            if nstates < 1:
                raise RuntimeError(
                    "TD-DFT needs at least one excited state; set States to a positive whole number"
                )
            stage = "tddft"
            from pyscf import tdscf
            td = tdscf.TDDFT(mf)
            td.nstates = nstates
            td.kernel()
            energies = [float(value) for value in td.e]
            dipoles = td.transition_dipole()
            strengths = td.oscillator_strength()
            states = []
            for index, value in enumerate(energies):
                if value <= 0.0:
                    continue
                vector = None
                if index < len(dipoles):
                    vector = [float(component) for component in dipoles[index]]
                strength = None
                if index < len(strengths):
                    strength = float(strengths[index])
                states.append({
                    "index": len(states) + 1,
                    "multiplicity": 1,
                    "energyHartree": float(value),
                    "energyEv": float(value) * 27.211386245988,
                    "wavelengthNm": (1239.841984 / (float(value) * 27.211386245988)),
                    "oscillatorStrength": strength,
                    "transitionDipoleAu": vector,
                })
            if len(states) == 0:
                raise RuntimeError("TD-DFT returned no positive excitation energy")
            record["excitedStates"] = {
                "requested": nstates,
                "source": "pyscf-tddft",
                "states": states,
            }
            record["energy"] = float(mf.e_tot)
            record["converged"] = True
            record["ok"] = True
            record["solvation"] = None
            _emit(record)
            return 0

        if job_type in ("Opt", "Opt Freq"):
            if method not in ("hf", "b3lyp", "pbe0", "m06-2x"):
                raise RuntimeError(
                    "PySCF optimisation in this build is limited to HF and DFT; "
                    "%s gradients are refused by name" % data.get("methodLabel")
                )
            if data.get("solvation"):
                raise RuntimeError(
                    "A solvated PySCF block is a single point in this build; "
                    "optimisation and frequencies are refused by name"
                )
            stage = "optimization"
            from pyscf.geomopt import geometric_solver
            steps = {"count": 0}

            def _count_step(env):
                steps["count"] += 1

            opt_converged, mol_eq = geometric_solver.kernel(
                mf,
                assert_convergence=False,
                maxsteps=int(data.get("maxSteps", 100)),
                callback=_count_step,
            )
            # geomeTRIC resets the mean-field object's energy; a fresh SCF at
            # the final geometry is the number this job reports.
            opt_mf = _new_scf(scf, dft, mol_eq, data)
            opt_mf.run()
            _scf_status(record, opt_mf)
            record["converged"] = bool(opt_mf.converged)
            record["geometry"] = _geometry(mol_eq)
            record["optimization"] = {
                "attempted": True,
                "converged": bool(opt_converged and opt_mf.converged),
                "cycles": steps["count"] if steps["count"] > 0 else None,
                "maxSteps": int(data.get("maxSteps", 100)),
            }
            if not record["converged"]:
                record["error"] = {
                    "stage": "optimization",
                    "type": "SCFNotConverged",
                    "message": "SCF at the final geometry did not converge after %d cycles" % record["nIter"],
                }
                _emit(record)
                return 1
            if not opt_converged:
                # The geometry is the last one reached; the gates decide
                # whether that is a result. No energy is invented.
                record["energy"] = float(opt_mf.e_tot)
                _emit(record)
                return 0
            mf = opt_mf
            mol = mol_eq
            stage = "frequencies" if job_type == "Opt Freq" else "result"
            if job_type == "Opt Freq":
                include = int(mol.natm) <= int(data.get("hessianMaxAtoms", 60))
                record["frequencies"] = _frequency_record(mf, include)
                record["hessian"] = record["frequencies"].get("hessian")
                record["hessianOmitted"] = not include
            record["energy"] = float(mf.e_tot)
            record["converged"] = True
            record["ok"] = True
            record["solvation"] = data.get("solvation")
            _emit(record)
            return 0

        stage = "correlation"
        if method in ("mp2", "ccsd", "ccsd(t)"):
            if data.get("solvation"):
                raise RuntimeError(
                    "PySCF PCM is applied to the SCF reference; a %s energy on top of it "
                    "has no solvent response in this build, so the combination is refused by name"
                    % data.get("methodLabel")
                )
            if method == "mp2":
                correlated = mp.MP2(mf).run()
                record["energy"] = float(correlated.e_tot)
                record["correlationEnergy"] = float(correlated.e_corr)
                # MP2 has no SCF-like convergence flag of its own; the reference
                # SCF converged above, so the job is converged.
                record["converged"] = True
            else:
                correlated = cc.CCSD(mf).run()
                energy = float(correlated.e_tot)
                record["correlationEnergy"] = float(correlated.e_corr)
                record["converged"] = bool(correlated.converged)
                if method == "ccsd(t)":
                    triples = float(correlated.ccsd_t())
                    record["triplesCorrection"] = triples
                    energy += triples
                record["energy"] = energy
            if not record["converged"]:
                record["error"] = {
                    "stage": "correlation",
                    "type": "CorrelationNotConverged",
                    "message": "%s did not converge" % data.get("methodLabel"),
                }
                _emit(record)
                return 1
        elif method == "casscf":
            stage = "casscf"
            space = data.get("activeSpace") or {}
            ncas = int(space.get("orbitals", 0))
            nelecas = int(space.get("electrons", 0))
            if ncas < 1 or nelecas < 1:
                raise RuntimeError(
                    "CASSCF needs an active space: set Active space to electrons,orbitals "
                    "(for example 2,2 for CAS(2,2))"
                )
            mc = mcscf.CASSCF(mf, ncas, nelecas)
            if data.get("solvation"):
                mc = _apply_pcm(solvent, mc, data)
            mc.run()
            record["scfEnergy"] = float(mf.e_tot)
            record["energy"] = float(mc.e_tot)
            record["converged"] = bool(mc.converged)
            record["moEnergies"] = [float(value) for value in mc.mo_energy]
            record["nBasis"] = int(mc.mol.nao)
            if not record["converged"]:
                record["error"] = {
                    "stage": "casscf",
                    "type": "CASSCFNotConverged",
                    "message": "CASSCF did not converge",
                }
                _emit(record)
                return 1
        else:
            # HF / DFT single point.
            record["energy"] = float(mf.e_tot)
            record["converged"] = bool(mf.converged)

        if job_type == "Freq":
            if method not in ("hf", "b3lyp", "pbe0", "m06-2x"):
                raise RuntimeError(
                    "PySCF frequencies in this build are limited to HF and DFT; "
                    "%s has no analytic Hessian here and is refused by name"
                    % data.get("methodLabel")
                )
            if data.get("solvation"):
                raise RuntimeError(
                    "A solvated PySCF block is a single point in this build; "
                    "frequencies are refused by name"
                )
            stage = "frequencies"
            include = int(mol.natm) <= int(data.get("hessianMaxAtoms", 60))
            record["frequencies"] = _frequency_record(mf, include)
            record["hessian"] = record["frequencies"].get("hessian")
            record["hessianOmitted"] = not include
            record["energy"] = float(mf.e_tot)

        record["ok"] = True
        record["solvation"] = data.get("solvation")
        _emit(record)
        return 0
    except Exception as exc:
        return _fail(record, stage, exc)


if __name__ == "__main__":
    sys.exit(main())
