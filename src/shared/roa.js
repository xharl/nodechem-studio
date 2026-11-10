/**
 * Raman optical activity (ROA) rows (issue 127).
 *
 * A `Freq=ROA` Gaussian job prints, beside the Raman rows in each frequency
 * block, three far-from-resonance ROA intensity rows plus the degree of
 * circularity:
 *
 * ```text
 *  ROA invariants AlphaG = alphaG', Gamma2 = beta(G')**2, Delta2 = beta(A)**2, (10**4 A**5/AMU)
 *  Far-From-Resonance Raman intensities (K), ROA intensites (10**4 K), CID=(ROA/Raman)*10**4
 *     Raman1;ROA1;CID1 =ICPu/SCPu(180), Raman2;ROA2;CID2 =ICPd/SCPd(90)
 *     Raman3;ROA3;CID3 =DCPI(180) RC180 = degree of circularity
 *  ...
 *  AlphaG Fr= 1--      0.0000                -0.0000                -0.0000
 *  ROA1   Fr= 1--       0.000                 -0.000                 -0.000
 *  RC180  Fr= 1--       0.714                  0.714                  0.266
 * ```
 *
 * Three separate scattering geometries are printed. They are not
 * interchangeable: `ROA1` is the ICPu/SCPu backscattering intensity (`Raman1`,
 * `ROA1`, `CID1`), `ROA2` is the ICPd/SCPd 90° intensity, and `ROA3` is the
 * DCPI backscattering intensity. The card makes the user choose one and names
 * it in the caption; it never averages them. `RC180` is a degree of
 * circularity and unitless.
 *
 * A job without `Freq=ROA` prints none of these rows, so `parseRoaIntensities`
 * returns `null`; "not requested" is not "all zero".
 *
 * The fixture this reader is tested against is a real Gaussian 09 E.01
 * `# freq=roa hf/3-21g` log (formaldehyde, 6 modes). Gaussian 16 B.01+ is the
 * revision that made the keyword generally available, but no public G16 ROA
 * log was found, so the card says the release is not stated by the table and
 * the parser branch is not claimed for anything newer than the fixture.
 */

const ROW = /^\s*(AlphaG|Gamma2|Delta2|Raman1|Raman2|Raman3|ROA1|ROA2|ROA3|CID1|CID2|CID3|RC180)\s+Fr=\s*\d+\s*-{2,}\s*(.*)$/i;
const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;

export const ROA_UNITS = '10⁴ K';
export const ROA_INVARIANT_UNITS = '10⁴ Å⁵ amu⁻¹';
export const ROA_GEOMETRY_KEYS = Object.freeze(['roa1', 'roa2', 'roa3']);

const numbers = (text) => (String(text || '').match(NUMBER) || []).map(Number);

function geometryLabels(text) {
  const labels = {
    roa1: 'ICPu/SCPu(180)',
    roa2: 'ICPd/SCPd(90)',
    roa3: 'DCPI(180)',
    rc180: 'degree of circularity',
  };
  for (const line of String(text || '').split(/\r\n|\n|\r/)) {
    if (/\bRaman1;ROA1;CID1\b/i.test(line)) {
      const match = line.match(/Raman1;ROA1;CID1\s*=\s*(.+?)(?:,|$)/i);
      if (match) labels.roa1 = match[1].trim();
    }
    if (/\bRaman2;ROA2;CID2\b/i.test(line)) {
      const match = line.match(/Raman2;ROA2;CID2\s*=\s*(.+?)(?:,|$)/i);
      if (match) labels.roa2 = match[1].trim();
    }
    if (/\bRaman3;ROA3;CID3\b/i.test(line)) {
      const match = line.match(/Raman3;ROA3;CID3\s*=\s*(.+?)(?:\s+RC180|$)/i);
      if (match) labels.roa3 = match[1].trim();
    }
  }
  return labels;
}

/**
 * Pull the ROA rows out of a frequency section. Rows repeat once per block of
 * up to three modes, so they are concatenated in mode order, exactly like the
 * frequency table.
 */
export function parseRoaIntensities(text) {
  const source = String(text || '');
  const lines = source.split(/\r\n|\n|\r/);
  const values = {
    alphaG: [], gamma2: [], delta2: [],
    roa1: [], roa2: [], roa3: [],
    raman1: [], raman2: [], raman3: [],
    cid1: [], cid2: [], cid3: [],
    rc180: [],
  };
  let incidentWavenumber = null;
  for (const line of lines) {
    const incident = line.match(/Incident light\s*\(cm\*\*-1\)\s*:\s*(-?\d+(?:\.\d+)?)/i);
    if (incident) incidentWavenumber = Number(incident[1]);
    const row = line.match(ROW);
    if (row) {
      const lower = row[1].toLowerCase();
      const key = lower === 'alphag' ? 'alphaG' : lower;
      values[key].push(...numbers(row[2]));
    }
  }
  const roaRows = values.roa1.length + values.roa2.length + values.roa3.length;
  if (roaRows === 0) return null;
  const finite = values.roa1.some((value) => Number.isFinite(value))
    || values.roa2.some((value) => Number.isFinite(value))
    || values.roa3.some((value) => Number.isFinite(value));
  if (!finite) return null;
  return {
    ...values,
    incidentWavenumber,
    units: ROA_UNITS,
    invariantUnits: ROA_INVARIANT_UNITS,
    geometries: geometryLabels(source),
    // The log states the geometry labels but not a G16 revision; keeping this
    // null is the honest record of what the table itself says.
    release: null,
  };
}

/** Attach ROA rows to a frequency mode table; absent rows stay null, never 0. */
export function attachRoa(modes, roa) {
  const list = Array.isArray(modes) ? modes : [];
  if (!roa) {
    return list.map((mode) => ({
      ...mode, alphaG: null, gamma2: null, delta2: null,
      roa1: null, roa2: null, roa3: null,
      raman1: null, raman2: null, raman3: null,
      cid1: null, cid2: null, cid3: null, rc180: null,
    }));
  }
  const value = (key, index) => (Number.isFinite(roa[key]?.[index]) ? roa[key][index] : null);
  return list.map((mode, index) => ({
    ...mode,
    alphaG: value('alphaG', index),
    gamma2: value('gamma2', index),
    delta2: value('delta2', index),
    roa1: value('roa1', index),
    roa2: value('roa2', index),
    roa3: value('roa3', index),
    raman1: value('raman1', index),
    raman2: value('raman2', index),
    raman3: value('raman3', index),
    cid1: value('cid1', index),
    cid2: value('cid2', index),
    cid3: value('cid3', index),
    rc180: value('rc180', index),
  }));
}

export function roaSpectrum(modes, { geometry = 'roa1', fwhmCm = 12, points = 600 } = {}) {
  if (!ROA_GEOMETRY_KEYS.includes(geometry)) {
    throw new Error(`Unknown ROA geometry "${geometry}"; choose ${ROA_GEOMETRY_KEYS.join(', ')}.`);
  }
  const peaks = (Array.isArray(modes) ? modes : [])
    .filter((mode) => Number.isFinite(mode.wavenumber) && Number.isFinite(mode[geometry]));
  if (peaks.length === 0) return null;

  const values = peaks.map((mode) => mode.wavenumber);
  const half = Math.max(Number(fwhmCm) / 2, 0.001);
  const pad = Math.max(6 * half, 20);
  const low = Math.min(...values) - pad;
  const high = Math.max(...values) + pad;
  const span = high - low || 1;
  const step = span / Math.max(points - 1, 1);
  const curve = [];
  for (let index = 0; index < points; index += 1) {
    const wavenumber = low + step * index;
    let intensity = 0;
    for (const mode of peaks) {
      const delta = wavenumber - mode.wavenumber;
      intensity += (mode[geometry] * half * half) / (delta * delta + half * half);
    }
    curve.push({ wavenumber, intensity });
  }
  const strongest = Math.max(...peaks.map((mode) => Math.abs(mode[geometry])));
  const positive = peaks.filter((mode) => mode[geometry] > 0).length;
  const label = geometry === 'roa1' ? 'ICPu/SCPu(180)'
    : geometry === 'roa2' ? 'ICPd/SCPd(90)' : 'DCPI(180)';
  return {
    fwhmCm: Number(fwhmCm),
    shape: 'lorentzian',
    signed: true,
    quantity: `ROA intensity · ${label}`,
    units: ROA_UNITS,
    geometry,
    geometryLabel: label,
    normalisation: `strongest |ROA| = 1.00 (${strongest.toFixed(4)} ${ROA_UNITS})`,
    minCm: low,
    maxCm: high,
    peaks: peaks
      .map((mode) => ({
        wavenumber: mode.wavenumber,
        intensity: mode[geometry],
        roa1: mode.roa1,
        roa2: mode.roa2,
        roa3: mode.roa3,
        rc180: mode.rc180,
        sign: mode[geometry] >= 0 ? '+' : '−',
      }))
      .sort((a, b) => a.wavenumber - b.wavenumber),
    counts: { total: peaks.length, positive, negative: peaks.length - positive },
    curve: curve.map((point) => ({
      wavenumber: point.wavenumber,
      intensity: strongest > 0 ? point.intensity / strongest : 0,
    })),
  };
}

/** Signed polyline in the 0–100 × 0–100 figure box, same as the VCD figure. */
export function roaPolyline(spectrum, { width = 100, height = 100 } = {}) {
  if (!spectrum || !Array.isArray(spectrum.curve) || spectrum.curve.length === 0) return '';
  const span = spectrum.maxCm - spectrum.minCm || 1;
  const mid = height / 2;
  return spectrum.curve
    .map((point) => {
      const x = ((point.wavenumber - spectrum.minCm) / span) * width;
      const y = mid - point.intensity * mid;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}
