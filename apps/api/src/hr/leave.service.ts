import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { accrualFor, addDaysIso, availableBalance, carryForwardLapse, compOffDays, eachDay, fyStartYear, isWorkingDay, istDate, leaveDays, type Accrual } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { Params } from '../clients/scope.js';
import { Clock } from '../common/clock.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { JobQueueService, Reschedule } from '../jobs/job-queue.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { SyncService } from '../sync/sync.service.js';
import { requireFirmWide, systemActor } from '../tasks/system-actor.js';
import { AttendanceService } from './attendance.service.js';
import { calendarFor, isoDay, loadHrSettings, num, personOf, personScopeSql, requireApprover, requireOwn, requirePerson } from './common.js';
import { presentLeaveType } from './config.service.js';

export const COMPOFF_JOB = 'hr.compoff';

const presentRequest = (r: Record<string, unknown>) => ({
  id: r.id, userId: r.user_id, userName: r.user_name ?? null, leaveTypeId: r.leave_type_id, leaveTypeKey: r.type_key ?? null, from: isoDay(r.from_date), to: isoDay(r.to_date),
  startHalf: r.start_half, endHalf: r.end_half, days: Number(r.days), reason: r.reason ?? null, status: r.status,
  approvedFrom: isoDay(r.approved_from), approvedTo: isoDay(r.approved_to), approvedDays: num(r.approved_days), decidedBy: r.decided_by ?? null, decidedAt: r.decided_at ?? null,
  decisionNote: r.decision_note ?? null, cancelledAt: r.cancelled_at ?? null, version: r.version,
});

type Ledger = { delta: number; expiresOn: string | null; on: string };

/** Leave (M14): types as data, ledger balances, apply → approve (partial) / reject, cancel, accrual + carry-forward, comp-off job. */
@Injectable()
export class LeaveService implements OnModuleInit {
  private log = new Logger('Leave');
  constructor(private db: DbService, private sync: SyncService, private audit: AuditService, private realtime: RealtimeService, private jobs: JobQueueService, private clock: Clock) {}

  onModuleInit() {
    this.jobs.register(COMPOFF_JOB, async (job, at) => {
      const day = addDaysIso(istDate(at), -1);
      const r = await this.runCompOff(systemActor(job.tenant_id), day, day);
      if (r.granted) this.log.log(`Tenant ${job.tenant_id}: ${r.granted} comp-off credits for ${day}`);
      throw new Reschedule(new Date(`${addDaysIso(istDate(at), 1)}T01:00:00+05:30`));
    });
    if (Number(process.env.JOB_POLL_MS ?? (process.env.NODE_ENV === 'test' ? 0 : 2000)) > 0) {
      void this.db.systemTx((tx) => tx.query(`INSERT INTO job_queue (tenant_id, kind, ref_id, run_at) SELECT t.id, $1, t.id, now() FROM tenant t
        ON CONFLICT (tenant_id, kind) WHERE kind = 'hr.compoff' AND dead_at IS NULL DO NOTHING`, [COMPOFF_JOB])).catch((e) => this.log.error(e));
    }
  }

  private pub(tenantId: string, c: number | undefined) { if (c) this.realtime.publish({ type: 'changed', tenantId, cursor: c }); }

  private async credit(tx: Tx, a: RequestActor, row: { userId: string; typeId: string; delta: number; reason: string; refKey?: string | null; requestId?: string | null; on: string; expiresOn?: string | null; note?: string | null }) {
    const r = await tx.query(`INSERT INTO leave_ledger (id, tenant_id, user_id, leave_type_id, delta, reason, ref_key, request_id, on_date, expires_on, note, created_by, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) ON CONFLICT (tenant_id, user_id, leave_type_id, ref_key) WHERE ref_key IS NOT NULL DO NOTHING RETURNING sync_cursor`,
      [uuidv7(), a.tenantId, row.userId, row.typeId, row.delta, row.reason, row.refKey ?? null, row.requestId ?? null, row.on, row.expiresOn ?? null, row.note ?? null, a.userId]);
    return r.rowCount ? Number(r.rows[0].sync_cursor) : 0;
  }
  private async entries(tx: Tx, userId: string, typeId: string): Promise<Ledger[]> {
    return (await tx.query(`SELECT delta, to_char(expires_on,'YYYY-MM-DD') AS e, to_char(on_date,'YYYY-MM-DD') AS o FROM leave_ledger WHERE user_id = $1 AND leave_type_id = $2 AND deleted_at IS NULL`, [userId, typeId])).rows
      .map((r) => ({ delta: Number(r.delta), expiresOn: r.e, on: r.o }));
  }
  private async pending(tx: Tx, userId: string, typeId: string, except?: string) {
    return Number((await tx.query(`SELECT COALESCE(sum(days),0) AS s FROM leave_request WHERE user_id = $1 AND leave_type_id = $2 AND status = 'pending' AND deleted_at IS NULL AND id <> COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000')`, [userId, typeId, except ?? null])).rows[0].s);
  }
  private async roleKeys(tx: Tx, userId: string): Promise<string[]> {
    return (await tx.query('SELECT r.key FROM role r JOIN user_role ur ON ur.role_id = r.id WHERE ur.user_id = $1 AND r.deleted_at IS NULL', [userId])).rows.map((r) => r.key);
  }
  private applicable(t: Record<string, unknown>, roles: string[]) { const want = (t.applies_to_roles as string[]) ?? []; return !want.length || want.some((k) => roles.includes(k)); }

  /** Balances per applicable type (ledger sum with comp-off expiry FIFO), pending days and available = balance − pending. */
  balances(a: RequestActor, userId?: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const uid = userId ?? a.userId;
      await requirePerson(tx, a, 'hr', 'view', uid);
      const roles = await this.roleKeys(tx, uid);
      const today = this.clock.todayIst();
      const types = (await tx.query('SELECT * FROM leave_type WHERE deleted_at IS NULL AND active ORDER BY sort, key')).rows.filter((t) => this.applicable(t, roles));
      const out = [];
      for (const t of types) {
        const e = await this.entries(tx, uid, t.id);
        const balance = availableBalance(e, today);
        const pend = await this.pending(tx, uid, t.id);
        out.push({ leaveType: presentLeaveType(t), balance, pending: pend, available: Math.round((balance - pend) * 2) / 2,
          expiring: e.filter((x) => x.delta > 0 && x.expiresOn && x.expiresOn >= today).map((x) => ({ days: x.delta, expiresOn: x.expiresOn })) });
      }
      return { userId: uid, asOf: today, balances: out };
    });
  }

  ledger(a: RequestActor, userId?: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const uid = userId ?? a.userId;
      await requirePerson(tx, a, 'hr', 'view', uid);
      return (await tx.query(`SELECT l.*, t.key FROM leave_ledger l JOIN leave_type t ON t.id = l.leave_type_id WHERE l.user_id = $1 ORDER BY l.on_date, l.created_at`, [uid])).rows
        .map((r) => ({ id: r.id, leaveTypeId: r.leave_type_id, leaveTypeKey: r.key, delta: Number(r.delta), reason: r.reason, refKey: r.ref_key, requestId: r.request_id, on: isoDay(r.on_date), expiresOn: isoDay(r.expires_on), note: r.note }));
    });
  }

  /** Manual credit/debit (opening balance, grant, adjustment): firm-wide hr:approve, never on one's own balance. */
  async adjust(a: RequestActor, i: { userId: string; leaveTypeId: string; delta: number; reason: 'opening' | 'grant' | 'adjustment'; note: string; expiresOn?: string | null }) {
    requireFirmWide(a, 'hr', 'approve');
    if (i.userId === a.userId) throw new ForbiddenException({ message: 'You cannot adjust your own balance', code: 'self_approval' });
    let c = 0;
    await this.db.tenantTx(a.tenantId, async (tx) => {
      if (!(await personOf(tx, i.userId))) throw new NotFoundException();
      if (!(await tx.query('SELECT 1 FROM leave_type WHERE id = $1 AND deleted_at IS NULL', [i.leaveTypeId])).rowCount) throw new NotFoundException();
      c = await this.credit(tx, a, { userId: i.userId, typeId: i.leaveTypeId, delta: i.delta, reason: i.reason, on: this.clock.todayIst(), expiresOn: i.expiresOn, note: i.note });
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'leave_ledger.adjusted', entity: 'app_user', entityId: i.userId, diff: i });
    });
    this.pub(a.tenantId, c);
  }

  /**
   * Monthly accrual (idempotent per user × type × month). In April the balance above each type's carry-forward cap lapses
   * first (once per FY). Firm-wide hr:approve.
   */
  async accrue(a: RequestActor, month: string) {
    requireFirmWide(a, 'hr', 'approve');
    let c = 0;
    const res = await this.db.tenantTx(a.tenantId, async (tx) => {
      const users = (await tx.query(`SELECT id FROM app_user WHERE deleted_at IS NULL AND status = 'active' AND kind = 'staff' ORDER BY id`)).rows.map((r) => r.id as string);
      const types = (await tx.query(`SELECT * FROM leave_type WHERE deleted_at IS NULL AND active AND tracked ORDER BY key`)).rows;
      const on = `${month}-01`;
      let credited = 0; let lapsed = 0;
      for (const u of users) {
        const roles = await this.roleKeys(tx, u);
        for (const t of types.filter((x) => this.applicable(x, roles))) {
          if (month.slice(5) === '04' && t.carry_forward_cap !== null) {
            const bal = availableBalance(await this.entries(tx, u, t.id), addDaysIso(on, -1));
            const lapse = carryForwardLapse(bal, Number(t.carry_forward_cap));
            if (lapse > 0) { const k = await this.credit(tx, a, { userId: u, typeId: t.id, delta: -lapse, reason: 'lapse', refKey: `lapse:${fyStartYear(on)}`, on }); if (k) { lapsed += lapse; c = Math.max(c, k); } }
          }
          const days = accrualFor(t.accrual as Accrual, month);
          if (days > 0) { const k = await this.credit(tx, a, { userId: u, typeId: t.id, delta: days, reason: 'accrual', refKey: `accrual:${month}`, on }); if (k) { credited += days; c = Math.max(c, k); } }
        }
      }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'leave.accrued', entity: 'leave_type', diff: { month, credited, lapsed } });
      return { month, creditedDays: credited, lapsedDays: lapsed };
    });
    this.pub(a.tenantId, c);
    return res;
  }

  async apply(a: RequestActor, i: { leaveTypeId: string; from: string; to: string; startHalf?: boolean; endHalf?: boolean; reason?: string | null }) {
    requireOwn(a, 'hr');
    const id = uuidv7();
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`leave:${a.userId}`]);
      const t = (await tx.query('SELECT * FROM leave_type WHERE id = $1 AND deleted_at IS NULL AND active', [i.leaveTypeId])).rows[0];
      if (!t || !this.applicable(t, await this.roleKeys(tx, a.userId))) throw new BadRequestException({ message: 'Leave type not available to you', code: 'leave_type_not_applicable' });
      if ((i.startHalf || i.endHalf) && !t.allow_half_day) throw new BadRequestException({ message: 'Half days not allowed for this type', code: 'half_day_not_allowed' });
      const days = await this.countDays(tx, a.branchId, i);
      if (days <= 0) throw new BadRequestException({ message: 'No working days in that range', code: 'no_working_days' });
      if (t.max_days_per_request !== null && days > Number(t.max_days_per_request)) throw new BadRequestException({ message: 'Too many days for this type', code: 'over_max_days' });
      await this.noOverlap(tx, a.userId, i.from, i.to, null);
      if (t.tracked) {
        const avail = availableBalance(await this.entries(tx, a.userId, t.id), i.from) - (await this.pending(tx, a.userId, t.id));
        if (days > avail) throw new ConflictException({ message: `Only ${avail} day(s) available`, code: 'insufficient_balance' });
      }
      const ins = await tx.query(`INSERT INTO leave_request (id, tenant_id, user_id, leave_type_id, from_date, to_date, start_half, end_half, days, reason, updated_by, device_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$3,$11) RETURNING sync_cursor`, [id, a.tenantId, a.userId, t.id, i.from, i.to, !!i.startHalf, !!i.endHalf, days, i.reason ?? null, a.deviceId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'leave_request.created', entity: 'leave_request', entityId: id, diff: { ...i, days } });
      return { days, c: Number(ins.rows[0].sync_cursor) };
    });
    this.pub(a.tenantId, r.c);
    return { id, days: r.days };
  }

  private async countDays(tx: Tx, branchId: string | null, i: { from: string; to: string; startHalf?: boolean; endHalf?: boolean }) {
    if (i.to < i.from) throw new BadRequestException({ message: 'to before from', code: 'invalid_range' });
    try { return leaveDays(i, await calendarFor(tx, branchId, i.from, i.to)); } catch (e) { throw new BadRequestException({ message: (e as Error).message, code: 'invalid_range' }); }
  }
  /** Overlaps with the user's pending/approved requests are refused (serialised per user by an advisory lock). */
  private async noOverlap(tx: Tx, userId: string, from: string, to: string, except: string | null) {
    const o = (await tx.query(`SELECT id FROM leave_request WHERE user_id = $1 AND deleted_at IS NULL AND id <> COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000')
      AND ((status = 'pending' AND from_date <= $3::date AND to_date >= $2::date) OR (status IN ('approved','partially_approved') AND approved_from <= $3::date AND approved_to >= $2::date)) LIMIT 1`,
      [userId, from, to, except])).rows[0];
    if (o) throw new ConflictException({ message: 'Overlaps another leave request', code: 'leave_overlap' });
  }

  list(a: RequestActor, q: { userId?: string; status?: string; from?: string; to?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const w = ['x.deleted_at IS NULL', personScopeSql(a, 'hr', 'view', p)];
      if (q.userId) w.push(`x.user_id = ${p.add(q.userId)}::uuid`);
      if (q.status) w.push(`x.status = ${p.add(q.status)}`);
      if (q.from) w.push(`x.to_date >= ${p.add(q.from)}::date`);
      if (q.to) w.push(`x.from_date <= ${p.add(q.to)}::date`);
      return (await tx.query(`SELECT x.*, u.name AS user_name, t.key AS type_key FROM leave_request x JOIN app_user u ON u.id = x.user_id JOIN leave_type t ON t.id = x.leave_type_id
        WHERE ${w.join(' AND ')} ORDER BY x.from_date DESC LIMIT 500`, p.values)).rows.map(presentRequest);
    });
  }

  /**
   * Approve (fully, or a sub-range → partially_approved) or reject. Manager or hr:approve over the person, never self (D86).
   * The approved days are debited from the ledger in the same transaction; balance is re-checked at approval.
   */
  async decide(a: RequestActor, id: string, i: { approve: boolean; approvedFrom?: string; approvedTo?: string; startHalf?: boolean; endHalf?: boolean; note?: string | null }) {
    let c = 0;
    const out = await this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params([id]);
      const r = (await tx.query(`SELECT x.* FROM leave_request x WHERE x.id = $1 AND x.deleted_at IS NULL AND ${personScopeSql(a, 'hr', 'view', p)} FOR UPDATE`, p.values)).rows[0];
      if (!r) throw new NotFoundException();
      const person = await requireApprover(tx, a, 'hr', r.user_id);
      if (r.status !== 'pending') throw new ConflictException({ message: 'Already decided', code: 'not_pending' });
      const now = this.clock.now().toISOString();
      if (!i.approve) {
        c = (await this.sync.serverPatch(tx, a, 'leave_request', id, { status: 'rejected', decided_by: a.userId, decided_at: now, decision_note: i.note ?? null }))?.cursor ?? 0;
        await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'leave_request.rejected', entity: 'leave_request', entityId: id, diff: { note: i.note ?? null } });
        return { status: 'rejected', approvedDays: 0 };
      }
      const from = isoDay(r.from_date)!; const to = isoDay(r.to_date)!;
      const af = i.approvedFrom ?? from; const at = i.approvedTo ?? to;
      if (af < from || at > to || at < af) throw new BadRequestException({ message: 'Approved range must lie within the request', code: 'invalid_range' });
      const sh = i.startHalf ?? (af === from ? r.start_half : false); const eh = i.endHalf ?? (at === to ? r.end_half : false);
      const days = await this.countDays(tx, person.branchId, { from: af, to: at, startHalf: sh, endHalf: eh });
      if (days <= 0 || days > Number(r.days)) throw new BadRequestException({ message: 'Approved days must be between 0 and the requested days', code: 'invalid_days' });
      const t = (await tx.query('SELECT * FROM leave_type WHERE id = $1', [r.leave_type_id])).rows[0];
      if (t.tracked) {
        const avail = availableBalance(await this.entries(tx, r.user_id, t.id), af) - (await this.pending(tx, r.user_id, t.id, id));
        if (days > avail) throw new ConflictException({ message: `Only ${avail} day(s) available`, code: 'insufficient_balance' });
        c = Math.max(c, await this.credit(tx, a, { userId: r.user_id, typeId: t.id, delta: -days, reason: 'leave', refKey: `leave:${id}`, requestId: id, on: af }));
      }
      const status = days < Number(r.days) ? 'partially_approved' : 'approved';
      c = Math.max(c, (await this.sync.serverPatch(tx, a, 'leave_request', id, { status, approved_from: af, approved_to: at, approved_start_half: sh, approved_end_half: eh, approved_days: days,
        decided_by: a.userId, decided_at: now, decision_note: i.note ?? null }))?.cursor ?? 0);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: `leave_request.${status}`, entity: 'leave_request', entityId: id, diff: { approvedFrom: af, approvedTo: at, days } });
      return { status, approvedDays: days };
    });
    this.pub(a.tenantId, c);
    return out;
  }

  /** Owner cancels a pending request, or an approved one that has not started (days are credited back). */
  async cancel(a: RequestActor, id: string) {
    let c = 0;
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = (await tx.query('SELECT * FROM leave_request WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE', [id, a.userId])).rows[0];
      if (!r) throw new NotFoundException();
      const started = isoDay(r.approved_from ?? r.from_date)! <= this.clock.todayIst();
      if (r.status === 'pending' || (['approved', 'partially_approved'].includes(r.status) && !started)) {
        if (r.status !== 'pending') {
          const t = (await tx.query('SELECT tracked FROM leave_type WHERE id = $1', [r.leave_type_id])).rows[0];
          if (t.tracked) c = await this.credit(tx, a, { userId: a.userId, typeId: r.leave_type_id, delta: Number(r.approved_days), reason: 'cancel', refKey: `cancel:${id}`, requestId: id, on: this.clock.todayIst() });
        }
        c = Math.max(c, (await this.sync.serverPatch(tx, a, 'leave_request', id, { status: 'cancelled', cancelled_at: this.clock.now().toISOString() }))?.cursor ?? 0);
        await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'leave_request.cancelled', entity: 'leave_request', entityId: id, diff: { from: r.status } });
      } else throw new ConflictException({ message: 'Only pending or not-yet-started leave can be cancelled', code: 'not_cancellable' });
    });
    this.pub(a.tenantId, c);
  }

  /**
   * Comp-off auto-grant (D92): for each day in [from, to] that is a weekend/holiday for the user, approved time (net of
   * reversals) or attendance minutes — whichever is higher — earn ½ or 1 comp-off day (firm thresholds), credited once per
   * user × day (ledger ref_key `compoff:<day>`) with an expiry. Idempotent; run daily by the `hr.compoff` job for yesterday.
   */
  async runCompOff(a: RequestActor, from: string, to: string) {
    if (!a.superAdmin) requireFirmWide(a, 'hr', 'approve');
    let c = 0;
    const res = await this.db.tenantTx(a.tenantId, async (tx) => {
      const s = await loadHrSettings(tx);
      if (!s.compOff.enabled) return { granted: 0, days: 0 };
      const type = (await tx.query('SELECT id FROM leave_type WHERE key = $1 AND deleted_at IS NULL AND active', [s.compOff.typeKey])).rows[0];
      if (!type) return { granted: 0, days: 0 };
      const users = (await tx.query(`SELECT id, branch_id FROM app_user WHERE deleted_at IS NULL AND status = 'active' AND kind = 'staff' ORDER BY id`)).rows;
      const time = (await tx.query(`SELECT user_id, to_char(work_date,'YYYY-MM-DD') AS d, sum(minutes) AS m FROM time_entry WHERE status = 'approved' AND deleted_at IS NULL
        AND work_date BETWEEN $1::date AND $2::date GROUP BY 1, 2`, [from, to])).rows;
      let granted = 0; let days = 0;
      for (const u of users) {
        const cal = await calendarFor(tx, u.branch_id, from, to, s);
        for (const d of eachDay(from, to)) {
          if (isWorkingDay(d, cal)) continue;
          const tm = Number(time.find((x) => x.user_id === u.id && x.d === d)?.m ?? 0);
          const am = await AttendanceService.minutesOn(tx, u.id, d);
          const earn = compOffDays(Math.max(tm, am), s.compOff);
          if (!earn) continue;
          const k = await this.credit(tx, a, { userId: u.id, typeId: type.id, delta: earn, reason: 'comp_off', refKey: `compoff:${d}`, on: d, expiresOn: addDaysIso(d, s.compOff.expiryDays),
            note: `Worked ${Math.max(tm, am)} min on a non-working day` });
          if (k) { granted += 1; days += earn; c = Math.max(c, k); }
        }
      }
      if (granted) await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'leave.comp_off_granted', entity: 'leave_type', entityId: type.id, diff: { from, to, granted, days } });
      return { granted, days };
    });
    this.pub(a.tenantId, c);
    return res;
  }
}
