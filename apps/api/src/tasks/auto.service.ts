import { ForbiddenException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { can, clientCtx, effectiveScope, type Actor } from '@worko/domain';
import { dates, schedule } from '@worko/rules';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { loadActors } from '../clients/actors.js';
import { clientScopeSql, Params, visibilityOf } from '../clients/scope.js';
import { approvedExtensions, fyOfDate, loadClientsWithFacts, todayIst } from '../compliance/facts.js';
import { RulePackService } from '../compliance/rule-pack.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { JobQueueService, Reschedule } from '../jobs/job-queue.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { systemActor } from './system-actor.js';

export const AUTO_JOB = 'tasks.auto_month';

export type PlannedTask = {
  clientId: string; clientName: string; serviceTypeId: string; serviceKey: string; ruleId: string; form: string;
  periodKey: string; periodLabel: string; statutoryDue: string; actBy: string; extensionId: string | null;
  leaderId: string | null; managerId: string | null; assigneeId: string | null; reviewerId: string | null;
  checks: Array<{ key: string; label: string; required: boolean }>;
};

/** act_by = statutory due − SLA days (never after the statutory due). */
export const actByFor = (due: string, sla: number) => (sla > 0 ? dates.addDays(due, -sla) : due);
/** Next month's first day 02:00 IST as a Date. */
export function nextMonthStart(at: Date): Date {
  const [y, m] = todayIst(at).split('-').map(Number) as [number, number];
  const n = dates.addMonths(y, m, 1);
  return new Date(`${n.y}-${String(n.m).padStart(2, '0')}-01T02:00:00+05:30`);
}

/**
 * Auto-creation (M5): for a month, every rule due item whose period ends in that month, for clients subscribed to the
 * matching service, becomes one task per client × service × period. Idempotent via `task_auto_unique` + NOT EXISTS
 * (a deleted task is never resurrected — D56).
 */
@Injectable()
export class AutoTaskService implements OnModuleInit {
  private log = new Logger('AutoTasks');
  constructor(private db: DbService, private packs: RulePackService, private audit: AuditService, private realtime: RealtimeService, private jobs: JobQueueService) {}

  onModuleInit() {
    this.jobs.register(AUTO_JOB, async (job, at) => {
      const r = await this.commit(systemActor(job.tenant_id), todayIst(at).slice(0, 7));
      this.log.log(`Tenant ${job.tenant_id}: ${r.created} tasks for ${r.month}`);
      throw new Reschedule(nextMonthStart(at));
    });
    if (Number(process.env.JOB_POLL_MS ?? (process.env.NODE_ENV === 'test' ? 0 : 2000)) > 0) void this.scheduleMonthly().catch((e) => this.log.error(e));
  }

  /** Ensures every tenant has one live monthly auto-creation job (first run at `at`). */
  async scheduleMonthly(at = new Date()) {
    return (await this.db.systemTx((tx) => tx.query(
      `INSERT INTO job_queue (tenant_id, kind, ref_id, run_at)
       SELECT t.id, $1, t.id, $2 FROM tenant t WHERE NOT EXISTS (SELECT 1 FROM job_queue j WHERE j.tenant_id = t.id AND j.kind = $1 AND j.dead_at IS NULL)
       ON CONFLICT (tenant_id, kind) WHERE kind = 'tasks.auto_month' AND dead_at IS NULL DO NOTHING`, [AUTO_JOB, at]))).rowCount ?? 0;
  }

  async plan(tx: Tx, a: RequestActor, month: string, forCommit = false): Promise<{ items: PlannedTask[]; skipped: number }> {
    const { pack } = await this.packs.active(tx, a.tenantId);
    const p = new Params();
    // Commit also assigns people, so it needs tasks:assign on each client (D64); preview needs create only.
    const where = a.superAdmin ? 'TRUE' : `${clientScopeSql(a, 'clients', 'view', p)} AND ${clientScopeSql(a, 'tasks', 'create', p)}${forCommit ? ` AND ${clientScopeSql(a, 'tasks', 'assign', p)}` : ''}`;
    const clients = await loadClientsWithFacts(tx, where, p.values);
    if (!clients.length) return { items: [], skipped: 0 };
    const byId = new Map(clients.map((c) => [c.row.id as string, c.row]));
    const due = schedule({ pack, clients: clients.map((c) => c.facts), fy: fyOfDate(`${month}-01`), extensions: await approvedExtensions(tx) })
      .filter((i) => i.period.end.slice(0, 7) === month);
    const types = (await tx.query('SELECT * FROM service_type WHERE deleted_at IS NULL AND active')).rows;
    const subs = new Map((await tx.query('SELECT * FROM client_service WHERE deleted_at IS NULL AND active AND client_id = ANY($1)', [[...byId.keys()]])).rows
      .map((s) => [`${s.client_id}|${s.service_type_id}`, s]));
    const settings = (await tx.query('SELECT settings FROM tenant WHERE id = $1', [a.tenantId])).rows[0]?.settings ?? {};
    const defaultSla = Number(settings?.tasks?.defaultSlaDays ?? 0);
    const ruleKey = new Map(pack.rules.map((r) => [r.id, r.serviceTypeKey]));
    const actors = await loadActors(tx);
    const sees = (u: string | null | undefined, c: Record<string, unknown>) => {
      const x = u ? actors.find((y: Actor) => y.userId === u) : undefined;
      return !!x && can(x, 'clients', 'view', clientCtx(visibilityOf(c)));
    };
    const first = (c: Record<string, unknown>, ...xs: Array<string | null | undefined>) => xs.find((u) => sees(u, c)) ?? null;

    const planned: PlannedTask[] = [];
    for (const i of due) {
      const st = types.find((t) => t.rule_id === i.ruleId) ?? types.find((t) => !t.rule_id && t.key === ruleKey.get(i.ruleId));
      if (!st) continue;
      const sub = subs.get(`${i.clientId}|${st.id}`);
      const pm = i.period.end.slice(0, 7);
      if (!sub || (sub.start_period && pm < sub.start_period) || (sub.end_period && pm > sub.end_period)) continue;
      const c = byId.get(i.clientId)!;
      const staff = (c.staff_ids as string[]) ?? [];
      // Assignment order: subscription override → service default → the client's own people.
      planned.push({
        clientId: i.clientId, clientName: c.name as string, serviceTypeId: st.id, serviceKey: st.key, ruleId: i.ruleId, form: i.form,
        periodKey: i.period.key, periodLabel: i.period.label, statutoryDue: i.statutoryDue,
        actBy: actByFor(i.statutoryDue, st.sla_days ?? defaultSla), extensionId: i.extensionId ?? null,
        assigneeId: first(c, sub.assignee_id, st.assignee_id, ...staff, c.manager_id as string, c.partner_id as string),
        reviewerId: first(c, sub.reviewer_id, st.reviewer_id, c.manager_id as string, c.partner_id as string),
        managerId: first(c, sub.manager_id, st.manager_id, c.manager_id as string),
        leaderId: first(c, sub.leader_id, st.leader_id, c.partner_id as string),
        checks: st.default_checks ?? [],
      });
    }
    if (!planned.length) return { items: [], skipped: 0 };
    // Any existing row (live or deleted) for client × service × period means "already handled".
    const existing = new Set((await tx.query(
      `SELECT client_id || '|' || service_type_id || '|' || period_key AS k FROM task WHERE client_id = ANY($1) AND service_type_id = ANY($2) AND period_key = ANY($3)`,
      [[...new Set(planned.map((x) => x.clientId))], [...new Set(planned.map((x) => x.serviceTypeId))], [...new Set(planned.map((x) => x.periodKey))]])).rows.map((r) => r.k as string));
    const items = planned.filter((x) => !existing.has(`${x.clientId}|${x.serviceTypeId}|${x.periodKey}`));
    return { items, skipped: planned.length - items.length };
  }

  async preview(a: RequestActor, month: string) {
    const r = await this.db.tenantTx(a.tenantId, (tx) => this.plan(tx, a, month));
    return { month, toCreate: r.items.length, skipped: r.skipped, items: r.items };
  }

  async commit(a: RequestActor, month: string) {
    const r = await this.db.tenantTx(a.tenantId, (tx) => this.commitTx(tx, a, month));
    if (r.cursor) this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor: r.cursor });
    return { month, created: r.ids.length, skipped: r.skipped, ids: r.ids };
  }

  async commitTx(tx: Tx, a: RequestActor, month: string) {
    if (!a.superAdmin && (effectiveScope(a, 'tasks', 'assign')?.scope ?? 'none') === 'none') throw new ForbiddenException('Missing permission tasks:assign');
    const plan = await this.plan(tx, a, month, true);
    const ids: string[] = []; let cursor = 0; let skipped = plan.skipped;
    for (const x of plan.items) {
      const checks = x.checks.map((c) => ({ ...c, done: false, doneBy: null, doneAt: null }));
      const r = await tx.query(
        `INSERT INTO task (id, tenant_id, client_id, service_type_id, period_key, period_label, title, statutory_due, act_by, leader_id, manager_id, assignee_id, reviewer_id,
           checks, source, rule_id, extension_id, created_by, updated_by, device_id)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'auto',$15,$16,$17,$17,'server'
         WHERE NOT EXISTS (SELECT 1 FROM task WHERE client_id = $3 AND service_type_id = $4 AND period_key = $5)
         ON CONFLICT (tenant_id, client_id, service_type_id, period_key) WHERE deleted_at IS NULL DO NOTHING RETURNING id, sync_cursor`,
        [uuidv7(), a.tenantId, x.clientId, x.serviceTypeId, x.periodKey, x.periodLabel, `${x.form} — ${x.periodLabel}`, x.statutoryDue, x.actBy,
          x.leaderId, x.managerId, x.assigneeId, x.reviewerId, JSON.stringify(checks), x.ruleId, x.extensionId, a.userId ?? null]);
      if (!r.rowCount) { skipped++; continue; }
      ids.push(r.rows[0].id); cursor = Math.max(cursor, Number(r.rows[0].sync_cursor));
    }
    if (ids.length) {
      await this.audit.record(tx, a.tenantId, { actorId: a.userId ?? null, deviceId: a.deviceId, action: 'task.auto_created', entity: 'task', entityId: null, diff: { month, count: ids.length, ids } });
    }
    return { ids, skipped, cursor };
  }
}
