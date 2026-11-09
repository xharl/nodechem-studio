import { writeFileSync, mkdirSync } from 'node:fs';
import { buildPsi4Input } from '../../../src/shared/engines/psi4.js';

const dir = new URL('./', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });

// Two ethylenes, each planar in xy, stacked along z at 3.60 Å and slipped by
// 1.40 Å along x. Every atom carries its fragment label, which is what the CT
// partition reads.
const monomer = (dx, dz, label) => ([
  { element: 'C', x: 0.6695 + dx, y: 0.0000, z: dz, fragment: label },
  { element: 'C', x: -0.6695 + dx, y: 0.0000, z: dz, fragment: label },
  { element: 'H', x: 1.2321 + dx, y: 0.9236, z: dz, fragment: label },
  { element: 'H', x: 1.2321 + dx, y: -0.9236, z: dz, fragment: label },
  { element: 'H', x: -1.2321 + dx, y: 0.9236, z: dz, fragment: label },
  { element: 'H', x: -1.2321 + dx, y: -0.9236, z: dz, fragment: label },
]);

const built = buildPsi4Input({
  title: 'Stacked ethylene dimer (3.60 A, 1.40 A slip) - issue 173 CT fixture',
  settings: {
    jobType: 'TD-DFT',
    method: 'b3lyp',
    basis: 'def2-svp',
    tdStates: 20,
    recordTransitionDipoles: true,
    memory: '4',
    memoryUnit: 'GB',
    nproc: 4,
    scf: 'tight',
  },
  molecule: {
    charge: 0,
    multiplicity: 1,
    coords: [...monomer(0, 0, 1), ...monomer(1.4, 3.6, 2)],
  },
  inputName: 'ethylene-dimer-td.dat',
});

writeFileSync(`${dir}/ethylene-dimer-td.dat`, built.inputText);
console.log(built.inputText);
