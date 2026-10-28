import { describe, expect, it } from 'vitest';
import { ganttBar, kanbanColumns, monthGrid, moveError, sprintBucket, sprintBuckets, weekStart, type Task } from './logic';

const task = (o: Partial<Task>): Task => ({ id: o.id ?? 'x', title: 'T', status: 'open', priority: 'normal', checks: [], source: 'manual', version: 1, ...o });
// 2026-10-28 is a Wednesday; its week runs Mon 26 Oct – Sun 1 Nov.
const TODAY = '2026-10-28';

describe('kanban column mapping', () => {
  it('groups by status, drops closed and cancelled, orders by act-by', () => {
    const cols = kanbanColumns([
      task({ id: 'a', status: 'open', actBy: '2026-11-05' }), task({ id: 'b', status: 'open', actBy: '2026-11-01' }),
      task({ id: 'c', status: 'review' }), task({ id: 'd', status: 'done', outcome: 'billed' }), task({ id: 'e', status: 'cancelled' }),
      task({ id: 'f', status: 'pending_client' }),
    ]);
    expect(cols.open.map((t) => t.id)).toEqual(['b', 'a']);
    expect(cols.review.map((t) => t.id)).toEqual(['c']);
    expect(cols.pending_client.map((t) => t.id)).toEqual(['f']);
    expect(cols.done).toEqual([]);
    expect(Object.keys(cols)).toEqual(['open', 'in_progress', 'pending_client', 'review', 'done']);
  });
  it('pre-checks moves with the server rules', () => {
    const t = task({ checks: [{ key: 'k', label: 'L', required: true, done: false }] });
    expect(moveError(t, 'done')).toBe('required_checks_pending');
    expect(moveError(t, 'review')).toBe('reviewer_required');
    expect(moveError({ ...t, reviewerId: 'r' }, 'review')).toBeNull();
    expect(moveError(t, 'pending_client')).toBe('pending_issue_required');
    expect(moveError(t, 'pending_client', { pendingIssue: 'bank stmt' })).toBeNull();
    expect(moveError(task({ outcome: 'free', status: 'done' }), 'open')).toBe('task_closed');
  });
});

describe('sprint bucketing', () => {
  it('uses Monday-start weeks in IST dates', () => {
    expect(weekStart(TODAY)).toBe('2026-10-26');
    expect(weekStart('2026-11-01')).toBe('2026-10-26');
    expect(weekStart('2026-11-02')).toBe('2026-11-02');
  });
  it('buckets by act-by, falling back to statutory due', () => {
    expect(sprintBucket(task({ actBy: '2026-10-27' }), TODAY)).toBe('overdue');
    expect(sprintBucket(task({ actBy: '2026-10-27', status: 'done' }), TODAY)).toBe('thisWeek');
    expect(sprintBucket(task({ actBy: '2026-11-01' }), TODAY)).toBe('thisWeek');
    expect(sprintBucket(task({ statutoryDue: '2026-11-02' }), TODAY)).toBe('nextWeek');
    expect(sprintBucket(task({ actBy: '2026-11-08' }), TODAY)).toBe('nextWeek');
    expect(sprintBucket(task({ actBy: '2026-11-09' }), TODAY)).toBe('later');
    expect(sprintBucket(task({}), TODAY)).toBe('noDate');
    const b = sprintBuckets([task({ actBy: '2026-10-01', outcome: 'deleted' }), task({ actBy: '2026-10-29' })], TODAY);
    expect(b.thisWeek).toHaveLength(1);
    expect(b.overdue).toHaveLength(0);
  });
});

describe('calendar + gantt helpers', () => {
  it('builds a Monday-first month grid covering the month', () => {
    const g = monthGrid('2026-10');
    expect(g[0]![0]).toBe('2026-09-28');
    expect(g.flat()).toContain('2026-10-31');
    expect(g.every((w) => w.length === 7)).toBe(true);
  });
  it('clips gantt bars from created to act-by', () => {
    expect(ganttBar(task({ createdAt: '2026-10-20T05:00:00Z', actBy: '2026-10-25' }), '2026-10-14', 42)).toEqual({ offset: 6, span: 6 });
    expect(ganttBar(task({ createdAt: '2026-01-01T00:00:00Z', actBy: '2026-10-15' }), '2026-10-14', 42)).toEqual({ offset: 0, span: 2 });
    expect(ganttBar(task({ actBy: '2027-01-01' }), '2026-10-14', 42)).toBeNull();
  });
});
