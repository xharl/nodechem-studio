import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  GAUSSIAN_PARSE_BRANCHES,
  GAUSSIAN_SUPPORTED_VERSIONS,
  parseGaussianOutput,
} from '../src/shared/gaussianOutput.js';
import {
  ORCA_PARSE_BRANCHES,
  ORCA_SUPPORTED_VERSIONS,
  parseOrcaOutput,
} from '../src/shared/engines/orca.js';
import {
  PSI4_PARSE_BRANCHES,
  PSI4_SUPPORTED_VERSIONS,
  parsePsi4Output,
} from '../src/shared/engines/psi4.js';
import {
  XTB_PARSE_BRANCHES,
  XTB_SUPPORTED_VERSIONS,
  parseXtbOutput,
} from '../src/shared/engines/xtb.js';

/**
 * Issue 176 — a parser branch with no captured real log is a red suite.
 *
 * The branch→fixture map below is **not** maintained here: it is produced by
 * parsing every log under `test/fixtures/real/**` with the engine parser and
 * asking each branch, through its own `taken()` predicate, whether the parse
 * resolved it. Adding a branch to a parser without adding a log for it fails
 * `fails when a declared branch has no captured fixture`, and the failure names
 * the log line the branch keys on.
 *
 * Three rules are enforced for the fixtures themselves:
 *
 * - every fixture **folder** carries a `PROVENANCE.md` with `Engine`, `Version`
 *   and `Command` rows (`test/fixtures/real/README.md` covers the older
 *   flat-file corpus, and the test checks every flat file is named there);
 * - the version a fixture names must appear in the parser's exported
 *   `*_SUPPORTED_VERSIONS`, so a log from an unknown release cannot be trusted
 *   silently;
 * - every branch names the releases its line was observed in, and those must be
 *   a subset of the same list.
 *
 * A branch that no log in this environment can reach is declared with a
 * `fixture: 'blocked: …'` reason in the parser's own list. It is printed as a
 * named gap in the table below instead of counting as a pass.
 */

const CORPUS = fileURLToPath(new URL('./fixtures/real/', import.meta.url));

const ENGINES = {
  psi4: {
    parser: parsePsi4Output,
    branches: () => PSI4_PARSE_BRANCHES,
    versions: PSI4_SUPPORTED_VERSIONS,
    name: /psi4/i,
  },
  gaussian: {
    parser: parseGaussianOutput,
    branches: () => GAUSSIAN_PARSE_BRANCHES,
    versions: GAUSSIAN_SUPPORTED_VERSIONS,
    name: /gaussian/i,
  },
  xtb: {
    parser: parseXtbOutput,
    branches: () => XTB_PARSE_BRANCHES,
    versions: XTB_SUPPORTED_VERSIONS,
    name: /xtb/i,
  },
  orca: {
    parser: parseOrcaOutput,
    branches: () => ORCA_PARSE_BRANCHES,
    versions: ORCA_SUPPORTED_VERSIONS,
    name: /orca/i,
  },
};

/**
 * Gaussian logs in this corpus were collected before the `g16-`/`g09-` prefix
 * convention existed. They stay where other tests read them; naming them here is
 * what makes the file→engine map total, so a new unclaimed log fails the suite.
 */
const LEGACY_GAUSSIAN_LOGS = new Set(['irc-summary.log', 'scan-relaxed.log', 'scan-unrelaxed.log']);

const OUTPUT_FILE = /\.(?:out|log)$/i;

/** Engine that produced a fixture, from its file or folder name. */
function engineFor(name) {
  if (/^psi4/i.test(name)) return 'psi4';
  if (/^g(?:09|16)/i.test(name)) return 'gaussian';
  if (/^xtb/i.test(name)) return 'xtb';
  if (/^orca/i.test(name)) return 'orca';
  if (LEGACY_GAUSSIAN_LOGS.has(name)) return 'gaussian';
  return null;
}

/** `1.11rc3.dev5` → `1.11`, `6.6.1` → `6.6`, `09 Rev D.01` → `09`. */
function majorMinor(version) {
  const match = /(\d+)(?:\.(\d+))?/.exec(String(version ?? ''));
  if (!match) return null;
  return match[2] === undefined ? match[1] : `${match[1]}.${match[2]}`;
}

/**
 * The `| Field | Value |` rows of a PROVENANCE.md, or null when the file is
 * missing. Deliberately strict: a prose paragraph is not provenance.
 */
function provenanceOf(dir) {
  const path = join(CORPUS, dir, 'PROVENANCE.md');
  if (!statSync(join(CORPUS, dir)).isDirectory()) return null;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const fields = {};
  for (const line of text.split('\n')) {
    const row = /^\|\s*([A-Za-z][A-Za-z ]*?)\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (row) fields[row[1]] = row[2];
  }
  return { path, text, fields };
}

/** True when the corpus README names the file literally or through a glob row. */
function readmeMentions(name, readme) {
  if (readme.includes(name)) return true;
  for (const raw of readme.match(/`[^`\n]+`/g) || []) {
    const token = raw.slice(1, -1).trim();
    if (!token.includes('*')) continue;
    const pattern = token
      .replace(/[.+^$()|[\]\\]/g, '\\$&')
      .replace(/\{([^}]*)\}/g, (_, list) => `(?:${list.split(',').map((part) => part.trim()).join('|')})`)
      .replace(/\*/g, '.*');
    if (new RegExp(`^${pattern}$`).test(name)) return true;
  }
  return false;
}

/** Every output file in the corpus, with the engine that should parse it. */
function discoverFixtures() {
  const entries = readdirSync(CORPUS, { withFileTypes: true });
  const fixtures = [];
  const folders = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      folders.push(entry.name);
      for (const name of readdirSync(join(CORPUS, entry.name))) {
        if (!OUTPUT_FILE.test(name)) continue;
        fixtures.push({ rel: `${entry.name}/${name}`, engine: engineFor(entry.name), folder: entry.name });
      }
    } else if (OUTPUT_FILE.test(entry.name)) {
      fixtures.push({ rel: entry.name, engine: engineFor(entry.name), folder: null });
    }
  }
  return { fixtures, folders };
}

let cached = null;

/** Parse the corpus once and record which branches each fixture reaches. */
function coverage() {
  if (cached) return cached;
  const { fixtures, folders } = discoverFixtures();
  const taken = new Map();
  const parseFailures = [];
  for (const fixture of fixtures) {
    if (!fixture.engine) continue;
    let parsed;
    try {
      parsed = ENGINES[fixture.engine].parser(readFileSync(join(CORPUS, fixture.rel), 'utf8'));
    } catch (error) {
      parseFailures.push(`${fixture.rel}: ${error.message}`);
      continue;
    }
    for (const branch of ENGINES[fixture.engine].branches()) {
      if (!branch.taken(parsed)) continue;
      const key = `${fixture.engine}.${branch.id}`;
      if (!taken.has(key)) taken.set(key, []);
      taken.get(key).push(fixture.rel);
    }
  }
  cached = { fixtures, folders, taken, parseFailures };
  return cached;
}

/** Fixed-width table: engine, branch, the fixture(s) that reach it. */
function branchTable() {
  const { taken } = coverage();
  const rows = [];
  const summarize = (hits) => (hits.length > 3
    ? `${hits.slice(0, 3).join(', ')} (+${hits.length - 3} more)`
    : hits.join(', '));
  for (const [engineId, engine] of Object.entries(ENGINES)) {
    for (const branch of engine.branches()) {
      const key = `${engineId}.${branch.id}`;
      const hits = taken.get(key) ?? [];
      rows.push([
        engineId,
        branch.id,
        hits.length ? summarize(hits) : (branch.fixture ? `GAP — ${branch.fixture}` : 'GAP — no fixture'),
      ]);
    }
  }
  const widths = [0, 1].map((column) => Math.max(...rows.map((row) => row[column].length)));
  return rows
    .map((row) => `${row[0].padEnd(widths[0])}  ${row[1].padEnd(widths[1])}  ${row[2]}`)
    .join('\n');
}

describe('real-output fixture coverage (issue 176)', () => {
  it('parses every committed fixture without throwing', () => {
    expect(coverage().parseFailures).toEqual([]);
  });

  it('claims every fixture for an engine', () => {
    const unclaimed = coverage().fixtures
      .filter((fixture) => !fixture.engine)
      .map((fixture) => fixture.rel);
    expect(
      unclaimed,
      'name these fixtures so the coverage test knows which parser to run, or move them into '
        + '<engine>-<version>-<molecule>-<job>/ folders',
    ).toEqual([]);
  });

  it('prints the branch → fixture table', () => {
    // The table is the point of the test: a gap has to be visible in the run
    // output, not only in a failing assertion nobody reads.
    console.log(`\nParser branch coverage (issue 176)\n\n${branchTable()}\n`);
    expect(branchTable().length).toBeGreaterThan(0);
  });

  it('fails when a declared branch has no captured fixture', () => {
    const { taken } = coverage();
    const gaps = [];
    for (const [engineId, engine] of Object.entries(ENGINES)) {
      for (const branch of engine.branches()) {
        if (branch.fixture) continue;
        if ((taken.get(`${engineId}.${branch.id}`) ?? []).length === 0) {
          gaps.push(`${engineId}.${branch.id} keys on ${branch.line}`);
        }
      }
    }
    expect(
      gaps,
      `\nThese parser branches are reached by no log in test/fixtures/real/:\n  ${gaps.join('\n  ')}\n`
        + 'Capture a real log for each, or declare it `fixture: \'blocked: <reason>\'` in the '
        + "parser's branch list so the gap is named.\n",
    ).toEqual([]);
  });

  it('names every blocked branch so the gap is visible', () => {
    const blocked = Object.entries(ENGINES).flatMap(([engineId, engine]) => engine.branches()
      .filter((branch) => branch.fixture)
      .map((branch) => `${engineId}.${branch.id}: ${branch.fixture}`));
    // Not a pass: the table above prints each of these as a GAP. What is checked
    // is that a gap carries a reason and a kind, never a silent exemption.
    expect(blocked.length).toBeGreaterThan(0);
    for (const line of blocked) expect(line).toMatch(/: (?:blocked|derived): \S/);
  });

  it('declares the engine versions each branch was written against', () => {
    for (const [engineId, engine] of Object.entries(ENGINES)) {
      const supported = engine.versions;
      expect(supported.length, `${engineId} declares no supported versions`).toBeGreaterThan(0);
      for (const branch of engine.branches()) {
        expect(typeof branch.id, `${engineId} branch id`).toBe('string');
        expect(branch.line, `${engineId}.${branch.id} must name the line it keys on`).toBeTruthy();
        expect(typeof branch.taken, `${engineId}.${branch.id} must expose a taken() predicate`).toBe('function');
        expect(
          Array.isArray(branch.versions) && branch.versions.length > 0,
          `${engineId}.${branch.id} must name the release(s) that print its line`,
        ).toBe(true);
        for (const version of branch.versions) {
          expect(
            supported,
            `${engineId}.${branch.id} claims version ${version}, which ${engineId} does not list `
              + `in its exported *_SUPPORTED_VERSIONS (${supported.join(', ')})`,
          ).toContain(version);
        }
      }
    }
  });

  it('gives every fixture folder a PROVENANCE.md naming engine, version and command', () => {
    const problems = [];
    for (const folder of coverage().folders) {
      const provenance = provenanceOf(folder);
      if (!provenance) {
        problems.push(`${folder}: no PROVENANCE.md`);
        continue;
      }
      const { fields } = provenance;
      const engineId = engineFor(folder);
      if (!engineId) {
        problems.push(`${folder}: folder name does not start with an engine`);
        continue;
      }
      for (const field of ['Engine', 'Version', 'Command']) {
        if (!fields[field]) problems.push(`${folder}: PROVENANCE.md has no \`| ${field} | … |\` row`);
      }
      if (fields.Engine && !ENGINES[engineId].name.test(fields.Engine)) {
        problems.push(`${folder}: PROVENANCE.md says engine "${fields.Engine}" but the folder is ${engineId}`);
      }
      if (fields.Version) {
        const version = majorMinor(fields.Version);
        if (!ENGINES[engineId].versions.includes(version)) {
          problems.push(
            `${folder}: PROVENANCE.md names ${fields.Version}, which ${engineId} does not list in `
              + `*_SUPPORTED_VERSIONS (${ENGINES[engineId].versions.join(', ')}). Read the release's `
              + 'output before trusting a parse of it, then add the version next to the regexes.',
          );
        }
      }
    }
    expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
  });

  it('names every flat fixture in the corpus README', () => {
    const readme = readFileSync(join(CORPUS, 'README.md'), 'utf8');
    const unnamed = coverage().fixtures
      .filter((fixture) => fixture.folder === null)
      .map((fixture) => fixture.rel)
      .filter((name) => !readmeMentions(name, readme));
    expect(
      unnamed,
      'every flat fixture needs a row (or a glob row) in test/fixtures/real/README.md so its '
        + 'provenance is recorded somewhere',
    ).toEqual([]);
  });
});

/**
 * Issue 176, requirement 4 — the mangled fixture.
 *
 * The fixture is derived in this test from the captured 1.11 MP2 log rather than
 * committed as a file: hand-written log text must never live under
 * `test/fixtures/real/`, and a mangled file would be indistinguishable from a
 * capture to anyone reading the corpus later. What is removed is exactly what a
 * Psi4 banner change would remove — the `DF-MP2 Energies` banner, the
 * `Total Energy =` row under it, and the `* MP2 total energy =` summary — which
 * leaves the `DF-SCS-MP2 Energies` banner as the only MP2-looking total.
 */
describe('a Psi4 log with only the SCS-MP2 banner (issue 176)', () => {
  const source = readFileSync(join(CORPUS, 'psi4-1.11-water-mp2/mp2.log'), 'utf8');

  function mangle(text) {
    const lines = text.split('\n');
    const kept = [];
    let dropNextTotal = false;
    for (const line of lines) {
      if (/={2,}>\s*DF-MP2 Energies\s*<=/.test(line)) {
        dropNextTotal = true;
        continue;
      }
      if (dropNextTotal && /^\s*Total Energy\s*=/.test(line)) {
        dropNextTotal = false;
        continue;
      }
      if (/^\s*\*?\s*MP2 total energy\s*=/.test(line)) continue;
      kept.push(line);
    }
    return kept.join('\n');
  }

  it('the mangled text really has lost the canonical banner and kept the SCS one', () => {
    const mangled = mangle(source);
    expect(mangled).not.toMatch(/DF-MP2 Energies/);
    expect(mangled).toMatch(/DF-SCS-MP2 Energies/);
    // The SCS total is still there: this is the number the old reader returned.
    expect(mangled).toMatch(/SCS Total Energy\s*=\s*-76\.1606279369433565/);
  });

  it('fails by naming the missing line instead of returning the SCS number', () => {
    const parsed = parsePsi4Output(mangle(source));
    // Not the SCS number, and not the SCF total that sits above it either.
    expect(parsed.finalEnergy.hartree).toBeNull();
    expect(parsed.finalEnergy.source).toBe('scs-mp2-only');
    expect(parsed.extras.finalEnergyError).toMatch(/DF-MP2 Energies/);
    expect(parsed.extras.finalEnergyError).toMatch(/MP2 Total Energy \(a\.u\.\)/);
  });

  it('still reports the canonical total when the banner is intact', () => {
    const parsed = parsePsi4Output(source);
    expect(parsed.finalEnergy.source).toBe('mp2');
    expect(parsed.finalEnergy.hartree).toBeCloseTo(-76.1644180801477404, 10);
    expect(parsed.extras.finalEnergyError).toBeNull();
  });
});
