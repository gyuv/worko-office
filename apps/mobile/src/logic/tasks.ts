import { taskChangeError, TASK_STATUSES, type TaskCheck, type TaskStatus } from '@worko/domain';
import type { MessageKey } from '@worko/i18n';
import type { LocalReminder } from '@worko/notify';
import type { LocalRow } from '@worko/sync';
import { todayIST } from './registers';

export type TaskItem = {
  id: string; title: string; clientId: string | null; serviceTypeId: string | null; ruleId: string | null; periodLabel: string | null;
  status: TaskStatus; priority: string; statutoryDue: string | null; actBy: string | null; checks: TaskCheck[]; pendingIssue: string | null;
  reviewerId: string | null; people: string[]; outcome: string | null;
};

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const day = (v: unknown) => (str(v) ? String(v).slice(0, 10) : null);

export function toTaskItem(r: LocalRow): TaskItem {
  const f = r.fields;
  const status = (TASK_STATUSES as readonly string[]).includes(String(f.status)) ? (f.status as TaskStatus) : 'open';
  return {
    id: r.id, title: String(f.title ?? ''), clientId: str(f.client_id), serviceTypeId: str(f.service_type_id), ruleId: str(f.rule_id),
    periodLabel: str(f.period_label) ?? str(f.period_key), status, priority: String(f.priority ?? 'normal'),
    statutoryDue: day(f.statutory_due), actBy: day(f.act_by), checks: Array.isArray(f.checks) ? (f.checks as TaskCheck[]) : [],
    pendingIssue: str(f.pending_issue), reviewerId: str(f.reviewer_id), outcome: str(f.outcome),
    people: [f.leader_id, f.manager_id, f.assignee_id, f.reviewer_id].filter((x): x is string => typeof x === 'string' && !!x),
  };
}

export const isOpen = (t: TaskItem) => !t.outcome && t.status !== 'done' && t.status !== 'cancelled';
export const isMine = (t: TaskItem, userId: string) => t.people.includes(userId);
/** The date the firm works to: act-by when set, else the statutory due date. */
export const workDate = (t: TaskItem) => t.actBy ?? t.statutoryDue;

export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

export type TaskGroups = { overdue: TaskItem[]; today: TaskItem[]; week: TaskItem[]; later: TaskItem[] };
export type StatusFilter = TaskStatus | 'all' | 'open';

/** My open tasks (or all mine for a status filter), grouped by work date relative to today (IST). */
export function groupMyTasks(items: TaskItem[], userId: string, filter: StatusFilter, today = todayIST()): TaskGroups {
  const g: TaskGroups = { overdue: [], today: [], week: [], later: [] };
  const weekEnd = addDays(today, 7);
  const mine = items.filter((t) => isMine(t, userId) && !t.outcome && (filter === 'all' ? true : filter === 'open' ? isOpen(t) : t.status === filter));
  for (const t of mine.sort((a, b) => (workDate(a) ?? '9999').localeCompare(workDate(b) ?? '9999') || a.title.localeCompare(b.title))) {
    const d = workDate(t);
    if (!d) g.later.push(t);
    else if (d < today) (isOpen(t) ? g.overdue : g.later).push(t);
    else if (d === today) g.today.push(t);
    else if (d <= weekEnd) g.week.push(t);
    else g.later.push(t);
  }
  return g;
}

const stateOf = (t: TaskItem) => ({
  status: t.status, reviewerId: t.reviewerId, checks: t.checks, pendingIssue: t.pendingIssue,
  outcome: (t.outcome as 'billed' | null) ?? null, statutoryDue: t.statutoryDue, actBy: t.actBy,
});

/** Same rule function as the server; returns a reason code or null. */
export function changeError(t: TaskItem, patch: Partial<Pick<TaskItem, 'status' | 'checks' | 'pendingIssue'>>): string | null {
  return taskChangeError(stateOf(t), { ...stateOf(t), ...patch });
}

export function toggleCheck(checks: TaskCheck[], key: string): TaskCheck[] {
  return checks.map((c) => (c.key === key ? { ...c, done: !c.done } : c));
}
export const requiredPending = (checks: TaskCheck[]) => checks.filter((c) => c.required && !c.done).length;

/** Statuses the user may pick, each with the reason it is blocked (if it is). */
export function statusOptions(t: TaskItem): Array<{ status: TaskStatus; blocked: string | null }> {
  return TASK_STATUSES.filter((s) => s !== t.status).map((s) => ({
    status: s, blocked: changeError(t, { status: s, pendingIssue: s === 'pending_client' ? t.pendingIssue ?? 'x' : t.pendingIssue }),
  }));
}

const REASONS: Record<string, MessageKey> = {
  required_checks_pending: 'm.task.err.requiredChecks', reviewer_required: 'm.task.err.reviewer', pending_issue_required: 'm.task.err.pendingIssue',
  act_by_after_due: 'm.task.err.actBy', task_closed: 'm.task.err.closed', forbidden: 'm.task.err.forbidden',
};
/** Server / local rejection reason → message key (unknown codes fall back to a generic message). */
export const reasonKey = (reason: string | undefined | null): MessageKey => REASONS[reason ?? ''] ?? 'm.task.err.generic';

export const STATUS_KEY: Record<TaskStatus, MessageKey> = {
  open: 'm.task.status.open', in_progress: 'm.task.status.in_progress', pending_client: 'm.task.status.pending_client',
  review: 'm.task.status.review', done: 'm.task.status.done', cancelled: 'm.task.status.cancelled',
};

export type ComplianceGroup = { key: string; label: string; tasks: TaskItem[]; open: number };

/** Tasks whose statutory due date falls in today's month (IST), grouped by rule (or service type when no rule). */
export function complianceDueThisMonth(items: TaskItem[], serviceName: (id: string) => string | undefined, today = todayIST()): ComplianceGroup[] {
  const month = today.slice(0, 7);
  const groups = new Map<string, ComplianceGroup>();
  for (const t of items) {
    if (t.outcome === 'deleted' || t.status === 'cancelled' || !t.statutoryDue?.startsWith(month)) continue;
    const key = t.ruleId ?? t.serviceTypeId ?? 'other';
    const label = (t.serviceTypeId && serviceName(t.serviceTypeId)) || t.ruleId || t.title;
    const g = groups.get(key) ?? { key, label, tasks: [], open: 0 };
    g.tasks.push(t); if (isOpen(t)) g.open++;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g, tasks: g.tasks.sort((a, b) => (a.statutoryDue ?? '').localeCompare(b.statutoryDue ?? '')) }))
    .sort((a, b) => (a.tasks[0]?.statutoryDue ?? '').localeCompare(b.tasks[0]?.statutoryDue ?? '') || a.label.localeCompare(b.label));
}

/** Local reminder time-of-day (IST) for an act-by date. A firm preference, not a statutory date. */
export const REMINDER_HOUR_IST = '10:00';

/** Offline reminders for my open tasks: the day before act-by (due soon) and on act-by (due today). Quiet hours are applied by ReminderScheduler. */
export function planTaskReminders(items: TaskItem[], userId: string, text: { soon(t: TaskItem): string; today(t: TaskItem): string }): LocalReminder[] {
  const out: LocalReminder[] = [];
  for (const t of items) {
    if (!isOpen(t) || !isMine(t, userId) || !t.actBy) continue;
    const at = (d: string) => `${d}T${REMINDER_HOUR_IST}:00+05:30`;
    out.push({ id: `task-soon:${t.id}:${t.actBy}`, title: text.soon(t), body: t.title, category: 'task.due_soon', priority: 'normal', fireAt: at(addDays(t.actBy, -1)) });
    out.push({ id: `task-today:${t.id}:${t.actBy}`, title: text.today(t), body: t.title, category: 'task.due_today', priority: 'high', fireAt: at(t.actBy) });
  }
  return out;
}

// ---- to-dos ----
export type TodoItem = { id: string; title: string; dueAt: string | null; done: boolean; taskId: string | null; sort: number };
export const toTodoItem = (r: LocalRow): TodoItem => ({
  id: r.id, title: String(r.fields.title ?? ''), dueAt: str(r.fields.due_at), done: !!r.fields.done, taskId: str(r.fields.task_id), sort: Number(r.fields.sort ?? 0),
});
/** Open first (by due, undated last), then done. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const sortTodos = (xs: TodoItem[]) => [...xs].sort((a, b) =>
  Number(a.done) - Number(b.done) || cmp(a.dueAt ?? '~', b.dueAt ?? '~') || a.sort - b.sort || a.title.localeCompare(b.title));

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Insert patch for a to-do; a due date (IST) becomes 18:00 IST that day. */
export function buildTodoPatch(title: string, due: string): { ok: true; patch: Record<string, unknown> } | { ok: false; error: 'title' | 'due' } {
  const tt = title.trim();
  if (!tt || tt.length > 300) return { ok: false, error: 'title' };
  const d = due.trim();
  if (d && (!DATE.test(d) || Number.isNaN(Date.parse(d)))) return { ok: false, error: 'due' };
  return { ok: true, patch: { title: tt, done: false, due_at: d ? new Date(`${d}T18:00:00+05:30`).toISOString() : null, sort: 0 } };
}
export const todoTogglePatch = (t: TodoItem, now = new Date()) => ({ done: !t.done, done_at: t.done ? null : now.toISOString() });
export const isTodoOverdue = (t: TodoItem, now = new Date()) => !t.done && !!t.dueAt && Date.parse(t.dueAt) < now.getTime();
