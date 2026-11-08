/**
 * Diagnostics bundle builder.
 *
 * Why this exists: a bug report needs the version, commit, OS, engine choice
 * and recent run records all at once. Asking a user to assemble that by hand
 * produces partial reports, so the app writes one markdown file they can attach.
 *
 * Pure module: no filesystem, no Electron, no window, no clock. The caller
 * supplies `generatedAt`, which keeps the output deterministic and testable.
 *
 * Privacy rules, in order of application:
 *   1. the OS home directory becomes `~`, the application data directory
 *      becomes `<userData>` (the caller supplies both, already known to it);
 *   2. any remaining home-style path (`/home/x`, `/Users/x`, `C:\Users\x`)
 *      loses the user segment;
 *   3. any other absolute path is reduced to `<path>/basename`, so a bug report
 *      never publishes where a user keeps their files;
 *   4. credentials and variable assignments are replaced with `<redacted>`.
 *
 * Only whitelisted record fields are read. Molecule coordinates, atom lists,
 * output file contents, variable dumps and machine names are never accepted as
 * input in the first place, so they cannot leak by accident.
 *
 * Honest absence: a field the caller did not record renders as `not recorded`.
 * It is never replaced with a plausible default or a zero, because a zero is a
 * measurement and "unknown" is not.
 */

export const NOT_RECORDED = 'not recorded';
export const MAX_RUNS = 10;
export const MAX_MARKDOWN_BYTES = 64 * 1024;
export const SCHEMA_ID = 'nodechem-diagnostics/1';

const MAX_FIELD_CHARS = 240;
const MAX_TITLE_CHARS = 160;
const MAX_NAME_CHARS = 200;
const TRUNCATION_RESERVE_BYTES = 256;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function present(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  return true;
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace a known path only at a path boundary, so `/home/x` never edits `/home/xyz`. */
function replaceKnownPath(text, needle, replacement) {
  if (!present(needle)) return text;
  const trimmed = String(needle).replace(/[\\/]+$/, '');
  if (!trimmed || trimmed === '/' || /^[A-Za-z]:$/.test(trimmed)) return text;
  const pattern = new RegExp(`${escapeRegExp(trimmed)}(?![\\w.-])`, 'gi');
  return text.replace(pattern, replacement);
}

function basenameOf(target) {
  const parts = String(target).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : NOT_RECORDED;
}

/**
 * Remove direct identifiers from one free-text value. This runs on titles and
 * error messages because those come from user and engine input, not just from
 * paths the caller told us about.
 */
function sanitiseText(value, context, { maskAddresses = true } = {}) {
  let text = String(value);
  // 1. Known locations first: userData usually lives inside home, so it must
  //    win before home collapses the prefix.
  text = replaceKnownPath(text, context.userData, '<userData>');
  text = replaceKnownPath(text, context.home, '~');
  // 2. Home-style paths for platforms whose home directory we were not told.
  text = text.replace(/(^|[\s("'`=:,\[])\/(?:home|Users)\/[^/\s"'`)\],;]+/g, '$1~');
  text = text.replace(/(^|[\s("'`=:,\[])([A-Za-z]:[\\/]Users[\\/])[^\\/\s"'`)\],;]+/gi, '$1~');
  // 3. Anything still absolute keeps only its basename. Bug reports need the
  //    executable name, not the folder layout of a stranger's machine.
  text = text.replace(/(^|[\s("'`=:,\[])(\/(?!\/)[^\s"'`)\],;]+)/g, (_match, lead, target) => (
    `${lead}<path>/${basenameOf(target)}`
  ));
  text = text.replace(/(^|[\s("'`=:,\[])([A-Za-z]:[\\/][^\s"'`)\],;]+)/g, (_match, lead, target) => (
    `${lead}<path>\\${basenameOf(target)}`
  ));
  // UNC paths carry a server name, so they are reduced to their basename too.
  text = text.replace(/(^|[\s("'`=:,\[])(\\\\[^\s"'`)\],;]+)/g, (_match, lead, target) => (
    `${lead}<path>\\${basenameOf(target)}`
  ));
  // 4. Credentials and addresses that a wrapped error message could have
  //    echoed. Public and private IPv4 ranges are both removed: the bundle
  //    describes an app, not a network. Version fields opt out below, because
  //    a Chrome version such as 140.0.0.0 has the same shape as an address.
  if (maskAddresses) {
    text = text.replace(/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, '<address>');
    text = text.replace(/\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi, '<address>');
    text = text.replace(/\b(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4})?\b/gi, '<address>');
    text = text.replace(/\b::1\b/g, '<address>');
  }
  text = text.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>');
  text = text.replace(/\b(?:sk|ghp|gho|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/gi, '<redacted>');
  // Prefixed names first (`API_TOKEN=`, `DB_PASSWORD=`), then bare ones
  // (`token=`, `secret:`), which the prefix form cannot match because `_` and a
  // letter are both word characters and therefore have no `\b` between them.
  text = text.replace(/\b([A-Za-z][A-Za-z0-9_]*?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD))\s*[:=]\s*\S+/gi, '$1=<redacted>');
  text = text.replace(/\b(key|token|secret|password|passwd|pwd|auth)\s*[:=]\s*\S+/gi, '$1=<redacted>');
  return text;
}

function oneLine(text) {
  return String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanValue(value, context, maxChars = MAX_FIELD_CHARS, options = {}) {
  if (!present(value)) return null;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  const cleaned = oneLine(sanitiseText(value, context, options));
  if (!cleaned) return null;
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned;
}

function cleanNumber(value) {
  return positiveNumber(value);
}

function markdownValue(value) {
  return present(value) ? String(value) : NOT_RECORDED;
}

function codeSpan(value) {
  return `\`${String(value).replace(/`/g, "'")}\``;
}

function tableCell(value) {
  return present(value) ? String(value).replace(/\|/g, '\\|') : NOT_RECORDED;
}

function utf8Bytes(text) {
  return new TextEncoder().encode(text).length;
}

function isoOrNull(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function normaliseRun(run, context) {
  const record = isObject(run) ? run : {};
  const gates = isObject(record.gates) ? record.gates : null;
  const provenance = isObject(record.provenance) ? record.provenance : null;
  const gateVerdict = present(record.gateVerdict)
    ? cleanValue(record.gateVerdict, context, 40)
    : gates && present(gates.overall) ? cleanValue(gates.overall, context, 40) : null;
  const mode = provenance && present(provenance.kind)
    ? cleanValue(provenance.kind, context, 40)
    : typeof record.dryRun === 'boolean' ? (record.dryRun ? 'dry run' : 'calculation') : null;
  return {
    id: cleanValue(record.id, context, 80),
    title: cleanValue(record.title, context, MAX_TITLE_CHARS),
    status: cleanValue(record.status, context, 40),
    engine: cleanValue(record.engine, context, 40),
    mode,
    startedAt: cleanValue(record.startedAt, context, 40),
    finishedAt: cleanValue(record.finishedAt, context, 40),
    gateVerdict,
    error: cleanValue(record.error, context, MAX_FIELD_CHARS),
  };
}

function normaliseProject(project, context) {
  if (!isObject(project)) return null;
  const defaults = isObject(project.defaults) ? project.defaults : {};
  const read = (key, max = MAX_FIELD_CHARS) => cleanValue(defaults[key], context, max);
  return {
    name: cleanValue(project.name, context, MAX_NAME_CHARS),
    blockCount: cleanNumber(project.blockCount ?? project.blocks),
    edgeCount: cleanNumber(project.edgeCount ?? project.edges),
    validationErrors: cleanNumber(project.validationErrors),
    engine: read('engine', 40),
    method: read('method'),
    basis: read('basis'),
    xtbMethod: read('xtbMethod', 40),
    xtbOptLevel: read('xtbOptLevel', 40),
    memory: read('memory', 20),
    memoryUnit: read('memoryUnit', 10),
    nproc: read('nproc', 20),
  };
}

function normaliseEngines(engines, context) {
  const list = Array.isArray(engines)
    ? engines
    : isObject(engines) ? Object.values(engines) : null;
  if (list === null) return null;
  return list.map((engine) => {
    const item = isObject(engine) ? engine : {};
    const capabilities = isObject(item.capabilities) ? item.capabilities : {};
    return {
      id: cleanValue(item.id, context, 40),
      label: cleanValue(item.label, context, 80),
      inputExtension: cleanValue(item.inputExtension ?? capabilities.inputExtension, context, 20),
      outputExtension: cleanValue(item.outputExtension ?? capabilities.outputExtension, context, 20),
      restartArtifact: cleanValue(item.restartArtifact ?? capabilities.restartArtifact, context, 20),
    };
  });
}

function renderEngines(engines) {
  if (engines === null) return [`Engines: ${NOT_RECORDED}.`];
  if (engines.length === 0) return ['No engines are registered in this build.'];
  const rows = engines.map((engine) => {
    const cells = [
      tableCell(engine.label),
      codeSpan(markdownValue(engine.id)),
      tableCell(engine.inputExtension),
      tableCell(engine.outputExtension),
      tableCell(engine.restartArtifact),
    ];
    return `| ${cells.join(' | ')} |`;
  });
  return [
    'Registered engines in this build; executable paths are not probed by this offline bundle.',
    '',
    '| Engine | Id | Input | Output | Restart artifact |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ];
}

function renderProject(project) {
  if (project === null) return [`Project summary: ${NOT_RECORDED}.`];
  const lines = [
    `- Name: ${markdownValue(project.name)}`,
    `- Blocks: ${markdownValue(project.blockCount)}`,
    `- Connections: ${markdownValue(project.edgeCount)}`,
    `- Validation errors: ${markdownValue(project.validationErrors)}`,
    `- Engine: ${markdownValue(project.engine)}`,
  ];
  // xTB and Gaussian record different method vocabularies; only show the pair
  // that belongs to the selected engine, and show "not recorded" rather than
  // borrowing the other engine's defaults.
  if (project.engine === 'xtb') {
    lines.push(`- xTB Hamiltonian: ${markdownValue(project.xtbMethod)}`);
    lines.push(`- xTB optimisation: ${markdownValue(project.xtbOptLevel)}`);
  } else {
    lines.push(`- Method: ${markdownValue(project.method)}`);
    lines.push(`- Basis: ${markdownValue(project.basis)}`);
  }
  // Only compose a resources line when at least one part was recorded; three
  // "not recorded" fragments read worse than one honest statement.
  const memoryLine = present(project.memory)
    ? `${project.memory}${present(project.memoryUnit) ? ` ${project.memoryUnit}` : ''}`
    : null;
  const coresLine = present(project.nproc) ? `${project.nproc} cores` : null;
  const resources = [memoryLine, coresLine].filter(Boolean);
  lines.push(`- Resources: ${resources.length ? resources.join(' · ') : NOT_RECORDED}`);
  return lines;
}

function renderRun(run, index) {
  const heading = `${index + 1}. ${codeSpan(markdownValue(run.id))} — ${markdownValue(run.status)}`;
  return [
    `### ${heading}`,
    `- Title: ${markdownValue(run.title)}`,
    `- Engine: ${markdownValue(run.engine)}`,
    `- Mode: ${markdownValue(run.mode)}`,
    `- Started: ${markdownValue(run.startedAt)}`,
    `- Finished: ${markdownValue(run.finishedAt)}`,
    `- Gates: ${markdownValue(run.gateVerdict)}`,
    `- Error: ${markdownValue(run.error)}`,
  ];
}

function capMarkdown(markdown) {
  const totalBytes = utf8Bytes(markdown);
  if (totalBytes <= MAX_MARKDOWN_BYTES) {
    return { text: markdown, truncated: false, omittedBytes: 0 };
  }
  // Find the largest character prefix that leaves room for the notice, then
  // cut at a line boundary so the file does not end mid-sentence.
  let low = 0;
  let high = markdown.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8Bytes(markdown.slice(0, mid)) <= MAX_MARKDOWN_BYTES - TRUNCATION_RESERVE_BYTES) low = mid;
    else high = mid - 1;
  }
  let cut = markdown.slice(0, low);
  const breakAt = cut.lastIndexOf('\n');
  if (breakAt > 0) cut = cut.slice(0, breakAt);
  for (;;) {
    const omittedBytes = totalBytes - utf8Bytes(cut);
    const limitKb = Math.round(MAX_MARKDOWN_BYTES / 1024);
    const notice = `\n\n> Report truncated: the ${limitKb} KB limit was reached; ${omittedBytes} bytes were omitted.\n`;
    const candidate = `${cut}${notice}`;
    if (utf8Bytes(candidate) <= MAX_MARKDOWN_BYTES || cut.length === 0) {
      return { text: candidate, truncated: true, omittedBytes };
    }
    cut = cut.slice(0, Math.max(0, cut.length - 128));
    const nextBreak = cut.lastIndexOf('\n');
    if (nextBreak > 0) cut = cut.slice(0, nextBreak);
  }
}

/**
 * Build a redacted diagnostics bundle.
 *
 * @param {object} input
 * @param {object} [input.app]        version, commit, electron, node, chrome
 * @param {object} [input.platform]   os, release, arch, home, userData
 * @param {Array}  [input.engines]    {id, label, inputExtension, outputExtension, restartArtifact}
 * @param {Array}  [input.runs]       run.json records, newest first
 * @param {object} [input.project]    {name, blockCount, edgeCount, validationErrors, defaults}
 * @param {string|Date} [input.generatedAt]
 * @returns {{markdown: string, json: object}}
 */
export function buildDiagnostics(input = {}) {
  const source = isObject(input) ? input : {};
  const app = isObject(source.app) ? source.app : {};
  const platform = isObject(source.platform) ? source.platform : {};
  const context = {
    home: present(platform.home) ? String(platform.home) : '',
    userData: present(platform.userData) ? String(platform.userData) : '',
  };
  const generatedAtRaw = isoOrNull(source.generatedAt);
  // Even the timestamp goes through the redactor: callers are external code,
  // and a malformed value must not become an un-redacted path in the bundle.
  const generatedAt = generatedAtRaw === null ? null : oneLine(sanitiseText(generatedAtRaw, context));

  const appRecord = {
    version: cleanValue(app.version, context, 40, { maskAddresses: false }),
    commit: cleanValue(app.commit, context, 80),
    electron: cleanValue(app.electron, context, 40, { maskAddresses: false }),
    node: cleanValue(app.node, context, 40, { maskAddresses: false }),
    chrome: cleanValue(app.chrome, context, 40, { maskAddresses: false }),
  };
  const platformRecord = {
    os: cleanValue(platform.os, context, 80),
    release: cleanValue(platform.release, context, 80),
    arch: cleanValue(platform.arch, context, 40),
    home: context.home ? '~' : null,
    userData: context.userData ? '<userData>' : null,
  };
  const engines = normaliseEngines(source.engines, context);
  const project = normaliseProject(source.project, context);

  const runsKnown = Array.isArray(source.runs);
  const allRuns = runsKnown ? source.runs : [];
  const included = allRuns.slice(0, MAX_RUNS).map((run) => normaliseRun(run, context));
  const runsOmitted = runsKnown ? Math.max(0, allRuns.length - MAX_RUNS) : null;

  const lines = [
    '# NodeChem Studio diagnostics',
    '',
    `Generated: ${markdownValue(generatedAt)}`,
    `Format: ${SCHEMA_ID}`,
    '',
    '## Application',
    `- Version: ${markdownValue(appRecord.version)}`,
    `- Commit: ${markdownValue(appRecord.commit)}`,
    `- Electron: ${markdownValue(appRecord.electron)}`,
    `- Node: ${markdownValue(appRecord.node)}`,
    `- Chrome: ${markdownValue(appRecord.chrome)}`,
    '',
    '## Platform',
    `- OS: ${markdownValue(platformRecord.os)}`,
    `- Release: ${markdownValue(platformRecord.release)}`,
    `- Architecture: ${markdownValue(platformRecord.arch)}`,
    `- Home folder: ${markdownValue(platformRecord.home)}`,
    `- Application data: ${platformRecord.userData ? codeSpan(platformRecord.userData) : NOT_RECORDED}`,
    '',
    '## Engines',
    ...renderEngines(engines),
    '',
    '## Project',
    ...renderProject(project),
    '',
    '## Recent runs',
  ];

  if (!runsKnown) {
    lines.push(`Runs: ${NOT_RECORDED}.`);
  } else if (allRuns.length === 0) {
    lines.push('No runs have been recorded.');
  } else {
    if (runsOmitted > 0) {
      lines.push(`Showing ${included.length} of ${allRuns.length} recorded runs; ${runsOmitted} older runs are not included.`);
      lines.push('');
    }
    included.forEach((run, index) => {
      lines.push(...renderRun(run, index));
      if (index < included.length - 1) lines.push('');
    });
  }

  lines.push(
    '',
    '## Redaction',
    '- Home folder is written as `~`; the application data folder is written as `<userData>` (when the platform reported them).',
    '- Other absolute paths are reduced to `<path>/<name>`; home-style paths lose the user segment.',
    '- Credential-shaped strings, variable assignments and network addresses are replaced with `<redacted>` or `<address>`.',
    '- Excluded by construction: molecule coordinates, atom lists, file contents, variable dumps, machine names.',
    '',
  );

  const capped = capMarkdown(lines.join('\n'));
  const json = {
    schema: SCHEMA_ID,
    generatedAt,
    app: appRecord,
    platform: platformRecord,
    engines,
    project,
    runs: runsKnown ? included : null,
    truncation: {
      runsOmitted,
      markdownTruncated: capped.truncated,
      markdownBytesOmitted: capped.omittedBytes,
    },
  };

  return { markdown: capped.text, json };
}
