import { ReminderScheduler, defaultPrefs } from '@worko/notify';
import type { LocalRow } from '@worko/sync';
import { describe, expect, it } from 'vitest';
import {
  buildTodoPatch, changeError, complianceDueThisMonth, groupMyTasks, planTaskReminders, reasonKey, sortTodos, statusOptions, toggleCheck,
  toTaskItem, todoTogglePatch, type TodoItem,
} from './tasks';

const ME = '00000000-0000-4000-8000-000000000001';
const row = (id: string, f: Record<string, unknown>): LocalRow => ({ table: 'task', id, version: 1, deleted: false,
  fields: { title: id, status: 'open', priority: 'normal', checks: [], assignee_id: ME, ...f } });
const task = (id: string, f: Record<string, unknown> = {}) => toTaskItem(row(id, f));
const TODAY = '2026-10-15';

describe('my tasks grouping', () => {
  const items = [
    task('late', { act_by: '2026-10-10' }), task('now', { act_by: TODAY }), task('soon', { act_by: '2026-10-20' }),
    task('far', { act_by: '2026-12-01' }), task('nodate'), task('dueOnly', { statutory_due: '2026-10-14' }),
    task('doneLate', { act_by: '2026-10-01', status: 'done' }), task('other', { act_by: TODAY, assignee_id: 'x' }),
    task('closed', { act_by: TODAY, outcome: 'billed', status: 'done' }),
  ];
  it('groups own open tasks by act-by (falling back to statutory due)', () => {
    const g = groupMyTasks(items, ME, 'open', TODAY);
    expect(g.overdue.map((x) => x.id)).toEqual(['late', 'dueOnly']);
    expect(g.today.map((x) => x.id)).toEqual(['now']);
    expect(g.week.map((x) => x.id)).toEqual(['soon']);
    expect(g.later.map((x) => x.id)).toEqual(['far', 'nodate']);
  });
  it('filters by status; done work is never "overdue"; closed tasks hidden', () => {
    const g = groupMyTasks(items, ME, 'done', TODAY);
    expect([...g.overdue, ...g.today, ...g.week, ...g.later].map((x) => x.id)).toEqual(['doneLate']);
    expect(g.overdue).toEqual([]);
  });
});

describe('check rules', () => {
  const t = task('t', { checks: [{ key: 'a', label: 'A', required: true, done: false }, { key: 'b', label: 'B', required: false, done: false }] });
  it('blocks done while required checks are pending, allows after toggling', () => {
    expect(changeError(t, { status: 'done' })).toBe('required_checks_pending');
    expect(statusOptions(t).find((o) => o.status === 'done')?.blocked).toBe('required_checks_pending');
    const checks = toggleCheck(t.checks, 'a');
    expect(checks[0]?.done).toBe(true);
    expect(changeError({ ...t, checks }, { status: 'done' })).toBeNull();
  });
  it('needs a reviewer for review and an issue for pending_client', () => {
    expect(changeError(t, { status: 'review' })).toBe('reviewer_required');
    expect(changeError(t, { status: 'pending_client', pendingIssue: ' ' })).toBe('pending_issue_required');
    expect(changeError(t, { status: 'pending_client', pendingIssue: 'PAN copy' })).toBeNull();
  });
  it('maps server reason codes to messages', () => {
    expect(reasonKey('required_checks_pending')).toBe('m.task.err.requiredChecks');
    expect(reasonKey('weird')).toBe('m.task.err.generic');
  });
});

describe('compliance due this month', () => {
  it('groups by rule, labelled by service type, skipping other months and cancelled', () => {
    const items = [
      task('a', { statutory_due: '2026-10-20', rule_id: 'gstr3b', service_type_id: 's1' }),
      task('b', { statutory_due: '2026-10-11', rule_id: 'gstr1', service_type_id: 's2', status: 'done' }),
      task('c', { statutory_due: '2026-10-20', rule_id: 'gstr3b', service_type_id: 's1' }),
      task('d', { statutory_due: '2026-11-20', rule_id: 'gstr3b' }), task('e', { statutory_due: '2026-10-05', status: 'cancelled' }),
    ];
    const g = complianceDueThisMonth(items, (id) => ({ s1: 'GSTR-3B', s2: 'GSTR-1' })[id], TODAY);
    expect(g.map((x) => [x.label, x.tasks.length, x.open])).toEqual([['GSTR-1', 1, 0], ['GSTR-3B', 2, 2]]);
  });
});

describe('task reminders', () => {
  const text = { soon: () => 'soon', today: () => 'today' };
  it('plans day-before and act-by reminders for my open tasks only', () => {
    const r = planTaskReminders([task('a', { act_by: '2026-10-20' }), task('b', { act_by: '2026-10-20', status: 'done' }), task('c', { act_by: '2026-10-20', assignee_id: 'x' }), task('d')], ME, text);
    expect(r.map((x) => [x.id, x.fireAt])).toEqual([
      ['task-soon:a:2026-10-20', '2026-10-19T10:00:00+05:30'], ['task-today:a:2026-10-20', '2026-10-20T10:00:00+05:30']]);
  });
  it('feeds the ReminderScheduler (pinned clock)', () => {
    const s = new ReminderScheduler({ now: () => Date.parse('2026-10-19T00:00:00Z'), show: () => undefined, prefs: defaultPrefs });
    const up = s.upcoming(planTaskReminders([task('a', { act_by: '2026-10-20' })], ME, text));
    expect(up.map((x) => x.reminder.id)).toEqual(['task-soon:a:2026-10-20', 'task-today:a:2026-10-20']);
  });
});

describe('to-dos', () => {
  it('validates and builds insert patches', () => {
    expect(buildTodoPatch(' ', '')).toEqual({ ok: false, error: 'title' });
    expect(buildTodoPatch('x', '2026/10/01')).toEqual({ ok: false, error: 'due' });
    expect(buildTodoPatch(' Call ', '2026-10-20')).toEqual({ ok: true, patch: { title: 'Call', done: false, due_at: '2026-10-20T12:30:00.000Z', sort: 0 } });
  });
  it('sorts open by due then done; toggles stamp done_at', () => {
    const td = (id: string, dueAt: string | null, done = false): TodoItem => ({ id, title: id, dueAt, done, taskId: null, sort: 0 });
    expect(sortTodos([td('d', null, true), td('n', null), td('b', '2026-10-02'), td('a', '2026-10-01')]).map((x) => x.id)).toEqual(['a', 'b', 'n', 'd']);
    const now = new Date('2026-10-15T00:00:00Z');
    expect(todoTogglePatch(td('a', null), now)).toEqual({ done: true, done_at: now.toISOString() });
    expect(todoTogglePatch(td('a', null, true), now)).toEqual({ done: false, done_at: null });
  });
});
