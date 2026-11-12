/**
 * Line handling for the output parsers.
 *
 * Splitting a 1 MB Gaussian log is one of the more expensive things a parse
 * does, and the document used to be split again inside every section reader
 * (eight or nine full splits per parse). The top-level parser now splits once
 * and hands each child parser an array of lines; every public entry still
 * accepts a plain string, so standalone callers and tests keep working.
 *
 * `toLines` deliberately returns an array unchanged rather than copying it:
 * callers below the top level must not re-split, and copying would give back
 * part of the allocation the split was meant to save.
 */

const LINE_BREAK = /\r\n|\n|\r/;

/** `string | string[]` → `string[]`. */
export function toLines(input) {
  return Array.isArray(input) ? input : String(input ?? '').split(LINE_BREAK);
}

/**
 * The whole document as one string, for the few readers that still need a
 * multi-line regex. An array is joined with `\n`; the readers using this only
 * match whitespace-tolerant patterns, so the original line ending does not
 * change the result.
 */
export function toText(input) {
  return Array.isArray(input) ? input.join('\n') : String(input ?? '');
}
