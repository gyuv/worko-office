import { describe, expect, it } from 'vitest';
import { dashboardStats, myDay, weekBars } from './home-logic';
import type { Task } from './tasks/logic';

const task = (p: Partial<Task>): Task => ({ id: Math.random().toString(36), title: 't', status: 'open', priority: 'normal', checks: [], source: 'manual', version: 1, ...p } as Task);
// Wednesday 11 Nov 2026, 10:00 IST (fixed: tests never read the wall clock).
const NOW = new Date('2026-11-11T04:30:00Z');

describe('dashboard stats', () => {
  it('counts by status, overdue (IST) and this month', () => {
    const s = dashboardStats([
      task({ status: 'done', completedAt: '2026-11-02T06:00:00Z', createdAt: '2026-10-20T06:00:00Z' }),
      task({ status: 'done', completedAt: '2026-10-31T19:00:00Z' }), // 1 Nov 00:30 IST → this month
      task({ status: 'in_progress', actBy: '2026-11-10', createdAt: '2026-11-05T06:00:00Z' }),
      task({ status: 'review', statutoryDue: '2026-11-20' }),
      task({ status: 'pending_client', actBy: '2026-11-01' }),
      task({ status: 'open' }),
    ], NOW);
    expect(s).toEqual({ total: 6, done: 2, running: 2, pendingClient: 1, overdue: 2, createdThisMonth: 1, doneThisMonth: 2 });
  });
});

describe('week bars', () => {
  it('last 7 days in IST, today last', () => {
    const b = weekBars([
      task({ status: 'done', completedAt: '2026-11-05T05:00:00Z' }), // Thu 5 Nov
      task({ status: 'done', completedAt: '2026-11-10T19:00:00Z' }), // Wed 11 Nov 00:30 IST
      task({ status: 'done', completedAt: '2026-11-11T03:00:00Z' }), // Wed 11 Nov
      task({ status: 'done', completedAt: '2026-11-04T05:00:00Z' }), // 8 days ago: outside
      task({ status: 'open', completedAt: '2026-11-09T05:00:00Z' }), // reopened: not counted
    ], NOW);
    expect(b.map((x) => x.date)).toEqual(['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11']);
    expect(b.map((x) => x.label).join('')).toBe('TFSSMTW');
    expect(b.map((x) => x.count)).toEqual([1, 0, 0, 0, 0, 0, 2]);
    expect(b.filter((x) => x.today).map((x) => x.date)).toEqual(['2026-11-11']);
  });
});

describe('myDay', () => {
  const now = new Date('2026-11-09T06:00:00Z');
  const base = { status: 'open', priority: 'normal', assigneeId: 'me' };
  const mk = (id: string, x: Record<string, unknown>) => ({ id, title: id, ...base, ...x }) as never;
  it('splits my open tasks and counts what I cleared today', () => {
    const r = myDay([
      mk('late', { actBy: '2026-11-01' }), mk('now', { actBy: '2026-11-09', priority: 'low' }), mk('urgent', { actBy: '2026-11-09', priority: 'urgent' }),
      mk('soon', { statutoryDue: '2026-11-12' }), mk('far', { actBy: '2026-12-30' }), mk('other', { actBy: '2026-11-09', assigneeId: 'x' }),
      mk('fin', { status: 'done', completedAt: '2026-11-09T04:00:00Z' }), mk('old', { status: 'done', completedAt: '2026-11-01T04:00:00Z' }),
    ], 'me', now);
    expect(r.overdue.map((x: { id: string }) => x.id)).toEqual(['late']);
    expect(r.todayList.map((x: { id: string }) => x.id)).toEqual(['urgent', 'now']);
    expect(r.upcoming.map((x: { id: string }) => x.id)).toEqual(['soon']);
    expect(r.doneToday).toBe(1);
    expect(r.tomorrow).toBe('2026-11-10');
  });
});
