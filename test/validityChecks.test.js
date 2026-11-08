/**
 * Validity checks (issue #25).
 *
 * Every Gaussian-looking output in this file is synthetic: it is prefixed with
 * `FIXTURE OUTPUT` and reproduces only the record shapes the checks read. No
 * Gaussian executable ran and no value here is a real calculation.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { evaluateGates, parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { parseXtbOutput } from '../src/shared/engines/xtb.js';
import {
  CHECK_STATUS,
  COVALENT_RADII_ANGSTROM,
  GEOMETRY_LIMITS,
  SPIN_CONTAMINATION_LIMITS,
  TS_IMAGINARY_FLOOR_CM1,
  VALIDITY_CHECKS,
  VALIDITY_CHECK_IDS,
  checkChargeMultiplicity,
  checkGeometrySanity,
  checkImaginaryFrequencies,
  checkMethodBasisCompatibility,
  checkOptimizationConvergence,
  checkConformerSpread,
  checkSpinContamination,
  normalizeValidityContext,
  runValidityChecks,
  severityOf,
  summarizeValidity,
} from '../src/shared/validityChecks.js';
import {
  defaultSettings,
  parseProjectText,
  stringifyProject,
  validateProject,
} from '../src/shared/projectSchema.js';

const WATER = [
  { element: 'O', x: 0, y: 0, z: 0.1173 },
  { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
  { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
];

function water(overrides = {}) {
  return { charge: 0, multiplicity: 1, coords: WATER, ...overrides };
}

/** Synthetic output that reproduces only the record shapes the checks read. */
function syntheticOutput({
  method = 'RB3LYP',
  spin = null,
  imaginary = [],
  optimization = true,
  frequencies = true,
} = {}) {
  const modes = [...imaginary, ...[610, 1580, 3650, 3760].slice(0, frequencies ? 4 : 0)];
  return [
    ' FIXTURE OUTPUT — synthetic, not a Gaussian calculation',
    ' This file exists only to exercise the validity checks.',
    '',
    ' Entering Gaussian System, Link 0=g16',
    '',
    ` SCF Done:  E(${method}) =  -76.000000000     A.U. after    8 cycles`,
    ...(spin ? [` S**2 before annihilation     ${spin.before},   after     ${spin.after}`] : []),
    ...(optimization ? [' Optimization completed.', ' Stationary point found.'] : []),
    ...(frequencies
      ? [' Harmonic frequencies (cm**-1), IR intensities',
        ` Frequencies --${modes.map((value) => value.toFixed(4).padStart(13)).join('')}`]
      : []),
    '',
    ' Normal termination of Gaussian 16 at Fri Nov  7 12:00:00 2026.',
    '',
  ].join('\n');
}

function parsedSynthetic(options = {}) {
  return parseGaussianOutput(syntheticOutput(options));
}

/* ── Contract ─────────────────────────────────────────────── */

describe('validity checks — contract', () => {
  it('exposes a stable registry of disableable checks', () => {
    expect(VALIDITY_CHECK_IDS).toEqual([
      'charge-multiplicity',
      'spin-contamination',
      'geometry-sanity',
      'imaginary-frequencies',
      'orbital-descriptors',
      'engine-settings',
      'method-basis-compatibility',
      'opt-convergence',
      'conformer-spread',
    ]);
    expect(VALIDITY_CHECKS.every((check) => Array.isArray(check.phases) && check.phases.length > 0)).toBe(true);
  });

  it('returns the four-key finding contract from every check', () => {
    const checks = [
      checkChargeMultiplicity, checkSpinContamination, checkGeometrySanity,
      checkImaginaryFrequencies, checkMethodBasisCompatibility, checkOptimizationConvergence,
      checkConformerSpread,
    ];
    for (const check of checks) {
      const result = check({});
      expect(Object.keys(result).sort()).toEqual(['evidence', 'id', 'message', 'status']);
      expect(VALIDITY_CHECK_IDS).toContain(result.id);
      expect([CHECK_STATUS.PASS, CHECK_STATUS.FAIL, CHECK_STATUS.WARNING,
        CHECK_STATUS.UNKNOWN, CHECK_STATUS.SKIPPED]).toContain(result.status);
      expect(typeof result.message).toBe('string');
    }
  });

  it('documents its thresholds as exported values', () => {
    expect(GEOMETRY_LIMITS).toMatchObject({
      clash: 0.55, shortBond: 0.75, longBond: 1.20, bond: 1.30,
      linearAngleDeg: 170, acuteAngleDeg: 40,
    });
    expect(SPIN_CONTAMINATION_LIMITS).toEqual({ warn: 0.10, fail: 0.50 });
    expect(TS_IMAGINARY_FLOOR_CM1).toBe(50);
    expect(COVALENT_RADII_ANGSTROM.H).toBeCloseTo(0.31);
  });
});

/* ── Charge / multiplicity ────────────────────────────────── */

describe('charge / multiplicity', () => {
  it('passes a closed-shell water molecule', () => {
    const result = checkChargeMultiplicity({ molecule: water() });
    expect(result.status).toBe('pass');
    expect(result.evidence.electrons).toBe(10);
  });

  it('fails a multiplicity with the wrong electron parity', () => {
    const result = checkChargeMultiplicity({ molecule: water({ multiplicity: 2 }) });
    expect(result.status).toBe('fail');
    expect(severityOf(result.status)).toBe('error');
    expect(result.message).toMatch(/parity/i);
    expect(result.evidence).toMatchObject({ electrons: 10, charge: 0, multiplicity: 2 });
  });

  it('accepts a triplet dioxygen', () => {
    const result = checkChargeMultiplicity({
      molecule: {
        charge: 0,
        multiplicity: 3,
        coords: [{ element: 'O', x: 0, y: 0, z: 0 }, { element: 'O', x: 1.21, y: 0, z: 0 }],
      },
    });
    expect(result.status).toBe('pass');
    expect(result.evidence.electrons).toBe(16);
  });

  it('fails when the charge removes more electrons than the atoms provide', () => {
    const result = checkChargeMultiplicity({
      molecule: { charge: 2, multiplicity: 1, coords: [{ element: 'H', x: 0, y: 0, z: 0 }] },
    });
    expect(result.status).toBe('fail');
    expect(result.message).toMatch(/more electrons/i);
  });

  it('fails a multiplicity that needs more unpaired electrons than exist', () => {
    const result = checkChargeMultiplicity({
      molecule: {
        charge: 0,
        multiplicity: 5,
        coords: [{ element: 'H', x: 0, y: 0, z: 0 }, { element: 'H', x: 0.74, y: 0, z: 0 }],
      },
    });
    expect(result.status).toBe('fail');
    expect(result.message).toMatch(/only 2/);
  });

  it('flags a restricted reference that contradicts the multiplicity', () => {
    const result = checkChargeMultiplicity({
      molecule: water({ multiplicity: 3 }),
      parsed: parsedSynthetic({ method: 'RB3LYP' }),
    });
    expect(result.status).toBe('fail');
    expect(result.message).toMatch(/restricted reference/i);
  });

  it('stays unknown without a geometry instead of passing', () => {
    const result = checkChargeMultiplicity({ molecule: { charge: 0, multiplicity: 1, coords: [] } });
    expect(result.status).toBe('unknown');
    expect(severityOf(result.status)).toBe('info');
  });
});

/* ── Spin contamination ───────────────────────────────────── */

describe('spin contamination', () => {
  it('passes a doublet whose S**2 matches S(S+1)', () => {
    const parsed = parsedSynthetic({ method: 'UB3LYP', spin: { before: 0.7531, after: 0.7500 } });
    expect(parsed.spinContamination).toEqual({ before: 0.7531, after: 0.75 });
    const result = checkSpinContamination({ molecule: water({ multiplicity: 2 }), parsed });
    expect(result.status).toBe('pass');
    expect(result.evidence).toMatchObject({ expected: 0.75, deviation: 0 });
  });

  it('warns above the documented deviation and reports the deviation', () => {
    const parsed = parsedSynthetic({ method: 'UB3LYP', spin: { before: 0.90, after: 0.86 } });
    const result = checkSpinContamination({ molecule: water({ multiplicity: 2 }), parsed });
    expect(result.status).toBe('warning');
    expect(result.evidence.deviation).toBeCloseTo(0.11, 2);
    expect(result.message).toContain('0.11');
  });

  it('fails contamination above the failure limit', () => {
    const parsed = parsedSynthetic({ method: 'UB3LYP', spin: { before: 1.60, after: 1.30 } });
    const result = checkSpinContamination({ molecule: water({ multiplicity: 2 }), parsed });
    expect(result.status).toBe('fail');
    expect(severityOf(result.status)).toBe('error');
    expect(result.evidence.deviation).toBeCloseTo(0.55, 2);
  });

  it('passes a restricted reference by construction', () => {
    const result = checkSpinContamination({
      molecule: water({ multiplicity: 2 }),
      parsed: parsedSynthetic({ method: 'RB3LYP' }),
    });
    expect(result.status).toBe('pass');
    expect(result.evidence.expected).toBe(0.75);
  });

  it('stays unknown when an unrestricted output has no S**2 line', () => {
    const result = checkSpinContamination({
      molecule: water({ multiplicity: 2 }),
      parsed: parsedSynthetic({ method: 'UB3LYP' }),
    });
    expect(result.status).toBe('unknown');
    expect(result.message).toMatch(/S\*\*2/);
  });
});

/* ── Geometry sanity ──────────────────────────────────────── */

describe('geometry sanity', () => {
  it('passes the water geometry', () => {
    const result = checkGeometrySanity({ molecule: water() });
    expect(result.status).toBe('pass');
    expect(result.evidence.pairsChecked).toBeGreaterThan(0);
  });

  it('fails two atoms on top of each other as a clash', () => {
    const result = checkGeometrySanity({
      molecule: {
        charge: 0,
        multiplicity: 1,
        coords: [{ element: 'O', x: 0, y: 0, z: 0 }, { element: 'O', x: 0.45, y: 0, z: 0 }],
      },
    });
    expect(result.status).toBe('fail');
    expect(severityOf(result.status)).toBe('error');
    expect(result.evidence.counts.clashes).toBe(1);
    expect(result.evidence.clashes[0].ratio).toBeLessThan(GEOMETRY_LIMITS.clash);
  });

  it('warns about a stretched bond instead of failing it', () => {
    const result = checkGeometrySanity({
      molecule: {
        charge: 0,
        multiplicity: 1,
        coords: [{ element: 'C', x: 0, y: 0, z: 0 }, { element: 'C', x: 1.90, y: 0, z: 0 }],
      },
    });
    expect(result.status).toBe('warning');
    expect(result.evidence.counts.longBonds).toBe(1);
    expect(result.evidence.longBonds[0].ratio).toBeCloseTo(1.25, 2);
  });

  it('does not judge a contact beyond the bonding cut-off', () => {
    const result = checkGeometrySanity({
      molecule: {
        charge: 0,
        multiplicity: 1,
        coords: [{ element: 'C', x: 0, y: 0, z: 0 }, { element: 'C', x: 2.02, y: 0, z: 0 }],
      },
    });
    expect(result.status).toBe('pass');
    expect(result.evidence.counts.longBonds).toBe(0);
  });

  it('warns about a near-linear angle at a bent oxygen centre', () => {
    const result = checkGeometrySanity({
      molecule: {
        charge: 0,
        multiplicity: 1,
        coords: [
          { element: 'O', x: 0, y: 0, z: 0.1173 },
          { element: 'H', x: 0, y: 0.7572, z: 0.1173 },
          { element: 'H', x: 0, y: -0.7572, z: 0.1173 },
        ],
      },
    });
    expect(result.status).toBe('warning');
    expect(result.evidence.linearAngles).toHaveLength(1);
    expect(result.evidence.linearAngles[0].angle).toBeCloseTo(180, 0);
  });

  it('warns about an acute three-atom arrangement', () => {
    const angle = (20 * Math.PI) / 180;
    const result = checkGeometrySanity({
      molecule: {
        charge: 0,
        multiplicity: 1,
        coords: [
          { element: 'C', x: 0, y: 0, z: 0 },
          { element: 'H', x: 1.09, y: 0, z: 0 },
          { element: 'H', x: 1.09 * Math.cos(angle), y: 1.09 * Math.sin(angle), z: 0 },
        ],
      },
    });
    expect(result.status).toBe('warning');
    expect(result.evidence.acuteAngles).toHaveLength(1);
    expect(result.evidence.acuteAngles[0].angle).toBeCloseTo(20, 0);
  });

  it('stays unknown for an element with no tabulated radius', () => {
    const result = checkGeometrySanity({
      molecule: {
        charge: 0,
        multiplicity: 1,
        coords: [{ element: 'Xe', x: 0, y: 0, z: 0 }, { element: 'Xe', x: 4.0, y: 0, z: 0 }],
      },
    });
    expect(result.status).toBe('unknown');
    expect(result.evidence.missingElements).toContain('Xe');
  });
});

/* ── Imaginary frequencies ────────────────────────────────── */

describe('stationary-point frequencies', () => {
  it('passes a transition state with exactly one imaginary mode', () => {
    const result = checkImaginaryFrequencies({
      settings: { jobType: 'Opt=TS' },
      parsed: parsedSynthetic({ imaginary: [-420.5] }),
    });
    expect(result.status).toBe('pass');
    expect(result.evidence.expectedImaginary).toBe(1);
  });

  it('fails a transition state with no imaginary mode', () => {
    const result = checkImaginaryFrequencies({
      settings: { jobType: 'Opt=TS' },
      parsed: parsedSynthetic({ imaginary: [] }),
    });
    expect(result.status).toBe('fail');
    expect(result.message).toMatch(/exactly one imaginary mode/i);
  });

  it('fails a transition state with two imaginary modes', () => {
    const result = checkImaginaryFrequencies({
      settings: { jobType: 'Opt=TS' },
      parsed: parsedSynthetic({ imaginary: [-420, -120] }),
    });
    expect(result.status).toBe('fail');
    expect(result.evidence.imaginaryCount).toBe(2);
  });

  it('warns about a single imaginary mode below the magnitude floor', () => {
    const result = checkImaginaryFrequencies({
      settings: { jobType: 'Opt=TS' },
      parsed: parsedSynthetic({ imaginary: [-20] }),
    });
    expect(result.status).toBe('warning');
    expect(result.message).toContain('20.0');
  });

  it('passes a minimum with no imaginary mode', () => {
    const result = checkImaginaryFrequencies({
      settings: { jobType: 'Freq' },
      parsed: parsedSynthetic({ imaginary: [] }),
    });
    expect(result.status).toBe('pass');
  });

  it('fails a minimum with an imaginary mode', () => {
    const result = checkImaginaryFrequencies({
      settings: { jobType: 'Opt Freq' },
      parsed: parsedSynthetic({ imaginary: [-88] }),
    });
    expect(result.status).toBe('fail');
    expect(severityOf(result.status)).toBe('error');
  });

  it('skips a job that makes no stationary-point claim', () => {
    const result = checkImaginaryFrequencies({ settings: { jobType: 'SP' }, parsed: parsedSynthetic() });
    expect(result.status).toBe('skipped');
    expect(severityOf(result.status)).toBeNull();
  });
});

/* ── Method / basis compatibility ─────────────────────────── */

describe('method / basis compatibility', () => {
  it('passes B3LYP/def2-SVP for a light-element molecule', () => {
    const result = checkMethodBasisCompatibility({
      settings: { method: 'B3LYP', basis: 'def2-SVP', dispersion: 'GD3BJ' },
      molecule: water(),
    });
    expect(result.status).toBe('pass');
  });

  it('fails a heavy element in a basis with no ECP', () => {
    const result = checkMethodBasisCompatibility({
      settings: { method: 'B3LYP', basis: '6-31G(d)', dispersion: '' },
      molecule: {
        charge: 0,
        multiplicity: 1,
        coords: [{ element: 'I', x: 0, y: 0, z: 0 }, { element: 'H', x: 1.6, y: 0, z: 0 }],
      },
    });
    expect(result.status).toBe('fail');
    expect(severityOf(result.status)).toBe('error');
    expect(result.evidence.heavyElements).toEqual(['I']);
    expect(result.evidence.issues[0].kind).toBe('ecp-missing');
  });

  it('passes a heavy element in an ECP basis whose data ships', () => {
    const result = checkMethodBasisCompatibility({
      settings: { method: 'B3LYP', basis: 'SDD', dispersion: '' },
      molecule: {
        charge: 0,
        multiplicity: 1,
        coords: [{ element: 'Pd', x: 0, y: 0, z: 0 }, { element: 'H', x: 2.0, y: 0, z: 0 }],
      },
    });
    expect(result.status).toBe('pass');
  });

  it('fails an ECP basis whose data does not ship, instead of passing it silently', () => {
    const result = checkMethodBasisCompatibility({
      settings: { method: 'B3LYP', basis: 'SDD', dispersion: '' },
      molecule: {
        charge: 0,
        multiplicity: 1,
        coords: [{ element: 'I', x: 0, y: 0, z: 0 }, { element: 'H', x: 2.0, y: 0, z: 0 }],
      },
    });
    expect(result.status).toBe('fail');
    expect(result.evidence.issues.some((issue) => issue.kind === 'ecp-data-missing')).toBe(true);
  });

  it('warns when a built-in-dispersion functional also gets GD3BJ', () => {
    const result = checkMethodBasisCompatibility({
      settings: { method: 'ωB97X-D', basis: 'def2-SVP', dispersion: 'GD3BJ' },
      molecule: water(),
    });
    expect(result.status).toBe('warning');
    expect(result.evidence.issues[0].kind).toBe('dispersion-redundant');
    expect(result.message).toMatch(/double-count/i);
  });

  it('warns when a semi-empirical method is given an ECP basis', () => {
    const result = checkMethodBasisCompatibility({
      settings: { method: 'AM1', basis: 'LANL2DZ', dispersion: '' },
      molecule: water(),
    });
    expect(result.status).toBe('warning');
    expect(result.evidence.issues[0].kind).toBe('method-ignores-basis');
  });

  it('stays unknown without a geometry', () => {
    const result = checkMethodBasisCompatibility({
      settings: { method: 'B3LYP', basis: '6-31G(d)', dispersion: '' },
      molecule: { charge: 0, multiplicity: 1, coords: [] },
    });
    expect(result.status).toBe('unknown');
  });
});

/* ── Optimisation convergence ─────────────────────────────── */

describe('optimisation convergence', () => {
  it('passes Opt Freq when the optimisation completed before the frequencies', () => {
    const result = checkOptimizationConvergence({
      settings: { jobType: 'Opt Freq' },
      parsed: parsedSynthetic({ optimization: true }),
    });
    expect(result.status).toBe('pass');
  });

  it('fails Opt Freq when frequencies exist without an optimisation-completed record', () => {
    const result = checkOptimizationConvergence({
      settings: { jobType: 'Opt Freq' },
      parsed: parsedSynthetic({ optimization: false }),
    });
    expect(result.status).toBe('fail');
    expect(result.message).toMatch(/minimum claim is not supported/i);
  });

  it('passes a Freq whose upstream optimisation completed', () => {
    const result = checkOptimizationConvergence({
      settings: { jobType: 'Freq' },
      upstream: {
        id: 'opt',
        title: 'Reactant optimization',
        settings: { jobType: 'Opt' },
        state: 'passed',
        parsed: { complete: true, optimization: { completed: true } },
      },
    });
    expect(result.status).toBe('pass');
    expect(result.evidence.source).toBe('upstream');
  });

  it('fails a Freq whose upstream optimisation did not complete', () => {
    const result = checkOptimizationConvergence({
      settings: { jobType: 'Freq' },
      upstream: {
        id: 'opt',
        title: 'Reactant optimization',
        settings: { jobType: 'Opt' },
        state: 'needs-review',
        parsed: { complete: true, optimization: { completed: false } },
      },
    });
    expect(result.status).toBe('fail');
    expect(result.message).toMatch(/did not report "Optimization completed"/);
  });

  it('fails a Freq whose upstream node did not pass its gates', () => {
    const result = checkOptimizationConvergence({
      settings: { jobType: 'Freq' },
      upstream: {
        id: 'opt',
        title: 'Reactant optimization',
        settings: { jobType: 'Opt' },
        state: 'review',
        output: 'r_opt.log',
        parsed: null,
      },
    });
    expect(result.status).toBe('fail');
    expect(result.message).toMatch(/did not pass its gates/i);
  });

  it('stays unknown with no linked optimisation', () => {
    const result = checkOptimizationConvergence({ settings: { jobType: 'Freq' } });
    expect(result.status).toBe('unknown');
  });

  it('skips a plain Opt job, which makes no minimum claim', () => {
    const result = checkOptimizationConvergence({ settings: { jobType: 'Opt' }, parsed: parsedSynthetic() });
    expect(result.status).toBe('skipped');
  });
});

/* ── Runner, phases and disabling ─────────────────────────── */

describe('running checks', () => {
  const context = {
    settings: { jobType: 'Opt=TS', method: 'B3LYP', basis: 'def2-SVP', dispersion: 'GD3BJ' },
    molecule: water({ multiplicity: 2 }),
    parsed: parsedSynthetic({ method: 'UB3LYP', spin: { before: 0.76, after: 0.75 }, imaginary: [-420] }),
  };

  it('runs the post-run checks and omits only pre-run ones', () => {
    const result = runValidityChecks(context, { phase: 'post' });
    expect(result.findings.map((finding) => finding.id).sort()).toEqual([
      'charge-multiplicity',
      'conformer-spread',
      'engine-settings',
      'imaginary-frequencies',
      'method-basis-compatibility',
      'opt-convergence',
      'spin-contamination',
    ]);
    expect(result.findings.every((finding) => finding.phase === 'post')).toBe(true);
  });

  it('attaches a severity to every finding it reports', () => {
    const result = runValidityChecks(context, { phase: 'post' });
    for (const finding of result.findings) {
      expect(finding.severity).toBe(severityOf(finding.status));
      expect(typeof finding.title).toBe('string');
    }
    const charge = result.findings.find((finding) => finding.id === 'charge-multiplicity');
    expect(charge.severity).toBe('error');
  });

  it('runs the pre-run checks and never the post-only ones', () => {
    const result = runValidityChecks(context, { phase: 'pre' });
    expect(result.findings.map((finding) => finding.id).sort()).toEqual([
      'charge-multiplicity',
      'conformer-spread',
      'engine-settings',
      'geometry-sanity',
      'method-basis-compatibility',
      'opt-convergence',
      'orbital-descriptors',
    ]);
  });

  it('removes a disabled check from the result entirely', () => {
    const before = runValidityChecks(context, { phase: 'post' });
    const after = runValidityChecks(context, { phase: 'post', disabled: ['spin-contamination'] });
    expect(before.findings).toHaveLength(7);
    expect(after.findings).toHaveLength(6);
    expect(after.findings.map((finding) => finding.id)).not.toContain('spin-contamination');
  });

  it('reads disabled checks from the settings when no override is given', () => {
    const result = runValidityChecks({
      ...context,
      settings: { ...context.settings, disabledChecks: ['charge-multiplicity', 'geometry-sanity'] },
    }, { phase: 'post' });
    expect(result.findings.map((finding) => finding.id)).not.toContain('charge-multiplicity');
  });

  it('never reports an empty evaluation as a pass', () => {
    const result = runValidityChecks(context, { phase: 'post', disabled: VALIDITY_CHECK_IDS });
    expect(result.findings).toEqual([]);
    expect(result.overall).toBe('unknown');
    expect(summarizeValidity([]).overall).toBe('unknown');
  });

  it('judges an xTB run with the applicable checks and flags the rest', () => {
    const context = {
      settings: { jobType: 'Opt' },
      molecule: { charge: 0, multiplicity: 1, coords: WATER },
      parsed: null,
    };
    const result = runValidityChecks(context, { phase: 'post', engine: 'xtb' });
    expect(result.engine).toBe('xtb');
    const byId = Object.fromEntries(result.findings.map((finding) => [finding.id, finding]));
    // Gaussian-route checks are not asked of xTB, and that is said explicitly.
    expect(byId['spin-contamination'].status).toBe(CHECK_STATUS.SKIPPED);
    expect(byId['spin-contamination'].applicability).toBe('not-applicable');
    expect(byId['method-basis-compatibility'].status).toBe(CHECK_STATUS.SKIPPED);
    expect(byId['method-basis-compatibility'].applicability).toBe('not-applicable');
    // A check that applies but has no evidence is unknown, not skipped.
    expect(byId['opt-convergence'].status).toBe(CHECK_STATUS.UNKNOWN);
    expect(byId['opt-convergence'].applicability).toBe('not-evaluated');
  });

  it('passes an xTB optimisation that printed its convergence banner', () => {
    const text = readFileSync(
      fileURLToPath(new URL('./fixtures/xtb/water-opt-tight.out', import.meta.url)),
      'utf8',
    );
    const parsed = parseXtbOutput(text, { argv: ['--opt', 'tight'] });
    const result = checkOptimizationConvergence({ settings: { jobType: 'Opt' }, parsed, engine: 'xtb' });
    expect(result.status).toBe(CHECK_STATUS.PASS);
    expect(result.evidence.cycles).toBe(5);
  });

  it('fails an xTB optimisation that never converged', () => {
    const text = [
      ' GEOMETRY OPTIMIZATION',
      ' * total energy  :    -5.0703708 Eh     change       -0.1154632E-13 Eh',
      'normal termination of xtb',
    ].join('\n');
    const parsed = parseXtbOutput(text, { argv: ['--opt', 'normal'] });
    expect(parsed.optimization.attempted).toBe(true);
    expect(parsed.optimization.completed).toBe(false);
    const result = checkOptimizationConvergence({ settings: { jobType: 'Opt' }, parsed, engine: 'xtb' });
    expect(result.status).toBe(CHECK_STATUS.FAIL);
  });

  it('does not invent an optimisation when the xTB run was a single point', () => {
    const text = 'normal termination of xtb';
    const parsed = parseXtbOutput(text, { argv: ['--gfn', '2'] });
    expect(parsed.optimization.attempted).toBe(false);
    const result = checkOptimizationConvergence({ settings: { jobType: 'Opt' }, parsed, engine: 'xtb' });
    expect(result.status).toBe(CHECK_STATUS.UNKNOWN);
    expect(result.message).toMatch(/no optimisation record/i);
  });

  it('fails an xTB frequency job with an imaginary mode', () => {
    const result = checkImaginaryFrequencies({
      settings: { jobType: 'Opt Freq' },
      parsed: {
        frequencies: { count: 9, imaginaryCount: 1, imaginaryValues: [-420], minImaginary: -420 },
      },
    });
    expect(result.status).toBe(CHECK_STATUS.FAIL);
  });
});

describe('validity context normalisation', () => {
  it('bounds and coerces a renderer payload', () => {
    const context = normalizeValidityContext({
      settings: { jobType: 'Freq', method: 'B3LYP\nInjected', basis: 'def2-SVP', disabledChecks: ['spin-contamination', 'not-a-check'] },
      molecule: {
        charge: 0,
        multiplicity: 1,
        coords: [{ element: 'O', x: '0', y: 0, z: 0 }, { element: '__proto__', x: 1, y: 0, z: 0 }],
      },
    });
    expect(context.settings.method).toBe('B3LYP Injected');
    expect(context.settings.disabledChecks).toEqual(['spin-contamination']);
    expect(context.molecule.coords).toHaveLength(2);
    expect(context.molecule.coords[0].x).toBe(0);
  });
});

/* ── Gate integration ─────────────────────────────────────── */

describe('gate integration', () => {
  it('reports a validity failure without changing the gate verdict', () => {
    const parsed = parsedSynthetic({ imaginary: [] });
    const validity = runValidityChecks({
      settings: { jobType: 'SP', method: 'B3LYP', basis: 'def2-SVP', dispersion: 'GD3BJ' },
      molecule: water({ multiplicity: 2 }),
      parsed,
    }, { phase: 'post' });
    const result = evaluateGates(parsed, { expectedImaginary: 0, validity: validity.findings });
    expect(result.overall).toBe('pass');
    expect(result.validity.overall).toBe('fail');
    expect(result.validity.findings.find((finding) => finding.id === 'charge-multiplicity'))
      .toMatchObject({ status: 'fail', severity: 'error' });
  });

  it('leaves validity null when no checks were supplied', () => {
    const result = evaluateGates(parsedSynthetic(), { expectedImaginary: 0 });
    expect(result.validity).toBeNull();
  });
});

/* ── Project validation ───────────────────────────────────── */

function projectWith({ molecule = water(), settings = {}, disabledChecks } = {}) {
  const nodeSettings = defaultSettings(settings);
  if (disabledChecks !== undefined) nodeSettings.disabledChecks = disabledChecks;
  return {
    schemaVersion: 1,
    name: 'Validity fixture',
    molecule: {
      smiles: '',
      charge: molecule.charge,
      multiplicity: molecule.multiplicity,
      fragments: [],
      coords: molecule.coords,
      geometry: { source: 'imported', file: '', format: 'xyz' },
    },
    defaults: {
      engine: 'gaussian', method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: 4,
    },
    nodes: [{
      id: 'opt',
      type: 'calc',
      kind: 'Opt',
      title: 'Optimization',
      state: 'ready',
      x: 0,
      y: 0,
      settings: nodeSettings,
      output: null,
      checkpointFrom: null,
    }],
    edges: [],
  };
}

describe('project validation integration', () => {
  it('reports an impossible charge/multiplicity as a blocking finding', () => {
    const result = validateProject(projectWith({ molecule: water({ multiplicity: 2 }) }));
    // The project still opens and saves so the user can fix it; only a run is
    // meaningless, and the input builder enforces validity.blocking.
    expect(result.ok).toBe(true);
    expect(result.validity.overall).toBe('fail');
    const blocking = result.validity.blocking.find((finding) => finding.id === 'charge-multiplicity');
    expect(blocking).toBeTruthy();
    expect(blocking.message).toMatch(/parity/i);
    expect(blocking.nodeId).toBe('opt');
  });

  it('drops a blocking finding once the check is disabled', () => {
    const result = validateProject(projectWith({
      molecule: water({ multiplicity: 2 }),
      disabledChecks: ['charge-multiplicity'],
    }));
    expect(result.ok).toBe(true);
    expect(result.validity.findings.map((finding) => finding.id)).not.toContain('charge-multiplicity');
    expect(result.validity.blocking).toEqual([]);
  });

  it('warns, without blocking, about redundant dispersion', () => {
    const result = validateProject(projectWith({
      settings: { method: 'ωB97X-D', dispersion: 'GD3BJ' },
    }));
    expect(result.ok).toBe(true);
    expect(result.warnings.some((entry) => entry.path === 'nodes[0].validity.method-basis-compatibility')).toBe(true);
    expect(result.validity.blocking).toEqual([]);
  });

  it('reports a heavy element in a basis without an ECP as blocking', () => {
    const result = validateProject(projectWith({
      molecule: {
        charge: 0,
        multiplicity: 1,
        coords: [{ element: 'I', x: 0, y: 0, z: 0 }, { element: 'H', x: 1.6, y: 0, z: 0 }],
      },
      settings: { basis: '6-31G(d)' },
    }));
    expect(result.ok).toBe(true);
    const blocking = result.validity.blocking.find((finding) => finding.id === 'method-basis-compatibility');
    expect(blocking).toBeTruthy();
    expect(blocking.severity).toBe('error');
  });

  it('loads a project written before validity checks existed', () => {
    const raw = projectWith();
    delete raw.nodes[0].settings.disabledChecks;
    const result = validateProject(raw);
    expect(result.ok).toBe(true);
    expect(result.project.nodes[0].settings.disabledChecks).toEqual([]);
  });

  it('round-trips disabled check ids through canonical serialization', () => {
    const result = stringifyProject(projectWith({ disabledChecks: ['spin-contamination'] }));
    expect(result.ok).toBe(true);
    const reopened = parseProjectText(result.text);
    expect(reopened.ok).toBe(true);
    expect(reopened.project.nodes[0].settings.disabledChecks).toEqual(['spin-contamination']);
  });

  it('drops an unknown check id with a warning instead of failing', () => {
    const result = validateProject(projectWith({ disabledChecks: ['not-a-check'] }));
    expect(result.ok).toBe(true);
    expect(result.warnings.some((entry) => entry.path === 'nodes[0].settings.disabledChecks[0]')).toBe(true);
    expect(result.project.nodes[0].settings.disabledChecks).toEqual([]);
  });
});
