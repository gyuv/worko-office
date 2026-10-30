import type { Schemas } from '@worko/api-client';
import { create } from 'zustand';
import { apiBase } from '../lib/platform';

/**
 * Portal-only token storage and http client (D126). Portal tokens have their own issuer/audience and refresh endpoint;
 * they live under a separate key per firm and are only ever attached to `/portal/*` requests. Staff tokens are never read here.
 */
export type PortalTokens = Schemas['PortalTokenPair'];
const KEY = (firm: string) => `worko.portal.${firm}`;

export const portalTokenStorage = {
  load(firm: string): PortalTokens | null { try { return JSON.parse(localStorage.getItem(KEY(firm)) ?? 'null'); } catch { return null; } },
  save(firm: string, t: PortalTokens | null) { try { if (t) localStorage.setItem(KEY(firm), JSON.stringify(t)); else localStorage.removeItem(KEY(firm)); } catch { /* private mode */ } },
};

type PortalSession = { firm: string | null; tokens: PortalTokens | null; open(firm: string): void; setTokens(t: PortalTokens | null): void };
export const usePortalSession = create<PortalSession>((set, get) => ({
  firm: null, tokens: null,
  open(firm) { if (get().firm !== firm) set({ firm, tokens: portalTokenStorage.load(firm) }); },
  setTokens(t) { const f = get().firm; if (f) portalTokenStorage.save(f, t); set({ tokens: t }); },
}));

export class PortalHttpError extends Error {
  constructor(public status: number, message: string, public code?: string, public body?: unknown, public headers?: Headers) { super(message); }
}

const isPortalPath = (p: string) => p.startsWith('/portal/');
let refreshing: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  const s = usePortalSession.getState();
  if (!s.tokens) return false;
  const res = await fetch(`${apiBase()}/portal/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: s.tokens.refreshToken }) });
  if (res.ok) { s.setTokens(await res.json()); return true; }
  s.setTokens(null);
  return false;
}

async function toError(res: Response): Promise<PortalHttpError> {
  const b = await res.json().catch(() => ({})) as { message?: string; code?: string };
  return new PortalHttpError(res.status, typeof b.message === 'string' ? b.message : `HTTP ${res.status}`, b.code, b, res.headers);
}

/** Authenticated portal request; one deduplicated refresh on 401, then retry once. Refuses non-portal paths. */
export async function portalRaw(path: string, init: RequestInit = {}, auth = true): Promise<Response> {
  if (!isPortalPath(path)) throw new Error('portal client only calls /portal routes');
  const send = () => {
    const h = new Headers(init.headers);
    const t = usePortalSession.getState().tokens;
    if (auth && t) h.set('authorization', `Bearer ${t.accessToken}`);
    return fetch(`${apiBase()}${path}`, { ...init, headers: h });
  };
  let res = await send();
  if (res.status === 401 && auth && usePortalSession.getState().tokens) {
    refreshing ??= refresh().finally(() => { refreshing = null; });
    if (await refreshing) res = await send();
  }
  return res;
}

export async function portalJson<T>(path: string, o: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const res = await portalRaw(path, { method: o.method ?? 'GET', ...(o.body !== undefined ? { body: JSON.stringify(o.body), headers: { 'content-type': 'application/json' } } : {}) }, o.auth ?? true);
  if (!res.ok) throw await toError(res);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export async function portalBlob(path: string): Promise<Blob> {
  const res = await portalRaw(path);
  if (!res.ok) throw await toError(res);
  return res.blob();
}

/** Multipart POST with upload progress (XHR), same bearer + single refresh as `portalRaw`. */
export function portalUpload<T>(path: string, form: FormData, onProgress?: (pct: number) => void): Promise<T> {
  if (!isPortalPath(path)) return Promise.reject(new Error('portal client only calls /portal routes'));
  const once = () => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `${apiBase()}${path}`);
    const t = usePortalSession.getState().tokens;
    if (t) x.setRequestHeader('authorization', `Bearer ${t.accessToken}`);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100)); };
    x.onload = () => resolve({ status: x.status, text: x.responseText });
    x.onerror = () => reject(new PortalHttpError(0, 'Network error'));
    x.send(form);
  });
  return (async () => {
    let r = await once();
    if (r.status === 401 && usePortalSession.getState().tokens) {
      refreshing ??= refresh().finally(() => { refreshing = null; });
      if (await refreshing) r = await once();
    }
    const b = (() => { try { return JSON.parse(r.text || 'null'); } catch { return null; } })();
    if (r.status < 200 || r.status >= 300) throw new PortalHttpError(r.status, b?.message ?? `HTTP ${r.status}`, b?.code, b);
    onProgress?.(100);
    return b as T;
  })();
}

/** Logged-out public JSON (no Authorization header at all — neither staff nor portal tokens). */
export async function publicJson<T>(path: string, o: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, { method: o.method ?? 'GET', ...(o.body !== undefined ? { body: JSON.stringify(o.body), headers: { 'content-type': 'application/json' } } : {}) });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}
