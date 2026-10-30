import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from '../lib/session';
import { useToasts } from '../components/Toast';
import { stopSync } from '../lib/sync';
import { App } from './App';

const tokens = { accessToken: 'a', refreshToken: 'r', expiresIn: 900, sessionId: 's1', userId: 'u1', tenantId: 't1' };
const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const grant = (module: string, action: string, scope = 'all') => ({ module, action, scope });
const ME = { id: 'u1', name: 'Anita Sharma', email: 'a@x.in', firmName: 'F', firmSlug: 'sharma', roles: ['partner'], totpEnabled: false,
  grants: [grant('clients', 'view'), ...['view', 'create', 'edit'].map((a) => grant('notices', a)), ...['view', 'create', 'edit', 'approve'].map((a) => grant('audit', a, 'team'))] };
const CID = '0190a000-0000-7000-8000-0000000000c1';
const XID = '0190a000-0000-7000-8000-0000000000e1';
const NID = '0190a000-0000-7000-8000-0000000000f1';
const EID = '0190a000-0000-7000-8000-0000000000a1';
const PID = '0190a000-0000-7000-8000-0000000000b1';
const TID = '0190a000-0000-7000-8000-0000000000d1';

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

const notice = { id: NID, clientId: CID, clientName: 'Mehta Traders', authority: 'income_tax', level: 'assessing_officer', section: '143(2)', referenceNo: null, din: null, title: 'Notice u/s 143(2)',
  description: null, issueDate: null, receivedOn: '2026-10-29', responseDue: '2026-11-20', assessmentYear: null, financialYear: null, period: null, demandPaise: 0, status: 'received', outcome: null,
  outcomeNote: null, finalDemandPaise: null, assigneeId: null, reviewerId: null, taskId: null, appealOf: null, closedAt: null, version: 1, createdAt: '', documents: [], hearings: [] };

describe('phase 8 notice extraction', () => {
  it('extract → confirm creates the notice with only the accepted fields', async () => {
    signIn();
    routes['GET /notices'] = () => json(200, { total: 0, items: [] });
    routes['GET /clients'] = () => json(200, { items: [{ id: CID, name: 'Mehta Traders' }], total: 1 });
    routes['POST /notices/extract'] = () => json(201, { id: XID, documentId: 'd1', provider: 'mock', status: 'pending', suggestions: [
      { field: 'section', value: '143(2)', confidence: 0.9, source: 'u/s 143(2)' },
      { field: 'responseDue', value: '2026-11-15', confidence: 0.8, source: '15.11.2026' },
      { field: 'din', value: 'ITBA/AST/S/143(2)/2026-27/1', confidence: 0.6, source: 'DIN' },
    ] });
    routes[`POST /notices/extractions/${XID}/confirm`] = () => json(201, { noticeId: NID });
    routes[`GET /notices/${NID}`] = () => json(200, notice);
    location.hash = '#/notices';
    render(<App />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: /Upload notice/ }));
    const dlg = screen.getByRole('dialog', { name: 'Upload notice' });
    await u.type(within(dlg).getByLabelText('Client'), 'Meh');
    await u.click(await within(dlg).findByRole('option', { name: /Mehta Traders/ }));
    await u.upload(within(dlg).getByLabelText('Notice file (PDF or text)'), new File(['Notice u/s 143(2)'], 'n.txt', { type: 'text/plain' }));
    await u.click(within(dlg).getByRole('button', { name: 'Upload & read' }));
    expect(await within(dlg).findByText('90% sure')).toBeInTheDocument();
    const confirm = within(dlg).getByRole('button', { name: /Confirm 0 field/ });
    expect(confirm).toBeDisabled(); // authority missing
    await u.click(within(dlg).getByLabelText('Accept Section'));
    await u.selectOptions(within(dlg).getByLabelText('Authority'), 'income_tax');
    const due = within(dlg).getByLabelText('Response due');
    await u.clear(due); await u.type(due, '2026-11-20');
    await u.click(within(dlg).getByRole('button', { name: /Confirm 3 field/ }));
    expect(await screen.findByRole('heading', { name: 'Notice u/s 143(2)' })).toBeInTheDocument();
    const body = calls.find((c) => c.path.endsWith('/confirm'))!.body as { fields: Record<string, unknown> };
    expect(body.fields).toEqual({ section: '143(2)', authority: 'income_tax', responseDue: '2026-11-20' });
    expect('din' in body.fields).toBe(false);
    // detail shows only allowed moves from "received"
    const moves = screen.getByRole('group', { name: 'Move to' });
    expect(within(moves).getAllByRole('button').map((b) => b.textContent)).toEqual(['Move to: Under review', 'Move to: Drafting reply', 'Move to: Closed']);
  });
});

const engagement = (udinRecorded: boolean, preparedBy: string | null) => ({
  id: EID, clientId: CID, clientName: 'Mehta Traders', fy: '2026-27', auditType: 'statutory_audit', programmeId: null, partnerId: 'u9', managerId: null, taskId: TID, status: 'fieldwork',
  udinRequired: true, udinRecorded, version: 1, createdAt: '', pbc: [], udins: udinRecorded ? [{ id: 'x', clientId: CID, engagementId: EID, taskId: TID, udin: '26123456ABCDEF1234', documentType: 'Audit report',
    generatedOn: '2026-10-20', membershipNo: '123456', signingPartnerId: null, documentId: null, revokedAt: null, revokeReason: null, createdAt: '' }] : [],
  progress: { total: 1, prepared: preparedBy ? 1 : 0, reviewed: 0, partner: 0 }, udinPortalUrl: 'https://udin.icai.org/',
  procedures: [{ id: PID, sectionKey: 'planning', sectionTitle: 'Planning', key: 'risk', title: 'Risk assessment', requiredEvidence: ['Memo'], notApplicable: false, conclusion: null,
    preparedBy, preparedAt: preparedBy ? '2026-10-28T05:00:00Z' : null, reviewedBy: null, reviewedAt: null, partnerBy: null, partnerAt: null, workpapers: 0 }],
});

describe('phase 8 audit sign-off', () => {
  it('reviewer button is disabled with the self-review reason after preparing', async () => {
    signIn();
    let prepared: string | null = null;
    routes[`GET /audit/engagements/${EID}`] = () => json(200, engagement(false, prepared));
    routes[`POST /audit/procedures/${PID}/signoff`] = (c) => {
      if ((c.body as { level: string }).level === 'preparer') { prepared = 'u1'; return json(204, null); }
      return json(400, { message: 'Rejected', code: 'self_review' });
    };
    location.hash = `#/engagements/${EID}`;
    render(<App />);
    const u = userEvent.setup();
    const row = await screen.findByTestId('proc-risk');
    expect(within(row).getByTestId('why-risk-reviewer')).toHaveTextContent('Needs the preparer sign-off first.');
    await u.click(within(row).getByRole('button', { name: 'Sign as preparer' }));
    await waitFor(() => expect(within(screen.getByTestId('proc-risk')).getByTestId('why-risk-reviewer')).toHaveTextContent('You prepared this — someone else must review it.'));
    const reviewer = within(screen.getByTestId('proc-risk')).getByRole('button', { name: 'Sign as reviewer' });
    expect(reviewer).toBeDisabled();
    expect(within(screen.getByTestId('proc-risk')).getByTestId('why-risk-partner')).toHaveTextContent('You may not sign at this level.');
    expect(calls.filter((c) => c.path.endsWith('/signoff')).map((c) => c.body)).toEqual([{ level: 'preparer' }]);
  });

  it('recording a UDIN unblocks the task (format validated first, portal link only)', async () => {
    signIn();
    let recorded = false;
    routes[`GET /audit/engagements/${EID}`] = () => json(200, engagement(recorded, null));
    routes['GET /documents'] = () => json(200, { items: [], total: 0 });
    routes['POST /audit/udins'] = () => { recorded = true; return json(201, { id: 'x' }); };
    location.hash = `#/engagements/${EID}`;
    render(<App />);
    const u = userEvent.setup();
    expect(await screen.findByTestId('udin-gate')).toHaveTextContent('cannot be completed until a UDIN is recorded');
    await u.click(screen.getByRole('tab', { name: 'UDIN' }));
    expect(screen.getByRole('link', { name: /Open official ICAI UDIN portal/ })).toHaveAttribute('href', 'https://udin.icai.org/');
    await u.type(screen.getByLabelText('UDIN'), '26123456ABCDEF123');
    await u.type(screen.getByLabelText('Membership no.'), '654321');
    await u.click(screen.getByRole('button', { name: 'Record' }));
    expect(screen.getByText('Not a valid UDIN format.')).toBeInTheDocument();
    await u.type(screen.getByLabelText('UDIN'), '4');
    expect(screen.getByText('Digits 3–8 of the UDIN must equal the membership number.')).toBeInTheDocument();
    const m = screen.getByLabelText('Membership no.');
    await u.clear(m); await u.type(m, '123456');
    expect(calls.some((c) => c.path === '/audit/udins')).toBe(false);
    await u.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(screen.getByTestId('udin-gate')).toHaveTextContent('UDIN recorded'));
    expect(calls.find((c) => c.path === '/audit/udins')!.body).toMatchObject({ clientId: CID, engagementId: EID, taskId: TID, udin: '26123456ABCDEF1234', membershipNo: '123456' });
  });
});

describe('phase 8 public e-sign page', () => {
  it('works logged out with the mock provider', async () => {
    routes['GET /esign/sign/tok_abcdefghijklmnopqrstuvwxyz'] = () => json(200, { documentName: 'Balance sheet FY26.pdf', signerName: 'Rakesh Mehta', signingUrl: 'https://esign.mock.invalid/sign/mock-1/s1' });
    location.hash = '#/esign/sign/tok_abcdefghijklmnopqrstuvwxyz';
    render(<App />);
    const u = userEvent.setup();
    expect(await screen.findByText('Balance sheet FY26.pdf')).toBeInTheDocument();
    expect(screen.getByText(/Hello Rakesh Mehta/)).toBeInTheDocument();
    expect(screen.getByText(/not a real electronic signature/)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Proceed to the signing provider' }));
    expect(screen.getByTestId('esign-mock-done')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/me')).toBe(false);
  });
  it('explains not-your-turn', async () => {
    routes['GET /esign/sign/tok_abcdefghijklmnopqrstuvwxyz'] = () => json(409, { message: 'wait', code: 'not_your_turn' });
    location.hash = '#/esign/sign/tok_abcdefghijklmnopqrstuvwxyz';
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('An earlier signer has not signed yet');
  });
});
