import type { Task } from './tasks/logic';

/** IST calendar date (YYYY-MM-DD) of an instant. */
export const istDate = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

/** Headline numbers for the dashboard (cancelled tasks are excluded by the caller). */
export function dashboardStats(items: Task[], now: Date) {
  const today = istDate(now);
  const month = today.slice(0, 7);
  const inMonth = (s?: string | null) => !!s && istDate(new Date(s)).slice(0, 7) === month;
  const open = items.filter((x) => x.status !== 'done');
  return {
    total: items.length,
    done: items.filter((x) => x.status === 'done').length,
    running: items.filter((x) => x.status === 'in_progress' || x.status === 'review').length,
    pendingClient: items.filter((x) => x.status === 'pending_client').length,
    overdue: open.filter((x) => { const d = x.actBy ?? x.statutoryDue; return !!d && d < today; }).length,
    createdThisMonth: items.filter((x) => inMonth(x.createdAt)).length,
    doneThisMonth: items.filter((x) => x.status === 'done' && inMonth(x.completedAt ?? x.closedAt)).length,
  };
}

const DAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** Tasks completed on each of the last 7 days (IST), oldest first, today last. */
export function weekBars(items: Task[], now: Date) {
  const today = istDate(now);
  const t0 = new Date(`${today}T00:00:00Z`).getTime();
  const counts = new Map<string, number>();
  for (const x of items) {
    const at = x.status === 'done' ? x.completedAt ?? x.closedAt : null;
    if (at) { const d = istDate(new Date(at)); counts.set(d, (counts.get(d) ?? 0) + 1); }
  }
  return Array.from({ length: 7 }, (_, k) => {
    const day = new Date(t0 - (6 - k) * 86_400_000);
    const date = day.toISOString().slice(0, 10);
    return { label: DAY[day.getUTCDay()]!, date, count: counts.get(date) ?? 0, today: date === today, future: false };
  });
}
