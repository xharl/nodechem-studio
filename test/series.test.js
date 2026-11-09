import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  SERIES_MAX_MEMBERS,
  SERIES_TERMINAL_RULE,
  SeriesError,
  atomDistance,
  expandSeries,
  perceiveSeriesBonds,
  seriesMemberCount,
  seriesMemberId,
  seriesUnitRecord,
  validateSeriesLinkage,
} from '../src/shared/series.js';
import { formulaOf } from '../src/shared/formula.js';
import { recordsForInput } from '../src/shared/flows.js';
import { defaultSettings, stringifyProject, validateProject } from '../src/shared/projectSchema.js';
import { buildWorkflowPlan } from '../src/shared/workflowTasks.js';

/**
 * Issue 169: a series block is an `input` block with `kind: 'series'`. One
 * repeat unit, one linkage rule and a range of n expand at plan time into N
 * ordinary records. These tests pin the geometry, the terminal rule, the guards
 * and the plan expansion — a wrong bond length here is a silent chemistry
 * error, not a crash, so every number is asserted rather than eyeballed.
 */

/** A bare two-atom unit: the acceptance criterion's "two-atom unit". */
const twoAtomUnit = {
  id: 'c2',
  label: 'C2 unit',
  charge: 0,
  multiplicity: 1,
  coords: [
    { element: 'C', x: 0, y: 0, z: 0 },
    { element: 'C', x: 1.3, y: 0, z: 0 },
  ],
};

/**
 * Ethene, used as a repeat unit: C1=C2 along x, one H per carbon pointing along
 * the chain axis (the leaving group) and one pointing away.
 */
const ethene = {
  id: 'ethene',
  label: 'Ethene',
  charge: 0,
  multiplicity: 1,
  coords: [
    { element: 'C', x: 0, y: 0, z: 0 },
    { element: 'C', x: 1.34, y: 0, z: 0 },
    { element: 'H', x: -0.54, y: 0.935, z: 0 },
    { element: 'H', x: -0.54, y: -0.935, z: 0 },
    { element: 'H', x: 1.88, y: 0.935, z: 0 },
    { element: 'H', x: 1.88, y: -0.935, z: 0 },
  ],
};
const etheneLinkage = { donor: 1, acceptor: 2, bondLengthAngstrom: 1.5, leaving: [3, 6] };

const water = [
  { element: 'O', x: 0, y: 0, z: 0 },
  { element: 'H', x: 0.96, y: 0, z: 0 },
  { element: 'H', x: -0.24, y: 0.93, z: 0 },
];

const refusal = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal, but the call succeeded');
};

describe('issue 169 — a series expands into real records', () => {
  it('builds a 3-member series from a two-atom unit: record count and formulas', () => {
    const { records } = expandSeries(twoAtomUnit, {
      from: 1,
      to: 3,
      linkage: { donor: 1, acceptor: 2, bondLengthAngstrom: 1.5, leaving: [] },
    });
    expect(records).toHaveLength(3);
    // Formulas are counted from the atoms each member actually carries.
    expect(records.map((record) => formulaOf(record.coords))).toEqual(['C2', 'C4', 'C6']);
    expect(records.map((record) => record.coords.length)).toEqual([2, 4, 6]);
    expect(records.map((record) => record.id)).toEqual(['c2-n1', 'c2-n2', 'c2-n3']);
  });

  it('makes every junction bond exactly the requested length, by construction', () => {
    const length = 1.5;
    const { records } = expandSeries(twoAtomUnit, {
      from: 2,
      to: 2,
      linkage: { donor: 1, acceptor: 2, bondLengthAngstrom: length, leaving: [] },
    });
    const [dimer] = records;
    // Atom order per copy is the unit's: [copy0 donor, copy0 acceptor, copy1 donor, copy1 acceptor].
    const junction = atomDistance(dimer.coords[1], dimer.coords[2]);
    expect(Math.abs(junction - length)).toBeLessThan(1e-9);
    // The unit's own bond is untouched, because a copy is a rigid translation.
    expect(atomDistance(dimer.coords[0], dimer.coords[1])).toBeCloseTo(1.3, 12);
    expect(atomDistance(dimer.coords[2], dimer.coords[3])).toBeCloseTo(1.3, 12);
  });

  it('keeps the junction bond exact for every member and every length tried', () => {
    for (const length of [0.9, 1.34, 1.5, 1.54, 2.2]) {
      const { records } = expandSeries(twoAtomUnit, {
        from: 1,
        to: 6,
        linkage: { donor: 1, acceptor: 2, bondLengthAngstrom: length, leaving: [] },
      });
      for (const record of records) {
        // Junction bonds are appended after every copy's own bonds.
        const junctions = record.series.n === 1 ? [] : record.bonds.slice(-(record.series.n - 1));
        expect(junctions).toHaveLength(record.series.n - 1);
        for (const bond of junctions) {
          const distance = atomDistance(record.coords[bond.a - 1], record.coords[bond.b - 1]);
          expect(Math.abs(distance - length)).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('states explicit bonds for every member, including the junctions', () => {
    const { records } = expandSeries(twoAtomUnit, {
      from: 3,
      to: 3,
      linkage: { donor: 1, acceptor: 2, bondLengthAngstrom: 1.5, leaving: [] },
    });
    const [trimer] = records;
    // 3 unit bonds + 2 junction bonds.
    expect(trimer.bonds).toHaveLength(5);
    expect(trimer.bonds[3]).toEqual({ a: 2, b: 3, order: 1 });
    expect(trimer.bonds[4]).toEqual({ a: 4, b: 5, order: 1 });
  });

  it('carries parent, n and the linkage rule as provenance', () => {
    const { records } = expandSeries(twoAtomUnit, {
      from: 2,
      to: 4,
      linkage: { donor: 1, acceptor: 2, bondLengthAngstrom: 1.5, leaving: [] },
    });
    expect(records.map((record) => record.series.n)).toEqual([2, 3, 4]);
    expect(records[0].series).toMatchObject({
      parentId: 'c2',
      parentLabel: 'C2 unit',
      n: 2,
      count: 3,
      of: '2…4',
      terminal: 'capped',
      linkage: { donor: 1, acceptor: 2, bondLengthAngstrom: 1.5, leaving: [] },
    });
    // The id names the pair, so a queue row is traceable without the object.
    expect(records[0].id).toBe(seriesMemberId('c2', 2));
  });

  it('is deterministic: the same definition yields identical coordinates', () => {
    const definition = { from: 1, to: 4, linkage: etheneLinkage };
    const first = expandSeries(ethene, definition).records;
    const second = expandSeries(ethene, definition).records;
    expect(second.map((record) => record.coords)).toEqual(first.map((record) => record.coords));
    expect(second.map((record) => record.bonds)).toEqual(first.map((record) => record.bonds));
  });
});

describe('issue 169 — leaving atoms and the terminal rule', () => {
  it('caps both ends: n = 1 is the unit, and only junction copies lose a leaving group', () => {
    const { records } = expandSeries(ethene, { from: 1, to: 3, linkage: etheneLinkage });
    // n = 1 is the unit itself, unchanged.
    expect(records[0].coords).toEqual(ethene.coords);
    expect(formulaOf(records[0].coords)).toBe('C2H4');
    // Each junction removes one H from each side: C2H4 + C2H2 per added unit.
    expect(records.map((record) => formulaOf(record.coords))).toEqual(['C2H4', 'C4H6', 'C6H8']);
    expect(records.map((record) => record.coords.length)).toEqual([6, 10, 14]);
  });

  it('drops the donor-side leaving group only from copies that use their donor', () => {
    const { records } = expandSeries(ethene, { from: 2, to: 2, linkage: etheneLinkage });
    const [dimer] = records;
    // Copy 0 keeps atoms 1-5 (its acceptor-side H, atom 6, is gone); copy 1
    // keeps atoms 1, 2, 4, 5, 6 (its donor-side H, atom 3, is gone).
    const elements = dimer.coords.map((atom) => atom.element).join('');
    expect(elements).toBe('CCHHH' + 'CCHHH');
    expect(atomDistance(dimer.coords[1], dimer.coords[5])).toBeCloseTo(1.5, 9);
    expect(SERIES_TERMINAL_RULE).toMatch(/capped at both ends/);
  });
});

describe('issue 169 — the guards refuse by name, before anything is built', () => {
  const guarded = (linkage, series = { from: 1, to: 3 }, unit = ethene) => refusal(() => expandSeries(unit, { ...series, linkage }));

  it('refuses donor == acceptor', () => {
    const error = guarded({ donor: 2, acceptor: 2, bondLengthAngstrom: 1.5, leaving: [] });
    expect(error).toBeInstanceOf(SeriesError);
    expect(error.message).toMatch(/same atom \(2\)/);
  });

  it('refuses an atom index outside the unit', () => {
    expect(guarded({ donor: 9, acceptor: 2, bondLengthAngstrom: 1.5, leaving: [] }).message)
      .toMatch(/donor \(9\) is not an atom index in the unit, which has 6 atoms/);
    expect(guarded({ donor: 1, acceptor: 0, bondLengthAngstrom: 1.5, leaving: [] }).message)
      .toMatch(/acceptor \(0\) is not an atom index/);
  });

  it('names the atom when the new bond would exceed its valence', () => {
    const oxygenUnit = { ...twoAtomUnit, coords: water };
    const error = guarded({ donor: 1, acceptor: 2, bondLengthAngstrom: 1.5, leaving: [] }, { from: 1, to: 2 }, oxygenUnit);
    expect(error.message).toMatch(/donor is atom 1 \(O\) with a bond order of 2/);
    expect(error.message).toMatch(/above the 2 O allows/);
    // A hydrogen that already has its one bond cannot take another.
    expect(guarded({ donor: 2, acceptor: 5, bondLengthAngstrom: 1.5, leaving: [] }).message)
      .toMatch(/acceptor is atom 5 \(H\) with a bond order of 1/);
  });

  it('refuses a leaving atom bonded to something other than the linkage atoms', () => {
    // A second fragment (H2) at x = 5: its atoms are bonded to each other and to
    // nothing else, so they cannot leave a junction.
    const unit = {
      ...ethene,
      coords: [
        ...ethene.coords,
        { element: 'H', x: 5, y: 0, z: 0 },
        { element: 'H', x: 5, y: 0.74, z: 0 },
      ],
    };
    const error = guarded({ donor: 1, acceptor: 2, bondLengthAngstrom: 1.5, leaving: [7] }, { from: 1, to: 2 }, unit);
    expect(error.message).toMatch(/Atom 7 is listed as leaving but is bonded to atom 8/);
  });

  it('refuses a leaving atom that is also a linkage atom, or bonded to nothing', () => {
    expect(guarded({ donor: 1, acceptor: 2, bondLengthAngstrom: 1.5, leaving: [1] }).message)
      .toMatch(/Atom 1 is listed as leaving and is also the linkage atom/);
    const lonely = { ...twoAtomUnit, coords: [...twoAtomUnit.coords, { element: 'H', x: 0, y: 0, z: 6 }] };
    expect(guarded({ donor: 1, acceptor: 2, bondLengthAngstrom: 1.5, leaving: [3] }, { from: 1, to: 2 }, lonely).message)
      .toMatch(/Atom 3 is listed as leaving but is bonded to nothing/);
  });

  it('refuses copies that overlap, naming both atoms', () => {
    // A unit with a tail that reaches past the acceptor: the 2.9 Å step lands
    // the next copy's acceptor 0.1 Å from this copy's tail atom.
    const wide = {
      ...twoAtomUnit,
      coords: [
        { element: 'C', x: 0, y: 0, z: 0 },
        { element: 'C', x: 1.4, y: 0, z: 0 },
        { element: 'C', x: 4.4, y: 0, z: 0 },
      ],
    };
    const overlap = refusal(() => expandSeries(wide, {
      from: 2, to: 2, linkage: { donor: 1, acceptor: 2, bondLengthAngstrom: 1.5, leaving: [] },
    }));
    expect(overlap).toBeInstanceOf(SeriesError);
    expect(overlap.message).toMatch(/overlap: atom \d+ \(C\) and atom \d+ \(C\) are [\d.]+ Å apart, below 0.5 Å/);
  });

  it('refuses a range above the cap, below 1, or empty', () => {
    const linkage = { donor: 1, acceptor: 2, bondLengthAngstrom: 1.5, leaving: [] };
    const over = refusal(() => expandSeries(twoAtomUnit, { from: 1, to: SERIES_MAX_MEMBERS + 1, linkage }));
    expect(over.message).toMatch(new RegExp(`the cap is ${SERIES_MAX_MEMBERS}`));
    expect(over.message).toMatch(/Every member multiplies every downstream block/);
    expect(refusal(() => expandSeries(twoAtomUnit, { from: 0, to: 3, linkage })).message)
      .toMatch(/starts at n = 0; a series starts at 1 or more/);
    expect(refusal(() => expandSeries(twoAtomUnit, { from: 3, to: 2, linkage })).message)
      .toMatch(/range is empty/);
  });

  it('refuses a bond length outside the sane window', () => {
    expect(guarded({ donor: 1, acceptor: 2, bondLengthAngstrom: 0.2, leaving: [] }).message)
      .toMatch(/outside 0.5–4 Å/);
  });

  it('refuses a member larger than one stored geometry may be', () => {
    const chain = Array.from({ length: 60 }, (_, index) => ({ element: 'C', x: index * 1.3, y: 0, z: 0 }));
    const unit = { ...twoAtomUnit, coords: chain };
    const error = refusal(() => expandSeries(unit, {
      from: 1, to: 20, linkage: { donor: 1, acceptor: 2, bondLengthAngstrom: 1.5, leaving: [] },
    }));
    expect(error.message).toMatch(/would hold 1200 atoms; one member is capped at 1000 atoms/);
  });

  it('refuses an ambiguous unit instead of taking the first record', () => {
    expect(refusal(() => seriesUnitRecord([twoAtomUnit, ethene], '')).message)
      .toMatch(/has 2 enabled records \(c2, ethene\); name the one repeat unit/);
    expect(refusal(() => seriesUnitRecord([twoAtomUnit], 'nope')).message)
      .toMatch(/unit record "nope" is not an enabled record/);
    expect(seriesUnitRecord([twoAtomUnit], '').id).toBe('c2');
  });

  it('reports the same refusal through recordsForInput, which the plan calls', () => {
    const dataset = {
      id: 'units',
      records: [{ ...twoAtomUnit, enabled: true }],
    };
    const node = {
      type: 'input',
      kind: 'series',
      input: {
        datasetId: 'units',
        recordId: 'c2',
        recordFilter: { field: '', equals: '' },
        series: { from: 1, to: 3, linkage: { donor: 1, acceptor: 2, bondLengthAngstrom: 1.5, leaving: [7] } },
      },
    };
    expect(() => recordsForInput(node, dataset)).toThrow(/not an atom index in the unit/);
  });
});

describe('issue 169 — the project schema keeps the definition and refuses it by name', () => {
  const project = (overrides = {}) => ({
    schemaVersion: 2,
    name: 'Series fixture',
    molecule: { smiles: '', charge: 0, multiplicity: 1, fragments: [], coords: water, geometry: { source: 'demo', file: '', format: '' } },
    defaults: { method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: '4' },
    runner: { maxParallel: 1 },
    datasets: [{
      id: 'units',
      title: 'Units',
      source: { kind: 'inline', path: '', format: 'sdf' },
      fields: { label: '', charge: '', multiplicity: '' },
      records: [{ ...ethene, enabled: true }],
      notes: '',
    }],
    flows: [{
      id: 'main',
      title: 'Series',
      nodes: [
        {
          id: 'in1',
          type: 'input',
          kind: 'series',
          title: 'Oligomers',
          state: 'ready',
          x: 0,
          y: 0,
          input: {
            datasetId: 'units',
            recordFilter: { field: '', equals: '' },
            recordId: 'ethene',
            series: { from: 1, to: 3, linkage: { ...etheneLinkage, leaving: [...etheneLinkage.leaving] } },
          },
        },
        {
          id: 'sp',
          type: 'calc',
          kind: 'SP',
          title: 'Single point',
          state: 'ready',
          x: 200,
          y: 0,
          settings: defaultSettings({ jobType: 'SP' }),
          output: null,
          checkpointFrom: null,
        },
      ],
      edges: [{ from: 'in1', to: 'sp', type: 'dependency' }],
    }],
    reports: [],
    activeFlowId: 'main',
    ...overrides,
  });

  it('validates a series block and stores the definition', () => {
    const result = validateProject(project());
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    const node = result.project.nodes[0];
    expect(node.kind).toBe('series');
    expect(node.input.series).toEqual({
      from: 1,
      to: 3,
      linkage: { donor: 1, acceptor: 2, bondLengthAngstrom: 1.5, leaving: [3, 6] },
    });
    expect(node.input.recordId).toBe('ethene');
    expect(result.warnings).toEqual([]);
  });

  it('round-trips the definition byte for byte', () => {
    const first = stringifyProject(project());
    expect(first.errors).toEqual([]);
    const second = stringifyProject(JSON.parse(first.text));
    expect(second.text).toBe(first.text);
    expect(first.text).toContain('"kind": "series"');
  });

  it('leaves a plain dataset block without the series keys', () => {
    const plain = project();
    plain.flows[0].nodes[0] = {
      id: 'in1', type: 'input', kind: 'Input', title: 'Enols', state: 'ready', x: 0, y: 0,
      input: { datasetId: 'units', recordFilter: { field: '', equals: '' } },
    };
    const result = stringifyProject(plain);
    expect(result.errors).toEqual([]);
    expect(result.text).not.toContain('series');
    expect(result.text).not.toContain('recordId');
  });

  it('refuses an unusable linkage when the project is opened, naming the atoms', () => {
    const bad = project();
    bad.flows[0].nodes[0].input.series.linkage = { donor: 3, acceptor: 3, bondLengthAngstrom: 1.5, leaving: [] };
    const result = validateProject(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path.endsWith('input.series')
      && /same atom \(3\)/.test(error.message))).toBe(true);
  });

  it('refuses a kind of "series" with no definition, and a malformed series', () => {
    const empty = project();
    delete empty.flows[0].nodes[0].input.series;
    const emptyResult = validateProject(empty);
    expect(emptyResult.errors.some((error) => error.path.endsWith('input.series')
      && /is required when the block kind is "series"/.test(error.message))).toBe(true);

    const broken = project();
    broken.flows[0].nodes[0].input.series = 'head-to-tail';
    const brokenResult = validateProject(broken);
    expect(brokenResult.errors.some((error) => error.path.endsWith('input.series')
      && /must be null or an object with from, to and linkage/.test(error.message))).toBe(true);
  });

  it('requires the linkage numbers instead of inventing them', () => {
    const missing = project();
    delete missing.flows[0].nodes[0].input.series.linkage.bondLengthAngstrom;
    const result = validateProject(missing);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path.endsWith('input.series.linkage.bondLengthAngstrom')
      && /is required/.test(error.message))).toBe(true);
  });

  it('drops an unknown series key with a warning instead of storing it', () => {
    const extra = project();
    extra.flows[0].nodes[0].input.series.linkage.angle = 180;
    const result = validateProject(extra);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((warning) => warning.path.endsWith('input.series.linkage.angle'))).toBe(true);
    expect(result.project.nodes[0].input.series.linkage.angle).toBeUndefined();
  });
});

describe('issue 169 — the plan expands the series, so nothing downstream changes', () => {
  const plan = () => {
    const result = validateProject({
      schemaVersion: 2,
      name: 'Series plan',
      molecule: { smiles: '', charge: 0, multiplicity: 1, fragments: [], coords: water, geometry: { source: 'demo', file: '', format: '' } },
      defaults: { method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: '4' },
      runner: { maxParallel: 1 },
      datasets: [{
        id: 'units',
        title: 'Units',
        source: { kind: 'inline', path: '', format: 'sdf' },
        fields: { label: '', charge: '', multiplicity: '' },
        records: [{ ...ethene, enabled: true }],
        notes: '',
      }],
      flows: [{
        id: 'main',
        title: 'Series',
        nodes: [
          {
            id: 'in1', type: 'input', kind: 'series', title: 'Oligomers', state: 'ready', x: 0, y: 0,
            input: {
              datasetId: 'units',
              recordFilter: { field: '', equals: '' },
              recordId: 'ethene',
              series: { from: 1, to: 3, linkage: { ...etheneLinkage, leaving: [...etheneLinkage.leaving] } },
            },
          },
          {
            id: 'sp', type: 'calc', kind: 'SP', title: 'Single point', state: 'ready', x: 200, y: 0,
            settings: defaultSettings({ jobType: 'SP' }), output: null, checkpointFrom: null,
          },
          { id: 'out1', type: 'output', kind: 'Output', title: 'Table', state: 'ready', x: 400, y: 0, output: { kind: 'csv', path: 'reports/series.csv', include: 'records', bundle: 'project.zip', manifest: true, notes: '' } },
        ],
        edges: [
          { from: 'in1', to: 'sp', type: 'dependency' },
          { from: 'sp', to: 'out1', type: 'dependency' },
        ],
      }],
      reports: [],
      activeFlowId: 'main',
    });
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    return buildWorkflowPlan(result.project);
  };

  it('queues one run per member, with record-to-record edges', () => {
    const built = plan();
    const executable = built.tasks.filter((task) => task.executable).map((task) => task.nodeId);
    expect(executable).toEqual(['sp~ethene-n1', 'sp~ethene-n2', 'sp~ethene-n3']);
    const into = built.edges.filter((edge) => edge.to.startsWith('sp~') && edge.type === 'dependency')
      .map((edge) => `${edge.from}->${edge.to}`);
    expect(into).toEqual([
      'in1->sp~ethene-n1',
      'in1->sp~ethene-n2',
      'in1->sp~ethene-n3',
    ]);
  });

  it('writes each member the geometry of its own n', () => {
    const built = plan();
    const trimer = built.tasks.find((task) => task.nodeId === 'sp~ethene-n3');
    const lines = trimer.inputText.split('\n');
    const start = lines.findIndex((line) => /^0 1$/.test(line.trim()));
    const atoms = lines.slice(start + 1).filter((line) => /^[A-Z][a-z]?\s/.test(line));
    expect(atoms).toHaveLength(14);
    expect(formulaOf(trimer.validity.molecule.coords)).toBe('C6H8');
    // The card and the queue row say which n this run is.
    expect(trimer.title).toBe('Single point — n=3');
  });

  it('carries parent and n on the task record, and lists every member on the input block', () => {
    const built = plan();
    const dimer = built.tasks.find((task) => task.nodeId === 'sp~ethene-n2');
    expect(dimer.record).toMatchObject({ id: 'ethene-n2', label: 'Ethene · n=2', charge: 0, multiplicity: 1 });
    expect(dimer.record.series).toMatchObject({ parentId: 'ethene', n: 2, count: 3 });
    expect(dimer.record.series.linkage).toEqual(etheneLinkage);
    const inputTask = built.tasks.find((task) => task.type === 'input');
    expect(inputTask.input.records.map((record) => record.id))
      .toEqual(['ethene-n1', 'ethene-n2', 'ethene-n3']);
    expect(inputTask.input.series).toEqual({ from: 1, to: 3, linkage: etheneLinkage });
  });

  it('still plans one task per dataset record when the block is not a series', () => {
    const result = validateProject({
      schemaVersion: 2,
      name: 'Plain',
      molecule: { smiles: '', charge: 0, multiplicity: 1, fragments: [], coords: water, geometry: { source: 'demo', file: '', format: '' } },
      defaults: { method: 'B3LYP', basis: 'def2-SVP', memory: '4', memoryUnit: 'GB', nproc: '4' },
      runner: { maxParallel: 1 },
      datasets: [{
        id: 'units', title: 'Units', source: { kind: 'inline', path: '', format: 'sdf' },
        fields: { label: '', charge: '', multiplicity: '' },
        records: [{ ...ethene, enabled: true }], notes: '',
      }],
      flows: [{
        id: 'main', title: 'Plain',
        nodes: [
          { id: 'in1', type: 'input', kind: 'Input', title: 'Units', state: 'ready', x: 0, y: 0, input: { datasetId: 'units', recordFilter: { field: '', equals: '' } } },
          { id: 'sp', type: 'calc', kind: 'SP', title: 'Single point', state: 'ready', x: 200, y: 0, settings: defaultSettings({ jobType: 'SP' }), output: null, checkpointFrom: null },
        ],
        edges: [{ from: 'in1', to: 'sp', type: 'dependency' }],
      }],
      reports: [],
      activeFlowId: 'main',
    });
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    const built = buildWorkflowPlan(result.project);
    expect(built.tasks.filter((task) => task.executable).map((task) => task.nodeId)).toEqual(['sp~ethene']);
  });
});

describe('issue 169 — helpers', () => {
  it('counts members the way the range reads', () => {
    expect(seriesMemberCount({ from: 1, to: 4 })).toBe(4);
    expect(seriesMemberCount({ from: 3, to: 3 })).toBe(1);
    expect(seriesMemberCount({ from: 3, to: 2 })).toBe(0);
    expect(seriesMemberCount(null)).toBe(0);
  });

  it('perceives the unit topology from covalent radii, 1-based', () => {
    const bonds = perceiveSeriesBonds(water);
    expect(bonds.map((bond) => [bond.a, bond.b])).toEqual([[1, 2], [1, 3]]);
    expect(bonds.every((bond) => bond.order === 1)).toBe(true);
  });

  it('splits leaving atoms by the end they belong to', () => {
    const prepared = validateSeriesLinkage({ atoms: ethene.coords, linkage: etheneLinkage });
    expect(prepared.donor).toBe(1);
    expect(prepared.acceptor).toBe(2);
    expect(prepared.leavingAtDonor).toEqual([3]);
    expect(prepared.leavingAtAcceptor).toEqual([6]);
    expect(prepared.axis.x).toBeCloseTo(1, 12);
    expect(prepared.step).toBeCloseTo(1.34 + 1.5, 12);
  });
});

describe('issue 169 — the input inspector shows the series it will queue', () => {
  let app;

  beforeAll(async () => {
    vi.stubGlobal('window', { desktop: null, innerWidth: 1440, innerHeight: 900, addEventListener: () => {} });
    vi.stubGlobal('document', { readyState: 'loading', addEventListener: () => {}, querySelector: () => null });
    app = await import('../src/renderer/app.js');
    app.state.project = {
      datasets: [{
        id: 'units',
        title: 'Units',
        source: { kind: 'inline', path: '', format: 'xyz' },
        fields: { label: '', charge: '', multiplicity: '' },
        records: [{ ...ethene, enabled: true }],
        notes: '',
      }],
      nodes: [],
      edges: [],
    };
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const inputNode = (overrides = {}) => ({
    id: 'in1',
    type: 'input',
    kind: 'Input',
    title: 'Oligomers',
    state: 'ready',
    x: 0,
    y: 0,
    input: { datasetId: 'units', recordFilter: { field: '', equals: '' } },
    ...overrides,
  });

  it('offers to repeat a plain record set as a series', () => {
    const html = app.inputInspector(inputNode());
    expect(html).toContain('data-action="series-enable"');
    expect(html).not.toContain('data-series-field="to"');
    expect(html).toContain('data-input-field="datasetId"');
  });

  it('renders the five linkage fields and every member the plan will queue', () => {
    const html = app.inputInspector(inputNode({
      kind: 'series',
      input: {
        datasetId: 'units',
        recordFilter: { field: '', equals: '' },
        recordId: 'ethene',
        series: { from: 1, to: 3, linkage: { ...etheneLinkage, leaving: [...etheneLinkage.leaving] } },
      },
    }));
    for (const field of ['recordId', 'from', 'to', 'donor', 'acceptor', 'bondLengthAngstrom', 'leaving']) {
      expect(html).toContain(`data-series-field="${field}"`);
    }
    expect(html).toContain('ethene-n1');
    expect(html).toContain('ethene-n3');
    expect(html).toContain('C4H6');
    expect(html).toContain('data-action="series-disable"');
    // The honest status of the geometry, in those words.
    expect(html).toContain('Starting point, not a minimum');
    expect(html).toContain('capped at both ends');
  });

  it('shows the refusal verbatim instead of a plausible preview', () => {
    const html = app.inputInspector(inputNode({
      kind: 'series',
      input: {
        datasetId: 'units',
        recordFilter: { field: '', equals: '' },
        recordId: 'ethene',
        series: { from: 1, to: 3, linkage: { donor: 1, acceptor: 1, bondLengthAngstrom: 1.5, leaving: [] } },
      },
    }));
    expect(html).toContain('Refused');
    expect(html).toContain('same atom (1)');
    expect(html).not.toContain('ethene-n1');
  });
});
