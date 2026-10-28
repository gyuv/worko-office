import { describe, expect, it } from 'vitest';
import { can, canTask, closeError, SYSTEM_ROLES, taskChangeError, taskCtx, type Actor, type ClientVisibility, type TaskState } from './index.js';

const role = (k: string) => SYSTEM_ROLES.find((r) => r.key === k)!;
const actor = (userId: string, k: string, extra: Partial<Actor> = {}): Actor => ({ userId, teamIds: [], branchId: 'b1', roles: [role(k)], ...extra });
const client = (x: Partial<ClientVisibility> = {}): ClientVisibility => ({
  branchId: 'b1', partnerId: 'p', managerId: 'm', teamId: 't1', staffIds: ['s'], groupIds: [], sensitive: false, allowedUserIds: [], ...x,
});
const people = { leaderId: null, managerId: null, assigneeId: null, reviewerId: null };

describe('taskCtx', () => {
  it('counts task people as owners alongside client owners', () => {
    const ctx = taskCtx({ ...people, assigneeId: 'a', reviewerId: 'r' }, client());
    expect(ctx.ownerUserIds?.sort()).toEqual(['a', 'm', 'p', 'r', 's']);
    expect(ctx.teamId).toBe('t1');
  });
  it('own-scope article works on tasks assigned to them, not others', () => {
    const art = actor('a', 'article');
    expect(can(art, 'tasks', 'edit', taskCtx({ ...people, assigneeId: 'a' }, client({ staffIds: ['a'] })))).toBe(true);
    expect(can(art, 'tasks', 'view', taskCtx({ ...people, assigneeId: 'x' }, client()))).toBe(false);
  });
  it('canTask also needs clients:view on the client', () => {
    const art = actor('a', 'article');
    // Assigned, but not staff on the client → cannot see the client → cannot see the task.
    expect(canTask(art, 'view', { ...people, assigneeId: 'a' }, client())).toBe(false);
    expect(canTask(art, 'view', { ...people, assigneeId: 'a' }, client({ staffIds: ['a'] }))).toBe(true);
    // Sensitive client: even the partner role needs the allow-list.
    expect(canTask(actor('p2', 'partner'), 'view', people, client({ sensitive: true, allowedUserIds: ['p'] }))).toBe(false);
  });
  it('firm tasks: all scope or task people only (branch scope does not reach them)', () => {
    const branchRole = { key: 'b', name: 'b', system: false, grants: [{ module: 'tasks' as const, action: 'view' as const, scope: 'branch' as const }] };
    expect(canTask(actor('x', 'partner'), 'view', people, null)).toBe(true);
    expect(canTask({ userId: 'x', teamIds: [], branchId: 'b1', roles: [branchRole] }, 'view', people, null)).toBe(false);
    expect(canTask(actor('a', 'article'), 'view', { ...people, assigneeId: 'a' }, null)).toBe(true);
    expect(canTask(actor('m', 'manager', { teamIds: ['t1'] }), 'view', people, null)).toBe(false);
  });
});

describe('task rules', () => {
  const base: TaskState = { status: 'open', reviewerId: null, checks: [{ key: 'k', label: 'K', required: true, done: false }], pendingIssue: null, outcome: null, statutoryDue: '2026-10-20', actBy: '2026-10-15' };
  it('done needs required checks; review needs reviewer; pending needs an issue', () => {
    expect(taskChangeError(base, { ...base, status: 'done' })).toBe('required_checks_pending');
    expect(taskChangeError(base, { ...base, status: 'done', checks: [{ ...base.checks[0]!, done: true }] })).toBeNull();
    expect(taskChangeError(base, { ...base, status: 'review' })).toBe('reviewer_required');
    expect(taskChangeError(base, { ...base, status: 'review', reviewerId: 'r' })).toBeNull();
    expect(taskChangeError(base, { ...base, status: 'pending_client' })).toBe('pending_issue_required');
    expect(taskChangeError(base, { ...base, actBy: '2026-10-21' })).toBe('act_by_after_due');
    expect(taskChangeError({ ...base, outcome: 'free' }, base)).toBe('task_closed');
  });
  it('close: billed/free only when done; deleted any time', () => {
    expect(closeError(base, 'billed')).toBe('task_not_done');
    expect(closeError(base, 'deleted')).toBeNull();
    expect(closeError({ ...base, status: 'done' }, 'free')).toBeNull();
    expect(closeError({ ...base, status: 'done', outcome: 'billed' }, 'free')).toBe('task_closed');
  });
});
