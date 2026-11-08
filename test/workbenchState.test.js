import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * The workbench's queue-driven state, checked without a browser.
 *
 * `resultFacts`, `runStateOf` and `syncNodeStatesFromQueue` are what make a
 * card, a flow tab and the status bar agree with the queue. They are pure
 * functions over `state`, so they can be pinned here: a card that says
 * "ready" after a run finished, or a family that reads "passed" while one
 * record failed, is a lie the user acts on. The full visual smoke is still
 * not covered by this file.
 */

describe('workbench state follows the queue', () => {
  let app;

  beforeAll(async () => {
    vi.stubGlobal('window', {
      desktop: null,
      innerWidth: 1440,
      innerHeight: 900,
      addEventListener: () => {},
    });
    vi.stubGlobal('document', {
      readyState: 'loading',
      addEventListener: () => {},
      querySelector: () => null,
    });
    app = await import('../src/renderer/app.js');
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const setNodes = (nodes) => {
    app.state.project.nodes = nodes;
  };

  const setQueue = (tasks) => {
    app.state.queue = { id: 'q1', status: 'completed', flowId: 'main', tasks, reason: null };
  };

  const calcNode = (id, extra = {}) => ({
    id,
    type: 'calc',
    kind: 'Calculation',
    title: id,
    state: 'ready',
    x: 0,
    y: 0,
    ...extra,
  });

  describe('a card reports what the block produced', () => {
    it('shows the final energy and the quantity that decides the gate', () => {
      setNodes([calcNode('opt')]);
      setQueue([{ nodeId: 'opt', status: 'completed', gateVerdict: 'pass' }]);
      const node = app.state.project.nodes[0];
      node.parsed = {
        finalEnergy: { hartree: -76.419737 },
        thermochemistry: { freeEnergyHartree: -76.393 },
        frequencies: { imaginaryCount: 0 },
      };
      const facts = app.resultFacts(node);
      expect(facts.main).toBe('E -76.41974 Eh');
      expect(facts.sub).toBe('ΔG -76.39300 · 0 imaginary');
      expect(facts.tone).toBe('ok');
    });

    it('marks a failed gate as bad instead of colouring the number as success', () => {
      setNodes([calcNode('freq')]);
      setQueue([{ nodeId: 'freq', status: 'completed', gateVerdict: 'fail' }]);
      const node = app.state.project.nodes[0];
      node.parsed = { finalEnergy: { hartree: -76.4 }, frequencies: { imaginaryCount: 2 } };
      const facts = app.resultFacts(node);
      expect(facts.sub).toBe('2 imaginary');
      expect(facts.tone).toBe('bad');
    });

    it('reports a dataset block as records finished and gates passed, not one energy', () => {
      setNodes([calcNode('opt')]);
      setQueue([
        { nodeId: 'opt~m1', status: 'completed', gateVerdict: 'pass' },
        { nodeId: 'opt~m2', status: 'completed', gateVerdict: 'pass' },
        { nodeId: 'opt~m3', status: 'completed', gateVerdict: 'fail' },
      ]);
      const facts = app.resultFacts(app.state.project.nodes[0]);
      expect(facts.main).toBe('3/3 records');
      expect(facts.sub).toBe('2/3 gates pass');
      expect(facts.tone).toBe('warn');
    });

    it('says a family is still running rather than implying it finished', () => {
      setNodes([calcNode('opt')]);
      setQueue([
        { nodeId: 'opt~m1', status: 'completed', gateVerdict: 'pass' },
        { nodeId: 'opt~m2', status: 'running' },
      ]);
      const facts = app.resultFacts(app.state.project.nodes[0]);
      expect(facts.main).toBe('1/2 records · running');
      expect(facts.tone).toBe('');
    });

    it('shows a SAPT total in the units the card computes', () => {
      setNodes([calcNode('sapt')]);
      setQueue([{ nodeId: 'sapt', status: 'completed', gateVerdict: 'pass' }]);
      const node = app.state.project.nodes[0];
      node.parsed = { sapt: { totalKj: -21.38, totalKcal: -5.11 } };
      const facts = app.resultFacts(node);
      expect(facts.main).toBe('-21.38 kJ/mol');
      expect(facts.sub).toBe('SAPT0 · -5.11 kcal/mol');
    });

    it('names the artifact an output block wrote, with a short size', () => {
      setNodes([{ ...calcNode('out'), type: 'output', title: 'Write CSV' }]);
      setQueue([{ nodeId: 'out', status: 'completed', reason: 'wrote screen/results.csv · 4105 bytes · sha256 abc' }]);
      const facts = app.resultFacts(app.state.project.nodes[0]);
      expect(facts.main).toBe('screen/results.csv · 4.0 kB');
      expect(facts.sub).toBe('');
    });

    it('invents nothing when the parser reported no numbers', () => {
      setNodes([calcNode('opt')]);
      setQueue([{ nodeId: 'opt', status: 'completed', gateVerdict: 'pass' }]);
      const node = app.state.project.nodes[0];
      node.parsed = {};
      expect(app.resultFacts(node)).toBeNull();
    });
  });

  describe('the live indicator', () => {
    it('marks the running block and leaves the others idle', () => {
      setNodes([calcNode('a'), calcNode('b')]);
      setQueue([
        { nodeId: 'a', status: 'completed' },
        { nodeId: 'b', status: 'running' },
      ]);
      expect(app.runStateOf(app.state.project.nodes[0])).toBeNull();
      expect(app.runStateOf(app.state.project.nodes[1])).toBe('running');
    });

    it('treats a queued block as queued, not running', () => {
      setNodes([calcNode('c')]);
      setQueue([{ nodeId: 'c', status: 'queued' }]);
      expect(app.runStateOf(app.state.project.nodes[0])).toBe('queued');
    });
  });

  describe('node state', () => {
    it('passes a block whose every family record completed and passed', () => {
      setNodes([calcNode('opt')]);
      app.syncNodeStatesFromQueue({
        tasks: [
          { nodeId: 'opt~m1', status: 'completed', gateVerdict: 'pass' },
          { nodeId: 'opt~m2', status: 'completed', gateVerdict: 'pass' },
        ],
      });
      expect(app.state.project.nodes[0].state).toBe('passed');
    });

    it('sends a family to review when one record failed its gate', () => {
      setNodes([calcNode('opt')]);
      app.syncNodeStatesFromQueue({
        tasks: [
          { nodeId: 'opt~m1', status: 'completed', gateVerdict: 'pass' },
          { nodeId: 'opt~m2', status: 'completed', gateVerdict: 'fail' },
        ],
      });
      expect(app.state.project.nodes[0].state).toBe('review');
    });

    it('sends a failed task to review and leaves a running family alone', () => {
      setNodes([calcNode('a'), calcNode('b')]);
      app.syncNodeStatesFromQueue({
        tasks: [
          { nodeId: 'a', status: 'failed' },
          { nodeId: 'b~m1', status: 'completed', gateVerdict: 'pass' },
          { nodeId: 'b~m2', status: 'running' },
        ],
      });
      expect(app.state.project.nodes[0].state).toBe('review');
      expect(app.state.project.nodes[1].state).toBe('ready');
    });

    it('reads a branch that was not taken as passed, not as pending work', () => {
      setNodes([{ ...calcNode('loop'), type: 'loop' }]);
      app.syncNodeStatesFromQueue({ tasks: [{ nodeId: 'loop', status: 'skipped' }] });
      expect(app.state.project.nodes[0].state).toBe('passed');
    });

    it('blocks a block whose task was blocked', () => {
      setNodes([calcNode('freq')]);
      app.syncNodeStatesFromQueue({ tasks: [{ nodeId: 'freq', status: 'blocked' }] });
      expect(app.state.project.nodes[0].state).toBe('blocked');
    });

    it('does nothing when there is no queue to read', () => {
      setNodes([calcNode('idle')]);
      expect(app.syncNodeStatesFromQueue({ tasks: [] })).toBeUndefined();
      expect(app.state.project.nodes[0].state).toBe('ready');
    });
  });
});
