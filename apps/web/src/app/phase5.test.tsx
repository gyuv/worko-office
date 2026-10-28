import { render, screen, within } from '@testing-library/react';
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
  grants: [grant('tasks', 'view'), grant('tasks', 'edit'), grant('tasks', 'create'), grant('tasks', 'assign'), grant('compliance', 'view'), grant('clients', 'view'), grant('clients', 'create'), grant('clients', 'edit'), grant('clients', 'export'), grant('registers', 'view'), grant('registers', 'create'), grant('registers', 'edit'), grant('billing', 'view'), grant('billing', 'create'), grant('billing', 'edit'), grant('billing', 'approve'), grant('billing', 'print'), grant('receipts', 'view'), grant('receipts', 'create')] };

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };
let routes: Record<string, (c: Call) => Response>;
let calls: Call[];

class NoopWs { readyState = 0; onopen = null; onmessage = null; onclose = null; onerror = null; send() {} close() {} }
const saved = (['clientHeight', 'clientWidth'] as const).map((k) => [k, Object.getOwnPropertyDescriptor(Element.prototype, k)] as const);
beforeAll(() => {
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

const INV = '33333333-0000-4000-8000-000000000001';
const C1 = '44444444-0000-4000-8000-000000000001';
const base = { id: INV, kind: 'invoice', entityId: 'e1', clientId: C1, clientName: 'Acme Traders', supplyType: 'intra', supplierState: '27', placeOfSupply: '27',
  taxablePaise: 1000000, cgstPaise: 90000, sgstPaise: 90000, igstPaise: 0, reimbursementPaise: 0, roundOffPaise: 0, totalPaise: 1180000, allocatedPaise: 0, tdsPaise: 0, creditedPaise: 0,
  balancePaise: 1180000, source: 'manual', followupPaused: false, version: 1, allocations: [], messages: [], paymentLinks: [],
  lines: [{ id: 'l1', description: 'GST return filing', sac: '998231', qty: 1, ratePaise: 1000000, discountPaise: 0, gstRate: 18, reimbursement: false, amountPaise: 1000000, taxablePaise: 1000000, cgstPaise: 90000, sgstPaise: 90000, igstPaise: 0, totalPaise: 1180000, taskIds: [] }] };

describe('phase 5 billing', () => {
  it('issues a draft after confirmation and then shows it read-only', async () => {
    let issued = false;
    routes['GET /billing/entities'] = () => json(200, [{ id: 'e1', name: 'Sharma & Co', stateCode: '27', invoicePrefix: 'SC', active: true, registered: true }]);
    routes['GET /billing/settings'] = () => json(200, { defaultEntityId: 'e1', dueDays: 15, ladder: [] });
    routes['GET /billing/unbilled'] = () => json(200, { count: 0, suggestedTotalPaise: 0, items: [] });
    routes[`GET /billing/invoices/${INV}`] = () => json(200, issued ? { ...base, status: 'issued', number: 'SC/2026-27/0001', issueDate: '2026-10-28', dueDate: '2026-11-12' } : { ...base, status: 'draft', number: null });
    routes[`POST /billing/invoices/${INV}/issue`] = () => { issued = true; return json(200, { number: 'SC/2026-27/0001' }); };
    location.hash = `#/billing/${INV}`;
    render(<App />);
    const u = userEvent.setup();
    expect(await screen.findByLabelText('Line 1 description')).toHaveValue('GST return filing');
    expect(screen.getByTestId('tax-cgst')).toHaveTextContent('₹900.00');
    expect(screen.queryByTestId('tax-igst')).toBeNull();
    await u.click(screen.getByRole('button', { name: 'Issue' }));
    const dlg = screen.getByRole('dialog', { name: 'Issue invoice' });
    await u.click(within(dlg).getByRole('button', { name: 'Issue now' }));
    expect(await screen.findByRole('heading', { name: 'SC/2026-27/0001' })).toBeInTheDocument();
    expect(calls.find((c) => c.path.endsWith('/issue'))!.body).toMatchObject({ issueDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), dueDate: null });
    expect(screen.queryByLabelText('Line 1 description')).toBeNull();
    expect(screen.getByRole('button', { name: 'Credit / debit note' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel invoice' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Issue' })).toBeNull();
  });

  it('records a receipt with TDS using a manual allocation', async () => {
    routes['GET /billing/receipts'] = () => json(200, { total: 0, items: [] });
    routes['GET /clients'] = () => json(200, { total: 1, items: [{ id: C1, name: 'Acme Traders' }] });
    routes[`GET /billing/clients/${C1}/outstanding`] = () => json(200, { clientId: C1, outstandingPaise: 300000, advancePaise: 0, netPaise: 300000, items: [
      { id: 'i1', kind: 'invoice', number: 'SC/1', dueDate: '2026-08-01', totalPaise: 100000, balancePaise: 100000 },
      { id: 'i2', kind: 'invoice', number: 'SC/2', dueDate: '2026-09-01', totalPaise: 200000, balancePaise: 200000 }] });
    routes['POST /billing/receipts'] = () => json(201, { id: 'r1', number: 'SCR/2026-27/0001', allocations: [] });
    location.hash = '#/receipts';
    render(<App />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Record receipt' }));
    const dlg = screen.getByRole('dialog', { name: 'Record receipt' });
    await u.type(within(dlg).getByLabelText('Client'), 'Acme');
    await u.click(await within(dlg).findByRole('option', { name: /Acme Traders/ }));
    await u.type(within(dlg).getAllByLabelText('Amount (₹)')[0]!, '1800');
    await u.type(within(dlg).getAllByLabelText('TDS deducted (₹)')[0]!, '200');
    expect(within(dlg).getByText('TDS needs a section.')).toBeInTheDocument();
    await u.type(within(dlg).getByLabelText('TDS section'), '194J');
    // FIFO preview: TDS 200 then cash 800 on SC/1, 1000 on SC/2 → no advance
    expect(within(dlg).getByTestId('advance')).toHaveTextContent('₹0.00');
    await u.click(within(dlg).getByLabelText('Manual'));
    await u.clear(within(dlg).getByLabelText('Cash for SC/1'));
    await u.clear(within(dlg).getByLabelText('Cash for SC/2'));
    await u.type(within(dlg).getByLabelText('Cash for SC/2'), '1500');
    expect(within(dlg).getByTestId('advance')).toHaveTextContent('₹300.00');
    await u.click(within(dlg).getByRole('button', { name: 'Record' }));
    expect(await screen.findByText('Receipt SCR/2026-27/0001 recorded')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/billing/receipts')!.body).toMatchObject({
      clientId: C1, amountPaise: 180000, tdsPaise: 20000, tdsSection: '194J', mode: 'bank',
      allocations: [{ invoiceId: 'i1', amountPaise: 0, tdsPaise: 20000 }, { invoiceId: 'i2', amountPaise: 150000, tdsPaise: 0 }] });
  });
});
