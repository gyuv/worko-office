import { describe, expect, it } from 'vitest';
import {
  affordable, availableSlots, buildIcs, capCheck, icsEscape, icsFold, istInstant, mentionsOf, normalizeEmail, normalizePhone, parseKeyword,
  placeholdersOf, rateFor, renderTemplate, smsSegments, templateErrors, withinEditWindow, type CommRate,
} from './comm.js';

describe('phone/email normalisation', () => {
  it('normalises Indian numbers to +91', () => {
    for (const s of ['9876543210', '09876543210', '919876543210', '+91 98765 43210', '+91-98765-43210', '0091 9876543210', '(+91) 98765.43210']) expect(normalizePhone(s)).toBe('+919876543210');
  });
  it('rejects invalid numbers and keeps explicit foreign numbers', () => {
    for (const s of ['12345', '5876543210', '+91 5876543210', 'abc9876543210', '', null]) expect(normalizePhone(s as string)).toBeNull();
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('+1 (415) 555-0100')).toBe('+14155550100');
  });
  it('lower-cases emails and rejects junk', () => {
    expect(normalizeEmail('  Ravi.K@Example.IN ')).toBe('ravi.k@example.in');
    expect(normalizeEmail('not an email')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
  });
});

describe('STOP keywords', () => {
  it('matches whole-message opt-out/opt-in keywords only', () => {
    for (const s of ['STOP', ' stop. ', 'Stop all', 'opt-out', 'UNSUBSCRIBE', 'band karo']) expect(parseKeyword(s)).toBe('stop');
    for (const s of ['START', 'unstop', 'Subscribe']) expect(parseKeyword(s)).toBe('start');
    for (const s of ["please don't stop the filing", 'yes', 'stopwatch', '', 'ok thanks']) expect(parseKeyword(s)).toBeNull();
  });
});

describe('templates', () => {
  it('validates placeholders against the allowed list and forbids secrets', () => {
    expect(templateErrors('Dear {{contact.name}}, invoice {{invoice.number}} for {{ invoice.amount }} is due on {{invoice.due_date}}.')).toEqual([]);
    expect(templateErrors('Hi {{client.nme}}')).toEqual(['unknown_variable:client.nme']);
    expect(templateErrors('Your password is {{vault.password}}')).toEqual(['forbidden_variable:vault.password']);
    expect(templateErrors('OTP {{otp}} PAN {{client.pan}}')).toEqual(['forbidden_variable:otp', 'forbidden_variable:client.pan']);
    expect(templateErrors('Hi {{contact.name}')).toContain('malformed_placeholder');
    expect(templateErrors('Hi {{Contact Name}}')).toEqual(['bad_variable:Contact Name']);
    expect(placeholdersOf('{{a}} {{ a }} {{b.c}}')).toEqual(['a', 'b.c']);
  });
  it('renders with escaping, never re-expands values and reports missing variables', () => {
    const r = renderTemplate('<p>Dear {{contact.name}}</p> {{link}} {{month}}', { 'contact.name': '<script>alert(1)</script> & "co"', link: '{{firm.name}}' }, 'html');
    expect(r.text).toBe('<p>Dear &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;co&quot;</p> firm.name ');
    expect(r.missing).toEqual(['month']);
    expect(renderTemplate('Hi {{contact.name}}', { 'contact.name': 'A\u0007B' }).text).toBe('Hi AB');
    expect(renderTemplate('Secret {{vault.secret}}', { 'vault.secret': 'x' }).text).toBe('Secret ');
  });
});

describe('rates and caps', () => {
  const rates: CommRate[] = [
    { channel: 'whatsapp', category: '*', paise: 50, effectiveFrom: '2026-01-01', effectiveTo: null },
    { channel: 'whatsapp', category: 'marketing', paise: 80, effectiveFrom: '2026-01-01', effectiveTo: '2026-09-30' },
    { channel: 'whatsapp', category: 'marketing', paise: 90, effectiveFrom: '2026-10-01', effectiveTo: null },
  ];
  it('picks the effective, most specific rate', () => {
    expect(rateFor(rates, 'whatsapp', 'marketing', '2026-09-15')).toBe(80);
    expect(rateFor(rates, 'whatsapp', 'marketing', '2026-10-15')).toBe(90);
    expect(rateFor(rates, 'whatsapp', 'utility', '2026-10-15')).toBe(50);
    expect(rateFor(rates, 'sms', 'utility', '2026-10-15')).toBeNull();
    expect(rateFor(rates, 'whatsapp', 'utility', '2025-12-31')).toBeNull();
  });
  it('cap checks block or warn; affordable counts', () => {
    expect(capCheck(900, 100, 1000, 'block')).toEqual({ allowed: true, warn: false, remainingPaise: 100 });
    expect(capCheck(950, 100, 1000, 'block')).toEqual({ allowed: false, warn: true, remainingPaise: 50 });
    expect(capCheck(950, 100, 1000, 'warn')).toMatchObject({ allowed: true, warn: true });
    expect(capCheck(1e9, 1, null, 'block').allowed).toBe(true);
    expect(affordable(250, 80)).toBe(3);
    expect(affordable(null, 80)).toBe(Infinity);
    expect(affordable(10, 0)).toBe(Infinity);
  });
  it('counts SMS segments', () => {
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
    expect(smsSegments('नमस्ते'.repeat(12))).toBe(2);
  });
});

describe('booking slots', () => {
  const wh = { '1': [['10:00', '12:00']] as [string, string][], '2': [['10:00', '11:00']] as [string, string][] };
  const base = { workingHours: wh, slotMinutes: 30, bufferMinutes: 0, busy: [], daysOff: [], now: new Date('2026-10-01T00:00:00Z'), minNoticeMinutes: 0 };
  it('slices working hours (IST) into slots', () => {
    const s = availableSlots({ ...base, from: '2026-10-05', to: '2026-10-06' }); // Mon + Tue
    expect(s.map((d) => d.toISOString())).toEqual(['2026-10-05T04:30:00.000Z', '2026-10-05T05:00:00.000Z', '2026-10-05T05:30:00.000Z', '2026-10-05T06:00:00.000Z', '2026-10-06T04:30:00.000Z', '2026-10-06T05:00:00.000Z']);
  });
  it('excludes busy intervals (with buffer), days off and short notice', () => {
    const busy = [{ start: istInstant('2026-10-05', '10:30'), end: istInstant('2026-10-05', '11:00') }];
    expect(availableSlots({ ...base, from: '2026-10-05', to: '2026-10-05', busy }).length).toBe(3);
    expect(availableSlots({ ...base, from: '2026-10-05', to: '2026-10-05', busy, bufferMinutes: 15 }).map((d) => d.toISOString())).toEqual(['2026-10-05T06:00:00.000Z']); // 10:00 and 10:45 clash, 11:30 is clear
    expect(availableSlots({ ...base, from: '2026-10-05', to: '2026-10-06', daysOff: ['2026-10-05'] })).toHaveLength(2);
    expect(availableSlots({ ...base, from: '2026-10-05', to: '2026-10-05', now: istInstant('2026-10-05', '10:10'), minNoticeMinutes: 30 }).map((d) => d.toISOString())).toEqual(['2026-10-05T05:30:00.000Z', '2026-10-05T06:00:00.000Z']);
  });
});

describe('ICS', () => {
  it('escapes text, folds long lines and emits all-day events', () => {
    expect(icsEscape('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
    const folded = icsFold(`SUMMARY:${'x'.repeat(200)}`);
    expect(folded.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(folded.replace(/\r\n /g, '')).toBe(`SUMMARY:${'x'.repeat(200)}`);
    const hindi = icsFold(`SUMMARY:${'न'.repeat(60)}`);
    expect(hindi.replace(/\r\n /g, '')).toBe(`SUMMARY:${'न'.repeat(60)}`);
    const ics = buildIcs('My, cal', [
      { uid: 'e1@worko', start: new Date('2026-10-05T04:30:00Z'), end: new Date('2026-10-05T05:00:00Z'), summary: 'Meet; Sharma, & co\nline2' },
      { uid: 't1@worko', start: new Date('2026-10-04T18:30:00Z'), end: new Date('2026-10-04T18:30:00Z'), allDay: true, summary: 'GSTR-3B' },
    ], new Date('2026-10-01T00:00:00Z'));
    expect(ics).toContain('X-WR-CALNAME:My\\, cal');
    expect(ics).toContain('SUMMARY:Meet\\; Sharma\\, & co\\nline2');
    expect(ics).toContain('DTSTART:20261005T043000Z');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261005');
    expect(ics).toContain('DTEND;VALUE=DATE:20261006');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
});

describe('chat helpers', () => {
  it('extracts mentions and checks the edit window', () => {
    const u = '0190a7d2-0000-7000-8000-000000000001';
    expect(mentionsOf(`hi @[Priya](${u}) and @[Priya](${u.toUpperCase()}) @someone`)).toEqual([u]);
    expect(withinEditWindow(new Date('2026-10-01T10:00:00Z'), new Date('2026-10-01T10:15:00Z'), 15)).toBe(true);
    expect(withinEditWindow(new Date('2026-10-01T10:00:00Z'), new Date('2026-10-01T10:15:01Z'), 15)).toBe(false);
  });
});
