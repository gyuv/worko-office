import { describe, expect, it } from 'vitest';
import { agentStates, aiFeatureVisible, allowedActions, approveBody, dryRunSummary, groupRunActions, routeForCategory, scheduleText, toRuleItem, toRunAction, toSuggestion, transition } from './automation';
import { retryBody, retryOutcome } from './automation';

const grants = [{ module: 'ai', action: 'create', scope: 'all' }];
const on = { noAiMode: false, features: { draft_reply: 'ok', summarise: 'feature_disabled' }, firmCapReached: false, userCapReached: false, mock: true };

describe('AI button visibility', () => {
  it('needs an ok gate, budget left and ai:create; hidden on error', () => {
    expect(aiFeatureVisible(on, 'draft_reply', grants)).toBe(true);
    expect(aiFeatureVisible(on, 'summarise', grants)).toBe(false);
    expect(aiFeatureVisible({ ...on, features: { draft_reply: 'ai_disabled' } }, 'draft_reply', grants)).toBe(false);
    expect(aiFeatureVisible({ ...on, noAiMode: true }, 'draft_reply', grants)).toBe(false);
    expect(aiFeatureVisible({ ...on, firmCapReached: true }, 'draft_reply', grants)).toBe(false);
    expect(aiFeatureVisible({ ...on, userCapReached: true }, 'draft_reply', grants)).toBe(false);
    expect(aiFeatureVisible({}, 'draft_reply', grants)).toBe(false);
    expect(aiFeatureVisible(on, 'draft_reply', [{ module: 'ai', action: 'create', scope: 'none' }])).toBe(false);
    expect(aiFeatureVisible(null, 'draft_reply', grants)).toBe(false);
  });
});

describe('suggestions', () => {
  const s = toSuggestion({ id: 'a', kind: 'draft_reply', status: 'pending', payload: { subject: 'Re', body: 'Hello' }, sources: [{ type: 'comm_message', id: 'm' }], mock: true });
  it('transitions', () => {
    expect(allowedActions('pending')).toEqual(['approve', 'reject']);
    expect(transition('pending', 'approve')).toBe('approved');
    expect(transition('pending', 'reject')).toBe('rejected');
    expect(transition('approved', 'reject')).toBe('already_decided');
    expect(transition('failed', 'approve')).toBe('already_decided');
    expect(transition('failed', 'reject')).toBe('rejected');
  });
  it('approve body carries only edits and refuses empty text', () => {
    expect(approveBody(s, { body: 'Hello', subject: 'Re' })).toEqual({ ok: true, body: {} });
    expect(approveBody(s, { body: ' Hi there ' })).toEqual({ ok: true, body: { body: 'Hi there' } });
    expect(approveBody(s, { body: '  ' })).toEqual({ ok: false, error: 'empty_body' });
    expect(s.mock).toBe(true);
    expect(s.sources).toHaveLength(1);
  });
});

describe('dry-run summary', () => {
  it('counts matches, skips, refusals and cost in paise', () => {
    const r = dryRunSummary({ evaluated: 3, matched: 2, actions: 4, estimatedCostPaise: '150', refusals: { no_consent: 1, quiet_hours: 2 }, items: [{ skipped: null }, { skipped: 'ladder_wait' }, {}] });
    expect(r).toEqual({ evaluated: 3, matched: 2, skipped: 1, actions: 4, refused: 3, estimatedCostPaise: 150, refusals: [['quiet_hours', 2], ['no_consent', 1]] });
    expect(dryRunSummary(null).evaluated).toBe(0);
  });
});

describe('runs', () => {
  it('groups problems first and offers retry on failure', () => {
    const acts = [{ idx: 1, type: 'notify', status: 'done' }, { idx: 0, type: 'send_message', status: 'failed', error: 'x' }, { idx: 2, type: 'send_message', status: 'skipped', code: 'rate_limited' }].map(toRunAction);
    const g = groupRunActions(acts);
    expect(g.groups.map((x) => x.status)).toEqual(['failed', 'rate_limited', 'done']);
    expect(g.retryable).toBe(true);
    expect(groupRunActions([toRunAction({ idx: 0, status: 'done' })]).retryable).toBe(false);
  });
});

describe('rules, agents, schedule', () => {
  it('parses paused rules and joins agents', () => {
    const r = toRuleItem({ id: 'r', name: 'X', enabled: true, status: 'paused', pausedReason: '5 failures', agentKey: 'document_collection', definition: { trigger: { kind: 'schedule', schedule: { freq: 'daily', at: '09:00' } } } });
    expect(r.paused).toBe(true); expect(r.schedule?.freq).toBe('daily');
    const a = agentStates([{ key: 'document_collection', name: 'D', description: '' }, { key: 'other', name: 'O', description: '' }], [r]);
    expect(a[0]!.rule?.id).toBe('r'); expect(a[0]!.on).toBe(false); expect(a[1]!.rule).toBeNull();
  });
  it('schedule text uses IST', () => {
    // 2026-10-29 04:00 UTC = 09:30 IST → today's 09:00 slot has passed
    const x = scheduleText({ freq: 'daily', at: '09:00' }, new Date('2026-10-29T04:00:00Z'));
    expect(x).toEqual({ key: 'm.auto.sched.daily', params: { at: '09:00', day: '', next: '2026-10-30 09:00' }, weekday: null });
    const w = scheduleText({ freq: 'weekly', at: '18:30', weekday: 1 }, new Date('2026-10-29T04:00:00Z'));
    expect(w.weekday).toBe('mon'); expect(w.params.next).toBe('2026-11-02 18:30');
  });
  it('routes notification categories', () => {
    expect(routeForCategory('automation.alert', 'run1')).toEqual({ name: 'automation', runId: 'run1' });
    expect(routeForCategory('ai.suggestion')).toEqual({ name: 'aiInbox', id: undefined });
    expect(routeForCategory('task.due')).toBeNull();
  });
});

describe('optimistic retry', () => {
  it('sends attempts as last read and reports already_retried', () => {
    expect(retryBody({ attempts: 2 })).toEqual({ expectedAttempts: 2 });
    expect(retryBody(null)).toEqual({ expectedAttempts: 0 });
    expect(retryOutcome({ retried: 0, skipped: 'already_retried' })).toEqual({ kind: 'already' });
    expect(retryOutcome({ retried: 3 })).toEqual({ kind: 'retried', count: 3 });
  });
});
