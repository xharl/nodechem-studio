/**
 * Regenerates the two captured builder decks in this folder.
 *
 * Issue 343 changed what the builder writes: every deck whose job has a
 * wavefunction now appends `return_wfn=True` and a `fchk(...)` line. The `.dat`
 * files beside this script are the **input the committed logs were produced
 * from**, so this script no longer overwrites them by default — that would
 * destroy the evidence tying `water-gas.out` and `water-pcm.out` to a deck.
 *
 * Run it with no arguments to print the current decks and see whether they still
 * match the captured ones with only the checkpoint statements added. Pass
 * `--write` to replace the captured files (and then re-run Psi4 if you need the
 * logs to match the new decks again).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildPsi4Input } from '../../../src/shared/engines/psi4.js';

const WATER = [
  { element: 'O', x: 0, y: 0, z: 0.1173 },
  { element: 'H', x: 0, y: 0.7572, z: -0.4692 },
  { element: 'H', x: 0, y: -0.7572, z: -0.4692 },
];
const molecule = { charge: 0, multiplicity: 1, coords: WATER, fragments: [] };
const base = {
  jobType: 'SP', method: 'hf', basis: '6-31g(d)', memory: '4', memoryUnit: 'GB',
  solvation: false, solvationModel: 'PCM', solvent: 'Water',
};
const dir = 'test/fixtures/psi4-ddx';
const write = process.argv.includes('--write');
mkdirSync(dir, { recursive: true });

const gas = buildPsi4Input({ title: 'water gas phase', settings: base, molecule, inputName: 'water-gas.dat' });
const pcm = buildPsi4Input({
  title: 'water DDX-PCM',
  settings: { ...base, solvation: true },
  molecule,
  inputName: 'water-pcm.dat',
});

const captured = (name) => {
  try {
    return readFileSync(`${dir}/${name}`, 'utf8');
  } catch {
    return null;
  }
};
const strip = (text) => text
  // `E, wfn = energy(...)`  → `energy(...)`
  .replace(/^\w+, wfn = /gm, '')
  // `E_gas = energy(...)`   → `energy(...)`
  .replace(/^\w+ = (energy|optimize|frequencies)\(/gm, '$1(')
  .replace(/,\s*return_wfn=True/g, '')
  // the checkpoint line itself
  .replace(/^fchk\(wfn, .*\)\n/m, '');

for (const [name, deck] of [['water-gas.dat', gas], ['water-pcm.dat', pcm]]) {
  const before = captured(name);
  const same = before === deck.inputText;
  const sameModuloCheckpoint = before !== null && strip(before) === strip(deck.inputText);
  console.log(`--- ${name} ---`);
  console.log(deck.inputText);
  console.log(same
    ? 'matches the captured file byte for byte'
    : sameModuloCheckpoint
      ? 'matches the captured file once the issue-343 checkpoint statements are removed'
      : 'differs from the captured file by more than the checkpoint statements');
  if (write) writeFileSync(`${dir}/${name}`, deck.inputText);
}

console.log('route:', pcm.route);
