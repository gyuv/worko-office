import { defaultPortalGrants } from '@worko/domain';
import { describe, expect, it } from 'vitest';
import { canVerify, codeExpired, esignHref, grantsReducer, invalidFys, listFromText, otpInitial, otpReducer, OTP_TRIES, parsePortalHash, portalHref, secondsUntil, viewAllowed } from './logic';

describe('portal routes', () => {
  it('parses firm, view, id and client', () => {
    expect(parsePortalHash('#/portal/Demo')).toEqual({ firm: 'demo', view: 'dashboard' });
    expect(parsePortalHash('#/portal/demo/invoices/abc?client=c1')).toEqual({ firm: 'demo', view: 'invoices', id: 'abc', clientId: 'c1' });
    expect(parsePortalHash('#/portal/demo/bogus')).toEqual({ firm: 'demo', view: 'dashboard' });
    expect(parsePortalHash('#/clients')).toBeNull();
    expect(parsePortalHash('#/portal/')).toBeNull();
    expect(parsePortalHash('#/portal/x')).toBeNull(); // slug too short
  });
  it('round-trips hrefs', () => {
    const h = portalHref('demo', 'documents', { clientId: 'c 1' });
    expect(parsePortalHash(h)).toEqual({ firm: 'demo', view: 'documents', clientId: 'c 1' });
  });
  it('hides sections without grants (notices off by default)', () => {
    const g = defaultPortalGrants();
    expect(viewAllowed('notices', g)).toBe(false);
    expect(viewAllowed('invoices', g)).toBe(true);
    expect(viewAllowed('documents', { ...g, documents: { ...g.documents, enabled: false } })).toBe(false);
    expect(viewAllowed('receipts', { ...g, invoices: false, payments: false })).toBe(false);
  });
  it('maps API signer links to the web signer page', () => {
    expect(esignHref('http://localhost:3000/v1/esign/sign/abc.def')).toBe('#/esign/sign/abc.def');
  });
});

describe('OTP form states (D135)', () => {
  const sent = otpReducer({ ...otpInitial, identifier: 'a@b.in' }, { type: 'sent', now: 0 });
  it('request always moves to the code step with a resend timer and 10-minute expiry', () => {
    expect(sent.step).toBe('code');
    expect(secondsUntil(sent.resendAt, 1000)).toBe(29);
    expect(codeExpired(sent, 10 * 60_000)).toBe(true);
    expect(canVerify({ ...sent, code: '123456' }, 1000)).toBe(true);
    expect(canVerify({ ...sent, code: '123456' }, 10 * 60_000)).toBe(false);
  });
  it('wrong codes are uniform; after 5 tries a new code is needed', () => {
    let s = sent;
    for (let i = 0; i < OTP_TRIES; i++) s = otpReducer({ ...otpReducer(s, { type: 'code', value: '111111' }), busy: true }, { type: 'failed', phase: 'verify', status: 401, now: 1 });
    expect(s.error).toBe('new_code_needed');
    expect(canVerify({ ...s, code: '123456' }, 2)).toBe(false);
    const again = otpReducer(s, { type: 'sent', now: 5 });
    expect(again.attempts).toBe(0);
    expect(canVerify({ ...again, code: '123456' }, 6)).toBe(true);
  });
  it('429 is a throttle countdown (Retry-After or 60s), never a lock', () => {
    const s = otpReducer(sent, { type: 'failed', phase: 'verify', status: 429, now: 0, retryAfter: 20 });
    expect(s.error).toBe('throttled');
    expect(secondsUntil(s.retryAt, 0)).toBe(20);
    expect(canVerify({ ...s, code: '123456' }, 1000)).toBe(false);
    expect(canVerify({ ...s, code: '123456' }, 21_000)).toBe(true);
    expect(secondsUntil(otpReducer(otpInitial, { type: 'failed', phase: 'request', status: 429, now: 0 }).retryAt, 0)).toBe(60);
    expect(s.attempts).toBe(0);
  });
  it('code input keeps digits only', () => {
    expect(otpReducer(sent, { type: 'code', value: '12a34 5678' }).code).toBe('123456');
  });
});

describe('grants editor state', () => {
  it('toggles areas and parses lists', () => {
    let g = defaultPortalGrants();
    g = grantsReducer(g, { type: 'flag', flag: 'notices', on: true });
    g = grantsReducer(g, { type: 'categories', text: 'GST, Income tax, GST' });
    g = grantsReducer(g, { type: 'fys', text: '' });
    expect(g.notices).toBe(true);
    expect(g.documents.categories).toEqual(['GST', 'Income tax']);
    expect(g.documents.fys).toEqual(['*']);
    expect(grantsReducer(g, { type: 'documents', on: false }).documents.enabled).toBe(false);
    expect(grantsReducer(g, { type: 'reset' })).toEqual(defaultPortalGrants());
  });
  it('validates FYs', () => {
    expect(listFromText('*, 2025-26')).toEqual(['*']);
    expect(invalidFys(['2025-26', '2025'])).toEqual(['2025']);
  });
});
