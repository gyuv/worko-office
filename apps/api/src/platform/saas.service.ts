import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import {
  addDaysIso, dunningStep, effectiveFeatures, lifecycleConfigSchema, nextPeriod, priceOn, saasInvoiceTotals, seatCheck, seatLimit, seatsUsed, subscriptionPaid,
  subscriptionTick, tenantBlocked, type BillingCycle, type FeatureMap, type LifecycleConfig, type Plan, type SaasFeature, type SubscriptionState,
} from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { PlatformActor, RequestActor } from '../auth/context.js';
import { PAYMENT_PROVIDERS, defaultPaymentProvider, type PaymentProvider } from '../billing/providers.js';
import { Clock } from '../common/clock.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { JobQueueService, Reschedule } from '../jobs/job-queue.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PlatformAuditService } from './platform-audit.service.js';

export const SAAS_JOB = 'saas.daily';
type PlanRow = Plan & { active: boolean };
type Supplier = { name: string; gstin: string | null; stateCode: string; address: string; sac: string; gstRate: number; invoicePrefix: string };

const planSql = `SELECT key, name, seats, storage_gb AS "storageGb", portal_users_count_as_seats AS "portalUsersCountAsSeats", modules, active FROM saas_plan`;
const dateStr = (d: Date | string | null) => (d === null ? null : typeof d === 'string' ? d.slice(0, 10) : new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10));

/** Seats in use vs the limit, inside the caller's tenant transaction (tenant + saas_plan are readable by worko_app). */
export async function seatInfo(tx: Tx, tenantId: string) {
  const t = (await tx.query('SELECT plan, seat_limit FROM tenant WHERE id = $1', [tenantId])).rows[0];
  const plan = t ? ((await tx.query(`${planSql} WHERE key = $1`, [t.plan])).rows[0] as PlanRow | undefined) : undefined;
  const c = (await tx.query(`SELECT (SELECT count(*)::int FROM app_user WHERE kind IN ('staff','freelancer') AND status = 'active' AND deleted_at IS NULL) AS staff,
    (SELECT count(*)::int FROM portal_user WHERE status IN ('invited','active')) AS portal`)).rows[0];
  const used = seatsUsed({ staff: c.staff, portalUsers: c.portal }, plan);
  return { plan: plan ?? null, used, limit: seatLimit(plan, t?.seat_limit ?? null), staff: c.staff as number, portalUsers: c.portal as number };
}

/** Refuses adding a staff seat beyond the plan (402 SEAT_LIMIT with a clear message). Called by user create/reactivate. */
export async function assertSeatAvailable(tx: Tx, tenantId: string, adding = 1) {
  const s = await seatInfo(tx, tenantId);
  const chk = seatCheck(s.used, s.limit, adding);
  if (!chk.ok) {
    throw new HttpException({ code: 'SEAT_LIMIT', message: `Your ${s.plan?.name ?? 'current'} plan includes ${s.limit} seats and ${s.used} are in use. Deactivate a user or request an upgrade under Settings → Subscription.`, used: s.used, limit: s.limit },
      HttpStatus.PAYMENT_REQUIRED);
  }
}

/** Effective switchable modules for a tenant (plan defaults ⊕ super-admin overrides). */
export async function tenantFeatures(tx: Tx, tenantId: string): Promise<FeatureMap> {
  const t = (await tx.query('SELECT plan, feature_flags FROM tenant WHERE id = $1', [tenantId])).rows[0];
  const plan = t ? (await tx.query(`${planSql} WHERE key = $1`, [t.plan])).rows[0] : null;
  return effectiveFeatures(plan, t?.feature_flags ?? {});
}

@Injectable()
export class SaasService implements OnModuleInit {
  private log = new Logger('Saas');
  constructor(private db: DbService, private audit: AuditService, private paudit: PlatformAuditService, private clock: Clock, private jobs: JobQueueService,
    private notifications: NotificationsService, @Inject(PAYMENT_PROVIDERS) private providers: Record<string, PaymentProvider>) {}

  onModuleInit() {
    this.jobs.register(SAAS_JOB, async (job, at) => {
      const day = new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
      await this.runDaily(job.tenant_id, day);
      throw new Reschedule(new Date(`${addDaysIso(day, 1)}T02:10:00+05:30`));
    });
    if (Number(process.env.JOB_POLL_MS ?? (process.env.NODE_ENV === 'test' ? 0 : 2000)) > 0) {
      void this.db.systemTx((tx) => tx.query(`INSERT INTO job_queue (tenant_id, kind, ref_id, run_at) SELECT t.id, $1, t.id, $2 FROM tenant t
        ON CONFLICT (tenant_id, kind) WHERE kind = 'saas.daily' AND dead_at IS NULL DO NOTHING`, [SAAS_JOB, new Date(`${addDaysIso(this.clock.todayIst(), 1)}T02:10:00+05:30`)]))
        .catch((e) => this.log.error(e));
    }
  }

  // ---------------- settings (platform data) ----------------

  private async setting<T>(key: string): Promise<T> {
    return (await this.db.systemTx((tx) => tx.query('SELECT value FROM platform_setting WHERE key = $1', [key]))).rows[0]?.value as T;
  }
  lifecycle(): Promise<LifecycleConfig> { return this.setting<unknown>('saas.lifecycle').then((v) => lifecycleConfigSchema.parse(v ?? {})); }
  supplier(): Promise<Supplier> { return this.setting<Supplier>('saas.supplier'); }

  // ---------------- plans ----------------

  listPlans() {
    return this.db.systemTx(async (tx) => {
      const plans = (await tx.query(`${planSql} ORDER BY sort, key`)).rows;
      const prices = (await tx.query(`SELECT id, plan_key AS "planKey", cycle, price_paise::int AS "pricePaise", to_char(effective_from,'YYYY-MM-DD') AS "effectiveFrom", unverified, notes
        FROM saas_plan_price ORDER BY plan_key, cycle, effective_from`)).rows;
      return plans.map((p) => ({ ...p, prices: prices.filter((x) => x.planKey === p.key) }));
    });
  }

  async upsertPlan(p: PlatformActor, plan: Plan & { active?: boolean }) {
    await this.db.systemTx(async (tx) => {
      await tx.query(`INSERT INTO saas_plan (key, name, seats, storage_gb, portal_users_count_as_seats, modules, active) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (key) DO UPDATE SET name = $2, seats = $3, storage_gb = $4, portal_users_count_as_seats = $5, modules = $6, active = $7`,
        [plan.key, plan.name, plan.seats, plan.storageGb, plan.portalUsersCountAsSeats, JSON.stringify(plan.modules), plan.active ?? true]);
      await this.paudit.recordTx(tx, { adminId: p.adminId, action: 'platform.plan_saved', entity: 'saas_plan', entityId: plan.key, diff: plan, ip: p.ip });
    });
    return (await this.listPlans()).find((x) => x.key === plan.key);
  }

  async addPrice(p: PlatformActor, key: string, b: { cycle: BillingCycle; pricePaise: number; effectiveFrom: string; notes?: string; unverified?: boolean }) {
    return this.db.systemTx(async (tx) => {
      if (!(await tx.query('SELECT 1 FROM saas_plan WHERE key = $1', [key])).rowCount) throw new NotFoundException();
      try {
        const id = (await tx.query(`INSERT INTO saas_plan_price (plan_key, cycle, price_paise, effective_from, notes, unverified) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [key, b.cycle, b.pricePaise, b.effectiveFrom, b.notes ?? null, b.unverified ?? true])).rows[0].id;
        await this.paudit.recordTx(tx, { adminId: p.adminId, action: 'platform.price_added', entity: 'saas_plan_price', entityId: id, diff: { key, ...b }, ip: p.ip });
        return { id };
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new BadRequestException('A price for that plan, cycle and date exists');
        throw e;
      }
    });
  }

  // ---------------- tenants ----------------

  listTenants(q: { q?: string; status?: string; limit: number }) {
    return this.db.systemTx(async (tx) => (await tx.query(
      `SELECT t.id, t.name, t.slug, t.plan, t.status, t.sub_status AS "subStatus", t.seat_limit AS "seatLimit", t.created_at AS "createdAt",
              to_char(t.trial_ends_on,'YYYY-MM-DD') AS "trialEndsOn", to_char(t.period_end,'YYYY-MM-DD') AS "periodEnd"
       FROM tenant t WHERE ($1::text IS NULL OR t.name ILIKE '%' || $1 || '%' OR t.slug ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR t.status = $2 OR t.sub_status = $2)
       ORDER BY t.created_at DESC LIMIT $3`, [q.q ?? null, q.status ?? null, q.limit])).rows);
  }

  private async tenantRow(tenantId: string) {
    const t = (await this.db.systemTx((tx) => tx.query(`SELECT * FROM tenant WHERE id = $1`, [tenantId]))).rows[0];
    if (!t) throw new NotFoundException();
    return t;
  }

  /** Live usage numbers inside the tenant's own transaction (RLS-scoped). */
  usageTx = async (tx: Tx, tenantId: string, month: string) => {
    const s = await seatInfo(tx, tenantId);
    const r = (await tx.query(`SELECT
        (SELECT coalesce(sum(size),0)::bigint FROM document WHERE deleted_at IS NULL) AS storage,
        (SELECT count(*)::int FROM comm_message WHERE direction = 'out' AND to_char(created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM') = $1) AS messages,
        (SELECT count(*)::int FROM ai_usage WHERE month = $1) AS ai_calls, (SELECT coalesce(sum(cost_paise),0)::bigint FROM ai_usage WHERE month = $1) AS ai_cost`, [month])).rows[0];
    return { month, seatsUsed: s.used, seatLimit: s.limit, staff: s.staff, portalUsers: s.portalUsers, storageBytes: Number(r.storage),
      storageLimitBytes: s.plan?.storageGb ? s.plan.storageGb * 1024 ** 3 : null, messages: r.messages as number, aiCalls: r.ai_calls as number, aiCostPaise: Number(r.ai_cost) };
  };

  /** Monthly usage snapshot (metering aggregation; idempotent upsert per tenant × month). */
  async meter(tenantId: string, month = this.clock.todayIst().slice(0, 7)) {
    return this.db.tenantTx(tenantId, async (tx) => {
      const u = await this.usageTx(tx, tenantId, month);
      await tx.query(`INSERT INTO saas_usage (id, tenant_id, month, seats, portal_users, storage_bytes, messages, ai_calls, ai_cost_paise, computed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
        ON CONFLICT (tenant_id, month) DO UPDATE SET seats = $4, portal_users = $5, storage_bytes = $6, messages = $7, ai_calls = $8, ai_cost_paise = $9, computed_at = now()`,
        [uuidv7(), tenantId, month, u.seatsUsed, u.portalUsers, u.storageBytes, u.messages, u.aiCalls, u.aiCostPaise]);
      return u;
    });
  }

  async tenantDetail(p: PlatformActor, tenantId: string) {
    const t = await this.tenantRow(tenantId);
    const month = this.clock.todayIst().slice(0, 7);
    const inner = await this.db.tenantTx(tenantId, async (tx) => ({
      usage: await this.usageTx(tx, tenantId, month),
      features: await tenantFeatures(tx, tenantId),
      history: (await tx.query(`SELECT month, seats, portal_users AS "portalUsers", storage_bytes::bigint AS "storageBytes", messages, ai_calls AS "aiCalls", ai_cost_paise::int AS "aiCostPaise" FROM saas_usage ORDER BY month DESC LIMIT 12`)).rows,
      invoices: await this.invoicesTx(tx),
      grants: (await tx.query(`SELECT id, status, reason, requested_write AS "requestedWrite", write_consent AS "writeConsent", requested_at AS "requestedAt", expires_at AS "expiresAt", actions
        FROM impersonation_grant ORDER BY requested_at DESC LIMIT 20`)).rows,
      upgradeRequests: (await tx.query(`SELECT id, plan_key AS "planKey", cycle, status, created_at AS "createdAt" FROM saas_upgrade_request ORDER BY created_at DESC LIMIT 20`)).rows,
    }));
    await this.paudit.record({ adminId: p.adminId, tenantId, action: 'platform.tenant_viewed', entity: 'tenant', entityId: tenantId, ip: p.ip });
    return { tenant: this.tenantOut(t), ...inner };
  }

  private tenantOut(t: Record<string, unknown>) {
    return { id: t.id, name: t.name, slug: t.slug, plan: t.plan, seatLimit: t.seat_limit, featureOverrides: t.feature_flags, status: t.status, suspendedAt: t.suspended_at, suspendedReason: t.suspended_reason,
      subStatus: t.sub_status, billingCycle: t.billing_cycle, trialEndsOn: dateStr(t.trial_ends_on as Date | null), periodStart: dateStr(t.period_start as Date | null), periodEnd: dateStr(t.period_end as Date | null),
      pastDueSince: dateStr(t.past_due_since as Date | null), createdAt: t.created_at };
  }

  /** Platform suspension (blocks logins + jobs, keeps data) — double-audited (platform + tenant). */
  async setSuspended(p: PlatformActor, tenantId: string, suspended: boolean, reason: string | null) {
    await this.tenantRow(tenantId);
    await this.db.systemTx(async (tx) => {
      await tx.query(`UPDATE tenant SET status = $2, suspended_at = CASE WHEN $2 = 'suspended' THEN now() END, suspended_reason = $3 WHERE id = $1`, [tenantId, suspended ? 'suspended' : 'active', suspended ? reason : null]);
      await this.paudit.recordTx(tx, { adminId: p.adminId, tenantId, action: suspended ? 'platform.tenant_suspended' : 'platform.tenant_reactivated', entity: 'tenant', entityId: tenantId, diff: { reason }, ip: p.ip });
    });
    await this.db.tenantTx(tenantId, (tx) => this.audit.record(tx, tenantId, { actorId: null, deviceId: 'platform', action: suspended ? 'tenant.suspended' : 'tenant.reactivated', entity: 'tenant', entityId: tenantId, diff: { platformAdminId: p.adminId, reason } }));
    return this.tenantOut(await this.tenantRow(tenantId));
  }

  async setFlags(p: PlatformActor, tenantId: string, overrides: Partial<Record<SaasFeature, boolean | null>>) {
    const t = await this.tenantRow(tenantId);
    const next = { ...(t.feature_flags ?? {}) } as Record<string, boolean>;
    for (const [k, v] of Object.entries(overrides)) { if (v === null) delete next[k]; else next[k] = v as boolean; }
    await this.db.systemTx(async (tx) => {
      await tx.query('UPDATE tenant SET feature_flags = $2 WHERE id = $1', [tenantId, JSON.stringify(next)]);
      await this.paudit.recordTx(tx, { adminId: p.adminId, tenantId, action: 'platform.flags_set', entity: 'tenant', entityId: tenantId, diff: { overrides }, ip: p.ip });
    });
    await this.db.tenantTx(tenantId, (tx) => this.audit.record(tx, tenantId, { actorId: null, deviceId: 'platform', action: 'tenant.features_changed', entity: 'tenant', entityId: tenantId, diff: { platformAdminId: p.adminId, overrides } }));
    return this.db.tenantTx(tenantId, (tx) => tenantFeatures(tx, tenantId));
  }

  async assignPlan(p: PlatformActor, tenantId: string, b: { planKey: string; cycle?: BillingCycle; seatLimit?: number | null }) {
    await this.tenantRow(tenantId);
    await this.db.systemTx(async (tx) => {
      if (!(await tx.query('SELECT 1 FROM saas_plan WHERE key = $1 AND active', [b.planKey])).rowCount) throw new BadRequestException('Unknown plan');
      await tx.query(`UPDATE tenant SET plan = $2, billing_cycle = COALESCE($3, billing_cycle), seat_limit = CASE WHEN $5 THEN $4::int ELSE seat_limit END WHERE id = $1`,
        [tenantId, b.planKey, b.cycle ?? null, b.seatLimit ?? null, b.seatLimit !== undefined]);
      await this.paudit.recordTx(tx, { adminId: p.adminId, tenantId, action: 'platform.plan_assigned', entity: 'tenant', entityId: tenantId, diff: b, ip: p.ip });
    });
    await this.db.tenantTx(tenantId, async (tx) => {
      await tx.query(`UPDATE saas_upgrade_request SET status = 'done' WHERE status = 'open' AND plan_key = $1`, [b.planKey]);
      await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'platform', action: 'tenant.plan_changed', entity: 'tenant', entityId: tenantId, diff: { platformAdminId: p.adminId, ...b } });
    });
    return this.tenantOut(await this.tenantRow(tenantId));
  }

  // ---------------- lifecycle ----------------

  private subState(t: Record<string, unknown>): SubscriptionState {
    return { status: t.sub_status as SubscriptionState['status'], trialEndsOn: dateStr(t.trial_ends_on as Date | null), periodStart: dateStr(t.period_start as Date | null), periodEnd: dateStr(t.period_end as Date | null),
      pastDueSince: dateStr(t.past_due_since as Date | null), suspendedSince: dateStr(t.sub_suspended_since as Date | null) };
  }

  /** Daily lifecycle for one tenant at `today` (IST; injectable clock): invoices, state transitions, dunning, metering. Idempotent per day. */
  async runDaily(tenantId: string, today = this.clock.todayIst(), by: PlatformActor | null = null) {
    const cfg = await this.lifecycle();
    const t = await this.tenantRow(tenantId);
    const s = this.subState(t);
    const nextStart = s.status === 'trial' ? (s.trialEndsOn ? addDaysIso(s.trialEndsOn, 1) : today) : s.periodEnd ? addDaysIso(s.periodEnd, 1) : today;
    const facts = await this.db.tenantTx(tenantId, async (tx) => ({
      oldestUnpaidDue: dateStr((await tx.query(`SELECT min(due_date) AS d FROM saas_invoice WHERE status = 'issued'`)).rows[0].d),
      nextPeriodInvoiced: !!(await tx.query(`SELECT 1 FROM saas_invoice WHERE period_start = $1 AND status <> 'void'`, [nextStart])).rowCount,
    }));
    const { state, actions } = subscriptionTick(s, facts, today, cfg);
    let invoiceId: string | null = null;
    if (actions.includes('issue_invoice')) {
      const planKey = t.plan === 'trial' ? cfg.conversionPlan : t.plan as string;
      invoiceId = await this.issueInvoice(tenantId, planKey, t.billing_cycle as BillingCycle, nextStart, today, cfg.invoiceDueDays);
      if (t.plan === 'trial') await this.db.systemTx((tx) => tx.query('UPDATE tenant SET plan = $2 WHERE id = $1', [tenantId, planKey]));
    }
    const changed = state.status !== s.status;
    if (changed || state.pastDueSince !== s.pastDueSince) {
      await this.db.systemTx(async (tx) => {
        await tx.query(`UPDATE tenant SET sub_status = $2, past_due_since = $3, sub_suspended_since = $4, cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE cancelled_at END WHERE id = $1`,
          [tenantId, state.status, state.pastDueSince, state.suspendedSince]);
        await this.paudit.recordTx(tx, { adminId: by?.adminId ?? null, tenantId, action: 'saas.subscription_changed', entity: 'tenant', entityId: tenantId, diff: { from: s.status, to: state.status, today } });
      });
      await this.db.tenantTx(tenantId, (tx) => this.audit.record(tx, tenantId, { actorId: null, deviceId: 'platform', action: 'subscription.status_changed', entity: 'tenant', entityId: tenantId, diff: { from: s.status, to: state.status } }));
    }
    const reminders = await this.dunning(tenantId, today, cfg);
    if (!tenantBlocked({ status: t.status, subStatus: state.status })) await this.meter(tenantId, today.slice(0, 7));
    return { today, from: s.status, status: state.status, actions, invoiceId, reminders };
  }

  private async issueInvoice(tenantId: string, planKey: string, cycle: BillingCycle, start: string, today: string, dueDays: number): Promise<string> {
    const supplier = await this.supplier();
    const prices = (await this.db.systemTx((tx) => tx.query(`SELECT price_paise::int AS "pricePaise", to_char(effective_from,'YYYY-MM-DD') AS "effectiveFrom" FROM saas_plan_price WHERE plan_key = $1 AND cycle = $2`, [planKey, cycle]))).rows;
    const price = priceOn(prices, start);
    if (!price) throw new BadRequestException(`No ${cycle} price for plan ${planKey} on ${start}`);
    const period = nextPeriod(start, cycle);
    const fyStart = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 4 ? 1 : 0);
    const seq = (await this.db.systemTx((tx) => tx.query(`INSERT INTO saas_invoice_counter (fy, last) VALUES ($1, 1) ON CONFLICT (fy) DO UPDATE SET last = saas_invoice_counter.last + 1 RETURNING last`, [fyStart]))).rows[0].last as number;
    const number = `${supplier.invoicePrefix}/${String(fyStart).slice(2)}${String(fyStart + 1).slice(2)}/${String(seq).padStart(5, '0')}`;
    const id = uuidv7();
    const inv = await this.db.tenantTx(tenantId, async (tx) => {
      const firm = (await tx.query(`SELECT e.name, e.gstin, e.state_code, e.address, t.name AS firm FROM firm_entity e JOIN tenant t ON t.id = e.tenant_id WHERE e.deleted_at IS NULL ORDER BY e.id LIMIT 1`)).rows[0];
      const partner = (await tx.query(`SELECT u.name, u.email, u.phone FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role r ON r.id = ur.role_id WHERE r.key = 'partner' AND u.status = 'active' ORDER BY u.id LIMIT 1`)).rows[0];
      const tot = saasInvoiceTotals(price.pricePaise, supplier, firm?.state_code ?? null, supplier.gstRate);
      const billTo = { name: firm?.firm ?? '', entity: firm?.name ?? null, gstin: firm?.gstin ?? null, stateCode: firm?.state_code ?? null, address: firm?.address ?? null };
      await tx.query(`INSERT INTO saas_invoice (id, tenant_id, number, issue_date, due_date, period_start, period_end, plan_key, cycle, supply_type, supplier, bill_to,
          taxable_paise, cgst_paise, sgst_paise, igst_paise, round_off_paise, total_paise) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [id, tenantId, number, today, addDaysIso(today, dueDays), period.start, period.end, planKey, cycle, tot.supplyType, JSON.stringify(supplier), JSON.stringify(billTo),
          tot.taxablePaise, tot.cgstPaise, tot.sgstPaise, tot.igstPaise, tot.roundOffPaise, tot.totalPaise]);
      await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'platform', action: 'subscription.invoice_issued', entity: 'saas_invoice', entityId: id, diff: { number, totalPaise: tot.totalPaise, planKey, cycle } });
      return { total: tot.totalPaise, partner };
    });
    const providerName = defaultPaymentProvider();
    const provider = this.providers[providerName];
    if (provider && inv.total > 0) {
      try {
        const link = await provider.createLink({ tenantId, invoiceId: id, invoiceNumber: number, amountPaise: inv.total, customer: { name: inv.partner?.name ?? 'Firm', email: inv.partner?.email, phone: inv.partner?.phone } });
        await this.db.systemTx((tx) => tx.query('INSERT INTO saas_payment_link (link_id, provider, tenant_id, invoice_id) VALUES ($1,$2,$3,$4)', [link.linkId, providerName, tenantId, id]));
        await this.db.tenantTx(tenantId, (tx) => tx.query('UPDATE saas_invoice SET provider = $2, payment_link_id = $3, payment_url = $4 WHERE id = $1', [id, providerName, link.linkId, link.url]));
      } catch (e) { this.log.warn(`payment link for ${number} failed: ${(e as Error).message}`); }
    }
    await this.paudit.record({ adminId: null, tenantId, action: 'saas.invoice_issued', entity: 'saas_invoice', entityId: id, diff: { number, totalPaise: inv.total } });
    return id;
  }

  private async dunning(tenantId: string, today: string, cfg: LifecycleConfig) {
    const due = await this.db.tenantTx(tenantId, async (tx) => {
      const rows = (await tx.query(`SELECT id, number, to_char(due_date,'YYYY-MM-DD') AS due, dunning_sent, total_paise::int AS total FROM saas_invoice WHERE status = 'issued' AND (last_dunning_on IS NULL OR last_dunning_on < $1)`, [today])).rows;
      const out: Array<{ id: string; number: string; step: number; total: number }> = [];
      for (const r of rows) {
        const step = dunningStep(r.due, today, r.dunning_sent, cfg.dunningDays);
        if (step === null) continue;
        await tx.query('UPDATE saas_invoice SET dunning_sent = $2, last_dunning_on = $3 WHERE id = $1', [r.id, step + 1, today]);
        await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'platform', action: 'subscription.dunning_sent', entity: 'saas_invoice', entityId: r.id, diff: { step } });
        out.push({ id: r.id, number: r.number, step, total: r.total });
      }
      const partners = (await tx.query(`SELECT DISTINCT u.id FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role r ON r.id = ur.role_id WHERE r.key IN ('partner','admin') AND u.status = 'active'`)).rows.map((r) => r.id as string);
      return { out, partners };
    });
    for (const d of due.out) {
      if (!due.partners.length) break;
      await this.notifications.send(tenantId, { userIds: due.partners, category: 'invoice.due', priority: d.step >= 2 ? 'high' : 'normal',
        title: `Worko subscription invoice ${d.number} is due`, body: `Rs. ${(d.total / 100).toFixed(2)} — pay from Settings → Subscription to avoid suspension.`,
        entityType: 'saas_invoice', entityId: d.id, dedupeKey: `saas_dunning:${d.id}:${d.step}` });
    }
    return due.out.length;
  }

  /** Marks an invoice paid (webhook or admin) and activates the subscription for the invoice's period. */
  private async markPaid(tenantId: string, invoiceId: string, via: { provider?: string; paymentId?: string | null; adminId?: string | null }) {
    const inv = await this.db.tenantTx(tenantId, async (tx) => {
      const r = (await tx.query(`UPDATE saas_invoice SET status = 'paid', paid_at = now(), provider_payment_id = COALESCE($2, provider_payment_id) WHERE id = $1 AND status = 'issued'
        RETURNING id, number, to_char(period_start,'YYYY-MM-DD') AS ps, to_char(period_end,'YYYY-MM-DD') AS pe, cycle`, [invoiceId, via.paymentId ?? null])).rows[0];
      if (r) await this.audit.record(tx, tenantId, { actorId: null, deviceId: 'platform', action: 'subscription.invoice_paid', entity: 'saas_invoice', entityId: invoiceId, diff: { provider: via.provider ?? 'manual', platformAdminId: via.adminId ?? null } });
      const unpaid = (await tx.query(`SELECT count(*)::int AS n FROM saas_invoice WHERE status = 'issued'`)).rows[0].n as number;
      return r ? { ...r, unpaid } : null;
    });
    if (!inv) return { paid: false };
    const t = await this.tenantRow(tenantId);
    const s = this.subState(t);
    const next = inv.unpaid === 0 ? subscriptionPaid(s, { start: inv.ps, end: inv.pe }) : { ...s, periodStart: inv.ps, periodEnd: inv.pe };
    await this.db.systemTx(async (tx) => {
      await tx.query(`UPDATE tenant SET sub_status = $2, period_start = $3, period_end = $4, past_due_since = $5, sub_suspended_since = $6, billing_cycle = $7 WHERE id = $1`,
        [tenantId, next.status, next.periodStart, next.periodEnd, next.pastDueSince, next.suspendedSince, inv.cycle]);
      await this.paudit.recordTx(tx, { adminId: via.adminId ?? null, tenantId, action: 'saas.invoice_paid', entity: 'saas_invoice', entityId: invoiceId, diff: { from: s.status, to: next.status } });
    });
    return { paid: true, status: next.status };
  }

  async adminMarkPaid(p: PlatformActor, tenantId: string, invoiceId: string) {
    const r = await this.markPaid(tenantId, invoiceId, { adminId: p.adminId });
    if (!r.paid) throw new NotFoundException('No unpaid invoice with that id');
    return r;
  }

  /** Payment-provider webhook (signature-verified, deduplicated); the link id maps to the tenant + invoice. */
  async webhook(providerName: string, raw: Buffer | undefined, headers: Record<string, string | string[] | undefined>) {
    const provider = this.providers[providerName];
    if (!provider || !raw || !provider.verify(raw, headers)) throw new HttpException('Invalid signature', HttpStatus.UNAUTHORIZED);
    const ev = provider.parse(raw, headers);
    if (!ev) return { ok: true, ignored: true };
    const fresh = (await this.db.systemTx((tx) => tx.query('INSERT INTO saas_payment_event (provider, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [providerName, ev.eventId]))).rowCount;
    if (!fresh) return { ok: true, duplicate: true };
    if (!ev.paid || !ev.linkId) return { ok: true, ignored: true };
    const link = (await this.db.systemTx((tx) => tx.query('SELECT tenant_id, invoice_id FROM saas_payment_link WHERE link_id = $1 AND provider = $2', [ev.linkId, providerName]))).rows[0];
    if (!link) return { ok: true, ignored: true };
    return { ok: true, ...(await this.markPaid(link.tenant_id, link.invoice_id, { provider: providerName, paymentId: ev.paymentId })) };
  }

  // ---------------- firm side ----------------

  private invoicesTx(tx: Tx) {
    return tx.query(`SELECT id, number, to_char(issue_date,'YYYY-MM-DD') AS "issueDate", to_char(due_date,'YYYY-MM-DD') AS "dueDate", to_char(period_start,'YYYY-MM-DD') AS "periodStart",
        to_char(period_end,'YYYY-MM-DD') AS "periodEnd", plan_key AS "planKey", cycle, supply_type AS "supplyType", taxable_paise::int AS "taxablePaise", cgst_paise::int AS "cgstPaise",
        sgst_paise::int AS "sgstPaise", igst_paise::int AS "igstPaise", total_paise::int AS "totalPaise", status, payment_url AS "paymentUrl", paid_at AS "paidAt", supplier, bill_to AS "billTo"
      FROM saas_invoice ORDER BY issue_date DESC, number DESC LIMIT 100`).then((r) => r.rows);
  }

  async subscription(a: RequestActor) {
    const plans = await this.listPlans();
    const month = this.clock.todayIst().slice(0, 7);
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const t = (await tx.query('SELECT * FROM tenant WHERE id = $1', [a.tenantId])).rows[0];
      return {
        subscription: this.tenantOut(t), usage: await this.usageTx(tx, a.tenantId, month), features: await tenantFeatures(tx, a.tenantId),
        invoices: await this.invoicesTx(tx),
        upgradeRequests: (await tx.query(`SELECT id, plan_key AS "planKey", cycle, note, status, created_at AS "createdAt" FROM saas_upgrade_request ORDER BY created_at DESC LIMIT 20`)).rows,
        plans: plans.filter((p) => p.active && p.key !== 'trial').map((p) => ({ key: p.key, name: p.name, seats: p.seats, storageGb: p.storageGb, modules: p.modules,
          prices: p.prices.filter((x: { effectiveFrom: string }) => x.effectiveFrom <= this.clock.todayIst()) })),
      };
    });
  }

  async requestUpgrade(a: RequestActor, b: { planKey: string; cycle: BillingCycle; note?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      if (!(await tx.query(`SELECT 1 FROM saas_plan WHERE key = $1 AND active AND key <> 'trial'`, [b.planKey])).rowCount) throw new BadRequestException('Unknown plan');
      const id = uuidv7();
      await tx.query(`INSERT INTO saas_upgrade_request (id, tenant_id, plan_key, cycle, note, requested_by) VALUES ($1,$2,$3,$4,$5,$6)`, [id, a.tenantId, b.planKey, b.cycle, b.note ?? null, a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'subscription.upgrade_requested', entity: 'saas_upgrade_request', entityId: id, diff: { planKey: b.planKey, cycle: b.cycle } });
      return { id };
    });
  }
}
