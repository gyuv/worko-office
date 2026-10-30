import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Clock } from '../src/common/clock.js';
import { bearer, bootApp, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
let clock: Clock;
const at = (iso: string) => clock.set(new Date(iso));
beforeAll(async () => { t = await bootApp(); clock = t.app.get(Clock); at('2026-10-14T10:00:00+05:30'); }, 60_000);
afterAll(() => t?.close());

const H = (s: Session) => bearer(s.accessToken);
type Firm = { p: Session; m: Session; ar: Session; sr: Session; acc: Session; cA: string; cB: string; tA: string; tB: string; g3b: string };

/** Partner, manager, article (reports to manager), senior, accountant; client A (article staff, manager is client manager), client B (partner only). */
async function firm(slug: string): Promise<Firm> {
  const p = await t.signup(slug);
  const m = await t.addUser(p, slug, 'Manager', 'manager');
  const ar = await t.addUser(p, slug, 'Article', 'article');
  const sr = await t.addUser(p, slug, 'Senior', 'senior');
  const acc = await t.addUser(p, slug, 'Accounts', 'accountant');
  await t.http().patch(`/v1/users/${ar.userId}`).set(H(p)).send({ managerId: m.userId }).expect(204);
  await t.http().post('/v1/service-types/install-defaults').set(H(p)).expect(200);
  const st = (await t.http().get('/v1/service-types').set(H(p)).expect(200)).body as Array<{ id: string; key: string }>;
  const g3b = st.find((s) => s.key === 'GSTR3B')!.id;
  await t.http().post('/v1/billing/rates').set(H(p)).send({ serviceTypeId: g3b, amountPaise: 150_000, effectiveFrom: '2026-04-01' }).expect(201);
  const cA = (await t.http().post('/v1/clients').set(H(p)).send({ name: 'Alpha Traders', entityType: 'PROPRIETORSHIP', staffIds: [ar.userId], managerId: m.userId }).expect(201)).body.id;
  const cB = (await t.http().post('/v1/clients').set(H(p)).send({ name: 'Beta Secret Pvt Ltd', entityType: 'PRIVATE_COMPANY' }).expect(201)).body.id;
  const tA = (await t.http().post('/v1/tasks').set(H(p)).send({ client_id: cA, service_type_id: g3b, period_key: '2026-09', title: 'GSTR-3B Sep', assignee_id: ar.userId, act_by: '2026-10-16', estimate_minutes: 300, checks: [] }).expect(201)).body.id;
  const tB = (await t.http().post('/v1/tasks').set(H(p)).send({ client_id: cB, service_type_id: g3b, period_key: '2026-08', title: 'GSTR-3B Aug', checks: [] }).expect(201)).body.id;
  return { p, m, ar, sr, acc, cA, cB, tA, tB, g3b };
}
const entry = async (s: Session, b: Record<string, unknown>) => (await t.http().post('/v1/time/entries').set(H(s)).send(b).expect(201)).body.id as string;
const approve = (s: Session, ids: string[], approve = true) => t.http().post('/v1/time/entries/decide').set(H(s)).send({ ids, approve }).expect(200).then((r) => r.body);

describe('timer', () => {
  it('one running timer per user; minutes from server time; capped at the firm cap; live activity hides invisible work', async () => {
    const f = await firm('tm1');
    at('2026-10-14T10:00:00+05:30');
    await t.http().post('/v1/time/timer/start').set(H(f.ar)).send({ taskId: f.tA, deviceAt: '2026-10-14T04:29:00Z' }).expect(201);
    await t.http().post('/v1/time/timer/start').set(H(f.ar)).send({}).expect(409);
    expect((await t.http().get('/v1/time/timer').set(H(f.ar)).expect(200)).body).toMatchObject({ taskId: f.tA, clientId: f.cA });
    // The partner sees the task; the senior (no view on the client/task) sees "Busy".
    await t.http().post('/v1/time/timer/start').set(H(f.p)).send({ taskId: f.tB }).expect(201);
    at('2026-10-14T10:30:00+05:30');
    const lp = (await t.http().get('/v1/activity/live').set(H(f.p)).expect(200)).body.items;
    expect(lp.find((x: { userId: string }) => x.userId === f.ar.userId)).toMatchObject({ label: 'GSTR-3B Sep', minutes: 30 });
    const ls = (await t.http().get('/v1/activity/live').set(H(f.sr)).expect(200)).body.items;
    expect(ls).toHaveLength(2);
    expect(ls.every((x: { label: string; client: unknown; task: unknown }) => x.label === 'Busy' && !x.client && !x.task)).toBe(true);
    const lm = (await t.http().get('/v1/activity/live').set(H(f.m)).expect(200)).body.items;
    expect(lm.find((x: { userId: string }) => x.userId === f.p.userId).label).toBe('Busy'); // client B invisible to the manager
    at('2026-10-14T11:30:29+05:30');
    const s1 = (await t.http().post('/v1/time/timer/stop').set(H(f.ar)).send({}).expect(200)).body;
    expect(s1).toMatchObject({ minutes: 90, capped: false });
    await t.http().post('/v1/time/timer/stop').set(H(f.ar)).send({}).expect(404);
    const e1 = (await t.http().get(`/v1/time/entries/${s1.entryId}`).set(H(f.ar)).expect(200)).body;
    expect(e1).toMatchObject({ source: 'timer', status: 'draft', minutes: 90, workDate: '2026-10-14', clientId: f.cA, taskTitle: 'GSTR-3B Sep' });
    // A forgotten timer is capped (12 h default) and flagged.
    await t.http().post('/v1/time/timer/start').set(H(f.ar)).send({ clientId: f.cA }).expect(201);
    at('2026-10-15T06:00:00+05:30');
    expect((await t.http().post('/v1/time/timer/stop').set(H(f.ar)).send({}).expect(200)).body).toMatchObject({ minutes: 720, capped: true });
    await t.http().post('/v1/time/timer/start').set(H(f.ar)).send({ clientId: f.cB }).expect(400); // invisible client
    // Review fix: a stop never pushes the day over 24 h — clamped and flagged; a full day stops without an entry (no 500).
    at('2026-10-14T20:00:00+05:30');
    await entry(f.ar, { clientId: f.cA, workDate: '2026-10-14', minutes: 600 }); // 90 + 720 + 600 = 1410
    await t.http().post('/v1/time/timer/start').set(H(f.ar)).send({ clientId: f.cA }).expect(201);
    at('2026-10-14T21:00:00+05:30');
    expect((await t.http().post('/v1/time/timer/stop').set(H(f.ar)).send({}).expect(200)).body).toMatchObject({ minutes: 30, capped: true, dayFull: false });
    await t.http().post('/v1/time/timer/start').set(H(f.ar)).send({ clientId: f.cA }).expect(201);
    at('2026-10-14T21:30:00+05:30');
    expect((await t.http().post('/v1/time/timer/stop').set(H(f.ar)).send({}).expect(200)).body).toMatchObject({ entryId: null, dayFull: true });
    expect((await t.http().get('/v1/time/timer').set(H(f.ar)).expect(200)).body?.id).toBeUndefined();
    const audit = await t.sql<{ action: string }>(`SELECT action FROM audit_log WHERE tenant_id = $1 AND action LIKE 'timer.%'`, [f.p.tenantId]);
    expect(audit.length).toBe(9);
    at('2026-10-14T10:00:00+05:30');
  });
});

describe('approval', () => {
  it('weekly submit, approver = manager or time:approve, never self; approved is immutable; reversal once', async () => {
    const f = await firm('tm2');
    const e = await entry(f.ar, { taskId: f.tA, workDate: '2026-10-13', minutes: 120 });
    await entry(f.ar, { clientId: f.cA, workDate: '2026-10-12', minutes: 60, billable: false });
    await t.http().post('/v1/time/entries').set(H(f.ar)).send({ clientId: f.cA, workDate: '2026-10-20', minutes: 60 }).expect(400); // future
    await t.http().post('/v1/time/entries').set(H(f.ar)).send({ clientId: f.cB, workDate: '2026-10-12', minutes: 60 }).expect(400); // invisible client
    await t.http().post('/v1/time/entries').set(H(f.ar)).send({ workDate: '2026-10-12', minutes: 1400 }).expect(400); // > 24 h in the day
    expect((await t.http().post('/v1/time/timesheets/submit').set(H(f.ar)).send({ weekStart: '2026-10-14' }).expect(200)).body).toMatchObject({ weekStart: '2026-10-12', submitted: 2 });
    // Submitted entries can't be edited (only withdrawn).
    await t.http().patch(`/v1/time/entries/${e}`).set(H(f.ar)).send({ minutes: 100 }).expect(400);
    // Senior: neither manager nor approver → skipped as not found (out of scope).
    expect((await approve(f.sr, [e])).results[0]).toMatchObject({ status: 'skipped' });
    const r = await approve(f.m, [e]);
    expect(r.approved).toBe(1);
    await t.http().patch(`/v1/time/entries/${e}`).set(H(f.ar)).send({ notes: 'edit' }).expect(409);
    await t.http().delete(`/v1/time/entries/${e}`).set(H(f.ar)).expect(409);
    await expect(t.sql('UPDATE time_entry SET minutes = 5 WHERE id = $1', [e])).rejects.toThrow(/immutable/);
    // Self approval refused even for a partner.
    const pe = await entry(f.p, { workDate: '2026-10-13', minutes: 30, submit: true });
    expect((await approve(f.p, [pe])).results[0]).toMatchObject({ status: 'skipped', reason: 'self_approval' });
    await t.http().post(`/v1/time/entries/${pe}/reverse`).set(H(f.p)).send({ note: 'x' }).expect(400);
    // Reversal by the manager, once.
    const rev = (await t.http().post(`/v1/time/entries/${e}/reverse`).set(H(f.m)).send({ note: 'wrong task' }).expect(201)).body.id;
    await t.http().post(`/v1/time/entries/${e}/reverse`).set(H(f.m)).send({ note: 'again' }).expect(409);
    expect((await t.http().get(`/v1/time/entries/${rev}`).set(H(f.ar)).expect(200)).body).toMatchObject({ minutes: -120, status: 'approved', source: 'reversal', reversesId: e });
    const mine = (await t.http().get('/v1/time/entries?status=approved').set(H(f.ar)).expect(200)).body;
    expect(mine.totalMinutes).toBe(0);
    // Visibility: the article can't see the partner's entry; the manager can't see the partner's firm entry either.
    await t.http().get(`/v1/time/entries/${pe}`).set(H(f.ar)).expect(404);
    await t.http().get(`/v1/time/entries/${pe}`).set(H(f.m)).expect(404);
    expect((await t.http().get(`/v1/time/entries?userId=${f.ar.userId}`).set(H(f.m)).expect(200)).body.total).toBe(3);
    // Rejected → owner edits and resubmits.
    const e3 = await entry(f.ar, { taskId: f.tA, workDate: '2026-10-14', minutes: 45, submit: true });
    expect((await approve(f.m, [e3], false)).rejected).toBe(1);
    await t.http().patch(`/v1/time/entries/${e3}`).set(H(f.ar)).send({ minutes: 50, status: 'submitted' }).expect(204);
    const acts = (await t.sql<{ action: string }>(`SELECT action FROM audit_log WHERE tenant_id = $1 AND entity = 'time_entry'`, [f.p.tenantId])).map((x) => x.action);
    expect(acts).toEqual(expect.arrayContaining(['time_entry.created', 'timesheet.submitted', 'time_entry.approved', 'time_entry.reversed', 'time_entry.rejected', 'time_entry.updated']));
  });
});

describe('job P&L and capacity', () => {
  it('revenue net of credit notes, cost at the rate on the entry date, WIP, loss flag; totals reconcile; cost hidden from non-authorised roles', async () => {
    const f = await firm('tm3');
    // Cost rates (sensitive): partner only; changes on 13 Oct.
    await t.http().post('/v1/hr/cost-rates').set(H(f.p)).send({ userId: f.ar.userId, hourlyPaise: 60_000, effectiveFrom: '2026-04-01' }).expect(201);
    await t.http().post('/v1/hr/cost-rates').set(H(f.p)).send({ userId: f.ar.userId, hourlyPaise: 90_000, effectiveFrom: '2026-10-13' }).expect(201);
    await t.http().post('/v1/hr/cost-rates').set(H(f.p)).send({ userId: f.m.userId, hourlyPaise: 120_000, effectiveFrom: '2026-04-01' }).expect(201);
    await t.http().get('/v1/hr/cost-rates').set(H(f.m)).expect(403);
    await t.http().post('/v1/hr/cost-rates').set(H(f.acc)).send({ userId: f.ar.userId, hourlyPaise: 1, effectiveFrom: '2026-05-01' }).expect(403);
    expect((await t.http().get(`/v1/hr/cost-rates?userId=${f.ar.userId}`).set(H(f.p)).expect(200)).body.map((r: { effectiveTo: string | null }) => r.effectiveTo)).toEqual([null, '2026-10-12']);
    // Approved time: article 60 min on 12 Oct (₹600/h) + 120 min on 13 Oct (₹900/h) on task A; manager 600 min on task B.
    const ids = [await entry(f.ar, { taskId: f.tA, workDate: '2026-10-12', minutes: 60, submit: true }), await entry(f.ar, { taskId: f.tA, workDate: '2026-10-13', minutes: 120, submit: true })];
    await entry(f.ar, { taskId: f.tA, workDate: '2026-10-13', minutes: 30, submit: true }); // submitted, not approved: no cost
    expect((await approve(f.m, ids)).approved).toBe(2);
    const mb = await entry(f.p, { taskId: f.tB, workDate: '2026-10-13', minutes: 600, submit: true }); // partner's own time, approved by the manager? not visible → admin
    expect((await approve(f.m, [mb])).approved).toBe(0);
    const adm = await t.addUser(f.p, 'tm3', 'Admin', 'admin');
    await t.http().post('/v1/time/entries/decide').set(H(adm)).send({ ids: [mb], approve: true }).expect(403); // admin holds no time grants
    await t.http().post('/v1/hr/cost-rates').set(H(f.p)).send({ userId: f.p.userId, hourlyPaise: 100_000, effectiveFrom: '2026-04-01' }).expect(201);
    await t.sql(`UPDATE time_entry SET status = 'approved', decided_by = $2 WHERE id = $1`, [mb, f.m.userId]);
    // Task A done and billed: line 3,000 for task A + 1,000 untasked; issued 10 Oct; credit note 400 taxable.
    await t.http().patch(`/v1/tasks/${f.tA}`).set(H(f.p)).send({ status: 'done' }).expect(204);
    const inv = (await t.http().post('/v1/billing/invoices').set(H(f.p)).send({ clientId: f.cA, lines: [{ description: 'GST', ratePaise: 300_000, taskIds: [f.tA] }, { description: 'Advice', ratePaise: 100_000 }] }).expect(201)).body.id;
    await t.http().post(`/v1/billing/invoices/${inv}/issue`).set(H(f.p)).send({ issueDate: '2026-10-10' }).expect(200);
    await t.http().post(`/v1/billing/invoices/${inv}/notes`).set(H(f.p)).send({ kind: 'credit_note', date: '2026-10-11', reason: 'Discount', lines: [{ description: 'Discount', taxablePaise: 40_000 }] }).expect(201);
    const q = '/v1/reports/job-pnl?from=2026-10-01&to=2026-10-31&groupBy=task';
    const r = (await t.http().get(q).set(H(f.p)).expect(200)).body;
    const a = r.items.find((x: { taskId: string }) => x.taskId === f.tA);
    const b = r.items.find((x: { taskId: string }) => x.taskId === f.tB);
    expect(a).toMatchObject({ revenuePaise: 270_000, costPaise: 60_000 + 180_000, marginPaise: 30_000, loss: false, wipPaise: 0, minutes: 180 });
    expect(b).toMatchObject({ revenuePaise: 0, costPaise: 1_000_000, loss: true, wipPaise: 150_000 });
    // Reconcile: revenue = task-linked taxable − credit allocated to it; cost = Σ approved minutes × rate.
    const [line] = await t.sql<{ taxable_paise: string }>(`SELECT l.taxable_paise FROM invoice_line l JOIN invoice_task it ON it.line_id = l.id WHERE it.task_id = $1`, [f.tA]);
    expect(r.totals.revenuePaise).toBe(Number(line!.taxable_paise) - r.creditNotesPaise);
    expect(r.creditNotesPaise).toBe(30_000);
    expect(r.totals.costPaise).toBe(r.items.reduce((s: number, x: { costPaise: number }) => s + x.costPaise, 0));
    expect(r.totals.costPaise).toBe(1_240_000);
    expect(r.lossMaking).toBe(1);
    const byClient = (await t.http().get('/v1/reports/job-pnl?from=2026-10-01&to=2026-10-31&groupBy=client').set(H(f.p)).expect(200)).body;
    expect(byClient.totals.revenuePaise).toBe(r.totals.revenuePaise);
    expect(byClient.totals.costPaise).toBe(r.totals.costPaise);
    const bySvc = (await t.http().get('/v1/reports/job-pnl?from=2026-10-01&to=2026-10-31&groupBy=service').set(H(f.p)).expect(200)).body;
    expect(bySvc.items).toHaveLength(1);
    // Manager: client A only (client B invisible), cost hidden.
    const rm = (await t.http().get(q).set(H(f.m)).expect(200)).body;
    expect(rm.costVisible).toBe(false);
    expect(rm.items.map((x: { taskId: string }) => x.taskId)).toEqual([f.tA]);
    expect(rm.items[0]).toMatchObject({ revenuePaise: 270_000, costPaise: null, marginPaise: null });
    // Job P&L carries revenue/fees: billing:view is required too (D172) — articles and seniors (reports:view own, no billing) get 403.
    await t.http().get(q).set(H(f.ar)).expect(403);
    await t.http().get(q).set(H(f.sr)).expect(403);
    // Review fix: WIP valued at cost (no rate-table fee) is hidden with the cost, and left out of the totals.
    const tC = (await t.http().post('/v1/tasks').set(H(f.p)).send({ client_id: f.cA, title: 'Ad-hoc advice', assignee_id: f.ar.userId, checks: [] }).expect(201)).body.id;
    await approve(f.m, [await entry(f.ar, { taskId: tC, workDate: '2026-10-13', minutes: 60, submit: true })]);
    const rp2 = (await t.http().get(q).set(H(f.p)).expect(200)).body;
    expect(rp2.items.find((x: { taskId: string }) => x.taskId === tC)).toMatchObject({ wipPaise: 90_000, wipAtCost: true });
    const rm2 = (await t.http().get(q).set(H(f.m)).expect(200)).body;
    expect(rm2.items.find((x: { taskId: string }) => x.taskId === tC)).toMatchObject({ wipPaise: null, costPaise: null });
    expect(rm2.totals.wipPaise).toBe(0);
    expect(JSON.stringify(rm2)).not.toContain('90000');

    // Capacity: holiday on Thu 15 Oct; planned = task A estimate (act-by 16 Oct, but done → excluded); actual = approved time.
    await t.http().post('/v1/hr/holidays').set(H(f.p)).send({ date: '2026-10-15', name: 'Dussehra (demo)' }).expect(201);
    await t.http().put(`/v1/hr/capacity/${f.ar.userId}`).set(H(f.p)).send({ weeklyMinutes: 2400 }).expect(204);
    await t.http().post('/v1/tasks').set(H(f.p)).send({ client_id: f.cA, title: 'Audit prep', assignee_id: f.ar.userId, act_by: '2026-10-17', estimate_minutes: 500, checks: [] }).expect(201);
    const cap = (await t.http().get('/v1/reports/capacity?weeks=2&from=2026-10-14').set(H(f.m)).expect(200)).body;
    expect(cap.weeks).toEqual(['2026-10-12', '2026-10-19']);
    expect(cap.users.map((u: { userId: string }) => u.userId).sort()).toEqual([f.m.userId, f.ar.userId].sort()); // self + report
    const w = cap.users.find((u: { userId: string }) => u.userId === f.ar.userId).weeks[0];
    expect(w).toMatchObject({ capacityMinutes: 2000, holidays: 1, plannedMinutes: 500, actualMinutes: 240, plannedPct: 25, actualPct: 12 });
    expect((await t.http().get('/v1/reports/capacity?weeks=1').set(H(f.ar)).expect(200)).body.users).toHaveLength(1);
  });
});

describe('sync', () => {
  it('own entries only; drafts editable offline; approved rejected; cost rates never shipped', async () => {
    const f = await firm('tm4');
    await t.http().post('/v1/hr/cost-rates').set(H(f.p)).send({ userId: f.ar.userId, hourlyPaise: 60_000, effectiveFrom: '2026-04-01' }).expect(201);
    const mineId = await entry(f.ar, { taskId: f.tA, workDate: '2026-10-13', minutes: 60, submit: true });
    await entry(f.m, { clientId: f.cA, workDate: '2026-10-13', minutes: 60 });
    await approve(f.m, [mineId]);
    const id = '01900000-0000-7000-8000-00000000a001';
    const push = (m: unknown[]) => t.http().post('/v1/sync/push').set(H(f.ar)).send({ mutations: m }).then((r) => { if (r.status !== 200) throw new Error(JSON.stringify(r.body)); return r.body.results; });
    const [ins] = await push([{ key: 'tm4-key-1', table: 'time_entry', id, baseVersion: 0, patch: { task_id: f.tA, work_date: '2026-10-14', minutes: 30, billable: true, notes: 'offline' } }]);
    expect(ins.status).toBe('applied');
    expect((await t.sql<{ client_id: string; user_id: string }>('SELECT client_id, user_id FROM time_entry WHERE id = $1', [id]))[0]).toMatchObject({ client_id: f.cA, user_id: f.ar.userId });
    const [bad] = await push([{ key: 'tm4-key-2', table: 'time_entry', id: mineId, baseVersion: 3, patch: { minutes: 10 } }]);
    expect(bad).toMatchObject({ status: 'rejected', reason: 'forbidden' });
    const [st] = await push([{ key: 'tm4-key-3', table: 'time_entry', id, baseVersion: 1, patch: { status: 'approved' } }]);
    expect(st).toMatchObject({ status: 'rejected', reason: 'invalid:status' });
    const [inv] = await push([{ key: 'tm4-key-4', table: 'time_entry', id: '01900000-0000-7000-8000-00000000a002', baseVersion: 0, patch: { client_id: f.cB, work_date: '2026-10-14', minutes: 30 } }]);
    expect(inv).toMatchObject({ status: 'rejected', reason: 'invalid:client_id' });
    // Review fix: "no future dates" also applies to device pushes (injectable clock, IST).
    const [fut] = await push([{ key: 'tm4-key-5', table: 'time_entry', id: '01900000-0000-7000-8000-00000000a003', baseVersion: 0, patch: { client_id: f.cA, work_date: '2026-10-15', minutes: 30 } }]);
    expect(fut).toMatchObject({ status: 'rejected', reason: 'future_date' });
    const pulled = (await t.http().get('/v1/sync/pull?since=0&limit=1000').set(H(f.ar)).expect(200)).body.changes as Array<{ table: string; fields: Record<string, unknown> }>;
    const te = pulled.filter((c) => c.table === 'time_entry');
    expect(te.length).toBe(2);
    expect(te.every((c) => c.fields.user_id === f.ar.userId)).toBe(true);
    expect(pulled.some((c) => c.table === 'cost_rate')).toBe(false);
    expect(JSON.stringify(pulled)).not.toContain('hourly_paise');
    expect(pulled.find((c) => c.table === 'task')?.fields).toHaveProperty('estimate_minutes');
  });
});
