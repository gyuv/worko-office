import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AutomationEngine } from '../src/automation/engine.js';
import { Clock } from '../src/common/clock.js';
import { JobQueueService } from '../src/jobs/job-queue.service.js';
import { bearer, bootApp, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
let P: Session; let M: Session; let S: Session;
let clock: Clock; let jobs: JobQueueService; let engine: AutomationEngine;
let clientA: string; let clientB: string; let clientC: string; let gstr3b: string;
const NOW = new Date('2026-10-29T10:00:00+05:30'); // Thursday 10:00 IST — outside client quiet hours
const H = (s: Session) => bearer(s.accessToken);
const day = (n: number, hhmm = '10:00') => new Date(new Date(`2026-10-29T${hhmm}:00+05:30`).getTime() + n * 86_400_000);
async function at(d: Date) { clock.set(d); }
/** Runs due jobs until the queue is empty (events → runs; automation may cause more events). */
async function flush(d = clock.now()) { for (let i = 0; i < 30; i++) if (!(await jobs.runOnce(50, d))) return; }
async function tick(d: Date) { await at(d); await engine.tick(P.tenantId, d); await flush(d); }
const rule = async (body: Record<string, unknown>, s: Session = P, code = 201) => (await t.http().post('/v1/automation/rules').set(H(s)).send({ scope: 'firm', enabled: true, ...body }).expect(code)).body;
const task = async (body: Record<string, unknown>, s: Session = P) => (await t.http().post('/v1/tasks').set(H(s)).send(body).expect(201)).body.id as string;
const runsOf = async (ruleId: string) => (await t.http().get(`/v1/automation/runs?ruleId=${ruleId}&limit=200`).set(H(P)).expect(200)).body.items as Array<Record<string, unknown>>;
const runActions = async (runId: string) => (await t.http().get(`/v1/automation/runs/${runId}`).set(H(P)).expect(200)).body.actions as Array<Record<string, unknown>>;
const notifyTo = (to: unknown[], title = 'Auto: {{task.title}}') => ({ type: 'notify', to, title });
const disable = (id: string) => t.http().post(`/v1/automation/rules/${id}/disable`).set(H(P)).expect(200);

beforeAll(async () => {
  t = await bootApp();
  clock = t.app.get(Clock); jobs = t.app.get(JobQueueService); engine = t.app.get(AutomationEngine);
  await at(NOW);
  P = await t.signup('autofirm');
  M = await t.addUser(P, 'autofirm', 'Mohan', 'manager');
  S = await t.addUser(P, 'autofirm', 'Sita', 'senior');
  await t.http().post('/v1/service-types/install-defaults').set(H(P)).expect(200);
  gstr3b = ((await t.http().get('/v1/service-types').set(H(P)).expect(200)).body as Array<{ id: string; key: string }>).find((x) => x.key === 'GSTR3B')!.id;
  const mk = async (name: string, email: string | null, extra: Record<string, unknown> = {}) => (await t.http().post('/v1/clients').set(H(P))
    .send({ name, entityType: 'PRIVATE_COMPANY', contacts: [{ name: `${name} Owner`, isPrimary: true, ...(email ? { email } : {}), phone: '+919876500001' }], ...extra }).expect(201)).body.id as string;
  clientA = await mk('Alpha Traders', 'alpha@alpha.example', { staffIds: [S.userId], managerId: M.userId, partnerId: P.userId });
  clientB = await mk('Beta Hidden Pvt Ltd', 'beta@beta.example');
  clientC = await mk('Gamma Optout LLP', 'gamma@gamma.example', { staffIds: [S.userId], managerId: M.userId });
  await t.http().post('/v1/comm/consents').set(H(P)).send({ clientId: clientC, channel: 'email', status: 'opted_out', source: 'email' }).expect(201);
}, 90_000);
afterAll(() => t?.close());

describe('rules: validation, scope and permissions', () => {
  it('validates definitions with zod, scopes firm vs personal rules', async () => {
    const bad = await rule({ name: 'bad', definition: { trigger: { kind: 'event', event: 'task.created' }, conditions: { field: 'client.nope', op: 'eq', value: 1 }, actions: [notifyTo(['owner'])] } }, P, 400);
    expect(bad.code).toBe('invalid_rule');
    // Managers hold automation at team scope: firm-wide rules need 'all'.
    await rule({ name: 'm firm', definition: { trigger: { kind: 'event', event: 'task.created' }, actions: [notifyTo(['owner'])] } }, M, 403);
    // Seniors have no automation module at all.
    await t.http().get('/v1/automation/rules').set(H(S)).expect(403);
    const pers = await rule({ name: 'mine', scope: 'personal', enabled: false, definition: { trigger: { kind: 'event', event: 'task.created' }, actions: [{ type: 'send_message', channel: 'email', subject: 's', body: 'b' }] } }, M, 400);
    expect(pers.code).toBe('personal_rule_action');
    const ok = await rule({ name: 'my nudges', scope: 'personal', enabled: false, definition: { trigger: { kind: 'event', event: 'task.overdue' }, actions: [notifyTo(['owner'])] } }, M);
    expect(ok).toMatchObject({ scope: 'personal', ownerId: M.userId, version: 1, enabled: false });
    // Partner sees it (firm-wide automation:view); a personal rule is managed by its owner only.
    expect((await t.http().get(`/v1/automation/rules/${ok.id}`).set(H(P)).expect(200)).body.name).toBe('my nudges');
    await t.http().post(`/v1/automation/rules/${ok.id}/enable`).set(H(P)).expect(403);
    const v2 = (await t.http().patch(`/v1/automation/rules/${ok.id}`).set(H(M)).send({ definition: { trigger: { kind: 'event', event: 'task.overdue' }, actions: [notifyTo(['owner'], 'Late: {{task.title}}')] }, note: 'title' }).expect(200)).body;
    expect(v2.version).toBe(2);
    expect((await t.http().get(`/v1/automation/rules/${ok.id}/versions`).set(H(M)).expect(200)).body.items.map((x: { version: number }) => x.version)).toEqual([2, 1]);
    await t.http().delete(`/v1/automation/rules/${ok.id}`).set(H(M)).expect(204);
    const audit = await t.sql<{ action: string }>(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY seq`, [ok.id]);
    expect(audit.map((a) => a.action)).toEqual(['automation.rule_created', 'automation.rule_updated', 'automation.rule_deleted']);
  });
});

describe('event outbox', () => {
  it('writes events only when a rule listens, in the source transaction; exactly once per rule × event', async () => {
    const before = (await t.sql<{ n: number }>(`SELECT count(*)::int AS n FROM automation_event`))[0]!.n;
    await task({ client_id: clientA, title: 'No listener yet' });
    expect((await t.sql<{ n: number }>(`SELECT count(*)::int AS n FROM automation_event`))[0]!.n).toBe(before);
    const r = await rule({ name: 'tell owner', definition: { trigger: { kind: 'event', event: 'task.created' }, actions: [notifyTo(['owner'])] } });
    const tid = await task({ client_id: clientA, title: 'Listened' });
    const [ev] = await t.sql<{ id: string; type: string; client_id: string; causation: unknown }>(`SELECT id, type, client_id, causation FROM automation_event WHERE entity_id = $1`, [tid]);
    expect(ev).toMatchObject({ type: 'task.created', client_id: clientA, causation: null });
    expect((await t.sql(`SELECT 1 FROM job_queue WHERE kind = 'automation.event' AND ref_id = $1`, [ev!.id])).length).toBe(1);
    await flush();
    // Re-delivery (and a concurrent one) never runs the rule twice.
    await Promise.all([engine.processEvent(P.tenantId, ev!.id, NOW), engine.processEvent(P.tenantId, ev!.id, NOW)]);
    const runs = (await runsOf(r.id)).filter((x) => x.entityId === tid);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'succeeded', actionsDone: 1 });
    expect((await t.sql(`SELECT 1 FROM notification WHERE category = 'automation.alert' AND entity_id = $1`, [tid])).length).toBe(1);
    // The action ran as the owner through the normal path: audit shows the automation device.
    await disable(r.id);
  });
});

describe('Document Collection Agent', () => {
  let ruleId: string; let tA: string; let tC: string;
  it('turning it on instantiates defaults and returns a dry-run preview', async () => {
    tA = await task({ client_id: clientA, service_type_id: gstr3b, title: 'GSTR-3B Oct 2026', statutory_due: '2026-11-05', assignee_id: S.userId });
    tC = await task({ client_id: clientC, service_type_id: gstr3b, title: 'GSTR-3B Oct 2026 (Gamma)', statutory_due: '2026-11-06', assignee_id: S.userId, manager_id: M.userId });
    const agents = (await t.http().get('/v1/automation/agents').set(H(M)).expect(200)).body.items as Array<{ key: string }>;
    expect(agents.map((a) => a.key)).toEqual(expect.arrayContaining(['document_collection', 'overdue_nudger', 'invoice_followup', 'renewal_reminder', 'hearing_prep', 'client_onboarding', 'portal_upload_triage']));
    await t.http().post('/v1/automation/agents/document_collection/enable').set(H(M)).send({}).expect(403);
    const r = (await t.http().post('/v1/automation/agents/document_collection/enable').set(H(P)).send({ params: { serviceKeys: ['GSTR3B'], everyDays: 3, maxReminders: 2 } }).expect(201)).body;
    ruleId = r.rule.id;
    expect(r.rule).toMatchObject({ agentKey: 'document_collection', enabled: true, triggerEvent: 'compliance.due_soon' });
    const a = r.preview.items.find((i: { entity: { id: string } }) => i.entity.id === tA);
    expect(a).toMatchObject({ matched: true, step: 'first' });
    expect(a.actions.map((x: { type: string }) => x.type)).toEqual(['set_task_status', 'send_message']);
    expect(a.actions[1]).toMatchObject({ wouldRefuse: null, details: { address: expect.stringContaining('•••') } });
    const c = r.preview.items.find((i: { entity: { id: string } }) => i.entity.id === tC);
    expect(c.actions[1].wouldRefuse).toBe('opted_out');
    expect(r.preview.refusals).toMatchObject({ opted_out: 1 });
  });

  it('dry-run has zero side effects', async () => {
    const tables = ['task', 'comm_message', 'notification', 'automation_run', 'automation_run_action', 'automation_event', 'automation_subject', 'audit_log', 'suggestion', 'job_queue', 'ai_usage'];
    const snap = async () => Object.fromEntries(await Promise.all(tables.map(async (x) => [x, (await t.sql<{ n: number; v: number }>(`SELECT count(*)::int AS n, COALESCE(sum(version), 0)::int AS v FROM ${x === 'job_queue' || x === 'audit_log' ? `${x}, LATERAL (SELECT 0 AS version) z` : x}`))[0]])));
    const before = await snap();
    const d = (await t.http().post(`/v1/automation/rules/${ruleId}/dry-run`).set(H(P)).send({ limit: 50 }).expect(200)).body;
    expect(d.matched).toBeGreaterThanOrEqual(2);
    const one = (await t.http().post(`/v1/automation/rules/${ruleId}/dry-run`).set(H(P)).send({ entityId: tA }).expect(200)).body;
    expect(one.items).toHaveLength(1);
    await t.http().post('/v1/automation/dry-run').set(H(P)).send({ definition: { trigger: { kind: 'event', event: 'task.created' }, actions: [{ type: 'create_task', title: 'x' }] } }).expect(200);
    expect(await snap()).toEqual(before);
    expect((await t.http().get(`/v1/tasks/${tA}`).set(H(P))).body.status).toBe('open');
  });

  it('asks, reminds on a ladder, stops on upload; refusals are recorded; escalates when nothing arrives', async () => {
    await tick(NOW);
    let task_ = (await t.http().get(`/v1/tasks/${tA}`).set(H(P)).expect(200)).body;
    expect(task_).toMatchObject({ status: 'pending_client', pendingIssue: expect.stringContaining('GSTR-3B Oct 2026') });
    const msgs = async (cid: string) => t.sql<{ status: string; device_id: string }>(`SELECT status, created_by FROM comm_message WHERE client_id = $1 AND direction = 'out' AND channel = 'email'`, [cid]);
    expect(await msgs(clientA)).toHaveLength(1);
    // Gamma opted out: the send is refused by comm and recorded, the rest of the run continues.
    const gRun = (await runsOf(ruleId)).find((x) => x.entityId === tC)!;
    expect(gRun.status).toBe('partial');
    expect((await runActions(gRun.id as string)).map((x) => [x.type, x.status, x.code])).toEqual([['set_task_status', 'done', null], ['send_message', 'refused', 'opted_out']]);
    expect(await msgs(clientC)).toHaveLength(0);
    // Next day: ladder waits. Same day again: the scan is idempotent.
    await tick(day(0, '15:00'));
    await tick(day(1));
    expect(await msgs(clientA)).toHaveLength(1);
    // +3 days: second reminder (task stays pending_client — status action is first-step only).
    await tick(day(3));
    expect(await msgs(clientA)).toHaveLength(2);
    // The client uploads → the ladder stops for that client.
    await at(day(3, '12:00'));
    await t.http().post('/v1/documents').set(H(P)).field('clientId', clientA).field('category', 'GST').attach('file', Buffer.from('sales register'), { filename: 'sales.txt', contentType: 'text/plain' }).expect(201);
    await flush();
    const [sub] = await t.sql<{ stop_reason: string; steps: number }>(`SELECT stop_reason, steps FROM automation_subject WHERE rule_id = $1 AND entity_id = $2`, [ruleId, tA]);
    expect(sub).toMatchObject({ stop_reason: 'document.uploaded', steps: 2 });
    expect((await runsOf(ruleId)).some((x) => x.step === 'stop' && String(x.skipReason).startsWith('stopped 1'))).toBe(true);
    await tick(day(6));
    expect(await msgs(clientA)).toHaveLength(2);
    // Gamma never sent anything: after maxReminders the assignee + manager are escalated to, once.
    const esc = await t.sql<{ user_id: string }>(`SELECT user_id FROM notification WHERE category = 'automation.alert' AND entity_id = $1 ORDER BY user_id`, [tC]);
    expect(esc.map((x) => x.user_id).sort()).toEqual([S.userId, M.userId].sort());
    await tick(day(9));
    expect((await t.sql(`SELECT 1 FROM notification WHERE category = 'automation.alert' AND entity_id = $1`, [tC])).length).toBe(2);
    task_ = (await t.http().get(`/v1/tasks/${tA}`).set(H(P))).body;
    const aud = await t.sql<{ device_id: string; actor_id: string }>(`SELECT device_id, actor_id FROM audit_log WHERE entity_id = $1 AND action = 'task.updated'`, [tA]);
    expect(aud[0]).toMatchObject({ device_id: `automation:${ruleId}`, actor_id: P.userId });
    await disable(ruleId);
    await at(NOW);
  });
});

describe('actions go through the services', () => {
  it('UDIN gate refuses a status change and the refusal is recorded', async () => {
    const eng = (await t.http().post('/v1/audit/engagements').set(H(P)).send({ clientId: clientA, fy: '2025-26', auditType: 'statutory', udinRequired: true }).expect(201)).body.id;
    const taskId = (await t.http().get(`/v1/audit/engagements/${eng}`).set(H(P)).expect(200)).body.taskId as string;
    const r = await rule({ name: 'auto-close reviewed', definition: { trigger: { kind: 'event', event: 'task.status_changed' }, conditions: { field: 'task.status', op: 'eq', value: 'review' },
      actions: [{ type: 'set_task_status', status: 'done' }] } });
    await t.http().patch(`/v1/tasks/${taskId}`).set(H(P)).send({ status: 'review', reviewer_id: P.userId }).expect(204);
    await flush();
    const run = (await runsOf(r.id)).find((x) => x.entityId === taskId)!;
    expect((await runActions(run.id as string))[0]).toMatchObject({ status: 'refused', code: 'udin_required' });
    expect((await t.http().get(`/v1/tasks/${taskId}`).set(H(P))).body.status).toBe('review');
    await disable(r.id);
  });

  it('quiet hours defer, marketing needs opt-in, cost caps block', async () => {
    const wa = (await t.http().post('/v1/comm/templates').set(H(P)).send({ name: 'promo_offer', channel: 'whatsapp', category: 'marketing', body: 'New service for {{client.name}}' }).expect(201)).body.id;
    await t.http().post(`/v1/comm/templates/${wa}/submit`).set(H(P)).expect(200);
    await t.http().post(`/v1/comm/templates/${wa}/decide`).set(H(P)).send({ approve: true }).expect(200);
    const r = await rule({ name: 'messages', definition: { trigger: { kind: 'event', event: 'task.created' }, conditions: { field: 'task.title', op: 'contains', value: 'msgtest' },
      actions: [{ type: 'send_message', channel: 'email', subject: 'Hello', body: 'Started {{task.title}}' }, { type: 'send_message', channel: 'whatsapp', templateId: wa },
        { type: 'send_message', channel: 'sms', body: 'Started {{task.title}}' }], limits: { monthlyCostCapPaise: 0 } } });
    await at(new Date('2026-10-29T23:00:00+05:30'));
    const tid = await task({ client_id: clientA, title: 'msgtest late' });
    await flush();
    const run = (await runsOf(r.id)).find((x) => x.entityId === tid)!;
    const acts = await runActions(run.id as string);
    expect(acts[0]).toMatchObject({ status: 'queued', result: { status: 'queued', sendAt: new Date('2026-10-30T08:00:00+05:30').toISOString() } });
    expect(acts[1]).toMatchObject({ status: 'refused', code: 'cost_cap' }); // WhatsApp costs paise; this rule's cap is 0
    expect(acts[2]).toMatchObject({ status: 'refused', code: 'cost_cap' });
    await t.http().patch(`/v1/automation/rules/${r.id}`).set(H(P)).send({ definition: { trigger: { kind: 'event', event: 'task.created' }, conditions: { field: 'task.title', op: 'contains', value: 'msgtest' },
      actions: [{ type: 'send_message', channel: 'whatsapp', templateId: wa }] } }).expect(200);
    await at(NOW);
    const t2 = await task({ client_id: clientA, title: 'msgtest marketing' });
    await flush();
    const run2 = (await runsOf(r.id)).find((x) => x.entityId === t2)!;
    expect((await runActions(run2.id as string))[0]).toMatchObject({ status: 'refused', code: 'not_opted_in' });
    await disable(r.id);
  });
});

describe('safety', () => {
  it('loop prevention: no self-trigger, causation chain recorded', async () => {
    const def = (n: string) => ({ trigger: { kind: 'event', event: 'task.created' }, conditions: { field: 'task.title', op: 'contains', value: 'loop' }, actions: [{ type: 'create_task', title: `{{task.title}} ${n}` }] });
    const a = await rule({ name: 'loop A', definition: def('A') });
    const b = await rule({ name: 'loop B', definition: def('B') });
    await task({ client_id: clientA, title: 'loop seed' });
    await flush();
    const titles = (await t.sql<{ title: string }>(`SELECT title FROM task WHERE title LIKE 'loop seed%' ORDER BY title`)).map((x) => x.title);
    expect(titles).toEqual(['loop seed', 'loop seed A', 'loop seed A B', 'loop seed B', 'loop seed B A']);
    const skips = [...await runsOf(a.id), ...await runsOf(b.id)].filter((x) => x.status === 'skipped').map((x) => x.skipReason);
    expect(skips).toEqual(Array(6).fill('self_trigger'));
    const [deep] = await t.sql<{ causation: { chain: string[]; depth: number } }>(`SELECT e.causation FROM automation_event e JOIN task t ON t.id = e.entity_id WHERE t.title = 'loop seed A B'`);
    expect(deep!.causation).toMatchObject({ chain: [a.id, b.id], depth: 2 });
    await disable(a.id); await disable(b.id);
  });

  it('rate limit per day, pause after repeated failures (owner told), resume and retry', async () => {
    const lim = await rule({ name: 'limited', definition: { trigger: { kind: 'event', event: 'task.created' }, conditions: { field: 'task.title', op: 'contains', value: 'ratelimit' },
      actions: [notifyTo(['owner'])], limits: { maxActionsPerDay: 2 } } });
    for (const i of [1, 2, 3]) await task({ client_id: clientA, title: `ratelimit ${i}` });
    await flush();
    const st = (await Promise.all((await runsOf(lim.id)).map((r) => runActions(r.id as string)))).map((x) => x[0]!.status).sort();
    expect(st).toEqual(['done', 'done', 'rate_limited']);
    await disable(lim.id);

    const bad = await rule({ name: 'broken', definition: { trigger: { kind: 'event', event: 'task.created' }, conditions: { field: 'task.title', op: 'contains', value: 'breakme' },
      actions: [{ type: 'create_task', title: 'x', assignee: { userId: '00000000-0000-4000-8000-000000000001' } }], limits: { pauseAfterFailures: 2 } } });
    await task({ client_id: clientA, title: 'breakme 1' }); await flush();
    await task({ client_id: clientA, title: 'breakme 2' }); await flush();
    const got = (await t.http().get(`/v1/automation/rules/${bad.id}`).set(H(P)).expect(200)).body;
    expect(got).toMatchObject({ status: 'paused', pausedReason: 'repeated_failures', consecutiveFailures: 2 });
    expect((await t.sql(`SELECT 1 FROM notification WHERE category = 'automation.failed' AND entity_id = $1 AND user_id = $2`, [bad.id, P.userId])).length).toBe(1);
    // Paused rules get no events.
    await task({ client_id: clientA, title: 'breakme 3' }); await flush();
    expect(await runsOf(bad.id)).toHaveLength(2);
    const failed = (await runsOf(bad.id))[0]!;
    // Retry goes through the same gates: a paused rule does nothing.
    expect((await t.http().post(`/v1/automation/runs/${failed.id}/retry`).set(H(P)).expect(200)).body).toMatchObject({ retried: 0, skipped: 'rule_inactive' });
    await t.http().post(`/v1/automation/rules/${bad.id}/resume`).set(H(P)).expect(200);
    expect((await t.http().get(`/v1/automation/rules/${bad.id}`).set(H(P))).body).toMatchObject({ status: 'active', consecutiveFailures: 0 });
    // Concurrent retries: each failed action is claimed once.
    const [r1, r2] = await Promise.all([1, 2].map(() => t.http().post(`/v1/automation/runs/${failed.id}/retry`).set(H(P)).expect(200)));
    expect(r1!.body.retried + r2!.body.retried).toBe(1);
    expect((await runActions(failed.id as string))[0]).toMatchObject({ status: 'failed', attempts: 2 });
    await disable(bad.id);
  });

  it('never acts on clients the owner cannot see; firm kill switch', async () => {
    // Manager's personal rule: Beta is not on the manager's team.
    const r = await rule({ name: 'm personal', scope: 'personal', definition: { trigger: { kind: 'event', event: 'task.created' }, conditions: { field: 'task.title', op: 'contains', value: 'scope' }, actions: [notifyTo(['owner'])] } }, M);
    await task({ client_id: clientB, title: 'scope beta' }); await flush();
    expect((await t.http().get(`/v1/automation/runs?ruleId=${r.id}`).set(H(M)).expect(200)).body.items[0]).toMatchObject({ status: 'skipped', skipReason: 'outside_owner_scope' });
    await t.http().put('/v1/automation/settings').set(H(M)).send({ enabled: false }).expect(403);
    await t.http().put('/v1/automation/settings').set(H(P)).send({ enabled: false }).expect(200);
    await task({ client_id: clientA, title: 'scope alpha' }); await flush();
    expect((await t.http().get(`/v1/automation/runs?ruleId=${r.id}`).set(H(M))).body.items[0]).toMatchObject({ status: 'skipped', skipReason: 'automation_off' });
    await t.http().put('/v1/automation/settings').set(H(P)).send({ enabled: true }).expect(200);
    await t.http().post(`/v1/automation/rules/${r.id}/disable`).set(H(M)).expect(200);
  });

  it('schedule triggers run once per IST slot', async () => {
    const r = await rule({ name: 'monday digest', definition: { trigger: { kind: 'schedule', schedule: { freq: 'daily', at: '09:00' } }, actions: [{ type: 'notify', to: ['owner'], title: 'Daily digest' }] } });
    expect(new Date(r.nextRunAt).toISOString()).toBe(new Date('2026-10-30T09:00:00+05:30').toISOString());
    await tick(new Date('2026-10-30T08:59:00+05:30'));
    expect(await runsOf(r.id)).toHaveLength(0);
    await tick(new Date('2026-10-30T09:05:00+05:30'));
    await tick(new Date('2026-10-30T09:20:00+05:30'));
    expect(await runsOf(r.id)).toHaveLength(1);
    expect((await t.http().get(`/v1/automation/rules/${r.id}`).set(H(P))).body.nextRunAt).toBe(new Date('2026-10-31T09:00:00+05:30').toISOString());
    await disable(r.id);
    await at(NOW);
  });

  it('cost meter per rule and month', async () => {
    const c = (await t.http().get('/v1/automation/costs?month=2026-10').set(H(P)).expect(200)).body;
    expect(c).toMatchObject({ month: '2026-10', capPaise: 500_000 });
    expect(c.items.find((i: { name: string }) => i.name === 'Document Collection Agent')).toMatchObject({ commPaise: 0, actions: expect.any(Number) });
  });
});

describe('phase 10 review regressions', () => {
  const simple = (title: string, actions: unknown[], limits: Record<string, unknown> = {}) => ({ trigger: { kind: 'event', event: 'task.created' }, conditions: { field: 'task.title', op: 'contains', value: title }, actions, limits });

  it('dry-run: custom definitions need manage rights; items the caller cannot see are counts only', async () => {
    const r = await rule({ name: 'dry leak', enabled: false, definition: simple('dryleak', [notifyTo(['owner'])]) });
    await task({ client_id: clientB, title: 'dryleak beta secret' });
    await task({ client_id: clientA, title: 'dryleak alpha' });
    await t.http().post(`/v1/automation/rules/${r.id}/dry-run`).set(H(M)).send({ definition: simple('', [notifyTo(['owner'])]) }).expect(403);
    const d = (await t.http().post(`/v1/automation/rules/${r.id}/dry-run`).set(H(M)).send({ limit: 100 }).expect(200)).body;
    expect(d.hidden).toBeGreaterThan(0);
    expect(JSON.stringify(d)).not.toContain('Beta Hidden');
    expect(JSON.stringify(d)).not.toContain('dryleak beta secret');
    expect(d.items.every((i: { clientId: string | null }) => i.clientId !== clientB)).toBe(true);
    const draft = (await t.http().post('/v1/automation/dry-run').set(H(M)).send({ scope: 'personal', definition: simple('dryleak', [notifyTo(['owner'])]), limit: 100 }).expect(200)).body;
    expect(JSON.stringify(draft)).not.toContain('Beta Hidden');
    await disable(r.id);
  });

  it('editing a firm rule makes the editor its owner; non-owners need the action permissions to enable/edit', async () => {
    const P2 = await t.addUser(P, 'autofirm', 'Prakash', 'partner');
    // A custom role: firm-wide automation manager with no tasks rights.
    const grants = ['view', 'create', 'edit'].map((action) => ({ module: 'automation', action, scope: 'all' }));
    await t.sql(`INSERT INTO role (id, tenant_id, key, name, system, grants) VALUES (gen_random_uuid(), $1, 'automator', 'Automator', false, $2)`, [P.tenantId, JSON.stringify(grants)]);
    const Ad = await t.addUser(P, 'autofirm', 'Asha', 'automator');
    const r = await rule({ name: 'owned', enabled: false, definition: simple('owned', [{ type: 'create_task', title: 'x' }]) });
    // Admin manages firm settings but holds no tasks permissions: can't borrow the owner's.
    expect((await t.http().post(`/v1/automation/rules/${r.id}/enable`).set(H(Ad)).expect(403)).body.code).toBe('missing_action_permission');
    expect((await t.http().patch(`/v1/automation/rules/${r.id}`).set(H(Ad)).send({ definition: simple('owned2', [{ type: 'create_task', title: 'y' }]) }).expect(403)).body.code).toBe('missing_action_permission');
    const upd = (await t.http().patch(`/v1/automation/rules/${r.id}`).set(H(P2)).send({ definition: simple('owned2', [{ type: 'create_task', title: 'y' }]) }).expect(200)).body;
    expect(upd.ownerId).toBe(P2.userId);
    const v = (await t.http().get(`/v1/automation/rules/${r.id}/versions`).set(H(P)).expect(200)).body.items[0];
    expect(v).toMatchObject({ version: 2, ownerId: P2.userId, previousOwnerId: P.userId });
    // A rename doesn't change the owner.
    expect((await t.http().patch(`/v1/automation/rules/${r.id}`).set(H(P)).send({ name: 'renamed' }).expect(200)).body.ownerId).toBe(P2.userId);
  });

  it('personal rules: lead scope is checked; notify only reaches users who can see the subject', async () => {
    const r = await rule({ name: 'm leads', scope: 'personal', definition: { trigger: { kind: 'event', event: 'lead.stage_changed' }, actions: [notifyTo(['owner'], 'Lead moved')] } }, M);
    const lead = (await t.http().post('/v1/leads').set(H(P)).send({ name: 'Partner Private Lead', source: 'referral', ownerId: P.userId }).expect(201)).body;
    await t.http().post(`/v1/leads/${lead.id}/move`).set(H(P)).send({ stage: 'contacted' }).expect(200);
    await flush();
    expect((await t.http().get(`/v1/automation/runs?ruleId=${r.id}`).set(H(M))).body.items[0]).toMatchObject({ status: 'skipped', skipReason: 'outside_owner_scope' });
    await t.http().post(`/v1/automation/rules/${r.id}/disable`).set(H(M)).expect(200);
    const n = await rule({ name: 'notify S', definition: simple('notifys', [notifyTo([{ userId: S.userId }])]) });
    const tid = await task({ client_id: clientB, title: 'notifys beta' }); // Sita is not on Beta
    await flush();
    const run = (await runsOf(n.id)).find((x) => x.entityId === tid)!;
    expect((await runActions(run.id as string))[0]).toMatchObject({ status: 'refused', code: 'no_recipient' });
    await disable(n.id);
  });

  it('crash recovery: a stale running run is resumed by the reaper without repeating committed actions', async () => {
    const r = await rule({ name: 'two notes', definition: simple('crashme', [notifyTo(['owner'], 'one'), notifyTo(['owner'], 'two')]) });
    const tid = await task({ client_id: clientA, title: 'crashme' });
    await flush();
    const run = (await runsOf(r.id)).find((x) => x.entityId === tid)!;
    // Simulate a crash after action 1's side effect but before its outcome was recorded.
    await t.sql(`UPDATE automation_run SET status = 'running', started_at = $2 WHERE id = $1`, [run.id, new Date(NOW.getTime() - 3_600_000)]);
    await t.sql(`DELETE FROM automation_run_action WHERE run_id = $1 AND idx = 1`, [run.id]);
    await tick(NOW);
    expect((await runsOf(r.id)).find((x) => x.entityId === tid)).toMatchObject({ status: 'succeeded', actionsDone: 2 });
    expect((await t.sql(`SELECT 1 FROM notification WHERE category = 'automation.alert' AND entity_id = $1`, [tid])).length).toBe(2);
    await disable(r.id);
  });

  it('daily action limit holds under concurrency', async () => {
    const r = await rule({ name: 'one a day', definition: simple('racer', [notifyTo(['owner'])], { maxActionsPerDay: 1 }) });
    await task({ client_id: clientA, title: 'racer 1' }); await task({ client_id: clientA, title: 'racer 2' });
    const evs = await t.sql<{ id: string }>(`SELECT e.id FROM automation_event e JOIN task t ON t.id = e.entity_id WHERE t.title LIKE 'racer %'`);
    await Promise.all(evs.map((e) => engine.processEvent(P.tenantId, e.id, NOW)));
    const st = (await Promise.all((await runsOf(r.id)).map((x) => runActions(x.id as string)))).map((x) => x[0]!.status).sort();
    expect(st).toEqual(['done', 'rate_limited']);
    await flush();
    await disable(r.id);
  });

  it('invoices inserted already issued emit invoice.issued', async () => {
    const r = await rule({ name: 'issued', enabled: true, definition: { trigger: { kind: 'event', event: 'invoice.issued' }, actions: [notifyTo(['owner'], 'Issued')] } });
    const [inv] = await t.sql<{ id: string }>(`INSERT INTO invoice (id, tenant_id, entity_id, client_id, status, kind, supply_type, supplier_state, number, fy, issue_date)
      SELECT gen_random_uuid(), $1, (SELECT id FROM firm_entity WHERE tenant_id = $1 LIMIT 1), $2, 'issued', 'invoice', 'intra', '27', 'IMP-1', 2026, '2026-10-29' RETURNING id`, [P.tenantId, clientA]);
    expect((await t.sql(`SELECT 1 FROM automation_event WHERE type = 'invoice.issued' AND entity_id = $1`, [inv!.id])).length).toBe(1);
    await flush();
    await disable(r.id);
  });
});
