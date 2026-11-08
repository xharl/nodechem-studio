import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFORMER_SETTINGS,
  HARTREE_KCAL,
  ensembleSummary,
  formatPopulation,
  parseCrestEnergies,
  parseMultiXyz,
  rankEnsemble,
  withEnergies,
} from '../src/shared/conformers.js';

/**
 * A water molecule at a given H–O–H angle. Rotating one hydrogen is a genuine
 * conformational change; translating the whole molecule is not, and RMSD
 * pruning must tell the two apart.
 */
const water = (angleDeg = 104.5) => {
  const a = (angleDeg * Math.PI) / 180;
  return [
    { element: 'O', x: 0, y: 0, z: 0 },
    { element: 'H', x: 0.96, y: 0, z: 0 },
    { element: 'H', x: 0.96 * Math.cos(a), y: 0.96 * Math.sin(a), z: 0 },
  ];
};

const frame = (energyEh, angleDeg = 104.5, { protomer = '' } = {}) => ({
  index: 0,
  comment: `energy: ${energyEh}${protomer ? ` protomer=${protomer}` : ''}`,
  atoms: water(angleDeg),
  energyEh,
  protomer,
});

const kcalToEh = (kcal) => kcal / HARTREE_KCAL;

describe('parseMultiXyz', () => {
  it('reads every frame, its energy and its protomer label', () => {
    const text = [
      '3', 'energy: -76.400000000 protomer=neutral', ...water().map((a) => `${a.element} ${a.x} ${a.y} ${a.z}`),
      '3', 'energy: -76.399000000 protomer=zwitterion', ...water(120).map((a) => `${a.element} ${a.x} ${a.y} ${a.z}`),
      '',
    ].join('\n');
    const { frames, errors } = parseMultiXyz(text);
    expect(errors).toEqual([]);
    expect(frames).toHaveLength(2);
    expect(frames[0].energyEh).toBeCloseTo(-76.4, 6);
    expect(frames[0].protomer).toBe('neutral');
    expect(frames[1].protomer).toBe('zwitterion');
    expect(frames[1].atoms[2].x).toBeCloseTo(0.96 * Math.cos((120 * Math.PI) / 180), 6);
  });

  it('refuses a malformed atom line instead of returning a short frame', () => {
    const text = ['3', 'water', 'O 0 0 0', 'H nope 0 0', 'H 0 1 0'].join('\n');
    const { frames, errors } = parseMultiXyz(text);
    expect(frames).toHaveLength(0);
    expect(errors[0].message).toMatch(/element x y z/);
  });

  it('refuses a file with no frames', () => {
    expect(parseMultiXyz('').errors[0].message).toMatch(/no conformer frames/);
  });

  it('reads a bare Hartree value from the comment, the way multi-XYZ writers store it', () => {
    const frame = (comment) => ['3', comment, ...water().map((a) => `${a.element} ${a.x} ${a.y} ${a.z}`)].join('\n');
    const parsed = parseMultiXyz([frame('-76.4180'), frame('conf 2 -76.4172')].join('\n'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.frames[0].energyEh).toBeCloseTo(-76.418, 6);
    expect(parsed.frames[1].energyEh).toBeCloseTo(-76.4172, 6);
  });

  it('does not mistake a bare index for an energy', () => {
    const frame = ['3', '2', ...water().map((a) => `${a.element} ${a.x} ${a.y} ${a.z}`)].join('\n');
    expect(parseMultiXyz(frame).frames[0].energyEh).toBeNull();
  });
});

describe('parseCrestEnergies', () => {
  it('reads the energy, not the leading index', () => {
    expect(parseCrestEnergies('1 -76.400000\n2 -76.398000\n')).toEqual([-76.4, -76.398]);
  });

  it('ignores blank lines', () => {
    expect(parseCrestEnergies('\n-76.4\n\n-76.3\n')).toEqual([-76.4, -76.3]);
  });
});

describe('withEnergies', () => {
  it('prefers the comment energy and falls back to the energies file', () => {
    const { frames } = parseMultiXyz([
      '3', 'energy: -76.4', ...water().map((a) => `${a.element} ${a.x} ${a.y} ${a.z}`),
      '3', 'conformer 2', ...water(120).map((a) => `${a.element} ${a.x} ${a.y} ${a.z}`),
    ].join('\n'));
    const merged = withEnergies(frames, [-76.4, -76.395]);
    expect(merged.error).toBeNull();
    expect(merged.frames[1].energyEh).toBeCloseTo(-76.395, 6);
  });

  it('refuses a frame with no energy anywhere', () => {
    const { frames } = parseMultiXyz(['3', 'no energy here', ...water().map((a) => `${a.element} ${a.x} ${a.y} ${a.z}`)].join('\n'));
    expect(withEnergies(frames, []).error).toMatch(/no energy/);
  });
});

describe('rankEnsemble', () => {
  it('ranks by energy, assigns Boltzmann populations and reports the spread', () => {
    const result = rankEnsemble({
      frames: [frame(-76.400, 40), frame(-76.399, 110), frame(-76.395, 180)],
      energyWindowKcal: 10,
      rmsdThreshold: 0.25,
    });
    expect(result.error).toBeNull();
    expect(result.retained).toHaveLength(3);
    expect(result.retained[0].relativeKcal).toBeCloseTo(0, 9);
    expect(result.retained[1].relativeKcal).toBeCloseTo(HARTREE_KCAL * 0.001, 4);
    expect(result.retained[2].relativeKcal).toBeCloseTo(HARTREE_KCAL * 0.005, 4);
    const total = result.retained.reduce((sum, member) => sum + member.population, 0);
    expect(total).toBeCloseTo(1, 9);
    expect(result.retained[0].population).toBeGreaterThan(result.retained[1].population);
    expect(result.spreadKcal).toBeCloseTo(HARTREE_KCAL * 0.005, 4);
    expect(result.selectedId).toBe('c1');
    expect(result.autoSelected).toBe(true);
  });

  it('drops conformers outside the energy window and records why', () => {
    const result = rankEnsemble({
      frames: [frame(-76.400, 60), frame(-76.390, 180)],
      energyWindowKcal: 2,
    });
    expect(result.retained).toHaveLength(1);
    expect(result.members[1].dropped).toBe('energy');
    expect(result.pruned.energy).toBe(1);
  });

  it('drops a duplicate geometry by RMSD even when its energy differs', () => {
    const result = rankEnsemble({
      frames: [frame(-76.400, 104.5), frame(-76.395, 104.5001)],
      rmsdThreshold: 0.5,
    });
    expect(result.retained).toHaveLength(1);
    expect(result.members[1].dropped).toBe('rmsd');
  });

  it('keeps a genuinely different geometry', () => {
    const result = rankEnsemble({
      frames: [frame(-76.400, 60), frame(-76.395, 180)],
      rmsdThreshold: 0.5,
    });
    expect(result.retained).toHaveLength(2);
  });

  it('caps retention and marks the rest as dropped by count', () => {
    const frames = [30, 60, 90, 120, 150, 180].map((angle, index) => frame(-76.4 - index * kcalToEh(0.5), angle));
    const result = rankEnsemble({ frames, maxConformers: 3, rmsdThreshold: 0.1, energyWindowKcal: 50 });
    expect(result.retained).toHaveLength(3);
    expect(result.pruned.count).toBe(3);
  });

  it('warns when the spread exceeds the threshold', () => {
    const result = rankEnsemble({
      frames: [frame(-76.400, 60), frame(-76.400 - kcalToEh(4), 180)],
      spreadThresholdKcal: 2,
    });
    expect(result.spreadKcal).toBeCloseTo(4, 6);
    expect(result.warnings.map((warning) => warning.id)).toContain('conformer-spread');
  });

  it('does not warn when the spread is inside the threshold', () => {
    const result = rankEnsemble({
      frames: [frame(-76.400, 60), frame(-76.400 - kcalToEh(1), 180)],
      spreadThresholdKcal: 2,
    });
    expect(result.warnings.map((warning) => warning.id)).not.toContain('conformer-spread');
  });

  it('refuses to auto-select across protomers and asks for an explicit choice', () => {
    const result = rankEnsemble({
      frames: [
        frame(-76.400, 60, { protomer: 'neutral' }),
        frame(-76.395, 180, { protomer: 'zwitterion' }),
      ],
    });
    expect(result.requiresSelection).toBe(true);
    expect(result.selectedId).toBe('');
    expect(result.warnings.map((warning) => warning.id)).toContain('conformer-protomer');
  });

  it('honours an explicit selection, including a non-lowest member', () => {
    const result = rankEnsemble({
      frames: [
        frame(-76.400, 60, { protomer: 'neutral' }),
        frame(-76.395, 180, { protomer: 'zwitterion' }),
      ],
      selectedConformerId: 'c2',
    });
    expect(result.requiresSelection).toBe(false);
    expect(result.selectedId).toBe('c2');
    expect(result.autoSelected).toBe(false);
  });

  it('treats structures of different composition as distinct, never as duplicates', () => {
    const protonated = frame(-76.3, 60);
    protonated.atoms = [...water(60), { element: 'H', x: 0.2, y: -0.9, z: 0.0 }];
    const result = rankEnsemble({ frames: [frame(-76.4, 60), protonated], rmsdThreshold: 5, energyWindowKcal: 100 });
    expect(result.retained).toHaveLength(2);
  });

  it('refuses an ensemble with a missing energy', () => {
    const broken = frame(-76.4);
    broken.energyEh = null;
    expect(rankEnsemble({ frames: [broken] }).error).toMatch(/no energy/);
  });
});

describe('ensembleSummary', () => {
  it('carries the table, the selected geometry and the geometry of every kept member', () => {
    const result = rankEnsemble({ frames: [frame(-76.400, 60), frame(-76.395, 180)] });
    const summary = ensembleSummary(result, { generator: 'crest', method: 'gfn2' });
    expect(summary.count).toBe(2);
    expect(summary.total).toBe(2);
    expect(summary.selected.atoms).toHaveLength(3);
    // A kept member can be chosen later, offline, so its atoms must travel.
    expect(summary.members[0].atoms).toHaveLength(3);
    expect(summary.members[0].atoms[1].x).toBeCloseTo(result.members[0].atoms[1].x, 6);
    expect(summary.generator).toBe('crest');
  });

  it('does not carry the geometry of a pruned member', () => {
    const result = rankEnsemble({
      frames: [frame(-76.400, 60), frame(-76.300, 180)],
      energyWindowKcal: 1,
    });
    const summary = ensembleSummary(result);
    const pruned = summary.members.find((member) => !member.kept);
    expect(pruned).toBeTruthy();
    expect(pruned).not.toHaveProperty('atoms');
  });
});

describe('formatting', () => {
  it('renders relative energies and populations', () => {
    expect(formatPopulation(0.999)).toBe('100%');
    expect(formatPopulation(0.0123)).toBe('1.2%');
  });

  it('exposes sane defaults', () => {
    expect(DEFAULT_CONFORMER_SETTINGS.maxConformers).toBeGreaterThan(0);
    expect(DEFAULT_CONFORMER_SETTINGS.spreadThresholdKcal).toBe(2);
  });
});
