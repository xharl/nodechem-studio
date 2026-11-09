/**
 * Export-menu action: write one block's NWChem / GAMESS / Q-Chem deck.
 *
 * The text is not built here. `renderBlockDeck` in `src/shared/interop/index.js`
 * is the only project → deck path, and `ncs export-input` / `ncs convert
 * --format <engine>` call the same function — so the menu and the terminal
 * cannot write different decks for the same block. This module owns only the
 * window-shaped part: which desktop call to make and what to tell the user.
 *
 * Nothing is written on a refusal. The refusal is the exporter's own sentence
 * (it names the field and the remedy), shown verbatim rather than summarised,
 * because a dropped route option is a different calculation.
 */

import { exporterFor, renderBlockDeck } from '../shared/interop/index.js';

/** A basename the main process will accept: letters, digits, dot, underscore, dash. */
function safeBase(value) {
  return String(value || 'job').replace(/[^A-Za-z0-9._-]/g, '_');
}

export function deckFilename(node, exporter) {
  const base = safeBase(node?.id || node?.title || 'job');
  return `${base}${exporter?.extension || '.txt'}`;
}

/**
 * `{ canceled: true }`, `{ error, message }`, or `{ path, engine }`.
 * Never claims success without a path from the main process.
 */
export async function exportDeckAction({ desktop, project, node, engine, notify } = {}) {
  const say = typeof notify === 'function' ? notify : () => {};
  const exporter = exporterFor(engine);
  if (!exporter) {
    const message = `"${engine}" is not an export engine. The window exports NWChem, GAMESS and Q-Chem decks.`;
    say(message);
    return { error: 'unknown-engine', message };
  }
  if (!node) {
    const message = 'Select a calculation block: its settings are the deck\'s route.';
    say(message);
    return { error: 'no-node', message };
  }
  const rendered = renderBlockDeck({ project, node, engine: exporter.id });
  if (!rendered.ok) {
    say(rendered.refused);
    return { error: rendered.code || 'export-refused', message: rendered.refused };
  }
  if (!desktop?.saveText) {
    say('Open the desktop app to export a deck.');
    return { canceled: true };
  }
  const filename = deckFilename(node, exporter);
  try {
    const result = await desktop.saveText({ suggestedName: filename, text: rendered.text });
    if (result?.canceled) return result;
    if (result?.error) {
      say(`Could not export: ${result.error.message}`);
      return result;
    }
    say(`Exported ${result.path}`);
    return { path: result.path, engine: rendered.engine, notes: rendered.notes };
  } catch (error) {
    say(`Could not export: ${error.message}`);
    return { error: error.message };
  }
}
