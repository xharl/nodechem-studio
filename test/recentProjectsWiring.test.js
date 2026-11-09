import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Issue 149, the half no DOM test can reach.
 *
 * The reducer and the JSON store are pinned in `recentProjects.test.js` and
 * `recentProjectsStore.test.js`. What is asserted here is the *wiring*: the IPC
 * surface exists, main records on open/save and refuses a path it did not
 * record, and the renderer has a real menu instead of the toast it shipped.
 *
 * This is a structural test, not a behavioural one — `src/renderer/app.js` is a
 * 7 000-line module that touches `document` at load, so vitest cannot import it.
 * It follows the pattern of `queueReconcileWiring.test.js`.
 */

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const mainSource = read('electron/main.js');
const preloadSource = read('electron/preload.cjs');
const appSource = read('src/renderer/app.js');
const htmlSource = read('index.html');

function functionBody(name, nextName) {
  const start = mainSource.indexOf(`function ${name}`);
  expect(start, `${name} should exist in electron/main.js`).toBeGreaterThan(-1);
  const end = mainSource.indexOf(`function ${nextName}`, start + 1);
  return mainSource.slice(start, end > start ? end : start + 4_000);
}

describe('recent projects — main process wiring (issue 149)', () => {
  it('registers the recent-list channels by name', () => {
    for (const channel of [
      'project:recent',
      'project:open-recent',
      'project:forget-recent',
      'project:clear-recent',
      'project:reveal',
    ]) {
      expect(mainSource).toContain(`ipcMain.handle('${channel}'`);
    }
  });

  it('records a successful open and a successful save', () => {
    expect(functionBody('readProjectFile', 'openProject')).toContain('rememberRecentProject(target, parsed.project)');
    const save = mainSource.slice(mainSource.indexOf('async function saveProject'));
    expect(save.slice(0, save.indexOf('async function exportGaussianInput')))
      .toContain('rememberRecentProject(target, serialized.project)');
    expect(mainSource).toContain('recent-projects.json');
  });

  it('opens a recent entry only after matching it against the recorded list', () => {
    const body = functionBody('openRecentProject', 'revealProject');
    const check = body.indexOf('recentProjects.entries().some');
    const readCall = body.indexOf('readProjectFile(requested)');
    expect(check).toBeGreaterThan(-1);
    expect(readCall).toBeGreaterThan(check);
    expect(body).toContain("'That project is not in the recent list.'");
  });

  it('does not let the renderer make main read an arbitrary path', () => {
    // `project:open-recent` takes a path but validates it first; `project:reveal`
    // only accepts a project this window opened or saved.
    expect(functionBody('openRecentProject', 'revealProject')).toContain('pathKey');
    const reveal = functionBody('revealProject', 'mainWindow');
    expect(reveal).toContain('knownProjectHashes.has(target)');
    expect(reveal).toContain('isProjectPath(target)');
  });

  it('exposes exactly that surface through the preload bridge', () => {
    for (const fn of [
      'recentProjects:',
      'openRecentProject:',
      'forgetRecentProject:',
      'clearRecentProjects:',
      'revealProject:',
    ]) {
      expect(preloadSource).toContain(fn);
    }
    expect(preloadSource).not.toContain('require(\'node:fs\')');
  });
});

describe('recent projects — renderer wiring (issue 149)', () => {
  it('is a real menu trigger, not the old toast', () => {
    expect(appSource).not.toContain('Use Open or Save in the top bar');
    expect(appSource).toContain("case 'project-menu': toggleProjectMenu();");
    expect(appSource).toContain('function toggleProjectMenu()');
    expect(appSource).toContain("syncMenuButton('#project-menu-btn', true)");
    expect(appSource).toContain("syncMenuButton('#project-menu-btn', false)");
  });

  it('renders each recent entry with name, folder, engines and modified label', () => {
    expect(appSource).toContain('desktop.recentProjects()');
    expect(appSource).toContain("from '../shared/recentProjects.js'");
    expect(appSource).toContain('entry.folder');
    expect(appSource).toContain('entry.engineSummary');
    expect(appSource).toContain('entry.modifiedLabel');
    expect(appSource).toContain('data-action="open-recent"');
    expect(appSource).toContain('data-action="forget-recent"');
    expect(appSource).toContain('data-action="clear-recent"');
  });

  it('shows a missing entry as Missing and disabled, never as openable', () => {
    const body = appSource.slice(appSource.indexOf('function recentProjectRow'));
    const row = body.slice(0, body.indexOf('function projectMenuHtml'));
    expect(row).toContain('const missing = entry.missing === true');
    expect(row).toContain('class="status-pill review">Missing');
    expect(row).toMatch(/missing\s*\n?\s*\? ' disabled aria-disabled="true"'/);
  });

  it('guards opening a project behind the unsaved-changes prompt', () => {
    const body = appSource.slice(appSource.indexOf('async function openProject()'));
    const guarded = body.slice(0, body.indexOf('async function openRecentProject'));
    expect(guarded).toContain('requestProjectReplacement(');
    expect(appSource).toContain("data-action=\"confirm-replace\"");
    expect(appSource).toContain('function renderReplaceConfirm()');
  });

  it('implements the keyboard contract on the menu itself', () => {
    expect(appSource).toContain("$('#project-menu')?.addEventListener('keydown', onProjectMenuKeydown)");
    expect(appSource).toContain("event.key === 'Escape'");
    expect(appSource).toContain("'ArrowDown', 'ArrowUp', 'Home', 'End'");
    expect(appSource).toContain('closeProjectMenu({ focus: true })');
  });

  it('marks the trigger as a menu in the document', () => {
    expect(htmlSource).toContain('id="project-menu-btn"');
    expect(htmlSource).toContain('aria-controls="project-menu"');
    expect(htmlSource).toContain('id="project-menu"');
    expect(htmlSource).toContain('role="menu"');
  });
});
