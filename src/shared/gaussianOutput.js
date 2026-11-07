/**
 * Minimal, dependency-free Gaussian output reader for the first desktop slice.
 * It classifies termination and exposes the evidence needed by the run gates.
 * The full GaussianHelper parser can replace this module without changing the
 * runner contract.
 */

const NUMBER = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][-+]?\d+)?`;

function toNumber(value) {
  if (value === undefined || value === null) return null;
  const number = Number(String(value).replace(/[Dd]/, 'E'));
  return Number.isFinite(number) ? number : null;
}

export function parseGaussianOutput(text) {
  if (typeof text !== 'string') throw new TypeError('Gaussian output must be text.');
  const lines = text.split(/\r\n|\n|\r/);
  const joined = lines.join('\n');

  const normalTermination = /\bNormal termination of Gaussian\b/i.test(joined);
  const errorTermination = /\bError termination\b/i.test(joined);
  const status = normalTermination ? 'completed' : errorTermination ? 'error' : 'incomplete';

  let scf = { status: 'unknown', energyHartree: null, cycles: null, method: null };
  const scfMatch = joined.match(new RegExp(
    String.raw`SCF Done:\s+E\(([^)]+)\)\s*=\s*(${NUMBER})\s+A\.U\.\s+after\s+(\d+)\s+cycles`,
    'i',
  ));
  if (scfMatch) {
    scf = {
      status: 'converged',
      energyHartree: toNumber(scfMatch[2]),
      cycles: Number(scfMatch[3]),
      method: scfMatch[1].trim(),
    };
  } else if (/Convergence failure/i.test(joined) || /\bSCF (?:did not converge|failed)\b/i.test(joined)) {
    scf = { ...scf, status: 'failed' };
  }

  const optimization = {
    completed: /\bOptimization completed\b/i.test(joined),
    stationary: /\bStationary point found\b/i.test(joined),
  };

  const frequencies = [];
  for (const line of lines) {
    const match = line.match(new RegExp(String.raw`Frequencies\s*--\s+(.+)`, 'i'));
    if (!match) continue;
    for (const token of match[1].split(/\s+/)) {
      const value = toNumber(token);
      if (value !== null) frequencies.push(value);
    }
  }
  const imaginaryValues = frequencies.filter((value) => value < 0);
  const imaginaryCount = imaginaryValues.length;
  const minImaginary = imaginaryValues.length ? Math.min(...imaginaryValues) : null;

  let freeEnergy = null;
  const freeEnergyMatch = joined.match(new RegExp(
    String.raw`Sum of electronic and thermal Free Energies\s*=\s*(${NUMBER})`,
    'i',
  ));
  if (freeEnergyMatch) freeEnergy = toNumber(freeEnergyMatch[1]);

  // Correlated (post-HF) energy when present; otherwise the SCF energy is the best record.
  const correlatedMatch = joined.match(new RegExp(
    String.raw`(?:CCSD\(T\)|CCSD|QCISD\(T\)|QCISD|MP4|MP3|MP2)\s*(?:energy)?\s*=\s*(${NUMBER})`,
    'i',
  )) || joined.match(new RegExp(String.raw`E\(CORR\)\s*=\s*(${NUMBER})`, 'i'));
  const correlatedEnergy = correlatedMatch ? toNumber(correlatedMatch[1]) : null;
  const finalEnergyHartree = correlatedEnergy !== null ? correlatedEnergy : scf.energyHartree;
  const finalEnergySource = correlatedEnergy !== null ? 'post-hf' : scf.energyHartree !== null ? 'scf' : null;

  return {
    status,
    termination: normalTermination
      ? 'Normal termination of Gaussian'
      : errorTermination ? 'Error termination' : 'No termination marker',
    scf,
    optimization,
    frequencies: {
      count: frequencies.length,
      imaginaryCount,
      imaginaryValues: imaginaryValues.slice(0, 20),
      minImaginary,
    },
    thermochemistry: { freeEnergyHartree: freeEnergy },
    finalEnergy: { hartree: finalEnergyHartree, source: finalEnergySource },
    lineCount: lines.length,
  };
}

/**
 * Evaluate the first-slice gates. A missing or unjudgeable value is `unknown`,
 * never `pass`. `expectedImaginary` is null when the route has no frequency
 * interpretation.
 */
export function evaluateGates(parsed, {
  expectedImaginary = null,
  minMagnitude = 50,
  requireOptimization = false,
  requireFrequency = false,
  requireThermochemistry = false,
  requireFinalEnergy = false,
} = {}) {
  const gates = [];
  const add = (name, required, result, detail) => {
    gates.push({ name, required, result, detail: detail || null });
  };

  add('Normal termination', true,
    parsed.termination === 'Normal termination of Gaussian' ? 'pass'
      : parsed.termination === 'Error termination' ? 'fail' : 'unknown',
    parsed.termination);

  add('SCF record', true,
    parsed.scf.status === 'converged' ? 'pass'
      : parsed.scf.status === 'failed' ? 'fail' : 'unknown',
    parsed.scf.status === 'converged'
      ? `${parsed.scf.energyHartree ?? '?'} Eh after ${parsed.scf.cycles ?? '?'} cycles`
      : parsed.scf.status);

  if (requireOptimization) {
    add('Optimization completed', true,
      parsed.optimization.completed ? 'pass' : 'unknown',
      parsed.optimization.completed ? 'Optimization completed' : null);
  }

  if (expectedImaginary !== null) {
    const countPass = Number.isInteger(expectedImaginary) && parsed.frequencies.count > 0
      ? parsed.frequencies.imaginaryCount === expectedImaginary
      : null;
    add('Imaginary mode count', true,
      countPass === true ? 'pass' : countPass === false ? 'fail' : 'unknown',
      `expected ${expectedImaginary}, found ${parsed.frequencies.imaginaryCount}`);

    if (expectedImaginary > 0) {
      const floor = Number.isFinite(Number(minMagnitude)) ? Number(minMagnitude) : 0;
      const magnitude = parsed.frequencies.minImaginary === null
        ? null : Math.abs(parsed.frequencies.minImaginary);
      add('Imaginary magnitude', true,
        magnitude === null ? 'unknown' : magnitude >= floor ? 'pass' : 'fail',
        magnitude === null ? null : `${magnitude.toFixed(1)} cm^-1 (floor ${floor})`);
    }
  }

  if (requireFrequency) {
    add('Frequency record', true,
      parsed.frequencies.count > 0 ? 'pass' : 'unknown',
      `${parsed.frequencies.count} modes`);
  }

  if (requireThermochemistry) {
    add('Thermochemistry record', true,
      parsed.thermochemistry.freeEnergyHartree !== null ? 'pass' : 'unknown',
      parsed.thermochemistry.freeEnergyHartree !== null ? 'free energy parsed' : null);
  }

  if (requireFinalEnergy) {
    const finalEnergy = parsed.finalEnergy || { hartree: null, source: null };
    add('Final energy record', true,
      finalEnergy.hartree !== null ? 'pass' : 'unknown',
      finalEnergy.hartree !== null ? `${finalEnergy.hartree} Eh (${finalEnergy.source})` : null);
  }

  const required = gates.filter((gate) => gate.required);
  const overall = required.some((gate) => gate.result === 'fail') ? 'fail'
    : required.every((gate) => gate.result === 'pass') ? 'pass' : 'unknown';
  return { overall, gates };
}
