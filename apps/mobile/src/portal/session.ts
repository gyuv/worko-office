import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { Linking } from 'react-native';
import { create } from 'zustand';
import { makeCacheEntry, readCacheEntry, safeExternalUrl, type CacheEntry } from '../logic/portal';
import Constants from 'expo-constants';

/**
 * DESIGN (Phase 9, D126/D134): the client portal lives in the SAME Android app behind an "I'm a client" entry on the
 * login screen, as a separate mode. Portal mode has its own SecureStore key, its own tiny HTTP client that refreshes via
 * /portal/auth/refresh, and never imports the staff api client, SyncEngine, realtime or remote-wipe paths
 * (it only shares the configured API base URL). A separate app can be split out later without touching this module's contract.
 */

export type PortalTokens = { accessToken: string; refreshToken: string; expiresIn: number; sessionId: string; portalUserId: string; tenantId: string };

const KEY = 'worko.portal.session';
const FIRM_KEY = 'worko.portal.firm';
const CACHE_DIR = `${FileSystem.documentDirectory ?? ''}portal-cache/`;

type State = {
  tokens: PortalTokens | null; firm: string | null; ready: boolean; clientId: string | null;
  setTokens(t: PortalTokens | null): void; setFirm(f: string): void; setClient(id: string | null): void; init(): Promise<void>;
};

export const usePortal = create<State>((set) => ({
  tokens: null, firm: null, ready: false, clientId: null,
  setTokens(t) {
    set({ tokens: t });
    void (t ? SecureStore.setItemAsync(KEY, JSON.stringify(t)) : SecureStore.deleteItemAsync(KEY));
    if (!t) { set({ clientId: null }); void clearPortalCache(); }
  },
  setFirm(f) { set({ firm: f }); void SecureStore.setItemAsync(FIRM_KEY, f); },
  setClient(id) { set({ clientId: id }); },
  async init() {
    let tokens: PortalTokens | null = null; let firm: string | null = null;
    try { tokens = JSON.parse((await SecureStore.getItemAsync(KEY)) ?? 'null'); firm = await SecureStore.getItemAsync(FIRM_KEY); } catch { /* ignore */ }
    set({ tokens, firm, ready: true });
  },
}));

// Same server as staff mode, but the staff session module (api client, wipe handler) is deliberately not imported.
const apiBase = (Constants.expoConfig?.extra?.apiBase as string | undefined) ?? 'http://10.0.2.2:3000/v1';
const base = () => apiBase.replace(/\/$/, '');
export type HttpError = Error & { status?: number; code?: string };
const fail = async (res: Response): Promise<never> => {
  const b = (await res.json().catch(() => null)) as { message?: string; code?: string } | null;
  throw Object.assign(new Error(b?.message ?? `HTTP ${res.status}`), { status: res.status, code: b?.code }) as HttpError;
};

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  const t = usePortal.getState().tokens;
  if (!t) return false;
  try {
    const res = await fetch(`${base()}/portal/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: t.refreshToken }) });
    if (res.ok) { usePortal.getState().setTokens((await res.json()) as PortalTokens); return true; }
    if (res.status === 401) usePortal.getState().setTokens(null); // portal sign-out only; no device wipe in portal mode
    return false;
  } catch { return false; }
}

/** Authenticated portal request with a single deduplicated refresh on 401. */
export async function portalFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = () => fetch(base() + path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: 'Bearer ' + (usePortal.getState().tokens?.accessToken ?? '') } });
  let res = await send();
  if (res.status === 401 && !path.startsWith('/portal/auth/')) {
    refreshing ??= refresh().finally(() => { refreshing = null; });
    if (await refreshing) res = await send();
  }
  return res;
}

export async function pget<T>(path: string): Promise<T> {
  const res = await portalFetch(path);
  if (!res.ok) await fail(res);
  return (await res.json()) as T;
}
export async function psend<T>(method: 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const res = await portalFetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) await fail(res);
  return (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
}

/** Public (unauthenticated) portal calls: branding + OTP. */
export async function ppublic<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(base() + path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) await fail(res);
  return (await res.json()) as T;
}
export const logoUrl = (firm: string) => `${base()}/portal/branding/${encodeURIComponent(firm)}/logo`;

export async function portalLogout(): Promise<void> {
  await portalFetch('/portal/auth/logout', { method: 'POST' }).catch(() => undefined);
  usePortal.getState().setTokens(null);
}

// ---- files ----
type RNFile = { uri: string; name: string; type: string };
const filePart = (f: RNFile) => f as unknown as Blob;

/** Upload to the client's "From client" inbox (server never overwrites). Same picker helpers as staff uploads. */
export async function portalUpload(clientId: string, f: RNFile, meta: { name?: string; fy?: string; note?: string }): Promise<{ id: string }> {
  const build = () => { const fd = new FormData(); fd.append('file', filePart(f)); if (meta.name) fd.append('name', meta.name); if (meta.fy) fd.append('fy', meta.fy); if (meta.note) fd.append('note', meta.note); return fd; };
  const res = await portalFetch(`/portal/clients/${clientId}/documents`, { method: 'POST', body: build() });
  if (!res.ok) await fail(res);
  return (await res.json()) as { id: string };
}

export async function portalRespond(clientId: string, kind: 'pbc' | 'task', id: string, message: string, f: RNFile | null): Promise<{ status: string }> {
  const fd = new FormData();
  if (message.trim()) fd.append('message', message.trim());
  if (f) fd.append('file', filePart(f));
  const res = await portalFetch(`/portal/clients/${clientId}/requests/${kind}/${id}/respond`, { method: 'POST', body: fd });
  if (!res.ok) await fail(res);
  return (await res.json()) as { status: string };
}

/** 2-minute signed URL (bound to this portal session) → system browser/viewer. No bearer leaves the app. */
export async function openPortalDocument(clientId: string, id: string): Promise<void> {
  const { url } = await psend<{ url: string }>('POST', `/portal/clients/${clientId}/documents/${id}/download-url`);
  await Linking.openURL(new URL(url, base() + '/').toString());
}

export async function openPortalInvoicePdf(clientId: string, id: string, name: string): Promise<void> {
  const target = `${FileSystem.cacheDirectory ?? ''}portal-${name.replace(/[^\w.-]+/g, '_') || 'invoice'}.pdf`;
  const url = `${base()}/portal/clients/${clientId}/invoices/${id}/pdf`;
  const get = () => FileSystem.downloadAsync(url, target, { headers: { Authorization: 'Bearer ' + (usePortal.getState().tokens?.accessToken ?? '') } });
  let res = await get();
  if (res.status === 401 && (await refresh())) res = await get();
  if (res.status !== 200) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  await Linking.openURL(await FileSystem.getContentUriAsync(res.uri));
}

export async function openExternal(url: unknown): Promise<boolean> {
  const safe = safeExternalUrl(url);
  if (!safe) return false;
  await Linking.openURL(safe);
  return true;
}

// ---- small read-only cache (app-private files; wiped on logout) ----
const cacheFile = (name: 'dashboard' | 'documents') => `${CACHE_DIR}${name}.json`;
export async function saveCache(name: 'dashboard' | 'documents', clientId: string, data: unknown): Promise<void> {
  const owner = usePortal.getState().tokens?.portalUserId;
  if (!owner || !FileSystem.documentDirectory) return;
  try {
    await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true }).catch(() => undefined);
    await FileSystem.writeAsStringAsync(cacheFile(name), JSON.stringify(makeCacheEntry(owner, clientId, data, Date.now())));
  } catch { /* best effort */ }
}
export async function loadCache<T>(name: 'dashboard' | 'documents', clientId: string): Promise<CacheEntry<T> | null> {
  const owner = usePortal.getState().tokens?.portalUserId;
  if (!owner || !FileSystem.documentDirectory) return null;
  try { return readCacheEntry<T>(await FileSystem.readAsStringAsync(cacheFile(name)), owner, clientId); } catch { return null; }
}
export async function clearPortalCache(): Promise<void> {
  if (!FileSystem.documentDirectory) return;
  await FileSystem.deleteAsync(CACHE_DIR, { idempotent: true }).catch(() => undefined);
}
