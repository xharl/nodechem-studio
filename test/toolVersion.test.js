import { describe, expect, it } from 'vitest';

import { parseToolVersion } from '../src/shared/toolVersion.js';

/**
 * Issue 314 — the Settings window printed the first line of `--version`, so
 * xTB's 59-character rule and ORCA's ASCII art were rendered as the version.
 * The banners below are the shapes those programs print; what matters is the
 * token the parser returns, and that a banner with no version token returns
 * nothing at all rather than a fragment.
 */

// `xtb --version` opens with a rule, then a title block, then the real line
// several lines down (xTB 6.8.0 on the reporting machine).
const XTB = [
  '      -----------------------------------------------------------',
  '                  xTB - An Extended Tight-Binding Quantum Chemistry',
  '      -----------------------------------------------------------',
  '',
  '      xtb version 6.8.0 (edcf3dd) compiled by \'conda\' on 2025-06-02',
  '',
  '      Cite: C. Bannwarth, E. Caldeweyher, S. Ehlert, A. Hansen,',
  '',
].join('\n');

// `orca --version`: banner art, no version until the last lines.
const ORCA = [
  '',
  '                                 *****************',
  '                                 * O   R   C   A *',
  '                                 *****************',
  '',
  '           --- An Ab Initio, DFT and Semiempirical electronic structure package ---',
  '',
  '                  #######################################################',
  '                  #                        -***-                        #',
  '                  #          Department of theory and spectroscopy      #',
  '                  #######################################################',
  '',
  'Direct, parallel, single-locality (DOLLY)',
  'Parallel, single-locality (POLLY)',
  'Sequential (SEQ)',
  'Version 6.1.1 - RELEASE',
  '',
].join('\n');

// Psi4 prints the bare number and nothing else.
const PSI4 = '1.11\n';

// Multiwfn answers with its title and a "Version 3.8(dev)" line.
const MULTIWFN = [
  ' Multiwfn -- A Multifunctional Wavefunction Analyzer',
  ' Version 3.8(dev), release date: 2024-May-17',
  '',
].join('\n');

describe('tool version parsing (issue 314)', () => {
  it('reads the version line out of the xTB banner instead of its first rule', () => {
    expect(parseToolVersion(XTB)).toBe('6.8.0');
  });

  it('reads ORCA’s version past its ASCII art', () => {
    expect(parseToolVersion(ORCA)).toBe('6.1.1');
  });

  it('keeps working for a program that prints only the number', () => {
    expect(parseToolVersion(PSI4)).toBe('1.11');
  });

  it('stops at the token rather than the annotation after it', () => {
    expect(parseToolVersion(MULTIWFN)).toBe('3.8');
  });

  it('falls back to a line that carries a digit run', () => {
    // Gaussian states its revision without the word "version".
    expect(parseToolVersion('Gaussian 16 Rev C.01\n')).toBe('Gaussian 16 Rev C.01');
    expect(parseToolVersion('pyscf 2.15.0\n')).toBe('pyscf 2.15.0');
  });

  it('returns nothing when the output carries no version, never a banner line', () => {
    for (const banner of [
      '-----------------------------------------------------------\n',
      '*****************\n* O   R   C   A *\n*****************\n',
      '',
      '   \n',
    ]) {
      expect(parseToolVersion(banner), JSON.stringify(banner)).toBe('');
    }
  });

  it('does not mistake a rule or art line for a version', () => {
    const artOnly = [
      '#######################################################',
      '#                        -***-                        #',
      '=======================================================',
    ].join('\n');
    expect(parseToolVersion(artOnly)).toBe('');
  });
});
