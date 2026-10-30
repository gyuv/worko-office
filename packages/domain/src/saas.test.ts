import { describe, expect, it } from 'vitest';
import {
  canTransitionSub, dunningStep, effectiveFeatures, impersonationUsable, nextPeriod, priceOn, saasInvoiceTotals, seatCheck, seatLimit, seatsUsed,
  subscriptionPaid, subscriptionTick, tenantBlocked, type SubscriptionState,
} from './saas.js';
import { DATA_INVENTORY, dpdpDueDate, dpdpSlaState, effectiveRetention, planErasure, validateRetentionOverride, canTransitionDpdp, breachReportDue } from './dpdp.js';

const plan = { key: 'starter', name: 'Starter', seats: 5, storageGb: 10, portalUsersCountAsSeats: false, modules: { portal: true, ai: false } };

describe('plans, features, seats', () => {
  it('plan defaults + overrides; no plan = everything on', () => {
    const f = effectiveFeatures(plan, { ai: true, portal: false });
    expect(f).toMatchObject({ ai: true, portal: false, automation: false });
    expect(Object.values(effectiveFeatures(null, {})).every(Boolean)).toBe(true);
  });
  it('seat limit: override beats plan; portal users count only when the plan says so', () => {
    expect(seatLimit(plan, null)).toBe(5);
    expect(seatLimit(plan, 8)).toBe(8);
    expect(seatLimit({ seats: null }, null)).toBeNull();
    expect(seatsUsed({ staff: 4, portalUsers: 10 }, plan)).toBe(4);
    expect(seatsUsed({ staff: 4, portalUsers: 10 }, { portalUsersCountAsSeats: true })).toBe(14);
    expect(seatCheck(5, 5)).toMatchObject({ ok: false, available: 0 });
    expect(seatCheck(4, 5)).toMatchObject({ ok: true, available: 1 });
    expect(seatCheck(400, null).ok).toBe(true);
  });
  it('price rows are data: latest effective row wins', () => {
    const rows = [{ effectiveFrom: '2026-01-01', p: 1 }, { effectiveFrom: '2026-07-01', p: 2 }];
    expect(priceOn(rows, '2026-06-30')!.p).toBe(1);
    expect(priceOn(rows, '2026-07-01')!.p).toBe(2);
    expect(priceOn(rows, '2025-12-31')).toBeNull();
  });
  it('SaaS invoice GST: intra-state CGST+SGST, inter-state IGST', () => {
    const s = { gstin: '29ABCDE1234F1Z5', stateCode: '29' };
    expect(saasInvoiceTotals(100_000, s, '29', 18)).toMatchObject({ cgstPaise: 9000, sgstPaise: 9000, igstPaise: 0, totalPaise: 118_000 });
    expect(saasInvoiceTotals(100_000, s, '27', 18)).toMatchObject({ igstPaise: 18_000, totalPaise: 118_000 });
  });
});

describe('subscription state machine (pinned dates)', () => {
  const base: SubscriptionState = { status: 'trial', trialEndsOn: '2026-10-31', periodStart: null, periodEnd: null, pastDueSince: null, suspendedSince: null };
  it('trial → invoice at trial end → past_due after due date → suspended after grace → cancelled', () => {
    expect(subscriptionTick(base, { oldestUnpaidDue: null, nextPeriodInvoiced: false }, '2026-10-31').actions).toEqual([]);
    expect(subscriptionTick(base, { oldestUnpaidDue: null, nextPeriodInvoiced: false }, '2026-11-01').actions).toEqual(['issue_invoice']);
    const pd = subscriptionTick(base, { oldestUnpaidDue: '2026-11-08', nextPeriodInvoiced: true }, '2026-11-09');
    expect(pd.state).toMatchObject({ status: 'past_due', pastDueSince: '2026-11-09' });
    const su = subscriptionTick(pd.state, { oldestUnpaidDue: '2026-11-08', nextPeriodInvoiced: true }, '2026-11-24');
    expect(su.state.status).toBe('suspended'); expect(su.actions).toContain('suspend');
    expect(subscriptionTick(su.state, { oldestUnpaidDue: '2026-11-08', nextPeriodInvoiced: true }, '2027-01-22').state.status).toBe('suspended');
    expect(subscriptionTick(su.state, { oldestUnpaidDue: '2026-11-08', nextPeriodInvoiced: true }, '2027-01-23').state.status).toBe('cancelled');
  });
  it('payment activates and moves the period; active renews at period end', () => {
    const a = subscriptionPaid({ ...base, status: 'past_due', pastDueSince: '2026-11-09' }, nextPeriod('2026-11-01', 'monthly'));
    expect(a).toMatchObject({ status: 'active', periodStart: '2026-11-01', periodEnd: '2026-11-30', pastDueSince: null });
    expect(subscriptionTick(a, { oldestUnpaidDue: null, nextPeriodInvoiced: false }, '2026-12-01').actions).toEqual(['issue_invoice']);
    expect(nextPeriod('2026-11-01', 'annual')).toEqual({ start: '2026-11-01', end: '2027-10-31' });
    expect(() => subscriptionPaid({ ...base, status: 'cancelled' as const }, nextPeriod('2026-11-01', 'monthly'))).not.toThrow();
  });
  it('transitions table and blocking', () => {
    expect(canTransitionSub('trial', 'suspended')).toBe(false);
    expect(canTransitionSub('past_due', 'suspended')).toBe(true);
    expect(tenantBlocked({ status: 'active', subStatus: 'past_due' })).toBe(false);
    expect(tenantBlocked({ status: 'suspended', subStatus: 'active' })).toBe(true);
    expect(tenantBlocked({ status: 'active', subStatus: 'cancelled' })).toBe(true);
  });
  it('dunning steps fire once each', () => {
    expect(dunningStep('2026-11-08', '2026-11-08', 0)).toBe(0);
    expect(dunningStep('2026-11-08', '2026-11-09', 1)).toBeNull();
    expect(dunningStep('2026-11-08', '2026-11-11', 1)).toBe(1);
    expect(dunningStep('2026-11-08', '2026-11-07', 0)).toBeNull();
  });
  it('impersonation: approved + unexpired + read-only unless consented', () => {
    const now = new Date('2026-10-30T10:00:00Z');
    const g = { status: 'approved', expiresAt: new Date('2026-10-30T11:00:00Z'), revokedAt: null, writeConsent: false };
    expect(impersonationUsable(g, now, 'GET')).toEqual({ ok: true, write: false });
    expect(impersonationUsable(g, now, 'POST')).toEqual({ ok: false, reason: 'read_only' });
    expect(impersonationUsable({ ...g, writeConsent: true }, now, 'PATCH')).toEqual({ ok: true, write: true });
    expect(impersonationUsable(g, new Date('2026-10-30T11:00:00Z'), 'GET')).toEqual({ ok: false, reason: 'expired' });
    expect(impersonationUsable({ ...g, status: 'requested' }, now, 'GET')).toEqual({ ok: false, reason: 'not_approved' });
    expect(impersonationUsable({ ...g, revokedAt: now }, now, 'GET')).toEqual({ ok: false, reason: 'revoked' });
  });
});

describe('DPDP rules', () => {
  it('inventory is data and covers every principal type it names', () => {
    expect(DATA_INVENTORY.find((e) => e.table === 'client')!.fields.some((f) => f.erase === 'shred')).toBe(true);
  });
  it('erasure respects the tax-records hold and never touches accounting rows', () => {
    const held = planErasure('client', { lastAccountingDate: '2026-04-01', today: '2026-10-30' });
    expect(held.outcome).toBe('partial');
    expect(held.steps.find((s) => s.table === 'invoice')!.action).toBe('retain');
    const keep = held.steps.find((s) => s.table === 'client' && s.action === 'retain')!;
    expect(keep.reason).toBe('legal_hold:tax_records:until:2034-03-30');
    expect(keep.fields.map((f) => f.name)).toContain('name');
    const drop = held.steps.find((s) => s.table === 'client' && s.action === 'anonymise')!;
    expect(drop.fields.map((f) => f.name)).toEqual(expect.arrayContaining(['email', 'phone', 'aadhaar_enc', 'bank_accounts_enc']));
    const free = planErasure('client', { lastAccountingDate: null, today: '2026-10-30' });
    expect(free.steps.find((s) => s.table === 'client')!.action).toBe('anonymise');
    expect(planErasure('lead', { lastAccountingDate: null, today: '2026-10-30' }).outcome).toBe('full');
    expect(planErasure('staff', { lastAccountingDate: null, today: '2026-10-30', isActiveStaff: true }).outcome).toBe('blocked');
  });
  it('retention overrides cannot shorten a statutory minimum', () => {
    expect(validateRetentionOverride('tax_records', 365)).toMatch(/at least/);
    expect(validateRetentionOverride('leads', 30)).toBeNull();
    expect(effectiveRetention({ tax_records: { days: 10 }, leads: { days: 90 } })).toMatchObject({ tax_records: { days: 2920 }, leads: { days: 90 } });
  });
  it('SLA dates and states', () => {
    expect(dpdpDueDate('2026-10-01', 'access')).toBe('2026-10-31');
    expect(dpdpSlaState('2026-10-31', '2026-11-01', false)).toBe('overdue');
    expect(dpdpSlaState('2026-10-31', '2026-10-28', false)).toBe('due_soon');
    expect(dpdpSlaState('2026-10-31', '2026-10-01', false)).toBe('on_track');
    expect(dpdpSlaState('2026-10-31', '2026-11-30', true)).toBe('closed');
    expect(canTransitionDpdp('completed', 'in_progress')).toBe(false);
    expect(breachReportDue(new Date('2026-10-01T00:00:00Z')).toISOString()).toBe('2026-10-04T00:00:00.000Z');
  });
});
