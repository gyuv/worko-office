import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockChannelHub } from '../src/comm/channels.js';
import { Clock } from '../src/common/clock.js';
import { Reschedule } from '../src/jobs/job-queue.service.js';
import { ReportEngine } from '../src/reports/engine.js';
import { ReportScheduleService } from '../src/reports/schedule.service.js';
import { bearer, bootApp, web, type Session } from './helpers.js';

let t: Awaited<ReturnType<typeof bootApp>>;
const TODAY = '2026-10-15';
const NOW = new Date('2026-10-15T12:00:00+05:30');
const S: Record<string, Session> = {};
const H = (role: string) => bearer(S[role]!.accessToken);
const run = (role: string, body: Record<string, unknown>, code = 200) => t.http().post('/v1/reports/run').set(H(role)).send(body).expect(code).then((r) => r.body);
const get = (role: string, url: string) => t.http().get(url).set(H(role)).expect(200).then((r) => r.body);
let tenantId: string;

beforeAll(async () => {
  t = await bootApp();
  const { seedDemo, DEMO } = await import('../src/db/seed-demo.js');
  await seedDemo(t.db.url, { today: TODAY });
  t.app.get(Clock).set(NOW);
  for (const u of DEMO.users) S[u.role] = (await t.http().post('/v1/auth/login').send({ firm: 'demo', email: u.email, password: DEMO.password, device: web }).expect(200)).body;
  tenantId = S.partner!.tenantId;
  // An analyst: reports view/export firm-wide, clients view (no clients:export), PAN hidden by field hiding.
  await t.sql(`INSERT INTO role (id, tenant_id, key, name, system, grants, hidden_fields) VALUES (gen_random_uuid(), $1, 'analyst', 'Analyst', false, $2, '{client.pan}')`,
    [tenantId, JSON.stringify([{ module: 'clients', action: 'view', scope: 'all' }, { module: 'reports', action: 'view', scope: 'all' }, { module: 'reports', action: 'export', scope: 'all' }])]);
  S.analyst = await t.addUser(S.partner!, 'demo', 'Analyst', 'article');
  await t.sql(`UPDATE user_role SET role_id = (SELECT id FROM role WHERE key = 'analyst' AND tenant_id = $1) WHERE user_id = $2`, [tenantId, S.analyst.userId]);
}, 120_000);
afterAll(() => t?.close());

describe('catalogue reconciles with the operational endpoints', () => {
  it('unbilled == Billing → Unbilled (partner and manager scope)', async () => {
    for (const role of ['partner', 'manager', 'accountant']) {
      const e = await get(role, '/v1/billing/unbilled');
      const r = await run(role, { catalogueKey: 'unbilled_by_client' });
      expect(e.count).toBeGreaterThan(0);
      expect(r.totals).toMatchObject({ count: e.count, sum_suggestedPaise: e.suggestedTotalPaise });
      expect(r.groups.reduce((s: number, g: { values: { sum_suggestedPaise: number } }) => s + g.values.sum_suggestedPaise, 0)).toBe(e.suggestedTotalPaise);
      expect(Number.isInteger(r.totals.sum_suggestedPaise)).toBe(true);
    }
  });
  it('ageing buckets == Billing → Ageing', async () => {
    const e = await get('partner', `/v1/billing/ageing?asOf=${TODAY}`);
    const r = await run('partner', { catalogueKey: 'ageing_buckets', params: { asOf: TODAY } });
    expect(r.totals.sum_balancePaise).toBe(e.totals.totalPaise);
    for (const g of r.groups) expect(g.values.sum_balancePaise).toBe(e.totals[g.key.bucket]);
    expect(r.groups.map((g: { key: { bucket: string } }) => g.key.bucket)).toEqual(['notDue', 'd0_30', 'd31_60', 'd61_90', 'd90plus'].filter((b) => e.totals[b] !== 0));
  });
  it('job P&L == Time → Job P&L; cost/margin hidden without cost visibility', async () => {
    const q = 'from=2026-04-01&to=2026-10-15&groupBy=client';
    const e = await get('partner', `/v1/reports/job-pnl?${q}`);
    const r = await run('partner', { catalogueKey: 'job_pnl', params: { from: '2026-04-01', to: TODAY, groupBy: 'client' } });
    expect(r.rowCount).toBe(e.items.length);
    expect(r.totals).toMatchObject({ sum_revenuePaise: e.totals.revenuePaise, sum_costPaise: e.totals.costPaise, sum_wipPaise: e.totals.wipPaise, sum_minutes: e.totals.minutes });
    const em = await get('manager', `/v1/reports/job-pnl?${q}`);
    const m = await run('manager', { catalogueKey: 'job_pnl', params: { from: '2026-04-01', to: TODAY, groupBy: 'client' } });
    expect(em.totals.costPaise).toBeNull();
    expect(m.hiddenColumns.sort()).toEqual(['costPaise', 'marginPaise', 'marginPct']);
    expect(m.totals.sum_costPaise).toBeUndefined();
    expect(m.totals.sum_revenuePaise).toBe(em.totals.revenuePaise);
    expect(m.columns.map((c: { key: string }) => c.key)).not.toContain('costPaise');
    expect(m.rows.every((x: { values: Record<string, unknown> }) => !('costPaise' in x.values) && !('marginPaise' in x.values))).toBe(true);
  });
  it('utilisation == Time → Capacity', async () => {
    for (const role of ['partner', 'manager']) {
      const e = await get(role, '/v1/reports/capacity?weeks=4&from=2026-09-21');
      const r = await run(role, { catalogueKey: 'utilisation_by_user', params: { from: '2026-09-21', weeks: 4 } });
      expect(r.groups.length).toBe(e.users.length);
      for (const u of e.users as Array<{ name: string; weeks: Array<{ capacityMinutes: number; actualMinutes: number; plannedMinutes: number }> }>) {
        const g = r.groups.find((x: { key: { userName: string } }) => x.key.userName === u.name);
        expect(g.values).toEqual({ sum_capacityMinutes: u.weeks.reduce((s, w) => s + w.capacityMinutes, 0), sum_plannedMinutes: u.weeks.reduce((s, w) => s + w.plannedMinutes, 0), sum_actualMinutes: u.weeks.reduce((s, w) => s + w.actualMinutes, 0) });
      }
      expect(r.totals.sum_actualMinutes).toBeGreaterThan(0);
    }
  });
  it('compliance status, notices ageing and attendance reconcile too', async () => {
    const e = await get('partner', `/v1/compliance/matrix?from=2026-10-01&to=2026-10-31&asOf=${TODAY}`);
    const r = await run('partner', { catalogueKey: 'compliance_status', params: { from: '2026-10-01', to: '2026-10-31', asOf: TODAY } });
    for (const g of r.groups) expect(g.values.count).toBe(e.cells.filter((c: { state: string }) => c.state === g.key.state).length);
    expect(r.totals.count).toBe(e.cells.length);
    const n = await get('partner', `/v1/notices/reports/ageing?asOf=${TODAY}`);
    const nr = await run('partner', { catalogueKey: 'notices_by_authority' });
    expect(nr.totals).toMatchObject({ count: n.open, sum_demandPaise: n.demandPaise });
    const at = await get('manager', '/v1/hr/attendance/report?month=2026-10');
    const ar = await run('manager', { catalogueKey: 'attendance_summary', params: { month: '2026-10' } });
    expect(ar.rowCount).toBe(at.users.length);
    expect(ar.totals.sum_presentDays).toBe(at.users.reduce((s: number, u: { presentDays: number }) => s + u.presentDays, 0));
  });
});

describe('row scope and column access', () => {
  const tasksDef = { dataset: 'tasks', columns: ['title', 'clientName', 'assigneeName', 'status'] };
  it('an article sees only their own tasks and time; the partner sees all', async () => {
    const a = await run('article', { definition: tasksDef, pageSize: 500 });
    const p = await run('partner', { definition: tasksDef, pageSize: 500 });
    expect(a.rowCount).toBeGreaterThan(0);
    expect(a.rowCount).toBeLessThan(p.rowCount);
    const ids = a.rows.map((x: { refs: { task: string } }) => x.refs.task);
    expect(ids).toHaveLength(a.rowCount);
    const me = S.article!.userId;
    const outside = await t.sql(`SELECT t.id FROM task t LEFT JOIN client c ON c.id = t.client_id WHERE t.id = ANY($1::uuid[]) AND NOT ($2 IN (t.assignee_id, t.leader_id, t.manager_id, t.reviewer_id)
      OR c.partner_id = $2 OR c.manager_id = $2 OR $2 = ANY(c.staff_ids))`, [ids, me]);
    expect(outside).toHaveLength(0);
    const time = await run('article', { definition: { dataset: 'time_entries', columns: ['userName', 'minutes'] }, pageSize: 500 });
    expect(time.rowCount).toBeGreaterThan(0);
    expect(time.rows.every((x: { refs: { user: string } }) => x.refs.user === me)).toBe(true);
    // The billing datasets are not theirs at all.
    expect((await run('article', { catalogueKey: 'unbilled_by_client' }, 403)).code).toBe('dataset_forbidden');
  });
  it('cost is absent without canSeeCost and cannot be filtered on', async () => {
    const def = { dataset: 'time_entries', columns: ['userName', 'minutes', 'costPaise'], groupBy: ['userName'], aggregates: [{ fn: 'sum', column: 'costPaise' }, { fn: 'sum', column: 'minutes' }] };
    const p = await run('partner', { definition: def });
    expect(p.totals.sum_costPaise).toBeGreaterThan(0);
    expect(p.rows[0].values.costPaise).toEqual(expect.any(Number));
    const m = await run('manager', { definition: def });
    expect(m.hiddenColumns).toEqual(['costPaise']);
    expect(m.totals.sum_costPaise).toBeUndefined();
    expect(m.rows.every((x: { values: object }) => !('costPaise' in x.values))).toBe(true);
    expect((await run('manager', { definition: { ...def, filters: [{ column: 'costPaise', op: 'gt', value: 0 }] } }, 403)).code).toBe('column_hidden');
  });
  it('PII columns follow role field hiding', async () => {
    const def = { dataset: 'clients', columns: ['name', 'pan', 'email'] };
    const p = await run('partner', { definition: def });
    expect(p.rows.some((x: { values: { pan: string | null } }) => !!x.values.pan)).toBe(true);
    const x = await run('analyst', { definition: def });
    expect(x.hiddenColumns).toEqual(['pan']);
    expect(x.rows.every((r: { values: object }) => !('pan' in r.values) && 'email' in r.values)).toBe(true);
  });
});

describe('saved reports, sharing and versions', () => {
  it('a shared report always runs with the VIEWER\'s scope; private ones are 404', async () => {
    const def = { dataset: 'tasks', columns: ['title', 'status'], filters: [{ column: 'status', op: 'nin', value: ['cancelled'] }] };
    const rep = (await t.http().post('/v1/reports/saved').set(H('partner')).send({ name: 'All live tasks', definition: def, share: { firm: true } }).expect(201)).body;
    expect(rep).toMatchObject({ share: { firm: true }, currentVersion: 1, canEdit: true });
    const listed = (await get('article', '/v1/reports/saved')).items.map((r: { id: string }) => r.id);
    expect(listed).toContain(rep.id);
    const asArticle = await run('article', { reportId: rep.id });
    const adhoc = await run('article', { definition: def });
    const asPartner = await run('partner', { reportId: rep.id });
    expect(asArticle.rowCount).toBe(adhoc.rowCount);
    expect(asArticle.rowCount).toBeLessThan(asPartner.rowCount);
    // Only firm-wide publishers share with the firm; the manager's private report is invisible to others.
    const mine = (await t.http().post('/v1/reports/saved').set(H('manager')).send({ name: 'Mine', definition: def }).expect(201)).body;
    await t.http().put(`/v1/reports/saved/${mine.id}/share`).set(H('manager')).send({ firm: true }).expect(403);
    await t.http().get(`/v1/reports/saved/${mine.id}`).set(H('article')).expect(404);
    await run('article', { reportId: mine.id }, 404);
    await t.http().put(`/v1/reports/saved/${rep.id}`).set(H('manager')).send({ name: 'x' }).expect(403);
    await t.http().put(`/v1/reports/saved/${rep.id}`).set(H('partner')).send({ definition: { ...def, columns: ['title'] } }).expect(200);
    const v = await get('partner', `/v1/reports/saved/${rep.id}/versions`);
    expect(v.items.map((x: { reportVersion: number }) => x.reportVersion)).toEqual([2, 1]);
    const audit = await t.sql<{ action: string }>(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY seq`, [rep.id]);
    expect(audit.map((x) => x.action)).toEqual(['report.saved', 'report.updated']);
  });
});

describe('drill-down', () => {
  it('drilling into a group returns its underlying rows; totals equal the group value', async () => {
    const r = await run('partner', { catalogueKey: 'unbilled_by_client' });
    for (const g of r.groups.slice(0, 3)) {
      const d = await run('partner', { catalogueKey: 'unbilled_by_client', drill: g.key, pageSize: 500 });
      expect(d.groups).toEqual([]);
      expect(d.totals.sum_suggestedPaise).toBe(g.values.sum_suggestedPaise);
      expect(d.rowCount).toBe(g.values.count);
      expect(d.rows.every((x: { values: { clientName: string }; refs: { task: string; client: string } }) => x.values.clientName === g.key.clientName && x.refs.task && x.refs.client)).toBe(true);
    }
    const two = await run('partner', { catalogueKey: 'compliance_by_form' });
    const child = two.groups[0].children[0];
    const d2 = await run('partner', { catalogueKey: 'compliance_by_form', drill: child.key });
    expect(d2.rowCount).toBe(child.values.count);
    expect((await run('partner', { catalogueKey: 'unbilled_by_client', drill: { title: 'x' } }, 400)).code).toBe('invalid_definition');
  });
});

describe('no raw SQL, ever; limits', () => {
  it('unknown datasets/columns and extra keys are rejected; filter values are parameters', async () => {
    for (const definition of [{ dataset: 'pg_user' }, { dataset: 'tasks', sql: 'SELECT 1' }, { dataset: 'tasks', columns: ['password_hash'] }, { dataset: 'tasks', columns: ['id) FROM app_user --'] },
      { dataset: 'tasks', filters: [{ column: 'status', op: 'eq', value: "open' OR '1'='1" }] }, { dataset: 'tasks', sort: [{ by: '1; DROP TABLE task' }] }]) {
      expect((await run('partner', { definition }, 400)).code).toBe('invalid_definition');
    }
    const before = (await t.sql<{ n: number }>('SELECT count(*)::int AS n FROM client'))[0]!.n;
    const r = await run('partner', { definition: { dataset: 'clients', columns: ['name'], filters: [{ column: 'name', op: 'contains', value: "x'); DROP TABLE client; --" }] } });
    expect(r.rowCount).toBe(0);
    expect((await t.sql<{ n: number }>('SELECT count(*)::int AS n FROM client'))[0]!.n).toBe(before);
    await t.http().post('/v1/reports/run').set(H('partner')).send({ definition: { dataset: 'tasks' }, catalogueKey: 'job_pnl' }).expect(400);
  });
  it('max rows and statement timeout (READ ONLY transaction)', async () => {
    const engine = t.app.get(ReportEngine);
    engine.maxScan = 5;
    try { expect((await run('partner', { definition: { dataset: 'tasks' } }, 422)).code).toBe('too_many_rows'); } finally { engine.maxScan = 20_000; }
    await t.sql(`INSERT INTO task (id, tenant_id, title) SELECT gen_random_uuid(), $1, 'bulk ' || g FROM generate_series(1, 30000) g`, [tenantId]);
    engine.timeoutMs = 1;
    try { expect((await run('partner', { definition: { dataset: 'tasks', columns: ['title'], filters: [{ column: 'title', op: 'contains', value: 'zz' }] } }, 503)).code).toBe('report_timeout'); } finally {
      engine.timeoutMs = 5_000;
      await t.sql(`DELETE FROM task WHERE tenant_id = $1 AND title LIKE 'bulk %' AND client_id IS NULL`, [tenantId]);
    }
  });
});

describe('exports', () => {
  it('CSV is formula-safe, audited with metadata only; XLSX/PDF render', async () => {
    await t.http().post('/v1/clients').set(H('partner')).send({ name: '=HYPERLINK("http://evil.example","x")', entityType: 'PROPRIETORSHIP' }).expect(201);
    const def = { dataset: 'clients', columns: ['name', 'fileNo'], filters: [{ column: 'name', op: 'starts_with', value: '=HYPER' }] };
    const csv = await t.http().post('/v1/reports/export').set(H('partner')).send({ definition: def, format: 'csv' }).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    const [audit] = await t.sql<{ diff: Record<string, unknown> }>(`SELECT diff FROM audit_log WHERE action = 'report.exported' ORDER BY seq DESC LIMIT 1`);
    expect(audit!.diff).toMatchObject({ dataset: 'clients', format: 'csv', rows: 1, columns: ['name', 'fileNo'] });
    expect(JSON.stringify(audit)).not.toContain('HYPERLINK');
    const x = await t.http().post('/v1/reports/export').set(H('partner')).send({ catalogueKey: 'unbilled_by_client', format: 'xlsx' }).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (c: Buffer) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); }).expect(200);
    expect(x.headers['content-type']).toMatch(/spreadsheetml/);
    expect((x.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    const pdf = await t.http().post('/v1/reports/export').set(H('partner')).send({ catalogueKey: 'ageing_buckets', format: 'pdf' }).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (c: Buffer) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); }).expect(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });
  it('exports need reports:export, and PII/cost columns need the module\'s export too', async () => {
    await t.http().post('/v1/reports/export').set(H('article')).send({ catalogueKey: 'my_open_tasks', format: 'csv' }).expect(403);
    const e = await t.http().post('/v1/reports/export').set(H('analyst')).send({ definition: { dataset: 'clients', columns: ['name', 'email'] }, format: 'csv' }).expect(403);
    expect(e.body.code).toBe('export_forbidden');
    await t.http().post('/v1/reports/export').set(H('analyst')).send({ definition: { dataset: 'clients', columns: ['name', 'fileNo'] }, format: 'csv' }).expect(200);
  });
});

describe('scheduled reports', () => {
  const svc = () => t.app.get(ReportScheduleService);
  const occur = async (id: string, extraMin = 1) => {
    const [s] = await t.sql<{ next_run_at: Date }>('SELECT next_run_at FROM report_schedule WHERE id = $1', [id]);
    const at = new Date(s!.next_run_at.getTime() + extraMin * 60_000);
    await svc().process(tenantId, id, at).catch((e) => { if (!(e instanceof Reschedule)) throw e; });
    return at;
  };
  it('runs AS EACH RECIPIENT, delivers a recipient-bound expiring link by e-mail, idempotent per period', async () => {
    const hub = t.app.get(MockChannelHub);
    const ids = ['partner', 'manager', 'article', 'accountant'].map((r) => S[r]!.userId);
    const s = (await t.http().post('/v1/reports/schedules').set(H('partner')).send({ name: 'Weekly open tasks', catalogueKey: 'my_open_tasks', schedule: { frequency: 'weekly', weekday: 1, time: '08:00' },
      recipientIds: ids, delivery: 'email', format: 'csv' }).expect(201)).body;
    expect(s.nextRunAt).toBe('2026-10-19T02:30:00.000Z');
    const before = hub.outbox.length;
    await occur(s.id);
    const runs = (await get('partner', `/v1/reports/schedules/${s.id}/runs`)).items as Array<{ recipientId: string; status: string; skipReason: string | null; rowCount: number | null; periodKey: string }>;
    const by = (r: string) => runs.find((x) => x.recipientId === S[r]!.userId)!;
    expect(by('partner')).toMatchObject({ status: 'delivered', periodKey: 'W2026-10-19' });
    expect(by('manager')).toMatchObject({ status: 'delivered' });
    expect(by('article')).toMatchObject({ status: 'skipped', skipReason: 'no_permission' }); // no reports:export
    expect(by('accountant')).toMatchObject({ status: 'skipped', skipReason: 'no_permission' }); // no tasks:view
    // Each recipient got their own scope.
    t.app.get(Clock).set(new Date('2026-10-19T08:01:00+05:30'));
    const pr = await run('partner', { catalogueKey: 'my_open_tasks' }); const mr = await run('manager', { catalogueKey: 'my_open_tasks' });
    t.app.get(Clock).set(NOW);
    expect(by('partner').rowCount).toBe(pr.rowCount);
    expect(by('manager').rowCount).toBe(mr.rowCount);
    expect(mr.rowCount).toBeLessThan(pr.rowCount);
    const mails = hub.outbox.slice(before).filter((m) => m.subject === 'Report ready: Weekly open tasks');
    expect(mails.map((m) => m.to).sort()).toEqual(['manager@demo.worko.in', 'partner@demo.worko.in']);
    const titles = (await t.sql<{ title: string }>(`SELECT title FROM task WHERE tenant_id = $1 LIMIT 50`, [tenantId])).map((x) => x.title);
    for (const m of mails) { expect(m.text).toMatch(/\/reports\/downloads\/[A-Za-z0-9_-]{40,}/); for (const ti of titles) expect(m.text).not.toContain(ti); }
    const token = (u: string) => /\/reports\/downloads\/([A-Za-z0-9_-]+)/.exec(mails.find((m) => m.to === u)!.text)![1]!;
    const dl = await t.http().get(`/v1/reports/downloads/${token('partner@demo.worko.in')}`).set(H('partner')).expect(200);
    expect(dl.text.trim().split('\r\n')).toHaveLength(pr.groups.length + 2); // grouped report: header + one line per group + total
    await t.http().get(`/v1/reports/downloads/${token('partner@demo.worko.in')}`).set(H('manager')).expect(404); // recipient-bound
    const [enc] = await t.sql<{ body_enc: Buffer }>(`SELECT body_enc FROM report_export WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [S.partner!.userId]);
    expect(enc!.body_enc.toString('latin1')).not.toContain(pr.rows[0].values.title);
    // Same period again: nothing new.
    await t.sql(`UPDATE report_schedule SET next_run_at = '2026-10-19T02:30:00Z' WHERE id = $1`, [s.id]);
    const n = hub.outbox.length;
    await occur(s.id, 30);
    expect((await get('partner', `/v1/reports/schedules/${s.id}/runs`)).items).toHaveLength(4);
    expect(hub.outbox.length).toBe(n);
    // The link expires (7 days).
    t.app.get(Clock).set(new Date('2026-10-27T09:00:00+05:30'));
    try { expect((await t.http().get(`/v1/reports/downloads/${token('manager@demo.worko.in')}`).set(H('manager')).expect(410)).body.code).toBe('link_expired'); } finally { t.app.get(Clock).set(NOW); }
    expect((await t.sql(`SELECT 1 FROM audit_log WHERE action = 'report.schedule_delivered' AND entity_id = $1`, [s.id])).length).toBe(2);
  });
  it('in-app delivery notifies; repeated failures pause the schedule and tell the owner', async () => {
    const s = (await t.http().post('/v1/reports/schedules').set(H('partner')).send({ name: 'Daily ageing', catalogueKey: 'ageing_buckets', schedule: { frequency: 'daily', time: '07:30' },
      recipientIds: [S.manager!.userId], delivery: 'in_app', format: 'xlsx' }).expect(201)).body;
    await occur(s.id);
    const [n] = await t.sql<{ category: string; entity_type: string; body: string }>(`SELECT category, entity_type, body FROM notification WHERE user_id = $1 AND category = 'report.ready'`, [S.manager!.userId]);
    expect(n).toMatchObject({ category: 'report.ready', entity_type: 'report_export' });
    const f = (await t.http().post('/v1/reports/schedules').set(H('partner')).send({ name: 'Failing', catalogueKey: 'ageing_buckets', schedule: { frequency: 'daily', time: '10:00' },
      recipientIds: [S.partner!.userId], delivery: 'email', format: 'csv' }).expect(201)).body;
    const hub = t.app.get(MockChannelHub); hub.failTo.add('partner@demo.worko.in');
    try { for (let i = 0; i < 3; i++) await occur(f.id); } finally { hub.failTo.delete('partner@demo.worko.in'); }
    const after = await get('partner', `/v1/reports/schedules/${f.id}`);
    expect(after).toMatchObject({ status: 'paused', pausedReason: 'repeated_failures', consecutiveFailures: 3 });
    expect((await t.sql(`SELECT 1 FROM notification WHERE user_id = $1 AND category = 'report.failed' AND entity_id = $2`, [S.partner!.userId, f.id])).length).toBe(1);
    expect((await t.http().put(`/v1/reports/schedules/${f.id}`).set(H('partner')).send({ enabled: true }).expect(200)).body).toMatchObject({ status: 'active', consecutiveFailures: 0 });
    await t.http().put(`/v1/reports/schedules/${f.id}`).set(H('manager')).send({ enabled: false }).expect(404);
  });
});

describe('dashboards', () => {
  it('role defaults per viewer; widgets run as the viewer and reconcile', async () => {
    const p = await get('partner', '/v1/reports/dashboards/default/data');
    expect(p.dashboard).toMatchObject({ name: 'Partner overview', origin: 'role', roleKey: 'partner' });
    const unbilled = p.widgets.find((w: { id: string }) => w.id === 'unbilled');
    expect(unbilled.value).toBe((await get('partner', '/v1/billing/unbilled')).suggestedTotalPaise);
    expect(p.widgets.map((w: { id: string; error?: string }) => w.error ?? 'ok')).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    const m = await get('manager', '/v1/reports/dashboards/default/data');
    expect(m.dashboard.name).toBe('Team overview');
    const a = await get('article', '/v1/reports/dashboards/default/data');
    expect(a.dashboard.name).toBe('My work');
    const tasks = a.widgets.find((w: { id: string }) => w.id === 'tasks');
    expect(tasks.rowCount).toBe((await run('article', { catalogueKey: 'my_open_tasks' })).rowCount);
    await t.http().put(`/v1/reports/dashboards/${m.dashboard.id}`).set(H('manager')).send({ name: 'x' }).expect(403);
  });
  it('personal dashboards, per-user default, widgets the viewer cannot use answer with an error', async () => {
    const d = (await t.http().post('/v1/reports/dashboards').set(H('senior')).send({ name: 'Mine', widgets: [
      { id: 'a', kind: 'kpi', title: 'Open', catalogueKey: 'my_open_tasks' }, { id: 'b', kind: 'chart', title: 'Unbilled', catalogueKey: 'unbilled_by_client' }] }).expect(201)).body;
    expect(await get('senior', '/v1/reports/dashboards/default')).toMatchObject({ id: null, origin: 'none', widgets: [] }); // no senior role dashboard or template
    await t.http().put('/v1/reports/dashboards/default').set(H('senior')).send({ dashboardId: d.id }).expect(200);
    const data = await get('senior', '/v1/reports/dashboards/default/data');
    expect(data.dashboard).toMatchObject({ id: d.id, origin: 'user' });
    expect(data.widgets[1]).toMatchObject({ id: 'b', error: 'dataset_forbidden' });
    await t.http().get(`/v1/reports/dashboards/${d.id}`).set(H('manager')).expect(404);
    await t.http().post('/v1/reports/dashboards').set(H('manager')).send({ name: 'Role', roleKey: 'senior', widgets: [] }).expect(403);
    await t.http().post('/v1/reports/dashboards').set(H('partner')).send({ name: 'Role', roleKey: 'nope', widgets: [] }).expect(400);
  });
  it('datasets and catalogue list only what the viewer may use, with hidden columns flagged', async () => {
    const ds = await get('manager', '/v1/reports/datasets');
    const te = ds.find((d: { key: string }) => d.key === 'time_entries');
    expect(te.columns.find((c: { key: string }) => c.key === 'costPaise')).toMatchObject({ hidden: true, sensitivity: 'cost' });
    const art = (await get('article', '/v1/reports/datasets')).map((d: { key: string }) => d.key);
    expect(art).toContain('tasks');
    expect(art).not.toContain('invoices');
    expect((await get('article', '/v1/reports/catalogue')).map((c: { key: string }) => c.key)).not.toContain('ageing_buckets');
  });
});
