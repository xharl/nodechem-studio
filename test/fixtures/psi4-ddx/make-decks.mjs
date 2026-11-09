import { mkdirSync, writeFileSync } from 'node:fs';
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
mkdirSync(dir, { recursive: true });

const gas = buildPsi4Input({ title: 'water gas phase', settings: base, molecule, inputName: 'water-gas.dat' });
writeFileSync(`${dir}/water-gas.dat`, gas.inputText);

const pcm = buildPsi4Input({
  title: 'water DDX-PCM',
  settings: { ...base, solvation: true },
  molecule,
  inputName: 'water-pcm.dat',
});
writeFileSync(`${dir}/water-pcm.dat`, pcm.inputText);

console.log('--- gas ---\n' + gas.inputText);
console.log('--- pcm ---\n' + pcm.inputText);
console.log('route:', pcm.route);
