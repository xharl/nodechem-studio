/**
 * Run provenance flags shared by the results surface and the workflow report.
 *
 * A fixture (dry run) and a partial parse are facts about the run, not
 * presentation choices. Both documents derive them from the same fields, so a
 * badge on screen and a badge in the report cannot disagree about whether a
 * value came from the whole log.
 */

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Derive the provenance flags from every field that can carry the fact, so an
 * older or partially written record cannot silently look complete.
 *
 * The parser's own `truncated` flag is authoritative: a windowed read covers
 * the file without reading every byte, so `bytesRead < size` alone is not
 * evidence of a partial parse. It is the fallback only when the record does not
 * explicitly say `truncated: false`.
 */
export function runFlagsFor(record) {
  const provenance = isObject(record?.provenance) ? record.provenance : {};
  const bytes = isObject(record?.outputBytes) ? record.outputBytes : null;
  const parsed = isObject(record?.parsed) ? record.parsed : {};
  const size = finite(bytes?.size);
  const bytesRead = finite(bytes?.bytesRead);
  const fixture = record?.dryRun === true || provenance.kind === 'fixture';
  const truncated = record?.truncated === true
    || parsed.complete === false
    || bytes?.truncated === true
    || (bytes?.truncated !== false && size !== null && bytesRead !== null && bytesRead < size);
  return { fixture, truncated, bytes };
}

/**
 * The byte window a partial read covered, as the report model carries it:
 * the bytes read, the file size when known, and the named windows the reader
 * supplied (for example `head` + `tail`). Empty values stay `null`, never zero.
 */
export function outputWindow(bytes) {
  if (!isObject(bytes)) return { bytesRead: null, size: null, windows: [] };
  const windows = Array.isArray(bytes.windows)
    ? bytes.windows
      .map((entry) => (typeof entry?.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : null))
      .filter(Boolean)
    : [];
  return {
    bytesRead: finite(bytes.bytesRead),
    size: finite(bytes.size),
    windows,
  };
}
