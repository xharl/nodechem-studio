/**
 * The superposition card: pick another run with the same atoms in the same
 * order, align it onto the current structure and report the RMSD in Å.
 *
 * The card is only mounted when at least one comparable run exists; it never
 * offers a run it cannot compare, so a number always has a basis.
 */

function projectionSvg(reference, aligned, { width = 360, height = 220, padding = 18 } = {}) {
  const all = [...reference, ...aligned];
  const xs = all.map((atom) => atom.x);
  const ys = all.map((atom) => atom.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  const project = (atom) => ({
    x: padding + (atom.x - minX) * scale + ((width - padding * 2) - spanX * scale) / 2,
    y: height - padding - (atom.y - minY) * scale - ((height - padding * 2) - spanY * scale) / 2,
  });
  const dots = (atoms, color, radius) => atoms.map((atom) => {
    const point = project(atom);
    return `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${radius}" fill="${color}" fill-opacity="0.55"><title>${atom.element}</title></circle>`;
  }).join('');
  return `<svg class="overlay-figure" viewBox="0 0 ${width} ${height}" role="img" aria-label="Two structures projected on the xy plane">`
    + dots(reference, 'var(--tone-teal-14)', 4) + dots(aligned, 'var(--tone-orange-14)', 2.6)
    + `<text x="${padding}" y="${height - 4}" class="spectrum-label">projected on xy after alignment · blue reference, amber moving</text>`
    + '</svg>';
}

/**
 * Issue 371: list the run summaries, then read the records they name. The
 * geometry lives in each record's `parsed` block, so the summary alone cannot
 * decide which runs are comparable.
 */
async function comparableRecords(desktop) {
  try {
    const summaries = await desktop.listRuns();
    const ids = (Array.isArray(summaries) ? summaries : [])
      .map((run) => run?.id)
      .filter((id) => typeof id === 'string' && id !== '');
    if (ids.length === 0) return [];
    const records = await desktop.getRunRecords(ids);
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}

export function mountSuperposition({
  container,
  currentRecord,
  desktop = globalThis.window?.desktop ?? null,
  doc = globalThis.document,
} = {}) {
  if (!container || !doc || !desktop?.listRuns || !desktop?.getRunRecords) return;
  const reference = currentRecord?.parsed?.finalGeometry?.atoms;
  if (!Array.isArray(reference) || reference.length === 0) return;
  const grid = container.querySelector('.results-grid');
  if (!grid) return;

  const card = doc.createElement('section');
  card.className = 'results-card is-wide';
  card.dataset.field = 'superposition';
  card.innerHTML = '<h3 class="results-card-title">Superposition</h3>'
    + '<p class="results-note">A run is offered only when it has the same atoms in the same order. '
    + 'The RMSD is a plain per-atom RMSD in Å after optimal rotation; it is not mass-weighted.</p>'
    + '<label class="results-note">Compare with <select data-overlay-run></select></label>'
    + '<div data-overlay-result><p class="results-note">Pick a run.</p></div>';
  grid.append(card);

  const select = card.querySelector('[data-overlay-run]');
  const result = card.querySelector('[data-overlay-result]');

  const comparable = async () => {
    const runs = await comparableRecords(desktop);
    return runs.filter((run) => {
      const atoms = run?.parsed?.finalGeometry?.atoms;
      return run?.id !== currentRecord?.id
        && Array.isArray(atoms)
        && atoms.length === reference.length
        && atoms.every((atom, index) => String(atom.element) === String(reference[index].element));
    });
  };

  comparable().then((runs) => {
    if (runs.length === 0) {
      card.remove();
      return;
    }
    for (const run of runs) {
      const option = doc.createElement('option');
      option.value = String(run.id);
      option.textContent = `${run.title || run.id}${run.engine ? ` · ${run.engine}` : ''}`;
      select.append(option);
    }
    const render = async () => {
      const runsNow = await comparable();
      const chosen = runsNow.find((run) => String(run.id) === select.value);
      if (!chosen) return;
      const { superimpose, largestDeviations } = await import('../shared/superpose.js');
      try {
        const aligned = superimpose(reference, chosen.parsed.finalGeometry.atoms);
        const worst = largestDeviations(reference, aligned.aligned, { limit: 5 });
        result.innerHTML = `<p class="results-kv"><span>RMSD</span><strong data-role="rmsd">${aligned.rmsd.toFixed(3)} Å</strong>`
          + `<span>Atoms used</span><span data-role="rmsd-atoms">${aligned.atoms}</span>`
          + `<span>Compared with</span><span>${chosen.title || chosen.id}</span></p>`
          + projectionSvg(reference, aligned.aligned)
          + '<table class="results-table"><thead><tr><th>Atom</th><th>Element</th><th class="num">Deviation / Å</th></tr></thead><tbody>'
          + worst.map((atom) => `<tr><td>${atom.index}</td><td>${atom.element}</td><td class="num">${atom.distance.toFixed(3)}</td></tr>`).join('')
          + '</tbody></table>';
      } catch (error) {
        result.innerHTML = `<p class="results-warning">${String(error?.message || error)}</p>`;
      }
    };
    select.addEventListener('change', render);
    render();
  });
}
