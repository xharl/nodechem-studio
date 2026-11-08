/**
 * Frontier-orbital energies and the Koopmans descriptors derived from them.
 *
 * Gaussian prints orbital eigenvalues only when the route asks for it
 * (`Pop=Full`, or an `IOp` that turns the print on):
 *
 *      Alpha  occ. eigenvalues --  -10.02022  -10.02017  -10.00811
 *      ...
 *      Alpha virt. eigenvalues --  -0.17750  -0.11127  -0.09444
 *
 * The occupied lines end at the HOMO and the virtual lines begin at the LUMO,
 * which is the whole definition used here: no gap is inferred from a MO diagram,
 * no ordering is assumed within a line beyond the order Gaussian printed.
 *
 * An open-shell job prints a `Beta` pair as well. The alpha and beta manifolds
 * have their own frontier orbitals, so they are kept apart rather than averaged:
 * for a doublet the beta HOMO and LUMO, not the alpha ones, are the ones a
 * Koopmans analysis of the unpaired electron refers to.
 *
 * Descriptors follow the paper-level definitions from Koopmans' theorem:
 *   IP = -E(HOMO), EA = -E(LUMO), gap = E(LUMO) - E(HOMO),
 *   mu = (IP + EA)/2, chi = -mu, eta = (IP - EA)/2, sigma = 1/eta,
 *   omega = mu^2 / (2*eta).
 * They are orbital-energy estimates, not Delta-SCF ionisation potentials; the
 * panel says so, because the two disagree by several tenths of an eV.
 */

/** CODATA 2018 hartree, in eV. */
export const HARTREE_TO_EV = 27.211386245988;

const EIGENVALUE_LINE = /^\s*(Alpha|Beta)\s+(occ|virt)\.\s*eigenvalues\s*--\s*(.*)$/;
const NUMBER = /-?\d+\.\d+/g;

/**
 * Every eigenvalue block in the text, oldest first. A file can print the
 * spectrum more than once (once at SCF convergence and again inside the
 * population analysis), so the caller decides which block is the result.
 *
 * @returns {Array<{alpha: {occupied: number[], virtual: number[]}, beta: {occupied: number[], virtual: number[]} | null, line: number}>}
 */
export function parseOrbitalBlocks(text) {
  const lines = String(text ?? '').split(/\r\n|\n|\r/);
  const blocks = [];
  let current = null;

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(EIGENVALUE_LINE);
    if (!match) continue;
    const [, spin, kind, tail] = match;
    // A new alpha occupied run starts a block; anything else continues the one
    // in progress (Gaussian wraps the list over several lines).
    // A wrapped list also starts with `Alpha occ.`, so a new block only begins
    // once the previous one has printed its virtual orbitals — that is the end
    // of a spectrum, and anything after it is a second print (for example the
    // one inside the population analysis).
    if (spin === 'Alpha' && kind === 'occ' && (!current || current.alpha.virtual.length > 0)) {
      current = {
        alpha: { occupied: [], virtual: [] },
        beta: null,
        line: index + 1,
      };
      blocks.push(current);
    }
    if (!current) continue;
    const values = (tail.match(NUMBER) || []).map(Number).filter((value) => Number.isFinite(value));
    if (!values.length) continue;
    if (spin === 'Beta') {
      if (!current.beta) current.beta = { occupied: [], virtual: [] };
      current.beta[kind === 'occ' ? 'occupied' : 'virtual'].push(...values);
    } else {
      current.alpha[kind === 'occ' ? 'occupied' : 'virtual'].push(...values);
    }
  }

  return blocks.filter((block) => block.alpha.occupied.length > 0 && block.alpha.virtual.length > 0);
}

/**
 * The frontier pair of one manifold: the last occupied and the first virtual
 * orbital, in hartree.
 */
export function frontierOf(manifold) {
  if (!manifold || manifold.occupied.length === 0 || manifold.virtual.length === 0) return null;
  return {
    homoHartree: manifold.occupied[manifold.occupied.length - 1],
    lumoHartree: manifold.virtual[0],
    occupiedCount: manifold.occupied.length,
    virtualCount: manifold.virtual.length,
  };
}

function round(value, places = 6) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Koopmans descriptors for one manifold, in eV. Everything is derived from the
 * two orbital energies; nothing is filled in when the pair is missing.
 */
export function descriptorsOf(frontier, { spin = 'restricted' } = {}) {
  if (!frontier) return null;
  const homoEv = frontier.homoHartree * HARTREE_TO_EV;
  const lumoEv = frontier.lumoHartree * HARTREE_TO_EV;
  const gapEv = lumoEv - homoEv;
  const ipEv = -homoEv;
  const eaEv = -lumoEv;
  const muEv = (ipEv + eaEv) / 2;
  const chiEv = -muEv;
  const etaEv = (ipEv - eaEv) / 2;
  return {
    spin,
    homoHartree: frontier.homoHartree,
    lumoHartree: frontier.lumoHartree,
    homoEv: round(homoEv),
    lumoEv: round(lumoEv),
    gapEv: round(gapEv),
    ipEv: round(ipEv),
    eaEv: round(eaEv),
    muEv: round(muEv),
    chiEv: round(chiEv),
    etaEv: round(etaEv),
    // Softness is the reciprocal of hardness and carries 1/eV; it is undefined
    // for a zero gap, which a metallic/zero-gap description would produce.
    softnessPerEv: etaEv === 0 ? null : round(1 / etaEv),
    electrophilicityEv: etaEv === 0 ? null : round((muEv * muEv) / (2 * etaEv)),
  };
}

/**
 * The result the results panel and the dataset export both read.
 *
 * `matched: false` means the log carried no eigenvalue block — the route did not
 * ask for `Pop=Full`, or the run died before printing it. That is reported as
 * "not printed", never as a zero gap.
 */
export function parseOrbitals(text) {
  const blocks = parseOrbitalBlocks(text);
  if (blocks.length === 0) {
    return {
      matched: false,
      reason: 'no orbital eigenvalues in this log',
      alpha: null,
      beta: null,
      line: null,
      openShell: false,
      gapEv: null,
    };
  }
  const block = blocks[blocks.length - 1];
  const alpha = descriptorsOf(frontierOf(block.alpha), { spin: block.beta ? 'alpha' : 'restricted' });
  const beta = block.beta
    ? descriptorsOf(frontierOf(block.beta), { spin: 'beta' })
    : null;
  const openShell = Boolean(beta);
  return {
    matched: true,
    reason: null,
    line: block.line,
    openShell,
    alpha,
    beta,
    // Which manifold a single "gap" number should come from: the alpha one for
    // a closed shell, and for an open shell the alpha gap with the beta values
    // kept alongside rather than silently averaged.
    gapEv: alpha ? alpha.gapEv : null,
  };
}
