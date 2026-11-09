/**
 * The wavefunction viewport: one card in the results surface that turns the
 * basis a run already carries into a plane slice or an isosurface.
 *
 * What it will and will not do:
 *
 * - It evaluates the orbital (or the density) from the parsed shells and MO
 *   coefficients with `volume.js`, on a grid the user chooses. No `cubegen`, no
 *   external binary, no network.
 * - It also accepts a `.cube` the user picks, and puts it through the *same*
 *   slice and surface code, because a cube from another program is a legitimate
 *   field and should not need a second renderer.
 * - When a run has no basis — an imported log, a job that did not write a
 *   checkpoint — the card says so and offers the file picker. It never invents
 *   a field, and it never leaves an empty canvas standing in for one.
 *
 * Everything that can be a number is printed as a number next to the picture:
 * grid points and spacing, the seconds the evaluation took, the isovalue, and
 * ∫|ψ|²dV (≈1 for a normalised occupied orbital) or the integrated electron
 * count for a density. Those are the checks a reader can do on the picture.
 *
 * The card is a `results-card is-wide` appended to `.results-grid`, the same
 * shape `superpositionCard.js` uses, so it sits inside the results surface
 * without a second layout system.
 */

import { parseCube, writeCube } from '../shared/cubeFile.js';
import { extractSurface } from '../shared/marchingCubes.js';
import {
  electrostaticPotential,
  espCardRows,
  potentialRange,
} from '../shared/esp.js';
import {
  fieldFromCube,
  fieldOfValues,
  gridFor,
  integrateField,
  shellsFromCheckpoint,
} from '../shared/volume.js';
import { createSliceView } from './sliceView.js';
import { createSurfaceViewer } from './surfaceViewer.js';

/**
 * The cube text for an evaluated field: the writer gets the field's own grid.
 *
 * Exported because it is the whole contract of `Write cube…` — the field's
 * dims, per-axis step, origin and values go out and `parseCube` must read the
 * same three back. The button only adds the dialog, so the round trip can be
 * checked without a canvas (issue 187).
 *
 * A field evaluated from a basis carries no atoms of its own (the grid does),
 * so the caller passes the record's geometry; a field read from a cube already
 * carries them.
 */
export function cubeTextForField(field, { atoms = null, title = '', comment = '' } = {}) {
  if (!field || !Array.isArray(field.dims) || !field.values) {
    throw new Error('there is no evaluated field to write; evaluate an orbital or a density, or open a cube, first.');
  }
  const list = Array.isArray(atoms) && atoms.length > 0 ? atoms : (field.atoms ?? []);
  return writeCube(field, {
    title: title || field.label || 'NodeChem field',
    comment: comment || 'NodeChem Studio cube from the wavefunction view; values in a.u.; outer loop X, middle loop Y, inner loop Z',
    atoms: list,
    units: 'angstrom',
  });
}

const SPACINGS = [0.2, 0.3, 0.5];

/**
 * CODATA 2018 hartree → eV, repeated here rather than imported from
 * `shared/wavefunction.js`: that module hashes its input with `node:crypto`,
 * and a renderer module must not drag a Node built-in into the browser bundle.
 */
const HARTREE_TO_EV = 27.211386245988;
const MAX_CUBE_BYTES = 64 * 1024 * 1024;

/**
 * Card styles, injected once. Kept here rather than in `styles.css` so the
 * viewport ships as one module and cannot be half-present; it only uses the
 * existing tokens, with literal fallbacks for the browser preview.
 */
const VIEWPORT_STYLE_ID = 'wf-viewport-style';
const VIEWPORT_CSS = `
.wf-view { display: flex; flex-direction: column; gap: 8px; }
.wf-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wf-label { color: var(--text-secondary); font-size: var(--text-size-xs); }
.wf-row select, .wf-row .button { font: inherit; }
.wf-stage { min-height: 120px; }
.wf-status { margin: 0; }
.wf-status[data-tone="warn"] { color: var(--state-review); }
.wf-numbers { grid-template-columns: minmax(96px, 24%) minmax(0, 1fr); }
.wf-numbers dt { color: var(--text-secondary); font-size: var(--text-size-xs); }
.wf-numbers dd { margin: 0; font: var(--text-size-xs)/1.45 var(--font-mono); overflow-wrap: anywhere; }

.slice-view { display: flex; flex-direction: column; gap: 6px; }
.slice-controls, .surface-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.slice-control, .surface-control { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: var(--text-size-xs); }
.slice-control input[type="range"] { width: 96px; }
.slice-control input[type="number"] { width: 72px; }
.slice-atom-plane { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.slice-atom-plane input { width: 52px; }
.slice-atom-plane[hidden] { display: none; }
.slice-note { margin: 0; color: var(--state-review); font-size: var(--text-size-xs); }
.slice-number, .surface-number { color: var(--text-primary); font: var(--text-size-xs) var(--font-mono); }
.slice-frame { display: flex; flex-direction: column; gap: 6px; }
.slice-canvas { width: 100%; max-width: 420px; height: 260px; border: 1px solid var(--border-subtle); border-radius: 8px; background: var(--surface-canvas); }
.slice-legend { display: flex; flex-direction: column; gap: 1px; }
.slice-legend p { margin: 0; color: var(--text-tertiary); font-size: var(--text-size-xs); }
.slice-legend .slice-note { color: var(--state-review); }

.surface-view { display: flex; flex-direction: column; gap: 6px; }
.surface-frame { position: relative; }
.surface-canvas { width: 100%; max-width: 460px; height: 300px; border: 1px solid var(--border-subtle); border-radius: 8px; background: var(--surface-canvas); touch-action: none; cursor: grab; }
.surface-canvas[data-dragging="true"] { cursor: grabbing; }
.surface-canvas[hidden] { display: none; }
.surface-notice { margin: 0; padding: 8px 10px; border: 1px solid var(--border-subtle); border-radius: 8px; color: var(--text-secondary); font-size: var(--text-size-xs); }
.surface-notice[data-state="unavailable"] { color: var(--state-review); }
.surface-lobes { display: inline-flex; gap: 10px; }
.surface-lobe { display: inline-flex; align-items: center; gap: 4px; color: var(--text-secondary); font-size: var(--text-size-xs); }
.surface-lobe.is-positive span::before { content: "＋"; color: var(--tone-orange-14); }
.surface-lobe.is-negative span::before { content: "－"; color: var(--tone-blue-118); }
.surface-numbers { display: grid; grid-template-columns: minmax(80px, 22%) minmax(0, 1fr); gap: 2px 8px; margin: 0; }
.surface-numbers dt { color: var(--text-secondary); font-size: var(--text-size-xs); }
.surface-numbers dd { margin: 0; font: var(--text-size-xs)/1.4 var(--font-mono); }
.surface-actions { display: flex; gap: 6px; }
`;

function installStyles(doc) {
  if (!doc?.head || doc.getElementById(VIEWPORT_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = VIEWPORT_STYLE_ID;
  style.textContent = VIEWPORT_CSS;
  doc.head.append(style);
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The orbitals a record can draw: a Molden `orbitals` list if it has one,
 * otherwise the flat alpha coefficient matrix sliced into columns.
 *
 * Occupations follow the file: a restricted set is doubly occupied up to the
 * alpha count, an unrestricted alpha set singly. A record with no electron
 * count yields zero occupations, so a density built from it integrates to zero
 * and says so, rather than pretending the MOs are filled.
 */
export function orbitalList(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  const functions = Number(parsed.numberOfBasisFunctions);
  if (Array.isArray(parsed.orbitals) && parsed.orbitals.length) {
    const alpha = parsed.orbitals.filter((orbital) => (orbital?.spin ?? 'Alpha') === 'Alpha');
    return alpha.map((orbital, index) => ({
      index,
      energyHartree: Number.isFinite(orbital.energy) ? orbital.energy : null,
      coefficients: orbital.coefficients,
      occupation: Number.isFinite(orbital.occupation) ? orbital.occupation : 0,
      symmetry: orbital.symmetry || '',
    }));
  }
  if (!Array.isArray(parsed.alphaMOCoefficients) || !Number.isInteger(functions) || functions <= 0) return [];
  const matrix = parsed.alphaMOCoefficients;
  const count = Math.floor(matrix.length / functions);
  const alphaElectrons = Number.isInteger(parsed.numberOfAlphaElectrons) ? parsed.numberOfAlphaElectrons : null;
  const betaElectrons = Number.isInteger(parsed.numberOfBetaElectrons) ? parsed.numberOfBetaElectrons : null;
  const restricted = alphaElectrons !== null && betaElectrons !== null && alphaElectrons === betaElectrons;
  const orbitals = [];
  for (let index = 0; index < count; index += 1) {
    const occupation = alphaElectrons === null
      ? 0
      : (index < alphaElectrons ? (restricted ? 2 : 1) : 0);
    orbitals.push({
      index,
      energyHartree: Array.isArray(parsed.orbitalEnergies) && Number.isFinite(parsed.orbitalEnergies[index])
        ? parsed.orbitalEnergies[index]
        : null,
      coefficients: matrix.slice(index * functions, (index + 1) * functions),
      occupation,
      symmetry: '',
    });
  }
  return orbitals;
}

/**
 * The shells of a record, or `null` when it carries no basis.
 *
 * A record that *has* a basis but whose arrays disagree is different from one
 * that has none: the first is a parsing bug worth naming, the second is an
 * ordinary imported log. `{ error }` is the first case, `null` the second.
 */
export function basisOf(record) {
  const candidates = [record?.parsed, record?.wavefunction];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const hasBasis = Array.isArray(candidate.shellTypes) || Array.isArray(candidate.shells);
    if (!hasBasis) continue;
    try {
      const parsed = shellsFromCheckpoint(candidate);
      if (parsed.shells.length) return parsed;
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  }
  return null;
}

/**
 * A worker-backed evaluator, with a same-thread fallback.
 *
 * The fallback is not a silent one: `mode` says `'main thread'` and the panel
 * prints it, because a 3-second freeze is something a user should be able to
 * attribute.
 */
export function createEvaluator({ doc = globalThis.document } = {}) {
  let worker = null;
  let nextId = 1;
  const jobs = new Map();
  let broken = false;

  const start = () => {
    if (worker || broken) return worker;
    if (typeof Worker === 'undefined') {
      broken = true;
      return null;
    }
    try {
      worker = new Worker(new URL('./volumeWorker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (event) => {
        const message = event?.data;
        const job = jobs.get(message?.id);
        if (!job) return;
        if (message.type === 'progress') {
          job.onProgress?.(message.done, message.total);
          return;
        }
        jobs.delete(message.id);
        if (message.type === 'error') {
          job.reject(new Error(message.message));
          return;
        }
        job.resolve(message);
      };
      worker.onerror = (event) => {
        broken = true;
        for (const job of jobs.values()) job.reject(new Error(event?.message || 'the volume worker failed'));
        jobs.clear();
      };
      return worker;
    } catch {
      broken = true;
      worker = null;
      return null;
    }
  };

  const runInline = (job) => new Promise((resolve, reject) => {
    // Yield once so the panel paints before the arithmetic starts.
    setTimeout(async () => {
      try {
        const { evaluateOrbital, evaluateDensity } = await import('../shared/volume.js');
        const { extractSurface } = await import('../shared/marchingCubes.js');
        const started = Date.now();
        const values = job.kind === 'density'
          ? evaluateDensity({
            shells: job.shells,
            coefficientsByMo: job.coefficientsByMo,
            occupations: job.occupations,
            grid: job.grid,
            cartesianOrder: job.cartesianOrder,
            precision: job.precision,
            onProgress: job.onProgress,
          })
          : evaluateOrbital({
            shells: job.shells,
            coefficients: job.coefficients,
            grid: job.grid,
            cartesianOrder: job.cartesianOrder,
            precision: job.precision,
            onProgress: job.onProgress,
          });
        const field = {
          values,
          dims: job.grid.counts,
          origin: job.grid.origin,
          step: job.grid.step,
          signed: job.kind !== 'density',
        };
        let mesh = null;
        if (job.mesh && Number.isFinite(job.mesh.iso) && job.mesh.iso !== 0) {
          const iso = Math.abs(job.mesh.iso);
          mesh = {
            positive: extractSurface(field, iso),
            negative: field.signed ? extractSurface(field, -iso) : null,
          };
        }
        resolve({ values, mesh, ms: Date.now() - started, grid: job.grid, mode: 'main thread' });
      } catch (error) {
        reject(error);
      }
    }, 0);
  });

  return {
    get mode() {
      return worker ? 'worker' : 'main thread';
    },
    run(job, { onProgress = null } = {}) {
      const id = nextId;
      nextId += 1;
      const instance = start();
      if (!instance) return runInline({ ...job, onProgress });
      return new Promise((resolve, reject) => {
        jobs.set(id, { resolve: (result) => resolve({ ...result, mode: 'worker' }), reject, onProgress });
        instance.postMessage({ ...job, id });
      });
    },
    dispose() {
      if (worker) {
        worker.terminate();
        worker = null;
      }
      jobs.clear();
    },
    doc,
  };
}

/**
 * Mount the viewport card.
 *
 * @param {object} options
 * @param {HTMLElement} options.container the results container (`#run-results`)
 * @param {object} options.record the run record being displayed
 * @param {object} [options.desktop] the preload bridge, for the file picker
 * @param {Document} [options.doc]
 */
export function mountWavefunctionViewport({
  container,
  record = null,
  desktop = globalThis.window?.desktop ?? null,
  doc = globalThis.document,
} = {}) {
  if (!container || !doc) return null;
  const grid = container.querySelector('.results-grid');
  if (!grid) return null;

  installStyles(doc);
  const basis = basisOf(record);

  const card = el(doc, 'section', 'results-card is-wide wf-view');
  card.dataset.field = 'wavefunction-view';
  const heading = el(doc, 'h3', 'results-card-title', 'Wavefunction view');
  const intro = el(doc, 'p', 'results-note',
    'A plane slice and an isosurface, evaluated from the basis in this record — no cubegen, no external binary. '
    + 'The numbers under the picture are the check: grid, spacing, seconds, and ∫|ψ|²dV (≈1 for an occupied orbital).');

  const sourceRow = el(doc, 'div', 'wf-row');
  const fieldSelect = el(doc, 'select');
  fieldSelect.dataset.role = 'wf-field';
  const viewSelect = el(doc, 'select');
  viewSelect.dataset.role = 'wf-view';
  for (const [value, label] of [['slice', 'Plane slice'], ['surface', 'Isosurface']]) {
    const option = el(doc, 'option', null, label);
    option.value = value;
    viewSelect.append(option);
  }
  const spacingSelect = el(doc, 'select');
  spacingSelect.dataset.role = 'wf-spacing';
  for (const spacing of SPACINGS) {
    const option = el(doc, 'option', null, `${spacing.toFixed(1)} Å`);
    option.value = String(spacing);
    option.selected = spacing === 0.3;
    spacingSelect.append(option);
  }
  const openButton = el(doc, 'button', 'button is-quiet', 'Open .cube…');
  openButton.type = 'button';
  openButton.dataset.role = 'wf-open-cube';

  sourceRow.append(
    el(doc, 'label', 'wf-label', 'Field'), fieldSelect,
    el(doc, 'label', 'wf-label', 'View'), viewSelect,
    el(doc, 'label', 'wf-label', 'Grid'), spacingSelect,
    openButton,
  );

  const stage = el(doc, 'div', 'wf-stage');
  const placeholder = el(doc, 'p', 'results-note',
    'nothing to draw yet: this record carries no basis set, and no cube is open.');
  placeholder.dataset.role = 'wf-placeholder';
  stage.append(placeholder);
  const status = el(doc, 'p', 'results-note wf-status');
  status.dataset.role = 'wf-status';
  const numbers = el(doc, 'dl', 'results-kv wf-numbers');
  numbers.dataset.role = 'wf-numbers';

  card.append(heading, intro, sourceRow, stage, status, numbers);
  grid.append(card);

  const state = {
    field: null, // the renderable field (from the basis or a cube)
    view: 'slice',
    spacing: 0.3,
    isovalue: 0.02,
    slice: null,
    surface: null,
    disposed: false,
    sourceNote: '',
  };
  const evaluator = createEvaluator({ doc });

  const setStatus = (text, tone = '') => {
    status.textContent = text;
    status.dataset.tone = tone;
  };

  const setNumbers = (rows) => {
    numbers.replaceChildren(...rows.flatMap(([term, value]) => [
      el(doc, 'dt', null, term),
      el(doc, 'dd', null, String(value)),
    ]));
  };
  setNumbers([['field', 'not evaluated']]);

  const defaultIsovalue = (field) => {
    const magnitude = Number.isFinite(field?.stats?.absMax) ? field.stats.absMax : 0;
    if (!(magnitude > 0)) return 0.02;
    // Two per cent of the field maximum: a starting point, printed everywhere
    // it is used, never a chemical recommendation.
    return Number((magnitude * 0.02).toPrecision(2));
  };

  /** `record-field.cube`: safe, lowercase, and the same name twice overwrites nothing by surprise. */
  const cubeFileName = (field) => {
    const slug = (text) => String(text || '').toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    return `${slug(record?.id || 'wavefunction') || 'wavefunction'}-${slug(field?.label || 'field') || 'field'}.cube`;
  };

  /**
   * `Write cube…`: the field's own grid goes to the writer, then to the main
   * process's save dialog (or the browser's download in the preview). The
   * status line reports the dims and spacing that were written, so the number in
   * the card and the number in the file are visibly the same.
   */
  const saveFieldAsCube = async () => {
    const field = state.field;
    if (!field) {
      setStatus('nothing to write: there is no evaluated field.', 'warn');
      return;
    }
    let text;
    try {
      text = cubeTextForField(field, {
        atoms: state.atoms ?? field.atoms ?? [],
        title: `${field.label}${record?.id ? ` — ${record.id}` : ''}`,
      });
    } catch (error) {
      setStatus(`cannot write a cube: ${String(error?.message ?? error)}`, 'warn');
      return;
    }
    const name = cubeFileName(field);
    try {
      if (desktop?.saveText) {
        const result = await desktop.saveText({ text, suggestedName: name });
        if (result?.canceled) {
          setStatus('cube not written: the save dialog was cancelled.');
          return;
        }
        setStatus(`cube written: ${result?.path ?? name} · ${field.dims.join('×')} at ${Number(field.step).toFixed(3)} Å`);
        return;
      }
      // Browser preview: hand the text to the download machinery instead of
      // pretending it was saved.
      const blob = new Blob([text], { type: 'chemical/x-gaussian-cube' });
      const url = URL.createObjectURL(blob);
      const anchor = doc.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus(`cube downloaded: ${name} · ${field.dims.join('×')} at ${Number(field.step).toFixed(3)} Å`);
    } catch (error) {
      setStatus(`cannot write a cube: ${String(error?.message ?? error)}`, 'warn');
    }
  };

  /** Mesh the current field at ±iso. Fast enough to run when a slider moves. */
  const meshOf = (field, iso) => {
    if (!field || !(Math.abs(iso) > 0)) return { positive: null, negative: null };
    const level = Math.abs(iso);
    try {
      return {
        positive: extractSurface(field, level),
        negative: field.signed ? extractSurface(field, -level) : null,
      };
    } catch (error) {
      setStatus(String(error?.message ?? error), 'warn');
      return { positive: null, negative: null };
    }
  };

  /**
   * The electrostatic potential at the surface, for the numbers row (issue 164).
   *
   * The potential is evaluated *at the surface centroids*, not on the field's
   * grid: the range the row prints is the range of the values a coloured surface
   * would actually take, and saying so is the point. A checkpoint that carries
   * no density block gets the exact words "no density in this file" — there is no
   * grey legend standing in for an unknown field.
   */
  const espRowsFor = (mesh) => {
    const parsed = record?.parsed;
    if (!parsed || !Array.isArray(parsed.shellTypes) || !Number.isInteger(parsed.numberOfBasisFunctions)) {
      return [];
    }
    const centroids = [];
    for (const part of [mesh?.positive, mesh?.negative]) {
      const count = Math.floor((part?.positions?.length ?? 0) / 9);
      for (let triangle = 0; triangle < count; triangle += 1) {
        centroids.push([0, 1, 2].map((axis) => (
          (part.positions[triangle * 9 + axis]
            + part.positions[triangle * 9 + 3 + axis]
            + part.positions[triangle * 9 + 6 + axis]) / 3
        )));
      }
    }
    if (!centroids.length) return [];
    try {
      const potential = electrostaticPotential({ fchk: parsed, points: centroids });
      if (!potential.ok) {
        return espCardRows({ fchk: parsed, esp: potential, sampledAt: `${centroids.length} surface centroids` });
      }
      const finite = potential.values.filter((value) => Number.isFinite(value));
      if (!finite.length) return [['ESP colour range', 'not computable: no finite value on this surface']];
      return espCardRows({
        fchk: parsed,
        esp: { ok: true, range: potentialRange(finite, { subject: 'surface' }) },
        sampledAt: `${centroids.length} surface centroids, analytic basis sum`,
      });
    } catch (error) {
      return [['ESP colour range', `not computable: ${String(error?.message ?? error)}`]];
    }
  };

  const describeSurface = (field) => {
    if (!state.surface) return;
    state.surface.setCubeAvailable?.(Boolean(field));
    if (!field) return;
    setStatus('meshing…');
    const mesh = meshOf(field, state.isovalue);
    state.surface.setMeshes(mesh, {
      iso: state.isovalue,
      grid: state.grid ? `${state.grid.counts.join('×')} at ${Number(state.grid.step).toFixed(3)} Å` : null,
    });
    const total = (mesh.positive?.triangleCount ?? 0) + (mesh.negative?.triangleCount ?? 0);
    setNumbers([
      ...(state.numberRows ?? []),
      ...espRowsFor(mesh),
      ['isovalue', `${state.isovalue.toPrecision(3)}`],
      ['triangles', String(total)],
    ]);
    setStatus(state.surface.message || `surface at ±${state.isovalue.toPrecision(3)} a.u. · drag to orbit, wheel to zoom`);
  };

  /** Swap the widget, then put the field that is already evaluated into it. */
  const renderView = () => {
    placeholder.remove();
    if (state.view === 'surface') {
      state.slice?.destroy();
      state.slice = null;
      if (!state.surface) {
        state.surface = createSurfaceViewer(stage, {
          doc,
          onIsoChange: (iso) => {
            state.isovalue = iso;
            if (state.field) describeSurface(state.field);
          },
          onWriteCube: saveFieldAsCube,
        });
      }
      if (state.field) describeSurface(state.field);
    } else {
      state.surface?.destroy();
      state.surface = null;
      if (!state.slice) state.slice = createSliceView(stage, { doc, atoms: state.atoms ?? null });
      state.slice.setAtoms?.(state.atoms ?? null);
      if (state.field) {
        state.slice.setField(state.field, { iso: state.isovalue, note: state.sourceNote });
        setStatus(`slice of ${state.field.label}`);
      }
    }
  };

  /**
   * Evaluate the current field from the basis. `keepGrid` re-uses the grid and
   * the field (the isovalue moved); otherwise the grid is rebuilt at the
   * selected spacing.
   */
  const evaluate = async ({ keepGrid = false } = {}) => {
    if (state.disposed) return;
    const parsed = basis;
    if (!parsed || parsed.error) {
      setStatus(parsed?.error
        ? `basis not readable: ${parsed.error}`
        : 'this record has no basis set. Open a .cube file to view a field; nothing is drawn from an assumption.', 'warn');
      return;
    }
    if (keepGrid && state.field && state.fieldSource === 'basis') {
      renderView();
      return;
    }
    const list = orbitalList(record?.parsed);
    const selection = fieldSelect.value || 'density';
    const atoms = record?.parsed?.atoms;
    if (!Array.isArray(atoms) || atoms.length === 0) {
      setStatus('this record has a basis but no geometry, so the shells cannot be placed.', 'warn');
      return;
    }

    let coefficients = null;
    let coefficientsByMo = null;
    let occupations = null;
    let label = '';
    if (selection === 'density') {
      coefficientsByMo = list.map((orbital) => orbital.coefficients);
      occupations = list.map((orbital) => orbital.occupation);
      if (!coefficientsByMo.length) {
        setStatus('this record has no MO coefficients, so there is no density to sum.', 'warn');
        return;
      }
      label = 'electron density';
    } else {
      const index = Number(selection);
      const orbital = list[index];
      if (!orbital) {
        setStatus(`orbital ${index + 1} is not in this record.`, 'warn');
        return;
      }
      coefficients = orbital.coefficients;
      label = `MO ${index + 1}${Number.isFinite(orbital.energyHartree)
        ? ` · ${orbital.energyHartree.toFixed(4)} Ha (${(orbital.energyHartree * HARTREE_TO_EV).toFixed(2)} eV)`
        : ''}`;
    }

    const gridResult = gridFor(atoms, { spacing: state.spacing });
    state.grid = gridResult;
    if (gridResult.capped) {
      setStatus(`grid coarsened to fit the point cap: ${gridResult.note}`, 'warn');
    }

    setStatus(`evaluating ${label} on ${gridResult.counts.join('×')} points…`);
    try {
      const result = await evaluator.run({
        type: 'evaluate',
        kind: selection === 'density' ? 'density' : 'orbital',
        shells: parsed.shells,
        coefficients,
        coefficientsByMo,
        occupations,
        cartesianOrder: parsed.cartesianOrder,
        precision: 'f64',
        grid: {
          origin: gridResult.origin,
          counts: gridResult.counts,
          step: gridResult.step,
          atoms: atoms.map((atom) => ({ x: atom.x, y: atom.y, z: atom.z })),
        },
        mesh: null,
      }, {
        onProgress: (done, total) => setStatus(`evaluating ${label}: ${Math.round((done / total) * 100)} %`),
      });
      if (state.disposed) return;

      state.field = fieldOfValues({
        kind: selection === 'density' ? 'density' : 'orbital',
        label,
        grid: { ...gridResult, atoms },
        values: result.values,
        signed: selection !== 'density',
        unit: selection === 'density' ? 'e/bohr^3' : 'a.u.',
      });
      state.fieldSource = 'basis';
      state.atoms = atoms;
      state.sourceNote = result.mode === 'worker' ? '' : 'evaluated on the main thread';
      if (!keepGrid) state.isovalue = defaultIsovalue(state.field);
      const integral = selection === 'density'
        ? integrateField(state.field)
        : integrateField(state.field, { square: true });
      state.numberRows = [
        ['field', label],
        ['grid', `${gridResult.counts.join('×')} = ${gridResult.points} points`],
        ['spacing', `${gridResult.step.toFixed(3)} Å${gridResult.capped ? ` (requested ${gridResult.requestedSpacing.toFixed(2)})` : ''}`],
        ['evaluated in', `${(result.ms / 1000).toFixed(2)} s (${result.mode})`],
        selection === 'density'
          ? ['∫ρ dV', `${integral.toFixed(3)} e`]
          : ['∫|ψ|²dV', `${integral.toFixed(3)} (bohr³)`],
      ];
      setNumbers(state.numberRows);
      renderView();
      if (state.view === 'slice' && state.slice) setStatus(`slice of ${label}`);
    } catch (error) {
      setStatus(String(error?.message ?? error), 'warn');
    }
  };

  const fillFieldSelect = () => {
    fieldSelect.replaceChildren();
    const list = orbitalList(record?.parsed);
    if (list.length) {
      list.forEach((orbital, index) => {
        const option = el(doc, 'option', null, `MO ${index + 1}`
          + (Number.isFinite(orbital.energyHartree) ? ` · ${orbital.energyHartree.toFixed(3)} Ha` : '')
          + (orbital.occupation > 0 ? ' · occupied' : ''));
        option.value = String(index);
        fieldSelect.append(option);
      });
      const homo = list.filter((orbital) => orbital.occupation > 0).length - 1;
      if (homo >= 0) fieldSelect.value = String(homo);
      else fieldSelect.value = '0';
      const density = el(doc, 'option', null, 'Electron density (all occupied MOs)');
      density.value = 'density';
      fieldSelect.append(density);
    } else {
      const option = el(doc, 'option', null, 'no orbitals in this record');
      option.value = '';
      fieldSelect.append(option);
      fieldSelect.disabled = true;
    }
  };

  /**
   * Accept a cube through the app's own file picker. The renderer never reads
   * the filesystem itself: `desktop.pickCubeFile` returns the text the main
   * process read, and the browser preview falls back to an `<input type=file>`
   * so the path degrades instead of disappearing.
   */
  const openCube = async () => {
    let text = null;
    let name = 'cube';
    if (desktop?.pickCubeFile) {
      const picked = await desktop.pickCubeFile();
      if (!picked || picked.canceled) return;
      if (picked.error) {
        setStatus(picked.error, 'warn');
        return;
      }
      text = picked.text;
      name = picked.name || name;
    } else {
      const input = el(doc, 'input');
      input.type = 'file';
      input.accept = '.cube,.cub,text/plain';
      const file = await new Promise((resolve) => {
        input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
        input.click();
      });
      if (!file) return;
      if (file.size > MAX_CUBE_BYTES) {
        setStatus(`that cube is ${(file.size / 1e6).toFixed(1)} MB; the limit is ${MAX_CUBE_BYTES / 1e6} MB.`, 'warn');
        return;
      }
      text = await file.text();
      name = file.name;
    }
    try {
      const cube = parseCube(text);
      const field = fieldFromCube(cube, { label: `${name} (cube)` });
      state.field = field;
      state.grid = {
        origin: field.origin,
        counts: field.dims,
        step: field.step,
        points: field.points,
        axes: field.axes,
        cellVolumeAngstrom3: field.cellVolumeAngstrom3,
        cellVolumeBohr3: field.cellVolumeBohr3,
        requestedSpacing: field.step,
        capped: false,
      };
      state.sourceNote = `read from ${name}`;
      state.fieldSource = 'cube';
      state.atoms = Array.isArray(cube.atoms) && cube.atoms.length ? cube.atoms : null;
      state.isovalue = defaultIsovalue(field);
      fieldSelect.disabled = true;
      const summary = el(doc, 'option', null, `cube: ${name}`);
      summary.value = 'cube';
      fieldSelect.replaceChildren(summary);
      state.numberRows = [
        ['field', field.label],
        ['grid', `${field.dims.join('×')} = ${field.points} points`],
        ['spacing', `${field.step.toFixed(3)} Å`],
        ['range', `${field.stats.min.toPrecision(3)} … ${field.stats.max.toPrecision(3)} ${field.unit}`],
        ['source', name],
      ];
      setNumbers(state.numberRows);
      renderView();
      setStatus(`cube loaded from ${name}: ${field.dims.join('×')} points at ${field.step.toFixed(3)} Å`);
    } catch (error) {
      setStatus(String(error?.message ?? error), 'warn');
    }
  };

  fieldSelect.addEventListener('change', () => {
    state.field = null;
    evaluate();
  });
  viewSelect.addEventListener('change', () => {
    state.view = viewSelect.value;
    renderView();
  });
  spacingSelect.addEventListener('change', () => {
    state.spacing = Number(spacingSelect.value);
    if (state.fieldSource === 'basis') evaluate();
  });
  openButton.addEventListener('click', openCube);

  fillFieldSelect();
  if (basis && !basis.error) {
    state.isovalue = 0.02;
    renderView();
    evaluate();
  } else {
    // With no basis the slice widget is still created: an empty frame is
    // honest (it has a legend saying what it would show) and the picker has
    // somewhere to draw. The surface viewport is not created at all, so no GL
    // context is requested for a run that has nothing to mesh.
    state.view = 'slice';
    viewSelect.value = 'slice';
    setStatus(basis?.error
      ? `basis not readable: ${basis.error}`
      : 'this record has no basis set. Open a .cube file to view a field; nothing is drawn from an assumption.');
  }

  return {
    element: card,
    get state() {
      return state;
    },
    openCube,
    evaluate,
    destroy() {
      state.disposed = true;
      evaluator.dispose();
      state.slice?.destroy();
      state.surface?.destroy();
      card.remove();
    },
  };
}
