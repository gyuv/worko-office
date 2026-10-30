import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { addDaysIso, isWorkingDay, roundCoord } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { Params } from '../clients/scope.js';
import { Clock } from '../common/clock.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { SyncService } from '../sync/sync.service.js';
import { calendarFor, checkOutFields, evaluateCheckIn, isoDay, loadHrSettings, personScopeSql, requireApprover, requireOwn } from './common.js';

export const presentAttendance = (r: Record<string, unknown>) => ({
  id: r.id, userId: r.user_id, userName: r.user_name ?? null, date: isoDay(r.work_date), checkInAt: r.check_in_at, checkOutAt: r.check_out_at ?? null,
  deviceCheckInAt: r.device_check_in_at ?? null, deviceCheckOutAt: r.device_check_out_at ?? null, inFence: r.in_fence, distanceM: r.distance_m ?? null, locationId: r.location_id ?? null,
  ipOk: r.ip_ok, method: r.method, flags: r.flags, status: r.status, minutes: r.minutes ?? null, notes: r.notes ?? null, version: r.version,
});
const presentReg = (r: Record<string, unknown>) => ({
  id: r.id, userId: r.user_id, userName: r.user_name ?? null, date: isoDay(r.work_date), checkInAt: r.check_in_at, checkOutAt: r.check_out_at ?? null, reason: r.reason,
  status: r.status, decidedBy: r.decided_by ?? null, decidedAt: r.decided_at ?? null, decisionNote: r.decision_note ?? null, attendanceId: r.attendance_id ?? null,
});
/** IST wall time on a date → instant. */
const istAt = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`);

/** Attendance (M14): geofence/IP check-in, check-out, approvals of out-of-policy days, regularisation, monthly report. */
@Injectable()
export class AttendanceService {
  constructor(private db: DbService, private sync: SyncService, private audit: AuditService, private realtime: RealtimeService, private clock: Clock) {}

  private pub(tenantId: string, c: unknown) { if (c) this.realtime.publish({ type: 'changed', tenantId, cursor: Number(c) }); }

  /** Check-in: server time authoritative, request IP checked against the allow-list (D88), raw coordinates never logged. */
  async checkIn(a: RequestActor, i: { lat?: number | null; lng?: number | null; deviceAt?: string | null; notes?: string | null }, ip: string | null) {
    requireOwn(a, 'hr');
    if ((i.lat == null) !== (i.lng == null)) throw new BadRequestException({ message: 'lat and lng go together', code: 'invalid_location' });
    const id = uuidv7();
    const { c, ev } = await this.db.tenantTx(a.tenantId, async (tx) => {
      const ev = await evaluateCheckIn(tx, { lat: i.lat, lng: i.lng, deviceAt: i.deviceAt ? new Date(i.deviceAt) : null, ip, serverAt: this.clock.now(), branchId: a.branchId, method: 'online' });
      if ('reject' in ev) throw new BadRequestException({ message: 'Check-in time rejected', code: ev.reject });
      let r;
      try {
        await tx.query('SAVEPOINT a');
        r = await tx.query(`INSERT INTO attendance (id, tenant_id, user_id, work_date, check_in_at, received_at, device_check_in_at, in_lat, in_lng, location_id, distance_m, in_fence, ip_ok, method, flags, status, notes, updated_by, device_id)
          VALUES ($1,$2,$3,$4,$5,$18,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$3,$17) RETURNING sync_cursor`,
          [id, a.tenantId, a.userId, ev.work_date, ev.check_in_at, ev.device_check_in_at, ev.in_lat, ev.in_lng, ev.location_id, ev.distance_m, ev.in_fence, ev.ip_ok, ev.method, ev.flags, ev.status, i.notes ?? null, a.deviceId, ev.received_at]);
      } catch (e) {
        await tx.query('ROLLBACK TO SAVEPOINT a');
        if ((e as { code?: string }).code === '23505') throw new ConflictException({ message: 'Already checked in today', code: 'already_checked_in' });
        throw e;
      }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'attendance.check_in', entity: 'attendance', entityId: id,
        diff: { date: ev.work_date, status: ev.status, flags: ev.flags, inFence: ev.in_fence, distanceM: ev.distance_m, ipOk: ev.ip_ok } });
      return { c: r.rows[0].sync_cursor, ev };
    });
    this.pub(a.tenantId, c);
    return { id, date: ev.work_date, status: ev.status, flags: ev.flags, inFence: ev.in_fence, distanceM: ev.distance_m, ipOk: ev.ip_ok };
  }

  async checkOut(a: RequestActor, i: { lat?: number | null; lng?: number | null; deviceAt?: string | null }) {
    requireOwn(a, 'hr');
    const out = await this.db.tenantTx(a.tenantId, async (tx) => {
      // Only today's open row, or one checked in within the attendance cap — a forgotten check-out never closes days later (D96).
      const now = this.clock.now();
      const st = await loadHrSettings(tx);
      const r = (await tx.query(`SELECT * FROM attendance WHERE user_id = $1 AND deleted_at IS NULL AND check_out_at IS NULL
        AND (work_date = $2::date OR check_in_at >= $3::timestamptz) ORDER BY work_date DESC LIMIT 1 FOR UPDATE`,
        [a.userId, this.clock.todayIst(), new Date(now.getTime() - st.attendance.maxMinutes * 60_000).toISOString()])).rows[0];
      if (!r) throw new NotFoundException({ message: 'Not checked in', code: 'not_checked_in' });
      const f = await checkOutFields(tx, r, now, now);
      const minutes = f.minutes;
      const res = await this.sync.serverPatch(tx, a, 'attendance', r.id, { ...f, device_check_out_at: i.deviceAt ?? null,
        out_lat: i.lat == null ? null : roundCoord(i.lat), out_lng: i.lng == null ? null : roundCoord(i.lng) });
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'attendance.check_out', entity: 'attendance', entityId: r.id, diff: { minutes } });
      return { id: r.id as string, minutes, c: res?.cursor };
    });
    this.pub(a.tenantId, out.c);
    return { id: out.id, minutes: out.minutes };
  }

  list(a: RequestActor, q: { userId?: string; from?: string; to?: string; status?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const w = ['x.deleted_at IS NULL', personScopeSql(a, 'hr', 'view', p)];
      if (q.userId) w.push(`x.user_id = ${p.add(q.userId)}::uuid`);
      if (q.from) w.push(`x.work_date >= ${p.add(q.from)}::date`);
      if (q.to) w.push(`x.work_date <= ${p.add(q.to)}::date`);
      if (q.status) w.push(`x.status = ${p.add(q.status)}`);
      return (await tx.query(`SELECT x.*, u.name AS user_name FROM attendance x JOIN app_user u ON u.id = x.user_id WHERE ${w.join(' AND ')} ORDER BY x.work_date DESC, lower(u.name) LIMIT 1000`, p.values)).rows.map(presentAttendance);
    });
  }

  /** Approve/reject an out-of-policy (flagged / needs-approval) day: manager or hr:approve, never self. */
  async decide(a: RequestActor, id: string, i: { approve: boolean; note?: string | null }) {
    const c = await this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params([id]);
      const r = (await tx.query(`SELECT x.* FROM attendance x WHERE x.id = $1 AND x.deleted_at IS NULL AND ${personScopeSql(a, 'hr', 'view', p)} FOR UPDATE`, p.values)).rows[0];
      if (!r) throw new NotFoundException();
      await requireApprover(tx, a, 'hr', r.user_id);
      if (!['flagged', 'needs_approval'].includes(r.status)) throw new ConflictException({ message: 'Nothing to decide', code: 'not_pending' });
      const res = await this.sync.serverPatch(tx, a, 'attendance', id, { status: i.approve ? 'approved' : 'rejected', decided_by: a.userId, decided_at: this.clock.now().toISOString(), notes: i.note ?? r.notes });
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: i.approve ? 'attendance.approved' : 'attendance.rejected', entity: 'attendance', entityId: id, diff: { note: i.note ?? null } });
      return res?.cursor;
    });
    this.pub(a.tenantId, c);
  }

  // ---------- Regularisation ----------

  async requestRegularisation(a: RequestActor, i: { date: string; checkIn: string; checkOut?: string | null; reason: string }) {
    requireOwn(a, 'hr');
    if (i.date > this.clock.todayIst()) throw new BadRequestException({ message: 'Cannot regularise a future day', code: 'future_date' });
    const inAt = istAt(i.date, i.checkIn); const outAt = i.checkOut ? istAt(i.date, i.checkOut) : null;
    if (outAt && outAt < inAt) throw new BadRequestException({ message: 'Check-out before check-in', code: 'invalid_times' });
    const id = uuidv7();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      try {
        await tx.query('SAVEPOINT r');
        await tx.query(`INSERT INTO attendance_regularisation (id, tenant_id, user_id, work_date, check_in_at, check_out_at, reason, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$3)`,
          [id, a.tenantId, a.userId, i.date, inAt.toISOString(), outAt?.toISOString() ?? null, i.reason]);
      } catch (e) {
        await tx.query('ROLLBACK TO SAVEPOINT r');
        if ((e as { code?: string }).code === '23505') throw new ConflictException({ message: 'A request for that day is pending', code: 'regularisation_pending' });
        throw e;
      }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'attendance_regularisation.requested', entity: 'attendance_regularisation', entityId: id, diff: i });
    });
    return { id };
  }

  regularisations(a: RequestActor, q: { status?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const w = ['x.deleted_at IS NULL', personScopeSql(a, 'hr', 'view', p)];
      if (q.status) w.push(`x.status = ${p.add(q.status)}`);
      return (await tx.query(`SELECT x.*, u.name AS user_name FROM attendance_regularisation x JOIN app_user u ON u.id = x.user_id WHERE ${w.join(' AND ')} ORDER BY x.work_date DESC LIMIT 500`, p.values)).rows.map(presentReg);
    });
  }

  /** Approval writes the requested times into that day's attendance (method `regularised`, status `approved`). */
  async decideRegularisation(a: RequestActor, id: string, i: { approve: boolean; note?: string | null }) {
    const c = await this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params([id]);
      const r = (await tx.query(`SELECT x.* FROM attendance_regularisation x WHERE x.id = $1 AND x.deleted_at IS NULL AND ${personScopeSql(a, 'hr', 'view', p)} FOR UPDATE`, p.values)).rows[0];
      if (!r) throw new NotFoundException();
      await requireApprover(tx, a, 'hr', r.user_id);
      if (r.status !== 'pending') throw new ConflictException({ message: 'Already decided', code: 'not_pending' });
      let attId: string | null = null; let cursor: number | undefined;
      if (i.approve) {
        const day = isoDay(r.work_date)!;
        const minutes = r.check_out_at ? Math.round((new Date(r.check_out_at).getTime() - new Date(r.check_in_at).getTime()) / 60_000) : null;
        const ex = (await tx.query('SELECT id, status, decided_by, check_in_at, check_out_at FROM attendance WHERE user_id = $1 AND work_date = $2::date AND deleted_at IS NULL FOR UPDATE', [r.user_id, day])).rows[0];
        const now = this.clock.now().toISOString();
        if (ex && (ex.decided_by || ['approved', 'rejected'].includes(ex.status))) {
          throw new ConflictException({ message: 'That day was already decided; reject this request or revise the day explicitly', code: 'day_decided' });
        }
        if (ex) {
          attId = ex.id;
          // Explicitly recorded: the times this approval replaces.
          await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'attendance.regularised', entity: 'attendance', entityId: ex.id,
            diff: { replacedCheckInAt: ex.check_in_at, replacedCheckOutAt: ex.check_out_at, regularisationId: id } });
          cursor = (await this.sync.serverPatch(tx, a, 'attendance', ex.id, { check_in_at: r.check_in_at, check_out_at: r.check_out_at, minutes, method: 'regularised', status: 'approved', decided_by: a.userId, decided_at: now }))?.cursor;
        } else {
          attId = uuidv7();
          cursor = Number((await tx.query(`INSERT INTO attendance (id, tenant_id, user_id, work_date, check_in_at, check_out_at, minutes, method, status, decided_by, decided_at, updated_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'regularised','approved',$8,$9,$8) RETURNING sync_cursor`, [attId, a.tenantId, r.user_id, day, r.check_in_at, r.check_out_at, minutes, a.userId, now])).rows[0].sync_cursor);
        }
      }
      await tx.query(`UPDATE attendance_regularisation SET status = $2, decided_by = $3, decided_at = $4, decision_note = $5, attendance_id = $6, updated_by = $3 WHERE id = $1`,
        [id, i.approve ? 'approved' : 'rejected', a.userId, this.clock.now().toISOString(), i.note ?? null, attId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: i.approve ? 'attendance_regularisation.approved' : 'attendance_regularisation.rejected', entity: 'attendance_regularisation', entityId: id, diff: { attendanceId: attId } });
      return cursor;
    });
    this.pub(a.tenantId, c);
  }

  /** Monthly attendance per visible user: working days, present, flagged/pending, leave, holidays, absent, minutes. */
  report(a: RequestActor, month: string) {
    return this.db.tenantTx(a.tenantId, (tx) => this.reportTx(tx, a, month));
  }
  /** Same, on the caller's transaction (report engine: one READ ONLY connection + statement timeout). */
  async reportTx(tx: Tx, a: RequestActor, month: string) {
    {
      const from = `${month}-01`;
      const [y, m] = month.split('-').map(Number) as [number, number];
      const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      const s = await loadHrSettings(tx);
      const p = new Params();
      const users = (await tx.query(`SELECT u.id, u.name, u.branch_id FROM app_user u WHERE u.deleted_at IS NULL AND u.status = 'active' AND u.kind = 'staff' AND ${personScopeSql(a, 'hr', 'view', p, 'u.id')} ORDER BY lower(u.name)`, p.values)).rows;
      const out = [];
      for (const u of users) {
        const cal = await calendarFor(tx, u.branch_id, from, to, s);
        const att = (await tx.query(`SELECT to_char(work_date,'YYYY-MM-DD') AS d, status, minutes FROM attendance WHERE user_id = $1 AND deleted_at IS NULL AND work_date BETWEEN $2::date AND $3::date`, [u.id, from, to])).rows;
        const lv = (await tx.query(`SELECT to_char(approved_from,'YYYY-MM-DD') AS f, to_char(approved_to,'YYYY-MM-DD') AS t, approved_start_half AS sh, approved_end_half AS eh FROM leave_request
          WHERE user_id = $1 AND status IN ('approved','partially_approved') AND deleted_at IS NULL AND approved_from <= $3::date AND approved_to >= $2::date`, [u.id, from, to])).rows;
        const leaveOn = new Map<string, number>();
        for (const l of lv) for (let d = l.f as string; d <= l.t; d = addDaysIso(d, 1)) if (d >= from && d <= to && isWorkingDay(d, cal)) leaveOn.set(d, (d === l.f && l.sh) || (d === l.t && l.eh) ? 0.5 : 1);
        const present = new Set(att.filter((x) => x.status !== 'rejected').map((x) => x.d as string));
        let working = 0; let absent = 0;
        for (let d = from; d <= to; d = addDaysIso(d, 1)) {
          if (!isWorkingDay(d, cal)) continue;
          working += 1;
          if (!present.has(d)) absent += Math.max(0, 1 - (leaveOn.get(d) ?? 0));
        }
        out.push({ userId: u.id, name: u.name, workingDays: working, holidays: [...cal.holidays].length, presentDays: present.size,
          flaggedDays: att.filter((x) => x.status === 'flagged').length, pendingApproval: att.filter((x) => x.status === 'needs_approval').length,
          leaveDays: [...leaveOn.values()].reduce((s2, x) => s2 + x, 0), absentDays: absent, minutes: att.reduce((s2, x) => s2 + Number(x.minutes ?? 0), 0) });
      }
      return { month, from, to, users: out };
    }
  }

  /** Used by leave/comp-off: attendance minutes of a user on a day. */
  static async minutesOn(tx: Tx, userId: string, day: string) {
    return Number((await tx.query(`SELECT COALESCE(sum(minutes),0) AS m FROM attendance WHERE user_id = $1 AND work_date = $2::date AND deleted_at IS NULL AND status IN ('ok','approved')`, [userId, day])).rows[0].m);
  }
}
