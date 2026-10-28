import { render, screen, within } from '@testing-library/react';
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
  grants: [grant('clients', 'view'), ...['view', 'create', 'edit', 'approve', 'assign', 'export'].map((a) => grant('communication', a))] };
const CID = '0190a000-0000-7000-8000-0000000000c1';
const KID = '0190a000-0000-7000-8000-0000000000k1'.replace('k', 'a');
const SETTINGS = { consent: { transactionalRequiresOptIn: false, optOutBlocksTransactional: true }, quietHours: null, caps: { monthlyPaise: { email: null, whatsapp: null, sms: null }, perBroadcastPaise: null, mode: 'block' },
  broadcast: { approvalThreshold: 50, batchSize: 50, batchIntervalSeconds: 60 }, chat: { editWindowMinutes: 15, maxLength: 4000 }, appointments: { reminderMinutesBefore: [1440] } };

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };
let routes: Record<string, (c: Call) => Response>;
let calls: Call[];
class NoopWs { readyState = 0; onopen = null; onmessage = null; onclose = null; onerror = null; send() {} close() {} }

beforeEach(async () => {
  await stopSync(false);
  localStorage.clear();
  useSession.setState({ tokens: null, ready: false, notice: null });
  useToasts.setState({ toasts: [] });
  calls = [];
  routes = {
    'GET /me': () => json(200, ME),
    'GET /sync/pull': () => json(200, { changes: [], cursor: 0, hasMore: false }),
    'GET /users': () => json(200, []),
    'GET /comm/settings': () => json(200, SETTINGS),
    'GET /comm/templates': () => json(200, []),
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
const signIn = () => localStorage.setItem('worko.session', JSON.stringify(tokens));

describe('phase 7 timeline composer', () => {
  it('shows the opted-out consent and the server refusal reason', async () => {
    signIn();
    routes[`GET /clients/${CID}`] = () => json(200, { id: CID, name: 'Mehta Traders', entityType: 'PROPRIETORSHIP', status: 'active', tags: [], staffIds: [], groupIds: [], sensitive: false, version: 1,
      pan: null, primaryGstin: null, fileNo: null, email: null, phone: null, registrations: [], groups: [],
      contacts: [{ id: KID, name: 'Rakesh Mehta', email: 'rakesh@example.in', phone: '+919876543210', whatsapp: null, isPrimary: true }],
      counts: { documents: null, secrets: 0, inward: null, outward: null }, can: { edit: false, delete: false, reveal: false, vault: false } });
    routes[`GET /clients/${CID}/timeline`] = () => json(200, { clientId: CID, nextBefore: null, items: [
      { kind: 'message', id: 'm1', at: '2026-10-27T05:00:00Z', channel: 'sms', direction: 'in', title: null, body: 'STOP', status: 'received', address: '+919876543210', by: null, callMinutes: null, amountPaise: null, broadcastId: null },
    ] });
    routes['GET /comm/consents'] = () => json(200, [{ id: 'k', channel: 'sms', address: '+919876543210', clientId: CID, contactId: KID, status: 'opted_out', optedInAt: null, optedInSource: null,
      optedOutAt: '2026-10-27T05:00:00Z', optedOutSource: 'keyword:sms', keyword: 'STOP', note: null, updatedAt: '' }]);
    routes['POST /comm/messages'] = () => json(409, { message: 'Not sent: opted_out', code: 'opted_out' });
    location.hash = `#/clients/${CID}`;
    render(<App />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('tab', { name: 'Timeline' }));
    expect(await screen.findByText('STOP')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: /Send message/ }));
    const dlg = screen.getByRole('dialog', { name: 'Message Mehta Traders' });
    await u.selectOptions(within(dlg).getByLabelText('Channel'), 'sms');
    expect(within(dlg).getByTestId('compose-consent')).toHaveTextContent('Opted out');
    await u.click(within(dlg).getByLabelText('Free text'));
    await u.type(within(dlg).getByLabelText('Message'), 'Your GST return is filed.');
    await u.click(within(dlg).getByRole('button', { name: 'Send' }));
    expect(await within(dlg).findByTestId('compose-refusal')).toHaveTextContent('This contact has opted out of this channel.');
    expect(calls.find((c) => c.path === '/comm/messages')!.body).toEqual({ clientId: CID, channel: 'sms', contactId: KID, subject: null, body: 'Your GST return is filed.' });
  });
});

describe('phase 7 broadcasts', () => {
  it('runs the wizard: dry run totals, then send', async () => {
    signIn();
    const tpl = { id: '0190a000-0000-7000-8000-0000000000t1'.replace('t', 'b'), name: 'gst_reminder', channel: 'email', category: 'utility', language: 'en', subject: 'GST', body: 'Dear {{contact.name}}, {{period}} is due.',
      variables: ['contact.name', 'period'], sensitive: false, status: 'approved', providerRef: null, rejectionReason: null, dltTemplateId: null, version: 1 };
    routes['GET /comm/templates'] = () => json(200, [tpl]);
    routes['GET /comm/broadcasts'] = () => json(200, []);
    routes['GET /client-groups'] = () => json(200, []);
    routes['GET /service-types'] = () => json(200, []);
    const BID = '0190a000-0000-7000-8000-0000000000d1';
    routes['POST /comm/broadcasts'] = () => json(201, { id: BID });
    routes[`POST /comm/broadcasts/${BID}/preview`] = () => json(200, { audience: 10, eligible: 6, optedOut: 2, notOptedIn: 0, noContact: 1, duplicates: 1, overCap: 0, unitPaise: 25, costPaise: 150, capWarning: false, needsApproval: false, sample: [] });
    routes[`POST /comm/broadcasts/${BID}/send`] = () => json(200, { status: 'scheduled', scheduledAt: '2026-10-28T10:00:00Z' });
    routes[`GET /comm/broadcasts/${BID}`] = () => json(200, { id: BID, name: 'Oct GST', channel: 'email', templateId: tpl.id, category: 'utility', filters: {}, variables: {}, scheduledAt: '2026-10-28T10:00:00Z',
      status: 'scheduled', estimate: null, approvedBy: null, approvedAt: null, cancelledAt: null, completedAt: null, spentPaise: 0, createdBy: 'u1', createdAt: '', progress: { total: 9, done: 3, counts: { pending: 6, skipped_optout: 2, skipped_nocontact: 1 } } });
    routes[`GET /comm/broadcasts/${BID}/recipients`] = () => json(200, []);
    location.hash = '#/comm/broadcasts';
    render(<App />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: /New broadcast/ }));
    const dlg = screen.getByRole('dialog', { name: 'New broadcast' });
    await u.type(within(dlg).getByLabelText('Name'), 'Oct GST');
    await u.click(within(dlg).getByLabelText('Proprietorship'));
    await u.click(within(dlg).getByRole('button', { name: 'Next' }));
    await u.selectOptions(within(dlg).getByLabelText('Template'), tpl.id);
    await u.type(within(dlg).getByLabelText('period'), 'Oct 2026');
    await u.click(within(dlg).getByRole('button', { name: 'Next' }));
    await u.click(within(dlg).getByRole('button', { name: 'Dry run' }));
    expect(await within(dlg).findByTestId('bc-eligible')).toHaveTextContent('6');
    expect(within(dlg).getByTestId('bc-optedOut')).toHaveTextContent('2');
    expect(within(dlg).getByTestId('bc-noContact')).toHaveTextContent('1');
    expect(within(dlg).getByTestId('bc-cost')).toHaveTextContent('₹1.50');
    expect(calls.find((c) => c.method === 'POST' && c.path === '/comm/broadcasts')!.body).toEqual({ name: 'Oct GST', channel: 'email', templateId: tpl.id, filters: { entityTypes: ['PROPRIETORSHIP'] }, variables: { period: 'Oct 2026' }, scheduledAt: null });
    await u.click(within(dlg).getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('progressbar', { name: 'Progress' })).toHaveAttribute('aria-valuenow', '33');
    expect(calls.some((c) => c.path === `/comm/broadcasts/${BID}/send`)).toBe(true);
  });
});

describe('phase 7 public booking', () => {
  it('books a slot while logged out', async () => {
    const slots = ['2026-11-02T05:00:00.000Z', '2026-11-02T05:40:00.000Z', '2026-11-03T09:30:00.000Z'];
    routes['GET /book/demo/consult'] = () => json(200, { firm: 'Sharma & Co', title: 'Tax consultation', description: 'Ask us', slotMinutes: 30, from: '2026-10-29', to: '2026-11-11', slots });
    routes['POST /book/demo/consult'] = () => json(201, { id: 'ap1', startsAt: slots[1], endsAt: '2026-11-02T06:10:00.000Z', manageToken: 'tok123', manageUrl: 'x' });
    routes['GET /book/manage/tok123'] = () => json(200, { status: 'booked', startsAt: slots[1], endsAt: '2026-11-02T06:10:00.000Z', purpose: 'Capital gains', page: 'Tax consultation', slug: 'consult', firm: 'Sharma & Co' });
    location.hash = '#/book/demo/consult';
    render(<App />);
    const u = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Tax consultation' })).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: '11:10' }));
    expect(screen.getByTestId('picked')).toHaveTextContent('Selected');
    await u.type(screen.getByLabelText('Name'), 'Neha Desai');
    await u.type(screen.getByLabelText('Mobile'), '9876543210');
    await u.type(screen.getByLabelText('What would you like to discuss?'), 'Capital gains');
    await u.click(screen.getByRole('button', { name: 'Book' }));
    expect(await screen.findByTestId('booked')).toHaveTextContent('You are booked');
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ startsAt: slots[1], name: 'Neha Desai', email: null, phone: '9876543210', purpose: 'Capital gains', consent: false });
    expect(calls.some((c) => c.path === '/me')).toBe(false); // never touched the staff session
    await u.click(screen.getByRole('link', { name: 'Manage booking' }));
    expect(await screen.findByTestId('manage')).toHaveTextContent('Capital gains');
    expect(screen.getByRole('button', { name: 'Reschedule' })).toBeInTheDocument();
  });
});
