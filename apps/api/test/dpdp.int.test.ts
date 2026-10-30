import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockChannelHub } from '../src/comm/channels.js';
import { Clock } from '../src/common/clock.js';
import { PortalAuthService } from '../src/portal/portal-auth.service.js';
import { bearer, bootApp, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
let P: Session; let M: Session; let A: Session; let other: Session;
let X: string; let Y: string; let lead: string; let oldLead: string; let invoiceBefore: Record<string, unknown>;
const NOW = new Date('2026-10-30T10:00:00+05:30');
const H = (s: { accessToken: string }) => bearer(s.accessToken);
const PII = ['xavier@xco.example', '+919811100001', 'Yamini Traders', 'yamini@y.example', 'Lata Lead', 'lata@lead.example', 'my secret reason text'];

beforeAll(async () => {
  t = await bootApp();
  t.app.get(Clock).set(NOW);
  P = await t.signup('privco');
  M = await t.addUser(P, 'privco', 'Manu', 'manager');
  A = await t.addUser(P, 'privco', 'Arti', 'article');
  other = await t.signup('elsewhere');
  X = (await t.http().post('/v1/clients').set(H(P)).send({ name: 'Xavier Exports', entityType: 'INDIVIDUAL', email: 'xavier@xco.example', phone: '+919811100001',
    contacts: [{ name: 'Xavier', email: 'xavier@xco.example', isPrimary: true }] }).expect(201)).body.id;
  Y = (await t.http().post('/v1/clients').set(H(P)).send({ name: 'Yamini Traders', entityType: 'PROPRIETORSHIP', email: 'yamini@y.example',
    contacts: [{ name: 'Yamini', email: 'yamini@y.example', isPrimary: true }] }).expect(201)).body.id;
  await t.http().post('/v1/clients').set(H(other)).send({ name: 'Other Firm Client', entityType: 'INDIVIDUAL', email: 'other@else.example' }).expect(201);
  await t.sql(`UPDATE client SET aadhaar_enc = '\\x01'::bytea, aadhaar_last4 = '1234', dob = '1980-01-01' WHERE id = $1`, [X]);
  // An issued tax invoice (accounting record) for X → tax-records retention hold.
  const [e] = await t.sql<{ id: string }>('SELECT id FROM firm_entity WHERE tenant_id = $1', [P.tenantId]);
  await t.sql(`INSERT INTO invoice (id, tenant_id, entity_id, client_id, status, number, fy, issue_date, due_date, supply_type, supplier_state, bill_to, taxable_paise, total_paise, balance_paise)
    VALUES (gen_random_uuid(), $1, $2, $3, 'issued', 'PV/2627/0001', 2026, '2026-04-15', '2026-04-30', 'unregistered', '27', '{"name":"Xavier Exports"}', 100000, 100000, 100000)`, [P.tenantId, e!.id, X]);
  invoiceBefore = (await t.sql('SELECT number, bill_to, total_paise, status, issue_date FROM invoice WHERE client_id = $1', [X]))[0]!;
  await t.sql(`INSERT INTO comm_message (id, tenant_id, client_id, direction, channel, address, subject, body, status) VALUES (gen_random_uuid(), $1, $2, 'out', 'email', 'xavier@xco.example', 'Docs', 'Dear Xavier, please send PAN', 'sent')`, [P.tenantId, X]);
  await t.sql(`INSERT INTO comm_message (id, tenant_id, client_id, direction, channel, address, subject, body, status, created_at) VALUES (gen_random_uuid(), $1, $2, 'out', 'email', 'yamini@y.example', 'Old', 'Ancient message', 'sent', '2020-01-01')`, [P.tenantId, Y]);
  await t.sql(`INSERT INTO comm_consent (id, tenant_id, channel, address, client_id, status, opted_in_at, opted_in_source) VALUES (gen_random_uuid(), $1, 'email', 'xavier@xco.example', $2, 'opted_in', now(), 'portal')`, [P.tenantId, X]);
  lead = (await t.sql<{ id: string }>(`INSERT INTO lead (id, tenant_id, name, email, phone) VALUES (gen_random_uuid(), $1, 'Lata Lead', 'lata@lead.example', '+919800000077') RETURNING id`, [P.tenantId]))[0]!.id;
  oldLead = (await t.sql<{ id: string }>(`INSERT INTO lead (id, tenant_id, name, email, stage, lost_reason, stage_changed_at) VALUES (gen_random_uuid(), $1, 'Old Lost', 'old@lead.example', 'lost', 'price', '2023-01-01') RETURNING id`, [P.tenantId]))[0]!.id;
}, 60_000);
afterAll(() => t?.close());

const createReq = (kind: string, principalType: string, principalId: string, details?: string) =>
  t.http().post('/v1/privacy/requests').set(H(P)).send({ kind, principalType, principalId, details }).expect(201).then((r) => r.body);

describe('inventory, settings, consents', () => {
  it('inventory is data with retention; sample SLA defaults; consent registry masks addresses', async () => {
    const inv = (await t.http().get('/v1/privacy/inventory').set(H(P)).expect(200)).body;
    expect(inv.inventory.find((e: { table: string }) => e.table === 'client').fields.map((f: { name: string }) => f.name)).toContain('aadhaar_enc');
    expect(inv.retention.tax_records).toMatchObject({ legalHold: true });
    expect((await t.http().get('/v1/privacy/settings').set(H(P)).expect(200)).body.settings.slaDays.access).toBe(30);
    await t.http().put('/v1/privacy/settings').set(H(P)).send({ retention: { tax_records: { days: 30 } } }).expect(400);
    await t.http().put('/v1/privacy/settings').set(H(P)).send({ retention: { leads: { days: 365 } } }).expect(200);
    const c = (await t.http().get('/v1/privacy/consents').set(H(P)).expect(200)).body;
    expect(c[0].addressMasked).toMatch(/^•+mple$/);
    expect(JSON.stringify(c)).not.toContain('xavier@xco.example');
    await t.http().get('/v1/privacy/requests').set(H(A)).expect(403);
  });
});

describe('access requests → export bundle', () => {
  let req: { id: string; dueOn: string; sla: string };
  it('intake with SLA due date; export contains ONLY the principal\'s data; link expires', async () => {
    req = await createReq('access', 'client', X, 'my secret reason text');
    expect(req).toMatchObject({ status: 'received', receivedOn: '2026-10-30', dueOn: '2026-11-29', sla: 'on_track', details: 'my secret reason text' });
    await t.http().post('/v1/privacy/requests').set(H(P)).send({ kind: 'access', principalType: 'client', principalId: '00000000-0000-4000-8000-000000000000' }).expect(400);
    await t.http().post(`/v1/privacy/requests/${req.id}/export`).set(H(M)).expect(403); // needs firm-wide settings:export
    const ex = (await t.http().post(`/v1/privacy/requests/${req.id}/export`).set(H(P)).expect(200)).body;
    expect(ex.path).toMatch(/^\/v1\/privacy\/exports\//);
    const res = await t.http().get(ex.path).expect(200);
    const b = JSON.parse(res.text);
    expect(b.client[0]).toMatchObject({ name: 'Xavier Exports', email: 'xavier@xco.example' });
    expect(b.invoice.map((i: { number: string }) => i.number)).toEqual(['PV/2627/0001']);
    expect(b.comm_message.map((m: { subject: string }) => m.subject)).toEqual(['Docs']);
    for (const s of ['Yamini', 'Other Firm Client', 'other@else.example', 'Ancient message', 'Lata']) expect(res.text).not.toContain(s);
    await t.http().get('/v1/privacy/exports/not-a-real-token-xxxxxxxxxxxxxx').expect(404);
    t.app.get(Clock).set(new Date(NOW.getTime() + 8 * 86_400_000));
    await t.http().get(ex.path).expect(410);
    t.app.get(Clock).set(NOW);
    const list = (await t.http().get('/v1/privacy/requests').set(H(P)).expect(200)).body;
    expect(list.find((r: { id: string }) => r.id === req.id).status).toBe('in_progress');
    await t.http().patch(`/v1/privacy/requests/${req.id}`).set(H(P)).send({ status: 'completed', resolution: 'Bundle shared' }).expect(200);
    await t.http().patch(`/v1/privacy/requests/${req.id}`).set(H(P)).send({ status: 'in_progress' }).expect(400);
  });
});

describe('erasure', () => {
  it('respects the tax-records hold: partial, accounting rows untouched, secrets shredded, contact data gone', async () => {
    const r = await createReq('erasure', 'client', X);
    await t.http().post(`/v1/privacy/requests/${r.id}/erase`).set(H(M)).send({ dryRun: true }).expect(403);
    const dry = (await t.http().post(`/v1/privacy/requests/${r.id}/erase`).set(H(P)).send({ dryRun: true }).expect(200)).body;
    expect(dry.outcome).toBe('partial');
    expect(dry.steps.find((s: { table: string; action: string }) => s.table === 'client' && s.action === 'retain').reason).toMatch(/^legal_hold:tax_records:until:2034-/);
    expect((await t.sql<{ email: string }>('SELECT email FROM client WHERE id = $1', [X]))[0]!.email).toBe('xavier@xco.example'); // dry-run changed nothing
    const done = (await t.http().post(`/v1/privacy/requests/${r.id}/erase`).set(H(P)).send({ dryRun: false }).expect(200)).body;
    expect(done).toMatchObject({ outcome: 'partial', status: 'partially_completed' });
    const [c] = await t.sql<Record<string, unknown>>('SELECT name, email, phone, aadhaar_enc, dob, addresses FROM client WHERE id = $1', [X]);
    expect(c).toMatchObject({ name: 'Xavier Exports', email: null, phone: null, aadhaar_enc: null, addresses: [] });
    expect((await t.sql('SELECT number, bill_to, total_paise, status, issue_date FROM invoice WHERE client_id = $1', [X]))[0]).toEqual(invoiceBefore);
    expect((await t.sql<{ body: string; address: string | null }>('SELECT body, address FROM comm_message WHERE client_id = $1', [X]))[0]).toMatchObject({ body: '[erased]', address: null });
    expect((await t.sql<{ address: string }>('SELECT address FROM comm_consent WHERE client_id = $1', [X]))[0]!.address).toBe('xavier@xco.example'); // proof of consent retained
    await t.http().post(`/v1/privacy/requests/${r.id}/erase`).set(H(P)).send({ dryRun: false }).expect(400);
  });

  it('no hold → client master anonymised; leads fully', async () => {
    const r = await createReq('erasure', 'client', Y);
    const out = (await t.http().post(`/v1/privacy/requests/${r.id}/erase`).set(H(P)).send({ dryRun: false }).expect(200)).body;
    // only the always-held tables (accounting rows, proof of consent) are retained — the client master itself is anonymised
    expect(out.steps.filter((s: { action: string }) => s.action === 'retain').map((s: { table: string }) => s.table).sort()).toEqual(['comm_consent', 'invoice', 'receipt']);
    expect((await t.sql<{ name: string; email: string | null }>('SELECT name, email FROM client WHERE id = $1', [Y]))[0]).toEqual({ name: '[erased]', email: null });
    const l = await createReq('erasure', 'lead', lead);
    expect((await t.http().post(`/v1/privacy/requests/${l.id}/erase`).set(H(P)).send({ dryRun: false }).expect(200)).body.status).toBe('completed');
    expect((await t.sql<{ name: string; email: string | null }>('SELECT name, email FROM lead WHERE id = $1', [lead]))[0]).toEqual({ name: '[erased]', email: null });
  });

  it('active staff cannot be erased (blocked → rejected)', async () => {
    const r = await createReq('erasure', 'staff', A.userId);
    expect((await t.http().post(`/v1/privacy/requests/${r.id}/erase`).set(H(P)).send({ dryRun: false }).expect(200)).body).toMatchObject({ outcome: 'blocked', status: 'rejected' });
  });
});

describe('breach register', () => {
  it('records incidents with a report deadline and notification tracking', async () => {
    const b = (await t.http().post('/v1/privacy/breaches').set(H(P)).send({ title: 'Laptop stolen', description: 'Contained Xavier files', severity: 'high', awareAt: '2026-10-29T10:00:00+05:30', affectedCount: 42, dataCategories: ['identity', 'financial'] }).expect(201)).body;
    expect(new Date(b.reportDueAt).toISOString()).toBe('2026-11-01T04:30:00.000Z');
    const u = (await t.http().patch(`/v1/privacy/breaches/${b.id}`).set(H(P)).send({ status: 'contained', boardNotifiedAt: '2026-10-30T09:00:00+05:30', principalsNotifiedCount: 42 }).expect(200)).body;
    expect(u).toMatchObject({ status: 'contained', principalsNotifiedCount: 42, description: 'Contained Xavier files' });
    expect((await t.http().get('/v1/privacy/breaches').set(H(other)).expect(200)).body).toEqual([]);
  });
});

describe('retention purge', () => {
  it('a real run needs a dry-run first; the dry-run has no side effects; the run applies the counts', async () => {
    expect((await t.http().post('/v1/privacy/purge').set(H(P)).send({ dryRun: false }).expect(409)).body.code).toBe('dry_run_required');
    const before = await t.sql('SELECT name, email FROM lead WHERE id = $1', [oldLead]);
    const msgBefore = await t.sql(`SELECT body FROM comm_message WHERE client_id = $1 ORDER BY created_at`, [Y]);
    const dry = (await t.http().post('/v1/privacy/purge').set(H(P)).send({ dryRun: true }).expect(200)).body;
    expect(dry.counts).toMatchObject({ leads: 1 });
    expect(await t.sql('SELECT name, email FROM lead WHERE id = $1', [oldLead])).toEqual(before);
    expect(await t.sql(`SELECT body FROM comm_message WHERE client_id = $1 ORDER BY created_at`, [Y])).toEqual(msgBefore);
    const real = (await t.http().post('/v1/privacy/purge').set(H(P)).send({ dryRun: false }).expect(200)).body;
    expect(real.counts.leads).toBe(1);
    expect((await t.sql<{ name: string }>('SELECT name FROM lead WHERE id = $1', [oldLead]))[0]!.name).toBe('[erased]');
    const runs = (await t.http().get('/v1/privacy/purge-runs').set(H(P)).expect(200)).body;
    expect(runs.map((r: { dryRun: boolean }) => r.dryRun)).toEqual([false, true]);
  });
});

describe('portal intake', () => {
  it('a portal user raises a request about a client they can access; staff see it with source portal', async () => {
    const hub = t.app.get(MockChannelHub);
    const [ct] = await t.sql<{ id: string }>(`SELECT id FROM contact WHERE client_id = $1`, [X]);
    await t.sql(`UPDATE contact SET email = 'xc@xco.example' WHERE id = $1`, [ct!.id]);
    await t.http().post('/v1/portal-admin/invites').set(H(P)).send({ clientId: X, contactId: ct!.id }).expect(201);
    await t.http().post('/v1/portal/auth/otp/request').send({ firm: 'privco', identifier: 'xc@xco.example' }).expect(202);
    await t.app.get(PortalAuthService).drain();
    const code = [...hub.outbox].reverse().find((m) => m.to === 'xc@xco.example')!.text.match(/\b(\d{6})\b/)![1];
    const pt = (await t.http().post('/v1/portal/auth/otp/verify').send({ firm: 'privco', identifier: 'xc@xco.example', code, device: { platform: 'web' } }).expect(200)).body;
    const r = (await t.http().post('/v1/portal/privacy-requests').set(H(pt)).send({ kind: 'correction', clientId: X, details: 'Fix my address' }).expect(201)).body;
    await t.http().post('/v1/portal/privacy-requests').set(H(pt)).send({ kind: 'access', clientId: Y }).expect(404);
    expect((await t.http().get('/v1/portal/privacy-requests').set(H(pt)).expect(200)).body.map((x: { id: string }) => x.id)).toEqual([r.id]);
    await t.http().get('/v1/portal/privacy-requests').set(H(P)).expect(401);
    const staff = (await t.http().get('/v1/privacy/requests').set(H(P)).expect(200)).body.find((x: { id: string }) => x.id === r.id);
    expect(staff).toMatchObject({ source: 'portal', principalType: 'client', principalId: X, details: 'Fix my address' });
  });
});

describe('no PII in audit', () => {
  it('audit diffs carry ids, kinds, counts and field names only', async () => {
    const rows = await t.sql<{ action: string; diff: unknown }>(`SELECT action, diff FROM audit_log WHERE tenant_id = $1 AND (action LIKE 'dpdp.%')`, [P.tenantId]);
    expect(rows.length).toBeGreaterThan(8);
    const blob = JSON.stringify(rows);
    for (const s of [...PII, 'Contained Xavier files', 'Fix my address', 'Bundle shared', 'Xavier Exports']) expect(blob).not.toContain(s);
  });
});
