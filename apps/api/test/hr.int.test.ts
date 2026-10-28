import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Clock } from '../src/common/clock.js';
import { JobQueueService } from '../src/jobs/job-queue.service.js';
import { bearer, bootApp, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
let clock: Clock;
beforeAll(async () => { t = await bootApp(); clock = t.app.get(Clock); clock.set(new Date('2026-10-14T09:30:00+05:30')); }, 60_000);
afterAll(() => t?.close());

const H = (s: Session) => bearer(s.accessToken);
const OFFICE = { lat: 18.5204, lng: 73.8567 };
type Firm = { p: Session; m: Session; ar: Session; sr: Session; cA: string };

async function firm(slug: string): Promise<Firm> {
  const p = await t.signup(slug);
  const m = await t.addUser(p, slug, 'Manager', 'manager');
  const ar = await t.addUser(p, slug, 'Article', 'article');
  const sr = await t.addUser(p, slug, 'Senior', 'senior');
  await t.http().patch(`/v1/users/${ar.userId}`).set(H(p)).send({ managerId: m.userId }).expect(204);
  await t.http().post('/v1/hr/office-locations').set(H(p)).send({ name: 'Pune office', ...OFFICE, radiusM: 200 }).expect(201);
  const cA = (await t.http().post('/v1/clients').set(H(p)).send({ name: 'Alpha Traders', entityType: 'PROPRIETORSHIP', staffIds: [ar.userId], managerId: m.userId }).expect(201)).body.id;
  return { p, m, ar, sr, cA };
}
const settings = (s: Session, attendance: Record<string, unknown>) => t.http().put('/v1/hr/settings').set(H(s)).send({ attendance });

describe('attendance', () => {
  it('geofence in/out, IP allow-list, approval of out-of-policy days, one per day, coordinates never logged', async () => {
    const f = await firm('hr1');
    clock.set(new Date('2026-10-14T09:30:00+05:30'));
    const a = (await t.http().post('/v1/hr/attendance/check-in').set(H(f.ar)).send({ lat: 18.52101234, lng: 73.8567, deviceAt: '2026-10-14T04:00:00Z' }).expect(201)).body;
    expect(a).toMatchObject({ date: '2026-10-14', status: 'ok', inFence: true, flags: [] });
    expect(a.distanceM).toBeLessThan(100);
    await t.http().post('/v1/hr/attendance/check-in').set(H(f.ar)).send({ ...OFFICE }).expect(409);
    const out = (await t.http().post('/v1/hr/attendance/check-in').set(H(f.m)).send({ lat: 18.54, lng: 73.85 }).expect(201)).body;
    expect(out).toMatchObject({ status: 'flagged', inFence: false, flags: ['out_of_fence'] });
    const [row] = await t.sql<{ in_lat: string }>('SELECT in_lat FROM attendance WHERE id = $1', [a.id]);
    expect(row!.in_lat).toBe('18.5210'); // rounded to 4 dp
    const logged = await t.sql<{ diff: unknown }>(`SELECT diff FROM audit_log WHERE tenant_id = $1 AND action LIKE 'attendance.%'`, [f.p.tenantId]);
    expect(JSON.stringify(logged)).not.toMatch(/18\.52|73\.85|"lat"/);
    // IP: allow-list matching the request IP (loopback in tests) passes; outside needs approval under this policy.
    await settings(f.p, { mode: 'ip', outside: 'approval', ipAllowList: ['127.0.0.1/32', '::1/128'] }).expect(200);
    await settings(f.p, { mode: 'ip', ipAllowList: ['not-an-ip'] }).expect(400);
    await settings(f.m, { mode: 'none' }).expect(403); // team-scope hr:edit is not firm-wide
    expect((await t.http().post('/v1/hr/attendance/check-in').set(H(f.sr)).send({}).expect(201)).body).toMatchObject({ status: 'ok', ipOk: true });
    await settings(f.p, { mode: 'ip', outside: 'approval', ipAllowList: ['10.0.0.0/8'] }).expect(200);
    const x = (await t.http().post('/v1/hr/attendance/check-in').set(H(f.p)).send({}).expect(201)).body;
    expect(x).toMatchObject({ status: 'needs_approval', ipOk: false, flags: ['ip_not_allowed'] });
    await t.http().post(`/v1/hr/attendance/${x.id}/decide`).set(H(f.p)).send({ approve: true }).expect(403); // self
    await t.http().post(`/v1/hr/attendance/${x.id}/decide`).set(H(f.ar)).send({ approve: true }).expect(404); // invisible
    await t.http().post(`/v1/hr/attendance/${out.id}/decide`).set(H(f.p)).send({ approve: true, note: 'client visit' }).expect(204);
    expect((await t.http().get('/v1/hr/attendance?status=approved').set(H(f.p)).expect(200)).body).toHaveLength(1);
    // Check-out from server time.
    clock.set(new Date('2026-10-14T18:00:00+05:30'));
    expect((await t.http().post('/v1/hr/attendance/check-out').set(H(f.ar)).send({ ...OFFICE }).expect(200)).body.minutes).toBe(510);
    await t.http().post('/v1/hr/attendance/check-out').set(H(f.ar)).send({}).expect(404);
    // The article sees only their own rows; the manager sees their report's too.
    expect((await t.http().get('/v1/hr/attendance').set(H(f.ar)).expect(200)).body).toHaveLength(1);
    expect((await t.http().get('/v1/hr/attendance').set(H(f.m)).expect(200)).body.map((r: { userId: string }) => r.userId).sort()).toEqual([f.m.userId, f.ar.userId].sort());
  });

  it('regularisation with approval feeds the monthly report; offline check-in via sync flags clock skew', async () => {
    const f = await firm('hr2');
    clock.set(new Date('2026-10-14T09:30:00+05:30'));
    const id = (await t.http().post('/v1/hr/attendance/regularisations').set(H(f.ar)).send({ date: '2026-10-12', checkIn: '09:30', checkOut: '18:00', reason: 'Forgot to check in' }).expect(201)).body.id;
    await t.http().post('/v1/hr/attendance/regularisations').set(H(f.ar)).send({ date: '2026-10-12', checkIn: '09:30', reason: 'again' }).expect(409);
    await t.http().post(`/v1/hr/attendance/regularisations/${id}/decide`).set(H(f.ar)).send({ approve: true }).expect(403);
    await t.http().post(`/v1/hr/attendance/regularisations/${id}/decide`).set(H(f.m)).send({ approve: true }).expect(204);
    const [r] = (await t.http().get(`/v1/hr/attendance?userId=${f.ar.userId}`).set(H(f.m)).expect(200)).body;
    expect(r).toMatchObject({ date: '2026-10-12', method: 'regularised', status: 'approved', minutes: 510 });
    await t.http().post('/v1/hr/holidays').set(H(f.p)).send({ date: '2026-10-02', name: 'Gandhi Jayanti' }).expect(201);
    const rep = (await t.http().get('/v1/hr/attendance/report?month=2026-10').set(H(f.m)).expect(200)).body;
    const u = rep.users.find((x: { userId: string }) => x.userId === f.ar.userId);
    // Oct 2026: 31 days − 4 Sundays − 1 holiday = 26 working days.
    expect(u).toMatchObject({ workingDays: 26, presentDays: 1, absentDays: 25, minutes: 510 });
    // Review fixes: offline check-ins take day/time from the device (bounded), keep the receipt time, never audit coordinates.
    const push = (key: string, id: string, patch: Record<string, unknown>) => t.http().post('/v1/sync/push').set(H(f.sr)).send({ mutations: [{ key, table: 'attendance', id, baseVersion: 0, patch }] })
      .expect(200).then((r) => r.body.results[0]);
    expect(await push('hr2-offline-old', '01900000-0000-7000-8000-00000000b002', { device_check_in_at: '2026-10-01T03:30:00Z', in_lat: 18.5205, in_lng: 73.8566 })).toMatchObject({ status: 'rejected', reason: 'too_old' });
    expect(await push('hr2-offline-fut', '01900000-0000-7000-8000-00000000b003', { device_check_in_at: '2026-10-15T03:30:00Z', in_lat: 18.5205, in_lng: 73.8566 })).toMatchObject({ status: 'rejected', reason: 'future_time' });
    const oid = '01900000-0000-7000-8000-00000000b001';
    expect((await push('hr2-offline-1', oid, { device_check_in_at: '2026-10-13T03:30:00Z', in_lat: 18.52051, in_lng: 73.85663 })).status).toBe('applied');
    const [row] = await t.sql<{ flags: string[]; status: string; in_fence: boolean; user_id: string; method: string; work_date: Date; check_in_at: Date; received_at: Date }>(
      'SELECT flags, status, in_fence, user_id, method, to_char(work_date, \'YYYY-MM-DD\') AS work_date, check_in_at, received_at FROM attendance WHERE id = $1', [oid]);
    expect(row).toMatchObject({ flags: ['clock_skew'], status: 'ok', in_fence: true, user_id: f.sr.userId, method: 'offline', work_date: '2026-10-13' });
    expect(new Date(row!.check_in_at).toISOString()).toBe('2026-10-13T03:30:00.000Z');
    expect(new Date(row!.received_at).toISOString()).toBe('2026-10-14T04:00:00.000Z');
    // Offline check-out: device time, not in the future.
    const out = (patch: Record<string, unknown>, key: string) => t.http().post('/v1/sync/push').set(H(f.sr)).send({ mutations: [{ key, table: 'attendance', id: oid, baseVersion: 1, patch }] }).expect(200).then((r) => r.body.results[0]);
    expect(await out({ device_check_out_at: '2026-10-15T12:00:00Z' }, 'hr2-out-future')).toMatchObject({ status: 'rejected', reason: 'future_time' });
    expect((await out({ device_check_out_at: '2026-10-13T12:30:00Z', out_lat: 18.5206, out_lng: 73.8567 }, 'hr2-out-1')).status).toBe('applied');
    expect((await t.sql<{ minutes: number }>('SELECT minutes FROM attendance WHERE id = $1', [oid]))[0]!.minutes).toBe(540);
    const logged = JSON.stringify(await t.sql(`SELECT diff FROM audit_log WHERE tenant_id = $1 AND entity = 'attendance'`, [f.p.tenantId]));
    expect(logged).not.toMatch(/18\.52|73\.85/);
    expect(logged).toContain('[omitted]');
    // Regularising a day that was already decided is refused, not silently overwritten.
    await t.sql(`UPDATE attendance SET status = 'approved', decided_by = $2 WHERE id = $1`, [oid, f.p.userId]);
    const rg = (await t.http().post('/v1/hr/attendance/regularisations').set(H(f.sr)).send({ date: '2026-10-13', checkIn: '08:00', checkOut: '20:00', reason: 'Was earlier' }).expect(201)).body.id;
    await t.http().post(`/v1/hr/attendance/regularisations/${rg}/decide`).set(H(f.p)).send({ approve: true }).expect(409);
    // Check-out caps the day (firm setting) and flags it; only today's / recent open rows close.
    await t.http().put('/v1/hr/settings').set(H(f.p)).send({ attendance: { maxMinutes: 60 } }).expect(200);
    clock.set(new Date('2026-10-14T09:30:00+05:30'));
    await t.http().post('/v1/hr/attendance/check-in').set(H(f.ar)).send({ ...OFFICE }).expect(201);
    clock.set(new Date('2026-10-14T18:00:00+05:30'));
    const co = (await t.http().post('/v1/hr/attendance/check-out').set(H(f.ar)).send({}).expect(200)).body;
    expect(co.minutes).toBe(60);
    expect((await t.sql<{ flags: string[] }>('SELECT flags FROM attendance WHERE id = $1', [co.id]))[0]!.flags).toContain('minutes_capped');
    await t.http().post('/v1/hr/attendance/check-in').set(H(f.m)).send({ ...OFFICE }).expect(201);
    clock.set(new Date('2026-10-16T10:00:00+05:30'));
    await t.http().post('/v1/hr/attendance/check-out').set(H(f.m)).send({}).expect(404); // forgotten check-out from two days ago
    clock.set(new Date('2026-10-14T09:30:00+05:30'));
  });
});

describe('leave', () => {
  it('types by role, ledger balances, overlap, partial approval, cancel, accrual idempotent, capacity reduced', async () => {
    const f = await firm('hr3');
    clock.set(new Date('2026-10-14T09:30:00+05:30'));
    const lt = async (b: Record<string, unknown>) => (await t.http().post('/v1/hr/leave-types').set(H(f.p)).send(b).expect(201)).body.id as string;
    const casual = await lt({ key: 'casual', name: 'Casual leave', accrual: { kind: 'monthly', days: 1 }, carryForwardCap: 5 });
    const study = await lt({ key: 'study', name: 'Study leave (articles)', appliesToRoles: ['article'], allowHalfDay: false });
    await t.http().post('/v1/hr/leave-types').set(H(f.m)).send({ key: 'x_type', name: 'x' }).expect(403);
    await t.http().post('/v1/hr/leave/requests').set(H(f.sr)).send({ leaveTypeId: study, from: '2026-10-19', to: '2026-10-19' }).expect(400); // not for seniors
    await t.http().post('/v1/hr/leave/ledger').set(H(f.p)).send({ userId: f.ar.userId, leaveTypeId: study, delta: 5, reason: 'opening', note: 'Opening balance' }).expect(204);
    await t.http().post('/v1/hr/leave/ledger').set(H(f.p)).send({ userId: f.p.userId, leaveTypeId: casual, delta: 5, reason: 'grant', note: 'self' }).expect(403);
    await t.http().post('/v1/hr/leave/requests').set(H(f.ar)).send({ leaveTypeId: study, from: '2026-10-19', to: '2026-10-24' }).expect(409); // 6 days > 5
    await t.http().post('/v1/hr/leave/requests').set(H(f.ar)).send({ leaveTypeId: study, from: '2026-10-19', to: '2026-10-19', startHalf: true }).expect(400); // no half days
    const r1 = (await t.http().post('/v1/hr/leave/requests').set(H(f.ar)).send({ leaveTypeId: study, from: '2026-10-19', to: '2026-10-21', reason: 'CA Inter exam prep' }).expect(201)).body;
    expect(r1.days).toBe(3);
    await t.http().post('/v1/hr/leave/requests').set(H(f.ar)).send({ leaveTypeId: study, from: '2026-10-21', to: '2026-10-22' }).expect(409); // overlap
    expect((await t.http().get('/v1/hr/leave/balances').set(H(f.ar)).expect(200)).body.balances.find((b: { leaveType: { key: string } }) => b.leaveType.key === 'study')).toMatchObject({ balance: 5, pending: 3, available: 2 });
    await t.http().post(`/v1/hr/leave/requests/${r1.id}/decide`).set(H(f.ar)).send({ approve: true }).expect(403);
    await t.http().post(`/v1/hr/leave/requests/${r1.id}/decide`).set(H(f.m)).send({ approve: true, approvedFrom: '2026-10-18' }).expect(400);
    expect((await t.http().post(`/v1/hr/leave/requests/${r1.id}/decide`).set(H(f.m)).send({ approve: true, approvedTo: '2026-10-20', note: 'Wed needed for audit' }).expect(200)).body)
      .toEqual({ status: 'partially_approved', approvedDays: 2 });
    await t.http().post(`/v1/hr/leave/requests/${r1.id}/decide`).set(H(f.m)).send({ approve: true }).expect(409);
    const led = (await t.http().get(`/v1/hr/leave/ledger?userId=${f.ar.userId}`).set(H(f.m)).expect(200)).body;
    expect(led.map((l: { reason: string; delta: number }) => `${l.reason}:${l.delta}`)).toEqual(['opening:5', 'leave:-2']);
    // The 21st is free again → a new request there is fine; capacity of that week drops by the approved days.
    const r2 = (await t.http().post('/v1/hr/leave/requests').set(H(f.ar)).send({ leaveTypeId: study, from: '2026-10-22', to: '2026-10-22' }).expect(201)).body;
    await t.http().post(`/v1/hr/leave/requests/${r2.id}/decide`).set(H(f.m)).send({ approve: true }).expect(200);
    const cap = (await t.http().get('/v1/reports/capacity?weeks=1&from=2026-10-19').set(H(f.m)).expect(200)).body;
    expect(cap.users.find((u: { userId: string }) => u.userId === f.ar.userId).weeks[0]).toMatchObject({ capacityMinutes: 1200, leaveDays: 3 });
    // Cancel the not-yet-started leave → credited back.
    await t.http().post(`/v1/hr/leave/requests/${r1.id}/cancel`).set(H(f.m)).expect(404); // only the owner
    await t.http().post(`/v1/hr/leave/requests/${r1.id}/cancel`).set(H(f.ar)).expect(204);
    expect((await t.http().get('/v1/hr/leave/balances').set(H(f.ar)).expect(200)).body.balances.find((b: { leaveType: { key: string } }) => b.leaveType.key === 'study').balance).toBe(4);
    // Accrual: once per month; April lapses above the carry-forward cap.
    expect((await t.http().post('/v1/hr/leave/accrue').set(H(f.p)).send({ month: '2026-11' }).expect(200)).body.creditedDays).toBe(4); // 4 staff × 1
    expect((await t.http().post('/v1/hr/leave/accrue').set(H(f.p)).send({ month: '2026-11' }).expect(200)).body.creditedDays).toBe(0);
    await t.http().post('/v1/hr/leave/ledger').set(H(f.p)).send({ userId: f.ar.userId, leaveTypeId: casual, delta: 6, reason: 'grant', note: 'bonus' }).expect(204);
    expect((await t.http().post('/v1/hr/leave/accrue').set(H(f.p)).send({ month: '2027-04' }).expect(200)).body.lapsedDays).toBe(2); // article: 7 → cap 5
    // Sync: own requests/ledger only, leave types for everyone.
    const pulled = (await t.http().get('/v1/sync/pull?since=0&limit=1000').set(H(f.ar)).expect(200)).body.changes as Array<{ table: string; fields: Record<string, unknown> }>;
    expect(pulled.filter((c) => c.table === 'leave_type').length).toBe(2);
    expect(pulled.filter((c) => c.table === 'leave_request').every((c) => c.fields.user_id === f.ar.userId)).toBe(true);
    expect(pulled.filter((c) => c.table === 'leave_ledger').every((c) => c.fields.user_id === f.ar.userId)).toBe(true);
    const sr = (await t.http().get('/v1/sync/pull?since=0&limit=1000').set(H(f.sr)).expect(200)).body.changes as Array<{ table: string }>;
    expect(sr.filter((c) => c.table === 'leave_request')).toHaveLength(0);
  });

  it('comp-off auto-grant for weekend/holiday work is idempotent (REST and job) and expires', async () => {
    const f = await firm('hr4');
    clock.set(new Date('2026-10-14T09:30:00+05:30'));
    const co = (await t.http().post('/v1/hr/leave-types').set(H(f.p)).send({ key: 'comp_off', name: 'Comp-off', compOff: true }).expect(201)).body.id;
    await t.http().post('/v1/hr/holidays').set(H(f.p)).send({ date: '2026-10-02', name: 'Gandhi Jayanti' }).expect(201);
    // Sunday 11 Oct: 300 min approved time (½ day); 2 Oct holiday: 480 min (1 day); Monday 12 Oct: workday, nothing.
    const ids = [];
    for (const [d, m] of [['2026-10-11', 300], ['2026-10-02', 480], ['2026-10-12', 600]] as const) {
      ids.push((await t.http().post('/v1/time/entries').set(H(f.ar)).send({ clientId: f.cA, workDate: d, minutes: m, submit: true }).expect(201)).body.id);
    }
    await t.http().post('/v1/time/entries/decide').set(H(f.m)).send({ ids, approve: true }).expect(200);
    await t.http().post('/v1/hr/leave/comp-off/run').set(H(f.m)).send({ from: '2026-10-01', to: '2026-10-13' }).expect(403);
    expect((await t.http().post('/v1/hr/leave/comp-off/run').set(H(f.p)).send({ from: '2026-10-01', to: '2026-10-13' }).expect(200)).body).toEqual({ granted: 2, days: 1.5 });
    expect((await t.http().post('/v1/hr/leave/comp-off/run').set(H(f.p)).send({ from: '2026-10-01', to: '2026-10-13' }).expect(200)).body).toEqual({ granted: 0, days: 0 });
    // The daily job (for yesterday) is idempotent too.
    await t.sql(`INSERT INTO job_queue (tenant_id, kind, ref_id, run_at) VALUES ($1, 'hr.compoff', $1, '2026-10-11T00:00:00Z')`, [f.p.tenantId]);
    await t.app.get(JobQueueService).runOnce(50, new Date('2026-10-12T02:00:00+05:30'));
    const [j] = await t.sql<{ run_at: Date }>(`SELECT run_at FROM job_queue WHERE tenant_id = $1 AND kind = 'hr.compoff'`, [f.p.tenantId]);
    expect(j!.run_at.toISOString()).toBe('2026-10-12T19:30:00.000Z'); // rescheduled to 01:00 IST next day
    const b = (await t.http().get('/v1/hr/leave/balances').set(H(f.ar)).expect(200)).body.balances.find((x: { leaveType: { id: string } }) => x.leaveType.id === co);
    expect(b).toMatchObject({ balance: 1.5 });
    expect(b.expiring.map((e: { expiresOn: string }) => e.expiresOn).sort()).toEqual(['2026-12-31', '2027-01-09']);
    // Review fix: a cancelled leave restores the consumed credit with its original expiry.
    const lv = (await t.http().post('/v1/hr/leave/requests').set(H(f.ar)).send({ leaveTypeId: co, from: '2026-10-16', to: '2026-10-16', startHalf: true }).expect(201)).body;
    await t.http().post(`/v1/hr/leave/requests/${lv.id}/decide`).set(H(f.m)).send({ approve: true }).expect(200);
    await t.http().post(`/v1/hr/leave/requests/${lv.id}/cancel`).set(H(f.ar)).expect(204);
    const back = (await t.http().get(`/v1/hr/leave/ledger?userId=${f.ar.userId}`).set(H(f.m)).expect(200)).body.filter((l: { reason: string }) => l.reason === 'cancel');
    expect(back.map((l: { delta: number; expiresOn: string }) => [l.delta, l.expiresOn])).toEqual([[0.5, '2026-12-31']]);
    clock.set(new Date('2027-01-05T09:30:00+05:30'));
    expect((await t.http().get('/v1/hr/leave/balances').set(H(f.ar)).expect(200)).body.balances.find((x: { leaveType: { id: string } }) => x.leaveType.id === co).balance).toBe(0.5);
    clock.set(new Date('2026-10-14T09:30:00+05:30'));
    // Review fix: reversing the Sunday time posts a negative adjustment (once); only ok/approved attendance counts.
    await t.http().post(`/v1/time/entries/${ids[0]}/reverse`).set(H(f.m)).send({ note: 'billed to wrong day' }).expect(201);
    const run = () => t.http().post('/v1/hr/leave/comp-off/run').set(H(f.p)).send({ from: '2026-10-01', to: '2026-10-13' }).expect(200).then((r) => r.body);
    expect(await run()).toEqual({ granted: 1, days: -0.5 });
    expect(await run()).toEqual({ granted: 0, days: 0 });
    const att = '01900000-0000-7000-8000-00000000c001';
    await t.sql(`INSERT INTO attendance (id, tenant_id, user_id, work_date, check_in_at, minutes, status, flags) VALUES ($1,$2,$3,'2026-10-04','2026-10-04T04:00:00Z',480,'flagged','{out_of_fence}')`, [att, f.p.tenantId, f.ar.userId]);
    expect(await run()).toEqual({ granted: 0, days: 0 }); // flagged attendance doesn't earn
    await t.http().post(`/v1/hr/attendance/${att}/decide`).set(H(f.m)).send({ approve: true }).expect(204);
    expect(await run()).toEqual({ granted: 1, days: 1 });
    // The daily job looks back (default 7 days), so a late approval is picked up there too.
    await t.sql(`INSERT INTO attendance (id, tenant_id, user_id, work_date, check_in_at, minutes, status) VALUES ($1,$2,$3,'2026-10-11','2026-10-11T04:00:00Z',480,'ok')`,
      ['01900000-0000-7000-8000-00000000c002', f.p.tenantId, f.ar.userId]);
    await t.sql(`UPDATE job_queue SET run_at = '2026-10-13T00:00:00Z' WHERE tenant_id = $1 AND kind = 'hr.compoff'`, [f.p.tenantId]);
    await t.app.get(JobQueueService).runOnce(50, new Date('2026-10-14T02:00:00+05:30')); // yesterday = 13 Oct; looks back to 6 Oct
    const sun = await t.sql<{ s: string }>(`SELECT sum(delta) AS s FROM leave_ledger WHERE user_id = $1 AND (ref_key = 'compoff:2026-10-11' OR ref_key LIKE 'compoff:2026-10-11:%')`, [f.ar.userId]);
    expect(Number(sun[0]!.s)).toBe(1);
  });
});

describe('expenses', () => {
  it('policy limits, per-line partial approval, advance settlement, payout, billable link to an invoice once', async () => {
    const f = await firm('hr5');
    clock.set(new Date('2026-10-14T09:30:00+05:30'));
    await t.http().put('/v1/hr/expense-categories').set(H(f.p)).send({ key: 'travel', name: 'Local travel', limitPaise: 50_000, limitMode: 'warn' }).expect(200);
    await t.http().put('/v1/hr/expense-categories').set(H(f.p)).send({ key: 'roc_fees', name: 'ROC / govt fees', limitPaise: 100_000, limitMode: 'block' }).expect(200);
    const line = (k: string, amt: number, extra: Record<string, unknown> = {}) => ({ categoryKey: k, spentOn: '2026-10-12', description: `${k} expense`, amountPaise: amt, ...extra });
    await t.http().post('/v1/hr/expenses/claims').set(H(f.ar)).send({ title: 'Too much', lines: [line('roc_fees', 200_000)] }).expect(400);
    await t.http().post('/v1/hr/expenses/claims').set(H(f.ar)).send({ title: 'No client', lines: [line('roc_fees', 20_000, { billable: true })] }).expect(400);
    const c = (await t.http().post('/v1/hr/expenses/claims').set(H(f.ar)).send({ title: 'Client visit', lines: [line('travel', 60_000), line('roc_fees', 20_000, { billable: true, clientId: f.cA })] }).expect(201)).body;
    expect(c.warnings).toHaveLength(1);
    await t.http().post(`/v1/hr/expenses/claims/${c.id}/submit`).set(H(f.ar)).expect(204);
    await t.http().patch(`/v1/hr/expenses/claims/${c.id}`).set(H(f.ar)).send({ title: 'x' }).expect(409);
    const claim = (await t.http().get(`/v1/hr/expenses/claims/${c.id}`).set(H(f.m)).expect(200)).body;
    expect(claim.lines[0]).toMatchObject({ policyFlag: 'over_limit', amountPaise: 60_000 });
    await t.http().get(`/v1/hr/expenses/claims/${c.id}`).set(H(f.sr)).expect(404);
    await t.http().post(`/v1/hr/expenses/claims/${c.id}/decide`).set(H(f.ar)).send({ approve: true }).expect(403);
    await t.http().post(`/v1/hr/expenses/claims/${c.id}/decide`).set(H(f.m)).send({ approve: true, lines: [{ id: claim.lines[0].id, approvedPaise: 70_000 }] }).expect(400);
    expect((await t.http().post(`/v1/hr/expenses/claims/${c.id}/decide`).set(H(f.m)).send({ approve: true, lines: [{ id: claim.lines[0].id, approvedPaise: 50_000, note: 'policy cap' }] }).expect(200)).body)
      .toEqual({ status: 'partially_approved', approvedPaise: 70_000 });
    // Advance: request 30,000 → approve 25,000 → paid; then the claim payout settles it first.
    const adv = (await t.http().post('/v1/hr/expenses/advances').set(H(f.ar)).send({ purpose: 'Outstation audit travel', amountPaise: 30_000 }).expect(201)).body.id;
    await t.http().post(`/v1/hr/expenses/advances/${adv}/pay`).set(H(f.p)).send({ reference: 'NEFT1' }).expect(409);
    await t.http().post(`/v1/hr/expenses/advances/${adv}/decide`).set(H(f.m)).send({ approve: true, approvedPaise: 25_000 }).expect(200);
    await t.http().post(`/v1/hr/expenses/advances/${adv}/pay`).set(H(f.m)).send({ reference: 'NEFT1' }).expect(403); // team scope, not firm-wide
    await t.http().post(`/v1/hr/expenses/advances/${adv}/pay`).set(H(f.p)).send({ reference: 'NEFT1' }).expect(204);
    expect((await t.http().get('/v1/hr/expenses/advances').set(H(f.ar)).expect(200)).body.outstandingPaise).toBe(25_000);
    expect((await t.http().post(`/v1/hr/expenses/claims/${c.id}/pay`).set(H(f.p)).send({ reference: 'NEFT2' }).expect(200)).body).toEqual({ advanceSettledPaise: 25_000, paidPaise: 45_000 });
    const advs = (await t.http().get('/v1/hr/expenses/advances').set(H(f.ar)).expect(200)).body;
    expect(advs).toMatchObject({ outstandingPaise: 0, items: [{ status: 'settled', balancePaise: 0 }] });
    // Re-bill the ROC fee: reimbursable list → invoice reimbursement line → link once.
    await t.http().get('/v1/hr/expenses/reimbursable').set(H(f.ar)).expect(403);
    const rb = (await t.http().get(`/v1/hr/expenses/reimbursable?clientId=${f.cA}`).set(H(f.p)).expect(200)).body;
    expect(rb.totalPaise).toBe(20_000);
    const el = rb.items[0];
    const inv = (await t.http().post('/v1/billing/invoices').set(H(f.p)).send({ clientId: f.cA, lines: [{ description: 'Fees', ratePaise: 100_000 }, el.suggestedLine] }).expect(201)).body.id;
    const lines = (await t.http().get(`/v1/billing/invoices/${inv}`).set(H(f.p)).expect(200)).body.lines;
    await t.http().post(`/v1/hr/expenses/lines/${el.id}/link`).set(H(f.p)).send({ invoiceLineId: lines[0].id }).expect(400); // not a reimbursement line
    // Review fix: a credit note's reimbursement line is not a billing target.
    const inv2 = (await t.http().post('/v1/billing/invoices').set(H(f.p)).send({ clientId: f.cA, lines: [el.suggestedLine] }).expect(201)).body.id;
    await t.http().post(`/v1/billing/invoices/${inv2}/issue`).set(H(f.p)).send({ issueDate: '2026-10-13' }).expect(200);
    const cn = (await t.http().post(`/v1/billing/invoices/${inv2}/notes`).set(H(f.p)).send({ kind: 'credit_note', date: '2026-10-14', reason: 'Wrong client', lines: [{ description: 'ROC fee', taxablePaise: 20_000, reimbursement: true }] }).expect(201)).body.id;
    const cnLine = (await t.http().get(`/v1/billing/invoices/${cn}`).set(H(f.p)).expect(200)).body.lines[0];
    await t.http().post(`/v1/hr/expenses/lines/${el.id}/link`).set(H(f.p)).send({ invoiceLineId: cnLine.id }).expect(400);
    await t.http().post(`/v1/hr/expenses/lines/${el.id}/link`).set(H(f.p)).send({ invoiceLineId: lines[1].id }).expect(204);
    await t.http().post(`/v1/hr/expenses/lines/${el.id}/link`).set(H(f.p)).send({ invoiceLineId: lines[1].id }).expect(409);
    expect((await t.http().get('/v1/hr/expenses/reimbursable').set(H(f.p)).expect(200)).body.items).toHaveLength(0);
    const acts = (await t.sql<{ action: string }>(`SELECT action FROM audit_log WHERE tenant_id = $1 AND entity IN ('expense_claim','expense_advance','expense_line')`, [f.p.tenantId])).map((x) => x.action);
    expect(acts).toEqual(expect.arrayContaining(['expense_claim.created', 'expense_claim.partially_approved', 'expense_advance.paid', 'expense_claim.paid', 'expense_line.billed']));
  });
});
