import { can, clientCtx } from '@worko/domain';
import type { RequestActor } from '../auth/context.js';
import { visibilityOf } from '../clients/scope.js';
import type { Tx } from '../db/db.service.js';
import { canTaskRow, ymd } from '../tasks/scope.js';

const CONTENT = ['task_id', 'client_id', 'work_date', 'minutes', 'billable', 'notes'] as const;
const norm = (x: unknown) => String(x instanceof Date ? ymd(x) : x ?? '');
const same = (x: unknown, y: unknown) => norm(x) === norm(y);

/** Task's client for a time entry (null = firm task); throws-free: returns undefined when the task is missing/invisible. */
export async function taskForEntry(a: RequestActor, tx: Tx, taskId: unknown): Promise<Record<string, unknown> | undefined> {
  if (typeof taskId !== 'string') return undefined;
  const t = (await tx.query('SELECT * FROM task WHERE id = $1 AND deleted_at IS NULL', [taskId])).rows[0];
  if (!t || !(await canTaskRow(a, 'view', t, tx))) return undefined;
  return t;
}

/**
 * Business rules for a time entry change by its owner (device push and REST share them):
 * approved entries are immutable; owners move draft/rejected → draft/submitted and may withdraw submitted → draft;
 * content changes only while draft/rejected; the task must be visible and the client must match it; a client without a
 * task needs clients:view; at most 24 h per person per day.
 */
export async function timeEntryError(a: RequestActor, cur: Record<string, unknown> | null, next: Record<string, unknown>, tx: Tx): Promise<string | null> {
  if (cur?.status === 'approved') return 'immutable';
  if (!['draft', 'submitted'].includes(String(next.status ?? 'draft'))) return 'invalid:status';
  if (cur?.status === 'submitted' && CONTENT.some((f) => !same(cur[f], next[f]))) return 'submitted_locked';
  const minutes = Number(next.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return 'invalid:minutes';
  if (!next.work_date) return 'invalid:work_date';
  if (!cur || !same(cur.task_id, next.task_id) || !same(cur.client_id, next.client_id)) {
    if (next.task_id) {
      const t = await taskForEntry(a, tx, next.task_id);
      if (!t) return 'invalid:task_id';
      if ((t.client_id ?? null) !== (next.client_id ?? null)) return 'client_mismatch';
    } else if (next.client_id) {
      const c = (await tx.query('SELECT * FROM client WHERE id = $1 AND deleted_at IS NULL', [next.client_id])).rows[0];
      if (!c || !can(a, 'clients', 'view', clientCtx(visibilityOf(c)))) return 'invalid:client_id';
    }
  }
  const day = (await tx.query(`SELECT COALESCE(sum(minutes),0) AS m FROM time_entry WHERE user_id = $1 AND work_date = $2::date AND deleted_at IS NULL AND id <> $3 AND minutes > 0`,
    [next.user_id ?? a.userId, next.work_date, next.id ?? cur?.id ?? '00000000-0000-0000-0000-000000000000'])).rows[0];
  if (Number(day.m) + minutes > 1440) return 'day_over_24h';
  return null;
}
