import type { ClientVisibility } from './clients.js';
import { clientCtx } from './clients.js';
import { can, type Action, type Actor, type ResourceCtx } from './permissions.js';

export const TASK_STATUSES = ['open', 'in_progress', 'pending_client', 'review', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_OUTCOMES = ['billed', 'free', 'deleted'] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const SERVICE_FREQUENCIES = ['monthly', 'quarterly', 'annual', 'one_time', 'event'] as const;

export type TaskCheck = { key: string; label: string; required: boolean; done: boolean; doneBy?: string | null; doneAt?: string | null };

/** The people on a task. Each of them counts as an owner for 'own'/'team' scope. */
export type TaskPeople = { leaderId: string | null; managerId: string | null; assigneeId: string | null; reviewerId: string | null };

/**
 * Resource context of a task for `can(actor, 'tasks', …)`.
 * - Client task: the client's context (branch/team/groups/sensitive) with the task's people added as owners.
 * - Firm/internal task (no client): only firm-wide scope ('all') or the task's own people (`firmWide` blocks branch scope).
 * Seeing a client task additionally needs `clients:view` on the client — use `canTask`.
 * Mirrored in SQL by the API (`taskScopeSql`), proven equal by a property test.
 */
export function taskCtx(t: TaskPeople, client: ClientVisibility | null): ResourceCtx {
  const people = [t.leaderId, t.managerId, t.assigneeId, t.reviewerId].filter((x): x is string => !!x);
  if (!client) return { ownerUserIds: people, branchId: null, teamId: null, clientGroupIds: [], firmWide: true };
  const c = clientCtx(client);
  return { ...c, ownerUserIds: [...new Set([...(c.ownerUserIds ?? []), ...people])] };
}

/** Full task check: `clients:view` on the client (if any) AND `tasks:<action>` on the task. */
export function canTask(a: Actor, action: Action, t: TaskPeople, client: ClientVisibility | null): boolean {
  if (client && !can(a, 'clients', 'view', clientCtx(client))) return false;
  return can(a, 'tasks', action, taskCtx(t, client));
}

export type TaskState = {
  status: TaskStatus; reviewerId: string | null; checks: TaskCheck[]; pendingIssue: string | null;
  outcome: TaskOutcome | null; statutoryDue: string | null; actBy: string | null;
};

/** Business rules for a task change; returns a reason code or null. Same function on server and devices. */
export function taskChangeError(cur: TaskState | null, next: TaskState): string | null {
  if (cur?.outcome) return 'task_closed';
  if (next.status === 'done' && cur?.status !== 'done' && next.checks.some((c) => c.required && !c.done)) return 'required_checks_pending';
  if (next.status === 'review' && !next.reviewerId) return 'reviewer_required';
  if (next.status === 'pending_client' && !next.pendingIssue?.trim()) return 'pending_issue_required';
  if (next.actBy && next.statutoryDue && next.actBy > next.statutoryDue) return 'act_by_after_due';
  const keys = next.checks.map((c) => c.key);
  if (new Set(keys).size !== keys.length) return 'duplicate_check_key';
  return null;
}

/** Closing rules: billed/free only once done; deleted from any state. */
export function closeError(cur: TaskState, outcome: TaskOutcome): string | null {
  if (cur.outcome) return 'task_closed';
  if (outcome !== 'deleted' && cur.status !== 'done') return 'task_not_done';
  return null;
}
