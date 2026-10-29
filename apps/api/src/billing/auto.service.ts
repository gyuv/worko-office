import { udinClearSql } from '../practice/udin-gate.js';
import { ConflictException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { Params } from '../clients/scope.js';
import { todayIst } from '../compliance/facts.js';
import { DbService, type Tx } from '../db/db.service.js';
import { JobQueueService, Reschedule } from '../jobs/job-queue.service.js';
import { systemActor } from '../tasks/system-actor.js';
import { d, n, scopeSql } from './common.js';
import { Cursor, InvoicesService } from './invoices.service.js';

export const RETAINER_JOB = 'billing.retainers';

/**
 * Rate for a service on a date (D68): client override → group override → firm default, latest effective_from wins.
 * Prices are data (billing_rate); nothing is hard-coded.
 */
export async function rateFor(tx: Tx, serviceTypeId: string, client: { id: string; group_ids?: string[] }, on: string): Promise<number | null> {
  const r = (await tx.query(`SELECT amount_paise FROM billing_rate WHERE service_type_id = $1 AND deleted_at IS NULL AND effective_from <= $3::date
      AND (effective_to IS NULL OR effective_to >= $3::date) AND (client_id = $2 OR group_id = ANY($4::uuid[]) OR (client_id IS NULL AND group_id IS NULL))
    ORDER BY (client_id IS NOT NULL) DESC, (group_id IS NOT NULL) DESC, effective_from DESC LIMIT 1`, [serviceTypeId, client.id, on, client.group_ids ?? []])).rows[0];
  return r ? n(r.amount_paise) : null;
}

export type UnbilledTask = {
  taskId: string; clientId: string; clientName: string; title: string; periodKey: string | null; serviceTypeId: string | null; serviceKey: string | null;
  completedOn: string | null; suggestedPaise: number | null; retainer: boolean;
};

const monthEnd = (ym: string) => { const [y, m] = ym.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const shiftMonth = (ym: string, k: number) => { const [y, m] = ym.split('-').map(Number) as [number, number]; const t = new Date(Date.UTC(y, m - 1 + k, 1)); return t.toISOString().slice(0, 7); };
const MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, annual: 12 };
/** Is a subscription billed for the period ending in `ym`? Quarters end Jun/Sep/Dec/Mar, years in March (FY). */
const billsIn = (freq: string, ym: string) => { const m = Number(ym.slice(5)); return freq === 'monthly' || (freq === 'quarterly' && m % 3 === 0) || (freq === 'annual' && m === 3); };

@Injectable()
export class BillingAutoService implements OnModuleInit {
  private log = new Logger('Billing');
  constructor(private db: DbService, private invoices: InvoicesService, private audit: AuditService, private jobs: JobQueueService) {}

  onModuleInit() {
    this.jobs.register(RETAINER_JOB, async (job, at) => {
      const month = shiftMonth(todayIst(at).slice(0, 7), -1); // on the 1st, bill the month that just ended
      const r = await this.commitRetainers(systemActor(job.tenant_id), month);
      this.log.log(`Tenant ${job.tenant_id}: ${r.created} retainer drafts for ${month}`);
      const next = shiftMonth(todayIst(at).slice(0, 7), 1);
      throw new Reschedule(new Date(`${next}-01T03:00:00+05:30`));
    });
    if (Number(process.env.JOB_POLL_MS ?? (process.env.NODE_ENV === 'test' ? 0 : 2000)) > 0) {
      const next = shiftMonth(todayIst().slice(0, 7), 1);
      void this.scheduleMonthly(new Date(`${next}-01T03:00:00+05:30`)).catch((e) => this.log.error(e));
    }
  }

  /** Done tasks without an outcome, visible for billing, with the suggested value from the rate tables. */
  async unbilledTx(tx: Tx, a: RequestActor, q: { from?: string; to?: string; clientId?: string; action?: 'view' | 'create' }): Promise<UnbilledTask[]> {
    const p = new Params();
    const where = ["t.status = 'done'", 't.outcome IS NULL', 't.deleted_at IS NULL', 'c.deleted_at IS NULL', scopeSql(a, 'billing', q.action ?? 'view', p),
      'COALESCE(s.billable, true)', 'NOT EXISTS (SELECT 1 FROM invoice_task it WHERE it.task_id = t.id AND it.live)', udinClearSql('t')];
    const done = `(t.completed_at AT TIME ZONE 'Asia/Kolkata')::date`;
    if (q.from) where.push(`${done} >= ${p.add(q.from)}::date`);
    if (q.to) where.push(`${done} <= ${p.add(q.to)}::date`);
    if (q.clientId) where.push(`t.client_id = ${p.add(q.clientId)}`);
    const rows = (await tx.query(`SELECT t.id, t.client_id, c.name AS client_name, c.group_ids, t.title, t.period_key, t.service_type_id, s.key AS service_key, ${done} AS done_on,
        t.statutory_due, EXISTS (SELECT 1 FROM client_service cs WHERE cs.client_id = t.client_id AND cs.service_type_id = t.service_type_id AND cs.deleted_at IS NULL
          AND cs.active AND cs.billing_frequency IS NOT NULL) AS retainer
      FROM task t JOIN client c ON c.id = t.client_id LEFT JOIN service_type s ON s.id = t.service_type_id
      WHERE ${where.join(' AND ')} ORDER BY lower(c.name), c.id, t.statutory_due NULLS LAST, t.id`, p.values)).rows;
    const out: UnbilledTask[] = [];
    for (const r of rows) {
      const on = d(r.statutory_due) ?? d(r.done_on) ?? todayIst();
      out.push({ taskId: r.id, clientId: r.client_id, clientName: r.client_name, title: r.title, periodKey: r.period_key, serviceTypeId: r.service_type_id, serviceKey: r.service_key,
        completedOn: d(r.done_on), retainer: r.retainer,
        suggestedPaise: r.retainer ? 0 : r.service_type_id ? await rateFor(tx, r.service_type_id, { id: r.client_id, group_ids: r.group_ids }, on) : null });
    }
    return out;
  }

  unbilled(a: RequestActor, q: { from?: string; to?: string; clientId?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const items = await this.unbilledTx(tx, a, q);
      return { items, count: items.length, suggestedTotalPaise: items.reduce((s, x) => s + (x.suggestedPaise ?? 0), 0) };
    });
  }

  /** Plan: one draft per client from its done-unbilled, priced, non-retainer tasks. Unpriced tasks are reported, not billed. */
  private async planTx(tx: Tx, a: RequestActor, q: { from?: string; to: string; clientIds?: string[] }) {
    const tasks = (await this.unbilledTx(tx, a, { from: q.from, to: q.to, action: 'create' })).filter((t) => !t.retainer && (!q.clientIds || q.clientIds.includes(t.clientId)));
    const byClient = new Map<string, { clientId: string; clientName: string; lines: Array<{ taskId: string; title: string; serviceTypeId: string; ratePaise: number }> }>();
    const unpriced: UnbilledTask[] = [];
    for (const t of tasks) {
      if (t.suggestedPaise === null || !t.serviceTypeId) { unpriced.push(t); continue; }
      const g = byClient.get(t.clientId) ?? { clientId: t.clientId, clientName: t.clientName, lines: [] };
      g.lines.push({ taskId: t.taskId, title: t.title, serviceTypeId: t.serviceTypeId, ratePaise: t.suggestedPaise });
      byClient.set(t.clientId, g);
    }
    const drafts = [...byClient.values()].map((g) => ({ ...g, taxablePaise: g.lines.reduce((s, l) => s + l.ratePaise, 0) }));
    return { drafts, unpriced };
  }

  preview(a: RequestActor, q: { from?: string; to: string; clientIds?: string[] }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = await this.planTx(tx, a, q);
      return { invoices: p.drafts.length, tasks: p.drafts.reduce((s, x) => s + x.lines.length, 0), drafts: p.drafts, unpriced: p.unpriced };
    });
  }

  /** Idempotent: a task already on a live invoice is never planned again (and the unique index refuses races). */
  async commit(a: RequestActor, q: { from?: string; to: string; clientIds?: string[]; entityId?: string | null }) {
    const cur = new Cursor();
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const plan = await this.planTx(tx, a, q);
      const ids: string[] = []; let skipped = 0;
      for (const g of plan.drafts) {
        await tx.query('SAVEPOINT auto_bill');
        try {
          ids.push(await this.invoices.createDraftTx(tx, a, {
            clientId: g.clientId, entityId: q.entityId,
            lines: g.lines.map((l) => ({ description: l.title, serviceTypeId: l.serviceTypeId, ratePaise: l.ratePaise, taskIds: [l.taskId] })),
          }, 'auto', cur));
        } catch (e) {
          if (!(e instanceof ConflictException)) throw e;
          await tx.query('ROLLBACK TO SAVEPOINT auto_bill'); skipped++;
        }
      }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'billing.auto_committed', entity: 'invoice', diff: { from: q.from ?? null, to: q.to, created: ids.length, skipped, unpriced: plan.unpriced.length } });
      return { created: ids.length, ids, skipped, unpriced: plan.unpriced.length };
    });
    this.invoices.publish(a, cur);
    return r;
  }

  // ---------- Retainers ----------

  private async retainerPlanTx(tx: Tx, a: RequestActor, month: string) {
    const p = new Params();
    const subs = (await tx.query(`SELECT cs.id, cs.client_id, cs.service_type_id, cs.billing_frequency, c.name AS client_name, c.group_ids, s.name AS service_name,
        EXISTS (SELECT 1 FROM invoice i WHERE i.client_service_id = cs.id AND i.period_key = ${p.add(month)} AND i.source = 'retainer' AND i.deleted_at IS NULL AND i.status <> 'cancelled') AS exists
      FROM client_service cs JOIN client c ON c.id = cs.client_id JOIN service_type s ON s.id = cs.service_type_id
      WHERE cs.deleted_at IS NULL AND cs.active AND cs.billing_frequency IS NOT NULL AND c.deleted_at IS NULL AND c.status = 'active'
        AND (cs.start_period IS NULL OR cs.start_period <= ${p.add(month)}) AND (cs.end_period IS NULL OR cs.end_period >= ${p.add(month)})
        AND ${scopeSql(a, 'billing', 'create', p)} ORDER BY lower(c.name), cs.id`, p.values)).rows.filter((s) => billsIn(s.billing_frequency, month));
    const items = [];
    for (const s of subs) {
      const rate = await rateFor(tx, s.service_type_id, { id: s.client_id, group_ids: s.group_ids }, monthEnd(month));
      items.push({ clientServiceId: s.id as string, clientId: s.client_id as string, clientName: s.client_name as string, serviceTypeId: s.service_type_id as string,
        serviceName: s.service_name as string, frequency: s.billing_frequency as string, ratePaise: rate, exists: s.exists as boolean });
    }
    return items;
  }

  previewRetainers(a: RequestActor, month: string) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const items = await this.retainerPlanTx(tx, a, month);
      return { month, toCreate: items.filter((x) => !x.exists && x.ratePaise !== null).length, items };
    });
  }

  /** One retainer draft per subscription × period; the period's done tasks of that service are linked (billed) to it. */
  async commitRetainers(a: RequestActor, month: string) {
    const cur = new Cursor();
    const r = await this.db.tenantTx(a.tenantId, async (tx) => {
      const items = await this.retainerPlanTx(tx, a, month);
      const ids: string[] = []; let skipped = 0;
      for (const x of items) {
        if (x.exists || x.ratePaise === null) { skipped++; continue; }
        const first = shiftMonth(month, 1 - MONTHS[x.frequency]!);
        const tasks = (await tx.query(`SELECT t.id FROM task t WHERE t.client_id = $1 AND t.service_type_id = $2 AND t.status = 'done' AND t.outcome IS NULL AND t.deleted_at IS NULL AND ${udinClearSql('t')}
          AND t.period_key >= $3 AND t.period_key <= $4 AND NOT EXISTS (SELECT 1 FROM invoice_task it WHERE it.task_id = t.id AND it.live)`, [x.clientId, x.serviceTypeId, first, month])).rows.map((t) => t.id as string);
        await tx.query('SAVEPOINT retainer');
        try {
          ids.push(await this.invoices.createDraftTx(tx, a, {
            clientId: x.clientId, lines: [{ description: `${x.serviceName} — retainer ${first === month ? month : `${first} to ${month}`}`, serviceTypeId: x.serviceTypeId, ratePaise: x.ratePaise, taskIds: tasks }],
          }, 'retainer', cur, { clientServiceId: x.clientServiceId, periodKey: month }));
        } catch (e) {
          if (!(e instanceof ConflictException)) throw e;
          await tx.query('ROLLBACK TO SAVEPOINT retainer'); skipped++;
        }
      }
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'billing.retainers_committed', entity: 'invoice', diff: { month, created: ids.length, skipped } });
      return { month, created: ids.length, ids, skipped };
    });
    this.invoices.publish(a, cur);
    return r;
  }

  /** Ensures every tenant has one live monthly retainer job (first run at `at`). */
  async scheduleMonthly(at = new Date()) {
    return (await this.db.systemTx((tx) => tx.query(
      `INSERT INTO job_queue (tenant_id, kind, ref_id, run_at) SELECT t.id, $1, t.id, $2 FROM tenant t
       ON CONFLICT (tenant_id, kind) WHERE kind IN ('billing.followups','billing.retainers') AND dead_at IS NULL DO NOTHING`, [RETAINER_JOB, at]))).rowCount ?? 0;
  }
}
