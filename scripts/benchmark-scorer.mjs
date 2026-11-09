#!/usr/bin/env node
/**
 * ADR 0001 §2.10 — the reordering benchmark.
 *
 * A scorer is only adopted when its ranking is measured against the ranking the
 * block already has. This script takes a JSON file of systems:
 *
 *   { "systems": [
 *       { "id": "system-1", "mm": ["c1","c3","c2"], "ml": ["c1","c2","c3"] }
 *   ] }
 *
 * and prints Kendall's tau per system plus the mean. `mm` is the incumbent
 * ordering (xTB / MMFF94 / file), `ml` the scorer's. A tau of 1 means the scorer
 * kept the order; -1 means it reversed every pair. The script is deliberately
 * separate from the app: it measures a model, it does not bless one.
 *
 * Usage: node scripts/benchmark-scorer.mjs path/to/orderings.json
 */
import fsp from 'node:fs/promises';
import { kendallTau } from '../src/shared/scorer.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/benchmark-scorer.mjs <orderings.json>');
  process.exit(2);
}
const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
const systems = Array.isArray(parsed?.systems) ? parsed.systems : [];
if (systems.length === 0) {
  console.error('The benchmark file has no systems.');
  process.exit(2);
}
const taus = [];
for (const system of systems) {
  const tau = kendallTau(system.mm, system.ml);
  if (tau === null) {
    console.error(`${system.id}: the two orderings are not comparable (different members or fewer than two).`);
    process.exitCode = 1;
    continue;
  }
  taus.push(tau);
  console.log(`${system.id}\ttau=${tau.toFixed(3)}`);
}
if (taus.length > 0) {
  const mean = taus.reduce((sum, value) => sum + value, 0) / taus.length;
  console.log(`mean\ttau=${mean.toFixed(3)} (${taus.length} system${taus.length === 1 ? '' : 's'})`);
}
