import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { addDaysIso, can, canPerson, clientCtx, istDate, mondayOf, timerMinutes } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { clientScopeSql, Params, visibilityOf } from '../clients/scope.js';
import { Clock } from '../common/clock.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { loadHrSettings, personOf, personScopeSql, requireApprover, requireOwn } from '../hr/common.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { SyncService } from '../sync/sync.service.js';
import { taskScopeSql, ymd } from '../tasks/scope.js';
import { taskForEntry } from './rules.js';

/** Highest sync cursor written in a transaction; published after commit. */
export class Cursor { v = 0; bump(c: number | null | undefined) { if (c) this.v = Math.max(this.v, Number(c)); } }

export type EntryIn = { taskId?: string | null; clientId?: string | null; workDate: string; minutes: number; billable?: boolean; notes?: string | null; submit?: boolean };
export type EntryPatch = Partial<Omit<EntryIn, 'submit'>> & { status?: 'draft' | 'submitted' };
export type EntriesQ = { userId?: string; from?: string; to?: string; status?: string; limit: number; offset: number };

export const presentEntry = (r: Record<string, unknown>) => ({
  id: r.id, userId: r.user_id, userName: r.user_name ?? null, taskId: r.task_id, taskTitle: r.task_title ?? null, clientId: r.client_id, clientName: r.client_name ?? null,
  workDate: ymd(r.work_date), minutes: r.minutes, billable: r.billable, notes: r.notes, source: r.source, status: r.status, startedAt: r.started_at ?? null, endedAt: r.ended_at ?? null,
  capped: r.capped, reversesId: r.reverses_id ?? null, submittedAt: r.submitted_at ?? null, decidedBy: r.decided_by ?? null, decidedAt: r.decided_at ?? null,
  decisionNote: r.decision_note ?? null, version: r.version,
});

/** Time entries (M10): own drafts, weekly submit, manager/approver decisions, reversals, timers, live activity. */
@Injectable()
export class TimeService {
  constructor(private db: DbService, private sync: SyncService, private audit: AuditService, private realtime: RealtimeService, private clock: Clock) {}

  publish(tenantId: string, c: Cursor) { if (c.v) this.realtime.publish({ type: 'changed', tenantId, cursor: c.v }); }

  /** Display columns (client/task names only when the viewer may see them) over entry alias `x`. */
  namesSql(a: RequestActor, p: Params) {
    return `u.name AS user_name, CASE WHEN c.id IS NOT NULL AND ${clientScopeSql(a, 'clients', 'view', p, 'c')} THEN c.name END AS client_name,
      CASE WHEN t.id IS NOT NULL AND ${taskScopeSql(a, 'view', p, 't', 'tc')} THEN t.title END AS task_title`;
  }
  readonly joins = `JOIN app_user u ON u.id = x.user_id LEFT JOIN client c ON c.id = x.client_id LEFT JOIN task t ON t.id = x.task_id LEFT JOIN client tc ON tc.id = t.client_id`;
  /** Entries the actor may see: own, or the person is in scope AND the client (if any) is visible (D84). */
  visibleSql(a: RequestActor, p: Params, action: 'view' | 'approve' = 'view') {
    return `(${personScopeSql(a, 'time', action, p)} AND (x.user_id = ${p.add(a.userId)}::uuid OR x.client_id IS NULL
      OR EXISTS (SELECT 1 FROM client vc WHERE vc.id = x.client_id AND vc.deleted_at IS NULL AND ${clientScopeSql(a, 'clients', 'view', p, 'vc')})))`;
  }

  list(a: RequestActor, q: EntriesQ) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const where = ['x.deleted_at IS NULL', this.visibleSql(a, p)];
      if (q.userId) where.push(`x.user_id = ${p.add(q.userId)}::uuid`);
      if (q.from) where.push(`x.work_date >= ${p.add(q.from)}::date`);
      if (q.to) where.push(`x.work_date <= ${p.add(q.to)}::date`);
      if (q.status) where.push(`x.status = ${p.add(q.status)}`);
      const rows = (await tx.query(`SELECT x.*, ${this.namesSql(a, p)}, count(*) OVER () AS total_count FROM time_entry x ${this.joins}
        WHERE ${where.join(' AND ')} ORDER BY x.work_date DESC, x.created_at DESC LIMIT ${p.add(q.limit)} OFFSET ${p.add(q.offset)}`, p.values)).rows;
      return { total: Number(rows[0]?.total_count ?? 0), totalMinutes: rows.reduce((s, r) => s + Number(r.minutes), 0), items: rows.map(presentEntry) };
    });
  }

  /** Entry row visible to the actor (404 otherwise). */
  private async load(tx: Tx, a: RequestActor, id: string, lock = false) {
    const p = new Params([id]);
    const r = (await tx.query(`SELECT x.*, ${this.namesSql(a, p)} FROM time_entry x ${this.joins} WHERE x.id = $1 AND x.deleted_at IS NULL AND ${this.visibleSql(a, p)}`, p.values)).rows[0];
    if (!r) throw new NotFoundException();
    if (lock) await tx.query('SELECT 1 FROM time_entry WHERE id = $1 FOR UPDATE', [id]);
    return r as Record<string, unknown>;
  }

  get(a: RequestActor, id: string) { return this.db.tenantTx(a.tenantId, async (tx) => presentEntry(await this.load(tx, a, id))); }

  private notFuture(day: string) {
    if (day > this.clock.todayIst()) throw new BadRequestException({ message: 'Time cannot be logged for a future date', code: 'future_date' });
  }

  async create(a: RequestActor, i: EntryIn) {
    requireOwn(a, 'time');
    this.notFuture(i.workDate);
    const id = uuidv7(); const cur = new Cursor();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      let clientId = i.clientId ?? null;
      if (i.taskId) {
        const t = await taskForEntry(a, tx, i.taskId);
        if (!t) throw new BadRequestException({ message: 'Task not found', code: 'invalid:task_id' });
        if (i.clientId !== undefined && i.clientId !== null && i.clientId !== t.client_id) throw new BadRequestException({ message: 'Client does not match the task', code: 'client_mismatch' });
        clientId = (t.client_id as string | null) ?? null;
      }
      const r = await this.sync.applyInTx(tx, a, { table: 'time_entry', id, baseVersion: 0, patch: {
        task_id: i.taskId ?? null, client_id: clientId, work_date: i.workDate, minutes: i.minutes, billable: i.billable ?? true, notes: i.notes ?? null, status: i.submit ? 'submitted' : 'draft' } });
      cur.bump(r.cursor);
    });
    this.publish(a.tenantId, cur);
    return { id };
  }

  async update(a: RequestActor, id: string, i: EntryPatch) {
    const cur = new Cursor();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const e = await this.load(tx, a, id, true);
      if (e.user_id !== a.userId) throw new ForbiddenException({ message: 'Only the owner edits an entry', code: 'not_owner' });
      if (e.status === 'approved') throw new ConflictException({ message: 'Approved entries are immutable; reverse and re-enter', code: 'immutable' });
      if (i.workDate) this.notFuture(i.workDate);
      const patch: Record<string, unknown> = {};
      if (i.taskId !== undefined) {
        patch.task_id = i.taskId;
        const t = i.taskId ? await taskForEntry(a, tx, i.taskId) : undefined;
        if (i.taskId && !t) throw new BadRequestException({ message: 'Task not found', code: 'invalid:task_id' });
        patch.client_id = t ? t.client_id ?? null : i.clientId ?? null;
      } else if (i.clientId !== undefined) patch.client_id = i.clientId;
      if (i.workDate !== undefined) patch.work_date = i.workDate;
      if (i.minutes !== undefined) patch.minutes = i.minutes;
      if (i.billable !== undefined) patch.billable = i.billable;
      if (i.notes !== undefined) patch.notes = i.notes;
      if (i.status !== undefined) patch.status = i.status;
      cur.bump((await this.sync.applyInTx(tx, a, { table: 'time_entry', id, baseVersion: e.version as number, patch })).cursor);
    });
    this.publish(a.tenantId, cur);
  }

  async remove(a: RequestActor, id: string) {
    const cur = new Cursor();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const e = await this.load(tx, a, id, true);
      if (e.user_id !== a.userId || !['draft', 'rejected'].includes(e.status as string)) throw new ConflictException({ message: 'Only your own draft or rejected entries can be deleted', code: 'not_deletable' });
      cur.bump((await this.sync.applyInTx(tx, a, { table: 'time_entry', id, baseVersion: e.version as number, patch: {}, delete: true })).cursor);
    });
    this.publish(a.tenantId, cur);
  }

  /** Submits the caller's drafts (and rejected entries) of the ISO week starting `weekStart` (any day → its Monday). */
  async submitWeek(a: RequestActor, weekStart: string) {
    requireOwn(a, 'time');
    const from = mondayOf(weekStart); const to = addDaysIso(from, 6);
    const cur = new Cursor();
    const n = await this.db.tenantTx(a.tenantId, async (tx) => {
      const ids = (await tx.query(`SELECT id FROM time_entry WHERE user_id = $1 AND deleted_at IS NULL AND status IN ('draft','rejected') AND work_date BETWEEN $2::date AND $3::date ORDER BY id FOR UPDATE`,
        [a.userId, from, to])).rows.map((r) => r.id as string);
      const now = this.clock.now().toISOString();
      for (const id of ids) cur.bump((await this.sync.serverPatch(tx, a, 'time_entry', id, { status: 'submitted', submitted_at: now, decided_by: null, decided_at: null, decision_note: null }))?.cursor);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'timesheet.submitted', entity: 'time_entry', diff: { from, to, entries: ids.length } });
      return ids.length;
    });
    this.publish(a.tenantId, cur);
    return { weekStart: from, weekEnd: to, submitted: n };
  }

  /**
   * Approve/reject submitted entries. Approver = the person's manager or time:approve over them; never one's own (D86).
   * Each entry is decided independently; failures are reported, not thrown.
   */
  async decide(a: RequestActor, i: { ids: string[]; approve: boolean; note?: string | null }) {
    const cur = new Cursor();
    const results = await this.db.tenantTx(a.tenantId, async (tx) => {
      const out: Array<{ id: string; status: string; reason?: string }> = [];
      for (const id of [...new Set(i.ids)]) {
        const p = new Params([id]);
        const e = (await tx.query(`SELECT x.* FROM time_entry x WHERE x.id = $1 AND x.deleted_at IS NULL AND ${this.visibleSql(a, p)} FOR UPDATE`, p.values)).rows[0];
        if (!e) { out.push({ id, status: 'skipped', reason: 'not_found' }); continue; }
        if (e.status !== 'submitted') { out.push({ id, status: 'skipped', reason: `not_submitted:${e.status}` }); continue; }
        try { await requireApprover(tx, a, 'time', e.user_id); } catch (err) {
          out.push({ id, status: 'skipped', reason: (err as { response?: { code?: string } }).response?.code ?? 'forbidden' }); continue;
        }
        cur.bump((await this.sync.serverPatch(tx, a, 'time_entry', id, { status: i.approve ? 'approved' : 'rejected', decided_by: a.userId, decided_at: this.clock.now().toISOString(), decision_note: i.note ?? null }))?.cursor);
        await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: i.approve ? 'time_entry.approved' : 'time_entry.rejected', entity: 'time_entry', entityId: id, diff: { note: i.note ?? null } });
        out.push({ id, status: i.approve ? 'approved' : 'rejected' });
      }
      return out;
    });
    this.publish(a.tenantId, cur);
    return { results, approved: results.filter((r) => r.status === 'approved').length, rejected: results.filter((r) => r.status === 'rejected').length };
  }

  /** Correction of an approved entry: an approved reversal (negative minutes, once per entry) by an approver (D84). */
  async reverse(a: RequestActor, id: string, note: string) {
    const cur = new Cursor(); const rid = uuidv7();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const e = await this.load(tx, a, id, true);
      if (e.status !== 'approved' || e.reverses_id) throw new ConflictException({ message: 'Only approved original entries can be reversed', code: 'not_reversible' });
      await requireApprover(tx, a, 'time', e.user_id as string);
      try {
        await tx.query('SAVEPOINT rev');
        const r = await tx.query(`INSERT INTO time_entry (id, tenant_id, user_id, task_id, client_id, work_date, minutes, billable, notes, source, status, reverses_id, decided_by, decided_at, decision_note, updated_by, device_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'reversal','approved',$10,$11,$12,$13,$11,$14) RETURNING sync_cursor`,
          [rid, a.tenantId, e.user_id, e.task_id, e.client_id, ymd(e.work_date), -(e.minutes as number), e.billable, `Reversal: ${note}`, id, a.userId, this.clock.now().toISOString(), note, a.deviceId]);
        cur.bump(r.rows[0].sync_cursor);
      } catch (err) {
        await tx.query('ROLLBACK TO SAVEPOINT rev');
        if ((err as { code?: string }).code === '23505') throw new ConflictException({ message: 'Already reversed', code: 'already_reversed' });
        throw err;
      }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'time_entry.reversed', entity: 'time_entry', entityId: id, diff: { reversalId: rid, note } });
    });
    this.publish(a.tenantId, cur);
    return { id: rid };
  }

  // ---------- Timer ----------

  private presentTimer = (r: Record<string, unknown> | undefined) => (r ? { id: r.id, taskId: r.task_id, clientId: r.client_id, notes: r.notes, billable: r.billable, startedAt: r.started_at, deviceStartedAt: r.device_started_at ?? null } : null);

  timer(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => this.presentTimer((await tx.query('SELECT * FROM time_timer WHERE user_id = $1 AND stopped_at IS NULL AND deleted_at IS NULL', [a.userId])).rows[0]));
  }

  /** One running timer per user (unique partial index → 409). Server time is authoritative; the device time is kept for reference. */
  async start(a: RequestActor, i: { taskId?: string | null; clientId?: string | null; notes?: string | null; billable?: boolean; deviceAt?: string | null }) {
    requireOwn(a, 'time');
    const id = uuidv7(); const cur = new Cursor();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      let clientId = i.clientId ?? null;
      if (i.taskId) {
        const t = await taskForEntry(a, tx, i.taskId);
        if (!t) throw new BadRequestException({ message: 'Task not found', code: 'invalid:task_id' });
        clientId = (t.client_id as string | null) ?? null;
      } else if (clientId) {
        const c = (await tx.query('SELECT * FROM client WHERE id = $1 AND deleted_at IS NULL', [clientId])).rows[0];
        if (!c || !can(a, 'clients', 'view', clientCtx(visibilityOf(c)))) throw new BadRequestException({ message: 'Client not found', code: 'invalid:client_id' });
      }
      try {
        await tx.query('SAVEPOINT t');
        const r = await tx.query(`INSERT INTO time_timer (id, tenant_id, user_id, task_id, client_id, notes, billable, started_at, device_started_at, updated_by, device_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$3,$10) RETURNING sync_cursor`,
          [id, a.tenantId, a.userId, i.taskId ?? null, clientId, i.notes ?? null, i.billable ?? true, this.clock.now().toISOString(), i.deviceAt ?? null, a.deviceId]);
        cur.bump(r.rows[0].sync_cursor);
      } catch (e) {
        await tx.query('ROLLBACK TO SAVEPOINT t');
        if ((e as { code?: string }).code === '23505') throw new ConflictException({ message: 'A timer is already running', code: 'timer_running' });
        throw e;
      }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'timer.started', entity: 'time_timer', entityId: id, diff: { taskId: i.taskId ?? null, clientId } });
    });
    this.publish(a.tenantId, cur);
    return { id };
  }

  /**
   * Stops the caller's timer: minutes from server timestamps, capped (firm setting, flagged `capped`); creates a draft entry
   * dated the IST day the timer started. The timer row is tombstoned so devices drop it.
   */
  async stop(a: RequestActor, i: { notes?: string | null } = {}) {
    const cur = new Cursor();
    const out = await this.db.tenantTx(a.tenantId, async (tx) => {
      const t = (await tx.query('SELECT * FROM time_timer WHERE user_id = $1 AND stopped_at IS NULL AND deleted_at IS NULL FOR UPDATE', [a.userId])).rows[0];
      if (!t) throw new NotFoundException({ message: 'No running timer', code: 'no_timer' });
      const s = await loadHrSettings(tx);
      const now = this.clock.now();
      const m = timerMinutes(new Date(t.started_at), now, s.timer.capMinutes);
      // Never more than 24 h in a day: clamp to what's left (flagged `capped`); a full day stops the timer without an entry.
      const day = istDate(new Date(t.started_at));
      const used = Number((await tx.query(`SELECT COALESCE(sum(minutes),0) AS m FROM time_entry WHERE user_id = $1 AND work_date = $2::date AND deleted_at IS NULL AND minutes > 0`, [a.userId, day])).rows[0].m);
      const minutes = Math.min(m.minutes, 1440 - used);
      const capped = m.capped || minutes < m.minutes;
      let entryId: string | null = null;
      if (minutes >= 1) {
        entryId = uuidv7();
        const ended = new Date(new Date(t.started_at).getTime() + minutes * 60_000);
        const r = await tx.query(`INSERT INTO time_entry (id, tenant_id, user_id, task_id, client_id, work_date, minutes, billable, notes, source, status, started_at, ended_at, capped, updated_by, device_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'timer','draft',$10,$11,$12,$3,$13) RETURNING sync_cursor`,
          [entryId, a.tenantId, a.userId, t.task_id, t.client_id, day, minutes, t.billable, i.notes ?? t.notes, t.started_at, (ended < now ? ended : now).toISOString(), capped, a.deviceId]);
        cur.bump(r.rows[0].sync_cursor);
      }
      cur.bump(Number((await tx.query('UPDATE time_timer SET stopped_at = $2, entry_id = $3, deleted_at = $2, updated_by = $4 WHERE id = $1 RETURNING sync_cursor', [t.id, now.toISOString(), entryId, a.userId])).rows[0].sync_cursor));
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'timer.stopped', entity: 'time_timer', entityId: t.id, diff: { entryId, minutes: Math.max(0, minutes), capped } });
      return { entryId, minutes: Math.max(0, minutes), capped, dayFull: !entryId };
    });
    this.publish(a.tenantId, cur);
    return out;
  }

  /**
   * Who has a running timer and on what. Everyone with time:view sees that colleagues are busy; the task/client is named
   * only when the viewer may see it, else the label is "Busy" (D84).
   */
  live(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const rows = (await tx.query(`SELECT x.*, ${this.namesSql(a, p)} FROM time_timer x ${this.joins} WHERE x.stopped_at IS NULL AND x.deleted_at IS NULL ORDER BY x.started_at`, p.values)).rows;
      const now = this.clock.now().getTime();
      const items = [];
      for (const r of rows) {
        const person = await personOf(tx, r.user_id);
        const seesPerson = !!person && canPerson(a, 'time', 'view', person);
        const task = r.task_title ? { id: r.task_id, title: r.task_title } : null;
        const client = r.client_name ? { id: r.client_id, name: r.client_name } : null;
        items.push({ userId: r.user_id, userName: r.user_name, startedAt: r.started_at, minutes: Math.max(0, Math.floor((now - new Date(r.started_at).getTime()) / 60_000)),
          task, client, label: task?.title ?? client?.name ?? (r.task_id || r.client_id ? 'Busy' : seesPerson ? (r.notes ?? 'Internal') : 'Busy'), inScope: seesPerson });
      }
      return { asOf: new Date(now).toISOString(), items };
    });
  }

}
