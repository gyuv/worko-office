import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalogueReport, DATASETS, opsFor, REPORT_CATALOGUE } from '@worko/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from '../lib/session';
import { stopSync } from '../lib/sync';
import { App } from './App';

const staff = { accessToken: 'STAFF', refreshToken: 'r', expiresIn: 900, sessionId: 's1', userId: 'u1', tenantId: 't1' };
const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const grant = (module: string, action: string) => ({ module, action, scope: 'all' });
const me = (reportActions: string[], extra: string[] = []) => ({ id: 'u1', name: 'Anita', email: 'a@x.in', firmName: 'Demo', firmSlug: 'demo', roles: ['partner'], totpEnabled: false,
  grants: [...reportActions.map((a) => grant('reports', a)), ...['billing', 'tasks', 'clients', 'time', 'users'].map((m) => grant(m, 'view')), ...extra.map((x) => grant(x.split(':')[0]!, x.split(':')[1]!))] });
const CID = '0190a000-0000-7000-8000-0000000000c1';
const RID = '0190a000-0000-7000-8000-0000000000a1';
const UID2 = '0190a000-0000-7000-8000-0000000000b2';
const avail = (nl: string) => ({ noAiMode: false, features: { nl_query: nl, draft_reply: 'ok' }, firmCapReached: false, userCapReached: false, mock: true });
const DATASET_VIEW = DATASETS.map((d) => ({ key: d.key, label: d.label, description: d.description, module: d.module, entity: d.entity ?? null, params: d.params ?? [],
  columns: d.columns.map((c) => ({ key: c.key, label: c.label, type: c.type, description: c.description ?? null, values: c.values ?? null, sensitivity: c.sensitivity ?? null, ref: c.ref ?? null, hidden: c.sensitivity === 'cost', ops: opsFor(c.type) })) }));
const CATALOGUE = REPORT_CATALOGUE.map((r) => ({ key: r.key, name: r.name, description: r.description, dataset: r.definition.dataset, definition: r.definition, explanation: r.name }));
const unbilledDef = catalogueReport('unbilled_by_client')!.definition;
const groups = [{ key: { clientName: 'Mehta Traders' }, label: 'Mehta Traders', values: { count: 2, sum_suggestedPaise: 1_000_000 } }, { key: { clientName: 'Shah Exports' }, label: 'Shah Exports', values: { count: 1, sum_suggestedPaise: 250_000 } }];
const runResult = (over: Record<string, unknown> = {}) => ({
  dataset: { key: 'unbilled', label: 'Unbilled work', module: 'billing' }, definition: { ...unbilledDef, aggregates: [{ fn: 'count', as: 'count' }, { fn: 'sum', column: 'suggestedPaise', as: 'sum_suggestedPaise' }] },
  explanation: 'Unbilled work, grouped by Client', columns: [{ key: 'clientName', label: 'Client', type: 'text' }, { key: 'title', label: 'Task', type: 'text' }, { key: 'suggestedPaise', label: 'Suggested fee', type: 'paise' }],
  hiddenColumns: [], params: {}, asOf: '2026-10-30', rows: [], rowCount: 0, page: 1, pageSize: 100, totals: { count: 3, sum_suggestedPaise: 1_250_000 }, groups, groupsTruncated: false,
  chart: { type: 'bar', x: 'clientName', y: 'sum_suggestedPaise' }, name: 'Unbilled by client', reportId: null, catalogueKey: 'unbilled_by_client', ...over,
});
const drillRows = [{ values: { clientName: 'Mehta Traders', title: 'GSTR-3B Sep', suggestedPaise: 600_000 }, refs: { client: CID, task: 't-1' } }];

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
    'GET /me': () => json(200, me(['view', 'create', 'edit', 'export'], ['ai:view', 'ai:create'])), 'GET /sync/pull': () => json(200, { changes: [], cursor: 0, hasMore: false }),
    'GET /users': () => json(200, [{ id: 'u1', name: 'Anita', email: 'a@x.in', roles: ['partner'], status: 'active' }, { id: UID2, name: 'Ravi', email: 'r@x.in', roles: ['manager'], status: 'active' }]),
    'GET /ai/availability': () => json(200, avail('ok')), 'GET /reports/datasets': () => json(200, DATASET_VIEW), 'GET /reports/catalogue': () => json(200, CATALOGUE),
    'GET /reports/saved': () => json(200, { items: [] }), 'GET /reports/schedules': () => json(200, { items: [] }), 'GET /reports/ask': () => json(200, { items: [] }),
    'POST /reports/run': (c) => json(200, (c.body as { drill?: unknown }).drill ? runResult({ groups: [], rows: drillRows, rowCount: 1 }) : runResult()),
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
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

describe('phase 11 dashboards & reports', () => {
  it('home dashboard loads widgets; clicking a bar drills to the underlying rows with entity links', async () => {
    routes['GET /reports/dashboards/default/data'] = () => json(200, {
      dashboard: { id: null, name: 'Partner overview', roleKey: 'partner', ownerId: null, canEdit: false, origin: 'template',
        widgets: [{ id: 'unbilled', kind: 'kpi', title: 'Unbilled (suggested fees)', catalogueKey: 'unbilled_by_client', value: 'sum_suggestedPaise' }, { id: 'byClient', kind: 'chart', title: 'Unbilled by client', catalogueKey: 'unbilled_by_client', chart: 'bar' }] },
      widgets: [{ id: 'unbilled', kind: 'kpi', title: 'Unbilled (suggested fees)', dataset: 'unbilled', value: 1_250_000, valueKey: 'sum_suggestedPaise', type: 'paise', hiddenColumns: [] },
        { id: 'byClient', kind: 'chart', title: 'Unbilled by client', dataset: 'unbilled', chart: 'bar', groups, totals: {}, hiddenColumns: [] },
        { id: 'slow', kind: 'chart', title: 'Slow one', error: 'budget_exceeded' }] });
    location.hash = '#/home';
    render(<App />);
    const u = userEvent.setup();
    expect(await screen.findByTestId('dashboard-name')).toHaveTextContent('Partner overview');
    expect(within(screen.getByTestId('widget-unbilled')).getByTestId('kpi-value')).toHaveTextContent('₹12,500.00');
    expect(screen.getByTestId('widget-slow')).toHaveTextContent('hit its time/row budget');
    const bars = within(screen.getByTestId('widget-byClient')).getAllByTestId('chart-bar');
    expect(bars).toHaveLength(2);
    await u.click(bars[0]!);
    const dlg = await screen.findByRole('dialog');
    const table = await within(dlg).findByTestId('rows-table');
    expect(within(table).getByRole('link', { name: 'Mehta Traders' })).toHaveAttribute('href', `#/clients/${CID}`);
    expect(within(table).getByText('₹6,000.00')).toBeInTheDocument();
    expect(within(dlg).getByTestId('breadcrumbs')).toHaveTextContent('Mehta Traders');
    expect(calls.find((c) => c.path === '/reports/run')!.body).toMatchObject({ catalogueKey: 'unbilled_by_client', drill: { clientName: 'Mehta Traders' } });
  });

  it('report view: group row drill with breadcrumbs back; column_hidden shows its reason; hidden-column notice', async () => {
    location.hash = '#/reports/run/unbilled_by_client';
    routes['POST /reports/run'] = (c) => json(200, (c.body as { drill?: unknown }).drill ? runResult({ groups: [], rows: drillRows, rowCount: 1, hiddenColumns: ['suggestedPaise'] }) : runResult());
    render(<App />);
    const u = userEvent.setup();
    expect(await screen.findByTestId('total-sum_suggestedPaise')).toHaveTextContent('₹12,500.00');
    await u.click(screen.getByRole('button', { name: 'Table' }));
    await u.click(within(screen.getByTestId('group-table')).getByRole('button', { name: 'Shah Exports' }));
    expect(await screen.findByTestId('hidden-notice')).toHaveTextContent('Suggested fee');
    await u.click(within(screen.getByTestId('breadcrumbs')).getByRole('button', { name: 'Unbilled by client' }));
    expect(await screen.findByTestId('group-table')).toBeInTheDocument();

    routes['POST /reports/run'] = () => json(403, { message: 'Not allowed', code: 'column_hidden', columns: ['costPaise'] });
    location.hash = '#/reports/builder';
    await screen.findByRole('option', { name: 'Time entries' });
    await u.selectOptions(screen.getByLabelText('Dataset'), 'time_entries');
    expect(screen.getByRole('checkbox', { name: /^Cost paise/ })).toBeDisabled();
    expect(screen.getByTestId('sens-costPaise')).toHaveTextContent('cost');
    await u.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByTestId('report-error')).toHaveTextContent('You cannot filter, group or sort by Cost');
  });

  it('builds, validates live and saves a report', async () => {
    routes['POST /reports/saved'] = (c) => json(201, { id: RID, name: (c.body as { name: string }).name });
    routes[`GET /reports/saved/${RID}`] = () => json(200, { id: RID, name: 'Unbilled GST', description: null, ownerId: 'u1', ownerName: 'Anita', definition: (calls.find((c) => c.path === '/reports/saved' && c.method === 'POST')!.body as { definition: unknown }).definition,
      explanation: '', currentVersion: 1, source: 'builder', catalogueKey: null, share: { firm: false, roles: [], userIds: [] }, canEdit: true, createdAt: '', updatedAt: '', version: 1 });
    location.hash = '#/reports/builder';
    render(<App />);
    const u = userEvent.setup();
    await screen.findByRole('option', { name: 'Unbilled work' });
    await u.selectOptions(screen.getByLabelText('Dataset'), 'unbilled');
    await u.click(screen.getByRole('checkbox', { name: /^Task text/ }));
    await u.click(screen.getByRole('checkbox', { name: /^Suggested fee paise/ }));
    await u.click(screen.getByRole('button', { name: 'Add filter' }));
    const f = screen.getByTestId('filter-0');
    await u.selectOptions(within(f).getByLabelText('Column'), 'completedOn');
    await u.selectOptions(within(f).getByLabelText('Operator'), 'fy');
    await u.selectOptions(within(f).getByLabelText('Financial year'), '2025-26');
    expect(screen.getByTestId('range-0')).toHaveTextContent('01 Apr 2025 – 31 Mar 2026');
    await u.selectOptions(screen.getByLabelText('Group by'), 'assigneeName');
    await u.click(screen.getByRole('button', { name: 'Add aggregate' }));
    await u.selectOptions(within(screen.getByTestId('agg-0')).getByLabelText('Of'), 'title');
    await u.selectOptions(within(screen.getByTestId('agg-0')).getByLabelText('Function'), 'count');
    expect(screen.getByTestId('builder-valid')).toBeInTheDocument();
    await u.selectOptions(within(screen.getByTestId('agg-0')).getByLabelText('Of'), 'suggestedPaise');
    await u.selectOptions(within(screen.getByTestId('agg-0')).getByLabelText('Function'), 'sum');
    await u.type(screen.getByLabelText('Name'), 'Unbilled GST');
    await u.click(screen.getByRole('button', { name: 'Save report' }));
    await waitFor(() => expect(location.hash).toBe(`#/reports/builder/${RID}`));
    expect(calls.find((c) => c.method === 'POST' && c.path === '/reports/saved')!.body).toEqual({ name: 'Unbilled GST', description: null, definition: {
      dataset: 'unbilled', columns: ['title', 'suggestedPaise'], filters: [{ column: 'completedOn', op: 'fy', value: '2025-26' }], groupBy: ['assigneeName'],
      aggregates: [{ fn: 'sum', column: 'suggestedPaise' }], sort: [], params: {}, chart: { type: 'table' } } });
    expect(await screen.findByRole('button', { name: /Versions \(v1\)/ })).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Share' }));
    expect(screen.getByTestId('share-note')).toHaveTextContent('Viewers always see their own scope');
  });

  it('export buttons need reports:export; CSV posts the source', async () => {
    routes['GET /me'] = () => json(200, me(['view']));
    location.hash = '#/reports/run/unbilled_by_client';
    const { unmount } = render(<App />);
    expect(await screen.findByTestId('report-totals')).toBeInTheDocument();
    expect(screen.queryByTestId('export-buttons')).toBeNull();
    unmount();
    routes['GET /me'] = () => json(200, me(['view', 'export']));
    routes['POST /reports/export'] = () => new Response('a,b', { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="unbilled.csv"' } });
    render(<App />);
    const u = userEvent.setup();
    await u.click(await within(await screen.findByTestId('export-buttons')).findByRole('button', { name: 'CSV' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/reports/export')).toBe(true));
    expect(calls.find((c) => c.path === '/reports/export')!.body).toEqual({ catalogueKey: 'unbilled_by_client', format: 'csv' });
  });

  it('creates a weekly schedule with an IST next-run preview and recipients', async () => {
    const SID = '0190a000-0000-7000-8000-0000000000d1';
    routes['POST /reports/schedules'] = (c) => json(201, { id: SID, ...(c.body as object) });
    location.hash = '#/reports/schedules';
    render(<App />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'New schedule' }));
    const dlg = await screen.findByRole('dialog');
    await u.selectOptions(within(dlg).getByLabelText('Report'), 'cat:ageing_buckets');
    await u.selectOptions(within(dlg).getByLabelText('Day'), '1');
    expect(within(dlg).getByTestId('schedule-preview')).toHaveTextContent(/Weekly on Monday at 08:00 IST · next run \d{2} \w{3} \d{4}, 08:00 IST/);
    await u.click(within(dlg).getByRole('checkbox', { name: 'Ravi' }));
    await u.selectOptions(within(dlg).getByLabelText('Format'), 'pdf');
    await u.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/reports/schedules')).toBe(true));
    expect(calls.find((c) => c.method === 'POST' && c.path === '/reports/schedules')!.body).toEqual({ name: 'Receivables ageing', schedule: { frequency: 'weekly', time: '08:00', weekday: 1, dayOfMonth: 1 },
      recipientIds: ['u1', UID2], format: 'pdf', delivery: 'email', linkTtlDays: 7, catalogueKey: 'ageing_buckets' });
  });

  it('scheduling for others: 403 recipients_forbidden is explained; history shows not_shared skips', async () => {
    const SID = '0190a000-0000-7000-8000-0000000000d2';
    routes['POST /reports/schedules'] = () => json(403, { message: 'x', code: 'recipients_forbidden' });
    routes['GET /reports/schedules'] = () => json(200, { items: [{ id: SID, name: 'Weekly ageing', ownerId: 'u1', reportId: null, catalogueKey: 'ageing_buckets', params: null,
      schedule: { frequency: 'weekly', time: '08:00', weekday: 1, dayOfMonth: 1 }, recipientIds: ['u1', UID2], delivery: 'email', format: 'xlsx', linkTtlDays: 7, enabled: true,
      status: 'paused', pausedReason: '3 failed periods', consecutiveFailures: 3, nextRunAt: null, lastRunAt: null, version: 1 }] });
    routes[`GET /reports/schedules/${SID}/runs`] = () => json(200, { items: [{ id: 'r1', periodKey: 'W2026-10-26', recipientId: UID2, recipientName: 'Ravi', status: 'skipped', skipReason: 'not_shared',
      rowCount: null, error: null, occurrenceAt: '2026-10-26T02:30:00Z', startedAt: '2026-10-26T02:30:00Z', finishedAt: null }] });
    location.hash = '#/reports/schedules';
    render(<App />);
    const u = userEvent.setup();
    expect(await screen.findByTestId('paused')).toHaveTextContent('Paused — 3 failed periods');
    await u.click(screen.getByRole('button', { name: 'History' }));
    expect(await screen.findByTestId('schedule-runs')).toHaveTextContent('Skipped — report not shared with this recipient');
    await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    await u.click(screen.getByRole('button', { name: 'New schedule' }));
    const dlg = await screen.findByRole('dialog');
    await u.selectOptions(within(dlg).getByLabelText('Report'), 'cat:ageing_buckets');
    await u.click(within(dlg).getByRole('checkbox', { name: 'Ravi' }));
    await u.click(within(dlg).getByRole('button', { name: 'Save' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('only for yourself and your direct reports');
  });

  it('shared report with [hidden] filter values: shown as-is, preview and save blocked', async () => {
    routes[`GET /reports/saved/${RID}`] = () => json(200, { id: RID, name: 'Partner clients', description: null, ownerId: 'u9', ownerName: 'Owner', explanation: '', currentVersion: 1, source: 'builder',
      catalogueKey: null, share: { firm: true }, canEdit: false, createdAt: '', updatedAt: '', version: 1,
      definition: { dataset: 'unbilled', columns: [], filters: [{ column: 'clientId', op: 'in', value: ['[hidden]', '[hidden]'] }], groupBy: [], aggregates: [], sort: [], params: {} } });
    location.hash = `#/reports/builder/${RID}`;
    render(<App />);
    expect(await screen.findByTestId('builder-masked')).toBeInTheDocument();
    expect(within(screen.getByTestId('filter-0')).getByLabelText('Value')).toHaveValue('[hidden], [hidden]');
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save new version' })).toBeNull();
  });

  it('download page explains expired and not-yours links', async () => {
    routes['GET /reports/downloads/tok_expired_aaaaaaaaaaaaaa'] = () => json(410, { code: 'link_expired' });
    location.hash = '#/reports/download/tok_expired_aaaaaaaaaaaaaa';
    render(<App />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Download' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This link has expired');
  });
});

describe('phase 11 Ask (NL query)', () => {
  it('PRD example shows the interpretation, sources, review badge and results; save as report', async () => {
    const def = { dataset: 'unbilled', columns: ['assigneeName', 'clientName', 'title', 'suggestedPaise'], filters: [{ column: 'serviceCategory', op: 'eq', value: 'GST' }, { column: 'completedOn', op: 'fy', value: '2025-26' }],
      groupBy: ['assigneeName'], aggregates: [{ fn: 'count' }, { fn: 'sum', column: 'suggestedPaise' }], sort: [], params: {}, chart: { type: 'bar' } };
    const result = runResult({ definition: { ...def, aggregates: [{ fn: 'count', as: 'count' }, { fn: 'sum', column: 'suggestedPaise', as: 'sum_suggestedPaise' }] }, chart: { type: 'bar' },
      groups: [{ key: { assigneeName: 'Ravi' }, label: 'Ravi', values: { count: 4, sum_suggestedPaise: 2_000_000 } }] });
    routes['POST /reports/ask'] = () => json(200, { id: RID, status: 'proposed', definition: def, explanation: 'Unbilled work, where Service category is GST and Completed on is in FY 2025-26, grouped by Assignee (user)',
      sources: [{ type: 'dataset', key: 'unbilled', label: 'Unbilled work', columns: ['assigneeName', 'serviceCategory', 'completedOn', 'suggestedPaise'] }], provider: 'mock', model: 'mock-1', mock: true, costPaise: 0, result });
    routes[`POST /reports/ask/${RID}/save`] = () => json(201, { id: RID, name: 'unbilled GST work FY 25-26 by user' });
    location.hash = '#/reports/ask';
    render(<App />);
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'unbilled GST work FY 25-26 by user' }));
    const ans = await screen.findByTestId('ask-answer');
    expect(within(ans).getByTestId('ask-badge')).toHaveTextContent('AI-generated query — review');
    expect(within(ans).getByTestId('ask-dataset')).toHaveTextContent('Unbilled work');
    expect(within(ans).getByTestId('ask-filters')).toHaveTextContent('Service category is GST; Completed on in FY 2025-26 (01 Apr 2025 – 31 Mar 2026)');
    expect(within(ans).getByTestId('ask-grouping')).toHaveTextContent('Assignee (user)');
    expect(within(ans).getByTestId('ask-sources')).toHaveTextContent('Unbilled work: Assignee (user), Service category, Completed on, Suggested fee');
    expect(within(within(ans).getByTestId('ask-results')).getByText('₹20,000.00')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/reports/ask' && c.method === 'POST')!.body).toEqual({ question: 'unbilled GST work FY 25-26 by user' });
    await u.click(within(ans).getByRole('button', { name: 'Save as report' }));
    await waitFor(() => expect(location.hash).toBe(`#/reports/builder/${RID}`));
  });

  it('shows invalid_model_output plainly', async () => {
    routes['POST /reports/ask'] = () => json(422, { code: 'invalid_model_output', message: 'x', issues: ['Unknown dataset payroll'] });
    location.hash = '#/reports/ask';
    render(<App />);
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Ask a question about your data'), 'payroll by month');
    await u.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByTestId('ask-error')).toHaveTextContent('The AI answer was not a valid report — rephrase the question. (Unknown dataset payroll)');
  });

  it('Ask is hidden when AI nl_query is off or the user lacks ai:create', async () => {
    routes['GET /ai/availability'] = () => json(200, avail('feature_disabled'));
    routes['GET /me'] = () => json(200, me(['view'], ['ai:view', 'ai:create']));
    location.hash = '#/reports/ask';
    const { unmount } = render(<App />);
    expect(await screen.findByRole('tab', { name: 'Catalogue' })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.path === '/ai/availability')).toBe(true));
    expect(screen.queryByRole('tab', { name: 'Ask' })).toBeNull();
    unmount();
    routes['GET /ai/availability'] = () => json(200, avail('ok'));
    render(<App />);
    expect(await screen.findByRole('tab', { name: 'Ask' })).toBeInTheDocument();
  });
});
