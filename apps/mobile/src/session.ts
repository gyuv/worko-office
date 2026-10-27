import { createWorkoClient, type TokenPair } from '@worko/api-client';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

const KEY = 'worko.session';
/** Encrypted with a key held in the Android Keystore. */
const storage = {
  load: async (): Promise<TokenPair | null> => { try { return JSON.parse((await SecureStore.getItemAsync(KEY)) ?? 'null'); } catch { return null; } },
  save: (t: TokenPair | null) => (t ? SecureStore.setItemAsync(KEY, JSON.stringify(t)) : SecureStore.deleteItemAsync(KEY)),
};

type State = { tokens: TokenPair | null; ready: boolean; wiped: boolean; setTokens(t: TokenPair | null): void; init(): Promise<void> };

export const useSession = create<State>((set) => ({
  tokens: null, ready: false, wiped: false,
  setTokens(t) { set({ tokens: t }); void storage.save(t); },
  async init() { set({ tokens: await storage.load(), ready: true }); },
}));

export const apiBase = (Constants.expoConfig?.extra?.apiBase as string | undefined) ?? 'http://10.0.2.2:3000/v1';

export const api = createWorkoClient({
  baseUrl: apiBase,
  tokens: { get: () => useSession.getState().tokens, set: (t) => useSession.getState().setTokens(t) },
  // Remote wipe: tokens are cleared by the client; the local SQLite store (Phase 2) is deleted here too.
  onWipe: () => useSession.setState({ tokens: null, wiped: true }),
  onSignedOut: () => useSession.getState().setTokens(null),
});

export async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const r = await p;
  if (r.error !== undefined || !r.response.ok) {
    const e = r.error as { message?: string; code?: string } | undefined;
    throw Object.assign(new Error(e?.message ?? `HTTP ${r.response.status}`), { status: r.response.status, code: e?.code });
  }
  return r.data as T;
}
