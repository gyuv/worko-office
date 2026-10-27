import { createWorkoClient, type TokenPair } from '@worko/api-client';
import { create } from 'zustand';
import { apiBase, desktop, webTokenStorage } from './platform';

type SessionState = {
  tokens: TokenPair | null;
  ready: boolean;
  notice: 'wiped' | null;
  setTokens(t: TokenPair | null): void;
  init(): Promise<void>;
};

export const useSession = create<SessionState>((set) => ({
  tokens: null, ready: false, notice: null,
  setTokens(t) {
    set({ tokens: t });
    const d = desktop();
    if (d) void d.tokens.set(t); else webTokenStorage.save(t);
  },
  async init() {
    const d = desktop();
    set({ tokens: d ? await d.tokens.get() : webTokenStorage.load(), ready: true });
  },
}));

// Lazy import avoids a session ↔ sync module cycle at load time.
const onWipe = () => import('./sync').then((m) => m.onRemoteWipe());

export const api = createWorkoClient({
  baseUrl: apiBase(),
  tokens: { get: () => useSession.getState().tokens, set: (t) => useSession.getState().setTokens(t) },
  onWipe: () => void onWipe(),
  onSignedOut: () => useSession.getState().setTokens(null),
});

/** Unwraps an openapi-fetch result or throws with the server's message. */
export async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const r = await p;
  if (r.error !== undefined || !r.response.ok) {
    const e = r.error as { message?: string; code?: string } | undefined;
    throw Object.assign(new Error(e?.message ?? `HTTP ${r.response.status}`), { status: r.response.status, code: e?.code });
  }
  return r.data as T;
}
