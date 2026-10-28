import { gstinCheckChar } from '@worko/domain';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobQueueService } from '../src/jobs/job-queue.service.js';
import { AutoTaskService } from '../src/tasks/auto.service.js';
import { systemActor } from '../src/tasks/system-actor.js';
import { bearer, bootApp, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
beforeAll(async () => { t = await bootApp(); }, 60_000);
afterAll(() => t?.close());

const H = (s: Session) => bearer(s.accessToken);
let seq = 3000;
function gstin() {
  const pan = `AAB CX${String(seq++).padStart(4, '0')}Z`.replace(' ', '');
  const base = `27${pan}1Z`;
  return base + gstinCheckChar(base);
}
async function client(s: Session, name: string, extra: Record<string, unknown> = {}) {
  const r = await t.http().post('/v1/clients').set(H(s)).send({ name, entityType: 'PRIVATE_COMPANY', registrations: [{ kind: 'GSTIN', number: gstin() }], ...extra }).expect(201);
  return r.body.id as string;
}
const services = async (s: Session) => (await t.http().get('/v1/service-types').set(H(s)).expect(200)).body as Array<{ id: string; key: string; ruleId: string | null; slaDays: number }>;
const subscribe = (s: Session, clientId: string, stId: string, body: Record<string, unknown> = {}) =>
  t.http().put(`/v1/clients/${clientId}/services/${stId}`).set(H(s)).send(body);
const tasks = async (s: Session, q = '') => (await t.http().get(`/v1/tasks?limit=1000${q}`).set(H(s)).expect(200)).body;
const pull = async (s: Session) => (await t.http().get('/v1/sync/pull?since=0&limit=1000').set(H(s)).expect(200)).body.changes as Array<{ table: string; id: string; deleted: boolean; fields: Record<string, unknown> }>;
const push = (s: Session, mutations: unknown[]) => t.http().post('/v1/sync/push').set(H(s)).send({ mutations }).expect(200).then((r) => r.body.results);
const tickAll = async (s: Session, id: string) => {
  const task = (await t.http().get(`/v1/tasks/${id}`).set(H(s)).expect(200)).body;
  for (const c of task.checks) await t.http().post(`/v1/tasks/${id}/checks`).set(H(s)).send({ key: c.key, done: true }).expect(204);
};

/** A firm with 4 GST clients subscribed to GSTR-3B and the people for the assignment-order test. */
async function firm(slug: string) {
  const p = await t.signup(slug);
  const art = await t.addUser(p, slug, 'Arti', 'article');
  const sen = await t.addUser(p, slug, 'Sanju', 'senior');
  const sen2 = await t.addUser(p, slug, 'Zoya', 'senior');
  const mgr = await t.addUser(p, slug, 'Mohan', 'manager');
  await t.http().post('/v1/service-types/install-defaults').set(H(p)).expect(200);
  const st = await services(p);
  const g3b = st.find((s) => s.key === 'GSTR3B')!;
  const a = await client(p, 'Alpha Pvt Ltd', { staffIds: [art.userId] });
  const b = await client(p, 'Beta Pvt Ltd', { staffIds: [sen.userId] });
  const c = await client(p, 'Gamma Pvt Ltd', { staffIds: [sen2.userId] });
  const d = await client(p, 'Delta Pvt Ltd', { managerId: mgr.userId });
  // A: subscription override → article. B/C: service default (Sanju) — C can't be seen by Sanju → falls to its staff. D: manager.
  await subscribe(p, a, g3b.id, { assigneeId: art.userId }).expect(200);
  for (const x of [b, c, d]) await subscribe(p, x, g3b.id).expect(200);
  await t.http().patch(`/v1/service-types/${g3b.id}`).set(H(p)).send({ assigneeId: sen.userId }).expect(204);
  return { p, art, sen, sen2, mgr, g3b, st, clients: { a, b, c, d } };
}

describe('service catalogue', () => {
  it('installs defaults idempotently, linked to the rule pack', async () => {
    const p = await t.signup('tk1');
    const first = (await t.http().post('/v1/service-types/install-defaults').set(H(p)).expect(200)).body;
    expect(first.created).toBeGreaterThan(10);
    expect((await t.http().post('/v1/service-types/install-defaults').set(H(p)).expect(200)).body).toEqual({ created: 0, skipped: first.created });
    const st = await services(p);
    expect(st.find((s) => s.key === 'GSTR3B')).toMatchObject({ ruleId: 'gst.gstr3b.monthly', slaDays: 3 });
    expect(st.find((s) => s.key === 'GSTR1')!.ruleId).toBeNull(); // two rules (monthly + QRMP) link by key
    expect(JSON.stringify(st)).not.toMatch(/price|amount|paise/i);
    const art = await t.addUser(p, 'tk1', 'Arti', 'article');
    await t.http().post('/v1/service-types/install-defaults').set(H(art)).expect(403);
    await t.http().post('/v1/service-types').set(H(p)).send({ key: 'GSTR3B', name: 'Dup', frequency: 'monthly' }).expect(409);
  });
});

describe('auto-creation', () => {
  it('preview equals commit, second commit creates nothing, assignment follows override → service default → client people', async () => {
    const f = await firm('tk2');
    const prev = (await t.http().post('/v1/tasks/auto/preview').set(H(f.p)).send({ month: '2026-09' }).expect(200)).body;
    expect(prev).toMatchObject({ month: '2026-09', toCreate: 4, skipped: 0 });
    const com = (await t.http().post('/v1/tasks/auto/commit').set(H(f.p)).send({ month: '2026-09' }).expect(200)).body;
    expect(com.created).toBe(4);
    expect((await t.http().post('/v1/tasks/auto/commit').set(H(f.p)).send({ month: '2026-09' }).expect(200)).body).toMatchObject({ created: 0, skipped: 4 });
    expect((await t.http().post('/v1/tasks/auto/preview').set(H(f.p)).send({ month: '2026-09' }).expect(200)).body).toMatchObject({ toCreate: 0, skipped: 4 });
    const list = (await tasks(f.p)).items as Array<Record<string, unknown>>;
    const by = (cid: string) => list.find((x) => x.clientId === cid)!;
    expect(by(f.clients.a)).toMatchObject({ assigneeId: f.art.userId, statutoryDue: '2026-10-20', actBy: '2026-10-17', status: 'open', source: 'auto', ruleId: 'gst.gstr3b.monthly', periodKey: '2026-09', title: 'GSTR-3B — Sep 2026' });
    expect(by(f.clients.b).assigneeId).toBe(f.sen.userId);
    expect(by(f.clients.c).assigneeId).toBe(f.sen2.userId);
    expect(by(f.clients.d)).toMatchObject({ assigneeId: f.mgr.userId, reviewerId: f.mgr.userId, managerId: f.mgr.userId });
    expect((by(f.clients.a).checks as unknown[]).length).toBeGreaterThan(2);
    // Deleted tasks are not resurrected by a re-run.
    await t.http().post(`/v1/tasks/${by(f.clients.b).id}/close`).set(H(f.p)).send({ outcome: 'deleted' }).expect(204);
    expect((await t.http().post('/v1/tasks/auto/commit').set(H(f.p)).send({ month: '2026-09' }).expect(200)).body.created).toBe(0);
    await t.http().get(`/v1/tasks/${by(f.clients.b).id}`).set(H(f.p)).expect(404);
    // Unsubscribed service → nothing; article can't run auto-creation.
    expect((await t.http().post('/v1/tasks/auto/preview').set(H(f.p)).send({ month: '2026-10' }).expect(200)).body.items.every((x: { serviceKey: string }) => x.serviceKey === 'GSTR3B')).toBe(true);
    await t.http().post('/v1/tasks/auto/commit').set(H(f.art)).send({ month: '2026-09' }).expect(403);
    const audit = (await t.http().get('/v1/audit?entity=task').set(H(f.p))).body;
    expect(audit.some((e: { action: string }) => e.action === 'task.auto_created')).toBe(true);
  });

  it('monthly job is idempotent and needs no wall clock', async () => {
    const f = await firm('tk3');
    const auto = t.app.get(AutoTaskService); const jobs = t.app.get(JobQueueService);
    const at = new Date('2026-10-01T03:00:00+05:30');
    expect(await auto.scheduleMonthly(at)).toBeGreaterThan(0);
    expect(await auto.scheduleMonthly(at)).toBe(0);
    await jobs.runOnce(500, at);
    const oct = (await tasks(f.p, '&dueFrom=2026-11-01&dueTo=2026-11-30')).items;
    expect(oct).toHaveLength(4); // GSTR-3B Oct 2026, due 20 Nov
    await jobs.runOnce(500, at); // rescheduled to next month: nothing runs
    expect((await auto.commit(systemActor(f.p.tenantId), '2026-10')).created).toBe(0);
    const [job] = await t.sql<{ run_at: Date }>(`SELECT run_at FROM job_queue WHERE kind = 'tasks.auto_month' AND tenant_id = $1`, [f.p.tenantId]);
    expect(job!.run_at.toISOString()).toBe('2026-10-31T20:30:00.000Z'); // 1 Nov 02:00 IST
    await jobs.runOnce(500, new Date('2026-11-01T02:00:00+05:30'));
    expect((await tasks(f.p, '&dueFrom=2026-12-01&dueTo=2026-12-31')).items).toHaveLength(4);
  });
});

describe('task rules and scope', () => {
  it('required checks block done; review needs a reviewer; every task ends billed/free/deleted', async () => {
    const p = await t.signup('tk4');
    await t.http().post('/v1/service-types/install-defaults').set(H(p)).expect(200);
    const g3b = (await services(p)).find((s) => s.key === 'GSTR3B')!;
    const cid = await client(p, 'Rules Pvt Ltd');
    const { id } = (await t.http().post('/v1/tasks').set(H(p)).send({ client_id: cid, service_type_id: g3b.id, period_key: '2026-08', title: 'GSTR-3B Aug', statutory_due: '2026-09-20' }).expect(201)).body;
    const r1 = await t.http().patch(`/v1/tasks/${id}`).set(H(p)).send({ status: 'done' }).expect(400);
    expect(r1.body.code).toBe('required_checks_pending');
    expect((await t.http().patch(`/v1/tasks/${id}`).set(H(p)).send({ status: 'review' }).expect(400)).body.code).toBe('reviewer_required');
    expect((await t.http().patch(`/v1/tasks/${id}`).set(H(p)).send({ status: 'pending_client' }).expect(400)).body.code).toBe('pending_issue_required');
    await t.http().patch(`/v1/tasks/${id}`).set(H(p)).send({ status: 'pending_client', pending_issue: 'Purchase register awaited' }).expect(204);
    await t.http().patch(`/v1/tasks/${id}`).set(H(p)).send({ act_by: '2026-09-25' }).expect(400);
    await t.http().patch(`/v1/tasks/${id}`).set(H(p)).send({ outcome: 'billed' }).expect(400); // not writable
    expect((await t.http().post(`/v1/tasks/${id}/close`).set(H(p)).send({ outcome: 'billed' }).expect(400)).body.code).toBe('task_not_done');
    await tickAll(p, id);
    const ticked = (await t.http().get(`/v1/tasks/${id}`).set(H(p))).body;
    expect(ticked.checks.every((c: { doneBy: string; doneAt: string }) => c.doneBy === p.userId && !!c.doneAt)).toBe(true);
    await t.http().patch(`/v1/tasks/${id}`).set(H(p)).send({ status: 'review', reviewer_id: p.userId }).expect(204);
    await t.http().patch(`/v1/tasks/${id}`).set(H(p)).send({ status: 'done' }).expect(204);
    expect((await t.http().get(`/v1/tasks/${id}`).set(H(p))).body.completedAt).toBeTruthy();
    await t.http().post(`/v1/tasks/${id}/close`).set(H(p)).send({ outcome: 'free', note: 'Retainer' }).expect(204);
    expect((await t.http().get(`/v1/tasks/${id}`).set(H(p))).body).toMatchObject({ outcome: 'free', outcomeNote: 'Retainer' });
    expect((await t.http().patch(`/v1/tasks/${id}`).set(H(p)).send({ title: 'x' }).expect(400)).body.code).toBe('task_closed');
    await t.http().post(`/v1/tasks/${id}/close`).set(H(p)).send({ outcome: 'billed' }).expect(400);
    // Devices can't delete a task directly.
    const [res] = await push(p, [{ key: randomUUID(), table: 'task', id, baseVersion: 99, patch: {}, delete: true }]);
    expect(res.status).toBe('rejected');
  });

  it('assignee (own scope) works their task; articles cannot see others (404); people must see the client', async () => {
    const f = await firm('tk5');
    await t.http().post('/v1/tasks/auto/commit').set(H(f.p)).send({ month: '2026-09' }).expect(200);
    const all = (await tasks(f.p)).items as Array<{ id: string; clientId: string }>;
    const mine = all.find((x) => x.clientId === f.clients.a)!; const other = all.find((x) => x.clientId === f.clients.b)!;
    expect((await tasks(f.art)).items.map((x: { id: string }) => x.id)).toEqual([mine.id]);
    await t.http().get(`/v1/tasks/${other.id}`).set(H(f.art)).expect(404);
    await t.http().patch(`/v1/tasks/${other.id}`).set(H(f.art)).send({ status: 'in_progress' }).expect(404);
    await t.http().patch(`/v1/tasks/${mine.id}`).set(H(f.art)).send({ status: 'in_progress' }).expect(204);
    await t.http().post(`/v1/tasks/${mine.id}/checks`).set(H(f.art)).send({ key: 'purchase_data', done: true }).expect(204);
    await t.http().patch(`/v1/tasks/${mine.id}`).set(H(f.art)).send({ assignee_id: f.sen.userId }).expect(403); // reassigning is 'assign'
    await t.http().post(`/v1/tasks/${mine.id}/close`).set(H(f.art)).send({ outcome: 'deleted' }).expect(403);
    // Article is reviewer (not staff) on B's task → still can't see it: clients:view is required too.
    expect((await t.http().patch(`/v1/tasks/${other.id}`).set(H(f.p)).send({ reviewer_id: f.art.userId }).expect(400)).body.code).toBe('person_cannot_see_task:reviewer_id');
    // Reassign away from the article: they lose the task on their devices (revocation), the new assignee gets it.
    const before = await pull(f.art);
    expect(before.filter((c) => c.table === 'task' && !c.deleted).map((c) => c.id)).toEqual([mine.id]);
    expect(before.some((c) => c.table === 'client_service')).toBe(true);
    await t.http().patch(`/v1/clients/${f.clients.a}`).set(H(f.p)).send({ notes: 'x' }).expect(204);
    await t.http().put(`/v1/clients/${f.clients.a}/access`).set(H(f.p)).send({ staffIds: [f.art.userId, f.sen.userId] }).expect(204);
    await t.http().patch(`/v1/tasks/${mine.id}`).set(H(f.p)).send({ assignee_id: f.sen.userId }).expect(204);
    expect((await tasks(f.sen)).items.map((x: { id: string }) => x.id)).toContain(mine.id);
    // Still staff on client A → article keeps seeing the task (client ownership), so no revocation for them.
    expect((await tasks(f.art)).items.map((x: { id: string }) => x.id)).toEqual([mine.id]);
  });

  it('sync pull: tasks need clients:view too; firm tasks only firm-wide or for their people', async () => {
    const f = await firm('tk6');
    await t.http().post('/v1/tasks/auto/commit').set(H(f.p)).send({ month: '2026-09' }).expect(200);
    const [tenantRole] = await t.sql<{ tenant_id: string }>('SELECT tenant_id FROM role WHERE key = $1 AND tenant_id = $2', ['partner', f.p.tenantId]);
    await t.sql(`INSERT INTO role (id, tenant_id, key, name, system, grants) VALUES ($1,$2,'tasksonly','Tasks only',false,$3)`,
      [randomUUID(), tenantRole!.tenant_id, JSON.stringify([{ module: 'tasks', action: 'view', scope: 'all' }, { module: 'tasks', action: 'edit', scope: 'all' }])]);
    const tonly = await t.addUser(f.p, 'tk6', 'Tara', 'tasksonly');
    const firmTask = (await t.http().post('/v1/tasks').set(H(f.p)).send({ title: 'Renew office lease', statutory_due: '2026-11-30' }).expect(201)).body.id;
    const artFirm = (await t.http().post('/v1/tasks').set(H(f.p)).send({ title: 'Article training', assignee_id: f.art.userId }).expect(201)).body.id;
    const tp = (await pull(tonly)).filter((c) => c.table === 'task').map((c) => c.id).sort();
    expect(tp).toEqual([firmTask, artFirm].sort()); // no client tasks without clients:view
    const ap = (await pull(f.art)).filter((c) => c.table === 'task').map((c) => c.id);
    expect(ap).toContain(artFirm); expect(ap).not.toContain(firmTask); expect(ap).toHaveLength(2);
    expect((await pull(f.mgr)).filter((c) => c.table === 'task').map((c) => c.id)).toEqual(expect.not.arrayContaining([firmTask]));
    // Devices can create own firm to-do style tasks but not assign them to others without 'assign'.
    const [ok] = await push(f.sen, [{ key: randomUUID(), table: 'task', id: randomUUID(), baseVersion: 0, patch: { title: 'Self task', assignee_id: f.sen.userId } }]);
    expect(ok.status).toBe('applied');
    const [bad] = await push(f.sen, [{ key: randomUUID(), table: 'task', id: randomUUID(), baseVersion: 0, patch: { title: 'For Arti', assignee_id: f.art.userId } }]);
    expect(bad.status).toBe('rejected'); // a senior's own scope never reaches a task only someone else is on
  });

  it('bulk update with undo (10 minutes, once, own token)', async () => {
    const f = await firm('tk7');
    await t.http().post('/v1/tasks/auto/commit').set(H(f.p)).send({ month: '2026-09' }).expect(200);
    const ids = (await tasks(f.p)).items.map((x: { id: string }) => x.id);
    const r = (await t.http().post('/v1/tasks/bulk').set(H(f.p)).send({ ids, patch: { priority: 'urgent', act_by: '2026-10-15' } }).expect(200)).body;
    expect(r).toMatchObject({ applied: 4, failed: [], expiresInSeconds: 600 });
    expect((await tasks(f.p)).items.every((x: { priority: string; actBy: string }) => x.priority === 'urgent' && x.actBy === '2026-10-15')).toBe(true);
    const done = (await t.http().post('/v1/tasks/bulk').set(H(f.p)).send({ ids, patch: { status: 'done' } }).expect(200)).body;
    expect(done.applied).toBe(0);
    expect(done.failed.every((x: { reason: string }) => x.reason === 'required_checks_pending')).toBe(true);
    await t.http().post('/v1/tasks/bulk/undo').set(H(f.mgr)).send({ undoToken: r.undoToken }).expect(404);
    expect((await t.http().post('/v1/tasks/bulk/undo').set(H(f.p)).send({ undoToken: r.undoToken }).expect(200)).body).toEqual({ restored: 4, skipped: [] });
    expect((await tasks(f.p)).items.every((x: { priority: string; actBy: string }) => x.priority === 'normal' && x.actBy === '2026-10-17')).toBe(true);
    await t.http().post('/v1/tasks/bulk/undo').set(H(f.p)).send({ undoToken: r.undoToken }).expect(410);
    const r2 = (await t.http().post('/v1/tasks/bulk').set(H(f.p)).send({ ids, patch: { reviewer_id: f.p.userId } }).expect(200)).body;
    await t.sql(`UPDATE task_bulk_undo SET expires_at = now() - interval '1 second' WHERE id = $1`, [r2.undoToken]);
    await t.http().post('/v1/tasks/bulk/undo').set(H(f.p)).send({ undoToken: r2.undoToken }).expect(410);
    // Article bulk on others' tasks: not found; own task fine.
    const art = (await t.http().post('/v1/tasks/bulk').set(H(f.art)).send({ ids, patch: { status: 'in_progress' } }).expect(200)).body;
    expect(art.applied).toBe(1);
    expect(art.failed.filter((x: { reason: string }) => x.reason === 'not_found')).toHaveLength(3);
    const audit = (await t.http().get('/v1/audit?entity=task').set(H(f.p))).body.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['task.bulk_updated', 'task.bulk_undone']));
  });

  it('to-dos sync only to their owner; templates create to-dos', async () => {
    const f = await firm('tk8');
    const id = randomUUID();
    const [res] = await push(f.art, [{ key: randomUUID(), table: 'todo', id, baseVersion: 0, patch: { title: 'Call client re: bank statements', owner_id: f.p.userId } }]);
    expect(res).toMatchObject({ status: 'rejected', reason: 'field_not_writable:owner_id' });
    expect((await push(f.art, [{ key: randomUUID(), table: 'todo', id, baseVersion: 0, patch: { title: 'Call client re: bank statements' } }]))[0].status).toBe('applied');
    expect((await pull(f.art)).filter((c) => c.table === 'todo').map((c) => c.id)).toEqual([id]);
    expect((await pull(f.p)).some((c) => c.table === 'todo')).toBe(false);
    await t.http().patch(`/v1/todos/${id}`).set(H(f.p)).send({ done: true }).expect(404);
    await t.http().patch(`/v1/todos/${id}`).set(H(f.art)).send({ done: true }).expect(204);
    expect((await t.http().get('/v1/todos').set(H(f.art))).body[0]).toMatchObject({ id, done: true });
    expect((await t.http().get('/v1/todos?done=true').set(H(f.art))).body[0].doneAt).toBeTruthy();
    const tpl = (await t.http().post('/v1/todo-templates').set(H(f.p)).send({ name: 'Month-end', items: [{ title: 'Chase GST data', offsetDays: 0 }, { title: 'Share 3B working', offsetDays: 5 }] }).expect(201)).body;
    const applied = (await t.http().post(`/v1/todo-templates/${tpl.id}/apply`).set(H(f.art)).send({ baseDate: '2026-10-01' }).expect(201)).body;
    expect(applied.ids).toHaveLength(2);
    const todos = (await t.http().get('/v1/todos?done=false').set(H(f.art))).body;
    expect(todos.map((x: { dueAt: string }) => new Date(x.dueAt).toISOString())).toEqual(['2026-10-01T12:30:00.000Z', '2026-10-06T12:30:00.000Z']);
    await t.http().delete(`/v1/todos/${id}`).set(H(f.art)).expect(204);
    expect((await pull(f.art)).find((c) => c.table === 'todo' && c.id === id)?.deleted).toBe(true);
  });
});

describe('compliance', () => {
  it('extension: impact preview counts, approve moves open tasks only (firm-wide approver)', async () => {
    const f = await firm('tk9');
    await t.http().post('/v1/tasks/auto/commit').set(H(f.p)).send({ month: '2026-09' }).expect(200);
    const list = (await tasks(f.p)).items as Array<{ id: string; clientId: string }>;
    const doneId = list.find((x) => x.clientId === f.clients.d)!.id;
    await tickAll(f.p, doneId);
    await t.http().patch(`/v1/tasks/${doneId}`).set(H(f.p)).send({ status: 'done' }).expect(204);
    await t.http().post('/v1/compliance/extensions').set(H(f.p)).send({ ruleId: 'gst.gstr3b.monthly', periodKey: 'FY2026-27-Q2', newDueDate: '2026-10-25' }).expect(400);
    await t.http().post('/v1/compliance/extensions').set(H(f.p)).send({ ruleId: 'nope', periodKey: '2026-09', newDueDate: '2026-10-25' }).expect(400);
    const { id } = (await t.http().post('/v1/compliance/extensions').set(H(f.p)).send({ ruleId: 'gst.gstr3b.monthly', periodKey: '2026-09', newDueDate: '2026-10-25', notification: 'CBIC (sample)' }).expect(201)).body;
    const imp = (await t.http().get(`/v1/compliance/extensions/${id}/impact`).set(H(f.p)).expect(200)).body;
    expect(imp).toMatchObject({ dueDatesChanged: 1, clientsAffected: 4, tasksToMove: 3 });
    expect(imp.tasks.every((x: { from: string; to: string }) => x.from === '2026-10-20' && x.to === '2026-10-25')).toBe(true);
    await t.http().post(`/v1/compliance/extensions/${id}/approve`).set(H(f.mgr)).expect(403);
    await t.http().post(`/v1/compliance/extensions/${id}/approve`).set(H(f.art)).expect(403);
    expect((await t.http().post(`/v1/compliance/extensions/${id}/approve`).set(H(f.p)).expect(200)).body).toEqual({ tasksMoved: 3 });
    const after = (await tasks(f.p)).items as Array<{ id: string; statutoryDue: string; actBy: string; extensionId: string | null }>;
    for (const x of after) {
      if (x.id === doneId) expect(x).toMatchObject({ statutoryDue: '2026-10-20', actBy: '2026-10-17', extensionId: null });
      else expect(x).toMatchObject({ statutoryDue: '2026-10-25', actBy: '2026-10-22', extensionId: id });
    }
    await t.http().post(`/v1/compliance/extensions/${id}/approve`).set(H(f.p)).expect(400);
    // New tasks for that period pick up the extended date.
    const e = await client(f.p, 'Epsilon Pvt Ltd');
    await subscribe(f.p, e, f.g3b.id).expect(200);
    await t.http().post('/v1/tasks/auto/commit').set(H(f.p)).send({ month: '2026-09' }).expect(200);
    expect((await tasks(f.p, `&clientId=${e}`)).items[0]).toMatchObject({ statutoryDue: '2026-10-25', extensionId: id });
    expect((await t.http().get('/v1/compliance/extensions').set(H(f.p))).body[0]).toMatchObject({ status: 'approved', tasksMoved: 3 });
  });

  it('rule packs: upload (validated) → diff → approve with firm-wide permission', async () => {
    const f = await firm('tk10');
    const packs0 = (await t.http().get('/v1/compliance/packs').set(H(f.p)).expect(200)).body;
    expect(packs0).toHaveLength(1);
    expect(packs0[0]).toMatchObject({ status: 'approved', version: '0.1.0' });
    expect(packs0[0].notes).toMatch(/UNVERIFIED/);
    const seed = JSON.parse(readFileSync(createRequire(import.meta.url).resolve('@worko/rules/packs/in-seed.json'), 'utf8'));
    const next = { ...seed, version: '0.2.0', rules: seed.rules.map((r: { id: string; due: object }) => (r.id === 'gst.gstr3b.monthly' ? { ...r, due: { anchor: 'period_end', addMonths: 1, day: 22 } } : r)) };
    await t.http().post('/v1/compliance/packs').set(H(f.p)).send({ pack: { ...next, rules: [{ id: 'BAD ID' }] } }).expect(400);
    await t.http().post('/v1/compliance/packs').set(H(f.art)).send({ pack: next }).expect(403);
    const { id } = (await t.http().post('/v1/compliance/packs').set(H(f.p)).send({ pack: next }).expect(201)).body;
    await t.http().post('/v1/compliance/packs').set(H(f.p)).send({ pack: next }).expect(409);
    const diff = (await t.http().get(`/v1/compliance/packs/${id}/diff?fy=2026`).set(H(f.p)).expect(200)).body;
    expect(diff).toMatchObject({ added: [], removed: [], changed: [{ rule: 'gst.gstr3b.monthly@2017-07-01', fields: ['due'] }] });
    expect(diff.impact).toMatchObject({ fy: 2026, dueDatesChanged: 12, clientsAffected: 4 });
    await t.http().post(`/v1/compliance/packs/${id}/approve`).set(H(f.mgr)).expect(403);
    await t.http().post(`/v1/compliance/packs/${id}/approve`).set(H(f.p)).expect(204);
    const packs = (await t.http().get('/v1/compliance/packs').set(H(f.p))).body.map((x: { version: string; status: string }) => `${x.version}:${x.status}`).sort();
    expect(packs).toEqual(['0.1.0:superseded', '0.2.0:approved']);
    expect((await t.http().post('/v1/tasks/auto/preview').set(H(f.p)).send({ month: '2026-09' }).expect(200)).body.items[0].statutoryDue).toBe('2026-10-22');
    await t.http().post(`/v1/compliance/packs/${id}/approve`).set(H(f.p)).expect(400);
  });

  it('matrix shows only visible clients with task state', async () => {
    const f = await firm('tk11');
    await t.http().post('/v1/tasks/auto/commit').set(H(f.p)).send({ month: '2026-09' }).expect(200);
    const q = '/v1/compliance/matrix?from=2026-10-01&to=2026-10-31&asOf=2026-10-15';
    const pm = (await t.http().get(q).set(H(f.p)).expect(200)).body;
    expect(pm.clients).toHaveLength(4);
    const cell = (m: typeof pm, cid: string, rule: string) => m.cells.find((c: { clientId: string; ruleId: string }) => c.clientId === cid && c.ruleId === rule);
    expect(cell(pm, f.clients.a, 'gst.gstr3b.monthly')).toMatchObject({ periodKey: '2026-09', statutoryDue: '2026-10-20', state: 'open' });
    expect(cell(pm, f.clients.a, 'gst.gstr1.monthly')).toMatchObject({ statutoryDue: '2026-10-11', state: 'overdue', taskId: null });
    const sm = (await t.http().get(q).set(H(f.sen)).expect(200)).body;
    expect(sm.clients.map((c: { id: string }) => c.id)).toEqual([f.clients.b]);
    expect(new Set(sm.cells.map((c: { clientId: string }) => c.clientId))).toEqual(new Set([f.clients.b]));
    await t.http().get('/v1/compliance/matrix?from=2026-01-01&to=2027-12-31').set(H(f.p)).expect(400);
    await t.http().get(q).set(H(f.art)).expect(403); // articles have no compliance permission
  });

  it('indicative late-fee calculator (paise, unverified)', async () => {
    const p = await t.signup('tk12');
    const r = (await t.http().post('/v1/compliance/late-fee').set(H(p)).send({ ruleId: 'gst.gstr3b.monthly', dueDate: '2026-10-20', filedOn: '2026-10-30', taxAmountPaise: 10_000_000 }).expect(200)).body;
    expect(r).toMatchObject({ daysLate: 10, feePaise: 50_000, indicative: true, verified: false, supported: true, form: 'GSTR-3B' });
    expect(r.totalPaise).toBe(r.feePaise + r.interestPaise);
    expect(r.disclaimer).toMatch(/Indicative/);
    expect((await t.http().post('/v1/compliance/late-fee').set(H(p)).send({ ruleId: 'roc.aoc4', dueDate: '2026-10-29', filedOn: '2026-11-30' }).expect(200)).body.supported).toBe(false);
    await t.http().post('/v1/compliance/late-fee').set(H(p)).send({ ruleId: 'x', dueDate: '2026-13-01', filedOn: '2026-11-30' }).expect(400);
  });
});
