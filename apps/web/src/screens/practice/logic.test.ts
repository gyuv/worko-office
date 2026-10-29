import { describe, expect, it } from 'vitest';
import {
  acceptAll, allowedTransitions, confirmFields, draftError, draftsFrom, editDraft, esignPublicToken, esignSummary, expiryBand, isNoticeOverdue, matchOnly, parseThresholds,
  signoffButton, signRights, toggleDraft, udinInputError, unverifiedProvider,
} from './logic';

describe('notice transitions', () => {
  it('offers only allowed moves', () => {
    expect(allowedTransitions('received')).toEqual(['under_review', 'drafting', 'closed']);
    expect(allowedTransitions('submitted')).toEqual(['drafting', 'hearing', 'closed']);
    expect(allowedTransitions('closed')).toEqual([]);
    expect(allowedTransitions('received')).not.toContain('hearing');
  });
  it('flags overdue only while a response is pending', () => {
    expect(isNoticeOverdue({ status: 'drafting', responseDue: '2026-10-01' }, '2026-10-29')).toBe(true);
    expect(isNoticeOverdue({ status: 'submitted', responseDue: '2026-10-01' }, '2026-10-29')).toBe(false);
    expect(isNoticeOverdue({ status: 'received', responseDue: null }, '2026-10-29')).toBe(false);
  });
});

describe('extraction merge / accept', () => {
  const sugg = [
    { field: 'section', value: '143(2)', confidence: 0.9, source: 'u/s 143(2)' },
    { field: 'section', value: '143(1)', confidence: 0.4, source: 'x' },
    { field: 'responseDue', value: '2026-11-15', confidence: 0.8, source: 'on or before 15.11.2026' },
    { field: 'demandPaise', value: 1234550, confidence: 0.7, source: 'Rs. 12,345.50' },
    { field: 'pan', value: 'ABCDE1234F', confidence: 0.99, source: 'PAN' },
  ];
  it('takes the best suggestion per field, nothing accepted yet', () => {
    const d = draftsFrom(sugg);
    expect(d.find((x) => x.field === 'section')).toMatchObject({ suggested: '143(2)', value: '143(2)', confidence: 0.9, accepted: false });
    expect(d.find((x) => x.field === 'demandPaise')!.value).toBe('12345.50');
    expect(d.find((x) => x.field === 'authority')!.suggested).toBe('');
    expect(confirmFields(d)).toEqual({});
    expect(matchOnly(sugg).map((s) => s.field)).toEqual(['pan']);
  });
  it('sends only accepted fields, with corrected values, demand in paise', () => {
    let d = draftsFrom(sugg);
    d = toggleDraft(d, 'section', true);
    d = editDraft(d, 'responseDue', '2026-11-20');
    d = editDraft(d, 'authority', 'income_tax');
    expect(confirmFields(d)).toEqual({ section: '143(2)', responseDue: '2026-11-20', authority: 'income_tax' });
    d = toggleDraft(d, 'demandPaise', true);
    expect(confirmFields(d).demandPaise).toBe(1234550);
    expect(Object.keys(confirmFields(acceptAll(draftsFrom(sugg)))).sort()).toEqual(['demandPaise', 'responseDue', 'section']);
  });
  it('validates accepted values and drops invalid ones', () => {
    const d = editDraft(draftsFrom([]), 'issueDate', '15/11/2026');
    expect(draftError(d.find((x) => x.field === 'issueDate')!)).toBe('date');
    expect(confirmFields(d)).toEqual({});
    expect(draftError(editDraft(draftsFrom([]), 'assessmentYear', '2025').find((x) => x.field === 'assessmentYear')!)).toBe('year');
    expect(editDraft(draftsFrom([]), 'din', '').find((x) => x.field === 'din')!.accepted).toBe(false);
  });
});

describe('sign-off button state', () => {
  const me = { id: 'u1', grants: [{ module: 'audit', action: 'edit', scope: 'all' }, { module: 'audit', action: 'approve', scope: 'team' }] };
  const r = signRights(me, { partnerId: 'u9' });
  const blank = { preparedBy: null, reviewedBy: null, partnerBy: null };
  it('derives rights (partner = engagement partner or firm-wide approve)', () => {
    expect(r).toEqual({ canPrepare: true, canReview: true, canPartner: false });
    expect(signRights(me, { partnerId: 'u1' }).canPartner).toBe(true);
    expect(signRights({ id: 'x', grants: [{ module: 'audit', action: 'approve', scope: 'all' }] }, { partnerId: null }).canPartner).toBe(true);
  });
  it('gives reasons: order, self-review, stale evidence, already signed', () => {
    expect(signoffButton(blank, 'preparer', 'u1', r)).toEqual({ enabled: true, reason: null, signed: false });
    expect(signoffButton(blank, 'reviewer', 'u1', r).reason).toBe('preparer_signoff_required');
    expect(signoffButton({ ...blank, preparedBy: 'u1' }, 'reviewer', 'u1', r).reason).toBe('self_review');
    expect(signoffButton({ ...blank, preparedBy: 'u2' }, 'reviewer', 'u1', r).enabled).toBe(true);
    expect(signoffButton({ ...blank, preparedBy: 'u2' }, 'reviewer', 'u1', r, true).reason).toBe('evidence_changed');
    expect(signoffButton({ ...blank, preparedBy: 'u2' }, 'partner', 'u1', r).reason).toBe('forbidden');
    expect(signoffButton({ ...blank, preparedBy: 'u2' }, 'preparer', 'u1', r)).toMatchObject({ signed: true, enabled: false });
    expect(signoffButton({ ...blank, notApplicable: true }, 'preparer', 'u1', r).reason).toBe('not_applicable');
  });
});

describe('DSC expiry band', () => {
  it('bands 60/30/15/7/expired', () => {
    const today = '2026-10-29';
    expect(expiryBand('2026-10-28', today)).toBe('expired');
    expect(expiryBand('2026-10-29', today)).toBe('7');
    expect(expiryBand('2026-11-05', today)).toBe('7');
    expect(expiryBand('2026-11-06', today)).toBe('15');
    expect(expiryBand('2026-11-28', today)).toBe('30');
    expect(expiryBand('2026-12-28', today)).toBe('60');
    expect(expiryBand('2027-01-01', today)).toBe('ok');
    expect(expiryBand(null, today)).toBe('ok');
  });
});

describe('UDIN entry validation', () => {
  it('checks format, membership digits and date', () => {
    const today = '2026-10-29';
    expect(udinInputError('26123456ABCDEF1234', '123456', '2026-10-20', today)).toBeNull();
    expect(udinInputError(' 26123456abcdef1234 ', '123456', '2026-10-20', today)).toBeNull();
    expect(udinInputError('2612345ABCDEF1234', '123456', '2026-10-20', today)).toBe('format');
    expect(udinInputError('26123456ABCDEF1234', '12345', '2026-10-20', today)).toBe('membership');
    expect(udinInputError('26123456ABCDEF1234', '654321', '2026-10-20', today)).toBe('membership_mismatch');
    expect(udinInputError('26123456ABCDEF1234', '123456', '2026-10-30', today)).toBe('future_date');
  });
});

describe('e-sign', () => {
  it('summarises bulk items and signers', () => {
    const s = esignSummary([
      { status: 'signed', signers: [{ status: 'signed' }, { status: 'signed' }] },
      { status: 'failed', signers: [{ status: 'pending' }] },
      { status: 'sent', signers: [{ status: 'notified' }, { status: 'cancelled' }] },
      { status: 'cancelled', signers: [] },
    ]);
    expect(s).toEqual({ total: 4, signed: 1, failed: 1, open: 1, cancelled: 1, signersSigned: 2, signersTotal: 4 });
  });
  it('marks mock/skeleton providers unverified and parses the public link', () => {
    expect(unverifiedProvider('mock')).toBe(true);
    expect(unverifiedProvider('asp')).toBe(true);
    expect(esignPublicToken('#/esign/sign/abc.def_123')).toBe('abc.def_123');
    expect(esignPublicToken('', '/esign/sign/tok')).toBe('tok');
    expect(esignPublicToken('#/esign/0190')).toBeNull();
  });
  it('parses thresholds', () => {
    expect(parseThresholds('7, 60,30,0')).toEqual([60, 30, 7, 0]);
    expect(parseThresholds('a,1')).toBeNull();
  });
});
