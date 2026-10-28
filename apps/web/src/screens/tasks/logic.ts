import type { Schemas } from '@worko/api-client';
import { taskChangeError, type TaskStatus } from '@worko/domain';

export type Task = Schemas['Task'];

/** Kanban columns, in board order. Cancelled tasks are left off the board (filter by status to see them). */
export const KANBAN_COLUMNS = ['open', 'in_progress', 'pending_client', 'review', 'done'] as const satisfies readonly TaskStatus[];
export type KanbanColumn = (typeof KANBAN_COLUMNS)[number];

/** Groups tasks into kanban columns; closed (billed/free/deleted) and cancelled tasks are excluded. */
export function kanbanColumns(tasks: Task[]): Record<KanbanColumn, Task[]> {
  const out = Object.fromEntries(KANBAN_COLUMNS.map((c) => [c, [] as Task[]])) as Record<KanbanColumn, Task[]>;
  for (const t of tasks) {
    if (t.outcome) continue;
    if ((KANBAN_COLUMNS as readonly string[]).includes(t.status)) out[t.status as KanbanColumn].push(t);
  }
  for (const c of KANBAN_COLUMNS) out[c].sort((a, b) => (a.actBy ?? '9999').localeCompare(b.actBy ?? '9999'));
  return out;
}

/**
 * Client-side pre-check of a status move with the same rule function the server uses.
 * Returns the server's rule code (e.g. `required_checks_pending`) or null; the server still re-checks.
 */
export function moveError(t: Task, to: TaskStatus, extra: { pendingIssue?: string | null } = {}): string | null {
  const cur = { status: t.status, reviewerId: t.reviewerId ?? null, checks: t.checks, pendingIssue: t.pendingIssue ?? null, outcome: t.outcome ?? null, statutoryDue: t.statutoryDue ?? null, actBy: t.actBy ?? null };
  return taskChangeError(cur, { ...cur, status: to, pendingIssue: extra.pendingIssue ?? cur.pendingIssue });
}

/** Working date of a task: act-by, else statutory due. */
export const workDate = (t: Task) => t.actBy ?? t.statutoryDue ?? null;

export const isOverdue = (t: Task, today: string) => !t.outcome && t.status !== 'done' && t.status !== 'cancelled' && !!workDate(t) && workDate(t)! < today;

const addDays = (ymd: string, n: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export { addDays };
/** Monday of the week containing `ymd` (weeks run Mon–Sun). */
export function weekStart(ymd: string): string {
  const dow = (new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(ymd, -dow);
}

export const SPRINT_BUCKETS = ['overdue', 'thisWeek', 'nextWeek', 'later', 'noDate'] as const;
export type SprintBucket = (typeof SPRINT_BUCKETS)[number];

/** Sprint view bucket by act-by (falling back to statutory due). Done/closed tasks never count as overdue. */
export function sprintBucket(t: Task, today: string): SprintBucket {
  const d = workDate(t);
  if (!d) return 'noDate';
  if (isOverdue(t, today)) return 'overdue';
  const ws = weekStart(today);
  const nextWs = addDays(ws, 7);
  if (d < nextWs) return 'thisWeek';
  if (d < addDays(nextWs, 7)) return 'nextWeek';
  return 'later';
}

export function sprintBuckets(tasks: Task[], today: string): Record<SprintBucket, Task[]> {
  const out = Object.fromEntries(SPRINT_BUCKETS.map((b) => [b, [] as Task[]])) as Record<SprintBucket, Task[]>;
  for (const t of tasks) if (!t.outcome && t.status !== 'cancelled') out[sprintBucket(t, today)].push(t);
  return out;
}

/** Month grid (Mon-first) covering `month` (YYYY-MM): weeks × 7 ISO dates. */
export function monthGrid(month: string): string[][] {
  const first = `${month}-01`;
  const start = weekStart(first);
  const weeks: string[][] = [];
  for (let d = start; weeks.length < 6; ) {
    const w = Array.from({ length: 7 }, (_, i) => addDays(d, i));
    weeks.push(w);
    d = addDays(d, 7);
    if (d.slice(0, 7) > month) break;
  }
  return weeks;
}
export const monthRange = (month: string) => { const g = monthGrid(month); return { from: g[0]![0]!, to: g[g.length - 1]![6]! }; };
export const shiftMonth = (month: string, n: number) => { const [y, m] = month.split('-').map(Number) as [number, number]; const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Gantt bar from created date to act-by (or statutory due), clipped to [from, from+days). Null when outside. */
export function ganttBar(t: Task, from: string, days: number): { offset: number; span: number } | null {
  const end = workDate(t);
  const start = (t.createdAt ?? '').slice(0, 10) || end;
  if (!end || !start) return null;
  const s = Math.max(0, dayDiff(from, start < end ? start : end));
  const e = Math.min(days - 1, dayDiff(from, end));
  if (e < 0 || s > days - 1) return null;
  return { offset: s, span: e - s + 1 };
}

/** Bulk patch applied → the undo token, if any rows changed. */
export type BulkResult = { undoToken: string | null; applied: number; failed: Array<{ id?: string; reason?: string }>; expiresInSeconds: number };
