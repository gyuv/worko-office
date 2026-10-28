import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { gstinCheckChar } from '@worko/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clientsView, parseHash } from '../lib/router';
import { useSession } from '../lib/session';
import { stopSync } from '../lib/sync';
import { App } from './App';

const tokens = { accessToken: 'a', refreshToken: 'r', expiresIn: 900, sessionId: 's1', userId: 'u1', tenantId: 't1' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const grant = (module: string, action: string) => ({ module, action, scope: 'all' });
const ME = { id: 'u1', name: 'Anita Sharma', email: 'a@x.in', firmName: 'F', firmSlug: 'sharma', roles: ['partner'], totpEnabled: false,
  grants: [grant('clients', 'view'), grant('clients', 'create'), grant('clients', 'edit'), grant('clients', 'export'), grant('registers', 'view'), grant('registers', 'create'), grant('registers', 'edit')] };
const CID = '11111111-2222-4333-8444-555555555555';
const client = (id: string, name: string) => ({ id, name, entityType: 'PRIVATE_COMPANY', status: 'active', tags: [], staffIds: [], groupIds: [], sensitive: false, version: 1, pan: 'AAPFU0939F', primaryGstin: null, fileNo: 'F-1' });
const GSTIN14 = '27AAPFU0939F1Z';
const GSTIN = GSTIN14 + gstinCheckChar(GSTIN14);

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
  routes = {
    'GET /me': () => json(200, ME),
    'GET /sync/pull': () => json(200, { changes: [], cursor: 0, hasMore: false }),
    'GET /client-groups': () => json(200, []),
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

describe('router', () => {
  it('parses parameterised client routes and keeps flat deep links', () => {
    expect(parseHash(`#/clients/${CID}`)).toEqual({ route: 'clients', params: [CID] });
    expect(clientsView(parseHash(`#/clients/${CID}`).params)).toEqual({ view: 'detail', id: CID });
    expect(clientsView(parseHash('#/clients/import').params)).toEqual({ view: 'import' });
    expect(clientsView(parseHash('#/clients/not-a-uuid').params)).toEqual({ view: 'list' });
    expect(parseHash('#/security')).toEqual({ route: 'security', params: [] });
    expect(parseHash('#/nope')).toEqual({ route: 'home', params: [] });
  });
});

describe('clients list', () => {
  it('renders rows and searches with q', async () => {
    routes['GET /clients'] = (c) => json(200, c.query.get('q') === 'acme'
      ? { total: 1, items: [client(CID, 'Acme Traders')] }
      : { total: 2, items: [client(CID, 'Acme Traders'), client('22222222-2222-4333-8444-555555555555', 'Bharat Steel')] });
    location.hash = '#/clients';
    render(<App />);
    expect(await screen.findByText('Bharat Steel')).toBeInTheDocument();
    expect(screen.getByText('2 clients')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search' }), 'acme');
    await waitFor(() => expect(screen.queryByText('Bharat Steel')).toBeNull());
    expect(calls.some((c) => c.path === '/clients' && c.query.get('q') === 'acme')).toBe(true);
    expect(screen.getByRole('row', { name: /Acme Traders/ })).toHaveAttribute('href', `#/clients/${CID}`);
  });
});

describe('new client dialog', () => {
  it('validates GSTIN, autofills from lookup, warns on hidden duplicates and posts the body', async () => {
    routes['GET /clients'] = () => json(200, { total: 0, items: [] });
    routes['GET /lookup/gstin/*'] = () => json(200, { gstin: GSTIN, legalName: 'MOCK LEGAL NAME', status: 'Active', entityType: 'PARTNERSHIP', stateCode: '27', state: 'Maharashtra', source: 'mock' });
    routes['POST /clients/duplicates'] = () => json(200, { matches: [], hidden: 2 });
    routes['POST /clients'] = () => json(201, { id: CID });
    routes[`GET /clients/${CID}`] = () => json(404, { message: 'nf' });
    location.hash = '#/clients';
    render(<App />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'New client' }));
    const dlg = await screen.findByRole('dialog');
    const g = within(dlg).getByLabelText('GSTIN');
    await u.type(g, GSTIN14 + (gstinCheckChar(GSTIN14) === 'A' ? 'B' : 'A'));
    expect(within(dlg).getByRole('alert')).toHaveTextContent('not valid');
    await u.clear(g);
    await u.type(g, GSTIN);
    await waitFor(() => expect(within(dlg).getByLabelText('Entity type')).toHaveValue('PARTNERSHIP'));
    expect(within(dlg).getByLabelText('PAN')).toHaveValue('AAPFU0939F');
    expect(within(dlg).getByLabelText('State')).toHaveValue('Maharashtra');
    expect(within(dlg).getByText(/MOCK LEGAL NAME/)).toBeInTheDocument();
    await u.type(within(dlg).getByLabelText('Name'), 'Acme Traders');
    expect(await within(dlg).findByText("2 similar clients you can't see", {}, { timeout: 2000 })).toBeInTheDocument();
    await u.click(within(dlg).getByRole('button', { name: 'Create client' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/clients')).toBeTruthy());
    expect(calls.find((c) => c.method === 'POST' && c.path === '/clients')!.body).toMatchObject({
      name: 'Acme Traders', entityType: 'PARTNERSHIP', pan: 'AAPFU0939F',
      registrations: [{ kind: 'GSTIN', number: GSTIN, stateCode: '27', isPrimary: true }], sensitive: false,
    });
    await waitFor(() => expect(location.hash).toBe(`#/clients/${CID}`));
  });
});

describe('client 360 reveal', () => {
  it('asks for step-up on STEP_UP_REQUIRED, then shows the value', async () => {
    routes[`GET /clients/${CID}`] = () => json(200, { ...client(CID, 'Acme Traders'), aadhaarLast4: '9012', registrations: [], contacts: [], groups: [],
      counts: { documents: 0, secrets: 0, inward: 0, outward: 0 }, can: { edit: true, delete: false, reveal: true, vault: false } });
    let elevated = false;
    routes[`POST /clients/${CID}/reveal`] = () => (elevated ? json(200, { value: '123456789012' }) : json(403, { statusCode: 403, code: 'STEP_UP_REQUIRED', message: 'step up' }));
    routes['POST /auth/step-up'] = (c) => { elevated = (c.body as { password?: string }).password === 'pw'; return elevated ? json(200, { elevatedUntil: 'x' }) : json(401, { message: 'bad' }); };
    location.hash = `#/clients/${CID}`;
    render(<App />);
    const u = userEvent.setup();
    expect(await screen.findByTestId('aadhaar-value')).toHaveTextContent('XXXX XXXX 9012');
    await u.click(screen.getByRole('button', { name: 'Reveal' }));
    const dlg = await screen.findByRole('dialog', { name: "Confirm it's you" });
    await u.type(within(dlg).getByLabelText('Password'), 'pw');
    await u.click(within(dlg).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getByTestId('aadhaar-value')).toHaveTextContent('1234 5678 9012'));
    expect(calls.filter((c) => c.path === `/clients/${CID}/reveal`)).toHaveLength(2);
    expect(calls.find((c) => c.path === '/auth/step-up')!.body).toEqual({ password: 'pw' });
  });
});

describe('import wizard', () => {
  it('previews a file and commits only selected valid rows', async () => {
    const row = (n: number, name: string, errors: string[] = []) => ({ row: n, data: errors.length ? null : { name, entityType: 'INDIVIDUAL' }, errors, warnings: [] });
    routes['POST /clients/import/preview'] = () => json(200, { headers: ['Name'], mapping: { Name: 'name' }, rows: [row(2, 'A One'), row(3, 'B Two'), row(4, 'Bad', ['Invalid PAN']), row(5, 'C Three')], summary: { total: 4, valid: 3, withErrors: 1, withWarnings: 0 } });
    routes['POST /clients/import/commit'] = () => json(200, { created: 2, ids: ['x', 'y'], failed: [] });
    location.hash = '#/clients/import';
    render(<App />);
    const u = userEvent.setup();
    await u.upload(await screen.findByLabelText(/Choose an .xlsx/), new File(['Name\nA One'], 'clients.csv', { type: 'text/csv' }));
    expect(await screen.findByText('3 valid')).toBeInTheDocument();
    expect(screen.getByText('Invalid PAN')).toBeInTheDocument();
    expect(screen.getByLabelText('Include row 4')).toBeDisabled();
    await u.click(screen.getByLabelText('Include row 3'));
    await u.click(screen.getByRole('button', { name: 'Import 2 clients' }));
    expect(await screen.findByText('2 clients imported.')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/clients/import/commit')!.body).toEqual({ rows: [{ name: 'A One', entityType: 'INDIVIDUAL' }, { name: 'C Three', entityType: 'INDIVIDUAL' }] });
  });
});

describe('registers', () => {
  it('creates an inward entry with a snake_case body and shows the number', async () => {
    routes['GET /registers/inward'] = () => json(200, { total: 0, items: [] });
    routes['GET /clients'] = () => json(200, { total: 1, items: [client(CID, 'Acme Traders')] });
    routes['POST /registers/inward'] = () => json(201, { id: 'e1', number: 'IN/2026-27/0001' });
    location.hash = '#/registers';
    render(<App />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'New inward entry' }));
    const dlg = await screen.findByRole('dialog');
    await u.type(within(dlg).getByLabelText('Client'), 'acme');
    await u.click(await within(dlg).findByRole('option', { name: /Acme Traders/ }));
    await u.clear(within(dlg).getByLabelText('Received on'));
    await u.type(within(dlg).getByLabelText('Received on'), '2026-10-27');
    await u.type(within(dlg).getByLabelText('Received from'), 'Ramesh');
    await u.type(within(dlg).getByLabelText('Description'), 'Bank statements');
    await u.type(within(dlg).getByLabelText('Item 1 description'), 'Passbook');
    await u.click(within(dlg).getByLabelText('original'));
    await u.click(within(dlg).getByLabelText('Returnable to client'));
    await u.click(within(dlg).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved as IN/2026-27/0001')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/registers/inward')!.body).toEqual({
      client_id: CID, received_on: '2026-10-27', mode: 'physical', from_name: 'Ramesh', from_phone: null, description: 'Bank statements',
      items: [{ description: 'Passbook', qty: 1, original: true }], returnable: true, due_back: null,
    });
  });
});
