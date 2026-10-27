import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export type DesktopSettings = { autoStart: boolean; startMinimised: boolean; apiBase: string };
export const DEFAULTS: DesktopSettings = { autoStart: true, startMinimised: false, apiBase: 'http://localhost:3000/v1' };

export function loadSettings(file: string): DesktopSettings {
  try { return { ...DEFAULTS, ...(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) }; } catch { return { ...DEFAULTS }; }
}
export function saveSettings(file: string, s: DesktopSettings) { writeFileSync(file, JSON.stringify(s, null, 2)); }

/** Only http(s) URLs to the configured API or the official portals may open; everything else is blocked. */
export function isAllowedExternal(url: string, apiBase: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === 'localhost')) return false;
    return u.origin === new URL(apiBase).origin || /(^|\.)(gov\.in|nic\.in|icai\.org)$/.test(u.hostname);
  } catch { return false; }
}
