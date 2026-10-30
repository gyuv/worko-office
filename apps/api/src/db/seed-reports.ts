import { addDaysIso, datasetMeta, mondayOf, nextScheduleRun, reportDefinitionSchema, ROLE_DASHBOARD_TEMPLATES, type ReportDefinition, type ReportSchedule } from '@worko/domain';
import { mockNlDefinition } from '../ai/provider.js';
import { AuditService } from '../audit/audit.service.js';
import { KeyService, LocalKms } from '../crypto/key.service.js';
import type { DbService } from './db.service.js';
import { uuidv7 } from './ids.js';

const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+05:30`);

/**
 * Phase 11 demo data, deterministic for `today`: role-default dashboards (partner: unbilled, ageing, utilisation, collections,
 * compliance; manager: team overdue + capacity; article: my tasks/time), saved reports (one shared with the firm, one with the
 * partner role, one private), a weekly scheduled report with two delivered weeks of history, and NL-query examples.
 */
export async function seedReports(db: DbService, tenantId: string, today: string) {
  const keys = new KeyService(new LocalKms()); const audit = new AuditService();
  await db.tenantTx(tenantId, async (tx) => {
    const users = Object.fromEntries((await tx.query(`SELECT u.id, r.key FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role r ON r.id = ur.role_id ORDER BY u.id`)).rows.map((r) => [r.key, r.id])) as Record<string, string>;
    const partner = users.partner!;
    for (const [role, t] of Object.entries(ROLE_DASHBOARD_TEMPLATES)) {
      const id = uuidv7();
      await tx.query(`INSERT INTO dashboard (id, tenant_id, name, role_key, widgets, updated_by, device_id) VALUES ($1,$2,$3,$4,$5,$6,'seed')`, [id, tenantId, t.name, role, JSON.stringify(t.widgets), partner]);
      await audit.record(tx, tenantId, { actorId: partner, deviceId: 'seed', action: 'dashboard.created', entity: 'dashboard', entityId: id, diff: { name: t.name, roleKey: role, widgets: t.widgets.length } });
    }
    const saved = async (name: string, owner: string, def: ReportDefinition, share: { firm?: boolean; roles?: string[] } = {}, source = 'builder') => {
      const id = uuidv7(); const d = reportDefinitionSchema.parse(def);
      await tx.query(`INSERT INTO saved_report (id, tenant_id, name, owner_id, definition, shared_firm, shared_roles, source, created_at, updated_by, device_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$4,'seed')`,
        [id, tenantId, name, owner, JSON.stringify(d), !!share.firm, share.roles ?? [], source, at(addDaysIso(today, -20), '11:00')]);
      await tx.query(`INSERT INTO saved_report_version (id, tenant_id, report_id, report_version, name, definition, changed_by, changed_at, device_id) VALUES ($1,$2,$3,1,$4,$5,$6,$7,'seed')`,
        [uuidv7(), tenantId, id, name, JSON.stringify(d), owner, at(addDaysIso(today, -20), '11:00')]);
      await audit.record(tx, tenantId, { actorId: owner, deviceId: 'seed', action: 'report.saved', entity: 'saved_report', entityId: id, diff: { name, dataset: d.dataset, source, shared: !!(share.firm || share.roles?.length) } });
      return id;
    };
    const prd = 'unbilled GST work FY 25-26 by user';
    const gst = await saved('Unbilled GST work FY 25-26 by user', partner, mockNlDefinition(prd) as ReportDefinition, { firm: true }, 'nl_query');
    await saved('Collections by mode this FY', users.accountant ?? partner, { dataset: 'receipts', columns: ['receivedOn', 'clientName', 'mode', 'amountPaise'], filters: [{ column: 'receivedOn', op: 'period', value: 'this_fy' }],
      groupBy: ['mode'], aggregates: [{ fn: 'sum', column: 'amountPaise' }], chart: { type: 'pie' } } as ReportDefinition, { roles: ['partner'] });
    await saved('My team: overdue GST tasks', users.manager ?? partner, { dataset: 'tasks', columns: ['title', 'clientName', 'assigneeName', 'statutoryDue', 'daysOverdue'],
      filters: [{ column: 'overdue', op: 'eq', value: true }, { column: 'serviceCategory', op: 'eq', value: 'GST' }], sort: [{ by: 'daysOverdue', dir: 'desc' }] } as ReportDefinition);

    // Weekly unbilled review to the partner and accounts (Monday 08:00 IST), with two delivered weeks of history.
    const sched: ReportSchedule = { frequency: 'weekly', time: '08:00', weekday: 1, dayOfMonth: 1 };
    const sid = uuidv7(); const recipients = [partner, users.accountant ?? partner].filter((x, i, xs) => xs.indexOf(x) === i);
    const next = nextScheduleRun(sched, at(today, '12:00'));
    // last run = the most recent Monday 08:00 strictly before today noon (history below covers the two weeks before it).
    await tx.query(`INSERT INTO report_schedule (id, tenant_id, name, owner_id, catalogue_key, schedule, recipient_ids, delivery, format, next_run_at, last_run_at, created_at, updated_by, device_id)
      VALUES ($1,$2,'Weekly unbilled review',$3,'unbilled_by_client',$4,$5,'email','xlsx',$6,$7,$8,$3,'seed')`, [sid, tenantId, partner, JSON.stringify(sched), recipients, next,
      at(mondayOf(today), '08:00'), at(addDaysIso(today, -21), '10:00')]);
    await tx.query('INSERT INTO job_queue (tenant_id, kind, ref_id, run_at) VALUES ($1,$2,$3,$4)', [tenantId, 'reports.schedule', sid, next]);
    for (const k of [7, 0]) {
      const monday = addDaysIso(mondayOf(today), -k);
      for (const r of recipients) {
        await tx.query(`INSERT INTO report_schedule_run (id, tenant_id, schedule_id, period_key, recipient_id, occurrence_at, status, row_count, started_at, finished_at, device_id)
          VALUES ($1,$2,$3,$4,$5,$6,'delivered',$7,$6,$6,'seed')`, [uuidv7(), tenantId, sid, `W${monday}`, r, at(monday, '08:00'), 10 + k]);
      }
    }
    await audit.record(tx, tenantId, { actorId: partner, deviceId: 'seed', action: 'report.schedule_created', entity: 'report_schedule', entityId: sid, diff: { name: 'Weekly unbilled review', catalogueKey: 'unbilled_by_client', recipients: recipients.length } });

    // NL-query examples (mock AI): the PRD question (saved as the shared report above) and one still proposed.
    for (const [q, status, savedId] of [[prd, 'saved', gst], ['overdue tasks by assignee', 'proposed', null]] as const) {
      const id = uuidv7(); const d = reportDefinitionSchema.parse(mockNlDefinition(q));
      await tx.query(`INSERT INTO report_ask (id, tenant_id, user_id, question_enc, definition_enc, status, dataset, sources, provider, model, saved_report_id, created_at, device_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'mock','mock-1',$9,$10,'seed')`, [id, tenantId, partner, await keys.encrypt(tx, tenantId, q, `report_ask:${id}:question`),
        await keys.encrypt(tx, tenantId, JSON.stringify(d), `report_ask:${id}:definition`), status, d.dataset, JSON.stringify([{ type: 'dataset', key: d.dataset, label: datasetMeta(d.dataset)!.label, columns: d.columns }]),
        savedId, at(addDaysIso(today, -20), '10:55')]);
    }
  });
}
