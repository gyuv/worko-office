import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAllowedExternal, loadSettings } from './settings';
import { TokenStore, type SafeStorage } from './token-store';
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
  it('tray shows pending count and auto-start state', () => {
    const m = trayMenu({ badge: 3, autoStart: false, open() {}, toggleAutoStart() {}, quit() {} });
    expect(m[0]?.label).toBe('Open Worko (3 pending)');
    expect(m.find((i) => i.type === 'checkbox')?.checked).toBe(false);
  });
});
