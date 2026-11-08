#!/usr/bin/env node
/**
 * Syntax-check every JavaScript module that ships with the app.
 *
 * The previous `check` script was one hand-written `node --check` chain in
 * package.json. It was easy to forget: three modules added in the 0.3 cycle
 * (diagnostics, templates, editHistory) were never listed and therefore never
 * parsed. Walking the trees instead means a new file cannot be added without
 * being checked.
 *
 * Parsing only: vitest owns behaviour, this owns "does every shipped file
 * parse at all".
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOTS = ['electron', 'src', 'bin', 'scripts'];
const EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', '.git']);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      yield join(dir, entry.name);
    }
  }
}

const files = ROOTS.flatMap((root) => {
  try {
    return [...walk(root)];
  } catch {
    return [];
  }
}).sort();

if (files.length === 0) {
  console.error('check: no files found — wrong working directory?');
  process.exit(1);
}

const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n')[0];
    failures.push({ file: relative(process.cwd(), file), detail });
  }
}

if (failures.length > 0) {
  for (const { file, detail } of failures) console.error(`✗ ${file}\n    ${detail}`);
  console.error(`check: ${failures.length} of ${files.length} modules failed to parse`);
  process.exit(1);
}

console.log(`check: ${files.length} modules parse`);
