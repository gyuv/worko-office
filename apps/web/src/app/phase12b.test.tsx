import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from '../lib/session';
import { stopSync } from '../lib/sync';
import { App } from './App';

const staff = { accessToken: 'STAFF', refreshToken: 'r', expiresIn: 900, sessionId: 's1', userId: 'u1', tenantId: 't1' };
const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ME = { id: 'u1', name: 'Anita', email: 'a@x.in', firmName: 'Demo', firmSlug: 'demo', roles: ['partner'], totpEnabled: false,
  grants: ['settings', 'clients', 'tasks'].flatMap((m) => ['view', 'create', 'edit'].map((a) => ({ module: m, action: a, scope: 'all' }))) };
const KID = '0190a000-0000-7000-8000-0000000000a1';
const HID = '0190a000-0000-7000-8000-0000000000b1';
const KEY = { id: KID, name: 'Tally bridge', prefix: 'demo123abc', scopes: ['clients:view'], clientGroupIds: null, ipAllowlist: [], ratePerMin: 120, expiresAt: null, createdBy: 'u1', createdByName: 'Anita',
  createdAt: '2026-10-29T05:00:00Z', rotatedAt: null, revokedAt: null, lastUsedAt: null, lastUsedIp: null, status: 'active' };
const HOOK = { id: HID, name: 'ERP', url: 'https://hooks.example.com/w', events: ['task.created'], status: 'disabled', disabledReason: 'too_many_failures', consecutiveFailures: 5, createdBy: 'u1', createdAt: '', lastDeliveryAt: null };

type Call = { method: string; path: string; body: unknown };
let routes: Record<string, (c: Call) => Response>;
let calls: Call[];
class NoopWs { readyState = 0; onopen = null; onmessage = null; onclose = null; onerror = null; send() {} close() {} }

beforeEach(async () => {
  await stopSync(false);
  localStorage.clear();
  localStorage.setItem('worko.session', JSON.stringify(staff));
  useSession.setState({ tokens: null, ready: false, notice: null });
  calls = [];
  routes = {
    'GET /me': () => json(200, ME), 'GET /sync/pull': () => json(200, { changes: [], cursor: 0, hasMore: false }), 'GET /users': () => json(200, []),
    'GET /developers/catalogue': () => json(200, { scopes: ['clients:view', 'clients:create', 'tasks:view'], events: ['task.created', 'invoice.issued'], docsUrl: '/v1/public-api/openapi.json' }),
    'GET /developers/api-keys': () => json(200, { items: [KEY] }), 'GET /developers/webhooks': () => json(200, { items: [HOOK] }),
    [`GET /developers/webhooks/${HID}/deliveries`]: () => json(200, { total: 1, items: [{ id: 'd1', subscriptionId: HID, eventId: 'e1', eventType: 'task.created', redeliveryOf: null, status: 'failed', attempts: 8, nextAttemptAt: null, lastStatusCode: 503, lastError: 'http_503', lastDurationMs: 100, createdAt: '2026-10-29T05:00:00Z', deliveredAt: null }] }),
  };
  vi.stubGlobal('WebSocket', NoopWs);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname.replace(/^\/v1/, '');
    const body = req.method !== 'GET' && (req.headers.get('content-type') ?? '').includes('json') ? await req.clone().json().catch(() => undefined) : undefined;
    const c = { method: req.method, path, body };
    calls.push(c);
    const h = routes[`${req.method} ${path}`];
    return h ? h(c) : json(404, { message: 'nf' });
  }));
});

describe('phase 12 B — Settings → Developers', () => {
  it('creates an API key with scopes + allow-list and shows the secret once', async () => {
    routes['POST /developers/api-keys'] = () => json(201, { key: { ...KEY, id: 'new' }, secret: 'wk_abcdefghij_' + 's'.repeat(43) });
    location.hash = '#/settings/developers';
    render(<App />);
    const u = userEvent.setup();
    expect(await screen.findByText('Tally bridge')).toBeInTheDocument();
    expect(screen.getByText('wk_demo123abc_…')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: /New API key/ }));
    const dlg = await screen.findByRole('dialog');
    await u.type(within(dlg).getByLabelText('Name'), 'ERP sync');
    await u.type(within(dlg).getByLabelText('IP allow-list'), 'bad/99');
    expect(within(dlg).getByText('Not valid: bad/99')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Create key' })).toBeDisabled();
    await u.clear(within(dlg).getByLabelText('IP allow-list'));
    await u.type(within(dlg).getByLabelText('IP allow-list'), '203.0.113.0/24');
    await u.click(within(dlg).getByRole('button', { name: 'Create key' }));
    expect(await screen.findByTestId('secret')).toHaveTextContent(/^wk_abcdefghij_/);
    const post = calls.find((c) => c.method === 'POST' && c.path === '/developers/api-keys')!;
    expect(post.body).toMatchObject({ name: 'ERP sync', scopes: ['clients:view', 'tasks:view'], ipAllowlist: ['203.0.113.0/24'], expiresAt: null });
  });

  it('webhooks: shows auto-disabled state, delivery log and redeliver', async () => {
    routes['POST /developers/webhook-deliveries/d1/redeliver'] = () => json(202, { id: 'd2' });
    location.hash = '#/settings/developers';
    render(<App />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('tab', { name: 'Webhooks' }));
    expect(await screen.findByText('Disabled (too_many_failures)')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Show delivery log' }));
    const log = await screen.findByRole('table', { name: 'Delivery log' });
    expect(within(log).getByText('503')).toBeInTheDocument();
    await u.click(within(log).getByRole('button', { name: 'Redeliver' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/developers/webhook-deliveries/d1/redeliver')).toBe(true));
  });
});
