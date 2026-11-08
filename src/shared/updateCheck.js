/**
 * Update notice logic (issue #82).
 *
 * Why this module exists: an install that never learns a newer release exists
 * is a trap for a preview product. It is deliberately not an updater — nothing
 * is downloaded, nothing is installed, and there is no network code here. The
 * main process asks GitHub for the published release list only when the user
 * asks for it; this module decides, from the version stamped into the build and
 * that list, whether there is anything worth telling the user about.
 *
 * Rules, in the order they are applied:
 *   1. drafts are never offered;
 *   2. a tag may carry a leading `v` (`v0.4.0`) or not (`0.4.0`);
 *   3. versions compare numerically, so 1.10.0 is newer than 1.9.0, and a
 *      prerelease sorts below the release it leads to (`0.4.0-beta.2` < `0.4.0`);
 *   4. a stable build is never offered a prerelease; a prerelease build may be
 *      offered the next prerelease, or the stable release that follows it;
 *   5. anything unrecognisable returns `newer: false` with a reason instead of
 *      throwing, because a malformed API response is not a crash.
 *
 * The result always has the same six keys, so the caller never has to guard:
 * `{ newer, version, url, publishedAt, prerelease, reason }`.
 */

/** Explicit semver shape. `v` is stripped before this is applied, not matched by it. */
const VERSION_PATTERN = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const NUMERIC = /^\d+$/;

/**
 * Parse a version or release tag.
 *
 * Tolerates surrounding whitespace, a leading `v`, and a build suffix
 * (`0.4.0+build.7`), which is ignored because it does not order releases.
 * Returns `null` for anything else rather than guessing.
 *
 * @param {unknown} value
 * @returns {{major: number, minor: number, patch: number, prerelease: string[]}|null}
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^[vV]/, '');
  const match = VERSION_PATTERN.exec(text);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  // `1.0.0-a..b` would parse but has an empty identifier; reject it rather
  // than carry a hole into the comparison.
  if (prerelease.some((part) => part.length === 0)) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

/** Semver's prerelease comparison: numeric identifiers sort below text ones. */
function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1; // a release is newer than its prereleases
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1; // shorter prefix is older
    if (right[index] === undefined) return 1;
    const leftNumeric = NUMERIC.test(left[index]);
    const rightNumeric = NUMERIC.test(right[index]);
    if (leftNumeric && rightNumeric) {
      const difference = Number(left[index]) - Number(right[index]);
      if (difference !== 0) return difference < 0 ? -1 : 1;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Order two versions, either as strings (`1.10.0`, `v1.9.0`) or as the objects
 * `parseVersion` returns. Returns `-1`, `0`, `1`, or `null` when either side
 * cannot be parsed — a comparison this module cannot make is never reported as
 * "equal".
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {-1|0|1|null}
 */
export function compareVersions(left, right) {
  const first = typeof left === 'string' ? parseVersion(left) : left;
  const second = typeof right === 'string' ? parseVersion(right) : right;
  if (!first || !second) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (first[key] !== second[key]) return first[key] < second[key] ? -1 : 1;
  }
  return comparePrerelease(first.prerelease, second.prerelease);
}

/** Render a parsed version without a `v`, so the UI can add its own prefix once. */
function formatVersion(parsed) {
  const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return parsed.prerelease.length === 0 ? base : `${base}-${parsed.prerelease.join('.')}`;
}

/** Only a plain https URL may reach `shell.openExternal`. */
function releaseUrl(value) {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  return /^https:\/\/[^\s]+$/i.test(url) ? url : null;
}

function publishedAt(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function emptyResult(overrides = {}) {
  return {
    newer: false,
    version: null,
    url: null,
    publishedAt: null,
    prerelease: false,
    reason: 'up-to-date',
    ...overrides,
  };
}

/** GitHub's field names; a mapping layer may pass the release objects straight through. */
function releaseTag(release) {
  return release.tag_name ?? release.tagName ?? release.tag;
}

/**
 * Decide whether `releases` contains something newer than `currentVersion`.
 *
 * @param {object} input
 * @param {unknown} input.currentVersion  the version stamped into this build
 * @param {unknown} input.releases        GitHub release objects (or the same fields)
 * @returns {{newer: boolean, version: string|null, url: string|null,
 *            publishedAt: string|null, prerelease: boolean, reason: string}}
 */
export function checkForUpdate(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return emptyResult({ reason: 'invalid-input' });
  }
  const current = parseVersion(input.currentVersion);
  if (!current) return emptyResult({ reason: 'invalid-current-version' });
  if (!Array.isArray(input.releases)) return emptyResult({ reason: 'invalid-releases' });
  // A repository with no published release is a different statement from a list
  // whose entries could not be read; the caller may want to say so differently.
  if (input.releases.length === 0) return emptyResult({ reason: 'no-releases' });

  const stableBuild = current.prerelease.length === 0;
  let best = null;
  let comparable = 0;
  let withheldPrerelease = false;

  for (const release of input.releases) {
    if (!release || typeof release !== 'object' || Array.isArray(release)) continue;
    if (release.draft === true) continue;
    const parsed = parseVersion(releaseTag(release));
    if (!parsed) continue;
    comparable += 1;
    // The tag suffix and GitHub's own flag both mark a prerelease. Either one
    // is enough: a release GitHub labels `prerelease` must not reach a stable
    // build even when its tag looks final.
    const prerelease = parsed.prerelease.length > 0 || release.prerelease === true;
    if (stableBuild && prerelease) {
      withheldPrerelease = true;
      continue;
    }
    if (compareVersions(current, parsed) >= 0) continue;
    if (best === null || compareVersions(parsed, best.parsed) > 0) {
      best = {
        parsed,
        prerelease,
        url: releaseUrl(release.html_url),
        publishedAt: publishedAt(release.published_at),
      };
    }
  }

  if (best === null) {
    if (comparable === 0) return emptyResult({ reason: 'no-comparable-releases' });
    if (withheldPrerelease) return emptyResult({ reason: 'prerelease-not-offered' });
    return emptyResult({ reason: 'up-to-date' });
  }

  return {
    newer: true,
    version: formatVersion(best.parsed),
    url: best.url,
    publishedAt: best.publishedAt,
    prerelease: best.prerelease,
    reason: 'newer-release',
  };
}
