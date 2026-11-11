/**
 * The version a program states about itself.
 *
 * Issue 314: the Settings window printed the first non-empty line of
 * `--version`, which for xTB is a 59-character rule and for ORCA is ASCII art.
 * A rule rendered as `version ---------------` reads as a broken detector, so
 * the probe now searches for the token a version is printed with and returns
 * nothing when the output carries none — the UI then says *unknown* instead of
 * showing a fragment of a banner.
 *
 * Pure module: no filesystem, no child_process, no Electron.
 */

/** A version token: a digit, then letters/digits/dots and the usual separators. */
const VERSION_TOKEN = '([0-9][0-9A-Za-z._+-]*)';

/**
 * In priority order:
 *   1. the word "version" followed by the token — xTB ("xtb version 6.8.0"),
 *      ORCA ("Version 6.1.1 - RELEASE"), Multiwfn ("Version 3.8(dev)"),
 *      Gaussian ("Gaussian 16 Rev C.01" has no "version" word, so rule 3),
 *   2. a line that is only a version — Psi4 prints `1.11`,
 *   3. "Rev"/"Release" followed by an identifier — Gaussian's banner style.
 */
const RULES = [
  new RegExp(`\\bversion\\s+v?${VERSION_TOKEN}`, 'i'),
  new RegExp(`^[ \\t]*v?${VERSION_TOKEN}[ \\t]*$`, 'im'),
  new RegExp(`\\b(?:Rev\\.?|Release)\\s+${VERSION_TOKEN}`, 'i'),
];

/** A line made only of punctuation is a frame around a banner, not data. */
function isRuleLine(line) {
  return /^[-=*#~_+·.\s]+$/.test(line);
}

/** Strip trailing separators a sentence put after the token. */
function cleanToken(token) {
  return String(token || '').replace(/[._+-]+$/, '');
}

/**
 * The first line that carries a digit run, as a last resort.
 *
 * A program that prints its version without the word "version" and without it
 * alone on a line still tends to print it on a short line ("pyscf 2.15.0",
 * "python 3.13.9"). Whole banner frames are skipped by `isRuleLine`.
 */
function firstDigitLine(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || isRuleLine(trimmed)) continue;
    if (!/[0-9]/.test(trimmed)) continue;
    return trimmed.slice(0, 160);
  }
  return '';
}

/**
 * The version stated in `text` (stdout and stderr joined), or '' when the
 * output states none. Never a banner fragment.
 */
export function parseToolVersion(text) {
  const value = String(text ?? '');
  if (!value.trim()) return '';
  for (const rule of RULES) {
    const match = value.match(rule);
    const token = match ? cleanToken(match[1]) : '';
    if (token) return token;
  }
  return firstDigitLine(value);
}
