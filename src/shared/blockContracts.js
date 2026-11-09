/**
 * ADR 0001 §4 — the block contract, in one table.
 *
 * Field-level checks stay in `projectSchema.js` (a route key, a path, a
 * conformer id). This module states the *shape* rules: what a block may read,
 * what it writes, and whether it may spawn a program. Every rule below has one
 * test in `test/blockContracts.test.js`.
 */

const STRUCTURE_TYPES = new Set(['input', 'prepare', 'generate', 'calculate']);
const RECORD_TYPES = new Set(['calculate', 'analyse']);
const CONTROL_TYPES = new Set(['condition', 'loop', 'merge']);

export const BLOCK_CONTRACTS = Object.freeze({
  input: Object.freeze({
    reads: 'files or datasets',
    writes: 'records or one ensemble',
    spawnsEngine: false,
    rule: 'no structure edges in',
  }),
  prepare: Object.freeze({
    reads: 'one structure',
    writes: 'one structure',
    spawnsEngine: false,
    rule: 'at most one structure in; no method settings',
  }),
  generate: Object.freeze({
    reads: 'one structure (search) or one ensemble (imported)',
    writes: 'one ensemble',
    spawnsEngine: false,
    rule: 'owns selection and fan-out',
  }),
  calculate: Object.freeze({
    reads: 'one structure',
    writes: 'one record',
    spawnsEngine: true,
    rule: 'requires an engine, an executable and a method',
  }),
  analyse: Object.freeze({
    reads: 'one or more records',
    writes: 'one table',
    spawnsEngine: false,
    rule: 'may not spawn a program',
  }),
  output: Object.freeze({
    reads: 'one or more records or tables',
    writes: 'one artifact',
    spawnsEngine: false,
    rule: 'nothing downstream',
  }),
  condition: Object.freeze({ reads: 'records', writes: 'branch decision', spawnsEngine: false, rule: 'control payload only' }),
  loop: Object.freeze({ reads: 'records', writes: 'loop decision', spawnsEngine: false, rule: 'control payload only' }),
  merge: Object.freeze({ reads: 'records', writes: 'records', spawnsEngine: false, rule: 'control payload only' }),
  note: Object.freeze({ reads: 'nothing', writes: 'nothing', spawnsEngine: false, rule: 'annotation only' }),
});

function isStructure(node) {
  return STRUCTURE_TYPES.has(node?.type);
}

/**
 * Validate one flow against the table.
 * Returns `{ errors, warnings }` with `{ path, message }` entries; the caller
 * decides whether a finding blocks a run or only warns.
 */
export function validateBlockContracts(flow) {
  const errors = [];
  const warnings = [];
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
  const edges = Array.isArray(flow?.edges) ? flow.edges : [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = (id) => edges.filter((edge) => edge.to === id && byId.has(edge.from));
  const outgoing = (id) => edges.filter((edge) => edge.from === id && byId.has(edge.to));

  nodes.forEach((node, index) => {
    const path = `flows[${flow?.id || 'main'}].nodes[${index}]`;
    const ins = incoming(node.id);
    const outs = outgoing(node.id);
    if (node.type === 'input') {
      if (ins.some((edge) => isStructure(byId.get(edge.from)) || ['merge', 'output'].includes(byId.get(edge.from)?.type))) {
        errors.push({ path, message: 'an input block has no structure edges in; it is the source of a scope.' });
      }
    } else if (node.type === 'prepare') {
      const structures = ins.filter((edge) => isStructure(byId.get(edge.from)));
      if (structures.length > 1) {
        errors.push({ path, message: 'prepare takes one structure in; wire exactly one upstream structure, or none to use the project molecule.' });
      }
      if (node.settings && (node.settings.method || node.settings.basis || node.settings.jobType)) {
        errors.push({ path, message: 'prepare has no method settings; it is a deterministic tool call, not a calculation.' });
      }
    } else if (node.type === 'generate') {
      const structures = ins.filter((edge) => isStructure(byId.get(edge.from)));
      const ensembleInputs = structures.filter((edge) => {
        const source = byId.get(edge.from);
        return source?.type === 'input' && source?.input?.kind === 'ensemble';
      });
      if (node.settings?.source === 'imported') {
        if (ensembleInputs.length !== 1) {
          errors.push({ path, message: 'an imported generate block reads exactly one ensemble input.' });
        }
      } else if (ensembleInputs.length > 0) {
        errors.push({ path, message: 'a search generate block reads a structure, not an ensemble input; set source to "imported" or unwire it.' });
      }
    } else if (node.type === 'calculate') {
      const structures = ins.filter((edge) => isStructure(byId.get(edge.from)));
      if (structures.length > 1) {
        warnings.push({ path, message: 'calculate reads more than one structure; only the first branch geometry is used, and fan-out decisions may be ambiguous.' });
      }
    } else if (node.type === 'analyse') {
      const records = ins.filter((edge) => RECORD_TYPES.has(byId.get(edge.from)?.type) || byId.get(edge.from)?.type === 'generate');
      if (records.length === 0) {
        warnings.push({ path, message: 'analyse has no record input wired; its expression has nothing to read.' });
      }
    } else if (node.type === 'output') {
      if (outs.length > 0) {
        errors.push({ path, message: 'output is terminal; nothing may be wired downstream of it.' });
      }
      const records = nodes.filter((entry) => RECORD_TYPES.has(entry.type));
      if (records.length === 0) {
        warnings.push({ path, message: 'output has no record or table to write yet.' });
      }
    } else if (CONTROL_TYPES.has(node.type)) {
      // Control payloads are validated by their own schema; the contract only
      // says they do not spawn a program.
      if (node.settings && Object.keys(node.settings).length > 0) {
        warnings.push({ path, message: `${node.type} carries calculation settings; they are ignored by the control runtime.` });
      }
    }
  });
  return { errors, warnings };
}
