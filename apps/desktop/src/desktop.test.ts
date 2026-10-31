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
