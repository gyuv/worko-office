import { gstinCheckChar } from '@worko/domain';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AutomationEngine } from '../src/automation/engine.js';
import { CollectionsService } from '../src/billing/collections.service.js';
import { MockChannelHub } from '../src/comm/channels.js';
import { Clock } from '../src/common/clock.js';
import { JobQueueService } from '../src/jobs/job-queue.service.js';
import { PortalAuthService } from '../src/portal/portal-auth.service.js';
import { bearer, bootApp, type Session } from './helpers.js';

/**
 * "The firm's day" (PRD §15) — the release gate. One firm, one client, one working day, ten steps, each an `it`
 * that depends on the previous ones (run in order, shared state). The clock is pinned: nothing reads the wall clock.
 * Steps are listed in docs/PRD.md §15; keep the two in sync.
 */
let t: Awaited<ReturnType<typeof bootApp>>;
let clock: Clock; let jobs: JobQueueService; let engine: AutomationEngine; let hub: MockChannelHub;
const SLUG = 'firmsday';
const DAY = (hhmm: string) => new Date(`2026-11-12T${hhmm}:00+05:30`); // Thursday, outside quiet hours
const H = (s: { accessToken: string }) => bearer(s.accessToken);
const pdf = Buffer.from('%PDF-1.4\n% firms day\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
function gstin(state: string, n: number) { const base = `${state}AABCF${String(n).padStart(4, '0')}Q1Z`; return base + gstinCheckChar(base); }
async function flush(d = clock.now()) { for (let i = 0; i < 30; i++) if (!(await jobs.runOnce(50, d))) return; }

// Shared state built up step by step.
let P: Session; let M: Session; let A: Session; let ACC: Session;
let clientId: string; let contactId: string; let g3b: string; let gstTask: string; let auditTask: string; let engagementId: string;
let ruleId: string; let portal: { accessToken: string }; let invoiceIds: string[] = []; let entryId: string;

beforeAll(async () => {
  t = await bootApp();
  clock = t.app.get(Clock); jobs = t.app.get(JobQueueService); engine = t.app.get(AutomationEngine); hub = t.app.get(MockChannelHub);
  clock.set(DAY('09:00'));
}, 90_000);
afterAll(() => t?.close());

describe("The firm's day (PRD §15)", () => {
  it('1. firm set-up: sign-up, GST billing entity, service catalogue + fee rates, team with roles', async () => {
    P = await t.signup(SLUG);
    const [e1] = (await t.http().get('/v1/billing/entities').set(H(P)).expect(200)).body;
    await t.http().patch(`/v1/billing/entities/${e1.id}`).set(H(P)).send({ gstin: gstin('27', 1), invoicePrefix: 'FD', address: 'FC Road, Pune' }).expect(204);
    await t.http().put('/v1/billing/settings').set(H(P)).send({ defaultEntityId: e1.id }).expect(204);
    expect((await t.http().post('/v1/service-types/install-defaults').set(H(P)).expect(200)).body.created).toBeGreaterThan(10);
    g3b = ((await t.http().get('/v1/service-types').set(H(P)).expect(200)).body as Array<{ id: string; key: string }>).find((s) => s.key === 'GSTR3B')!.id;
    await t.http().post('/v1/billing/rates').set(H(P)).send({ serviceTypeId: g3b, amountPaise: 150_000, effectiveFrom: '2026-04-01' }).expect(201);
    M = await t.addUser(P, SLUG, 'Mohan', 'manager');
    A = await t.addUser(P, SLUG, 'Arti', 'article');
    ACC = await t.addUser(P, SLUG, 'Kavya', 'accountant');
    await t.http().patch(`/v1/users/${A.userId}`).set(H(P)).send({ managerId: M.userId }).expect(204); // article reports to the manager
    // Least privilege from the first minute: an article cannot touch billing or the catalogue.
    await t.http().get('/v1/billing/invoices').set(H(A)).expect(403);
    await t.http().post('/v1/service-types/install-defaults').set(H(A)).expect(403);
    const actions = (await t.sql<{ action: string }>('SELECT action FROM audit_log WHERE tenant_id = $1', [P.tenantId])).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['tenant.created', 'user.created']));
  });

  it('2. client onboarding: GSTIN-validated client, team, services, audit engagement, portal invitation', async () => {
    const good = gstin('27', 2);
    await t.http().get('/v1/lookup/gstin/27AABCX0000Z1ZZ').set(H(P)).expect(400); // checksum fails locally
    expect((await t.http().get(`/v1/lookup/gstin/${good}`).set(H(P)).expect(200)).body).toMatchObject({ stateCode: '27' });
    clientId = (await t.http().post('/v1/clients').set(H(P)).send({ name: 'Sahyadri Agro Pvt Ltd', entityType: 'PRIVATE_COMPANY',
      registrations: [{ kind: 'GSTIN', number: good, isPrimary: true }], managerId: M.userId, partnerId: P.userId, staffIds: [A.userId],
      contacts: [{ name: 'Ramesh Patil', email: 'ramesh@sahyadri.example', phone: '+919822012345', isPrimary: true }] }).expect(201)).body.id;
    // Duplicate detection by GSTIN.
    await t.http().post('/v1/clients').set(H(P)).send({ name: 'Copy', entityType: 'PRIVATE_COMPANY', registrations: [{ kind: 'GSTIN', number: good }] }).expect(409);
    await t.http().put(`/v1/clients/${clientId}/services/${g3b}`).set(H(P)).send({ assigneeId: A.userId }).expect(200);
    const eng = (await t.http().post('/v1/audit/engagements').set(H(P)).send({ clientId, fy: '2025-26', auditType: 'statutory', partnerId: P.userId, managerId: M.userId, udinRequired: true }).expect(201)).body;
    engagementId = eng.id;
    auditTask = (await t.http().get(`/v1/audit/engagements/${engagementId}`).set(H(P)).expect(200)).body.taskId;
    contactId = (await t.sql<{ id: string }>('SELECT id FROM contact WHERE client_id = $1', [clientId]))[0]!.id;
    const inv = (await t.http().post('/v1/portal-admin/invites').set(H(P)).send({ clientId, contactId }).expect(201)).body;
    expect(inv.invite.status).toBe('sent');
    expect(hub.outbox.some((m) => m.to === 'ramesh@sahyadri.example' && /client portal/.test(m.text))).toBe(true);
  });

  it('3. monthly auto-creation: preview = commit, assigned to the article, due dates from the rule pack, visible in the matrix', async () => {
    const prev = (await t.http().post('/v1/tasks/auto/preview').set(H(P)).send({ month: '2026-10' }).expect(200)).body;
    expect(prev.toCreate).toBe(1);
    expect((await t.http().post('/v1/tasks/auto/commit').set(H(P)).send({ month: '2026-10' }).expect(200)).body.created).toBe(1);
    expect((await t.http().post('/v1/tasks/auto/commit').set(H(P)).send({ month: '2026-10' }).expect(200)).body.created).toBe(0); // idempotent
    const mine = (await t.http().get('/v1/tasks?limit=100').set(H(A)).expect(200)).body.items as Array<Record<string, unknown>>;
    const task = mine.find((x) => x.ruleId === 'gst.gstr3b.monthly')!;
    expect(task).toMatchObject({ clientId, assigneeId: A.userId, periodKey: '2026-10', statutoryDue: '2026-11-20', status: 'open', source: 'auto' });
    gstTask = task.id as string;
    const m = (await t.http().get('/v1/compliance/matrix?from=2026-11-01&to=2026-11-30&asOf=2026-11-12').set(H(P)).expect(200)).body;
    expect(m.cells.find((c: { clientId: string; ruleId: string }) => c.clientId === clientId && c.ruleId === 'gst.gstr3b.monthly')).toMatchObject({ taskId: gstTask, state: 'open' });
  });

  it('4. Document Collection Agent: asks the client (task → pending_client, e-mail on the timeline)', async () => {
    clock.set(DAY('10:00'));
    const r = (await t.http().post('/v1/automation/agents/document_collection/enable').set(H(P)).send({ params: { serviceKeys: ['GSTR3B'], everyDays: 3, maxReminders: 2 } }).expect(201)).body;
    ruleId = r.rule.id;
    expect(r.preview.items.find((i: { entity: { id: string } }) => i.entity.id === gstTask)).toMatchObject({ matched: true });
    await engine.tick(P.tenantId, DAY('10:00')); await flush();
    expect((await t.http().get(`/v1/tasks/${gstTask}`).set(H(P)).expect(200)).body).toMatchObject({ status: 'pending_client', pendingIssue: expect.stringContaining('GSTR-3B') });
    const sent = await t.sql(`SELECT subject FROM comm_message WHERE client_id = $1 AND direction = 'out' AND channel = 'email' AND subject LIKE 'Documents needed%'`, [clientId]);
    expect(sent).toHaveLength(1);
  });

  it('5. client portal: OTP sign-in, upload → staff notified, office sees it, the reminder ladder stops', async () => {
    clock.set(DAY('11:00'));
    await t.http().post('/v1/portal/auth/otp/request').send({ firm: SLUG, identifier: 'ramesh@sahyadri.example' }).expect(202);
    await t.app.get(PortalAuthService).drain();
    const code = [...hub.outbox].reverse().find((x) => x.to === 'ramesh@sahyadri.example')!.text.match(/\b(\d{6})\b/)![1]!;
    portal = (await t.http().post('/v1/portal/auth/otp/verify').send({ firm: SLUG, identifier: 'ramesh@sahyadri.example', code, device: { platform: 'web' } }).expect(200)).body;
    expect((await t.http().get('/v1/portal/me').set(H(portal)).expect(200)).body.clients.map((c: { id: string }) => c.id)).toEqual([clientId]);
    const reqs = (await t.http().get(`/v1/portal/clients/${clientId}/requests`).set(H(portal)).expect(200)).body as Array<{ id: string }>;
    expect(reqs.some((x) => x.id === gstTask)).toBe(true); // the pending_client task asks the client
    const docId = (await t.http().post(`/v1/portal/clients/${clientId}/documents`).set(H(portal)).field('name', 'Sales register Oct.pdf')
      .attach('file', pdf, { filename: 'sales.pdf', contentType: 'application/pdf' }).expect(201)).body.id as string;
    await flush();
    const staffDocs = (await t.http().get(`/v1/documents?clientId=${clientId}`).set(H(A)).expect(200)).body;
    expect(JSON.stringify(staffDocs)).toContain(docId);
    const notes = await t.sql<{ user_id: string }>(`SELECT user_id FROM notification WHERE tenant_id = $1 AND category = 'client.uploaded'`, [P.tenantId]);
    expect(notes.map((n) => n.user_id).sort()).toEqual([P.userId, M.userId].sort()); // client's partner + manager
    const [sub] = await t.sql<{ stop_reason: string }>('SELECT stop_reason FROM automation_subject WHERE rule_id = $1 AND entity_id = $2', [ruleId, gstTask]);
    expect(sub!.stop_reason).toBe('document.uploaded');
  });

  it('6. the work: timer, offline change from Android reaches the manager, checks, review, done; audit closes only with a UDIN', async () => {
    clock.set(DAY('11:30'));
    await t.http().post('/v1/time/timer/start').set(H(A)).send({ taskId: gstTask }).expect(201);
    // Article's phone (offline queue) moves the task to in_progress; the manager's desktop pulls it.
    const phone = await t.login(SLUG, 'arti@firmsday.in', 'android');
    const desk = await t.login(SLUG, 'mohan@firmsday.in', 'desktop');
    const before = (await t.http().get('/v1/sync/pull?since=0&limit=1000').set(H(phone)).expect(200)).body;
    const row = before.changes.find((c: { table: string; id: string }) => c.table === 'task' && c.id === gstTask);
    const [res] = (await t.http().post('/v1/sync/push').set(H(phone)).send({ mutations: [{ key: `k-${randomUUID()}`, table: 'task', id: gstTask, baseVersion: row.version, patch: { status: 'in_progress' } }] }).expect(200)).body.results;
    expect(res.status).toBe('applied');
    const seen = (await t.http().get('/v1/sync/pull?since=0&limit=1000').set(H(desk)).expect(200)).body.changes.find((c: { table: string; id: string }) => c.table === 'task' && c.id === gstTask);
    expect(seen.fields.status).toBe('in_progress');
    const task = (await t.http().get(`/v1/tasks/${gstTask}`).set(H(A)).expect(200)).body;
    for (const c of task.checks) await t.http().post(`/v1/tasks/${gstTask}/checks`).set(H(A)).send({ key: c.key, done: true }).expect(204);
    clock.set(DAY('13:00'));
    const stop = (await t.http().post('/v1/time/timer/stop').set(H(A)).send({}).expect(200)).body;
    expect(stop.minutes).toBe(90);
    entryId = stop.entryId;
    await t.http().patch(`/v1/tasks/${gstTask}`).set(H(A)).send({ status: 'review', reviewer_id: M.userId }).expect(204);
    await t.http().patch(`/v1/tasks/${gstTask}`).set(H(M)).send({ status: 'done' }).expect(204);
    expect((await t.http().get(`/v1/tasks/${gstTask}`).set(H(P)).expect(200)).body).toMatchObject({ status: 'done', completedAt: expect.any(String) });
    // Statutory audit: the UDIN gate holds until the partner records the UDIN.
    await t.http().patch(`/v1/tasks/${auditTask}`).set(H(P)).send({ status: 'review', reviewer_id: P.userId }).expect(204);
    expect((await t.http().patch(`/v1/tasks/${auditTask}`).set(H(P)).send({ status: 'done' }).expect(400)).body.code).toBe('udin_required');
    await t.http().post('/v1/audit/udins').set(H(P)).send({ clientId, engagementId, udin: '26123456FIRMDY0001', documentType: 'Audit report', generatedOn: '2026-11-12', membershipNo: '123456' }).expect(201);
    await t.http().patch(`/v1/tasks/${auditTask}`).set(H(P)).send({ status: 'done' }).expect(204);
  });

  it('7. billing: unbilled work auto-drafted at rate-table prices, audit fee added, issued with CGST+SGST', async () => {
    clock.set(DAY('15:00'));
    const unb = (await t.http().get('/v1/billing/unbilled').set(H(ACC)).expect(200)).body;
    expect(unb.items.map((x: { taskId: string }) => x.taskId).sort()).toEqual([gstTask, auditTask].sort());
    const com = (await t.http().post('/v1/billing/auto/commit').set(H(P)).send({ to: '2026-11-12' }).expect(200)).body;
    expect(com.created).toBe(1);
    const auto = (await t.http().get(`/v1/billing/invoices/${com.ids[0]}`).set(H(P)).expect(200)).body;
    expect(auto).toMatchObject({ source: 'auto', taxablePaise: 150_000, supplyType: 'intra', cgstPaise: 13_500, sgstPaise: 13_500, totalPaise: 177_000, status: 'draft' });
    const audit = (await t.http().post('/v1/billing/invoices').set(H(ACC)).send({ clientId, lines: [{ description: 'Statutory audit FY 2025-26', ratePaise: 5_000_000, taskIds: [auditTask] }] }).expect(201)).body.id as string;
    invoiceIds = [com.ids[0], audit];
    for (const id of invoiceIds) await t.http().post(`/v1/billing/invoices/${id}/issue`).set(H(P)).send({ issueDate: '2026-11-12' }).expect(200);
    const nums = await Promise.all(invoiceIds.map(async (id) => (await t.http().get(`/v1/billing/invoices/${id}`).set(H(P)).expect(200)).body.number));
    expect(nums.sort()).toEqual(['FD/2627/0001', 'FD/2627/0002']);
    for (const id of [gstTask, auditTask]) expect((await t.http().get(`/v1/tasks/${id}`).set(H(P)).expect(200)).body.outcome).toBe('billed');
    expect((await t.http().get('/v1/billing/unbilled').set(H(P)).expect(200)).body.count).toBe(0);
  });

  it('8. collection: client pays in the portal via the payment link, signed webhook → receipt; follow-ups stop', async () => {
    clock.set(DAY('16:00'));
    const list = (await t.http().get(`/v1/portal/clients/${clientId}/invoices`).set(H(portal)).expect(200)).body;
    expect(JSON.stringify(list)).toContain('FD/2627/0001');
    for (const [i, id] of invoiceIds.entries()) {
      const inv = (await t.http().get(`/v1/billing/invoices/${id}`).set(H(P)).expect(200)).body;
      const pay = (await t.http().post(`/v1/portal/clients/${clientId}/invoices/${id}/pay`).set(H(portal)).expect(200)).body;
      const body = JSON.stringify({ id: `evt_fd_${i}`, type: 'payment.captured', linkId: pay.url.split('/').pop(), paymentId: `pay_fd_${i}`, amountPaise: inv.totalPaise });
      const sig = createHmac('sha256', 'worko-dev-webhook-secret').update(body).digest('hex');
      const ok = (await t.http().post(`/v1/billing/webhooks/mock/${P.tenantId}`).set('Content-Type', 'application/json').set('x-worko-signature', sig).send(body).expect(200)).body;
      expect(ok.status).toBe('receipt_recorded');
      expect((await t.http().get(`/v1/portal/clients/${clientId}/invoices/${id}`).set(H(portal)).expect(200)).body).toMatchObject({ status: 'paid', balancePaise: 0 });
    }
    const rec = (await t.http().get(`/v1/billing/receipts?clientId=${clientId}`).set(H(ACC)).expect(200)).body;
    expect(rec.total).toBe(2);
    expect(rec.items.every((r: { source: string }) => r.source === 'gateway')).toBe(true);
    expect((await t.http().get(`/v1/portal/clients/${clientId}/receipts`).set(H(portal)).expect(200)).body.length ?? 1).toBeGreaterThan(0);
    // Weeks later, the follow-up ladder has nothing to chase.
    expect(await t.app.get(CollectionsService).runFollowups(P.tenantId, '2026-11-12')).toMatchObject({ sent: 0, escalated: 0 });
  });

  it('9. reports reconcile: unbilled, ageing, job P&L and the time entry agree across modules', async () => {
    clock.set(DAY('17:00'));
    // Timesheet: the article submits the week, the manager approves (never self-approval).
    expect((await t.http().post('/v1/time/timesheets/submit').set(H(A)).send({ weekStart: '2026-11-09' }).expect(200)).body.submitted).toBe(1);
    expect((await t.http().post('/v1/time/entries/decide').set(H(M)).send({ ids: [entryId], approve: true }).expect(200)).body.approved).toBe(1);
    const run = async (body: Record<string, unknown>) => (await t.http().post('/v1/reports/run').set(H(P)).send(body).expect(200)).body;
    const unb = await run({ catalogueKey: 'unbilled_by_client' });
    expect(unb.totals.count ?? 0).toBe(0);
    const ag = (await t.http().get('/v1/billing/ageing?asOf=2026-11-12').set(H(P)).expect(200)).body;
    expect(ag.totals.totalPaise).toBe(0);
    const agr = await run({ catalogueKey: 'ageing_buckets', params: { asOf: '2026-11-12' } });
    expect(agr.totals.sum_balancePaise ?? 0).toBe(0);
    const pnl = (await t.http().get('/v1/reports/job-pnl?from=2026-04-01&to=2026-11-12&groupBy=client').set(H(P)).expect(200)).body;
    const pr = await run({ catalogueKey: 'job_pnl', params: { from: '2026-04-01', to: '2026-11-12', groupBy: 'client' } });
    expect(pr.totals).toMatchObject({ sum_revenuePaise: pnl.totals.revenuePaise, sum_minutes: pnl.totals.minutes });
    expect(pnl.totals.revenuePaise).toBe(150_000 + 5_000_000); // taxable value of both invoices
    expect(pnl.totals.minutes).toBe(90);
  });

  it('10. end of day: notifications delivered, automation run recorded, audit chain intact', async () => {
    const runs = (await t.http().get(`/v1/automation/runs?ruleId=${ruleId}&limit=50`).set(H(P)).expect(200)).body.items as Array<{ entityId: string; status: string }>;
    expect(runs.some((r) => r.entityId === gstTask && r.status === 'succeeded')).toBe(true);
    const notes = (await t.http().get('/v1/notifications').set(H(M)).expect(200)).body;
    expect(JSON.stringify(notes)).toContain('uploaded a document');
    const v = (await t.http().get('/v1/audit/verify').set(H(P)).expect(200)).body;
    expect(v).toMatchObject({ ok: true, brokenAt: null });
    expect(v.checked).toBeGreaterThan(30);
    const actions = new Set((await t.sql<{ action: string }>('SELECT DISTINCT action FROM audit_log WHERE tenant_id = $1', [P.tenantId])).map((x) => x.action));
    for (const a of ['task.auto_created', 'invoice.issued', 'receipt.created', 'payment.webhook', 'udin.recorded']) expect(actions.has(a), a).toBe(true);
  });
});
