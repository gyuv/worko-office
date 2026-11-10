import { describe, expect, it } from 'vitest';
import { androidVersionCode, compareVersions, DOWNLOAD_PREFIX, pickUpdate, type GhRelease } from './updates.js';

const rel = (tag: string, names: string[], extra: Partial<GhRelease> = {}): GhRelease => ({
  tag_name: tag, html_url: `https://github.com/x/releases/tag/${tag}`, body: `notes ${tag}`, prerelease: true,
  assets: names.map((n) => ({ name: n, browser_download_url: `${DOWNLOAD_PREFIX}${tag}/${n}`, size: 10, digest: 'sha256:ABC' })), ...extra,
});

describe('compareVersions', () => {
  it('orders semver including pre-releases', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3-beta.2', '1.2.3')).toBeLessThan(0);
    expect(compareVersions('1.2.3-beta.10', '1.2.3-beta.2')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0-ci.40', '1.1.0')).toBeLessThan(0);
    expect(compareVersions('junk', '0.0.1')).toBeLessThan(0);
  });
});

describe('pickUpdate', () => {
  const list = [
    rel('v1.3.0', ['Worko-1.3.0.apk']),
    rel('v1.2.0', ['Worko-Setup-1.2.0.exe', 'Worko-1.2.0-arm64.dmg', 'Worko-1.2.0.dmg', 'Worko-1.2.0.apk']),
    rel('v9.0.0', ['Worko-Setup-9.0.0.exe'], { draft: true }),
    rel('NEW-v2', ['Worko-Setup-2.exe']),
  ];
  it('picks the newest release with an installer for the platform', () => {
    expect(pickUpdate(list, 'android', '1.1.0')).toMatchObject({ version: '1.3.0', sha256: 'abc', fileName: 'Worko-1.3.0.apk' });
    expect(pickUpdate(list, 'win', '1.1.0')).toMatchObject({ version: '1.2.0', url: `${DOWNLOAD_PREFIX}v1.2.0/Worko-Setup-1.2.0.exe` });
    expect(pickUpdate(list, 'mac-arm64', '1.1.0')?.fileName).toBe('Worko-1.2.0-arm64.dmg');
    expect(pickUpdate(list, 'mac-x64', '1.1.0')?.fileName).toBe('Worko-1.2.0.dmg');
  });
  it('returns null when up to date, for drafts, or for foreign download hosts', () => {
    expect(pickUpdate(list, 'win', '1.2.0')).toBeNull();
    expect(pickUpdate(list, 'linux', '0.0.1')).toBeNull();
    const evil = rel('v5.0.0', ['Worko-Setup-5.exe']); evil.assets[0]!.browser_download_url = 'https://evil.example/x.exe';
    expect(pickUpdate([evil], 'win', '1.0.0')).toBeNull();
  });
  it('maps versions to Android version codes', () => {
    expect(androidVersionCode('1.2.3')).toBe(10203);
    expect(androidVersionCode('2.0.0')).toBeGreaterThan(androidVersionCode('1.99.99'));
  });
});
