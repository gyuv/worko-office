import { describe, expect, it, vi } from 'vitest';
import { createWorkoClient, type TokenPair } from './index.js';

const pair = (n: number): TokenPair => ({ accessToken: `a${n}`, refreshToken: `r${n}`, expiresIn: 900, sessionId: 's', userId: 'u', tenantId: 't' });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(handler: (url: string, auth: string | null) => Response) {
  let tokens: TokenPair | null = pair(1);
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(`${new URL(req.url).pathname} ${req.headers.get('authorization') ?? '-'}`);
    return handler(new URL(req.url).pathname, req.headers.get('authorization'));
  });
  const onWipe = vi.fn(); const onSignedOut = vi.fn();
  const client = createWorkoClient({ baseUrl: 'http://api/v1', fetch, onWipe, onSignedOut, tokens: { get: () => tokens, set: (t) => { tokens = t; } } });
  return { client, calls, onWipe, onSignedOut, tokens: () => tokens };
}

describe('api client', () => {
  it('refreshes once on 401 and retries with the new token', async () => {
    const t = setup((url, auth) => url.endsWith('/auth/refresh') ? json(200, pair(2)) : auth === 'Bearer a2' ? json(200, { name: 'A' }) : json(401, {}));
    const { data } = await t.client.GET('/me');
    expect(data).toMatchObject({ name: 'A' });
    expect(t.calls).toEqual(['/v1/me Bearer a1', '/v1/auth/refresh -', '/v1/me Bearer a2']);
  });
  it('dedupes concurrent refreshes', async () => {
    const t = setup((url, auth) => url.endsWith('/auth/refresh') ? json(200, pair(2)) : auth === 'Bearer a2' ? json(200, []) : json(401, {}));
    await Promise.all([t.client.GET('/me'), t.client.GET('/users'), t.client.GET('/roles')]);
    expect(t.calls.filter((c) => c.includes('refresh'))).toHaveLength(1);
  });
  it('signals remote wipe and clears tokens', async () => {
    const t = setup(() => json(401, { code: 'DEVICE_WIPE' }));
    await t.client.GET('/me');
    expect(t.onWipe).toHaveBeenCalled();
    expect(t.tokens()).toBeNull();
  });
  it('signs out when refresh fails', async () => {
    const t = setup(() => json(401, {}));
    await t.client.GET('/me');
    expect(t.onSignedOut).toHaveBeenCalled();
  });
});
