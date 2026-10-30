import { describe, expect, it } from 'vitest';
import {
  canIssueOtp, chargeFailureTo, defaultPortalGrants, diffProposalVersions, leadTransitionError, liveChallenges, needsRebalance, PORTAL_OTP, portalAllows, recordVerifyFailure, verifyThrottled, renderEngagementLetter,
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
  it('OTP: several live codes, failures charged to the newest live one only, self-resetting identifier window, hourly cap', () => {
    const now = new Date('2026-10-15T10:00:00Z');
    const c = (id: string, minsAgo: number, attempts = 0, consumed = false) => ({ id, attempts, createdAt: new Date(now.getTime() - minsAgo * 60_000),
      expiresAt: new Date(now.getTime() + (PORTAL_OTP.ttlMinutes - minsAgo) * 60_000), consumedAt: consumed ? now : null });
    const live = liveChallenges([c('old', 5), c('new', 1), c('used', 0, 0, true), c('dead', 2, PORTAL_OTP.maxAttempts), c('expired', 11)], now);
    expect(live.map((x) => x.id)).toEqual(['new', 'old']);
    expect(chargeFailureTo(live)!.id).toBe('new');
    expect(chargeFailureTo([])).toBeNull(); // no live code → nothing counted
    let w = { failures: 0, windowStart: null as Date | null };
    for (let i = 0; i < PORTAL_OTP.verifyFailuresPerWindow; i++) w = recordVerifyFailure(w, now);
    expect(verifyThrottled(w, now)).toBe(true);
    const later = new Date(now.getTime() + PORTAL_OTP.verifyWindowMinutes * 60_000);
    expect(verifyThrottled(w, later)).toBe(false); // resets by itself
    expect(recordVerifyFailure(w, later)).toEqual({ failures: 1, windowStart: later });
    expect(canIssueOtp(4, 0)).toBe(true);
    expect(canIssueOtp(5, 0)).toBe(false);
    expect(canIssueOtp(0, PORTAL_OTP.maxLive)).toBe(false);
  });
  it('engagement letter: user text is inserted raw after rendering (placeholders in it are never expanded)', () => {
    const out = renderEngagementLetter('To {{client.name}}\n{{services}}\nTerms: {{terms}}\n{{firm.name}}',
      { 'client.name': 'Evil {{firm.name}} Ltd', 'firm.name': 'Sharma & Co' }, { services: '- GST {{client.name}}', terms: 'Pay {{fees}} now' });
    expect(out).toBe('To Evil firm.name Ltd\n- GST {{client.name}}\nTerms: Pay {{fees}} now\nSharma & Co');
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
