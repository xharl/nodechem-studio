# Reproducing Molecules 2024, 29(8), 1808 — APN 1 solvatochromism

**Paper.** "Synthesis, Cytotoxicity, and Photophysical Investigations of 2-Amino-4,6-diphenylnicotinonitriles
as Potential Fluorescent Sensors", *Molecules* **2024**, 29(8), 1808. Open access, CC BY 4.0.
Protocol reproduced from section 3.4, "Computational Studies of APNs 1–6".

**Project.** [`examples/apn-fluorescence.ncs`](../../examples/apn-fluorescence.ncs) — 7 calculation blocks and one
note block, 34 atoms (C18H13N3), validated by `ncs validate` and pinned by `test/apnReproduction.test.js`.

---

## What the paper did

Verbatim, from section 3.4 (emphasis added):

> The initial molecular structures … were **optimized at the DFT/b3lyp/6-311++g(d,p) level using Gaussian 16,
> Revision C.01**. Geometry-optimized structures were subjected to further **TD-DFT calculation … computing
> 5 singlet excited states** on top of the structures obtained at the TD-DFT/b3lyp/6-311++g(d,p) level of theory
> with the **solvent polarizable continuum model (PCM) in toluene, tetrahydrofuran (THF), dichloromethane (DCM),
> dimethyl sulfoxide (DMSO), and methanol** solvents. **A vibrational analysis was carried out** for each optimized
> molecule to ensure that they were at a vibrational energy minimum and had no imaginary frequencies.

Reported targets for compound **1**:

| Quantity | Value (methanol) | Value (DMSO) |
| --- | --- | --- |
| Band 1 | 408.18 nm — 3.037 eV, f = 0.640 (HOMO→LUMO) | 408.14 nm — 3.037 eV, f = 0.640 |
| Band 2 | ~309 nm — 4.009 eV, f = 0.412 | ~309 nm — 4.009 eV, f = 0.412 |

## How it maps onto NodeChem

| Paper step | Block | Route NodeChem generates |
| --- | --- | --- |
| Optimize at B3LYP/6-311++G(d,p) | `apn-opt` | `#p B3LYP/6-311++G(d,p) Opt=Tight Integral=UltraFine` |
| Vibrational analysis, no imaginary modes | `apn-freq` | `#p B3LYP/6-311++G(d,p) Freq` + gate "0 imaginary modes" |
| TD-DFT, 5 singlet states, PCM toluene | `apn-td-toluene` | `#p B3LYP/6-311++G(d,p) SP TD=(NStates=5) SCRF=(PCM,Solvent=Toluene) Geom=Check Guess=Read` |
| … THF / DCM / DMSO / methanol | `apn-td-{thf,dcm,dmso,meoh}` | the same, with `Solvent=THF`, `Dichloromethane`, `DMSO`, `Methanol` |

The five TD blocks are checkpoint children of the frequency block, so each one reads the optimised geometry
and the ground-state orbitals from disk rather than re-optimising.

```console
$ ncs validate examples/apn-fluorescence.ncs
{"ok": true, "errors": [], "warnings": [], "validity": {"overall": "unknown", …}}

$ ncs build-input examples/apn-fluorescence.ncs --node apn-td-dmso
%Mem=4GB
%NProcShared=4
%Chk=apn_td_dmso.chk
%OldChk=apn_freq.chk
#p B3LYP/6-311++G(d,p) SP TD=(NStates=5) SCRF=(PCM,Solvent=DMSO) Geom=Check Guess=Read
```

The molecule is PubChem CID 668105 (2-amino-4,6-diphenylpyridine-3-carbonitrile), whose 3D conformer
matches the paper's compound **1**; the SDF is imported through the parser added in #79, so the bond
block is carried into the project rather than re-perceived.

## Deviations, stated

1. **`Opt=Tight` and `Integral=UltraFine`** are NodeChem's guidance for any geometry that will be followed by
   a frequency job. The paper states neither. They change the convergence criterion and the integration grid,
   not the method.
2. **No dispersion correction.** Modern presets in NodeChem default to `EmpiricalDispersion=GD3BJ`; this
   project explicitly sets `dispersion: ''` because the paper's route is plain B3LYP. Adding D3 would be a
   *better* calculation and a *worse* reproduction.
3. **The optimisation solvent is unstated.** The paper optimises "at the DFT/b3lyp level" and only introduces
   PCM for the TD step, so this project optimises in the gas phase. If the authors optimised in each solvent,
   five geometry optimisations would be needed instead of one.
4. **PCM cavity settings are unstated** (radii, `Read`/default cavity, non-electrostatic terms). Left at
   Gaussian defaults; this is the largest remaining uncertainty in the protocol.
5. **Temperature is unstated** for the TD step; the paper's figures are labelled 298 K but no `Temperature`
   keyword appears in the described method.

## What this environment cannot do

There is no Gaussian 16 binary on this machine — NodeChem's Gaussian runner and the paper's engine are the
same program, and neither is installed here — so **no number is produced by this reproduction**. What is
verified is that the inputs are runnable and match every keyword the paper states: routes, states, solvent
model, solvent identities, checkpoint chaining and the minimum gate. Running it requires Gaussian 16 (rev.
C.01, the paper's version) and, for the comparison, the paper's own optimised geometry.

## A methodological observation about the paper's "emission" claim

Section 3.4 describes **only** vertical excitations from the ground-state minimum. There is no step that
optimises the S1 surface, and no emission job. Yet Figures 8 and 9 are captioned "TD-DFT-calculated electronic
fluorescence emission spectra". Two signatures agree with that reading:

- the methanol and DMSO values are identical to two decimals (408.18 vs 408.14 nm; both 3.037 eV with f = 0.640),
  which is what vertical absorption with PCM looks like for a weakly solvatochromic state, not what emission
  from a relaxed S1 geometry usually looks like across solvents of very different polarity;
- the oscillator strengths reported for "emission" are absorption quantities: f has meaning for the transition
  from the ground state, not for a radiative rate in the way an emission spectrum would use it.

So the paper's fluorescence numbers are most likely **vertical excitation energies at the S0 geometry**, labelled
as emission. This is a reproduction-relevant ambiguity, not a parsing problem: NodeChem's **Emission from S1**
template (Opt with `TD=(NStates=1,Root=1)`, then TD at that minimum) exists precisely to compute the quantity
the paper says it is reporting, and would give a lower energy and a larger Stokes shift. Anyone comparing the
two must decide which quantity they actually want.

## To go further

- Run the seven inputs with Gaussian 16 C.01 and diff the first excitation energies against the targets above.
- For the descriptors in the paper (HOMO, LUMO, gap, IP, EA, χ, η, σ, ω) NodeChem's parser does **not** yet
  extract orbital energies from the log — the paper reports them from `GaussView` views of the Gaussian output. That is a
  parser gap, not a workflow gap; the route would also want `pop=full` (or an equivalent orbital print) for
  the numbers to be recoverable from the log.
- For an emission-consistent comparison, use the **Emission from S1** template with the same B3LYP/6-311++G(d,p)
  and PCM settings, then compare the two numbers explicitly.
