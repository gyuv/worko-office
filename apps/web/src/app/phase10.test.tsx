import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AGENT_TEMPLATES } from '@worko/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from '../lib/session';
import { stopSync } from '../lib/sync';
import { App } from './App';

const staff = { accessToken: 'STAFF', refreshToken: 'r', expiresIn: 900, sessionId: 's1', userId: 'u1', tenantId: 't1' };
const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const grant = (module: string, action: string) => ({ module, action, scope: 'all' });
const ACTIONS = ['view', 'create', 'edit', 'approve'];
const ME = { id: 'u1', name: 'Anita', email: 'a@x.in', firmName: 'Demo', firmSlug: 'demo', roles: ['partner'], totpEnabled: false,
  grants: ['automation', 'ai', 'notices', 'clients', 'communication', 'settings', 'documents'].flatMap((m) => ACTIONS.map((a) => grant(m, a))) };
const CID = '0190a000-0000-7000-8000-0000000000c1';
const NID = '0190a000-0000-7000-8000-0000000000e1';
const RID = '0190a000-0000-7000-8000-0000000000a1';
const SID = '0190a000-0000-7000-8000-0000000000f1';
const AGENTS = AGENT_TEMPLATES.map((t) => ({ key: t.key, name: t.name, description: t.description, defaults: t.params.parse({}), definition: t.build(t.params.parse({})) }));
const DRY = { trigger: 'compliance.due_soon', asOf: '2026-10-29', evaluated: 2, matched: 2, actions: 4, estimatedCostPaise: 25, refusals: { opted_out: 1 }, monthToDateCostPaise: 0, capPaise: 50_000, items: [
  { entity: { type: 'task', id: 't-1' }, clientId: CID, clientName: 'Mehta Traders', step: 'first', skipped: null, matched: true, conditions: [],
    actions: [{ type: 'set_task_status', summary: 'GSTR-3B → pending client', wouldRefuse: null, costPaise: 0, details: {} }, { type: 'send_message', summary: 'Email to ravi@x.in', wouldRefuse: null, costPaise: 25, details: {} }] },
  { entity: { type: 'task', id: 't-2' }, clientId: 'c2', clientName: 'Shah Exports', step: 'first', skipped: null, matched: true, conditions: [],
    actions: [{ type: 'set_task_status', summary: 'GSTR-1 → pending client', wouldRefuse: null, costPaise: 0, details: {} }, { type: 'send_message', summary: 'Email', wouldRefuse: 'opted_out', costPaise: 0, details: {} }] },
] };
const notice = { id: NID, clientId: CID, clientName: 'Mehta Traders', authority: 'income_tax', level: 'assessing_officer', section: '143(2)', referenceNo: null, din: null, title: 'Notice u/s 143(2)',
  description: null, issueDate: null, receivedOn: '2026-10-29', responseDue: '2026-11-20', assessmentYear: null, financialYear: null, period: null, demandPaise: 0, status: 'received', outcome: null,
  outcomeNote: null, finalDemandPaise: null, assigneeId: null, reviewerId: null, taskId: null, appealOf: null, closedAt: null, version: 1, createdAt: '', documents: [], hearings: [] };
const suggestion = { id: SID, kind: 'draft_reply', feature: 'draft_reply', status: 'pending', clientId: CID, entityType: 'notice', entityId: NID, requestedBy: 'u1', ruleId: null, runId: null,
  provider: 'mock', model: 'mock-1', mock: true, payload: { subject: 'Re: Notice u/s 143(2)', body: 'Dear Sir, Mehta Traders (PAN ABCPM1234K) will respond.', channel: 'email' },
  sources: [{ type: 'client', id: CID, label: 'Mehta Traders' }, { type: 'notice', id: NID, label: 'Notice u/s 143(2)' }], meta: {}, decidedBy: null, decidedAt: null, applied: null, error: null, purged: false, createdAt: '2026-10-29T05:00:00Z' };
const avail = (on: boolean) => ({ noAiMode: false, features: Object.fromEntries(['notice_extraction', 'draft_reply', 'summarise', 'classify_upload', 'automation_draft', 'ask'].map((f) => [f, on ? 'ok' : 'ai_disabled'])), firmCapReached: false, userCapReached: false, mock: true });

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
    'GET /automation/agents': () => json(200, { items: AGENTS }), 'GET /automation/rules': () => json(200, { items: [] }),
    'GET /automation/costs': () => json(200, { month: '2026-10', totalPaise: 0, capPaise: 500_000, items: [] }), 'GET /ai/availability': () => json(200, avail(true)),
  };
  vi.stubGlobal('WebSocket', NoopWs);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname.replace(/^\/v1/, '');
    const ct = req.headers.get('content-type') ?? '';
    const body = req.method !== 'GET' && ct.includes('json') ? await req.clone().json().catch(() => undefined) : undefined;
    const c = { method: req.method, path, body };
    calls.push(c);
    const h = routes[`${req.method} ${path}`];
    return h ? h(c) : json(404, { message: 'nf' });
  }));
});

describe('phase 10 automation', () => {
  it('enables the Document Collection Agent via preview → enable', async () => {
    routes['POST /automation/agents/document_collection/preview'] = () => json(200, DRY);
    routes['POST /automation/agents/document_collection/enable'] = () => json(201, { rule: { id: RID, name: 'Document Collection Agent', version: 1 }, preview: DRY });
    location.hash = '#/automation/agents';
    render(<App />);
    const u = userEvent.setup();
    const card = await screen.findByTestId('agent-document_collection');
    await u.click(within(card).getByRole('button', { name: 'Set up' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByRole('button', { name: 'Enable' })).toBeDisabled(); // preview first
    const lead = within(dlg).getByLabelText('Days before due');
    await u.clear(lead); await u.type(lead, '7');
    await u.click(within(dlg).getByRole('button', { name: 'Preview' }));
    const dr = await within(dlg).findByTestId('dry-run');
    expect(within(dr).getByTestId('dr-matched')).toHaveTextContent('2');
    expect(within(dr).getByTestId('dr-cost')).toHaveTextContent('₹0.25');
    expect(within(dr).getByTestId('dr-refusals')).toHaveTextContent('client opted out × 1');
    expect(within(dr).getByText('Email to ravi@x.in')).toBeInTheDocument();
    expect(calls.find((c) => c.path.endsWith('/preview'))!.body).toMatchObject({ params: { leadDays: 7, serviceKeys: ['GSTR1', 'GSTR3B'], channel: 'email' } });
    await u.click(within(dlg).getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(location.hash).toBe('#/automation/rules'));
    expect(calls.find((c) => c.path.endsWith('/enable'))!.body).toMatchObject({ enabled: true, params: { leadDays: 7 } });
  });

  it('rule with an invalid condition shows the error, then saves once fixed', async () => {
    routes['POST /automation/rules'] = (c) => json(201, { id: RID, name: (c.body as { name: string }).name, version: 1, definition: (c.body as { definition: unknown }).definition, scope: 'firm', enabled: false });
    location.hash = '#/automation/rules/new';
    render(<App />);
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Name'), 'Big invoices');
    await u.selectOptions(screen.getByLabelText('Event'), 'invoice.issued');
    await u.click(screen.getByRole('button', { name: 'Condition' }));
    await u.selectOptions(screen.getByLabelText('Field'), 'invoice.totalPaise');
    await u.selectOptions(screen.getByLabelText('Operator'), 'gt');
    await u.type(screen.getByLabelText('Value'), 'lots');
    await u.selectOptions(screen.getByLabelText('Action'), 'notify');
    await u.click(screen.getByRole('button', { name: 'Add action' }));
    await u.type(within(screen.getByTestId('action-0')).getByLabelText('Title'), 'Big invoice for {{client.name}}');
    expect(await screen.findByText('invoice.totalPaise compares with number')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Create (disabled)' }));
    expect(screen.getByTestId('rule-errors')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/automation/rules')).toBe(false);
    await u.clear(screen.getByLabelText('Value')); await u.type(screen.getByLabelText('Value'), '5,000');
    expect(screen.queryByText('invoice.totalPaise compares with number')).toBeNull();
    await u.click(screen.getByRole('button', { name: 'Create (disabled)' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/automation/rules')).toBe(true));
    const b = calls.find((c) => c.method === 'POST' && c.path === '/automation/rules')!.body as { definition: { conditions: unknown; trigger: unknown }; enabled: boolean };
    expect(b.enabled).toBe(false);
    expect(b.definition.trigger).toEqual({ kind: 'event', event: 'invoice.issued' });
    expect(b.definition.conditions).toEqual({ all: [{ field: 'invoice.totalPaise', op: 'gt', value: 500000 }] });
  });
});

describe('phase 10 AI', () => {
  it('approves a draft-reply suggestion after editing; service errors are shown plainly', async () => {
    routes['GET /ai/suggestions'] = () => json(200, { items: [suggestion] });
    let n = 0;
    routes[`POST /ai/suggestions/${SID}/approve`] = () => (++n === 1 ? json(409, { message: 'Client has opted out of email', code: 'opted_out' }) : json(200, { id: SID, status: 'approved', applied: { messageId: 'm1' } }));
    location.hash = '#/suggestions';
    render(<App />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: /Draft reply/ }));
    const box = screen.getByTestId(`suggestion-${SID}`);
    expect(within(box).getByTestId('ai-badge')).toHaveTextContent('AI suggestion — review before use');
    expect(within(box).getByRole('link', { name: 'Notice u/s 143(2)' })).toHaveAttribute('href', `#/notices/${NID}`);
    await u.click(within(box).getByRole('button', { name: 'Show what the AI saw' }));
    expect(within(box).getByTestId('redacted')).toHaveTextContent('Dear Sir, [CLIENT_1] (PAN [PAN_1]) will respond.');
    const msg = within(box).getByLabelText('Message');
    await u.clear(msg); await u.type(msg, 'Dear Sir, we will file the reply by 15 Nov.');
    await u.click(within(box).getByRole('button', { name: 'Approve & send' }));
    expect(await within(box).findByTestId('ai-error')).toHaveTextContent('Not applied: Client has opted out of email');
    await u.click(within(box).getByRole('button', { name: 'Approve & send' }));
    await waitFor(() => expect(n).toBe(2));
    expect(calls.filter((c) => c.path.endsWith('/approve'))[1]!.body).toEqual({ body: 'Dear Sir, we will file the reply by 15 Nov.' });
  });

  it('AI disabled hides every AI button; enabled shows them', async () => {
    routes[`GET /notices/${NID}`] = () => json(200, notice);
    routes['GET /ai/availability'] = () => json(200, avail(false));
    location.hash = `#/notices/${NID}`;
    const { unmount } = render(<App />);
    expect(await screen.findByRole('heading', { name: 'Notice u/s 143(2)' })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.path === '/ai/availability')).toBe(true));
    expect(screen.queryByRole('button', { name: /Draft reply/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Summarise/ })).toBeNull();
    unmount();
    routes['GET /ai/availability'] = () => json(200, avail(true));
    render(<App />);
    expect(await screen.findByRole('button', { name: /Draft reply/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Summarise/ })).toBeInTheDocument();
  });
});
