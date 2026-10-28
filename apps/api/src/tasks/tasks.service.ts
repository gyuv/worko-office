import { BadRequestException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { closeError, taskChangeError, type TaskCheck, type TaskOutcome } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { Params } from '../clients/scope.js';
import { todayIst } from '../compliance/facts.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { SyncService } from '../sync/sync.service.js';
import { actorChangeError, canTaskRow, checkPeopleAndRevoke, stateOf, taskScopeSql, ymd } from './scope.js';

export type TaskListQ = {
  status?: string[]; assigneeId?: string; clientId?: string; serviceTypeId?: string; dueFrom?: string; dueTo?: string; overdue?: boolean;
  asOf?: string; closed?: boolean; q?: string; firm?: boolean; limit: number; offset: number; dateField?: 'statutory_due' | 'act_by';
};
export type BulkPatch = Partial<{ status: string; assignee_id: string | null; reviewer_id: string | null; act_by: string | null; priority: string }>;
const UNDO_MINUTES = 10;

export function presentTask(r: Record<string, unknown>) {
  return {
    id: r.id, clientId: r.client_id, clientName: r.client_name ?? null, serviceTypeId: r.service_type_id, serviceName: r.service_name ?? null,
    periodKey: r.period_key, periodLabel: r.period_label, title: r.title, description: r.description, status: r.status, priority: r.priority,
    statutoryDue: ymd(r.statutory_due), actBy: ymd(r.act_by), leaderId: r.leader_id, managerId: r.manager_id, assigneeId: r.assignee_id, reviewerId: r.reviewer_id,
    checks: r.checks, pendingIssue: r.pending_issue, outcome: r.outcome, outcomeNote: r.outcome_note, closedAt: r.closed_at, completedAt: r.completed_at,
    source: r.source, estimateMinutes: r.estimate_minutes ?? null, ruleId: r.rule_id, extensionId: r.extension_id, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

@Injectable()
export class TasksService {
  constructor(private db: DbService, private sync: SyncService, private realtime: RealtimeService, private audit: AuditService) {}

  private publish(a: RequestActor, cursor: number | undefined) { if (cursor) this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor }); }

  list(a: RequestActor, q: TaskListQ) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const where = ['t.deleted_at IS NULL', '(t.client_id IS NULL OR c.deleted_at IS NULL)', taskScopeSql(a, 'view', p, 't', 'c')];
      const df = q.dateField ?? 'statutory_due';
      if (q.status?.length) where.push(`t.status = ANY(${p.add(q.status)}::text[])`);
      if (q.assigneeId) where.push(`t.assignee_id = ${p.add(q.assigneeId === 'me' ? a.userId : q.assigneeId)}::uuid`);
      if (q.clientId) where.push(`t.client_id = ${p.add(q.clientId)}::uuid`);
      if (q.firm) where.push('t.client_id IS NULL');
      if (q.serviceTypeId) where.push(`t.service_type_id = ${p.add(q.serviceTypeId)}::uuid`);
      if (q.dueFrom) where.push(`t.${df} >= ${p.add(q.dueFrom)}::date`);
      if (q.dueTo) where.push(`t.${df} <= ${p.add(q.dueTo)}::date`);
      if (q.overdue) where.push(`t.statutory_due < ${p.add(q.asOf ?? todayIst())}::date AND t.status NOT IN ('done','cancelled') AND t.outcome IS NULL`);
      if (q.closed !== undefined) where.push(q.closed ? 't.outcome IS NOT NULL' : 't.outcome IS NULL');
      if (q.q) { const term = p.add(q.q); where.push(`(t.title ILIKE '%' || ${term} || '%' OR c.name ILIKE '%' || ${term} || '%')`); }
      const rows = (await tx.query(
        `SELECT t.*, c.name AS client_name, s.name AS service_name, count(*) OVER () AS total
         FROM task t LEFT JOIN client c ON c.id = t.client_id LEFT JOIN service_type s ON s.id = t.service_type_id
         WHERE ${where.join(' AND ')} ORDER BY t.${df} NULLS LAST, t.priority DESC, t.id LIMIT ${p.add(q.limit)} OFFSET ${p.add(q.offset)}`, p.values)).rows;
      return { total: Number(rows[0]?.total ?? 0), items: rows.map(presentTask) };
    });
  }

  /** Calendar: tasks grouped by due (or act-by) date. */
  async calendar(a: RequestActor, from: string, to: string, field: 'statutory_due' | 'act_by') {
    const { items, total } = await this.list(a, { dueFrom: from, dueTo: to, dateField: field, limit: 2000, offset: 0 });
    const days = new Map<string, typeof items>();
    for (const t of items) {
      const d = (field === 'act_by' ? t.actBy : t.statutoryDue) as string | null;
      if (d) days.set(d, [...(days.get(d) ?? []), t]);
    }
    return { from, to, field, truncated: total > items.length, days: [...days.entries()].map(([date, tasks]) => ({ date, count: tasks.length, tasks })) };
  }

  /** Loads a task the actor may see, or 404. */
  private async load(tx: Tx, a: RequestActor, id: string, lock = false) {
    const r = (await tx.query(`SELECT t.*, c.name AS client_name, s.name AS service_name FROM task t LEFT JOIN client c ON c.id = t.client_id
      LEFT JOIN service_type s ON s.id = t.service_type_id WHERE t.id = $1 AND t.deleted_at IS NULL${lock ? ' FOR UPDATE OF t' : ''}`, [id])).rows[0];
    if (!r || !(await canTaskRow(a, 'view', r, tx))) throw new NotFoundException('Task not found');
    return r;
  }

  get(a: RequestActor, id: string) { return this.db.tenantTx(a.tenantId, async (tx) => presentTask(await this.load(tx, a, id))); }

  async create(a: RequestActor, patch: Record<string, unknown>) {
    const id = uuidv7();
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const row = { ...patch };
      if (row.service_type_id) {
        const st = (await tx.query('SELECT * FROM service_type WHERE id = $1 AND deleted_at IS NULL', [row.service_type_id])).rows[0];
        if (!st) throw new BadRequestException('Unknown service');
        if (row.checks === undefined) row.checks = ((st.default_checks ?? []) as TaskCheck[]).map((c) => ({ ...c, done: false }));
      }
      return this.sync.applyInTx(tx, a, { table: 'task', id, baseVersion: 0, patch: row });
    });
    this.publish(a, r.cursor);
    return { id };
  }

  async update(a: RequestActor, id: string, patch: Record<string, unknown>) {
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const cur = await this.load(tx, a, id);
      return this.sync.applyInTx(tx, a, { table: 'task', id, baseVersion: cur.version, patch });
    });
    this.publish(a, r.cursor);
  }

  async setCheck(a: RequestActor, id: string, key: string, done: boolean) {
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const cur = await this.load(tx, a, id);
      const checks = (cur.checks as TaskCheck[]) ?? [];
      if (!checks.some((c) => c.key === key)) throw new BadRequestException('Unknown check');
      return this.sync.applyInTx(tx, a, { table: 'task', id, baseVersion: cur.version, patch: { checks: checks.map((c) => (c.key === key ? { ...c, done } : c)) } });
    });
    this.publish(a, r.cursor);
  }

  /** Every task ends billed, free or deleted (soft delete). */
  async close(a: RequestActor, id: string, outcome: TaskOutcome, note?: string | null) {
    const cursor = await this.db.tenantTx(a.tenantId, async (tx) => {
      const cur = await this.load(tx, a, id, true);
      if (!(await canTaskRow(a, outcome === 'deleted' ? 'delete' : 'edit', cur, tx))) throw new ForbiddenException();
      const why = closeError(stateOf(cur), outcome);
      if (why) throw new BadRequestException({ message: 'Rejected', code: why });
      let res = await this.sync.serverPatch(tx, a, 'task', id, { outcome, outcome_note: note ?? null, closed_at: new Date().toISOString(), closed_by: a.userId });
      if (outcome === 'deleted') {
        res = { version: 0, cursor: Number((await tx.query('UPDATE task SET deleted_at = now(), updated_by = $2 WHERE id = $1 RETURNING sync_cursor', [id, a.userId])).rows[0].sync_cursor) };
      }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'task.closed', entity: 'task', entityId: id, diff: { outcome, note: note ?? null } });
      return res?.cursor;
    });
    this.publish(a, cursor);
  }

  /** Applies one patch to many tasks; returns an undo token valid for 10 minutes. Rows that fail rules are reported, not applied. */
  async bulk(a: RequestActor, ids: string[], patch: BulkPatch) {
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const snapshot: Array<{ id: string; prev: Record<string, unknown>; next: Record<string, unknown> }> = [];
      const failed: Array<{ id: string; reason: string }> = [];
      let cursor = 0;
      for (const id of [...new Set(ids)]) {
        const cur = (await tx.query('SELECT * FROM task WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
        if (!cur || !(await canTaskRow(a, 'view', cur, tx))) { failed.push({ id, reason: 'not_found' }); continue; }
        const why = await this.checkChange(tx, a, cur, patch);
        if (why) { failed.push({ id, reason: why }); continue; }
        snapshot.push({ id, prev: pick(cur, Object.keys(patch)), next: pick({ ...cur, ...patch }, Object.keys(patch)) });
        cursor = Math.max(cursor, (await this.sync.serverPatch(tx, a, 'task', id, withDerived(cur, patch)))!.cursor);
      }
      const token = uuidv7();
      if (snapshot.length) {
        await tx.query(`INSERT INTO task_bulk_undo (id, tenant_id, user_id, snapshot, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(mins => ${UNDO_MINUTES}))`,
          [token, a.tenantId, a.userId, JSON.stringify(snapshot)]);
        await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'task.bulk_updated', entity: 'task', entityId: null, diff: { ids: snapshot.map((s) => s.id), patch, undoToken: token } });
      }
      return { undoToken: snapshot.length ? token : null, applied: snapshot.length, failed, cursor };
    });
    this.publish(a, r.cursor);
    return { undoToken: r.undoToken, applied: r.applied, failed: r.failed, expiresInSeconds: UNDO_MINUTES * 60 };
  }

  async undo(a: RequestActor, token: string) {
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const u = (await tx.query('SELECT * FROM task_bulk_undo WHERE id = $1 AND user_id = $2 FOR UPDATE', [token, a.userId])).rows[0];
      if (!u) throw new NotFoundException('Undo token not found');
      if (u.used_at || (await tx.query('SELECT $1::timestamptz < now() AS expired', [u.expires_at])).rows[0].expired) throw new GoneException('Undo window has passed');
      let cursor = 0; let restored = 0; const skipped: Array<{ id: string; reason: 'stale' | 'forbidden' | 'invalid' }> = [];
      for (const s of u.snapshot as Array<{ id: string; prev: Record<string, unknown>; next: Record<string, unknown> }>) {
        const cur = (await tx.query('SELECT * FROM task WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [s.id])).rows[0];
        // Gone, closed, or changed since the bulk edit → leave it alone (never overwrite newer work).
        if (!cur || cur.outcome || JSON.stringify(pick(cur, Object.keys(s.next))) !== JSON.stringify(s.next)) { skipped.push({ id: s.id, reason: 'stale' }); continue; }
        const why = await this.checkChange(tx, a, cur, s.prev);
        if (why) { skipped.push({ id: s.id, reason: why === 'forbidden' || why === 'reviewer_must_approve' ? 'forbidden' : 'invalid' }); continue; }
        await tx.query('SAVEPOINT undo_row');
        try {
          cursor = Math.max(cursor, (await this.sync.serverPatch(tx, a, 'task', s.id, withDerived(cur, s.prev)))!.cursor);
          await tx.query('RELEASE SAVEPOINT undo_row');
          restored++;
        } catch (e) {
          if (!['23514', '23503', '23502'].includes((e as { code?: string }).code ?? '')) throw e;
          await tx.query('ROLLBACK TO SAVEPOINT undo_row');
          skipped.push({ id: s.id, reason: 'invalid' });
        }
      }
      await tx.query('UPDATE task_bulk_undo SET used_at = now() WHERE id = $1', [token]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'task.bulk_undone', entity: 'task', entityId: null, diff: { undoToken: token, restored, skipped } });
      return { restored, skipped, cursor };
    });
    this.publish(a, r.cursor);
    return { restored: r.restored, skipped: r.skipped };
  }

  /** Same permission + business rules as a device edit, for server-side batch changes. */
  private async checkChange(tx: Tx, a: RequestActor, cur: Record<string, unknown>, patch: Record<string, unknown>): Promise<string | null> {
    if (!(await canTaskRow(a, 'edit', cur, tx))) return 'forbidden';
    const next = { ...cur, ...patch };
    const who = await actorChangeError(a, cur, next, tx);
    if (who) return who;
    return taskChangeError(stateOf(cur), stateOf(next)) ?? (await checkPeopleAndRevoke(tx, a.tenantId, cur, next));
  }

  // ---------- To-dos (personal) ----------
  listTodos(a: RequestActor, q: { done?: boolean; taskId?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params([a.userId]);
      const where = ['owner_id = $1', 'deleted_at IS NULL'];
      if (q.done !== undefined) where.push(`done = ${p.add(q.done)}`);
      if (q.taskId) where.push(`task_id = ${p.add(q.taskId)}`);
      return (await tx.query(`SELECT id, title, notes, due_at AS "dueAt", done, done_at AS "doneAt", task_id AS "taskId", sort, version, created_at AS "createdAt"
        FROM todo WHERE ${where.join(' AND ')} ORDER BY done, due_at NULLS LAST, sort, created_at`, p.values)).rows;
    });
  }

  async createTodo(a: RequestActor, patch: Record<string, unknown>) {
    const id = uuidv7();
    const r = await this.db.tenantTx(a.tenantId, (tx) => this.sync.applyInTx(tx, a, { table: 'todo', id, baseVersion: 0, patch }));
    this.publish(a, r.cursor);
    return { id };
  }

  async updateTodo(a: RequestActor, id: string, patch: Record<string, unknown> | null) {
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const cur = (await tx.query('SELECT version FROM todo WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [id, a.userId])).rows[0];
      if (!cur) throw new NotFoundException();
      if (patch && 'done' in patch && !('done_at' in patch)) patch.done_at = patch.done ? new Date().toISOString() : null;
      return this.sync.applyInTx(tx, a, { table: 'todo', id, baseVersion: cur.version, patch: patch ?? {}, delete: !patch });
    });
    this.publish(a, r.cursor);
  }

  listTemplates(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(`SELECT id, name, items, version FROM todo_template WHERE deleted_at IS NULL ORDER BY name`)).rows);
  }

  async createTemplate(a: RequestActor, t: { name: string; items: Array<{ title: string; offsetDays: number }> }) {
    const id = uuidv7();
    const cursor = await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await tx.query('INSERT INTO todo_template (id, tenant_id, name, items, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$5) RETURNING sync_cursor', [id, a.tenantId, t.name, JSON.stringify(t.items), a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'todo_template.created', entity: 'todo_template', entityId: id, diff: t });
      return Number(r.rows[0].sync_cursor);
    });
    this.publish(a, cursor);
    return { id };
  }

  /** Creates the template's to-dos for the caller, due `offsetDays` after `baseDate` (18:00 IST). */
  async applyTemplate(a: RequestActor, id: string, i: { baseDate?: string; taskId?: string | null }) {
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const t = (await tx.query('SELECT * FROM todo_template WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
      if (!t) throw new NotFoundException();
      const base = i.baseDate ?? todayIst();
      const ids: string[] = []; let cursor = 0;
      for (const [n, it] of (t.items as Array<{ title: string; offsetDays: number }>).entries()) {
        const tid = uuidv7();
        const d = new Date(`${base}T18:00:00+05:30`); d.setUTCDate(d.getUTCDate() + (it.offsetDays ?? 0));
        cursor = Math.max(cursor, (await this.sync.applyInTx(tx, a, { table: 'todo', id: tid, baseVersion: 0, patch: { title: it.title, due_at: d.toISOString(), task_id: i.taskId ?? null, sort: n } })).cursor);
        ids.push(tid);
      }
      return { ids, cursor };
    });
    this.publish(a, r.cursor);
    return { ids: r.ids };
  }
}

/** Comparable snapshot of task columns (dates as YYYY-MM-DD). */
function pick(r: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, k === 'act_by' || k === 'statutory_due' ? ymd(r[k]) : r[k] ?? null]));
}

/** Server-derived columns for a change (completion time; check stamps are untouched by bulk). */
function withDerived(cur: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...patch };
  if ('status' in patch && patch.status !== cur.status) out.completed_at = patch.status === 'done' ? new Date().toISOString() : null;
  return out;
}
