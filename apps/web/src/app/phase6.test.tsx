import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from '../lib/session';
import { useToasts } from '../components/Toast';
import { stopSync } from '../lib/sync';
import { App } from './App';

const tokens = { accessToken: 'a', refreshToken: 'r', expiresIn: 900, sessionId: 's1', userId: 'u1', tenantId: 't1' };
const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const grant = (module: string, action: string) => ({ module, action, scope: 'all' });
const ME = { id: 'u1', name: 'Anita Sharma', email: 'a@x.in', firmName: 'F', firmSlug: 'sharma', roles: ['partner'], totpEnabled: false,
  grants: [grant('tasks', 'view'), grant('clients', 'view'), grant('time', 'view'), grant('time', 'edit'), grant('time', 'approve'), grant('hr', 'view'), grant('hr', 'edit'), grant('hr', 'approve'), grant('reports', 'view')] };

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };
let routes: Record<string, (c: Call) => Response>;
let calls: Call[];
class NoopWs { readyState = 0; onopen = null; onmessage = null; onclose = null; onerror = null; send() {} close() {} }

beforeEach(async () => {
  await stopSync(false);
  localStorage.clear();
  localStorage.setItem('worko.session', JSON.stringify(tokens));
  useSession.setState({ tokens: null, ready: false, notice: null });
  useToasts.setState({ toasts: [] });
  calls = [];
  routes = {
    'GET /me': () => json(200, ME),
    'GET /sync/pull': () => json(200, { changes: [], cursor: 0, hasMore: false }),
    'GET /users': () => json(200, []),
    'GET /tasks': () => json(200, { total: 0, items: [] }),
    'GET /time/timer': () => json(200, null),
    'GET /time/entries': () => json(200, { total: 0, totalMinutes: 0, items: [] }),
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
    const h = routes[`${req.method} ${path}`];
    return h ? h(c) : json(404, { message: 'nf' });
  }));
});

describe('phase 6 timer', () => {
  it('starts a timer from the header and stops it into a draft entry', async () => {
    let running: null | { id: string; taskId: null; clientId: null; notes: string | null; billable: boolean; startedAt: string; deviceStartedAt: null } = null;
    routes['GET /time/timer'] = () => json(200, running);
    routes['POST /time/timer/start'] = (c) => { running = { id: 'tm1', taskId: null, clientId: null, notes: (c.body as { notes: string }).notes, billable: true, startedAt: new Date(Date.now() - 65_000).toISOString(), deviceStartedAt: null }; return json(201, { id: 'tm1' }); };
    routes['POST /time/timer/stop'] = () => { running = null; return json(200, { entryId: 'e1', minutes: 25, capped: false }); };
    location.hash = '#/time';
    render(<App />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Start timer' }));
    const dlg = screen.getByRole('dialog', { name: 'Start a timer' });
    await u.type(within(dlg).getByLabelText('Notes'), 'Internal review');
    await u.click(within(dlg).getByRole('button', { name: 'Start timer' }));
    expect(await screen.findByRole('timer', { name: 'Timer running' })).toBeInTheDocument();
    expect(screen.getByTestId('timer-elapsed').textContent).toMatch(/^0:01:0\d$/);
    expect(calls.find((c) => c.path === '/time/timer/start')!.body).toMatchObject({ taskId: null, clientId: null, notes: 'Internal review', billable: true, deviceAt: expect.any(String) });
    await u.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Timer stopped — 0:25 saved as a draft.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Start timer' })).toBeInTheDocument();
  });
});

describe('phase 6 leave', () => {
  it('previews working days, applies, then a manager partially approves', async () => {
    const type = { id: 'lt1', key: 'casual', name: 'Casual leave', paid: true, tracked: true, appliesToRoles: [], accrual: { kind: 'monthly', days: 1 }, carryForwardCap: null, allowHalfDay: true, maxDaysPerRequest: null, compOff: false, active: true, sort: 0, notes: null };
    const req = (o: object) => ({ id: 'r2', userId: 'u2', userName: 'Ravi Kumar', leaveTypeId: 'lt1', leaveTypeKey: 'casual', from: '2026-11-02', to: '2026-11-06', startHalf: false, endHalf: false, days: 5, reason: 'Wedding', status: 'pending', approvedFrom: null, approvedTo: null, approvedDays: null, decisionNote: null, ...o });
    routes['GET /hr/leave-types'] = () => json(200, [type]);
    routes['GET /hr/settings'] = () => json(200, { attendance: { mode: 'geofence', outside: 'flag', ipAllowList: [], skewFlagMinutes: 10 }, workWeek: { weekendDays: [0], excludeWeekends: true, excludeHolidays: true }, capacity: { defaultWeeklyMinutes: 2400 }, timer: { capMinutes: 720 }, compOff: { enabled: true, typeKey: 'comp_off', halfDayMinutes: 240, fullDayMinutes: 420, expiryDays: 90 } });
    routes['GET /hr/holidays'] = () => json(200, [{ id: 'h1', date: '2026-11-04', name: 'Diwali', branchId: null, optional: false }]);
    routes['GET /hr/leave/balances'] = () => json(200, { userId: 'u1', asOf: '2026-10-28', balances: [{ leaveType: type, balance: 8, pending: 0, available: 8, expiring: [] }] });
    routes['GET /hr/leave/requests'] = (c) => json(200, c.query.get('status') === 'pending' ? [req({})] : []);
    routes['POST /hr/leave/requests'] = () => json(201, { id: 'r1', days: 5 });
    routes['POST /hr/leave/requests/r2/decide'] = () => json(200, { status: 'partially_approved', approvedDays: 2 });
    location.hash = '#/leave';
    render(<App />);
    const u = userEvent.setup();
    expect(await screen.findByTestId('bal-casual')).toHaveTextContent('8');
    await u.click(screen.getByRole('button', { name: 'Apply for leave' }));
    const dlg = screen.getByRole('dialog', { name: 'Apply for leave' });
    fireEvent.change(within(dlg).getByLabelText('From'), { target: { value: '2026-11-02' } });
    fireEvent.change(within(dlg).getByLabelText('To'), { target: { value: '2026-11-08' } });
    await u.click(within(dlg).getByLabelText('Last day half'));
    // Mon 2 → Sun 8: Sunday off, Wed 4 holiday → 5 days, last day (Sunday) not counted so the half has no effect.
    expect(await within(dlg).findByText('5 working day(s)')).toBeInTheDocument();
    expect(within(dlg).getByTestId('leave-preview')).toHaveTextContent('Diwali');
    await u.click(within(dlg).getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Applied for 5 day(s)')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/hr/leave/requests')!.body).toEqual({ leaveTypeId: 'lt1', from: '2026-11-02', to: '2026-11-08', startHalf: false, endHalf: true, reason: null });

    await u.click(screen.getByRole('tab', { name: 'Approvals' }));
    await u.click(await screen.findByRole('button', { name: 'Decide' }));
    const d2 = screen.getByRole('dialog', { name: 'Leave for Ravi Kumar' });
    await u.click(within(d2).getByLabelText('Approve part'));
    fireEvent.change(within(d2).getByLabelText('Approve to'), { target: { value: '2026-11-04' } });
    expect(await within(d2).findByText('Approves 2 day(s)')).toBeInTheDocument();
    await u.click(within(d2).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Partly approved — 2 day(s)')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/hr/leave/requests/r2/decide')!.body).toEqual({ approve: true, approvedFrom: '2026-11-02', approvedTo: '2026-11-04', startHalf: false, endHalf: false, note: null });
  });
});
