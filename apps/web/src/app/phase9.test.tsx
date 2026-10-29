import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { defaultPortalGrants } from '@worko/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from '../lib/session';
import { stopSync } from '../lib/sync';
import { usePortalSession } from '../portal/http';
import { App } from './App';

const staff = { accessToken: 'STAFF', refreshToken: 'r', expiresIn: 900, sessionId: 's1', userId: 'u1', tenantId: 't1' };
const portalTok = { accessToken: 'PORTAL', refreshToken: 'pr-xxxxxxxxxxxxxxxxxxxxxxxx', expiresIn: 900, sessionId: 'ps1', portalUserId: 'pu1', tenantId: 't1' };
const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const grant = (module: string, action: string) => ({ module, action, scope: 'all' });
const ME = { id: 'u1', name: 'Anita', email: 'a@x.in', firmName: 'Demo', firmSlug: 'demo', roles: ['partner'], totpEnabled: false,
  grants: ['view', 'create', 'edit', 'approve'].map((a) => grant('leads', a)).concat([grant('clients', 'view')]) };
const CID = '0190a000-0000-7000-8000-0000000000c1';
const PID = '0190a000-0000-7000-8000-0000000000b1';
const BRAND = { firm: 'demo', displayName: 'Sharma & Co', accent: 'teal', logoUrl: null, supportEmail: null, supportPhone: null, welcomeText: null };
const PME = { user: { id: 'pu1', name: 'Ravi', email: 'ravi@x.in', phone: null }, clients: [{ id: CID, name: 'Mehta Traders', grants: defaultPortalGrants() }], branding: BRAND };

type Call = { method: string; path: string; auth: string | null; body: unknown };
let routes: Record<string, (c: Call) => Response>;
let calls: Call[];
class NoopWs { readyState = 0; onopen = null; onmessage = null; onclose = null; onerror = null; send() {} close() {} }

beforeEach(async () => {
  await stopSync(false);
  localStorage.clear();
  useSession.setState({ tokens: null, ready: false, notice: null });
  usePortalSession.setState({ firm: null, tokens: null });
  calls = [];
  routes = {
    'GET /me': () => json(200, ME), 'GET /sync/pull': () => json(200, { changes: [], cursor: 0, hasMore: false }), 'GET /users': () => json(200, []),
    'GET /portal/branding/demo': () => json(200, BRAND), 'GET /portal/me': () => json(200, PME),
    [`GET /portal/clients/${CID}/dashboard`]: () => json(200, { client: { id: CID, name: 'Mehta Traders' }, pendingRequests: [], outstanding: { totalPaise: 1_18_000_00, invoices: [] }, recentDocuments: [] }),
  };
  vi.stubGlobal('WebSocket', NoopWs);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname.replace(/^\/v1/, '');
    const ct = req.headers.get('content-type') ?? '';
    const body = req.method !== 'GET' && ct.includes('json') ? await req.clone().json().catch(() => undefined) : undefined;
    const c = { method: req.method, path, auth: req.headers.get('authorization'), body };
    calls.push(c);
    const h = routes[`${req.method} ${path}`];
    return h ? h(c) : json(404, { message: 'nf' });
  }));
});

describe('phase 9 client portal', () => {
  it('OTP login → dashboard, with neutral "sent" text and no staff token', async () => {
    localStorage.setItem('worko.session', JSON.stringify(staff)); // a staff session on the same browser must not leak into the portal
    routes['POST /portal/auth/otp/request'] = () => json(202, { sent: true });
    let tries = 0;
    routes['POST /portal/auth/otp/verify'] = (c) => (++tries === 1 ? json(401, { message: 'Invalid or expired code' }) : (expect((c.body as { code: string }).code).toBe('654321'), json(200, portalTok)));
    location.hash = '#/portal/demo';
    render(<App />);
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Email or mobile number'), 'ravi@x.in');
    await u.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(/If ravi@x.in is registered/)).toBeInTheDocument();
    expect(screen.getByText(/New code in \d+s/)).toBeInTheDocument();
    await u.type(screen.getByLabelText('6-digit code'), '123456');
    await u.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/not valid or has expired/)).toBeInTheDocument();
    await u.type(screen.getByLabelText('6-digit code'), '654321');
    await u.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByTestId('outstanding')).toHaveTextContent('1,18,000');
    expect(JSON.parse(localStorage.getItem('worko.portal.demo')!).accessToken).toBe('PORTAL');
    for (const c of calls) expect(c.auth).not.toBe('Bearer STAFF');
    expect(calls.find((c) => c.path === '/portal/me')!.auth).toBe('Bearer PORTAL');
    expect(calls.some((c) => !c.path.startsWith('/portal/'))).toBe(false);
  });

  it('429 shows a countdown and disables sign-in', async () => {
    routes['POST /portal/auth/otp/request'] = () => json(202, { sent: true });
    routes['POST /portal/auth/otp/verify'] = () => new Response(JSON.stringify({ message: 'Too Many Requests' }), { status: 429, headers: { 'retry-after': '42' } });
    location.hash = '#/portal/demo';
    render(<App />);
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Email or mobile number'), '9876543210');
    await u.click(screen.getByRole('button', { name: 'Send code' }));
    await u.type(await screen.findByLabelText('6-digit code'), '123456');
    await u.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/Try again in 4\ds/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    expect(screen.queryByText(/locked/i)).toBeNull();
  });

  it('upload with progress lands in "Uploaded by you"', async () => {
    localStorage.setItem('worko.portal.demo', JSON.stringify(portalTok));
    let docs: unknown[] = [];
    routes[`GET /portal/clients/${CID}/documents`] = () => json(200, docs);
    const sent: Array<{ url: string; auth: string | null; file: unknown }> = [];
    class FakeXhr {
      status = 0; responseText = ''; upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null; onerror: (() => void) | null = null; private h: Record<string, string> = {}; private url = '';
      open(_m: string, url: string) { this.url = url; }
      setRequestHeader(k: string, v: string) { this.h[k] = v; }
      send(fd: FormData) {
        sent.push({ url: this.url, auth: this.h.authorization ?? null, file: (fd.get('file') as File).name });
        this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
        docs = [{ id: 'd1', name: 'bank.pdf', category: 'From client', fy: null, mime: 'application/pdf', size: 2048, currentVersion: 1, createdAt: '2026-10-29T05:00:00Z', fromClient: true }];
        setTimeout(() => { this.status = 201; this.responseText = '{"id":"d1"}'; this.onload?.(); }, 0);
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    location.hash = `#/portal/demo/documents?client=${CID}`;
    render(<App />);
    const u = userEvent.setup();
    const form = await screen.findByRole('form', { name: 'Upload a document' });
    await u.upload(within(form).getByLabelText('File'), new File(['%PDF'], 'bank.pdf', { type: 'application/pdf' }));
    await u.click(within(form).getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText('bank.pdf uploaded.')).toBeInTheDocument();
    expect(sent[0]).toMatchObject({ auth: 'Bearer PORTAL', file: 'bank.pdf' });
    expect(sent[0]!.url).toContain(`/portal/clients/${CID}/documents`);
    const mine = await screen.findByRole('region', { name: 'Uploaded by you' });
    expect(await within(mine).findByText('bank.pdf')).toBeInTheDocument();
  });
});

describe('phase 9 staff side', () => {
  it('staff app never sends the portal token', async () => {
    localStorage.setItem('worko.session', JSON.stringify(staff));
    localStorage.setItem('worko.portal.demo', JSON.stringify(portalTok));
    routes['GET /leads/board'] = () => json(200, ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'].map((stage) => ({ stage, count: 0, valuePaise: 0, items: [] })));
    location.hash = '#/leads';
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Leads' })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.path === '/leads/board')).toBe(true));
    for (const c of calls) { expect(c.auth).not.toBe('Bearer PORTAL'); expect(c.path.startsWith('/portal/')).toBe(false); }
  });

  it('public proposal accept works logged-out and sends no Authorization header', async () => {
    localStorage.setItem('worko.session', JSON.stringify(staff));
    let state = 'open';
    const view = () => ({ firm: 'Sharma & Co', accent: 'blue', number: 'PR-1', title: 'Annual compliance', version: 2, preparedFor: 'Mehta Traders', terms: 'Pay in 15 days', validUntil: '2026-11-30',
      lines: [{ description: 'GST returns', frequency: 'monthly', qty: 1, feePaise: 100_000, discountPaise: 0, gstRate: 18 }],
      totals: { supplyType: 'intra', byFrequency: { one_time: { taxablePaise: 0, taxPaise: 0, totalPaise: 0 }, monthly: { taxablePaise: 100_000, taxPaise: 18_000, totalPaise: 118_000 }, quarterly: { taxablePaise: 0, taxPaise: 0, totalPaise: 0 }, annual: { taxablePaise: 0, taxPaise: 0, totalPaise: 0 } },
        firstYear: { taxablePaise: 1_200_000, taxPaise: 216_000, totalPaise: 1_416_000 } }, state, acceptable: state === 'open' });
    routes['GET /proposals/public/tok123'] = () => json(200, view());
    routes['POST /proposals/public/tok123/accept'] = (c) => { expect(c.body).toEqual({ name: 'Ravi Mehta', agree: true }); state = 'accepted'; return json(200, { status: 'accepted' }); };
    location.hash = '#/proposal/tok123';
    render(<App />);
    const u = userEvent.setup();
    expect(await screen.findByText(/PR-1 · version 2/)).toBeInTheDocument();
    expect(screen.getByText('First-year value')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'Accept proposal' });
    await u.type(screen.getByLabelText('Type your full name'), 'Ravi Mehta');
    expect(btn).toBeDisabled();
    await u.click(screen.getByRole('checkbox'));
    await u.click(btn);
    expect(await screen.findByTestId('pub-state')).toHaveTextContent(/Accepted/);
    for (const c of calls) expect(c.auth).toBeNull();
  });

  it('convert: duplicate choice → result links', async () => {
    localStorage.setItem('worko.session', JSON.stringify(staff));
    const totals = { supplyType: 'intra', byFrequency: { one_time: { taxablePaise: 0, taxPaise: 0, totalPaise: 0 }, monthly: { taxablePaise: 0, taxPaise: 0, totalPaise: 0 }, quarterly: { taxablePaise: 0, taxPaise: 0, totalPaise: 0 }, annual: { taxablePaise: 500_000, taxPaise: 90_000, totalPaise: 590_000 } }, firstYear: { taxablePaise: 500_000, taxPaise: 90_000, totalPaise: 590_000 } };
    routes[`GET /proposals/${PID}`] = () => json(200, { id: PID, number: 'PR-1', title: 'ITR', leadId: 'l1', leadName: 'Ravi', company: 'Mehta Traders', status: 'accepted', entityId: null, placeOfSupply: null,
      currentVersion: 1, sentVersion: 1, acceptedVersion: 1, sentAt: '', decidedAt: '', acceptedName: 'Ravi Mehta', declinedReason: null, convertedAt: null, conversion: null,
      versions: [{ version: 1, lines: [{ serviceTypeId: null, description: 'ITR', frequency: 'annual', qty: 1, feePaise: 500_000, gstRate: 18 }], terms: null, validUntil: null, totals, supplyType: 'intra', sentAt: '2026-10-01T00:00:00Z', sentVia: 'email', createdAt: '' }] });
    routes['GET /leads/settings'] = () => json(200, { proposalValidityDays: 30, engagementLetterTemplate: '', defaultTerms: '' });
    routes['GET /service-types'] = () => json(200, []); routes['GET /billing/rates'] = () => json(200, []); routes['GET /billing/entities'] = () => json(200, []);
    let n = 0;
    routes[`POST /proposals/${PID}/convert`] = (c) => {
      if (++n === 1) return json(409, { message: 'Possible existing client', code: 'duplicate_client', candidates: [{ id: CID, name: 'Mehta Traders', matchedOn: ['pan'] }], hidden: 2 });
      expect(c.body).toMatchObject({ clientId: CID, inviteToPortal: true });
      return json(200, { alreadyConverted: false, clientId: CID, createdClient: false, contactId: 'ct1', letterDocumentId: 'd1', esignRequestId: null, portal: { status: 'needs_confirmation', code: 'existing_portal_user' } });
    };
    location.hash = `#/leads/p/${PID}`;
    render(<App />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Convert to client' }));
    const dlg = screen.getByRole('dialog', { name: 'Convert to client' });
    await u.click(within(dlg).getByRole('button', { name: 'Convert' }));
    expect(await within(dlg).findByText(/2 more matching client/)).toBeInTheDocument();
    await u.click(within(dlg).getByLabelText(/Use existing client Mehta Traders/));
    await u.click(within(dlg).getByRole('button', { name: 'Convert' }));
    const res = await screen.findByTestId('convert-result');
    expect(within(res).getByRole('link', { name: 'Open client' })).toHaveAttribute('href', `#/clients/${CID}`);
    expect(within(res).getByText(/Confirm the link from the client’s Portal tab/)).toBeInTheDocument();
  });
});
