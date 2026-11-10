import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
export { normaliseServer } from './logic/server';

/** The server baked in at build time; the user can point the app elsewhere from the sign-in screen. */
export const DEFAULT_API_BASE = ((Constants.expoConfig?.extra?.apiBase as string | undefined) ?? 'http://10.0.2.2:3000/v1').replace(/\/+$/, '');
const SERVER_KEY = 'worko.server';
export let apiBase = DEFAULT_API_BASE;

export async function loadServer() {
  try { const v = await SecureStore.getItemAsync(SERVER_KEY); if (v) apiBase = v; } catch { /* default */ }
}
export async function setServer(url: string | null) {
  apiBase = url ?? DEFAULT_API_BASE;
  if (url && url !== DEFAULT_API_BASE) await SecureStore.setItemAsync(SERVER_KEY, url); else await SecureStore.deleteItemAsync(SERVER_KEY);
}
/** Requests are built against the default base; rewrite them to the chosen server. */
export const serverFetch: typeof fetch = (input, init) => {
  if (apiBase === DEFAULT_API_BASE) return fetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
  if (!url.startsWith(DEFAULT_API_BASE)) return fetch(input, init);
  const next = apiBase + url.slice(DEFAULT_API_BASE.length);
  return input instanceof Request ? fetch(new Request(next, input), init) : fetch(next, init);
};

export const serverBase = () => apiBase;
