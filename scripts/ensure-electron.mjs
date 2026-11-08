/**
 * Make `npm start` open a window after a fresh install.
 *
 * npm >= 12 skips dependency lifecycle scripts unless they are allow-listed, so
 * Electron's own postinstall never runs and `node_modules/electron/dist/` stays
 * empty — `npm start` then exits without opening anything, and the failure
 * looks like an application bug rather than an install one. This script runs
 * Electron's installer only when its binary is missing, so it is a no-op on a
 * healthy tree and in CI, where `npm run build` and `npm test` do not need it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const dist = path.join(root, 'node_modules', 'electron', 'dist');
const installer = path.join(root, 'node_modules', 'electron', 'install.js');

if (fs.existsSync(dist) && fs.readdirSync(dist).length > 0) process.exit(0);
if (!fs.existsSync(installer)) {
  process.stderr.write('ensure-electron: electron is not installed in this tree; run npm ci first.\n');
  process.exit(0);
}

process.stdout.write('ensure-electron: node_modules/electron/dist is missing; running Electron\'s installer...\n');
const result = spawnSync(process.execPath, [installer], { stdio: 'inherit' });
process.exit(result.status ?? 1);
