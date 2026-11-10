/**
 * Issue 252 — markup and seeding rules for the app-wide Settings window.
 *
 * Kept out of `app.js` so the page structure and the "local override wins over
 * Settings" rule can be tested without a DOM. The renderer supplies the modal
 * shell, focus handling and IPC; this module only says what each page contains.
 */
import { ENGINES } from '../shared/engines/index.js';
import { XTB_METHODS, XTB_OPT_LEVELS } from '../shared/engines/xtb.js';
import {
  SETTINGS_MEMORY_UNITS,
} from '../shared/appSettings.js';

export const SETTINGS_PAGES = Object.freeze([
  { id: 'engines', label: 'Engines', title: 'Engines', description: 'The console executable for each engine. These are machine facts: every project uses them.' },
  { id: 'tools', label: 'Tools', title: 'Tools', description: 'Companion programs the runner spawns. Blank optional tools stay optional.' },
  { id: 'runs', label: 'Runs', title: 'Runs', description: 'Defaults a new run starts from. The run console keeps the per-run override.' },
  { id: 'appearance', label: 'Appearance', title: 'Appearance', description: 'Window and panel behaviour. The theme stays in the app menu.' },
  { id: 'projectDefaults', label: 'Project defaults', title: 'Project defaults', description: 'What a newly created project starts with. A saved project keeps its own defaults.' },
  { id: 'advanced', label: 'Advanced', title: 'Advanced', description: 'Storage and diagnostics. Change these only when you know where your runs should live.' },
]);

const ENGINE_COPY = Object.freeze({
  gaussian: 'Gaussian 16',
  xtb: 'xTB',
  psi4: 'Psi4',
  orca: 'ORCA',
  pyscf: 'PySCF',
});

const TOOL_COPY = Object.freeze({
  crest: { title: 'CREST', hint: 'Conformer searches' },
  obabel: { title: 'Open Babel', hint: 'MMFF94 conformers, embed3d and relax' },
  scorer: { title: 'ML scorer', hint: 'Optional AIMNet2 sidecar' },
  multiwfn: { title: 'Multiwfn', hint: 'User-installed 3.8 binary for analyse blocks' },
  tautomer: { title: 'Tautomer sidecar', hint: 'Python interpreter for RDKit enumeration' },
});

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function trimmed(value) {
  return String(value ?? '').trim();
}

/** Local per-run values win over Settings; Settings fills the blanks. */
export function runFieldSeed({ settings, saved = {} } = {}) {
  const tools = settings?.tools || {};
  const runs = settings?.runs || {};
  const or = (localValue, settingsValue) => trimmed(localValue) || trimmed(settingsValue);
  return {
    crest: or(saved.crestExecutable, tools.crest),
    obabel: or(saved.obabelExecutable, tools.obabel),
    scorer: or(saved.scorerExecutable, tools.scorer),
    multiwfn: or(saved.multiwfnExecutable, tools.multiwfn),
    tautomer: or(saved.tautomerExecutable, tools.tautomer),
    tautomerScript: or(saved.tautomerScript, tools.tautomerScript),
    scratch: or(saved.scratchDir, tools.scratch),
    dryRun: typeof saved.dryRun === 'boolean' ? saved.dryRun : runs.dryRun !== false,
  };
}

/** The effective per-engine executable map: a local override, else Settings. */
export function engineExecutableMap(settings, local = {}) {
  const map = {};
  for (const [id, value] of Object.entries(local || {})) {
    if (trimmed(value)) map[id] = trimmed(value);
  }
  for (const [id, value] of Object.entries(settings?.engines || {})) {
    if (!map[id] && trimmed(value)) map[id] = trimmed(value);
  }
  return map;
}

/** Keep only local values that genuinely differ from Settings. */
export function localOverrides(values, settingsValues, keys) {
  const out = {};
  for (const key of keys) {
    const value = trimmed(values?.[key]);
    if (value && value !== trimmed(settingsValues?.[key])) out[key] = value;
  }
  return out;
}

function errorFor(errors, field) {
  const found = (Array.isArray(errors) ? errors : []).find((error) => error?.field === field);
  return found
    ? `<p class="field-hint is-warn" data-settings-error="${esc(field)}">${esc(found.message)}</p>`
    : '';
}

function statusFor({ configured, detected, version }) {
  const path = trimmed(configured) || trimmed(detected?.path);
  if (configured && detected?.ok && trimmed(detected.path) === trimmed(configured)) {
    return {
      tone: 'ok',
      label: 'detected',
      detail: `Found at ${detected.path}${version ? ` · version ${version}` : ''}`,
    };
  }
  if (configured) {
    return {
      tone: 'set',
      label: 'set',
      detail: `Using ${configured}${version ? ` · version ${version}` : ''}`,
    };
  }
  if (detected?.ok) {
    return {
      tone: 'ok',
      label: 'detected on PATH',
      detail: `Found at ${detected.path}${version ? ` · version ${version}` : ''}`,
    };
  }
  return {
    tone: 'missing',
    label: 'not found',
    detail: path ? `Not found at ${path}` : 'Not found on PATH. Set it if this machine has it.',
  };
}

function textField(label, field, value, {
  placeholder = '', type = 'text', hint = '', attrs = '', errors = [],
} = {}) {
  return `<label class="settings-field">
    <span>${esc(label)}</span>
    <input class="input" type="${esc(type)}" data-settings-field="${esc(field)}" value="${esc(value)}"
      placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off" ${attrs}>
    ${hint ? `<small>${esc(hint)}</small>` : ''}
    ${errorFor(errors, field)}
  </label>`;
}

function selectField(label, field, options, value, { hint = '', errors = [] } = {}) {
  return `<label class="settings-field">
    <span>${esc(label)}</span>
    <select class="select" data-settings-field="${esc(field)}">
      ${options.map(([id, text]) => `<option value="${esc(id)}"${String(value) === String(id) ? ' selected' : ''}>${esc(text)}</option>`).join('')}
    </select>
    ${hint ? `<small>${esc(hint)}</small>` : ''}
    ${errorFor(errors, field)}
  </label>`;
}

function executableRow({ label, field, hint, value, detected, version, browse, errors }) {
  const status = statusFor({ configured: value, detected, version });
  return `<div class="settings-row" data-settings-row="${esc(field)}">
    <div class="settings-row-head">
      <div><strong>${esc(label)}</strong>${hint ? `<span class="settings-row-hint">${esc(hint)}</span>` : ''}</div>
      <span class="settings-status is-${esc(status.tone)}">${esc(status.label)}</span>
    </div>
    <div class="settings-path">
      <input class="input" type="text" data-settings-field="${esc(field)}" value="${esc(value)}"
        placeholder="${esc(detected?.path || 'Choose the executable…')}" spellcheck="false" autocomplete="off">
      ${browse
    ? `<button type="button" class="btn small" data-action="settings-browse" data-settings-browse="${esc(browse)}">Browse…</button>`
    : ''}
    </div>
    <p class="settings-row-meta">${esc(status.detail)}</p>
    ${errorFor(errors, field)}
  </div>`;
}

function enginesPage(draft, detection, errors) {
  return `<div class="settings-page-head">
    <h3>Engines</h3>
    <p>Detection checks this machine's PATH. A typed path is validated when you save; a path that cannot run is refused with the reason.</p>
    <button type="button" class="btn small" data-action="settings-detect">Detect again</button>
  </div>
  <div class="settings-rows">
    ${Object.keys(ENGINE_COPY).map((id) => executableRow({
    label: ENGINE_COPY[id],
    field: `engines.${id}`,
    value: draft?.engines?.[id] || '',
    detected: detection?.[id] || null,
    version: detection?.versions?.[trimmed(draft?.engines?.[id])]
      || detection?.versions?.[trimmed(detection?.[id]?.path)] || '',
    browse: `engine:${id}`,
    errors,
  })).join('')}
  </div>`;
}

function toolsPage(draft, detection, errors) {
  const toolStatus = detection?.tools || {};
  return `<div class="settings-page-head">
    <h3>Tools</h3>
    <p>Companion programs are optional until a block asks for one. A configured path is checked before it is saved.</p>
    <button type="button" class="btn small" data-action="settings-detect">Detect again</button>
  </div>
  <div class="settings-rows">
    ${Object.entries(TOOL_COPY).map(([id, copy]) => executableRow({
    label: copy.title,
    hint: copy.hint,
    field: `tools.${id}`,
    value: draft?.tools?.[id] || '',
    detected: toolStatus[id] || null,
    version: detection?.versions?.[trimmed(draft?.tools?.[id])]
      || detection?.versions?.[trimmed(toolStatus[id]?.path)] || '',
    browse: `tool:${id}`,
    errors,
  })).join('')}
    ${executableRow({
    label: 'Tautomer script',
    hint: 'Optional script passed to the interpreter',
    field: 'tools.tautomerScript',
    value: draft?.tools?.tautomerScript || '',
    detected: null,
    errors,
  })}
    ${textField('Scratch directory', 'tools.scratch', draft?.tools?.scratch || '', {
    placeholder: 'defaults to the run directory',
    hint: 'Scratch files are written here; leave blank to use each run folder.',
    errors,
  })}
  </div>`;
}

function runsPage(draft, errors) {
  const runs = draft?.runs || {};
  return `<div class="settings-page-header"><h3>Runs</h3>
    <p>These seed the run console. A value typed in the console is a per-run override and is not written back here.</p></div>
  <div class="settings-form">
    <label class="settings-check">
      <input type="checkbox" data-settings-field="runs.dryRun"${runs.dryRun !== false ? ' checked' : ''}>
      <span><strong>Dry run by default</strong><small>Writes synthetic fixture output, not chemistry. Recommended until the engine paths are proven.</small></span>
    </label>
    ${textField('Task time limit (seconds)', 'runs.timeoutSeconds', runs.timeoutSeconds || '', {
    type: 'number',
    placeholder: '3600',
    attrs: 'min="0" max="86400" step="1"',
    hint: '0 or blank uses the built-in 3600 s limit. A block can set its own limit.',
    errors,
  })}
    ${textField('Parallel tasks', 'runs.maxParallel', runs.maxParallel ?? 1, {
    type: 'number',
    attrs: 'min="1" max="64" step="1"',
    hint: 'How many independent tasks a new queue runs at once.',
    errors,
  })}
  </div>`;
}

function appearancePage(draft) {
  const appearance = draft?.appearance || {};
  return `<div class="settings-page-header"><h3>Appearance</h3>
    <p>The run console can live wherever you last dragged it, or always return to the corner.</p></div>
  <div class="settings-form">
    <label class="settings-check">
      <input type="checkbox" data-settings-field="appearance.runConsoleDock"${appearance.runConsoleDock === true ? ' checked' : ''}>
      <span><strong>Keep the run console docked</strong><small>A dragged position is forgotten at the next start when this is on.</small></span>
    </label>
    <div class="settings-action-row">
      <button type="button" class="btn small" data-action="settings-reset-console">Reset run console position now</button>
    </div>
    <p class="field-hint">Theme is still chosen from the app menu (top-left) and applies immediately.</p>
  </div>`;
}

function projectDefaultsPage(draft, errors) {
  const defaults = draft?.projectDefaults || {};
  const engineOptions = Object.values(ENGINES).map((engine) => [engine.id, engine.label]);
  return `<div class="settings-page-header"><h3>Project defaults</h3>
    <p>Applied when a project is created. Existing projects keep the defaults saved in their own file.</p></div>
  <div class="settings-form form-grid">
    ${selectField('Engine', 'projectDefaults.engine', engineOptions, defaults.engine, { errors })}
    ${selectField('xTB method', 'projectDefaults.xtbMethod', XTB_METHODS.map((item) => [item.id, item.label]), defaults.xtbMethod, { errors })}
    ${selectField('xTB optimisation level', 'projectDefaults.xtbOptLevel', XTB_OPT_LEVELS.map((level) => [level, level]), defaults.xtbOptLevel, { errors })}
    ${textField('Method', 'projectDefaults.method', defaults.method, { placeholder: 'B3LYP', errors })}
    ${textField('Basis', 'projectDefaults.basis', defaults.basis, { placeholder: 'def2-SVP', errors })}
    ${textField('Memory', 'projectDefaults.memory', defaults.memory, {
    type: 'number', attrs: 'min="1" max="1048576" step="1"', errors,
  })}
    ${selectField('Memory unit', 'projectDefaults.memoryUnit', SETTINGS_MEMORY_UNITS.map((unit) => [unit, unit]), defaults.memoryUnit, { errors })}
    ${textField('Cores (nproc)', 'projectDefaults.nproc', defaults.nproc, {
    type: 'number', attrs: 'min="1" max="1024" step="1"', errors,
  })}
  </div>`;
}

function advancedPage(draft, settingsPath, errors) {
  return `<div class="settings-page-header"><h3>Advanced</h3>
    <p>Where this app keeps what it writes. Projects are never stored here.</p></div>
  <div class="settings-form">
    ${textField('Data directory', 'advanced.dataDir', draft?.advanced?.dataDir || '', {
    placeholder: 'app user-data folder',
    hint: 'Runs and queues are written under this folder. Takes effect the next time the app starts.',
    errors,
  })}
    <div class="settings-action-row">
      <span>Settings file</span>
      <code>${esc(settingsPath || 'settings.json')}</code>
    </div>
    <p class="field-hint">No secrets are stored in this file. It contains paths and defaults only.</p>
  </div>`;
}

const PAGE_RENDERERS = Object.freeze({
  engines: (draft, detection, errors) => enginesPage(draft, detection, errors),
  tools: (draft, detection, errors) => toolsPage(draft, detection, errors),
  runs: (draft, _detection, errors) => runsPage(draft, errors),
  appearance: (draft) => appearancePage(draft),
  projectDefaults: (draft, _detection, errors) => projectDefaultsPage(draft, errors),
  advanced: (draft, _detection, errors, settingsPath) => advancedPage(draft, settingsPath, errors),
});

export function settingsPageHtml({
  page = 'engines',
  draft = {},
  detection = null,
  errors = [],
  settingsPath = '',
} = {}) {
  const renderer = PAGE_RENDERERS[page] || PAGE_RENDERERS.engines;
  return renderer(draft, detection, errors, settingsPath);
}
