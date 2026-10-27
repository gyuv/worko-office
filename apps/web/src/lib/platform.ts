import type { TokenPair } from '@worko/api-client';

/**
 * Bridge exposed by the Electron preload (`window.worko`). On the web it is absent and we fall back to
 * browser APIs. Keeps the renderer identical across web and desktop.
 */
export type DesktopBridge = {
  platform: 'desktop';
  apiBase: string;
  tokens: { get(): Promise<TokenPair | null>; set(t: TokenPair | null): Promise<void> };
  notify(n: { title: string; body: string; id?: string }): void;
  setBadge(count: number): void;
  wipeLocalData(): Promise<void>;
  /** 32-byte key for the local encrypted store; generated and kept by the OS keychain (safeStorage). */
  getDbKey(): Promise<Uint8Array>;
  settings: { get(): Promise<{ autoStart: boolean }>; set(s: { autoStart: boolean }): Promise<void> };
};

declare global { interface Window { worko?: DesktopBridge } }

export const desktop = (): DesktopBridge | undefined => (typeof window !== 'undefined' ? window.worko : undefined);
export const platformName = (): 'web' | 'desktop' => (desktop() ? 'desktop' : 'web');
export const apiBase = (): string => desktop()?.apiBase ?? import.meta.env.VITE_API_URL ?? '/v1';

const KEY = 'worko.session';
/**
 * Web: tokens live in localStorage so a refresh keeps you signed in. Exposure to XSS is mitigated by a
 * strict CSP (no inline/3rd-party scripts) and 15-minute access tokens; desktop uses OS-encrypted storage.
 */
export const webTokenStorage = {
  load(): TokenPair | null { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; } },
  save(t: TokenPair | null) { if (t) localStorage.setItem(KEY, JSON.stringify(t)); else localStorage.removeItem(KEY); },
};
