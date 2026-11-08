import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Documentation guard for the scripting surface.
 *
 * The link checker in docs.test.js proves every relative target resolves. This
 * adds the part a link checker cannot see: the pages a scripting reader needs
 * are actually reachable from the guide, and the plugin contract documents
 * every key `registerEngine` validates. A spec key that never reaches
 * docs/ENGINE_PLUGIN.md is a key plugin authors cannot discover.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SCRIPTING = 'docs/SCRIPTING.md';
const PLUGIN = 'docs/ENGINE_PLUGIN.md';

describe('scripting documentation', () => {
  it('ships a scripting page and a plugin page', () => {
    expect(fs.existsSync(path.join(ROOT, SCRIPTING))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, PLUGIN))).toBe(true);
    expect(read(SCRIPTING)).toMatch(/^# \S/m);
    expect(read(PLUGIN)).toMatch(/^# \S/m);
  });

  it('is reachable from the guide index and the CLI page', () => {
    const index = read('docs/guide/README.md');
    const cli = read('docs/guide/cli.md');
    for (const target of ['../SCRIPTING.md', '../ENGINE_PLUGIN.md']) {
      expect(index, `guide index must link ${target}`).toContain(`(${target})`);
    }
    expect(cli).toContain('(../SCRIPTING.md)');
    expect(cli).toContain('(../ENGINE_PLUGIN.md)');
  });

  it('links the schema file and the Python client from the scripting page', () => {
    const text = read(SCRIPTING);
    expect(text).toContain('schemas/run-record.v1.schema.json');
    expect(text).toContain('clients/python/');
    expect(text).toContain('ncs export --json --schema-version');
    expect(text).toContain('CliError');
    expect(text).toContain('record-invalid');
    // The compatibility policy is part of the contract, not an afterthought.
    expect(text).toContain('Compatibility policy');
    expect(text).toContain('Major change');
    expect(text).toContain('Minor change');
  });

  it('documents every key registerEngine validates', () => {
    const doc = read(PLUGIN);
    const keys = [
      'id', 'extensions', 'buildArgv', 'parseOutput', 'gates',
      'label', 'capabilities', 'detect', 'toCanonical',
    ];
    const missing = keys.filter((key) => !doc.includes('`' + key + '`'));
    expect(missing).toEqual([]);
    expect(doc).toContain('EngineSpecError');
    expect(doc).toContain('No sandbox');
  });
});
