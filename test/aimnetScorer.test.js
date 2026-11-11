import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmrf } from './helpers/tempCleanup.js';

/**
 * Issue 317 — the shipped AIMNet2 scorer sidecar could not run anywhere:
 *
 *  1. it imported `aimnet2`, a distribution that does not exist (the published
 *     one is `aimnet`, module `aimnet.calculators`);
 *  2. it handed the calculator unbatched tensors and no `mult`;
 *  3. `torch`/`warp`/`aimnet` print a banner on import, which landed on stdout —
 *     the JSON channel — so the parent's JSON.parse failed even on success.
 *
 * These tests run the real script against a stub `torch` and a stub `aimnet`
 * that behaves like 0.2.x: it rejects anything but a batched structure, it needs
 * `mult`, and it prints a banner the moment it is imported. No torch is
 * installed in CI, and the model weights are a stub file — nothing here calls
 * the real network.
 */

const SCRIPT = path.resolve('scripts/aimnet2-scorer.py');

function pythonBinary() {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['-V'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const PYTHON = pythonBinary();
const canRun = Boolean(PYTHON) && process.platform !== 'win32';

/** A stub `torch` with just the surface the sidecar touches. */
const TORCH_STUB = `
class Tensor:
    def __init__(self, data, dtype=None):
        self.data = data
        self.dtype = dtype
        self.shape = _shape(data)

    def unsqueeze(self, dim):
        if dim != 0:
            raise RuntimeError("stub only unsqueezes dim 0")
        return Tensor([self.data], self.dtype)

    def reshape(self, *shape):
        rows = list(self.data)
        if shape == (-1,):
            return Tensor(_flatten(rows), self.dtype)
        count, width = shape
        if len(rows) == 1 and isinstance(rows[0], list) and rows[0] and isinstance(rows[0][0], list):
            rows = rows[0]
        if len(rows) != count or any(len(row) != width for row in rows):
            raise RuntimeError("reshape mismatch: asked for %s, have %s" % (shape, self.shape))
        return Tensor(rows, self.dtype)

    def detach(self):
        return self

    def cpu(self):
        return self

    def tolist(self):
        return self.data

    def __getitem__(self, index):
        return Tensor(self.data[index], self.dtype)

    def __float__(self):
        value = self.data[0] if isinstance(self.data, list) else self.data
        return float(value)


def _shape(data):
    if isinstance(data, list):
        return (len(data),) + (_shape(data[0]) if data else ())
    return ()


def _flatten(rows):
    out = []
    for row in rows:
        if isinstance(row, list):
            out.extend(_flatten(row))
        else:
            out.append(row)
    return out


long = "int64"
float64 = "float64"


def get_default_dtype():
    return "float32"


def tensor(data, dtype=None):
    return Tensor(data, dtype)
`;

/**
 * A stub `aimnet` package that fails exactly where the real one does: banners on
 * stdout, and a calculator that only accepts the batched structure.
 */
function aimnetStub(moduleName) {
  const calculators = `
import sys

print("Warp 1.19.0 initialized:")
print("   CUDA Toolkit 13.4, CUDA driver not available")


class AIMNet2Calculator:
    """Behaves like aimnet 0.2.x: needs the batched structure, and mult."""

    def __init__(self, weights):
        print("aimnet: loaded %s" % weights)
        self.weights = weights

    def __call__(self, data, forces=False):
        coord = data["coord"]
        numbers = data["numbers"]
        charge = data["charge"]
        mult = data["mult"]

        if len(coord.shape) != 3 or coord.shape[0] != 1 or coord.shape[2] != 3:
            raise RuntimeError("coord must be (1, N, 3), got %s" % (coord.shape,))
        if numbers.shape != (1, coord.shape[1]):
            raise RuntimeError("numbers must be (1, N), got %s" % (numbers.shape,))
        if charge.shape != (1,):
            raise RuntimeError("charge must be (1,), got %s" % (charge.shape,))
        if mult.shape != (1,):
            raise RuntimeError("mult must be (1,), got %s" % (mult.shape,))

        atoms = coord.shape[1]
        energy = -100.0 + float(charge.data[0]) + float(mult.data[0])
        return {
            "energy": _tensor([[energy]]),
            "forces": _tensor([[[0.0, 0.0, -0.03] for _ in range(atoms)]]),
        }
`;

  if (moduleName === 'aimnet') {
    return {
      'aimnet/__init__.py': 'print("aimnet 0.2.6 (stub) imported")\n',
      'aimnet/calculators.py': calculators + '\n\ndef _tensor(data):\n    import torch\n    return torch.Tensor(data)\n',
      'aimnet-0.2.6.dist-info/METADATA': 'Metadata-Version: 2.1\nName: aimnet\nVersion: 0.2.6\n',
    };
  }
  return {
    'aimnet2.py': calculators + '\n\ndef _tensor(data):\n    import torch\n    return torch.Tensor(data)\n',
    'aimnet2-0.2.6.dist-info/METADATA': 'Metadata-Version: 2.1\nName: aimnet2\nVersion: 0.2.6\n',
  };
}

const WATER = {
  model: 'aimnet2',
  charge: 0,
  multiplicity: 3,
  frames: [{
    id: 'c1',
    atoms: [
      { element: 'O', x: 0.0, y: 0.0, z: 0.119 },
      { element: 'H', x: 0.0, y: 0.763, z: -0.477 },
      { element: 'H', x: 0.0, y: -0.763, z: -0.477 },
    ],
  }],
};

const roots = [];

async function stubEnv(files) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-aimnet-'));
  roots.push(root);
  const site = path.join(root, 'site');
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(site, name);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, body);
  }
  const weights = path.join(root, 'aimnet2_weights.pt');
  await fsp.writeFile(weights, 'not a real checkpoint\n');
  return {
    env: { ...process.env, PYTHONPATH: site, AIMNET2_WEIGHTS: weights, AIMNET2_DEVICE: 'cpu' },
  };
}

function runSidecar(env, request = WATER) {
  return spawnSync(PYTHON, [SCRIPT, '--model', 'aimnet2'], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    env,
    timeout: 60000,
  });
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rmrf(root)));
});

describe.skipIf(!canRun)('aimnet2 scorer sidecar (issue 317)', () => {
  let torchRoot;

  beforeAll(async () => {
    torchRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gns-torch-'));
    roots.push(torchRoot);
    await fsp.writeFile(path.join(torchRoot, 'torch.py'), TORCH_STUB);
  });

  async function envWith(files) {
    const { env } = await stubEnv(files);
    return { ...env, PYTHONPATH: `${env.PYTHONPATH}${path.delimiter}${torchRoot}` };
  }

  it('imports the published distribution and returns one clean JSON line', async () => {
    const env = await envWith(aimnetStub('aimnet'));
    const run = runSidecar(env);

    expect(run.stderr).not.toContain('Traceback');
    expect(run.status).toBe(0);

    // stdout is the contract, and only the result object may appear on it.
    const lines = run.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(run.stdout).not.toContain('Warp');

    const payload = JSON.parse(lines[0]);
    expect(payload).toMatchObject({
      model: 'aimnet2',
      version: '0.2.6',
      dtype: 'float32',
      device: 'cpu',
      charge: 0,
      multiplicity: 3,
    });
    expect(payload.weightsSha256).toMatch(/^[0-9a-f]{64}$/);
    // -100 + charge + mult, so the value proves `mult` reached the calculator.
    expect(payload.results[0].energyEv).toBeCloseTo(-97, 6);
    expect(payload.results[0].energyHartree).toBeCloseTo(-97 * 0.03674932217565499, 9);
    // Forces come back unbatched: one row per atom, three components each.
    expect(payload.results[0].forces).toHaveLength(3);
    expect(payload.results[0].forces[0]).toHaveLength(3);
  });

  it('sends the library banners to stderr, never to the JSON channel', async () => {
    const env = await envWith(aimnetStub('aimnet'));
    const run = runSidecar(env);

    expect(run.stderr).toContain('Warp 1.19.0 initialized');
    expect(run.stderr).toContain('aimnet: loaded');
    expect(run.stdout).not.toContain('initialized');
    expect(run.stdout).not.toContain('loaded');
  });

  it('still accepts a fork that ships the module as aimnet2', async () => {
    const env = await envWith(aimnetStub('aimnet2'));
    const run = runSidecar(env);

    expect(run.status).toBe(0);
    const payload = JSON.parse(run.stdout.trim());
    expect(payload.version).toBe('0.2.6');
    expect(payload.results[0].energyEv).toBeCloseTo(-97, 6);
  });

  it('names the package that actually exists when neither is installed', async () => {
    const env = await envWith({});
    const run = runSidecar(env);

    expect(run.status).toBe(2);
    expect(run.stdout.trim()).toBe('');
    expect(run.stderr).toContain('Neither `aimnet` nor `aimnet2` is importable');
    expect(run.stderr).toContain('pip install aimnet torch');
  });

  it('keeps the request contract for charge and multiplicity', async () => {
    const env = await envWith(aimnetStub('aimnet'));
    const run = runSidecar(env, { ...WATER, charge: 1, multiplicity: 2 });

    expect(run.status).toBe(0);
    const payload = JSON.parse(run.stdout.trim());
    expect(payload).toMatchObject({ charge: 1, multiplicity: 2 });
    // -100 + 1 + 2
    expect(payload.results[0].energyEv).toBeCloseTo(-97, 6);
  });
});
