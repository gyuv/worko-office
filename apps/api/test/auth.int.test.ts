import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { Clock } from '../src/common/clock.js';
import { MockChannelHub } from '../src/comm/channels.js';
import { base32Decode, totp } from '../src/auth/crypto.js';
import { type MockSmsProvider, SMS_PROVIDER } from '../src/auth/sms.provider.js';
import { migrate } from '../src/db/migrate.js';
import { freshDatabase } from './db.js';


let app: INestApplication;
let db: Awaited<ReturnType<typeof freshDatabase>>;
let sms: MockSmsProvider;
const http = () => request(app.getHttpServer());
const web = { platform: 'web', label: 'Chrome' };
const PW = 'correct horse battery';

async function signup(slug: string, email = `partner@${slug}.in`, phone?: string) {
  await http().post('/v1/tenants/signup').send({ firmName: `${slug} & Co`, slug, stateCode: '27', partner: { name: 'P', email, password: PW, phone } }).expect(201);
  const r = await http().post('/v1/auth/login').send({ firm: slug, email, password: PW, device: web }).expect(200);
  return r.body as { accessToken: string; refreshToken: string; sessionId: string; tenantId: string; userId: string };
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  db = await freshDatabase();
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  app.setGlobalPrefix('v1');
  await app.init();
  sms = app.get(SMS_PROVIDER);
}, 60_000);
afterAll(async () => { await app?.close(); await db?.drop(); });

describe('migrations', () => {
  it('are idempotent', async () => expect(await migrate(db.url)).toEqual([]));
});

describe('signup + login', () => {
  it('creates a firm and logs the partner in', async () => {
    const s = await signup('sharma');
    const me = await http().get('/v1/me').set(bearer(s.accessToken)).expect(200);
    expect(me.body).toMatchObject({ firmSlug: 'sharma', roles: ['partner'] });
  });
  it('rejects duplicate slug and weak password', async () => {
    await http().post('/v1/tenants/signup').send({ firmName: 'XY', slug: 'sharma', stateCode: '27', partner: { name: 'P', email: 'a@b.in', password: PW } }).expect(409);
    await http().post('/v1/tenants/signup').send({ firmName: 'XY', slug: 'weak', stateCode: '27', partner: { name: 'P', email: 'a@b.in', password: 'short' } }).expect(400);
  });
  it('does not reveal whether a firm exists', async () => {
    const a = await http().post('/v1/auth/login').send({ firm: 'nope', email: 'x@y.in', password: 'x', device: web }).expect(401);
    const b = await http().post('/v1/auth/login').send({ firm: 'sharma', email: 'partner@sharma.in', password: 'wrong', device: web }).expect(401);
    expect(a.body.message).toBe(b.body.message);
  });
  it('requires auth on protected routes', () => http().get('/v1/me').expect(401));
});

describe('lockout', () => {
  it('locks after 5 failures, even with the right password', async () => {
    await signup('lockco');
    for (let i = 0; i < 5; i++) await http().post('/v1/auth/login').send({ firm: 'lockco', email: 'partner@lockco.in', password: 'bad', device: web }).expect(401);
    await http().post('/v1/auth/login').send({ firm: 'lockco', email: 'partner@lockco.in', password: PW, device: web }).expect(429);
  });
});

describe('refresh rotation', () => {
  it('rotates, and replaying an old token revokes the session', async () => {
    const s = await signup('rotco');
    const r1 = await http().post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(200);
    expect(r1.body.refreshToken).not.toBe(s.refreshToken);
    await http().post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401); // reuse
    await http().post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401); // family revoked
    await http().get('/v1/me').set(bearer(r1.body.accessToken)).expect(401);
  });
});

describe('TOTP 2FA', () => {
  it('enables and then requires the code', async () => {
    const s = await signup('totpco');
    const setup = await http().post('/v1/auth/totp/setup').set(bearer(s.accessToken)).expect(201);
    const secret = base32Decode(setup.body.secret);
    await http().post('/v1/auth/totp/enable').set(bearer(s.accessToken)).send({ code: '000000' === totp(secret) ? '111111' : '000000' }).expect(401);
    await http().post('/v1/auth/totp/enable').set(bearer(s.accessToken)).send({ code: totp(secret) }).expect(204);
    const noCode = await http().post('/v1/auth/login').send({ firm: 'totpco', email: 'partner@totpco.in', password: PW, device: web }).expect(401);
    expect(noCode.body.code).toBe('MFA_REQUIRED');
    // Next time step: the step used to enable is spent (replay protection).
    await http().post('/v1/auth/login').send({ firm: 'totpco', email: 'partner@totpco.in', password: PW, totp: totp(secret, Date.now() + 30_000), device: web }).expect(200);
  });
});

describe('phone OTP', () => {
  it('logs in with an SMS code; wrong codes are counted', async () => {
    await signup('otpco', 'partner@otpco.in', '+919876543210');
    await http().post('/v1/auth/otp/request').send({ firm: 'otpco', phone: '+919876543210' }).expect(202);
    await http().post('/v1/auth/otp/request').send({ firm: 'otpco', phone: '+919999999999' }).expect(202); // unknown: same answer
    const code = sms.sent.at(-1)!.text.slice(0, 6);
    await http().post('/v1/auth/otp/verify').send({ firm: 'otpco', phone: '+919876543210', code: code === '000000' ? '111111' : '000000', device: web }).expect(401);
    await http().post('/v1/auth/otp/verify').send({ firm: 'otpco', phone: '+919876543210', code, device: { platform: 'android' } }).expect(200);
    await http().post('/v1/auth/otp/verify').send({ firm: 'otpco', phone: '+919876543210', code, device: web }).expect(401); // single use
  });
});

describe('devices, remote wipe, permissions', () => {
  it('partner wipes a lost laptop; it gets DEVICE_WIPE; audit shows it; chain verifies', async () => {
    const s = await signup('wipeco');
    const laptop = await http().post('/v1/auth/login').send({ firm: 'wipeco', email: 'partner@wipeco.in', password: PW, device: { platform: 'desktop', label: 'Laptop' } }).expect(200);
    const list = await http().get('/v1/auth/sessions').set(bearer(s.accessToken)).expect(200);
    expect(list.body).toHaveLength(2);
    await http().post(`/v1/auth/sessions/${laptop.body.sessionId}/wipe`).set(bearer(s.accessToken)).expect(204);
    const r = await http().get('/v1/me').set(bearer(laptop.body.accessToken)).expect(401);
    expect(r.body.code).toBe('DEVICE_WIPE');
    const rr = await http().post('/v1/auth/refresh').send({ refreshToken: laptop.body.refreshToken }).expect(401);
    expect(rr.body.code).toBe('DEVICE_WIPE');
    const audit = await http().get('/v1/audit').set(bearer(s.accessToken)).expect(200);
    expect(audit.body.map((e: { action: string }) => e.action)).toContain('auth.remote_wipe');
    expect((await http().get('/v1/audit/verify').set(bearer(s.accessToken)).expect(200)).body).toMatchObject({ ok: true });
  });

  it('article cannot list users or read audit; cannot be used to escalate', async () => {
    const s = await signup('permco');
    await http().post('/v1/users').set(bearer(s.accessToken)).send({ name: 'Art', email: 'art@permco.in', password: PW, roleKeys: ['article'] }).expect(201);
    const art = (await http().post('/v1/auth/login').send({ firm: 'permco', email: 'art@permco.in', password: PW, device: web }).expect(200)).body;
    await http().get('/v1/users').set(bearer(art.accessToken)).expect(403);
    await http().get('/v1/audit').set(bearer(art.accessToken)).expect(403);
    await http().post('/v1/users').set(bearer(art.accessToken)).send({ name: 'X', email: 'x@permco.in', password: PW, roleKeys: ['partner'] }).expect(403);
    await http().get('/v1/me').set(bearer(art.accessToken)).expect(200);
  });

  it('cannot revoke another user\'s session without users:edit', async () => {
    const s = await signup('sessco');
    await http().post('/v1/users').set(bearer(s.accessToken)).send({ name: 'Art', email: 'art@sessco.in', password: PW, roleKeys: ['article'] }).expect(201);
    const art = (await http().post('/v1/auth/login').send({ firm: 'sessco', email: 'art@sessco.in', password: PW, device: web }).expect(200)).body;
    await http().post(`/v1/auth/sessions/${s.sessionId}/revoke`).set(bearer(art.accessToken)).expect(403);
  });
});

describe('tenant isolation (RLS) and audit tamper evidence', () => {
  it('firm A cannot see firm B users; tampering breaks the chain', async () => {
    const a = await signup('firma');
    const b = await signup('firmb');
    const ua = await http().get('/v1/users').set(bearer(a.accessToken)).expect(200);
    expect(ua.body.map((u: { email: string }) => u.email)).toEqual(['partner@firma.in']);
    // A forged token for B's session but A's tenant id finds nothing under RLS.
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    await c.query("UPDATE audit_log SET action = 'tampered' WHERE seq = (SELECT min(seq) FROM audit_log WHERE tenant_id = $1)", [b.tenantId]);
    await c.end();
    expect((await http().get('/v1/audit/verify').set(bearer(b.accessToken)).expect(200)).body.ok).toBe(false);
    expect((await http().get('/v1/audit/verify').set(bearer(a.accessToken)).expect(200)).body.ok).toBe(true);
  });
});

describe('rules endpoints', () => {
  it('require auth + compliance:view, validate input and report extension impact', async () => {
    const s = await signup('rulesco');
    await http().post('/v1/rules/preview').send({ fy: 2026, clients: [] }).expect(401);
    await http().post('/v1/rules/preview').set(bearer(s.accessToken)).send({ fy: 'x' }).expect(400);
    const clients = Array.from({ length: 412 }, (_, i) => ({ id: `c${i}`, gstRegistered: true, gstFiling: 'MONTHLY' }));
    const res = await http().post('/v1/rules/extension-impact').set(bearer(s.accessToken)).send({
      fy: 2026, clients, extensions: [{ id: 'n1', ruleId: 'gst.gstr3b.monthly', periodKey: '2026-09', newDueDate: '2026-10-25' }],
    }).expect(201);
    expect(res.body).toMatchObject({ clientsAffected: 412, dueDatesChanged: 1 });
  });
  it('health is public', () => http().get('/v1/health').expect(200, { status: 'ok', product: 'Worko' }));
});

describe('demo seed', () => {
  it('creates the demo firm once and every demo user can log in', async () => {
    const { seedDemo, DEMO } = await import('../src/db/seed-demo.js');
    expect((await seedDemo(db.url, { today: '2026-10-15' })).created).toBe(true);
    expect((await seedDemo(db.url, { today: '2026-10-15' })).created).toBe(false);
    const tok: Record<string, string> = {};
    for (const u of DEMO.users) {
      const r = await http().post('/v1/auth/login').send({ firm: 'demo', email: u.email, password: DEMO.password, device: web }).expect(200);
      expect((await http().get('/v1/me').set(bearer(r.body.accessToken))).body.roles).toEqual([u.role]);
      tok[u.role] = r.body.accessToken;
    }
    expect((await http().get('/v1/clients?limit=500').set(bearer(tok.partner!))).body.total).toBe(51); // 50 + one converted from an accepted proposal (Phase 9)
    expect((await http().get('/v1/clients?limit=500').set(bearer(tok.article!))).body.total).toBe(12);
    const [secret] = (await http().get('/v1/vault/secrets?portal=INCOME_TAX').set(bearer(tok.partner!)).expect(200)).body;
    await http().post('/v1/auth/step-up').set(bearer(tok.partner!)).send({ password: DEMO.password }).expect(200);
    expect((await http().post(`/v1/vault/secrets/${secret.id}/reveal`).set(bearer(tok.partner!)).send({ purpose: 'view' }).expect(200)).body.password).toMatch(/^Demo#/);
    const [doc] = (await http().get('/v1/documents?category=ITR').set(bearer(tok.partner!))).body.items;
    const { body: { url } } = await http().post(`/v1/documents/${doc.id}/download-url`).set(bearer(tok.partner!)).send({}).expect(200);
    await http().get(url).expect(200);
    // Phase 4: catalogue, auto-created tasks for Aug + Sep 2026, statuses, to-dos, a draft extension.
    const all = (await http().get('/v1/tasks?limit=1000').set(bearer(tok.partner!)).expect(200)).body;
    const g3b = all.items.filter((x: { ruleId: string }) => x.ruleId === 'gst.gstr3b.monthly');
    expect(new Set(g3b.map((x: { periodKey: string }) => x.periodKey))).toEqual(new Set(['2026-08', '2026-09']));
    const statuses = new Set(all.items.map((x: { status: string }) => x.status));
    for (const s of ['open', 'in_progress', 'review', 'pending_client', 'done']) expect(statuses).toContain(s);
    expect(all.items.some((x: { outcome: string }) => x.outcome === 'billed')).toBe(true);
    expect((await http().get('/v1/tasks?overdue=true&asOf=2026-10-15').set(bearer(tok.partner!))).body.total).toBeGreaterThan(0);
    const art = (await http().get('/v1/tasks?limit=1000').set(bearer(tok.article!))).body;
    expect(art.total).toBeGreaterThan(0);
    expect(art.total).toBeLessThan(all.total);
    expect((await http().get('/v1/todos').set(bearer(tok.article!))).body).toHaveLength(2);
    const [ext] = (await http().get('/v1/compliance/extensions').set(bearer(tok.partner!))).body;
    expect(ext).toMatchObject({ status: 'draft', ruleId: 'gst.gstr3b.monthly', periodKey: '2026-09', newDueDate: '2026-10-25' });
    expect((await http().get(`/v1/compliance/extensions/${ext.id}/impact`).set(bearer(tok.partner!))).body.tasksToMove).toBeGreaterThan(0);
    expect((await http().post('/v1/tasks/auto/commit').set(bearer(tok.partner!)).send({ month: '2026-09' }).expect(200)).body.created).toBe(0);
    // Phase 5: entities, invoices across statuses and ageing buckets, receipts with TDS, a credit note, advance, retainer, unbilled work.
    const P = bearer(tok.partner!);
    expect((await http().get('/v1/billing/entities').set(P).expect(200)).body.map((e: { invoicePrefix: string; registered: boolean }) => `${e.invoicePrefix}:${e.registered}`).sort()).toEqual(['SMA:true', 'SMK:true']);
    const inv = (await http().get('/v1/billing/invoices?limit=1000').set(P).expect(200)).body.items as Array<{ status: string; kind: string; source: string; balancePaise: number; number: string | null }>;
    for (const st of ['draft', 'issued', 'paid', 'partially_paid']) expect(inv.map((i) => i.status)).toContain(st);
    expect(inv.some((i) => i.kind === 'credit_note')).toBe(true);
    expect(inv.some((i) => i.source === 'retainer')).toBe(true);
    expect(inv.find((i) => i.number === 'SMA/2627/0001')).toBeTruthy();
    const ag = (await http().get('/v1/billing/ageing?asOf=2026-10-15').set(P).expect(200)).body;
    expect(['notDue', 'd0_30', 'd31_60', 'd61_90', 'd90plus'].filter((b) => ag.totals[b] > 0).length).toBeGreaterThanOrEqual(4);
    expect(ag.totals.totalPaise).toBe(inv.filter((i) => ['issued', 'partially_paid'].includes(i.status)).reduce((s, i) => s + i.balancePaise, 0));
    expect(ag.totals.advancePaise).toBe(500_000);
    const rec = (await http().get('/v1/billing/receipts').set(P).expect(200)).body.items as Array<{ tdsPaise: number }>;
    expect(rec).toHaveLength(3);
    expect(rec.some((r) => r.tdsPaise > 0)).toBe(true);
    expect((await http().get('/v1/billing/unbilled').set(P).expect(200)).body.count).toBeGreaterThan(0);
    expect((await http().get('/v1/billing/invoices').set(bearer(tok.accountant!)).expect(200)).body.total).toBe(inv.length);
    await http().get('/v1/billing/invoices').set(bearer(tok.article!)).expect(403);
    const e1 = (await http().get('/v1/billing/entities').set(P)).body.find((e: { invoicePrefix: string }) => e.invoicePrefix === 'SMA').id;
    const sma = (await http().get('/v1/billing/invoices?kind=invoice&limit=1000').set(P)).body.items.filter((i: { number: string | null }) => i.number?.startsWith('SMA/'))
      .sort((x: { number: string }, y: { number: string }) => x.number.localeCompare(y.number)).map((i: { issueDate: string }) => i.issueDate);
    expect(sma).toEqual([...sma].sort()); // numbers follow date order
    expect(all.items.some((x: { periodKey: string; status: string }) => x.periodKey === '2026-09' && x.status === 'done')).toBe(true); // recent done work exists
    expect((await http().post('/v1/billing/tally/dry-run').set(P).send({ entityId: e1, from: '2026-04-01', to: '2027-03-31' }).expect(200)).body.errors).toEqual([]);
    // Phase 6: holidays, office fence, cost rates, time (approved + submitted), attendance (one flagged), leave incl. study leave, comp-off, expenses.
    const A = bearer(tok.article!); const M = bearer(tok.manager!);
    expect((await http().get('/v1/hr/holidays').set(A).expect(200)).body).toHaveLength(2);
    expect((await http().get('/v1/hr/office-locations').set(P).expect(200)).body).toHaveLength(1);
    expect((await http().get('/v1/hr/cost-rates').set(P).expect(200)).body).toHaveLength(5);
    const te = (await http().get('/v1/time/entries?limit=1000').set(P).expect(200)).body.items as Array<{ status: string }>;
    expect(te.filter((x) => x.status === 'approved').length).toBeGreaterThan(10);
    expect(te.filter((x) => x.status === 'submitted').length).toBe(15);
    const att = (await http().get('/v1/hr/attendance').set(M).expect(200)).body as Array<{ flags: string[] }>;
    expect(att.filter((x) => x.flags.includes('out_of_fence'))).toHaveLength(1);
    const lr = (await http().get('/v1/hr/leave/requests').set(A).expect(200)).body as Array<{ leaveTypeKey: string; status: string }>;
    expect(lr.find((x) => x.leaveTypeKey === 'study')?.status).toBe('partially_approved');
    const bal = (await http().get('/v1/hr/leave/balances').set(A).expect(200)).body.balances as Array<{ leaveType: { key: string }; balance: number }>;
    expect(bal.find((b) => b.leaveType.key === 'comp_off')?.balance).toBe(0.5);
    expect(bal.find((b) => b.leaveType.key === 'study')?.balance).toBe(8);
    const claims = (await http().get('/v1/hr/expenses/claims').set(A).expect(200)).body as Array<{ status: string; advanceSettledPaise: number }>;
    expect(claims[0]).toMatchObject({ status: 'paid', advanceSettledPaise: 140_000, paidPaise: 0 });
    expect((await http().get('/v1/hr/expenses/advances').set(A).expect(200)).body.outstandingPaise).toBe(60_000);
    expect((await http().get('/v1/hr/expenses/reimbursable').set(P).expect(200)).body.items).toHaveLength(0); // already linked to an invoice
    const pnl = (await http().get('/v1/reports/job-pnl?from=2026-01-01&to=2026-12-31&groupBy=client').set(P).expect(200)).body;
    expect(pnl.totals.costPaise).toBeGreaterThan(0);
    expect((await http().get('/v1/reports/capacity?weeks=4&from=2026-10-12').set(M).expect(200)).body.users.length).toBeGreaterThanOrEqual(3);
    // Phase 7: templates, consents (one opted out), a mixed timeline, triage inbox, broadcasts, team chat, calendar, booking.
    const tpls = (await http().get('/v1/comm/templates').set(P).expect(200)).body as Array<{ status: string; name: string }>;
    expect(new Set(tpls.map((x) => x.status))).toEqual(new Set(['approved', 'draft']));
    const q = async <T,>(text: string) => { const c = new pg.Client({ connectionString: db.url }); await c.connect(); try { return (await c.query(text)).rows as T[]; } finally { await c.end(); } };
    const firstClient = (await q<{ id: string }>(`SELECT id FROM client ORDER BY file_no LIMIT 1`))[0]!.id;
    const tl = (await http().get(`/v1/clients/${firstClient}/timeline`).set(P).expect(200)).body.items as Array<{ kind: string; channel: string | null }>;
    for (const ch of ['email', 'whatsapp', 'sms', 'note', 'call']) expect(tl.some((x) => x.kind === 'message' && x.channel === ch)).toBe(true);
    expect(tl.some((x) => x.kind === 'document')).toBe(true);
    expect((await http().get('/v1/comm/inbox').set(M).expect(200)).body).toHaveLength(1);
    const cons = await q<{ status: string }>(`SELECT status FROM comm_consent`);
    expect(cons.filter((x) => x.status === 'opted_out')).toHaveLength(1);
    const bcs = (await http().get('/v1/comm/broadcasts').set(P).expect(200)).body as Array<{ status: string; id: string }>;
    expect(bcs.map((b) => b.status).sort()).toEqual(['completed', 'draft']);
    expect((await http().get(`/v1/comm/broadcasts/${bcs.find((b) => b.status === 'completed')!.id}`).set(P)).body.progress.counts).toEqual({ sent: 5, skipped_optout: 1 });
    const chans = (await http().get('/v1/chat/channels').set(bearer(tok.senior!)).expect(200)).body as Array<{ kind: string }>;
    expect(chans.map((c) => c.kind).sort()).toEqual(['client', 'team']);
    expect((await http().get('/v1/notifications').set(A).expect(200)).body.some((n: { category: string }) => n.category === 'chat.mentioned')).toBe(true);
    expect((await http().get('/v1/calendar/events?from=2026-10-15&to=2026-10-31').set(M).expect(200)).body.filter((i: { source: string }) => i.source === 'event').length).toBeGreaterThanOrEqual(3);
    expect((await http().get('/v1/booking/appointments').set(P).expect(200)).body).toHaveLength(2);
    // Phase 8: notices (overdue + hearing tomorrow + pending extraction), audit engagement with mixed sign-offs/PBC/UDIN gate, DSCs, licences, e-sign.
    const nts = (await http().get('/v1/notices?limit=100').set(P).expect(200)).body.items as Array<{ authority: string; status: string; taskId: string | null }>;
    expect(nts).toHaveLength(6);
    expect(new Set(nts.map((n) => n.authority))).toEqual(new Set(['income_tax', 'gst', 'tds', 'roc']));
    expect(new Set(nts.map((n) => n.status))).toEqual(new Set(['drafting', 'received', 'submitted', 'closed', 'hearing']));
    expect((await http().get('/v1/notices/reports/ageing?asOf=2026-10-15').set(P).expect(200)).body).toMatchObject({ open: 4, overdue: 1 });
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM notice_hearing WHERE starts_at::date = '2026-10-16'`))[0]!.n).toBe(1);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM notice_extraction WHERE status = 'pending'`))[0]!.n).toBe(1);
    const engs = (await http().get('/v1/audit/engagements').set(P).expect(200)).body.items as Array<{ id: string; udinRecorded: boolean; taskId: string }>;
    expect(engs.map((e) => e.udinRecorded).sort()).toEqual([false, true]);
    const pending = engs.find((e) => !e.udinRecorded)!;
    const eng = (await http().get(`/v1/audit/engagements/${pending.id}`).set(M).expect(200)).body;
    expect(eng.progress).toEqual({ total: 8, prepared: 6, reviewed: 4, partner: 2 });
    expect(new Set(eng.pbc.map((x: { status: string }) => x.status))).toEqual(new Set(['accepted', 'received', 'requested']));
    expect((await http().post(`/v1/tasks/${pending.taskId}/close`).set(P).send({ outcome: 'billed' }).expect(400)).body.code).toBe('udin_required');
    expect((await http().get('/v1/audit/udins').set(P).expect(200)).body).toHaveLength(1);
    const dscs = (await http().get('/v1/dsc').set(P).expect(200)).body as Array<{ validTo: string; clientId: string | null }>;
    expect(dscs.map((d) => d.validTo)).toEqual(['2026-10-10', '2026-10-22', '2026-11-14', '2026-12-14', '2027-11-19']);
    expect((await http().post('/v1/practice/run').set(P).send({ asOf: '2026-10-15' }).expect(201)).body.expiryAlerts).toBeGreaterThanOrEqual(4);
    expect((await http().get('/v1/licences').set(P).expect(200)).body).toHaveLength(6);
    const es = (await http().get('/v1/esign/requests').set(P).expect(200)).body.items as Array<{ status: string; bulk: boolean }>;
    expect(es.map((r) => `${r.status}:${r.bulk}`).sort()).toEqual(['completed:false', 'in_progress:true']);
    // Phase 9: white-label portal, two portal users (group director: 2 companies; restricted accounts contact), leads in every stage, proposals.
    app.get(Clock).set(new Date('2026-10-15T12:00:00+05:30'));
    const { PORTAL_DEMO } = await import('../src/db/seed-portal.js');
    const hub = app.get(MockChannelHub);
    const portal = async (email: string) => {
      await http().post('/v1/portal/auth/otp/request').send({ firm: 'demo', identifier: email }).expect(202);
      const code = [...hub.outbox].reverse().find((m) => m.to === email)!.text.match(/\b(\d{6})\b/)![1];
      return bearer((await http().post('/v1/portal/auth/otp/verify').send({ firm: 'demo', identifier: email, code, device: web }).expect(200)).body.accessToken);
    };
    expect((await http().get('/v1/portal/branding/demo').expect(200)).body).toMatchObject({ displayName: 'Sharma & Mehta Client Desk', accent: 'teal' });
    const G = await portal(PORTAL_DEMO.group.email); const R = await portal(PORTAL_DEMO.restricted.email);
    const gme = (await http().get('/v1/portal/me').set(G).expect(200)).body.clients as Array<{ id: string }>;
    expect(gme).toHaveLength(2);
    const rme = (await http().get('/v1/portal/me').set(R).expect(200)).body.clients as Array<{ id: string }>;
    expect(rme).toHaveLength(1);
    await http().get(`/v1/portal/clients/${rme[0]!.id}/invoices`).set(R).expect(404);
    const rdocs = (await http().get(`/v1/portal/clients/${rme[0]!.id}/documents`).set(R).expect(200)).body as Array<{ name: string; fromClient: boolean }>;
    expect(rdocs.some((d) => d.name === 'Computation of income AY 2026-27.pdf')).toBe(true);
    expect(rdocs.some((d) => d.name === 'Internal review notes.pdf')).toBe(false);
    expect(rdocs.some((d) => d.fromClient)).toBe(true);
    expect((await http().get(`/v1/portal/clients/${rme[0]!.id}/requests`).set(R).expect(200)).body.some((x: { kind: string }) => x.kind === 'pbc')).toBe(true);
    const dash = await Promise.all(gme.map(async (c) => (await http().get(`/v1/portal/clients/${c.id}/dashboard`).set(G).expect(200)).body));
    expect(dash.some((d) => d.outstanding.invoices.length > 0 && d.recentDocuments.length > 0)).toBe(true);
    expect(dash.reduce((n, d) => n + d.pendingSignatures, 0)).toBeGreaterThanOrEqual(1);
    const payable = dash.find((d) => d.outstanding.invoices.length)!;
    const inv0 = (await http().get(`/v1/portal/clients/${payable.client.id}/invoices/${payable.outstanding.invoices[0].id}`).set(G).expect(200)).body;
    expect(inv0).toMatchObject({ payable: true, paymentUrl: 'https://pay.example.invalid/plink_demo_portal' });
    expect((await http().get(`/v1/portal/clients/${payable.client.id}/messages`).set(G).expect(200)).body).toHaveLength(2);
    const board = (await http().get('/v1/leads/board').set(P).expect(200)).body as Array<{ stage: string; count: number }>;
    expect(board.every((c) => c.count > 0)).toBe(true);
    const props = (await http().get('/v1/proposals').set(P).expect(200)).body as Array<{ status: string; currentVersion: number; convertedAt: string | null }>;
    expect(props.map((x) => x.status).sort()).toEqual(['accepted', 'declined', 'draft', 'sent']);
    expect(props.find((x) => x.status === 'sent')!.currentVersion).toBe(2);
    expect(props.find((x) => x.status === 'accepted')!.convertedAt).toBeTruthy();
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM client_service cs JOIN client c ON c.id = cs.client_id WHERE c.file_no = 'F-151' AND cs.billing_frequency = 'monthly'`))[0]!.n).toBe(2);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM document d JOIN client c ON c.id = d.client_id WHERE c.file_no = 'F-151' AND d.category = 'Engagement letters'`))[0]!.n).toBe(1);
    app.get(Clock).set(new Date('2026-10-15T12:00:00+05:30')); // slots depend on "now"
    try { expect((await http().get('/v1/book/demo/consult?from=2026-10-16&to=2026-10-22').expect(200)).body.slots.length).toBeGreaterThan(10); } finally { app.get(Clock).set(null); }
  });
});

describe('Phase 1 review regressions', () => {
  const sql = async <T = Record<string, unknown>>(q: string, p: unknown[] = []) => {
    const c = new pg.Client({ connectionString: db.url }); await c.connect();
    try { return (await c.query(q, p)).rows as T[]; } finally { await c.end(); }
  };

  it('idempotency_key is tenant-isolated under RLS', async () => {
    const a = await signup('idema'); const b = await signup('idemb');
    await sql(`INSERT INTO idempotency_key (tenant_id, key, response) VALUES ($1, 'k1', '{"secret":1}')`, [a.tenantId]);
    const c = new pg.Client({ connectionString: db.url }); await c.connect();
    await c.query('BEGIN'); await c.query('SET LOCAL ROLE worko_app');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [b.tenantId]);
    expect((await c.query('SELECT * FROM idempotency_key')).rows).toEqual([]);
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [a.tenantId]);
    expect((await c.query('SELECT * FROM idempotency_key')).rows).toHaveLength(1);
    await c.query('ROLLBACK'); await c.end();
  });

  it('wrong TOTP codes lock the account; a used code cannot be replayed', async () => {
    const s = await signup('mfalock');
    const secret = base32Decode((await http().post('/v1/auth/totp/setup').set(bearer(s.accessToken)).expect(201)).body.secret);
    await http().post('/v1/auth/totp/enable').set(bearer(s.accessToken)).send({ code: totp(secret) }).expect(204);
    const login = (code: string) => http().post('/v1/auth/login').send({ firm: 'mfalock', email: 'partner@mfalock.in', password: PW, totp: code, device: web });
    await login(totp(secret)).expect(401); // same step as enable → replay rejected
    const wrong = totp(secret) === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) await login(wrong).expect(401);
    await login(totp(secret, Date.now() + 30_000)).expect(429); // locked even with a valid future-step code
  });

  it('requesting a new OTP does not grant extra guesses; requests are capped', async () => {
    await signup('otpcap', 'partner@otpcap.in', '+919811111111');
    const req = () => http().post('/v1/auth/otp/request').send({ firm: 'otpcap', phone: '+919811111111' }).expect(202);
    const verify = (code: string) => http().post('/v1/auth/otp/verify').send({ firm: 'otpcap', phone: '+919811111111', code, device: web });
    await req();
    const first = sms.sent.at(-1)!.text.slice(0, 6);
    await req(); // retires the first challenge
    await verify(first).expect(401);
    const before = sms.sent.length;
    for (let i = 0; i < 10; i++) await req();
    expect(sms.sent.length - before).toBeLessThanOrEqual(3); // 5 per hour in total
    const n = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM otp_challenge c JOIN app_user u ON u.id = c.user_id WHERE u.phone = '+919811111111' AND c.consumed_at IS NULL`))[0]!.n;
    expect(n).toBe(1);
  });

  it('branch-scoped admins cannot wipe devices in other branches or of partners, nor add users elsewhere', async () => {
    const s = await signup('branchco');
    const [{ id: branch2 }] = await sql<{ id: string }>(`INSERT INTO branch (id, tenant_id, name) VALUES (gen_random_uuid(), $1, 'Pune') RETURNING id`, [s.tenantId]);
    const grants = JSON.stringify(['view', 'create', 'edit'].map((action) => ({ module: 'users', action, scope: 'branch' })));
    await sql(`INSERT INTO role (id, tenant_id, key, name, grants) VALUES (gen_random_uuid(), $1, 'branch_admin', 'Branch admin', $2)`, [s.tenantId, grants]);
    await http().post('/v1/users').set(bearer(s.accessToken)).send({ name: 'BA', email: 'ba@branchco.in', password: PW, roleKeys: ['branch_admin'], branchId: branch2 }).expect(201);
    await http().post('/v1/users').set(bearer(s.accessToken)).send({ name: 'Art', email: 'art@branchco.in', password: PW, roleKeys: ['article'] }).expect(201);
    const ba = (await http().post('/v1/auth/login').send({ firm: 'branchco', email: 'ba@branchco.in', password: PW, device: web }).expect(200)).body;
    const art = (await http().post('/v1/auth/login').send({ firm: 'branchco', email: 'art@branchco.in', password: PW, device: web }).expect(200)).body;
    await http().post(`/v1/auth/sessions/${s.sessionId}/wipe`).set(bearer(ba.accessToken)).expect(403); // partner, other branch
    await http().post(`/v1/auth/sessions/${art.sessionId}/wipe`).set(bearer(ba.accessToken)).expect(403); // other branch
    const [{ id: hq }] = await sql<{ id: string }>(`SELECT id FROM branch WHERE tenant_id = $1 AND name = 'Head office'`, [s.tenantId]);
    await http().post('/v1/users').set(bearer(ba.accessToken)).send({ name: 'X', email: 'x@branchco.in', password: PW, roleKeys: ['branch_admin'], branchId: hq }).expect(403);
  });

  it('refresh ignores client device ids and stops for disabled users', async () => {
    const s = await signup('refco');
    const [{ device_id }] = await sql<{ device_id: string }>(`SELECT device_id FROM device_session WHERE id = $1`, [s.sessionId]);
    const r = await http().post('/v1/auth/refresh').send({ refreshToken: s.refreshToken, deviceId: 'spoofed' }).expect(200);
    const claims = JSON.parse(Buffer.from(r.body.accessToken.split('.')[1], 'base64url').toString());
    expect(claims.dev).toBe(device_id);
    await sql(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [s.userId]);
    await http().post('/v1/auth/refresh').send({ refreshToken: r.body.refreshToken }).expect(401);
  });
});
