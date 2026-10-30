import { conditionSchema, type Condition } from '@worko/domain';
import { createTranslator } from '@worko/i18n';
import { describe, expect, it } from 'vitest';
import { canRetry, endOfIstDay, fieldsFor, fromCondition, groupDryRun, leafErrors, lineDiff, opsFor, paramsFromRaw, scheduleText, toCondition, validateDefinition, type DryRun, type GroupNode } from './logic';

const t = createTranslator('en-IN');

describe('condition builder ↔ schema', () => {
  it('round-trips nested AND/OR/NOT with paise amounts and lists', () => {
    const c: Condition = { all: [
      { field: 'invoice.balancePaise', op: 'gte', value: 1_50_000_00 },
      { any: [{ field: 'client.tags', op: 'contains', value: 'vip' }, { field: 'invoice.status', op: 'in', value: ['issued', 'partially_paid'] }] },
      { not: { all: [{ field: 'client.portalEnabled', op: 'eq', value: true }] } },
      { field: 'invoice.dueDate', op: 'exists' },
    ] };
    const tree = fromCondition(c);
    const leaf = tree.children[0] as { raw: string };
    expect(leaf.raw).toBe('150000'); // shown in rupees
    const back = toCondition(tree);
    expect(back).toEqual(c);
    expect(conditionSchema.safeParse(back).success).toBe(true);
  });
  it('rupee text becomes paise; bad input is reported inline by the schema', () => {
    const g: GroupNode = { id: 'r', kind: 'group', mode: 'all', negate: false, children: [
      { id: 'a', kind: 'leaf', field: 'invoice.totalPaise', op: 'gt', raw: '5,000.50' },
      { id: 'b', kind: 'leaf', field: 'invoice.totalPaise', op: 'gt', raw: 'abc' },
      { id: 'c', kind: 'leaf', field: 'task.status', op: 'eq', raw: 'open' },
    ] };
    expect(toCondition(g)).toEqual({ all: [{ field: 'invoice.totalPaise', op: 'gt', value: 500050 }, { field: 'invoice.totalPaise', op: 'gt', value: 'abc' }, { field: 'task.status', op: 'eq', value: 'open' }] });
    const e = leafErrors(g, 'invoice.issued');
    expect(e.a).toBeUndefined();
    expect(e.b).toMatch(/compares with number/);
    expect(e.c).toBe('field_unavailable'); // task.* is not in an invoice.issued context
  });
  it('fields and operators are typed per trigger', () => {
    expect(fieldsFor('invoice.overdue')).toContain('event.daysOverdue');
    expect(fieldsFor('invoice.issued')).not.toContain('event.daysOverdue');
    expect(fieldsFor('lead.stage_changed')).not.toContain('client.name');
    expect(opsFor('boolean')).not.toContain('gt');
    expect(opsFor('string[]')).toEqual(['contains', 'exists', 'not_exists']);
  });
  it('validates whole definitions with the domain schema (action paths kept)', () => {
    const bad = validateDefinition({ trigger: { kind: 'event', event: 'lead.stage_changed' }, actions: [{ type: 'send_message', channel: 'email', body: 'Hi' }] }, 'firm');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.actions[0]?.join()).toMatch(/needs a client event/);
    const personal = validateDefinition({ trigger: { kind: 'event', event: 'task.created' }, actions: [{ type: 'add_timeline_note', body: 'x' }] }, 'personal');
    expect(personal.ok).toBe(false);
    expect(validateDefinition({ trigger: { kind: 'event', event: 'task.created' }, actions: [{ type: 'notify', to: ['owner'], title: 'x' }] }, 'personal').ok).toBe(true);
  });
});

describe('schedule preview (IST)', () => {
  const now = new Date('2026-10-29T10:00:00Z'); // 15:30 IST Thursday
  it('daily/weekly/monthly with next run in IST', () => {
    expect(scheduleText({ freq: 'daily', at: '09:00' }, t, now)).toMatch(/^Every day at 9:00 AM IST · next: 30 Oct 2026, 09:00 am/i);
    expect(scheduleText({ freq: 'weekly', at: '18:30', weekday: 1 }, t, now)).toMatch(/^Every Monday at 6:30 PM IST · next: 02 Nov 2026, 06:30 pm/i);
    expect(scheduleText({ freq: 'monthly', at: '00:15', monthDay: 5 }, t, now)).toMatch(/^On day 5 of every month at 12:15 AM IST · next: 05 Nov 2026, 12:15 am/i);
  });
  it('end of IST day for the run filter', () => expect(endOfIstDay('2026-10-29')).toBe('2026-10-29T18:30:00.000Z'));
});

describe('dry-run grouping', () => {
  const plan = (type: string, wouldRefuse: string | null, costPaise = 0) => ({ type, summary: '', wouldRefuse, costPaise, details: {} });
  const r: DryRun = { trigger: 'compliance.due_soon', asOf: '2026-10-29', evaluated: 4, matched: 2, actions: 4, estimatedCostPaise: 40, refusals: { opted_out: 1 }, monthToDateCostPaise: 49_990, capPaise: 50_000, items: [
    { entity: { type: 'task', id: '1' }, clientId: 'c1', clientName: 'A', step: 'first', skipped: null, matched: true, conditions: [], actions: [plan('set_task_status', null), plan('send_message', null, 40)] },
    { entity: { type: 'task', id: '2' }, clientId: 'c2', clientName: 'B', step: 'first', skipped: null, matched: true, conditions: [], actions: [plan('set_task_status', null), plan('send_message', 'opted_out')] },
    { entity: { type: 'task', id: '3' }, clientId: 'c3', clientName: 'C', step: 'wait', skipped: 'ladder_wait', matched: false, conditions: [], actions: [] },
    { entity: { type: 'task', id: '4' }, clientId: 'c4', clientName: 'D', step: 'first', skipped: null, matched: false, conditions: [{ field: 'task.status', op: 'in', ok: false, actual: 'done' }], actions: [] },
  ] };
  it('splits matched / skipped by reason / unmatched and counts messages, consent refusals, cap overrun', () => {
    const g = groupDryRun(r);
    expect(g.matched.map((i) => i.clientName)).toEqual(['A', 'B']);
    expect(Object.keys(g.skipped)).toEqual(['ladder_wait']);
    expect(g.unmatched.map((i) => i.clientName)).toEqual(['D']);
    expect(g.messages).toBe(1);
    expect(g.willDo).toBe(3);
    expect(g.consentRefusals).toBe(1);
    expect(g.overCap).toBe(true);
  });
});

describe('misc', () => {
  it('retry only for failed actions', () => {
    const a = (status: string) => ({ idx: 0, type: 'x', status, code: null, result: null, costPaise: 0, error: null, attempts: 1, finishedAt: null });
    expect(canRetry([a('done'), a('refused')])).toBe(false);
    expect(canRetry([a('failed')])).toBe(true);
  });
  it('line diff', () => expect(lineDiff('a\nb\nc', 'a\nc\nd').map((l) => l.op + l.text)).toEqual([' a', '-b', ' c', '+d']));
  it('agent params from form text', () => expect(paramsFromRaw({ serviceKeys: 'GSTR1, GSTR3B', leadDays: '7', channel: 'sms', templateId: '' }, { serviceKeys: [], leadDays: 10, channel: 'email' }, ['email', 'sms']))
    .toEqual({ serviceKeys: ['GSTR1', 'GSTR3B'], leadDays: 7, channel: 'sms' }));
});
