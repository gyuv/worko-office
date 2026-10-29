import { defaultPortalGrants } from '@worko/domain';
import { describe, expect, it } from 'vitest';
import { applyMove, followupState, groupBoard, moveBody, moveError, moveTargets, toLeadItem, type LeadItem } from './leads';
import {
  accentColor, cacheView, canVerify, heldSecondsLeft, initialOtp, invoiceDisplay, isHeld, makeCacheEntry, moreItems, otpEventFor, otpReducer, parseGrants, pickClient,
  portalTabs, profileChanges, readCacheEntry, resendIn, safeExternalUrl, toPortalInvoice, totalOutstanding, validCode, validIdentifier, STALE_AFTER_MS,
} from './portal';

const T0 = Date.parse('2026-10-29T05:00:00Z');

describe('portal OTP state machine', () => {
  it('moves to code entry and enforces the resend timer', () => {
    const s = otpReducer(initialOtp(), { type: 'sent' }, T0);
    expect(s.phase).toBe('code');
    expect(resendIn(s, T0)).toBe(30);
    expect(resendIn(s, T0 + 29_500)).toBe(1);
    expect(resendIn(s, T0 + 30_000)).toBe(0);
  });
  it('a code dies after 5 wrong guesses; a new code resets (no account lockout, D135)', () => {
    let s = otpReducer(initialOtp(), { type: 'sent' }, T0);
    for (let i = 0; i < 4; i++) s = otpReducer(s, { type: 'verifyFailed' }, T0);
    expect(s.error).toBe('invalid');
    expect(canVerify(s, T0)).toBe(true);
    s = otpReducer(s, { type: 'verifyFailed' }, T0);
    expect(s.error).toBe('codeSpent');
    expect(canVerify(s, T0)).toBe(false);
    s = otpReducer(s, { type: 'sent' }, T0 + 60_000);
    expect(canVerify(s, T0 + 60_000)).toBe(true);
    expect(canVerify(s, T0 + 60_000 + 10 * 60_000)).toBe(false); // expired
  });
  it('429 holds both buttons for the throttle window; edit keeps the hold', () => {
    expect(otpEventFor('verify', 401)).toEqual({ type: 'verifyFailed' });
    expect(otpEventFor('verify', 429)).toEqual({ type: 'rateLimited' });
    expect(otpEventFor('request', 429)).toEqual({ type: 'rateLimited' });
    expect(otpEventFor('request', undefined)).toEqual({ type: 'network' });
    let s = otpReducer(otpReducer(initialOtp(), { type: 'sent' }, T0), { type: 'rateLimited' }, T0);
    expect(isHeld(s, T0 + 59_000)).toBe(true);
    expect(heldSecondsLeft(s, T0 + 30_000)).toBe(30);
    expect(resendIn(s, T0 + 30_000)).toBe(30);
    expect(canVerify(s, T0 + 1000)).toBe(false);
    s = otpReducer(s, { type: 'edit' }, T0);
    expect(s.phase).toBe('identify');
    expect(isHeld(s, T0 + 1000)).toBe(true);
    expect(isHeld(s, T0 + 60_000)).toBe(false);
  });
  it('validates inputs', () => {
    expect(validCode('123456')).toBe(true);
    expect(validCode('12345a')).toBe(false);
    expect(validIdentifier('a@b.in')).toBe(true);
    expect(validIdentifier('98450 12345')).toBe(true);
    expect(validIdentifier('xyz')).toBe(false);
  });
});

describe('grant-based visibility', () => {
  it('defaults show documents/requests/invoices/messages', () => {
    const g = defaultPortalGrants();
    expect(portalTabs(g)).toEqual(['home', 'documents', 'requests', 'invoices', 'messages', 'more']);
    expect(moreItems(g)).toEqual(['esign', 'receipts', 'profile', 'consent']);
  });
  it('hides areas without a grant; malformed grants hide everything', () => {
    const g = { ...defaultPortalGrants(), invoices: false, payments: false, messages: false, esign: false, documents: { enabled: false, categories: ['*'], fys: ['*'] } };
    expect(portalTabs(g)).toEqual(['home', 'requests', 'more']);
    expect(moreItems(g)).toEqual(['profile', 'consent']);
    expect(portalTabs(parseGrants({ bogus: 1 }))).toEqual(['home', 'more']);
  });
  it('keeps the selected client while accessible', () => {
    expect(pickClient([{ id: 'a' }, { id: 'b' }], 'b')).toBe('b');
    expect(pickClient([{ id: 'a' }], 'b')).toBe('a');
    expect(pickClient([], 'b')).toBeNull();
  });
  it('accent falls back to blue', () => {
    expect(accentColor('teal', 'light')).toBe('#0f766e');
    expect(accentColor('pink', 'dark')).toBe('#7aa2ff');
  });
});

describe('read-only cache', () => {
  it('is scoped to user + client and trims lists', () => {
    const e = makeCacheEntry('u1', 'c1', Array.from({ length: 80 }, (_, i) => i), T0);
    expect(e.data).toHaveLength(50);
    const raw = JSON.stringify(e);
    expect(readCacheEntry(raw, 'u1', 'c1')?.savedAt).toBe(T0);
    expect(readCacheEntry(raw, 'u2', 'c1')).toBeNull();
    expect(readCacheEntry(raw, 'u1', 'c2')).toBeNull();
    expect(readCacheEntry('{bad', 'u1', 'c1')).toBeNull();
  });
  it('prefers live data; cache is stale on failure or age', () => {
    const e = makeCacheEntry('u', 'c', { x: 1 }, T0);
    expect(cacheView({ x: 2 }, e, false, T0)).toEqual({ data: { x: 2 }, stale: false, savedAt: null });
    expect(cacheView(undefined, e, true, T0).stale).toBe(true);
    expect(cacheView(undefined, e, false, T0 + 1000).stale).toBe(false);
    expect(cacheView(undefined, e, false, T0 + STALE_AFTER_MS + 1).stale).toBe(true);
    expect(cacheView(undefined, null, true, T0).data).toBeUndefined();
  });
});

describe('invoice display', () => {
  const inv = (o: Record<string, unknown>) => toPortalInvoice({ id: 'i', kind: 'invoice', status: 'issued', number: 'INV/1', totalPaise: '11800', balancePaise: '11800', dueDate: '2026-10-31', ...o });
  it('parses paise strings and badges', () => {
    expect(inv({}).balancePaise).toBe(11800);
    expect(invoiceDisplay(inv({}), '2026-10-29')).toEqual({ badge: 'due', outstandingPaise: 11800, daysOverdue: 0 });
    expect(invoiceDisplay(inv({ dueDate: '2026-10-19' }), '2026-10-29')).toEqual({ badge: 'overdue', outstandingPaise: 11800, daysOverdue: 10 });
    expect(invoiceDisplay(inv({ balancePaise: 0, status: 'paid' }), '2026-10-29').badge).toBe('paid');
    expect(invoiceDisplay(inv({ kind: 'credit_note' }), '2026-10-29').badge).toBe('credit');
    expect(inv({ balancePaise: '12.5' }).balancePaise).toBe(0);
  });
  it('totals outstanding and overdue', () => {
    expect(totalOutstanding([inv({}), inv({ dueDate: '2026-10-01', balancePaise: 500 })], '2026-10-29')).toEqual({ totalPaise: 12300, overduePaise: 500 });
  });
  it('only opens safe URLs; profile diff', () => {
    expect(safeExternalUrl('https://pay.example/x')).toBe('https://pay.example/x');
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('http://evil.example')).toBeNull();
    expect(profileChanges({ name: 'A', email: 'a@x.in' }, { name: 'A', email: ' b@x.in ', phone: '' })).toEqual({ email: 'b@x.in' });
  });
});

describe('leads kanban', () => {
  const L = (o: Partial<LeadItem> & { id: string }): LeadItem => toLeadItem({ name: o.id, stage: 'new', position: 1024, expectedValuePaise: '0', ...o });
  const leads = [L({ id: 'a', position: 2048, expectedValuePaise: 100 }), L({ id: 'b', position: 1024, expectedValuePaise: 50 }), L({ id: 'c', stage: 'qualified' }), L({ id: 'w', stage: 'won', clientId: 'x' })];
  it('groups by stage order and position', () => {
    const b = groupBoard(leads);
    expect(b.map((c) => c.stage)).toEqual(['new', 'contacted', 'qualified', 'proposal', 'won', 'lost']);
    expect(b[0]!.items.map((x) => x.id)).toEqual(['b', 'a']);
    expect(b[0]!.valuePaise).toBe(150);
  });
  it('validates moves with domain rules', () => {
    const a = leads[0]!;
    expect(moveError(a, 'lost')).toBe('lost_reason_required');
    expect(moveError(a, 'lost', 'price')).toBeNull();
    expect(moveError(a, 'won')).toBe('convert_to_win');
    expect(moveError(leads[3]!, 'new')).toBe('lead_won_final');
    expect(moveError(L({ id: 'l', stage: 'lost' }), 'proposal')).toBe('invalid_transition');
    expect(moveTargets(a).find((x) => x.stage === 'lost')).toEqual({ stage: 'lost', blocked: null, needsReason: true });
  });
  it('appends to the target column', () => {
    const b = groupBoard(leads);
    expect(moveBody(b, leads[1]!, 'qualified')).toEqual({ stage: 'qualified', beforeId: 'c', afterId: null, lostReason: null });
    expect(moveBody(b, leads[1]!, 'lost', ' too costly ')).toEqual({ stage: 'lost', beforeId: null, afterId: null, lostReason: 'too costly' });
    const after = applyMove(b, leads[1]!, 'qualified');
    expect(after[2]!.items.map((x) => x.id)).toEqual(['c', 'b']);
    expect(after[0]!.items.map((x) => x.id)).toEqual(['a']);
  });
  it('follow-up state', () => {
    expect(followupState(L({ id: 'f', nextFollowupOn: '2026-10-28' }), '2026-10-29')).toBe('overdue');
    expect(followupState(L({ id: 'f', nextFollowupOn: '2026-10-29' }), '2026-10-29')).toBe('today');
    expect(followupState(L({ id: 'f', stage: 'won', nextFollowupOn: '2026-10-01' }), '2026-10-29')).toBeNull();
  });
});
