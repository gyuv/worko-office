import { describe, expect, it } from 'vitest';
import {
  ageBucket, dueThresholds, invalidatedByEvidence, isValidUdin, noticeTaskDue, noticeTransitionError, parseIndianDate, parseNoticeText, signoffError, udinSchema,
} from './index.js';

describe('UDIN validation edge cases', () => {
  it('format only: 18 chars, 8 digits then 10 alphanumerics, case-insensitive, trimmed by the schema', () => {
    expect(isValidUdin('26123456ABCDEF1234')).toBe(true);
    expect(isValidUdin('26123456abcdef1234')).toBe(true);
    expect(isValidUdin('26123456ABCDEF12345')).toBe(false);
    expect(isValidUdin('2612345AABCDEF1234')).toBe(false);
    expect(isValidUdin('26123456ABCDEF-234')).toBe(false);
    expect(isValidUdin('')).toBe(false);
    expect(udinSchema.parse(' 26123456abcdef1234 ')).toBe('26123456ABCDEF1234');
    expect(udinSchema.safeParse('26 123456ABCDEF1234').success).toBe(false);
  });
});

describe('notices', () => {
  it('task due = response due − buffer, floored at a given date', () => {
    expect(noticeTaskDue('2026-11-30', 7)).toBe('2026-11-23');
    expect(noticeTaskDue('2026-11-30', 0)).toBe('2026-11-30');
    expect(noticeTaskDue('2026-11-05', 7, '2026-11-01')).toBe('2026-11-01');
    expect(noticeTaskDue('2026-10-20', 7, '2026-10-29')).toBe('2026-10-20');
  });
  it('workflow transitions', () => {
    expect(noticeTransitionError('received', 'under_review')).toBeNull();
    expect(noticeTransitionError('received', 'hearing')).toBe('invalid_transition');
    expect(noticeTransitionError('submitted', 'closed')).toBe('outcome_required');
    expect(noticeTransitionError('submitted', 'closed', 'dropped')).toBeNull();
    expect(noticeTransitionError('closed', 'drafting')).toBe('invalid_transition');
  });
  it('age buckets', () => {
    expect(ageBucket('2026-10-29', '2026-10-29')).toBe('0-30');
    expect(ageBucket('2026-09-29', '2026-10-29')).toBe('0-30');
    expect(ageBucket('2026-09-28', '2026-10-29')).toBe('31-60');
    expect(ageBucket('2026-07-01', '2026-10-29')).toBe('91-180');
    expect(ageBucket('2025-01-01', '2026-10-29')).toBe('180+');
  });
});

describe('expiry thresholds', () => {
  const T = [60, 30, 15, 7, 0];
  it('fires only the tightest reached threshold, once', () => {
    expect(dueThresholds('2027-01-01', '2026-10-29', T, [])).toEqual([]);
    expect(dueThresholds('2026-12-28', '2026-10-29', T, [])).toEqual([60]);
    expect(dueThresholds('2026-12-28', '2026-10-29', T, [60])).toEqual([]);
    expect(dueThresholds('2026-11-03', '2026-10-29', T, [])).toEqual([7]);
    expect(dueThresholds('2026-11-03', '2026-10-29', T, [60])).toEqual([7]);
    expect(dueThresholds('2026-11-03', '2026-10-29', T, [7])).toEqual([]);
    expect(dueThresholds('2026-10-20', '2026-10-29', T, [7])).toEqual([0]);
    expect(dueThresholds('2026-08-01', '2026-10-29', T, [])).toEqual([]);
  });
});

describe('sign-off rules', () => {
  const all = { canPrepare: true, canReview: true, canPartner: true };
  it('order, self-review and rights', () => {
    const s0 = { preparedBy: null, reviewedBy: null, partnerBy: null };
    expect(signoffError(s0, 'reviewer', 'u2', all)).toBe('preparer_signoff_required');
    expect(signoffError(s0, 'preparer', 'u1', { ...all, canPrepare: false })).toBe('forbidden');
    const s1 = { ...s0, preparedBy: 'u1' };
    expect(signoffError(s1, 'reviewer', 'u1', all)).toBe('self_review');
    expect(signoffError(s1, 'partner', 'u3', all)).toBe('reviewer_signoff_required');
    expect(signoffError(s1, 'reviewer', 'u2', all)).toBeNull();
    const s2 = { ...s1, reviewedBy: 'u2' };
    expect(signoffError(s2, 'partner', 'u1', all)).toBe('self_review');
    expect(signoffError(s2, 'partner', 'u3', all)).toBeNull();
    expect(signoffError(s2, 'reviewer', 'u3', all)).toBe('already_signed');
    expect(invalidatedByEvidence(s2)).toEqual(['preparer', 'reviewer']);
  });
});

describe('mock notice parser', () => {
  it('extracts suggested fields with confidence', () => {
    const s = parseNoticeText(`INCOME TAX DEPARTMENT\nNotice under section 143(2) of the Income-tax Act\nDIN: ITBA/AST/S/143(2)/2026-27/1012345678(1)\nPAN: ABCDE1234F\nAssessment Year: 2025-26\nDated: 15/10/2026\nYou are requested to furnish the details on or before 20-11-2026.\nDemand of Rs. 1,25,000.50 is proposed.`);
    const m = Object.fromEntries(s.map((x) => [x.field, x.value]));
    expect(m).toMatchObject({ authority: 'income_tax', section: '143(2)', pan: 'ABCDE1234F', assessmentYear: '2025-26', issueDate: '2026-10-15', responseDue: '2026-11-20', demandPaise: 12500050 });
    expect(String(m.din)).toMatch(/^ITBA\/AST/);
    expect(s.every((x) => x.confidence > 0 && x.confidence <= 1)).toBe(true);
    expect(parseNoticeText('GSTIN: 27ABCDE1234F1Z5 show cause DRC-01 u/s 73').find((x) => x.field === 'authority')?.value).toBe('gst');
    expect(parseNoticeText('nothing here')).toEqual([]);
  });
  it('dates', () => {
    expect(parseIndianDate('31/02/2026')).toBeNull();
    expect(parseIndianDate('5 Nov 2026')).toBe('2026-11-05');
    expect(parseIndianDate('2026-11-05')).toBe('2026-11-05');
  });
});
