import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Issue 315 — the save path.
 *
 * The pure half (collapsing a doubled suffix) is pinned in `projectFile.test.js`
 * against the cases the report names. What is asserted here is the wiring in
 * `electron/main.js`, which vitest cannot import because it opens a window:
 * the chosen name is normalised on both save paths, an unknown existing file is
 * confirmed before it is replaced, and the dialog reopens where the last save
 * went. This follows `recentProjectsWiring.test.js`.
 */

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const mainSource = read('electron/main.js');

const start = mainSource.indexOf('async function saveProject');
const end = mainSource.indexOf('async function exportGaussianInput');
const saveBody = mainSource.slice(start, end > start ? end : start + 6_000);

describe('project save path — main process wiring (issue 315)', () => {
  it('finds the save function', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it('normalises the name the dialog returns and the path the renderer supplies', () => {
    // Both entry points reach the same helper, so "foo.ncs" and "foo" converge
    // and "foo.ncs.ncs" collapses instead of growing.
    expect(saveBody).toContain('target = withProjectExtension(result.filePath)');
    expect(saveBody).toContain('target = withProjectExtension(target)');
  });

  it('asks before replacing a file this process never read or wrote', () => {
    const prompt = saveBody.indexOf('showMessageBox');
    const write = saveBody.indexOf('fsp.writeFile');
    expect(prompt).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(prompt);
    expect(saveBody).toContain("buttons: ['Replace', 'Cancel']");
    expect(saveBody).toContain('!knownProjectHashes.has(target)');
    // A cancelled prompt is a cancelled save, not a write.
    expect(saveBody).toContain('if (answer.response !== 0) return { canceled: true };');
  });

  it('reopens the dialog in the folder the last save used', () => {
    expect(saveBody).toContain("lastProjectSaveDir || app.getPath('documents')");
    expect(saveBody).toContain('lastProjectSaveDir = path.dirname(target)');
  });
});
