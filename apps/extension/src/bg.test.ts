import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PopupResponse } from './messages.js';

type Store = Record<string, unknown>;
function area(data: Store) {
  return {
    data,
    get: vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in data).map((k) => [k, data[k]]))),
    set: vi.fn(async (o: Store) => { Object.assign(data, o); }),
    clear: vi.fn(async () => { for (const k of Object.keys(data)) delete data[k]; }),
  };
}

const TOKENS = { accessToken: 'at', refreshToken: 'rt', expiresIn: 900, sessionId: 's', userId: 'u', tenantId: 't' };
const GST_URL = 'https://services.gst.gov.in/services/login';
const SECRET = { id: 'sec1', clientId: 'c1', clientName: 'Acme Pvt Ltd', portal: 'GST', label: 'GST login', usernameHint: 'ac***01', createdAt: '2026-01-01' };

let session: ReturnType<typeof area>;
let local: ReturnType<typeof area>;
let tab: { id: number; url?: string };
let tabNow: { id: number; url?: string } | null;
let sendMessage: ReturnType<typeof vi.fn>;
let calls: { method: string; path: string; body: unknown; auth: string | null }[];
let routes: Record<string, (body: unknown) => [number, unknown]>;

function json(status: number, body: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  vi.resetModules();
  session = area({});
  local = area({});
  tab = { id: 7, url: GST_URL };
  tabNow = null;
  sendMessage = vi.fn(async () => ({ ok: true, filled: 2 }));
  calls = [];
  routes = {
    'POST /v1/auth/extension/pair': () => [200, TOKENS],
    'GET /v1/vault/secrets': () => [200, [SECRET]],
    'POST /v1/vault/secrets/sec1/reveal': () => [200, { username: 'ACME01', password: 'Sup3r$ecret' }],
    'POST /v1/auth/step-up': () => [200, { elevatedUntil: '2026-10-27T10:05:00Z' }],
    'POST /v1/auth/logout': () => [204, undefined],
  };
  vi.stubGlobal('chrome', {
    runtime: { id: 'ext-id' },
    storage: { session, local, sync: area({}) },
    tabs: {
      query: vi.fn(async () => [tab]),
      get: vi.fn(async () => tabNow ?? tab),
      sendMessage,
    },
  });
  vi.stubGlobal('fetch', vi.fn(async (input: Request | string, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const u = new URL(req.url);
    const text = await req.text();
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ method: req.method, path: u.pathname + u.search, body, auth: req.headers.get('authorization') });
    const route = routes[`${req.method} ${u.pathname}`];
    if (!route) return json(404, { statusCode: 404, message: 'nope' });
    const [status, resBody] = route(body);
    return json(status, resBody);
  }));
});

async function bg() { return import('./bg.js'); }
async function paired() { session.data.tokens = TOKENS; return bg(); }

describe('background message handler', () => {
  it('pairing stores tokens in session storage only; settings in local', async () => {
    const { handle } = await bg();
    const r = await handle({ type: 'pair', apiBase: 'http://localhost:3000/v1/', firm: 'demo', code: 'ABCD-1234' });
    expect(r).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/auth/extension/pair', body: { firm: 'demo', code: 'ABCD-1234' } });
    expect(session.data.tokens).toEqual(TOKENS);
    expect(local.data).toEqual({ apiBase: 'http://localhost:3000/v1', firm: 'demo' });
    expect(JSON.stringify(local.data)).not.toContain('at');
    expect((chrome.storage.sync as unknown as ReturnType<typeof area>).set).not.toHaveBeenCalled();
  });

  it('rejects a plain-http non-local API base', async () => {
    const { handle } = await bg();
    expect((await handle({ type: 'pair', apiBase: 'http://evil.example/v1', firm: 'demo', code: 'x' })).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('pair failure does not store tokens', async () => {
    routes['POST /v1/auth/extension/pair'] = () => [401, { statusCode: 401, message: 'bad', code: 'INVALID_CODE' }];
    const { handle } = await bg();
    expect(await handle({ type: 'pair', apiBase: 'http://localhost:3000/v1', firm: 'demo', code: 'x' })).toMatchObject({ ok: false, error: 'INVALID_CODE' });
    expect(session.data.tokens).toBeUndefined();
  });

  it('status reports the active tab portal; non-portal is null', async () => {
    const { handle } = await paired();
    expect(await handle({ type: 'status' })).toMatchObject({ ok: true, paired: true, portal: 'GST' });
    tab = { id: 7, url: 'https://services.gst.gov.in.evil.com/' };
    expect(await handle({ type: 'status' })).toMatchObject({ portal: null });
  });

  it('listing uses the portal from the active tab URL with the bearer token', async () => {
    const { handle } = await paired();
    tab = { id: 3, url: 'https://eportal.incometax.gov.in/iec/foservices/' };
    routes['GET /v1/vault/secrets'] = () => [200, [{ ...SECRET, portal: 'INCOME_TAX' }]];
    const r = await handle({ type: 'list', q: 'acme' });
    expect(calls[0]!.path).toBe('/v1/vault/secrets?portal=INCOME_TAX&q=acme');
    expect(calls[0]!.auth).toBe('Bearer at');
    expect(r).toEqual({ ok: true, secrets: [{ id: 'sec1', clientName: 'Acme Pvt Ltd', label: 'GST login', usernameHint: 'ac***01', portal: 'INCOME_TAX' }] });
  });

  it('listing on a non-portal tab makes no API call', async () => {
    const { handle } = await paired();
    tab = { id: 3, url: 'https://example.com/' };
    expect(await handle({ type: 'list' })).toEqual({ ok: true, secrets: [] });
    expect(calls).toHaveLength(0);
  });

  it('fill: STEP_UP_REQUIRED → needsStepUp; after step-up reveal uses {autofill, tab.url} and sends to that tab frame 0', async () => {
    let elevated = false;
    routes['POST /v1/vault/secrets/sec1/reveal'] = () => elevated
      ? [200, { username: 'ACME01', password: 'Sup3r$ecret' }]
      : [403, { statusCode: 403, message: 'step up', code: 'STEP_UP_REQUIRED' }];
    routes['POST /v1/auth/step-up'] = (b) => { elevated = (b as { totp?: string }).totp === '123456'; return [200, { elevatedUntil: 'x' }]; };
    const { handle } = await paired();

    expect(await handle({ type: 'fill', secretId: 'sec1' })).toMatchObject({ ok: false, needsStepUp: true });
    expect(sendMessage).not.toHaveBeenCalled();

    expect(await handle({ type: 'stepUp', totp: '123456' })).toEqual({ ok: true });
    expect(calls.at(-1)).toMatchObject({ path: '/v1/auth/step-up', body: { totp: '123456' } });

    expect(await handle({ type: 'fill', secretId: 'sec1' })).toEqual({ ok: true, filled: 2 });
    const reveal = calls.filter((c) => c.path === '/v1/vault/secrets/sec1/reveal').at(-1)!;
    expect(reveal.body).toEqual({ purpose: 'autofill', pageUrl: GST_URL });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [tabId, msg, opts] = sendMessage.mock.calls[0]!;
    expect(tabId).toBe(7);
    expect(opts).toEqual({ frameId: 0 });
    expect(msg).toMatchObject({ type: 'worko:fill', portal: 'GST' });
    // Nothing secret persisted anywhere.
    expect(JSON.stringify([session.data, local.data])).not.toContain('Sup3r$ecret');
  });

  it('a tab on a non-allow-listed URL never receives credentials', async () => {
    const { handle } = await paired();
    for (const url of ['https://example.com/', 'http://services.gst.gov.in/', 'https://services.gst.gov.in.evil.com/']) {
      tab = { id: 9, url };
      expect((await handle({ type: 'fill', secretId: 'sec1' })).ok).toBe(false);
    }
    expect(calls.some((c) => c.path.includes('/reveal'))).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('a tab that navigates away during reveal never receives credentials', async () => {
    const { handle } = await paired();
    tabNow = { id: 7, url: 'https://phish.example/login' };
    const r: PopupResponse = await handle({ type: 'fill', secretId: 'sec1' });
    expect(r).toMatchObject({ ok: false, error: 'NOT_PORTAL' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a secret that belongs to another portal', async () => {
    routes['GET /v1/vault/secrets'] = () => [200, [{ ...SECRET, portal: 'MCA' }]];
    const { handle } = await paired();
    expect((await handle({ type: 'fill', secretId: 'sec1' })).ok).toBe(false);
    expect(calls.some((c) => c.path.includes('/reveal'))).toBe(false);
  });

  it('sign-out calls logout and clears session storage', async () => {
    const { handle } = await paired();
    session.data.other = 'x';
    expect(await handle({ type: 'signOut' })).toEqual({ ok: true });
    expect(calls.at(-1)!.path).toBe('/v1/auth/logout');
    expect(session.data).toEqual({});
    expect(await handle({ type: 'status' })).toMatchObject({ paired: false });
  });

  it('DEVICE_WIPE clears session storage', async () => {
    routes['GET /v1/vault/secrets'] = () => [401, { statusCode: 401, message: 'wipe', code: 'DEVICE_WIPE' }];
    const { handle } = await paired();
    expect(await handle({ type: 'list' })).toMatchObject({ ok: false, signedOut: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(session.data).toEqual({});
  });

  it('only trusts messages from its own extension pages', async () => {
    const { isTrustedSender } = await bg();
    expect(isTrustedSender({ id: 'ext-id' })).toBe(true);
    expect(isTrustedSender({ id: 'ext-id', tab: { id: 1 } as chrome.tabs.Tab })).toBe(false);
    expect(isTrustedSender({ id: 'other' })).toBe(false);
  });
});
