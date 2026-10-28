import createClient, { type Middleware } from 'openapi-fetch';
import type { components, paths } from './schema.js';

export type { components, paths };
export type Schemas = components['schemas'];
export type TokenPair = Schemas['TokenPair'];

export type TokenStore = {
  get(): TokenPair | null;
  set(t: TokenPair | null): void;
};

export type ClientOptions = {
  baseUrl: string;
  tokens: TokenStore;
  /** Called when the server says this device must erase local data (remote wipe). */
  onWipe?: () => void;
  /** Called when the session can't be refreshed (logged out elsewhere, expired). */
  onSignedOut?: () => void;
  fetch?: typeof fetch;
};

/**
 * Typed client generated from docs/openapi.yaml. Adds the bearer token, and on 401 performs a single
 * refresh (deduplicated across concurrent requests) and retries once.
 */
export function createWorkoClient(o: ClientOptions) {
  // Resolved per call so polyfills or test stubs installed after creation are honoured.
  const f: typeof fetch = (input, init) => (o.fetch ?? globalThis.fetch)(input, init);
  let refreshing: Promise<boolean> | null = null;

  async function refresh(): Promise<boolean> {
    const t = o.tokens.get();
    if (!t) return false;
    const res = await f(`${o.baseUrl}/auth/refresh`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: t.refreshToken }),
    });
    if (res.ok) { o.tokens.set(await res.json()); return true; }
    const body = await res.json().catch(() => ({}));
    o.tokens.set(null);
    if (body?.code === 'DEVICE_WIPE') o.onWipe?.(); else o.onSignedOut?.();
    return false;
  }

  const auth: Middleware = {
    onRequest({ request }) {
      const t = o.tokens.get();
      if (t && !request.headers.has('authorization')) request.headers.set('authorization', `Bearer ${t.accessToken}`);
      return request;
    },
  };

  const retrying: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const retry = req.clone();
    const res = await f(req);
    if (res.status !== 401 || req.url.includes('/auth/')) return res;
    const body = await res.clone().json().catch(() => ({}));
    if (body?.code === 'DEVICE_WIPE') { o.tokens.set(null); o.onWipe?.(); return res; }
    refreshing ??= refresh().finally(() => { refreshing = null; });
    if (!(await refreshing)) return res;
    retry.headers.set('authorization', `Bearer ${o.tokens.get()!.accessToken}`);
    return f(retry);
  };

  const client = createClient<paths>({ baseUrl: o.baseUrl, fetch: retrying });
  client.use(auth);
  return client;
}

export type WorkoClient = ReturnType<typeof createWorkoClient>;
export { createHttpTransport } from './transport.js';
