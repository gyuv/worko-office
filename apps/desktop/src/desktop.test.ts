import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApiBase, deepLinkHash, isAllowedExternal, isAppUrl, isTokenPair, loadSettings } from './settings';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DbKeyStore, TokenStore, type SafeStorage } from './token-store';
import { trayMenu } from './tray-menu';

const fakeSafe = (available = true): SafeStorage => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(s, 'utf8').map((b) => b ^ 0x5a) as Buffer,
  decryptString: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
});

describe('token store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worko-'));
  it('never writes plaintext tokens to disk', () => {
    const s = new TokenStore(join(dir, 'a.bin'), fakeSafe());
    s.set({ refreshToken: 'super-secret' });
    expect(readFileSync(join(dir, 'a.bin')).toString()).not.toContain('super-secret');
    expect(s.get()).toEqual({ refreshToken: 'super-secret' });
    s.set(null);
    expect(existsSync(join(dir, 'a.bin'))).toBe(false);
  });
  it('keeps tokens in memory only when OS encryption is unavailable', () => {
    const s = new TokenStore(join(dir, 'b.bin'), fakeSafe(false));
    s.set({ refreshToken: 'x' });
    expect(existsSync(join(dir, 'b.bin'))).toBe(false);
    expect(s.get()).toEqual({ refreshToken: 'x' });
  });
});

describe('external links', () => {
  it('allows the API origin and official portals only', () => {
    const api = 'https://api.worko.in/v1';
    expect(isAllowedExternal('https://api.worko.in/x', api)).toBe(true);
    expect(isAllowedExternal('https://www.gst.gov.in/', api)).toBe(true);
    expect(isAllowedExternal('https://udin.icai.org/', api)).toBe(true);
    expect(isAllowedExternal('https://evil.example/gov.in', api)).toBe(false);
    expect(isAllowedExternal('http://www.gst.gov.in/', api)).toBe(false);
    expect(isAllowedExternal('file:///etc/passwd', api)).toBe(false);
  });
});

describe('settings & tray', () => {
  it('defaults when missing or corrupt', () => expect(loadSettings('/nonexistent/x.json').autoStart).toBe(true));
  it('takes the packaged API base from build-config.json, refusing non-https', () => {
    const d = mkdtempSync(join(tmpdir(), 'wb-')); const f = join(d, 'build-config.json');
    expect(buildApiBase('/nonexistent/build-config.json')).toBe('http://localhost:3000/v1');
    writeFileSync(f, JSON.stringify({ apiBase: 'https://api.firm.example/v1' }));
    expect(buildApiBase(f)).toBe('https://api.firm.example/v1');
    writeFileSync(f, JSON.stringify({ apiBase: 'http://api.firm.example/v1' }));
    expect(buildApiBase(f)).toBe('http://localhost:3000/v1');
  });
  it('tray shows pending count and auto-start state', () => {
    const m = trayMenu({ badge: 3, autoStart: false, open() {}, toggleAutoStart() {}, quit() {} });
    expect(m[0]?.label).toBe('Open Worko (3 pending)');
    expect(m.find((i) => i.type === 'checkbox')?.checked).toBe(false);
  });
});

describe('renderer lock-down', () => {
  const app = 'file:///C:/Program%20Files/Worko/resources/web/dist/index.html';
  it('only the app entry page may load', () => {
    expect(isAppUrl(app + '#/audit', app)).toBe(true);
    expect(isAppUrl('file:///C:/Users/x/Downloads/evil.html', app)).toBe(false);
    expect(isAppUrl('https://evil.example/', app)).toBe(false);
    expect(isAppUrl('http://localhost:5173/#/x', 'http://localhost:5173/')).toBe(true);
    expect(isAppUrl('http://localhost:5174/', 'http://localhost:5173/')).toBe(false);
  });
  it('validates token payloads from the renderer', () => {
    expect(isTokenPair(null)).toBe(true);
    expect(isTokenPair({ accessToken: 'a', refreshToken: 'r', sessionId: 's', userId: 'u', tenantId: 't', expiresIn: 900 })).toBe(true);
    expect(isTokenPair({ accessToken: 1 })).toBe(false);
    expect(isTokenPair('x')).toBe(false);
  });
});

describe('local DB key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worko-key-'));
  it('is stable across restarts, stored only encrypted, and destroyed on wipe', () => {
    const k1 = new DbKeyStore(join(dir, 'k.bin'), fakeSafe(), randomBytes).get();
    expect(k1).toHaveLength(32);
    expect(readFileSync(join(dir, 'k.bin')).includes(Buffer.from(k1.toString('base64')))).toBe(false);
    const again = new DbKeyStore(join(dir, 'k.bin'), fakeSafe(), randomBytes);
    expect(again.get().equals(k1)).toBe(true);
    again.destroy();
    expect(new DbKeyStore(join(dir, 'k.bin'), fakeSafe(), randomBytes).get().equals(k1)).toBe(false);
  });
});

describe('deep links', () => {
  it('maps worko:// paths to hash routes and refuses anything else', () => {
    expect(deepLinkHash('worko://tasks/01a1-b2')).toBe('#/tasks/01a1-b2');
    expect(deepLinkHash('worko:///reports/download/x.pdf')).toBe('#/reports/download/x.pdf');
    for (const bad of ['https://evil.example/tasks', 'worko://tasks/../../etc', 'worko://u:p@tasks/1', 'worko://', 'worko://tasks/<script>', 'javascript:alert(1)', 'worko://a/b?x=1#y'.replace('?x=1#y', '/%2e%2e')])
      expect(deepLinkHash(bad), bad).toBeNull();
  });
});

import { createHash } from 'node:crypto';
import { platformKey, Updater, type UpdateState } from './updater';
import { DOWNLOAD_PREFIX } from './update-core';

describe('in-app updater', () => {
  it('update-core.ts matches the domain source', () => {
    const domain = readFileSync(join(__dirname, '../../../packages/domain/src/updates.ts'), 'utf8');
    const copy = readFileSync(join(__dirname, 'update-core.ts'), 'utf8').split('\n').slice(2).join('\n');
    expect(copy).toBe(domain);
  });
  it('maps OS + arch to a release asset kind', () => {
    expect(platformKey('win32', 'x64')).toBe('win');
    expect(platformKey('darwin', 'arm64')).toBe('mac-arm64');
    expect(platformKey('darwin', 'x64')).toBe('mac-x64');
    expect(platformKey('freebsd', 'x64')).toBeNull();
  });
  const bytes = Buffer.from('installer-bytes');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const releases = (digest: string) => [{ tag_name: 'v2.0.0', html_url: 'h', assets: [{ name: 'Worko-Setup-2.0.0.exe', browser_download_url: `${DOWNLOAD_PREFIX}v2.0.0/Worko-Setup-2.0.0.exe`, size: bytes.length, digest: `sha256:${digest}` }] }];
  const fakeFetch = (digest: string) => (async (url: string) => (String(url).includes('api.github.com')
    ? new Response(JSON.stringify(releases(digest)))
    : new Response(bytes, { headers: { 'content-length': String(bytes.length) } }))) as unknown as typeof fetch;

  it('downloads, verifies and reports ready', async () => {
    const states: UpdateState['phase'][] = [];
    const u = new Updater({ current: '1.0.0', platform: 'win', dir: mkdtempSync(join(tmpdir(), 'wu-')), fetch: fakeFetch(sha), onState: (s) => states.push(s.phase) });
    const s = await u.check();
    expect(s.phase).toBe('ready');
    expect(states).toContain('checking');
    if (s.phase === 'ready') expect(readFileSync(s.file).equals(bytes)).toBe(true);
  });
  it('refuses a file whose checksum does not match', async () => {
    const u = new Updater({ current: '1.0.0', platform: 'win', dir: mkdtempSync(join(tmpdir(), 'wu-')), fetch: fakeFetch('0'.repeat(64)), onState: () => {} });
    expect(await u.check()).toMatchObject({ phase: 'error', message: 'checksum mismatch' });
  });
  it('stays current when nothing newer exists', async () => {
    const u = new Updater({ current: '3.0.0', platform: 'win', dir: mkdtempSync(join(tmpdir(), 'wu-')), fetch: fakeFetch(sha), onState: () => {} });
    expect((await u.check()).phase).toBe('current');
  });
});

import { normaliseServer, withApiInCsp } from './settings';
describe('server address + CSP', () => {
  it('normalises typed server addresses', () => {
    expect(normaliseServer('worko-api.onrender.com')).toBe('https://worko-api.onrender.com/v1');
    expect(normaliseServer('https://api.firm.in/v1/')).toBe('https://api.firm.in/v1');
    expect(normaliseServer('http://evil.example')).toBeNull();
    expect(normaliseServer('ftp://x')).toBeNull();
  });
  it('adds the API origin to connect-src', () => {
    const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' http://localhost:3000">`;
    expect(withApiInCsp(html, 'https://a.example/v1')).toContain("connect-src 'self' https://a.example wss://a.example http://localhost:3000");
  });
});
