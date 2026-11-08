/**
 * Superposition of two geometries: Kabsch-style alignment via Horn's quaternion
 * method, plus the RMSD that comes out of it.
 *
 * Only the atoms both structures list, in the same order, are used — the count
 * is returned so a reported RMSD always says what it was computed over. A mass
 * weighting is deliberately not applied: the number quoted is the plain
 * per-atom RMSD in Ångström, and saying "mass-weighted" would describe a
 * different quantity.
 */

function centre(points) {
  const n = points.length;
  const sum = points.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y, z: acc.z + point.z }), { x: 0, y: 0, z: 0 });
  return { x: sum.x / n, y: sum.y / n, z: sum.z / n };
}

function centred(points, origin) {
  return points.map((point) => ({ x: point.x - origin.x, y: point.y - origin.y, z: point.z - origin.z }));
}

/** Jacobi eigenvalue iteration for a symmetric 4×4 matrix. */
function largestEigenvector(matrix) {
  const a = matrix.map((row) => row.slice());
  const v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 64; sweep += 1) {
    let off = 0;
    for (let p = 0; p < 4; p += 1) for (let q = p + 1; q < 4; q += 1) off += a[p][q] * a[p][q];
    if (off < 1e-18) break;
    for (let p = 0; p < 4; p += 1) {
      for (let q = p + 1; q < 4; q += 1) {
        if (Math.abs(a[p][q]) < 1e-18) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; k += 1) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k += 1) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k += 1) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i += 1) if (a[i][i] > a[best][best]) best = i;
  return [v[0][best], v[1][best], v[2][best], v[3][best]];
}

/**
 * Rotate `moving` onto `reference`.
 *
 * Returns `{ rmsd, atoms, rotation, translation, aligned }`. Throws when the
 * two structures cannot be compared at all (different atom counts or element
 * order), because a quietly truncated RMSD is worse than a refusal.
 */
export function superimpose(reference, moving) {
  const ref = Array.isArray(reference) ? reference : [];
  const mov = Array.isArray(moving) ? moving : [];
  if (ref.length === 0 || ref.length !== mov.length) {
    throw new Error(`Superposition needs two structures with the same atom count; got ${ref.length} and ${mov.length}.`);
  }
  for (let index = 0; index < ref.length; index += 1) {
    if (String(ref[index].element) !== String(mov[index].element)) {
      throw new Error(`Atom ${index + 1} is ${ref[index].element} in the reference and ${mov[index].element} in the moving structure; the atoms must be given in the same order.`);
    }
  }
  const refCentre = centre(ref);
  const movCentre = centre(mov);
  const p = centred(ref, refCentre);
  const q = centred(mov, movCentre);

  // Horn's symmetric 4×4 matrix from the cross-covariance of the two sets.
  let sxx = 0; let sxy = 0; let sxz = 0; let syx = 0; let syy = 0; let syz = 0; let szx = 0; let szy = 0; let szz = 0;
  for (let index = 0; index < p.length; index += 1) {
    // S = Σ q pᵀ: the quaternion eigenvector is then the rotation that carries
    // the moving set onto the reference set (the transposed product gives the
    // inverse rotation).
    sxx += q[index].x * p[index].x; sxy += q[index].x * p[index].y; sxz += q[index].x * p[index].z;
    syx += q[index].y * p[index].x; syy += q[index].y * p[index].y; syz += q[index].y * p[index].z;
    szx += q[index].z * p[index].x; szy += q[index].z * p[index].y; szz += q[index].z * p[index].z;
  }
  const matrix = [
    [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
  ];
  const [qw, qx, qy, qz] = largestEigenvector(matrix);
  const norm = Math.hypot(qw, qx, qy, qz) || 1;
  const w = qw / norm; const x = qx / norm; const y = qy / norm; const z = qz / norm;
  const rotation = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
  const apply = (point) => ({
    x: rotation[0][0] * point.x + rotation[0][1] * point.y + rotation[0][2] * point.z,
    y: rotation[1][0] * point.x + rotation[1][1] * point.y + rotation[1][2] * point.z,
    z: rotation[2][0] * point.x + rotation[2][1] * point.y + rotation[2][2] * point.z,
  });
  const aligned = q.map((point) => {
    const rotated = apply(point);
    return { x: rotated.x + refCentre.x, y: rotated.y + refCentre.y, z: rotated.z + refCentre.z };
  });
  let sumSquares = 0;
  for (let index = 0; index < p.length; index += 1) {
    sumSquares += (aligned[index].x - ref[index].x) ** 2
      + (aligned[index].y - ref[index].y) ** 2
      + (aligned[index].z - ref[index].z) ** 2;
  }
  return {
    rmsd: Math.sqrt(sumSquares / p.length),
    atoms: p.length,
    rotation,
    translation: refCentre,
    aligned,
    elements: ref.map((atom) => atom.element),
  };
}

/**
 * Per-atom distances after superposition, heaviest deviation first — the atoms
 * a chemist will look at first when judging whether two conformers are the same
 * structure.
 */
export function largestDeviations(reference, aligned, { limit = 5 } = {}) {
  const deviations = reference.map((atom, index) => ({
    index: index + 1,
    element: atom.element,
    distance: Math.hypot(
      aligned[index].x - atom.x,
      aligned[index].y - atom.y,
      aligned[index].z - atom.z,
    ),
  }));
  return deviations.sort((a, b) => b.distance - a.distance).slice(0, limit);
}
