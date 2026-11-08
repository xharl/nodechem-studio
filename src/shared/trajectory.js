/**
 * Optimisation trajectory: every geometry Gaussian printed, paired with the
 * energy that preceded it.
 *
 * An optimisation cycle prints `SCF Done: … = -382.1649 A.U.` and then a
 * `Standard orientation:` block for that geometry. Pairing them by order is
 * what the output itself does; a geometry with no preceding SCF energy keeps
 * `energyHartree: null` rather than borrowing the next one's.
 */

const ENERGY = /SCF Done:\s+E\([^)]*\)\s*=\s*(-?\d+\.\d+)/;
const ORIENTATION = /^\s*Standard orientation:/;
const DASHES = /^\s*-{10,}\s*$/;

function elementFor(atomicNumber) {
  const table = ['H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne', 'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar',
    'K', 'Ca', 'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn'];
  return table[atomicNumber - 1] || `Z${atomicNumber}`;
}

/**
 * Parse every `Standard orientation:` block. Returns `null` when the output has
 * none, so a job with no geometries is distinguishable from one with an empty
 * list.
 */
export function parseTrajectory(text) {
  const lines = String(text ?? '').split(/\r\n|\n|\r/);
  const steps = [];
  let lastEnergy = null;

  for (let index = 0; index < lines.length; index += 1) {
    const energyMatch = lines[index].match(ENERGY);
    if (energyMatch) {
      lastEnergy = Number(energyMatch[1]);
      continue;
    }
    if (!ORIENTATION.test(lines[index])) continue;

    // Header: two dashed lines, two title lines, one dashed line, then atoms
    // until the closing dashed line.
    let cursor = index + 1;
    let dashes = 0;
    while (cursor < lines.length && dashes < 2) {
      if (DASHES.test(lines[cursor])) dashes += 1;
      cursor += 1;
    }
    cursor += 2; // "Center Atomic Atomic …" and its units line
    const atoms = [];
    let malformed = false;
    while (cursor < lines.length && !DASHES.test(lines[cursor])) {
      const parts = lines[cursor].trim().split(/\s+/);
      if (parts.length >= 6) {
        const atomicNumber = Number(parts[1]);
        const x = Number(parts[3]);
        const y = Number(parts[4]);
        const z = Number(parts[5]);
        if (Number.isFinite(atomicNumber) && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
          atoms.push({ element: elementFor(atomicNumber), atomicNumber, x, y, z });
        } else {
          malformed = true;
        }
      }
      cursor += 1;
    }
    if (atoms.length > 0 && !malformed) {
      steps.push({ index: steps.length + 1, energyHartree: lastEnergy, atoms });
      lastEnergy = null;
    }
    index = cursor;
  }

  if (steps.length === 0) return null;
  return { steps, count: steps.length };
}

/**
 * Energy against step, with the reference being the lowest energy recorded —
 * not the first step — so the plot shows how far each geometry sits above the
 * best one found, and the reference step is named.
 */
export function trajectoryEnergies(trajectory) {
  if (!trajectory || !Array.isArray(trajectory.steps) || trajectory.steps.length === 0) return null;
  const energies = trajectory.steps.map((step) => (Number.isFinite(step.energyHartree) ? step.energyHartree : null));
  const finite = energies.filter((value) => value !== null);
  if (finite.length === 0) return null;
  const lowest = Math.min(...finite);
  const referenceIndex = energies.indexOf(lowest);
  return trajectory.steps.map((step, index) => ({
    step: step.index,
    energyHartree: energies[index],
    relativeKcal: energies[index] === null ? null : (energies[index] - lowest) * 627.5094740631,
    atoms: step.atoms.length,
    reference: index === referenceIndex,
  }));
}

/** SVG of energy against step. A step with no energy is a gap, never a zero. */
export function trajectorySvg(trajectory, { width = 520, height = 180 } = {}) {
  const series = trajectoryEnergies(trajectory);
  if (!series) return '';
  const withEnergy = series.filter((point) => point.relativeKcal !== null);
  if (withEnergy.length < 2) return '';
  const pad = { left: 52, right: 14, top: 14, bottom: 26 };
  const maxKcal = Math.max(...withEnergy.map((point) => point.relativeKcal), 1);
  const xFor = (step) => pad.left + ((step - 1) / Math.max(1, series.length - 1)) * (width - pad.left - pad.right);
  const yFor = (kcal) => height - pad.bottom - (kcal / maxKcal) * (height - pad.top - pad.bottom);
  const path = withEnergy.map((point, index) => `${index === 0 ? 'M' : 'L'}${xFor(point.step).toFixed(1)},${yFor(point.relativeKcal).toFixed(1)}`).join(' ');
  const markers = withEnergy.map((point) => `<circle cx="${xFor(point.step).toFixed(1)}" cy="${yFor(point.relativeKcal).toFixed(1)}" r="2.4" fill="${point.reference ? '#fbbf24' : '#8fa3bf'}"><title>step ${point.step}: ${point.relativeKcal.toFixed(2)} kcal mol⁻¹</title></circle>`).join('');
  const ticks = [0, maxKcal].map((value) => `<text x="${pad.left - 6}" y="${yFor(value) + 3}" text-anchor="end" class="spectrum-label">${value.toFixed(1)}</text>`).join('');
  return `<figure class="results-spectrum" data-field="trajectory">`
    + `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Energy against optimisation step">`
    + `<path d="${path}" fill="none" stroke="#7dd3fc" stroke-width="1.6"></path>${markers}${ticks}`
    + `<text x="${width - pad.right}" y="${height - 6}" text-anchor="end" class="spectrum-label">step →</text>`
    + `<text x="8" y="${pad.top + 4}" class="spectrum-label">ΔE / kcal mol⁻¹</text>`
    + '</svg>'
    + `<figcaption>${series.length} geometries; reference is step ${withEnergy.find((point) => point.reference)?.step ?? '—'} (lowest energy)</figcaption>`
    + '</figure>';
}
