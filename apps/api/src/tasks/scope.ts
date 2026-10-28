import { canTask, effectiveScope, type Action, type Actor, type TaskCheck, type TaskPeople, type TaskState } from '@worko/domain';
import { loadActors } from '../clients/actors.js';
import { clientScopeSql, visibilityOf, type Params } from '../clients/scope.js';
import type { Tx } from '../db/db.service.js';

/**
 * SQL twin of `canTask(actor, action, people(t), client)` over a task row `t` with its client LEFT JOINed as `c`
 * (c.* NULL for firm tasks). Kept in lock-step with @worko/domain by a property test (test/scope.int.test.ts).
 */
export function taskScopeSql(a: Actor & { superAdmin?: boolean }, action: Action, p: Params, t = 't', c = 'c'): string {
  if (a.superAdmin) return 'TRUE';
  const g = effectiveScope(a, 'tasks', action);
  if (!g || g.scope === 'none') return 'FALSE';
  const me = p.add(a.userId);
  const people = `(${t}.leader_id = ${me}::uuid OR ${t}.manager_id = ${me}::uuid OR ${t}.assignee_id = ${me}::uuid OR ${t}.reviewer_id = ${me}::uuid)`;
  const clientOwner = `(${c}.partner_id = ${me}::uuid OR ${c}.manager_id = ${me}::uuid OR ${me}::uuid = ANY(${c}.staff_ids))`;
  const owner = `(${people} OR ${clientOwner})`;
  let firm: string; let rule: string;
  switch (g.scope) {
    case 'all': firm = 'TRUE'; rule = 'TRUE'; break;
    case 'branch': firm = 'FALSE'; rule = a.branchId ? `(${c}.branch_id IS NULL OR ${c}.branch_id = ${p.add(a.branchId)}::uuid)` : `${c}.branch_id IS NULL`; break;
    case 'groups': firm = 'FALSE'; rule = `${c}.group_ids && ${p.add(g.clientGroupIds ?? [])}::uuid[]`; break;
    case 'team': firm = people; rule = `((${c}.team_id IS NOT NULL AND ${c}.team_id = ANY(${p.add(a.teamIds)}::uuid[])) OR ${owner})`; break;
    case 'own': firm = people; rule = owner; break;
  }
  const sensitive = `(NOT ${c}.sensitive OR ${me}::uuid = ANY(${c}.allowed_user_ids))`;
  return `(CASE WHEN ${t}.client_id IS NULL THEN COALESCE(${firm}, FALSE) ELSE COALESCE(${clientScopeSql(a, 'clients', 'view', p, c)} AND ${rule} AND ${sensitive}, FALSE) END)`;
}

export const PEOPLE_COLS = ['leader_id', 'manager_id', 'assignee_id', 'reviewer_id'] as const;
export const peopleOf = (r: Record<string, unknown>): TaskPeople => ({
  leaderId: (r.leader_id as string) ?? null, managerId: (r.manager_id as string) ?? null,
  assigneeId: (r.assignee_id as string) ?? null, reviewerId: (r.reviewer_id as string) ?? null,
});
/** A pg `date` value (parsed by node-pg as local midnight) or string → 'YYYY-MM-DD'. */
export const ymd = (v: unknown): string | null => v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : typeof v === 'string' ? v.slice(0, 10) : null;
const d = ymd;
export const stateOf = (r: Record<string, unknown>): TaskState => ({
  status: (r.status as TaskState['status']) ?? 'open', reviewerId: (r.reviewer_id as string) ?? null, checks: (r.checks as TaskCheck[]) ?? [],
  pendingIssue: (r.pending_issue as string) ?? null, outcome: (r.outcome as TaskState['outcome']) ?? null,
  statutoryDue: d(r.statutory_due), actBy: d(r.act_by),
});

export async function clientOfTask(tx: Tx, clientId: unknown) {
  if (typeof clientId !== 'string') return null;
  return (await tx.query('SELECT * FROM client WHERE id = $1 AND deleted_at IS NULL', [clientId])).rows[0] ?? null;
}

/** Row-level check; a task whose client is gone/invisible fails. */
export async function canTaskRow(a: Actor & { superAdmin?: boolean }, action: Action, row: Record<string, unknown>, tx: Tx, client?: Record<string, unknown> | null): Promise<boolean> {
  if (a.superAdmin) return true;
  const c = client !== undefined ? client : await clientOfTask(tx, row.client_id);
  if (row.client_id && !c) return false;
  return canTask(a, action, peopleOf(row), c ? visibilityOf(c) : null);
}

/**
 * People named on a task must be able to see it (no invisible assignments), and users who could see the task
 * before a people change but not after get a sync revocation (only them).
 */
export async function checkPeopleAndRevoke(tx: Tx, tenantId: string, before: Record<string, unknown> | null, after: Record<string, unknown>): Promise<string | null> {
  const changed = PEOPLE_COLS.filter((f) => (before ? (before[f] ?? null) !== (after[f] ?? null) : !!after[f]));
  if (!changed.length) return null;
  const client = await clientOfTask(tx, after.client_id);
  const vis = client ? visibilityOf(client) : null;
  const actors = await loadActors(tx);
  for (const f of changed) {
    const uid = after[f] as string | null;
    if (!uid) continue;
    const x = actors.find((y) => y.userId === uid);
    if (!x || !canTask(x, 'view', peopleOf(after), vis)) return `person_cannot_see_task:${f}`;
  }
  if (before?.id) {
    const lost = actors.filter((x) => canTask(x, 'view', peopleOf(before), vis) && !canTask(x, 'view', peopleOf(after), vis)).map((x) => x.userId);
    if (lost.length) {
      await tx.query(`INSERT INTO sync_revocation (tenant_id, table_name, row_id, user_ids, sync_cursor) VALUES ($1,'task',$2,$3, nextval('sync_cursor_seq'))`, [tenantId, before.id, lost]);
    }
  }
  return null;
}

/** Stamps who/when on checks that became done; clears it on undone ones. */
export function stampChecks(prev: TaskCheck[], next: TaskCheck[], userId: string | null, now = new Date().toISOString()): TaskCheck[] {
  const old = new Map(prev.map((c) => [c.key, c]));
  return next.map((c) => {
    const o = old.get(c.key);
    if (!c.done) return { ...c, doneBy: null, doneAt: null };
    if (o?.done) return { ...c, doneBy: o.doneBy ?? null, doneAt: o.doneAt ?? null };
    return { ...c, doneBy: userId, doneAt: now };
  });
}
