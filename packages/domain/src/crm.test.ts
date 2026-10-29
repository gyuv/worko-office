import { describe, expect, it } from 'vitest';
import {
  canIssueOtp, defaultPortalGrants, diffProposalVersions, leadTransitionError, needsRebalance, otpFailure, otpVerifyOutcome, PORTAL_OTP, portalAllows,
  portalGrantsSchema, portalIdentifier, portalSettingsSchema, positionBetween, proposalAcceptError, proposalTotals, templateErrors, ENGAGEMENT_LETTER_VARIABLES,
  DEFAULT_ENGAGEMENT_LETTER, crmSettingsSchema, type ProposalLine,
} from './index.js';

const line = (o: Partial<ProposalLine> = {}): ProposalLine => ({ serviceTypeId: 's1', description: 'GST returns', frequency: 'monthly', qty: 1, feePaise: 250_000, gstRate: 18, ...o });

describe('lead pipeline', () => {
  it('allows open moves, needs a lost reason, won is final, lost reopens', () => {
    expect(leadTransitionError('new', 'qualified')).toBeNull();
    expect(leadTransitionError('proposal', 'contacted')).toBeNull();
    expect(leadTransitionError('qualified', 'won')).toBeNull();
    expect(leadTransitionError('qualified', 'lost')).toBe('lost_reason_required');
    expect(leadTransitionError('qualified', 'lost', 'price')).toBeNull();
    expect(leadTransitionError('won', 'new')).toBe('lead_won_final');
    expect(leadTransitionError('lost', 'contacted')).toBeNull();
    expect(leadTransitionError('lost', 'won')).toBe('invalid_transition');
    expect(leadTransitionError('new', 'new')).toBeNull();
  });
  it('orders kanban cards between neighbours', () => {
    expect(positionBetween(null, null)).toBe(1024);
    expect(positionBetween(1024, null)).toBe(2048);
    expect(positionBetween(null, 1024)).toBe(0);
    expect(positionBetween(1, 2)).toBe(1.5);
    expect(() => positionBetween(2, 1)).toThrow();
    expect(needsRebalance(1, 1 + 1e-9)).toBe(true);
  });
});

describe('proposals', () => {
  it('computes GST per frequency (intra = CGST+SGST, inter = IGST) and first-year value', () => {
    const lines = [line(), line({ serviceTypeId: 's2', description: 'Incorporation', frequency: 'one_time', feePaise: 1_500_000 }), line({ serviceTypeId: 's3', frequency: 'annual', feePaise: 1_000_000, gstRate: 18 })];
    const intra = proposalTotals(lines, 'intra');
    expect(intra.byFrequency.monthly).toEqual({ taxablePaise: 250_000, taxPaise: 45_000, totalPaise: 295_000 });
    expect(intra.byFrequency.one_time.totalPaise).toBe(1_770_000);
    expect(intra.firstYear.taxablePaise).toBe(1_500_000 + 12 * 250_000 + 1_000_000);
    expect(intra.firstYear.totalPaise).toBe(1_770_000 + 12 * 295_000 + 1_180_000);
    const inter = proposalTotals(lines, 'inter');
    expect(inter.byFrequency.monthly.taxPaise).toBe(45_000);
    expect(proposalTotals(lines, 'unregistered').byFrequency.monthly.taxPaise).toBe(0);
    // odd paise: CGST/SGST halves rounded like invoices
    expect(proposalTotals([line({ feePaise: 10_001 })], 'intra').byFrequency.monthly.taxPaise).toBe(1800);
  });
  it('diffs versions by service × frequency', () => {
    const a = { lines: [line(), line({ serviceTypeId: 's2', frequency: 'annual', feePaise: 100 })], terms: 'x', validUntil: '2026-11-30' };
    const b = { lines: [line({ feePaise: 300_000 }), line({ serviceTypeId: 's4', frequency: 'one_time' })], terms: 'x', validUntil: '2026-12-15' };
    const d = diffProposalVersions(a, b);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]!.fields).toEqual(['feePaise']);
    expect(d.added.map((l) => l.serviceTypeId)).toEqual(['s4']);
    expect(d.removed.map((l) => l.serviceTypeId)).toEqual(['s2']);
    expect(d.terms).toBe(false);
    expect(d.validUntil).toBe(true);
  });
  it('accepts only the latest sent, open, unexpired version', () => {
    const p = { status: 'sent' as const, sentVersion: 2, currentVersion: 2, validUntil: '2026-11-30' };
    expect(proposalAcceptError(p, 2, '2026-11-01')).toBeNull();
    expect(proposalAcceptError(p, 1, '2026-11-01')).toBe('superseded');
    expect(proposalAcceptError({ ...p, currentVersion: 3, status: 'draft' }, 2, '2026-11-01')).toBe('superseded');
    expect(proposalAcceptError(p, 2, '2026-12-01')).toBe('expired');
    expect(proposalAcceptError({ ...p, status: 'accepted' }, 2, '2026-11-01')).toBe('already_decided');
    expect(proposalAcceptError({ ...p, status: 'withdrawn' }, 2, '2026-11-01')).toBe('withdrawn');
  });
  it('default engagement letter uses only allowed variables', () => {
    expect(templateErrors(DEFAULT_ENGAGEMENT_LETTER, ENGAGEMENT_LETTER_VARIABLES)).toEqual([]);
    expect(crmSettingsSchema.parse({}).proposalValidityDays).toBe(30);
  });
});

describe('client portal', () => {
  it('grants: defaults, notices off, category/FY narrowing', () => {
    const g = defaultPortalGrants();
    expect(g.notices).toBe(false);
    expect(g.compliance).toBe(false);
    expect(portalAllows(g, 'invoices')).toBe(true);
    expect(portalAllows(g, 'documents', { category: 'ITR', fy: null })).toBe(true);
    const n = portalGrantsSchema.parse({ documents: { categories: ['ITR', 'GST'], fys: ['2025-26'] }, invoices: false });
    expect(portalAllows(n, 'invoices')).toBe(false);
    expect(portalAllows(n, 'documents', { category: 'itr', fy: '2025-26' })).toBe(true);
    expect(portalAllows(n, 'documents', { category: 'ITR', fy: '2024-25' })).toBe(false);
    expect(portalAllows(n, 'documents', { category: 'Bank', fy: '2025-26' })).toBe(false);
    expect(portalAllows(n, 'documents', { category: 'ITR', fy: null })).toBe(false);
    expect(portalAllows({ ...n, documents: { ...n.documents, enabled: false } }, 'documents')).toBe(false);
    expect(() => portalGrantsSchema.parse({ vault: true })).toThrow();
  });
  it('OTP: expiry, attempts, lockout, hourly cap', () => {
    const now = new Date('2026-10-15T10:00:00Z');
    const ch = { attempts: 0, expiresAt: new Date(now.getTime() + 60_000), consumedAt: null };
    expect(otpVerifyOutcome({ lockedUntil: null, failedLogins: 0, challenge: ch }, true, now)).toBe('ok');
    expect(otpVerifyOutcome({ lockedUntil: null, failedLogins: 0, challenge: ch }, false, now)).toBe('invalid');
    expect(otpVerifyOutcome({ lockedUntil: null, failedLogins: 0, challenge: { ...ch, expiresAt: now } }, true, now)).toBe('invalid');
    expect(otpVerifyOutcome({ lockedUntil: null, failedLogins: 0, challenge: { ...ch, attempts: PORTAL_OTP.maxAttempts } }, true, now)).toBe('invalid');
    expect(otpVerifyOutcome({ lockedUntil: null, failedLogins: 0, challenge: null }, true, now)).toBe('invalid');
    expect(otpVerifyOutcome({ lockedUntil: new Date(now.getTime() + 1), failedLogins: 5, challenge: ch }, true, now)).toBe('locked');
    expect(otpFailure(3, now).lockedUntil).toBeNull();
    expect(otpFailure(4, now).lockedUntil).toEqual(new Date(now.getTime() + PORTAL_OTP.lockMinutes * 60_000));
    expect(canIssueOtp(4, null, now)).toBe(true);
    expect(canIssueOtp(5, null, now)).toBe(false);
    expect(canIssueOtp(0, new Date(now.getTime() + 1), now)).toBe(false);
  });
  it('identifiers and white-label settings', () => {
    expect(portalIdentifier(' Ravi@Example.IN ')).toEqual({ kind: 'email', value: 'ravi@example.in' });
    expect(portalIdentifier('98200 12345')).toEqual({ kind: 'phone', value: '+919820012345' });
    expect(portalIdentifier('hello')).toBeNull();
    expect(portalSettingsSchema.parse({}).accent).toBe('blue');
    expect(() => portalSettingsSchema.parse({ accent: '#ff0000' })).toThrow();
    expect(portalSettingsSchema.parse({ customDomain: 'Portal.SharmaCA.in' }).customDomain).toBe('portal.sharmaca.in');
    expect(() => portalSettingsSchema.parse({ customDomain: 'http://x' })).toThrow();
  });
});
