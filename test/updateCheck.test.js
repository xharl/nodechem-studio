import { describe, it, expect } from 'vitest';
import { checkForUpdate, compareVersions, parseVersion } from '../src/shared/updateCheck.js';

/**
 * The update notice is the only thing the app does with a remote response, and
 * a wrong answer here is expensive in both directions: telling a user they are
 * current when they are not leaves a known bug installed, and offering a
 * prerelease to a stable build invites them into an untested build. The tests
 * pin the ordering rules, the channel rules, and — just as important — that a
 * malformed payload produces a reason instead of an exception.
 */

const release = (tag_name, extra = {}) => ({
  tag_name,
  html_url: `https://github.com/xharl/nodechem-studio/releases/tag/${tag_name}`,
  published_at: '2026-11-01T12:00:00Z',
  prerelease: false,
  draft: false,
  ...extra,
});

const check = (currentVersion, releases) => checkForUpdate({ currentVersion, releases });

describe('parseVersion and compareVersions', () => {
  it('parses plain, prefixed and prerelease versions', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion(' V1.2.3 ')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion('1.2.3-beta.1')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ['beta', '1'] });
    // A build suffix does not order releases, so it is parsed away.
    expect(parseVersion('1.2.3+build.7')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  it('rejects everything that is not a three-part version', () => {
    for (const value of ['', 'v', '1', '1.2', '1.2.3.4', 'release-1.2.3', '1.2.3-', '1.2.3-a..b', null, 3, {}]) {
      expect(parseVersion(value), String(value)).toBeNull();
    }
  });

  it('compares numerically, not as strings', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
    expect(compareVersions('0.3.0', '0.3.0')).toBe(0);
    expect(compareVersions('v0.3.0', '0.3.0')).toBe(0);
    expect(compareVersions('0.3.1', '0.3.0')).toBe(1);
    expect(compareVersions('0.2.99', '0.3.0')).toBe(-1);
  });

  it('orders prereleases below the release they lead to', () => {
    expect(compareVersions('0.4.0-beta.1', '0.4.0')).toBe(-1);
    expect(compareVersions('0.4.0', '0.4.0-beta.1')).toBe(1);
    expect(compareVersions('0.4.0-beta.1', '0.4.0-beta.2')).toBe(-1);
    expect(compareVersions('0.4.0-beta.2', '0.4.0-beta.10')).toBe(-1);
    expect(compareVersions('0.4.0-alpha', '0.4.0-beta')).toBe(-1);
    expect(compareVersions('0.4.0-beta', '0.4.0-beta.1')).toBe(-1);
    expect(compareVersions('0.4.0-2', '0.4.0-10')).toBe(-1);
    // Numeric identifiers sort below alphanumeric ones.
    expect(compareVersions('0.4.0-1', '0.4.0-alpha')).toBe(-1);
    expect(compareVersions('0.4.0-beta.2', '0.4.0-beta.2')).toBe(0);
  });

  it('reports an unparsable comparison as null, never as equal', () => {
    expect(compareVersions('0.3.0', 'not-a-version')).toBeNull();
    expect(compareVersions('', '')).toBeNull();
  });
});

describe('checkForUpdate — basic ordering', () => {
  it('offers a newer release', () => {
    const result = check('0.3.0', [release('v0.4.0')]);
    expect(result).toMatchObject({
      newer: true,
      version: '0.4.0',
      prerelease: false,
      publishedAt: '2026-11-01T12:00:00Z',
      reason: 'newer-release',
    });
    expect(result.url).toBe('https://github.com/xharl/nodechem-studio/releases/tag/v0.4.0');
  });

  it('does not offer an older release', () => {
    expect(check('0.4.0', [release('v0.3.0'), release('0.2.5')])).toMatchObject({
      newer: false,
      version: null,
      reason: 'up-to-date',
    });
  });

  it('does not offer the version already installed', () => {
    expect(check('0.3.0', [release('v0.3.0')])).toMatchObject({ newer: false, reason: 'up-to-date' });
  });

  it('treats tags with and without a leading v as the same version', () => {
    expect(check('0.3.0', [release('0.3.0')]).newer).toBe(false);
    expect(check('v0.3.0', [release('v0.3.0')]).newer).toBe(false);
    expect(check('0.3.0', [release('0.3.1')]).version).toBe('0.3.1');
  });

  it('compares numeric segments numerically (1.10.0 is newer than 1.9.0)', () => {
    expect(check('1.9.0', [release('v1.10.0')])).toMatchObject({ newer: true, version: '1.10.0' });
    expect(check('1.10.0', [release('v1.9.0')]).newer).toBe(false);
  });

  it('picks the highest version, not the most recently published one', () => {
    const result = check('0.3.0', [
      release('v0.3.1', { published_at: '2026-11-07T00:00:00Z' }),
      release('v0.4.0', { published_at: '2026-11-01T00:00:00Z' }),
    ]);
    expect(result.version).toBe('0.4.0');
    expect(result.publishedAt).toBe('2026-11-01T00:00:00Z');
  });

  it('ignores drafts even when the draft is the newest tag', () => {
    expect(check('0.3.0', [release('v0.5.0', { draft: true }), release('v0.4.0')])).toMatchObject({
      newer: true,
      version: '0.4.0',
    });
    expect(check('0.3.0', [release('v0.5.0', { draft: true })])).toMatchObject({
      newer: false,
      reason: 'no-comparable-releases',
    });
  });
});

describe('checkForUpdate — prerelease rules', () => {
  it('never offers a prerelease to a stable build', () => {
    expect(check('0.3.0', [release('v0.4.0-beta.1', { prerelease: true })])).toMatchObject({
      newer: false,
      version: null,
      reason: 'prerelease-not-offered',
    });
  });

  it('keeps a stable build on the newest stable release when a prerelease is newer', () => {
    const result = check('0.3.0', [
      release('v0.4.0-beta.2', { prerelease: true }),
      release('v0.3.1'),
    ]);
    expect(result).toMatchObject({ newer: true, version: '0.3.1', prerelease: false });
  });

  it('withholds a release GitHub flags as prerelease even when its tag looks final', () => {
    expect(check('0.3.0', [release('v0.4.0', { prerelease: true })])).toMatchObject({
      newer: false,
      reason: 'prerelease-not-offered',
    });
  });

  it('offers the next prerelease to a prerelease build', () => {
    const result = check('0.3.0-beta.1', [release('v0.3.0-beta.2', { prerelease: true })]);
    expect(result).toMatchObject({ newer: true, version: '0.3.0-beta.2', prerelease: true });
  });

  it('offers the stable release that follows a prerelease build', () => {
    const result = check('0.3.0-beta.2', [release('v0.3.0')]);
    expect(result).toMatchObject({ newer: true, version: '0.3.0', prerelease: false });
  });

  it('prefers a newer prerelease over the stable release it will lead to', () => {
    const result = check('0.3.0-beta.2', [release('v0.4.0-beta.1', { prerelease: true }), release('v0.3.0')]);
    expect(result).toMatchObject({ newer: true, version: '0.4.0-beta.1', prerelease: true });
  });

  it('does not offer a prerelease of the version a prerelease build already has', () => {
    expect(check('0.4.0-beta.2', [release('v0.4.0-beta.2')])).toMatchObject({ newer: false });
  });

  it('orders prerelease identifiers numerically, so beta.10 beats beta.9', () => {
    expect(check('0.4.0-beta.9', [release('v0.4.0-beta.10')])).toMatchObject({
      newer: true,
      version: '0.4.0-beta.10',
      prerelease: true,
    });
  });
});

describe('checkForUpdate — tolerated input', () => {
  it('returns a reason for an empty release list', () => {
    expect(check('0.3.0', [])).toMatchObject({ newer: false, reason: 'no-releases' });
  });

  it('returns a reason when no release has a comparable tag', () => {
    expect(check('0.3.0', [release('nightly'), release('vNext'), { tag_name: 42 }])).toMatchObject({
      newer: false,
      reason: 'no-comparable-releases',
    });
  });

  it('skips malformed entries without losing the valid ones', () => {
    const list = [null, undefined, 'v9.9.9', 42, [], { tag_name: null }, release('v0.4.0')];
    expect(check('0.3.0', list)).toMatchObject({ newer: true, version: '0.4.0' });
  });

  it('never throws on unknown top-level shapes', () => {
    const inputs = [undefined, null, 'check', 7, [], {}];
    for (const input of inputs) {
      const result = checkForUpdate(input);
      expect(result.newer).toBe(false);
      expect(typeof result.reason).toBe('string');
      expect(result).toMatchObject({ version: null, url: null, publishedAt: null });
    }
  });

  it('separates a bad current version from a bad release list', () => {
    expect(checkForUpdate({ currentVersion: 'unknown', releases: [] }).reason).toBe('invalid-current-version');
    expect(checkForUpdate({ currentVersion: '0.3.0', releases: 'nope' }).reason).toBe('invalid-releases');
    expect(checkForUpdate({ releases: [] }).reason).toBe('invalid-current-version');
  });

  it('drops a release URL that is not https, rather than passing it to the shell', () => {
    const result = check('0.3.0', [release('v0.4.0', { html_url: 'javascript:alert(1)' })]);
    expect(result.newer).toBe(true);
    expect(result.url).toBeNull();
    expect(check('0.3.0', [release('v0.4.0', { html_url: 'http://example.com/x' })]).url).toBeNull();
  });

  it('reports a missing published date as null instead of inventing one', () => {
    const result = check('0.3.0', [release('v0.4.0', { published_at: null })]);
    expect(result.newer).toBe(true);
    expect(result.publishedAt).toBeNull();
  });
});
