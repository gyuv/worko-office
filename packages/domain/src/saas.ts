import { z } from 'zod';
import { computeInvoice, daysBetween, supplyTypeOf, type InvoiceTotals } from './billing.js';
import { addDaysIso } from './hr.js';

/**
 * M22 SaaS: plans, switchable modules, seats, the subscription state machine and SaaS invoice maths.
 * Plans and prices are DATA (saas_plan / saas_plan_price); nothing here hard-codes a price.
 */

/** Switchable multi-tenancy features (super-admin flags). Plan modules give the defaults; per-tenant overrides win. */
export const SAAS_FEATURES = ['portal', 'automation', 'ai', 'payments', 'whatsapp', 'esign', 'leads', 'reports'] as const;
export type SaasFeature = (typeof SAAS_FEATURES)[number];
export type FeatureMap = Record<SaasFeature, boolean>;

export const planSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/), name: z.string().min(1).max(80),
  /** null = unlimited */
  seats: z.number().int().positive().nullable(), storageGb: z.number().int().positive().nullable(),
  portalUsersCountAsSeats: z.boolean().default(false),
  modules: z.record(z.enum(SAAS_FEATURES), z.boolean()).default({}),
}).strict();
export type Plan = z.infer<typeof planSchema>;

export const featureOverridesSchema = z.record(z.enum(SAAS_FEATURES), z.boolean());

/** Plan defaults ⊕ tenant overrides. No plan (legacy tenant) → everything on, so nothing breaks before a plan is assigned. */
export function effectiveFeatures(plan: Pick<Plan, 'modules'> | null | undefined, overrides: Record<string, unknown> | null | undefined): FeatureMap {
  const out = {} as FeatureMap;
  for (const f of SAAS_FEATURES) {
    const o = overrides?.[f];
    out[f] = typeof o === 'boolean' ? o : plan ? plan.modules[f] === true : true;
  }
  return out;
}

/** The tenant's seat limit: a super-admin override beats the plan; null = unlimited. */
export const seatLimit = (plan: Pick<Plan, 'seats'> | null | undefined, override: number | null | undefined): number | null => override ?? plan?.seats ?? null;

/** Seats in use: active staff (+ freelancers); portal users only when the plan says they count. */
export function seatsUsed(counts: { staff: number; portalUsers: number }, plan: Pick<Plan, 'portalUsersCountAsSeats'> | null | undefined): number {
  return counts.staff + (plan?.portalUsersCountAsSeats ? counts.portalUsers : 0);
}

export function seatCheck(used: number, limit: number | null, adding = 1): { ok: boolean; used: number; limit: number | null; available: number | null } {
  const available = limit === null ? null : Math.max(0, limit - used);
  return { ok: limit === null || used + adding <= limit, used, limit, available };
}

// ---------------- Subscription lifecycle ----------------

export const SUBSCRIPTION_STATUSES = ['trial', 'active', 'past_due', 'suspended', 'cancelled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export const BILLING_CYCLES = ['monthly', 'annual'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

/** Allowed transitions (anything else is refused). */
export const SUB_TRANSITIONS: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  trial: ['active', 'past_due', 'cancelled'],
  active: ['past_due', 'cancelled'],
  past_due: ['active', 'suspended', 'cancelled'],
  suspended: ['active', 'cancelled'],
  cancelled: ['active'],
};
export const canTransitionSub = (from: SubscriptionStatus, to: SubscriptionStatus) => SUB_TRANSITIONS[from].includes(to);

export const lifecycleConfigSchema = z.object({
  trialDays: z.number().int().min(1).max(365).default(30),
  invoiceDueDays: z.number().int().min(0).max(60).default(7),
  /** past_due → suspended after this many days unpaid */
  graceDays: z.number().int().min(1).max(120).default(15),
  /** suspended → cancelled after this many days (data kept; see D183) */
  cancelAfterDays: z.number().int().min(1).max(365).default(60),
  /** reminder days after the invoice due date */
  dunningDays: z.array(z.number().int().min(0).max(120)).max(10).default([0, 3, 7, 14]),
  /** plan a trial converts to when the firm hasn't chosen one (data) */
  conversionPlan: z.string().default('starter'),
}).strict();
export type LifecycleConfig = z.infer<typeof lifecycleConfigSchema>;
export const DEFAULT_LIFECYCLE: LifecycleConfig = lifecycleConfigSchema.parse({});

/** Dates are IST yyyy-mm-dd. */
export type SubscriptionState = {
  status: SubscriptionStatus; trialEndsOn: string | null; periodStart: string | null; periodEnd: string | null;
  pastDueSince: string | null; suspendedSince: string | null;
};
export type SubAction = 'issue_invoice' | 'suspend' | 'cancel';
export type TickFacts = { /** due date of the oldest unpaid invoice, if any */ oldestUnpaidDue: string | null; /** an invoice already covers the next period */ nextPeriodInvoiced: boolean };

/**
 * One lifecycle step for `today` (pure; the service injects the clock). Idempotent: running a day twice gives the same state.
 *  trial ends → invoice for the first period; unpaid past due date → past_due → (graceDays) suspended → (cancelAfterDays) cancelled.
 *  active at period end → renewal invoice.
 */
export function subscriptionTick(s: SubscriptionState, facts: TickFacts, today: string, cfg: LifecycleConfig = DEFAULT_LIFECYCLE): { state: SubscriptionState; actions: SubAction[] } {
  const st = { ...s }; const actions: SubAction[] = [];
  if (st.status === 'cancelled') return { state: st, actions };
  const periodOver = st.status === 'trial' ? !!st.trialEndsOn && today > st.trialEndsOn : !!st.periodEnd && today > st.periodEnd;
  if (periodOver && !facts.nextPeriodInvoiced && (st.status === 'trial' || st.status === 'active')) actions.push('issue_invoice');
  if (facts.oldestUnpaidDue && today > facts.oldestUnpaidDue && (st.status === 'active' || st.status === 'trial')) {
    st.status = 'past_due'; st.pastDueSince = addDaysIso(facts.oldestUnpaidDue, 1);
  }
  if (st.status === 'past_due' && st.pastDueSince && daysBetween(st.pastDueSince, today) >= cfg.graceDays) {
    st.status = 'suspended'; st.suspendedSince = today; actions.push('suspend');
  }
  if (st.status === 'suspended' && st.suspendedSince && daysBetween(st.suspendedSince, today) >= cfg.cancelAfterDays) {
    st.status = 'cancelled'; actions.push('cancel');
  }
  return { state: st, actions };
}

/** Payment for a period makes the subscription active and moves the period forward. */
export function subscriptionPaid(s: SubscriptionState, period: { start: string; end: string }): SubscriptionState {
  if (!canTransitionSub(s.status, 'active') && s.status !== 'active') throw new Error(`cannot activate from ${s.status}`);
  return { ...s, status: 'active', periodStart: period.start, periodEnd: period.end, pastDueSince: null, suspendedSince: null };
}

/** Next billing period after `from` (inclusive start). */
export function nextPeriod(from: string, cycle: BillingCycle): { start: string; end: string } {
  const [y, m, d] = from.split('-').map(Number) as [number, number, number];
  const months = cycle === 'annual' ? 12 : 1;
  const end = new Date(Date.UTC(y, m - 1 + months, d));
  return { start: from, end: addDaysIso(end.toISOString().slice(0, 10), -1) };
}

/** Dunning step due today for an unpaid invoice (index into `dunningDays`), or null. `sent` = reminders already sent. */
export function dunningStep(dueDate: string, today: string, sent: number, days: number[] = DEFAULT_LIFECYCLE.dunningDays): number | null {
  const late = daysBetween(dueDate, today);
  let step: number | null = null;
  days.forEach((d, i) => { if (late >= d) step = i; });
  return step !== null && step >= sent ? step : null;
}

/** Logins/jobs blocked? Platform suspension OR a suspended/cancelled subscription (data is kept either way). */
export function tenantBlocked(t: { status: string; subStatus: string }): boolean {
  return t.status === 'suspended' || t.subStatus === 'suspended' || t.subStatus === 'cancelled';
}

/** SaaS invoice to a firm: Worko (supplier, configured as data) → firm; GST via the billing helpers. */
export function saasInvoiceTotals(pricePaise: number, supplier: { gstin: string | null; stateCode: string }, firmStateCode: string | null, gstRate: number): InvoiceTotals {
  const supply = supplyTypeOf(supplier.gstin, supplier.stateCode, firmStateCode);
  return computeInvoice([{ qty: 1, ratePaise: pricePaise, gstRate }], supply);
}

/** Price row effective on a date (rate table: latest effective_from ≤ date). */
export function priceOn<T extends { effectiveFrom: string }>(rows: T[], date: string): T | null {
  return rows.filter((r) => r.effectiveFrom <= date).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] ?? null;
}

// ---------------- Impersonation ----------------

export const IMPERSONATION_STATUSES = ['requested', 'approved', 'denied', 'revoked', 'expired'] as const;
export type ImpersonationStatus = (typeof IMPERSONATION_STATUSES)[number];
export const IMPERSONATION_MAX_MINUTES = 240;

/** Is a grant usable right now, and may it write? */
export function impersonationUsable(g: { status: string; expiresAt: Date | null; revokedAt: Date | null; writeConsent: boolean }, now: Date, method: string):
  { ok: true; write: boolean } | { ok: false; reason: 'not_approved' | 'expired' | 'revoked' | 'read_only' } {
  if (g.revokedAt || g.status === 'revoked') return { ok: false, reason: 'revoked' };
  if (g.status !== 'approved') return { ok: false, reason: 'not_approved' };
  if (!g.expiresAt || g.expiresAt <= now) return { ok: false, reason: 'expired' };
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
  if (write && !g.writeConsent) return { ok: false, reason: 'read_only' };
  return { ok: true, write: g.writeConsent };
}
