/**
 * The interop seam: SMILES in, NWChem/GAMESS/Q-Chem decks out.
 *
 * Issue 148 asked for three edges to be removed. Two of them are here:
 *
 *   1. **SMILES** — `./smiles.js` reads a bond graph. It deliberately produces
 *      no geometry, and `structureImport.js` refuses to turn that graph into a
 *      project geometry, because the app's structure block, project format and
 *      run builder all require 3D coordinates (the builder would fall back to
 *      the demo water molecule). `ncs smiles` prints the graph itself.
 *   2. **Export-only engines** — `./nwchem.js`, `./gamess.js` and `./qchem.js`
 *      write a deck from the same settings and molecule a Gaussian block uses,
 *      and refuse — by name, naming the field — anything they cannot spell.
 *
 * The third edge, ChemDraw's binary `.cdx`, is **not** implemented: see the
 * refusal in `structureImport.js`, which names the missing reader and the
 * supported CDXML path.
 *
 * `renderInput()` is the one entry point. It never throws for a bad request:
 * a refusal is a value, so a caller cannot mistake "not written" for "written".
 */

import { GAMESS_CAPABILITIES, GAMESS_ENGINE_ID, renderGamess } from './gamess.js';
import { NWCHEM_CAPABILITIES, NWCHEM_ENGINE_ID, renderNwchem } from './nwchem.js';
import { QCHEM_CAPABILITIES, QCHEM_ENGINE_ID, renderQchem } from './qchem.js';
import { moleculeForNode, settingsForNode } from '../workflowTasks.js';

export { SmilesError, describeSmilesGraph, parseSmiles, parseSmilesList } from './smiles.js';
export { DeckImportError, parseGamessInput, parseNwchemInput, parseQchemInput } from './deckImport.js';
export { MAX_Z, coordinate, prepareMolecule } from './deck.js';

export const EXPORTERS = Object.freeze({
  [NWCHEM_ENGINE_ID]: Object.freeze({
    id: NWCHEM_ENGINE_ID,
    label: 'NWChem',
    extension: '.nw',
    capabilities: NWCHEM_CAPABILITIES,
    render: renderNwchem,
  }),
  [GAMESS_ENGINE_ID]: Object.freeze({
    id: GAMESS_ENGINE_ID,
    label: 'GAMESS (US)',
    extension: '.inp',
    capabilities: GAMESS_CAPABILITIES,
    render: renderGamess,
  }),
  [QCHEM_ENGINE_ID]: Object.freeze({
    id: QCHEM_ENGINE_ID,
    label: 'Q-Chem',
    extension: '.qcin',
    capabilities: QCHEM_CAPABILITIES,
    render: renderQchem,
  }),
});

/** Ids in a stable order, for usage text and error messages. */
export const EXPORT_ENGINE_IDS = Object.freeze(Object.keys(EXPORTERS));

/** One exporter descriptor, or null. Unknown ids are a refusal, not a throw. */
export function exporterFor(engine) {
  const key = String(engine ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(EXPORTERS, key) ? EXPORTERS[key] : null;
}

/**
 * Render one deck.
 *
 * `{ ok: true, engine, text, notes }` or `{ ok: false, refused }` — never a
 * half-written deck and never an exception for an unsupported request.
 */
export function renderInput({ engine, settings = {}, molecule = {}, geometry = null, title = '' } = {}) {
  const exporter = exporterFor(engine);
  if (!exporter) {
    return {
      ok: false,
      refused: `"${engine}" is not an export engine here. Supported: ${EXPORT_ENGINE_IDS.join(', ')}. `
        + 'Gaussian, ORCA, Psi4 and xTB are run by the app; these three are export-only.',
    };
  }
  const result = exporter.render({ settings, molecule, geometry, title });
  return result.ok ? { ...result, engine: exporter.id } : result;
}

/**
 * The reason a project with no coordinates cannot be exported as a deck. Named
 * once because both the CLI and the window say it, and both must say the same
 * thing: `moleculeForNode` substitutes the demo water molecule, and a deck full
 * of water is worse than no deck.
 */
export const NO_GEOMETRY_REFUSAL = 'This project has no geometry: the block would fall back to the demo water molecule, '
  + 'and a deck full of water is worse than no deck. Import a structure into the project first.';

/**
 * One block of a project → one deck. **This is the only path** that turns a
 * project into NWChem/GAMESS/Q-Chem text: the CLI (`export-input`, `convert`)
 * and the window's Export menu all call it, so the two cannot drift into
 * writing different decks for the same block.
 *
 * `{ ok: true, engine, text, notes }` or `{ ok: false, code?, refused }`.
 * Refusals are values, never throws.
 */
export function renderBlockDeck({ project = null, node = null, engine = '' } = {}) {
  if (!project || typeof project !== 'object') {
    return { ok: false, code: 'no-project', refused: 'No project is open. A deck is written from a saved project and one of its blocks.' };
  }
  if (!node || typeof node !== 'object') {
    return { ok: false, code: 'no-node', refused: 'Select a calculation block: a deck is written from that block\'s settings and the project geometry.' };
  }
  // Checked before `moleculeForNode`, which fills an empty project with the
  // demo water molecule rather than reporting the absence.
  const coords = project.molecule?.coords;
  if (!Array.isArray(coords) || coords.length === 0) {
    return { ok: false, code: 'export-no-geometry', refused: NO_GEOMETRY_REFUSAL };
  }
  return renderInput({
    engine,
    settings: settingsForNode(project, node),
    molecule: moleculeForNode(project, node),
    geometry: project.molecule?.geometry ?? null,
    title: node.title,
  });
}
