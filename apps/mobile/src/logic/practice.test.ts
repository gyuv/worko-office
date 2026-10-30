import type { LocalRow } from '@worko/sync';
import { describe, expect, it } from 'vitest';
import {
  allowedTransitions, buildHearingBody, buildStatusBody, canCancelEsign, canRetryEsign, expiryBand, filterNotices, groupNotices, hearingsInRange, mergeAccepted,
  nextSignLevel, normaliseUdin, refusalCode, reviewRows, searchDsc, toDscItem, toHearingItem, toNoticeItem, validateUdinForm,
} from './practice';

const TODAY = '2026-10-29';
const row = (table: string, id: string, fields: Record<string, unknown>): LocalRow => ({ table, id, version: 1, deleted: false, fields });
const notice = (id: string, f: Record<string, unknown> = {}) => toNoticeItem(row('notice', id, { client_id: 'c1', authority: 'income_tax', title: `N ${id}`, status: 'received', demand_paise: '0', ...f }));
const hearing = (id: string, noticeId: string, startsAt: string, status = 'scheduled') => toHearingItem(row('notice_hearing', id, { notice_id: noticeId, client_id: 'c1', starts_at: startsAt, status }));

describe('notice mapping', () => {
  it('parses paise strings and dates', () => {
    const n = notice('a', { demand_paise: '1250000', response_due: '2026-11-02T00:00:00Z', final_demand_paise: null });
    expect(n.demandPaise).toBe(1_250_000);
    expect(n.responseDue).toBe('2026-11-02');
    expect(n.finalDemandPaise).toBeNull();
    expect(notice('b', { status: 'bogus' }).status).toBe('received');
  });
});

describe('notice grouping (IST, injected today)', () => {
  it('splits overdue / due soon / hearing this week / other / closed', () => {
    const ns = [
      notice('od', { response_due: '2026-10-28' }),
      notice('today', { response_due: TODAY }),
      notice('soon', { response_due: '2026-11-04' }), // today + 6
      notice('later', { response_due: '2026-11-05' }), // today + 7 → not soon
      notice('hear', { response_due: null }),
      notice('closed', { response_due: '2026-10-01', status: 'closed' }),
    ];
    // 2026-11-04 20:00 UTC = 2026-11-05 01:30 IST → outside the week; 2026-10-30 10:00 IST → inside
    const hs = [hearing('h1', 'hear', '2026-10-30T04:30:00Z'), hearing('h2', 'later', '2026-11-04T20:00:00Z')];
    const g = groupNotices(ns, hs, TODAY);
    expect(g.overdue.map((n) => n.id)).toEqual(['od']);
    expect(g.dueSoon.map((n) => n.id)).toEqual(['today', 'soon']);
    expect(g.hearingWeek.map((n) => n.id)).toEqual(['hear']);
    expect(g.other.map((n) => n.id)).toEqual(['later']);
    expect(g.closed.map((n) => n.id)).toEqual(['closed']);
  });
  it('uses the IST day for hearings near midnight', () => {
    const hs = [hearing('late', 'n', '2026-10-28T19:00:00Z'), hearing('adj', 'n', '2026-10-29T06:00:00Z', 'adjourned'), hearing('ok', 'n', '2026-10-29T05:00:00Z')];
    expect(hearingsInRange(hs, TODAY, 1).map((h) => h.id)).toEqual(['late', 'ok']); // 00:30 IST on the 29th counts as today
  });
  it('filters by status, authority, mine and search', () => {
    const ns = [notice('a', { assignee_id: 'u1', section: '143(2)' }), notice('b', { authority: 'gst', status: 'closed' })];
    const name = () => 'Acme Traders';
    expect(filterNotices(ns, { status: 'open', authority: null, mine: false, q: '' }, 'u1', name).map((n) => n.id)).toEqual(['a']);
    expect(filterNotices(ns, { status: 'all', authority: 'gst', mine: false, q: '' }, 'u1', name).map((n) => n.id)).toEqual(['b']);
    expect(filterNotices(ns, { status: 'all', authority: null, mine: true, q: '' }, 'u1', name).map((n) => n.id)).toEqual(['a']);
    expect(filterNotices(ns, { status: 'all', authority: null, mine: false, q: '143' }, 'u1', name).map((n) => n.id)).toEqual(['a']);
    expect(filterNotices(ns, { status: 'all', authority: null, mine: false, q: 'acme' }, 'u1', name)).toHaveLength(2);
  });
});

describe('status transitions', () => {
  it('mirrors the domain workflow', () => {
    expect(allowedTransitions('received')).toEqual(['under_review', 'drafting', 'closed']);
    expect(allowedTransitions('submitted')).toEqual(['drafting', 'hearing', 'closed']);
    expect(allowedTransitions('closed')).toEqual([]);
  });
  it('requires an outcome to close and validates the final demand', () => {
    expect(buildStatusBody('received', 'submitted', null, '', '')).toEqual({ ok: false, error: 'invalid_transition' });
    expect(buildStatusBody('drafting', 'closed', null, '', '')).toEqual({ ok: false, error: 'outcome_required' });
    expect(buildStatusBody('drafting', 'closed', 'demand_reduced', 'x', '10.999')).toEqual({ ok: false, error: 'final_demand' });
    expect(buildStatusBody('drafting', 'closed', 'demand_reduced', ' ok ', '1,000.50')).toEqual({ ok: true, body: { status: 'closed', outcome: 'demand_reduced', outcomeNote: 'ok', finalDemandPaise: 100050 } });
    expect(buildStatusBody('received', 'drafting', null, 'ignored', '')).toEqual({ ok: true, body: { status: 'drafting' } });
  });
});

describe('hearing form', () => {
  it('builds IST offset date-times and validates', () => {
    expect(buildHearingBody({ date: '2026-11-03', start: '11:00', end: '12:30', venue: ' Room 4 ', link: '' }, TODAY))
      .toEqual({ ok: true, body: { startsAt: '2026-11-03T11:00:00+05:30', endsAt: '2026-11-03T12:30:00+05:30', venue: 'Room 4', virtualLink: null } });
    expect(buildHearingBody({ date: '2026-02-30', start: '11:00', end: '', venue: '', link: '' }, TODAY)).toEqual({ ok: false, error: 'date' });
    expect(buildHearingBody({ date: '2026-10-28', start: '11:00', end: '', venue: '', link: '' }, TODAY)).toEqual({ ok: false, error: 'past' });
    expect(buildHearingBody({ date: TODAY, start: '25:00', end: '', venue: '', link: '' }, TODAY)).toEqual({ ok: false, error: 'time' });
    expect(buildHearingBody({ date: TODAY, start: '11:00', end: '10:00', venue: '', link: '' }, TODAY)).toEqual({ ok: false, error: 'order' });
    expect(buildHearingBody({ date: TODAY, start: '11:00', end: '', venue: '', link: 'http://x.in' }, TODAY)).toEqual({ ok: false, error: 'link' });
    const adj = buildHearingBody({ date: TODAY, start: '11:00', end: '', venue: '', link: 'https://meet.example.in/abc', reason: ' AO on leave ' }, TODAY);
    expect(adj.ok && adj.body.reason).toBe('AO on leave');
  });
});

describe('extraction review', () => {
  const sg = [
    { field: 'authority', value: 'income_tax', confidence: 0.85, source: 'kw' },
    { field: 'demandPaise', value: 1250050, confidence: 0.7, source: 'Rs 12,500.50' },
    { field: 'responseDue', value: '2026-11-15', confidence: 0.6, source: 'on or before' },
    { field: 'pan', value: 'ABCDE1234F', confidence: 0.9, source: 'PAN' },
  ];
  it('keeps confirmable fields, shows rupees, pre-accepts confident ones', () => {
    const rows = reviewRows(sg);
    expect(rows.map((r) => [r.field, r.value, r.accepted])).toEqual([['authority', 'income_tax', true], ['demandPaise', '12500.50', true], ['responseDue', '2026-11-15', false]]);
  });
  it('merges only accepted (possibly corrected) values', () => {
    const rows = reviewRows(sg).map((r) => (r.field === 'responseDue' ? { ...r, accepted: true, value: '2026-11-20' } : r));
    expect(mergeAccepted(rows, true)).toEqual({ ok: true, fields: { authority: 'income_tax', demandPaise: 1250050, responseDue: '2026-11-20' } });
    expect(mergeAccepted(rows.map((r) => ({ ...r, accepted: r.field === 'demandPaise' })), true)).toEqual({ ok: false, errors: ['authority'] });
    expect(mergeAccepted(rows.map((r) => ({ ...r, accepted: r.field === 'demandPaise' })), false)).toEqual({ ok: true, fields: { demandPaise: 1250050 } });
    expect(mergeAccepted([{ field: 'issueDate', value: '31/10/2026', accepted: true, confidence: 1, source: '' }], false)).toEqual({ ok: false, errors: ['issueDate'] });
    expect(mergeAccepted([{ field: 'demandPaise', value: '12.345', accepted: true, confidence: 1, source: '' }], false)).toEqual({ ok: false, errors: ['demandPaise'] });
  });
});

describe('DSC', () => {
  it('bands expiry relative to today', () => {
    expect(expiryBand('2026-10-28', TODAY)).toBe('expired');
    expect(expiryBand(TODAY, TODAY)).toBe('critical');
    expect(expiryBand('2026-11-05', TODAY)).toBe('critical');
    expect(expiryBand('2026-11-06', TODAY)).toBe('warning');
    expect(expiryBand('2026-11-28', TODAY)).toBe('warning');
    expect(expiryBand('2026-11-29', TODAY)).toBe('ok');
    expect(expiryBand(null, TODAY)).toBe('unknown');
  });
  it('searches holder, client and serial; soonest expiry first', () => {
    const d = (id: string, f: Record<string, unknown>) => toDscItem(row('dsc', id, { holder_name: 'X', custody: 'in_office', ...f }));
    const items = [d('1', { holder_name: 'Ravi Kumar', valid_to: '2027-05-01', serial_no: '1A 2B-3C', client_id: 'c1' }),
      d('2', { holder_name: 'Meena', valid_to: '2026-11-01', client_id: 'c2' }), d('3', { holder_name: 'Old', valid_to: '2026-01-01', custody: 'nowhere' })];
    const names = (id: string) => ({ c1: 'Acme', c2: 'Beta' })[id];
    expect(searchDsc(items, '', names, TODAY).map((x) => x.id)).toEqual(['3', '2', '1']);
    expect(searchDsc(items, 'ravi', names, TODAY).map((x) => x.id)).toEqual(['1']);
    expect(searchDsc(items, 'beta', names, TODAY).map((x) => x.id)).toEqual(['2']);
    expect(searchDsc(items, '1a2b', names, TODAY).map((x) => x.id)).toEqual(['1']);
    expect(items[2]!.custody).toBe('in_office');
  });
});

describe('UDIN entry validation', () => {
  const ok = { udin: '26123456 abcdef1234', membershipNo: '123456', documentType: 'Tax audit report', generatedOn: TODAY };
  it('normalises and accepts a well-formed UDIN', () => {
    expect(normaliseUdin(' 26123456-abcdef1234 ')).toBe('26123456ABCDEF1234');
    expect(validateUdinForm(ok, TODAY)).toEqual({ ok: true, value: { ...ok, udin: '26123456ABCDEF1234' } });
  });
  it('reports each problem', () => {
    expect(validateUdinForm({ ...ok, udin: '' }, TODAY)).toEqual({ ok: false, errors: ['udin_empty'] });
    expect(validateUdinForm({ ...ok, udin: '2612345' }, TODAY)).toEqual({ ok: false, errors: ['udin_length'] });
    expect(validateUdinForm({ ...ok, udin: 'AB123456ABCDEF1234' }, TODAY)).toEqual({ ok: false, errors: ['udin_format'] });
    expect(validateUdinForm({ ...ok, membershipNo: '12345', documentType: ' ', generatedOn: '2026-10-30' }, TODAY)).toEqual({ ok: false, errors: ['membership', 'document_type', 'future'] });
    expect(validateUdinForm({ ...ok, generatedOn: '30-10-2026' }, TODAY)).toEqual({ ok: false, errors: ['date'] });
  });
});

describe('audit sign-off and e-sign helpers', () => {
  it('next level follows preparer → reviewer → partner', () => {
    const p = { preparedBy: null, reviewedBy: null, partnerBy: null, notApplicable: false };
    expect(nextSignLevel(p)).toBe('preparer');
    expect(nextSignLevel({ ...p, preparedBy: 'u' })).toBe('reviewer');
    expect(nextSignLevel({ ...p, preparedBy: 'u', reviewedBy: 'v' })).toBe('partner');
    expect(nextSignLevel({ ...p, preparedBy: 'u', reviewedBy: 'v', partnerBy: 'w' })).toBeNull();
    expect(nextSignLevel({ ...p, notApplicable: true })).toBeNull();
  });
  it('maps server refusal codes', () => {
    expect(refusalCode('self_review')).toBe('self_review');
    expect(refusalCode(undefined, 403)).toBe('forbidden');
    expect(refusalCode('weird', 400)).toBe('other');
  });
  it('retry/cancel availability', () => {
    expect(canRetryEsign('partially_failed')).toBe(true);
    expect(canRetryEsign('in_progress', ['sent', 'failed'])).toBe(true);
    expect(canRetryEsign('in_progress', ['sent'])).toBe(false);
    expect(canRetryEsign('cancelled', ['failed'])).toBe(false);
    expect(canCancelEsign('in_progress')).toBe(true);
    expect(canCancelEsign('completed')).toBe(false);
  });
});
