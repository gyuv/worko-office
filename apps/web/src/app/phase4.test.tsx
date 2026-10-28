import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from '../lib/session';
import { useToasts } from '../components/Toast';
import { stopSync } from '../lib/sync';
import { App } from './App';

const tokens = { accessToken: 'a', refreshToken: 'r', expiresIn: 900, sessionId: 's1', userId: 'u1', tenantId: 't1' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const grant = (module: string, action: string) => ({ module, action, scope: 'all' });
const ME = { id: 'u1', name: 'Anita Sharma', email: 'a@x.in', firmName: 'F', firmSlug: 'sharma', roles: ['partner'], totpEnabled: false,
  grants: [grant('tasks', 'view'), grant('tasks', 'edit'), grant('tasks', 'create'), grant('tasks', 'assign'), grant('compliance', 'view'), grant('clients', 'view'), grant('clients', 'create'), grant('clients', 'edit'), grant('clients', 'export'), grant('registers', 'view'), grant('registers', 'create'), grant('registers', 'edit')] };

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };
let routes: Record<string, (c: Call) => Response>;
let calls: Call[];

class NoopWs { readyState = 0; onopen = null; onmessage = null; onclose = null; onerror = null; send() {} close() {} }
const saved = (['clientHeight', 'clientWidth'] as const).map((k) => [k, Object.getOwnPropertyDescriptor(Element.prototype, k)] as const);
beforeAll(() => {
  // jsdom has no layout; give the virtualised list a viewport so rows render.
  Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 800 });
});
afterAll(() => { for (const [k, d] of saved) if (d) Object.defineProperty(Element.prototype, k, d); });

beforeEach(async () => {
  await stopSync(false);
  localStorage.clear();
  localStorage.setItem('worko.session', JSON.stringify(tokens));
  useSession.setState({ tokens: null, ready: false, notice: null });
  calls = [];
  useToasts.setState({ toasts: [] });
  routes = {
    'GET /me': () => json(200, ME),
    'GET /sync/pull': () => json(200, { changes: [], cursor: 0, hasMore: false }),
    'GET /client-groups': () => json(200, []),
    'GET /service-types': () => json(200, []),
    'GET /users': () => json(200, []),
  };
  vi.stubGlobal('WebSocket', NoopWs);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    const path = u.pathname.replace(/^\/v1/, '');
    const ct = req.headers.get('content-type') ?? '';
    const body = req.method !== 'GET' && ct.includes('json') ? await req.clone().json().catch(() => undefined) : undefined;
    const c = { method: req.method, path, query: u.searchParams, body };
    calls.push(c);
    const h = routes[`${req.method} ${path}`] ?? Object.entries(routes).find(([k]) => k.endsWith('*') && `${req.method} ${path}`.startsWith(k.slice(0, -1)))?.[1];
    return h ? h(c) : json(404, { message: 'nf' });
  }));
});

const T1 = '11111111-0000-4000-8000-000000000001';
const T2 = '11111111-0000-4000-8000-000000000002';
const task = (id: string, title: string, o: Record<string, unknown> = {}) => ({ id, title, status: 'open', priority: 'normal', checks: [], source: 'auto', version: 1, clientId: null, clientName: 'Acme Traders', actBy: '2026-11-05', statutoryDue: '2026-11-11', createdAt: '2026-10-01T00:00:00Z', ...o });

describe('tasks list bulk edit', () => {
  it('applies a bulk status change and undoes it from the toast', async () => {
    routes['GET /tasks'] = () => json(200, { total: 2, items: [task(T1, 'GSTR-1 Sep'), task(T2, 'GSTR-3B Sep')] });
    routes['POST /tasks/bulk'] = () => json(200, { undoToken: '22222222-0000-4000-8000-000000000000', applied: 2, failed: [], expiresInSeconds: 600 });
    routes['POST /tasks/bulk/undo'] = () => json(200, { restored: 2, skipped: [] });
    location.hash = '#/tasks';
    render(<App />);
    const u = userEvent.setup();
    await u.click(await screen.findByLabelText('Select GSTR-1 Sep'));
    await u.click(screen.getByLabelText('Select GSTR-3B Sep'));
    const bar = screen.getByRole('region', { name: 'Bulk edit' });
    expect(within(bar).getByText('2 selected')).toBeInTheDocument();
    await u.selectOptions(within(bar).getByLabelText('To'), 'in_progress');
    await u.click(within(bar).getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('2 tasks updated, 0 skipped.')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/tasks/bulk')!.body).toEqual({ ids: [T1, T2], patch: { status: 'in_progress' } });
    await u.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('2 tasks restored, 0 skipped.')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/tasks/bulk/undo')!.body).toEqual({ undoToken: '22222222-0000-4000-8000-000000000000' });
  });
});

describe('kanban', () => {
  it('blocks done with pending required checks (toast) and patches allowed moves', async () => {
    routes['GET /tasks'] = () => json(200, { total: 1, items: [task(T1, 'GSTR-1 Sep', { checks: [{ key: 'k', label: 'Reconcile', required: true, done: false }] })] });
    routes[`PATCH /tasks/${T1}`] = () => new Response(null, { status: 204 });
    location.hash = '#/tasks';
    render(<App />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('tab', { name: 'Kanban' }));
    const col = await screen.findByRole('region', { name: 'Open' });
    expect(within(col).getByText('GSTR-1 Sep')).toBeInTheDocument();
    await u.selectOptions(within(col).getByLabelText('Move GSTR-1 Sep to'), 'done');
    expect(await screen.findByText('Tick all required checks before marking this done.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    await u.selectOptions(within(col).getByLabelText('Move GSTR-1 Sep to'), 'in_progress');
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'in_progress' }));
  });
  it('shows the server rule message when the server rejects a move', async () => {
    routes['GET /tasks'] = () => json(200, { total: 1, items: [task(T1, 'GSTR-1 Sep', { reviewerId: 'u9' })] });
    routes[`PATCH /tasks/${T1}`] = () => json(400, { statusCode: 400, code: 'person_cannot_see_task:reviewer_id', message: 'Rejected' });
    location.hash = '#/tasks';
    render(<App />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('tab', { name: 'Kanban' }));
    await u.selectOptions(await screen.findByLabelText('Move GSTR-1 Sep to'), 'review');
    expect(await screen.findByText('That person cannot see this client.')).toBeInTheDocument();
  });
});

describe('auto-create wizard', () => {
  it('previews then commits and shows counts', async () => {
    routes['GET /tasks'] = () => json(200, { total: 0, items: [] });
    routes['POST /tasks/auto/preview'] = () => json(200, { month: '2026-10', toCreate: 1, skipped: 3, items: [{ clientId: 'c', clientName: 'Acme Traders', serviceTypeId: 's', serviceKey: 'GSTR1', ruleId: 'gst.gstr1', form: 'GSTR-1', periodKey: '2026-10', periodLabel: 'Oct 2026', statutoryDue: '2026-11-11', actBy: '2026-11-08' }] });
    routes['POST /tasks/auto/commit'] = () => json(200, { month: '2026-10', created: 1, skipped: 3, ids: ['x'] });
    location.hash = '#/tasks';
    render(<App />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Auto-create' }));
    const dlg = await screen.findByRole('dialog');
    await u.clear(within(dlg).getByLabelText('Periods ending in'));
    await u.type(within(dlg).getByLabelText('Periods ending in'), '2026-10');
    await u.click(within(dlg).getByRole('button', { name: 'Preview' }));
    expect(await within(dlg).findByText('1 to create · 3 already exist')).toBeInTheDocument();
    expect(within(dlg).getByText('GSTR-1')).toBeInTheDocument();
    await u.click(within(dlg).getByRole('button', { name: 'Create 1 tasks' }));
    expect(await within(dlg).findByText('1 tasks created, 3 already existed.')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/tasks/auto/commit')!.body).toEqual({ month: '2026-10' });
  });
});

describe('compliance matrix', () => {
  it('renders coloured cells by state', async () => {
    routes['GET /compliance/matrix'] = (c) => json(200, { from: c.query.get('from'), to: c.query.get('to'), asOf: '2026-10-28',
      rules: [{ id: 'gst.gstr1', form: 'GSTR-1', title: 'x', regime: 'GST', verified: false }], clients: [{ id: 'c1', name: 'Acme Traders', fileNo: null }],
      cells: [{ clientId: 'c1', ruleId: 'gst.gstr1', periodKey: '2026-09', periodLabel: 'Sep 2026', statutoryDue: '2026-10-11', state: 'not_created', taskId: null }] });
    location.hash = '#/compliance';
    render(<App />);
    const cell = await screen.findByLabelText(/Acme Traders · GSTR-1 Sep 2026: Not created, past due/);
    expect(cell).toHaveAttribute('data-tone', 'missing');
  });
});
