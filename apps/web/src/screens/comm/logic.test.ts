import { describe, expect, it } from 'vitest';
import {
  addressKey, bodySegments, consentBlock, consentFor, filterMembers, fromLocalInput, groupSlots, groupTimeline, insertMention, layoutWeek, mentionQuery, monthGrid,
  previewTemplate, previewTotals, publicRoute, unreadCounts, weekDays, workingHoursErrors, type CalItem, type ChatMember, type ChatMessage, type TimelineItem,
} from './logic';

const tl = (id: string, at: string, o: Partial<TimelineItem> = {}): TimelineItem => ({ kind: 'message', id, at, channel: 'email', direction: 'out', title: null, body: 'x', status: 'sent',
  address: null, by: null, callMinutes: null, amountPaise: null, broadcastId: null, ...o });

describe('timeline grouping', () => {
  it('merges pages, drops duplicates and groups by IST day (newest first)', () => {
    const g = groupTimeline([
      { clientId: 'c', nextBefore: 'x', items: [tl('a', '2026-10-28T05:00:00Z'), tl('b', '2026-10-27T19:00:00Z')] }, // b = 28 Oct 00:30 IST
      { clientId: 'c', nextBefore: null, items: [tl('b', '2026-10-27T19:00:00Z'), tl('c', '2026-10-27T18:00:00Z', { kind: 'invoice' }), tl('a', '2026-10-28T05:00:00Z', { kind: 'task' })] },
    ]);
    expect(g.map((x) => x.day)).toEqual(['2026-10-28', '2026-10-27']);
    expect(g[0]!.items.map((i) => `${i.kind}:${i.id}`)).toEqual(['message:a', 'task:a', 'message:b']);
    expect(g[1]!.items.map((i) => i.id)).toEqual(['c']);
  });
});

describe('consent', () => {
  const consents = [{ id: '1', channel: 'sms', address: '+919876543210', clientId: 'c', contactId: null, status: 'opted_out' as const, optedInAt: null, optedInSource: null, optedOutAt: '2026-10-01', optedOutSource: 'keyword:sms', keyword: 'STOP', note: null, updatedAt: '' }];
  it('matches on the last 10 digits and applies the D99 policy', () => {
    expect(addressKey('sms', '098765 43210')).toBe('9876543210');
    expect(consentFor(consents, 'sms', '9876543210')).toBe('opted_out');
    expect(consentFor(consents, 'whatsapp', '9876543210')).toBe('none');
    expect(consentFor(consents, 'email', null)).toBe('no_address');
    const policy = { transactionalRequiresOptIn: false, optOutBlocksTransactional: true };
    expect(consentBlock('opted_out', 'transactional', policy)).toBe('opted_out');
    expect(consentBlock('none', 'transactional', policy)).toBeNull();
    expect(consentBlock('none', 'marketing', policy)).toBe('not_opted_in');
    expect(consentBlock('opted_out', 'utility', { ...policy, optOutBlocksTransactional: false })).toBeNull();
  });
});

describe('template preview', () => {
  it('reports placeholder errors like the server', () => {
    const p = previewTemplate({ channel: 'email', subject: '', body: 'Dear {{contact.name}}, {{vault.secret}} {{foo}} {{Bad-Var}} {{oops}' });
    expect(p.issues).toEqual(expect.arrayContaining([{ code: 'malformed_placeholder' }, { code: 'forbidden_variable', name: 'vault.secret' }, { code: 'unknown_variable', name: 'foo' },
      { code: 'bad_variable', name: 'Bad-Var' }, { code: 'subject_required' }]));
  });
  it('renders a live preview with sample values and overrides', () => {
    const p = previewTemplate({ channel: 'whatsapp', subject: null, body: 'Hi {{contact.name}}, {{service}} for {{period}} is due on {{due_date}}.', vars: { period: 'Sep 2026' } });
    expect(p.issues).toEqual([]);
    expect(p.text).toBe('Hi Rakesh Mehta, GSTR-3B for Sep 2026 is due on 20 Nov 2026.');
  });
});

describe('broadcast preview totals', () => {
  it('adds buckets up to the audience and exposes cost/send-ability', () => {
    const p = { audience: 12, eligible: 7, optedOut: 2, notOptedIn: 1, noContact: 1, duplicates: 1, overCap: 0, unitPaise: 80, costPaise: 560, capWarning: false, needsApproval: false };
    const s = previewTotals(p);
    expect(s.skipped).toBe(5);
    expect(s.consistent).toBe(true);
    expect(s.costPaise).toBe(560);
    expect(s.canSend).toBe(true);
    expect(previewTotals({ ...p, eligible: 0, audience: 5 }).canSend).toBe(false);
  });
});

describe('chat', () => {
  const msg = (id: string, ch: string, author: string, at: string | null): ChatMessage => ({ id, channelId: ch, authorId: author, body: '', mentions: [], attachmentDocIds: [], editedAt: null, createdAt: at });
  const mem = (ch: string, user: string, last: string | null, lastAt: string | null = null): ChatMember => ({ id: `${ch}-${user}`, channelId: ch, userId: user, role: 'member', lastReadMessageId: last, lastReadAt: lastAt, muted: false });
  it('counts unread messages by others after the read cursor', () => {
    const msgs = [msg('m1', 'A', 'u2', '2026-10-28T05:00:00Z'), msg('m2', 'A', 'u2', '2026-10-28T05:01:00Z'), msg('m3', 'A', 'me', '2026-10-28T05:02:00Z'),
      msg('m4', 'A', 'u3', '2026-10-28T05:03:00Z'), msg('n1', 'B', 'u2', '2026-10-28T04:00:00Z'), msg('x1', 'C', 'u2', '2026-10-28T04:00:00Z')];
    const u = unreadCounts('me', [mem('A', 'me', 'm1'), mem('B', 'me', null), mem('A', 'u2', null), mem('D', 'me', 'gone', '2026-10-28T03:00:00Z')], msgs);
    expect(u.get('A')).toBe(2); // m2, m4 (m3 is mine)
    expect(u.get('B')).toBe(1); // no cursor: all by others
    expect(u.has('C')).toBe(false); // not a member
    expect(u.get('D')).toBe(0);
  });
  it('finds the @query at the caret and inserts a parseable mention', () => {
    const text = 'Hi @ra';
    const q = mentionQuery(text, text.length)!;
    expect(q).toEqual({ start: 3, query: 'ra' });
    expect(mentionQuery('mail a@b', 8)).toBeNull();
    const id = '0190a000-0000-7000-8000-000000000002';
    const r = insertMention(text, q.start, text.length, { id, name: 'Ravi [CA]' });
    expect(r.text).toBe(`Hi @[Ravi CA](${id}) `);
    expect(bodySegments(r.text)).toEqual([{ text: 'Hi ' }, { text: '@Ravi CA', mention: id }, { text: ' ' }]);
    expect(filterMembers([{ id: 'a', name: 'Ravi' }, { id: 'b', name: 'Anita' }, { id: 'me', name: 'Raghav' }], 'ra', 'me').map((u) => u.id)).toEqual(['a']);
  });
});

describe('calendar layout', () => {
  const ev = (id: string, s: string, e: string, o: Partial<CalItem> = {}): CalItem => ({ source: 'event', id, kind: 'meeting', title: id, startsAt: s, endsAt: e, allDay: false, clientId: null, clientName: null, editable: true, ...o });
  it('builds a Monday-first IST week and splits overlaps into lanes', () => {
    const days = weekDays('2026-10-28'); // Wednesday
    expect(days[0]).toBe('2026-10-26');
    expect(days[6]).toBe('2026-11-01');
    const cols = layoutWeek([
      ev('a', '2026-10-28T10:00:00+05:30', '2026-10-28T11:00:00+05:30'),
      ev('b', '2026-10-28T10:30:00+05:30', '2026-10-28T11:30:00+05:30'),
      ev('c', '2026-10-28T12:00:00+05:30', '2026-10-28T12:30:00+05:30'),
      ev('h', '2026-10-29T00:00:00+05:30', '2026-10-29T00:00:00+05:30', { source: 'holiday', allDay: true }),
      ev('l', '2026-10-30T00:00:00+05:30', '2026-11-02T00:00:00+05:30', { source: 'leave', allDay: true }),
    ], days);
    const wed = cols[2]!;
    expect(wed.timed.map((x) => [x.id, x.top, x.height, x.lane, x.lanes])).toEqual([['a', 600, 60, 0, 2], ['b', 630, 60, 1, 2], ['c', 720, 30, 0, 1]]);
    expect(cols[3]!.allDay.map((x) => x.id)).toEqual(['h']);
    expect(cols.filter((c) => c.allDay.some((x) => x.id === 'l')).map((c) => c.day)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
    const g = monthGrid('2026-11');
    expect(g[0]![0]).toBe('2026-10-26');
    expect(g.flat()).toHaveLength(42);
  });
  it('reads datetime-local inputs as IST', () => {
    expect(fromLocalInput('2026-11-02T10:30')).toBe('2026-11-02T05:00:00.000Z');
    expect(fromLocalInput('bad')).toBeNull();
  });
});

describe('booking', () => {
  it('groups slots by IST day with wall-clock labels', () => {
    const g = groupSlots(['2026-11-02T05:00:00.000Z', '2026-11-01T18:45:00.000Z', '2026-11-02T05:40:00.000Z']);
    expect(g).toEqual([
      { day: '2026-11-02', slots: [{ iso: '2026-11-01T18:45:00.000Z', time: '00:15' }, { iso: '2026-11-02T05:00:00.000Z', time: '10:30' }, { iso: '2026-11-02T05:40:00.000Z', time: '11:10' }] },
    ]);
  });
  it('validates working hours', () => {
    expect(workingHoursErrors({ '1': [['10:00', '13:00'], ['14:00', '18:00']] })).toEqual([]);
    expect(workingHoursErrors({ '1': [['10:00', '13:00'], ['12:00', '18:00']], '2': [['15:00', '14:00']] })).toEqual(['overlap:1', 'bad_range:2']);
  });
  it('parses public routes from the hash or path', () => {
    expect(publicRoute('#/book/demo/consult')).toEqual({ kind: 'book', firm: 'demo', slug: 'consult' });
    expect(publicRoute('#/book/manage/abc?firm=demo')).toEqual({ kind: 'manage', token: 'abc' });
    expect(publicRoute('', '/book/demo/consult')).toEqual({ kind: 'book', firm: 'demo', slug: 'consult' });
    expect(publicRoute('#/booking')).toBeNull();
    expect(publicRoute('#/clients')).toBeNull();
  });
});
