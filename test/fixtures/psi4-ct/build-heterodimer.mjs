import { writeFileSync } from 'node:fs';
import { buildPsi4Input } from '../../../src/shared/engines/psi4.js';

const dir = new URL('./', import.meta.url).pathname;

// Ammonia (fragment 1, 4 atoms) donating to water (fragment 2, 3 atoms) along
// +z/-z. N-H = 1.012 A, H-N-H = 107 deg; the water O sits 2.95 A from N with one
// O-H pointing at the nitrogen (O...H = 1.98 A). Different fragments and
// different sizes, so the CT partition has a direction and the atom map has to
// respect it.
const ammonia = (label) => {
  const r = 1.012;
  const s = Math.sin(Math.acos(0.372));
  const c = 0.372;
  return [90, 210, 330].map((deg) => {
    const phi = (deg * Math.PI) / 180;
    return {
      element: 'H',
      x: Number((r * s * Math.cos(phi)).toFixed(6)),
      y: Number((r * s * Math.sin(phi)).toFixed(6)),
      z: Number((r * c).toFixed(6)),
      fragment: label,
    };
  });
};

const coords = [
  { element: 'N', x: 0, y: 0, z: 0, fragment: 1 },
  ...ammonia(1),
  { element: 'O', x: 0, y: 0, z: -2.95, fragment: 2 },
  { element: 'H', x: 0, y: 0, z: -1.98, fragment: 2 },
  { element: 'H', x: 0.9265, y: 0, z: -3.189, fragment: 2 },
];

const built = buildPsi4Input({
  title: 'Ammonia-water dimer (N...H-O 1.98 A) - issue 173 CT fixture',
  settings: {
    jobType: 'TD-DFT',
    method: 'b3lyp',
    basis: 'def2-svp',
    tdStates: 12,
    recordTransitionDipoles: true,
    memory: '4',
    memoryUnit: 'GB',
    nproc: 4,
    scf: 'tight',
  },
  molecule: { charge: 0, multiplicity: 1, coords },
  inputName: 'ammonia-water-td.dat',
});

writeFileSync(`${dir}/ammonia-water-td.dat`, built.inputText);
console.log(built.inputText);
