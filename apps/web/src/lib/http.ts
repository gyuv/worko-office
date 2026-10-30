import { useEffect, useState } from 'react';
import { apiBase } from './platform';
import { useSession } from './session';

/** Absolute URL for a server-relative path such as `/v1/files/...` returned by the API. */
export function absoluteUrl(path: string): string {
  const base = new URL(apiBase(), typeof location !== 'undefined' ? location.href : 'http://localhost');
  return new URL(path, base).toString();
}

/** Authenticated GET for binary responses (exports, receipts) that the typed client does not model. */
export async function fetchBlob(path: string): Promise<{ blob: Blob; filename: string | null }> {
  const tokens = useSession.getState().tokens;
  const res = await fetch(`${apiBase()}${path}`, { headers: tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {} });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    throw Object.assign(new Error(e.message ?? `HTTP ${res.status}`), { status: res.status, code: e.code });
  }
  const cd = res.headers.get('content-disposition') ?? '';
  const filename = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? null;
  return { blob: await res.blob(), filename };
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function openBlob(blob: Blob) {
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** openapi-fetch passes FormData through untouched; the generated types model multipart as strings. */
export const multipart = (fields: Record<string, string | Blob | undefined>): never => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== '') fd.append(k, v);
  return fd as never;
};

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const id = setTimeout(() => setV(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return v;
}

export const errCode = (e: unknown) => (e as { code?: string } | null)?.code;
export const errStatus = (e: unknown) => (e as { status?: number } | null)?.status;

/** Current Indian financial year label, e.g. 2026-27, computed in IST. */
export function currentFy(now = new Date()): string {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const y = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}
export const todayIst = (now = new Date()) => new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
