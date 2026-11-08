import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateGates, parseGaussianOutput } from '../src/shared/gaussianOutput.js';
import { parseXtbOutput } from '../src/shared/engines/xtb.js';
import { makeFixtureOutput } from '../src/shared/fixtureOutput.js';
import { resultsPanelHtml, installResultsView } from '../src/renderer/resultsView.js';

const coverageText = readFileSync(
  fileURLToPath(new URL('./fixtures/synthetic-parser-coverage.out', import.meta.url)),
  'utf8',
);
const lowModeText = readFileSync(
  fileURLToPath(new URL('./fixtures/synthetic-lowmode-freq.out', import.meta.url)),
  'utf8',
);
const gfnffText = readFileSync(
  fileURLToPath(new URL('./fixtures/xtb/water-gfnff.out', import.meta.url)),
  'utf8',
);

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function recordFor(parsed, overrides = {}) {
  return {
    id: '20261107-120000-abc123',
    status: 'completed',
    engine: 'gaussian',
    title: 'Synthetic coverage record',
    dryRun: false,
    inputName: 'coverage.gjf',
    outputName: 'coverage.out',
    outputSource: 'file',
    truncated: false,
    outputBytes: {
      size: coverageText.length,
      bytesRead: coverageText.length,
      truncated: false,
      windows: [],
    },
    inputSha256: HASH_A,
    outputSha256: HASH_B,
    app: { version: '0.1.0', commit: 'faf51fb' },
    provenance: {
      kind: 'calculation',
      method: {
        functional: 'B3LYP',
        basis: '6-31G(d)',
        dispersion: 'GD3BJ',
        solvation: null,
        grid: null,
        scf: null,
      },
      input: { name: 'coverage.gjf', bytes: 2048 },
      output: {
        name: 'coverage.out',
        source: 'file',
        bytes: coverageText.length,
        hashSource: 'file',
        sha256: HASH_B,
      },
    },
    startedAt: '2026-11-07T12:00:00.000Z',
    finishedAt: '2026-11-07T12:00:02.000Z',
    exitCode: 0,
    parsed,
    gates: evaluateGates(parsed, {
      expectedImaginary: 0,
      requireFrequency: true,
      requireThermochemistry: true,
      requireFinalEnergy: true,
    }),
    error: null,
    ...overrides,
  };
}

function field(html, name) {
  // Isolate one data-field value so assertions cannot accidentally match a
  // number from a different card. Find the element that owns the attribute
  // and read up to its own closing tag.
  const marker = `data-field="${name}">`;
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const openTagStart = html.lastIndexOf('<', start);
  const openTag = html.slice(openTagStart, start);
  const tag = openTag.match(/^<([a-z0-9]+)/i)?.[1] || 'span';
  const from = start + marker.length;
  const end = html.indexOf(`</${tag}>`, from);
  return end === -1 ? null : html.slice(from, end);
}

describe('results surface — complete record', () => {
  const parsed = parseGaussianOutput(coverageText);
  const html = resultsPanelHtml(recordFor(parsed));

  it('shows run status and the engine without mistaking the engine for the parsed banner', () => {
    expect(html).toContain('data-status="completed"');
    expect(html).toContain('data-engine="gaussian"');
    expect(field(html, 'status')).toContain('completed');
    expect(field(html, 'engine')).toBe('Gaussian 16');
    expect(html).toContain('data-role="run-status">completed');
    expect(html).toContain('data-role="gates-overall">gates pass');
  });

  it('shows the program banner and the route exactly as reported', () => {
    expect(field(html, 'program')).toBe('Gaussian 16, Revision C.01');
    expect(field(html, 'route')).toBe('#P B3LYP/6-31G(d) Opt Freq');
  });

  it('shows the final energy and its source in Hartree', () => {
    expect(field(html, 'final-energy')).toBe('-100.5000000000 Eh');
    expect(field(html, 'final-energy-source')).toBe('SCF');
    expect(field(html, 'scf-energy')).toBe('-100.5000000000 Eh');
    expect(field(html, 'scf-status')).toBe('converged');
  });

  it('shows E+ZPE, H and G from the parsed thermochemistry block', () => {
    expect(field(html, 'thermo-ezpe')).toBe('-100.4884480000 Eh');
    expect(field(html, 'thermo-h')).toBe('-100.4821960000 Eh');
    expect(field(html, 'thermo-g')).toBe('-100.5096700000 Eh');
    expect(field(html, 'thermo-conditions')).toBe('298.15 K · 1.00000 atm');
  });

  it('does not invent an entropy value when the S table was not printed', () => {
    // This fixture has E+ZPE/H/G but no E (Thermal)/CV/S table. A missing
    // entropy must stay missing rather than being computed or copied.
    expect(field(html, 'thermo-entropy')).toContain('not reported');
  });

  it('shows the imaginary count and the lowest modes', () => {
    expect(field(html, 'freq-count')).toBe('4');
    expect(field(html, 'freq-imaginary-count')).toBe('0');
    expect(field(html, 'freq-min-imaginary')).toContain('not reported');
    expect(field(html, 'freq-modes')).toContain('610.0');
    expect(field(html, 'freq-modes')).toContain('1580.0');
    expect(field(html, 'freq-modes')).toContain('3650.0');
    expect(field(html, 'freq-modes')).toContain('3760.0');
  });

  it('renders the population tables and dipole only because the parse carried them', () => {
    expect(html).toContain('Mulliken charges');
    expect(html).toContain('Löwdin charges');
    expect(html).toContain('Natural population analysis (NBO)');
    expect(html).toContain('ESP charges');
    expect(html).toContain('-0.120000');
    expect(html).toContain('Dipole moment');
    expect(html).toContain('0.1234');
    expect(html).toContain('4 atoms');
  });

  it('shows the T1 diagnostic and the resource record', () => {
    expect(field(html, 't1')).toBe('0.012345');
    expect(field(html, 'resources-nbasis')).toBe('34');
    expect(field(html, 'resources-basis-functions')).toBe('34');
    expect(field(html, 'resources-primitive-gaussians')).toBe('60');
    expect(field(html, 'resources-processors')).toBe('4');
    expect(field(html, 'resources-memory')).toBe('4GB');
    expect(field(html, 'resources-cpu-seconds')).toBe('1.2 s');
    expect(field(html, 'resources-elapsed-seconds')).toBe('1.5 s');
  });

  it('shows every gate, its result and its evidence', () => {
    expect(html).toContain('data-gate="Output complete" data-result="pass"');
    expect(html).toContain('data-gate="Normal termination" data-result="pass"');
    expect(html).toContain('data-gate="SCF record" data-result="pass"');
    expect(html).toContain('data-gate="Imaginary mode count" data-result="pass"');
    expect(html).toContain('data-gate="Frequency record" data-result="pass"');
    expect(html).toContain('data-gate="Thermochemistry record" data-result="pass"');
    expect(html).toContain('data-gate="Final energy record" data-result="pass"');
    expect(html).toContain('Normal termination of Gaussian');
    expect(html).toContain('expected 0, found 0');
    expect(html).toContain('4 modes');
  });

  it('puts every hash and app version in the collapsible provenance block', () => {
    expect(html).toContain('<details class="results-provenance">');
    expect(field(html, 'input-sha256')).toBe(`<code>${HASH_A}</code>`);
    expect(field(html, 'output-sha256')).toBe(`<code>${HASH_B}</code>`);
    expect(field(html, 'app-version')).toBe('0.1.0');
    expect(field(html, 'app-commit')).toBe('faf51fb');
    expect(field(html, 'provenance-kind')).toBe('calculation');
    expect(field(html, 'provenance-method')).toContain('B3LYP/6-31G(d)');
    expect(field(html, 'run-id')).toBe('20261107-120000-abc123');
  });

  it('does not label a calculation record as a fixture', () => {
    expect(html).toContain('data-fixture="false"');
    expect(html).not.toContain('data-role="fixture-badge"');
    expect(html).not.toContain('FIXTURE');
  });
});

describe('results surface — xTB GFN-FF', () => {
  const parsed = parseXtbOutput(gfnffText, {
    argv: ['water.xyz', '--gfnff', '--ohess', 'tight'],
    route: 'GFN-FF Opt Freq',
  });
  const html = resultsPanelHtml(recordFor(parsed, {
    engine: 'xtb',
    provenance: {
      kind: 'calculation',
      method: {
        hamiltonian: 'gfnff',
        optLevel: 'tight',
        dispersion: 'force field (built in)',
        solvation: null,
        argv: ['water.xyz', '--gfnff', '--ohess', 'tight'],
      },
      input: { name: 'water.xyz', bytes: 151 },
      output: { name: 'water.out', source: 'stdout', bytes: 1000, hashSource: 'file', sha256: HASH_B },
    },
    gates: evaluateGates(parsed, {
      requireFrequency: true,
      requireThermochemistry: true,
      requireFinalEnergy: true,
    }),
  }));

  it('labels the force-field energy and does not pretend it is an SCF result', () => {
    expect(field(html, 'final-energy')).toBe('-0.3276559634 Eh');
    expect(field(html, 'final-energy-source')).toBe('GFN-FF energy');
    expect(field(html, 'scf-energy')).toContain('not reported');
    expect(field(html, 'scf-status')).toContain('not applicable');
    expect(html).not.toContain('xTB SCC');
  });

  it('shows the xTB route recorded with the task', () => {
    expect(field(html, 'route')).toBe('GFN-FF Opt Freq');
  });
});

describe('results surface — entropy from a record that carries it', () => {
  it('shows the parsed total entropy with its unit', () => {
    const parsed = parseGaussianOutput(lowModeText);
    const html = resultsPanelHtml(recordFor(parsed));
    expect(parsed.thermochemistry.entropyCalPerMolK.total).toBeCloseTo(57.837, 6);
    expect(field(html, 'thermo-entropy')).toBe('57.837 cal mol⁻¹ K⁻¹');
    expect(field(html, 'thermo-ezpe')).toBe('-100.4884480000 Eh');
    expect(field(html, 'freq-count')).toBe('6');
  });
});

describe('results surface — fixture record', () => {
  const parsed = parseGaussianOutput(makeFixtureOutput());
  const html = resultsPanelHtml(recordFor(parsed, {
    status: 'completed',
    dryRun: true,
    title: 'Dry-run water fixture',
    provenance: {
      kind: 'fixture',
      method: { functional: 'B3LYP', basis: '6-31G(d)' },
      input: { name: 'fixture.gjf', bytes: 512 },
      output: { name: 'fixture.out', source: 'fixture', bytes: 700, sha256: HASH_B },
    },
  }));

  it('labels the run as a fixture in the header and in a banner', () => {
    expect(html).toContain('data-fixture="true"');
    expect(html).toContain('data-role="fixture-badge"');
    expect(html).toContain('>FIXTURE<');
    expect(html).toContain('data-role="fixture-banner"');
    expect(html).toContain('synthetic dry-run data, not a real calculation');
  });

  it('repeats the fixture warning next to the thermochemistry values', () => {
    expect(html).toContain('Thermochemistry: synthetic fixture output');
    expect(html).toContain('-76.0200000000 Eh');
  });

  it('does not claim a Gaussian build that the fixture output never printed', () => {
    expect(field(html, 'program')).toContain('not reported');
    expect(html).not.toContain('Revision C.01');
  });
});

describe('results surface — truncated parse', () => {
  const byteRange = {
    size: 5000,
    bytesRead: 1800,
    truncated: true,
    windows: [
      { name: 'head', start: 0, end: 900 },
      { name: 'tail', start: 4100, end: 5000 },
    ],
  };
  const parsed = parseGaussianOutput(coverageText, { truncated: true, byteRange });
  const gates = evaluateGates(parsed, { expectedImaginary: 0, requireFrequency: true });
  const html = resultsPanelHtml(recordFor(parsed, {
    status: 'needs-review',
    truncated: true,
    outputBytes: byteRange,
    gates,
  }));

  it('marks the parse as truncated above every value', () => {
    expect(parsed.complete).toBe(false);
    expect(gates.overall).toBe('unknown');
    expect(html).toContain('data-truncated="true"');
    expect(html).toContain('data-role="truncated-badge"');
    expect(html).toContain('>TRUNCATED<');
    expect(html).toContain('data-role="truncation-banner"');
    expect(html).toContain('1800 of 5000 bytes (head + tail)');
    expect(html).toContain('no gate can pass on a partial parse');
  });

  it('keeps the parsed numbers but warns that they may be partial', () => {
    expect(field(html, 'final-energy')).toBe('-100.5000000000 Eh');
    expect(html).toContain('Thermochemistry: partial parse');
    expect(html).toContain('The frequency summary: partial parse');
  });

  it('shows the completeness gate as unknown with its byte evidence', () => {
    expect(field(html, 'gate-overall')).toBe('unknown');
    expect(html).toContain('data-gate="Output complete" data-result="unknown"');
    expect(html).toContain('read 1800 of 5000 bytes (head+tail)');
  });
});

describe('results surface — missing fields', () => {
  it('renders "not reported" instead of undefined, null, NaN or a guess', () => {
    const html = resultsPanelHtml({
      id: 'bare-run',
      status: 'failed',
      engine: 'gaussian',
      parsed: null,
      gates: null,
    });
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('[object Object]');
    expect(html).not.toContain('null');
    expect(html).toMatch(/data-field="final-energy"><span class="results-missing">not reported<\/span>/);
    expect(html).toMatch(/data-field="thermo-ezpe"><span class="results-missing">not reported<\/span>/);
    expect(html).toMatch(/data-field="t1">not reported<\/p>/);
    expect(html).toContain('not reported — no gate record was saved for this run.');
  });

  it('does not fill E+ZPE from the SCF energy or from a correction', () => {
    const html = resultsPanelHtml({
      status: 'completed',
      parsed: {
        scf: { energyHartree: -76.4 },
        finalEnergy: { hartree: null, source: null },
        thermochemistry: {
          freeEnergyHartree: -76.2,
          zeroPointCorrectionHartree: 0.02,
        },
      },
    });
    expect(field(html, 'final-energy')).toContain('not reported');
    expect(field(html, 'thermo-ezpe')).toContain('not reported');
    expect(field(html, 'thermo-h')).toContain('not reported');
    expect(field(html, 'thermo-g')).toBe('-76.2000000000 Eh');
    expect(field(html, 'scf-energy')).toBe('-76.4000000000 Eh');
  });

  it('renders a friendly empty state when no record is selected', () => {
    expect(resultsPanelHtml(null)).toContain('Select a completed run');
    expect(resultsPanelHtml(undefined)).toContain('Select a completed run');
  });

  it('does not require a DOM to import the module', () => {
    // The renderer module is imported by app.js; tests and the check script
    // load it in Node. Installation is the only DOM-aware entry point.
    expect(installResultsView()).toBeNull();
  });
});

describe('results surface — gate statuses', () => {
  it('shows pass, fail and unknown with their evidence and class names', () => {
    const html = resultsPanelHtml({
      status: 'needs-review',
      engine: 'xtb',
      parsed: { finalEnergy: { hartree: -10.5, source: 'scc' } },
      gates: {
        overall: 'unknown',
        complete: false,
        gates: [
          { name: 'Normal termination', required: true, result: 'pass', detail: 'normal termination of xtb' },
          { name: 'Imaginary magnitude', required: true, result: 'fail', detail: '42.0 cm^-1 (floor 50)' },
          { name: 'Output complete', required: true, result: 'unknown', detail: 'read 1800 of 5000 bytes (head+tail)' },
          { name: 'Frequency record', required: false, result: 'pass', detail: null },
        ],
      },
    });
    expect(html).toContain('data-gate="Normal termination" data-result="pass"');
    expect(html).toContain('data-gate="Imaginary magnitude" data-result="fail"');
    expect(html).toContain('data-gate="Output complete" data-result="unknown"');
    expect(html).toContain('class="results-gate is-pass">pass');
    expect(html).toContain('class="results-gate is-fail">fail');
    expect(html).toContain('class="results-gate is-unknown">unknown');
    expect(html).toContain('42.0 cm^-1 (floor 50)');
    expect(html).toContain('read 1800 of 5000 bytes (head+tail)');
    expect(field(html, 'gate-overall')).toBe('unknown');
    // A gate with no evidence is not given invented evidence.
    expect(html).toContain('data-gate="Frequency record" data-result="pass"');
    expect(html).toContain('optional');
    expect(html).toContain('>not reported<');
  });

  it('never dresses an unrecognised gate result up as a pass', () => {
    const html = resultsPanelHtml({
      status: 'completed',
      gates: { overall: 'maybe', gates: [{ name: 'Odd gate', required: true, result: 'maybe', detail: null }] },
    });
    expect(html).not.toContain('data-result="maybe"');
    expect(html).not.toContain('is-maybe');
    expect(html).toContain('data-gate="Odd gate" data-result="unknown"');
    expect(field(html, 'gate-overall')).toBe('unknown');
  });
});

describe('results surface — error termination', () => {
  it('shows the actionable cause and the termination line', () => {
    const errorText = readFileSync(
      fileURLToPath(new URL('./fixtures/synthetic-error-termination.out', import.meta.url)),
      'utf8',
    );
    const parsed = parseGaussianOutput(errorText);
    const html = resultsPanelHtml(recordFor(parsed, { status: 'failed' }));
    expect(parsed.status).toBe('error');
    expect(field(html, 'error-cause')).toBe('Convergence failure -- run terminated.');
    expect(field(html, 'error-termination')).toContain('Error termination via Lnk1e');
    expect(field(html, 'error-lines')).toContain('Convergence criterion not met.');
    expect(html).toContain('data-gate="Normal termination" data-result="fail"');
  });

  it('adds an offline explanation when a signature matches', () => {
    const errorText = readFileSync(
      fileURLToPath(new URL('./fixtures/synthetic-error-termination.out', import.meta.url)),
      'utf8',
    );
    const html = resultsPanelHtml(recordFor(parseGaussianOutput(errorText), { status: 'failed' }));
    expect(html).toContain('data-field="error-explanation"');
    expect(html).toContain('data-signature="scf-convergence-short"');
    expect(html).toContain('Next step:');
    expect(html).toContain('SCF did not converge');
  });

  it('says so when no signature matches instead of guessing', () => {
    const html = resultsPanelHtml({
      status: 'failed',
      engine: 'gaussian',
      parsed: {
        status: 'error',
        errorTermination: {
          cause: 'Something nobody has catalogued yet.',
          terminationLine: 'Error termination via Lnk1e',
          lines: ['Something nobody has catalogued yet.'],
        },
      },
    });
    expect(field(html, 'error-explanation')).toContain('No known signature matched');
    expect(html).not.toContain('Next step:');
  });
});

describe('results surface — HTML escaping', () => {
  const html = resultsPanelHtml({
    id: 'run-<b>1</b>',
    status: 'failed',
    engine: 'gaussian',
    title: '<img src=x onerror="alert(1)">',
    app: { version: '<script>v</script>', commit: '<img>' },
    provenance: {
      kind: 'calculation',
      input: { name: '<bad>.gjf', bytes: 10 },
      output: { name: '<bad>.out', source: '<file>' },
    },
    parsed: {
      route: '#p <script>alert(1)</script>',
      program: { name: '<script>', version: '16', revision: '<b>C.01</b>' },
      finalEnergy: { hartree: -1, source: 'scf' },
      errorTermination: {
        cause: '<svg onload=alert(1)>',
        terminationLine: 'Error termination <x>',
        lines: ['<b>line</b>'],
      },
      charges: {
        mulliken: [{ atom: 1, element: '<i>C</i>', charge: -0.1 }],
      },
    },
    gates: {
      overall: 'pass',
      gates: [{ name: '<b>Gate</b>', required: true, result: 'pass', detail: '" onmouseover="alert(1)' }],
    },
  });

  it('escapes text and attribute contexts from the record', () => {
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<svg onload');
    expect(html).not.toContain('<b>Gate</b>');
    expect(html).not.toContain('<i>C</i>');
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;svg onload=alert(1)&gt;');
    expect(html).toContain('data-gate="&lt;b&gt;Gate&lt;/b&gt;"');
    expect(html).toContain('&quot; onmouseover=&quot;alert(1)');
    expect(html).toContain('&lt;i&gt;C&lt;/i&gt;');
  });
});
