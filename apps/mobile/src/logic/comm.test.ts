import type { LocalRow } from '@worko/sync';
import { describe, expect, it } from 'vitest';
import {
  activeMentionQuery, buildEventPatch, canEditMessage, channelSummaries, commErrorKey, decodeMentions, encodeMentions, eventDays, extractMentions, formFromEvent,
  groupAgenda, groupByDay, insertMention, isOwnEditable, markReadPatch, mentionCandidates, missingVars, toChannel, toEvent, toMember, toMessage, totalUnread,
  validateMessage, type EventForm,
} from './comm';

const ME = '00000000-0000-4000-8000-000000000001';
const BOB = '00000000-0000-4000-8000-000000000002';
const EVE = '00000000-0000-4000-8000-000000000003';
const row = (table: string, id: string, fields: Record<string, unknown>, deleted = false): LocalRow => ({ table, id, version: 1, deleted, fields });
const ch = (id: string, f: Record<string, unknown> = {}) => toChannel(row('chat_channel', id, { kind: 'group', name: id, ...f }));
const mem = (id: string, channel: string, user: string, f: Record<string, unknown> = {}) => toMember(row('chat_member', id, { channel_id: channel, user_id: user, ...f }));
const msg = (id: string, channel: string, author: string, at: string, f: Record<string, unknown> = {}, deleted = false) =>
  toMessage(row('chat_message', id, { channel_id: channel, author_id: author, created_at: at, body: 'hi', ...f }, deleted));

describe('unread counts from synced read cursors', () => {
  const channels = [ch('a'), ch('b'), ch('c'), ch('notmine')];
  const members = [
    mem('ma', 'a', ME, { last_read_message_id: 'a2' }), mem('mb', 'b', ME), mem('mc', 'c', ME, { muted: true, last_read_at: '2026-10-28T05:00:00Z' }),
    mem('mx', 'notmine', BOB),
  ];
  const messages = [
    msg('a1', 'a', BOB, '2026-10-28T04:00:00Z'), msg('a2', 'a', BOB, '2026-10-28T04:05:00Z'), msg('a3', 'a', BOB, '2026-10-28T04:10:00Z', { mentions: [ME] }),
    msg('a4', 'a', ME, '2026-10-28T04:11:00Z'), msg('a5', 'a', BOB, '2026-10-28T04:12:00Z', {}, true),
    msg('b1', 'b', BOB, '2026-10-27T04:00:00Z'), msg('b2', 'b', EVE, '2026-10-27T05:00:00Z'),
    msg('c1', 'c', BOB, '2026-10-28T04:59:00Z'), msg('c2', 'c', BOB, '2026-10-28T05:30:00Z'),
  ];
  const s = channelSummaries(channels, members, messages, ME);
  const by = Object.fromEntries(s.map((x) => [x.id, x]));
  it('counts others\' messages after the cursor, skipping own and deleted', () => {
    expect(by.a!.unread).toBe(1); expect(by.a!.mentioned).toBe(true);
    expect(by.b!.unread).toBe(2); // no cursor = all unread
    expect(by.c!.unread).toBe(1); expect(by.c!.muted).toBe(true);
    expect(by.notmine).toBeUndefined(); // not a member
  });
  it('sorts by latest activity and totals excluding muted-without-mention', () => {
    expect(s.map((x) => x.id)).toEqual(['c', 'a', 'b']);
    expect(by.a!.last!.id).toBe('a4');
    expect(totalUnread(s)).toBe(3);
  });
  it('mark-read moves my cursor to the newest message only when it advances', () => {
    const now = new Date('2026-10-28T06:00:00Z');
    expect(markReadPatch(members[0], messages, now)).toEqual({ last_read_message_id: 'a4', last_read_at: now.toISOString() });
    expect(markReadPatch(mem('ma', 'a', ME, { last_read_message_id: 'a4' }), messages, now)).toBeNull();
    expect(markReadPatch(undefined, messages, now)).toBeNull();
  });
});

describe('mentions', () => {
  const body = `hi @[Bob K](${BOB}) and @[Eve](${EVE.toUpperCase()}) and again @[Bob K](${BOB})`;
  it('extracts unique lower-cased ids', () => expect(extractMentions(body)).toEqual([BOB, EVE]));
  it('validates mentions ⊆ members, length and emptiness', () => {
    expect(validateMessage(body, [ME, BOB])).toEqual({ ok: false, error: 'm.chat.err.mention' });
    expect(validateMessage(body, [ME, BOB, EVE])).toMatchObject({ ok: true, mentions: [BOB, EVE] });
    expect(validateMessage('   ', [ME])).toEqual({ ok: false, error: 'm.chat.err.empty' });
    expect(validateMessage('', [ME], 4000, 1)).toMatchObject({ ok: true });
    expect(validateMessage('x'.repeat(4001), [ME])).toEqual({ ok: false, error: 'm.chat.err.tooLong' });
  });
  it('picker: active query, candidates, insert + encode/decode round trip', () => {
    expect(activeMentionQuery('hello @bo')).toBe('bo');
    expect(activeMentionQuery('hello@bo')).toBeNull();
    expect(activeMentionQuery('hello @')).toBe('');
    expect(activeMentionQuery('done @bob ')).toBeNull();
    const people = [{ id: ME, name: 'Me' }, { id: BOB, name: 'Bob K' }, { id: EVE, name: 'Eve Bobson' }];
    expect(mentionCandidates(people, 'bo', ME).map((p) => p.id)).toEqual([BOB, EVE]);
    const d = insertMention('ping @bo', 'Bob K');
    expect(d).toBe('ping @Bob K ');
    const enc = encodeMentions(d + 'now', [{ id: BOB, name: 'Bob K' }]);
    expect(enc).toBe(`ping @[Bob K](${BOB}) now`);
    expect(decodeMentions(enc)).toEqual({ draft: 'ping @Bob K now', picked: [{ id: BOB, name: 'Bob K' }] });
  });
});

describe('edit window (injected now)', () => {
  const m = msg('m', 'a', ME, '2026-10-28T04:00:00Z');
  it('author only, within 15 minutes, not deleted', () => {
    expect(canEditMessage(m, ME, new Date('2026-10-28T04:15:00Z'))).toBe(true);
    expect(canEditMessage(m, ME, new Date('2026-10-28T04:15:01Z'))).toBe(false);
    expect(canEditMessage(m, BOB, new Date('2026-10-28T04:01:00Z'))).toBe(false);
    expect(canEditMessage({ ...m, deleted: true }, ME, new Date('2026-10-28T04:01:00Z'))).toBe(false);
    expect(canEditMessage(m, ME, new Date('2026-10-28T04:25:00Z'), 30)).toBe(true);
  });
});

describe('grouping by IST day', () => {
  it('messages split at IST midnight (18:30 UTC)', () => {
    const g = groupByDay([msg('2', 'a', BOB, '2026-10-27T18:30:00Z'), msg('1', 'a', BOB, '2026-10-27T18:29:59Z'), msg('3', 'a', BOB, '2026-10-28T10:00:00Z')]);
    expect(g.map((x) => [x.day, x.data.map((m) => m.id)])).toEqual([['2026-10-27', ['1']], ['2026-10-28', ['2', '3']]]);
  });
  const ev = (id: string, s: string, e: string, f: Record<string, unknown> = {}) => toEvent(row('calendar_event', id, { owner_id: ME, kind: 'meeting', title: id, starts_at: s, ends_at: e, ...f }));
  it('events span every IST day they cover; midnight end does not spill; all-day first', () => {
    const es = [
      ev('late', '2026-10-28T17:00:00Z', '2026-10-28T19:00:00Z'), // 22:30–00:30 IST → 28 and 29
      ev('allday', '2026-10-28T00:00:00+05:30', '2026-10-29T00:00:00+05:30', { all_day: true }), // only 28
      ev('morning', '2026-10-28T04:00:00Z', '2026-10-28T05:00:00Z'),
      ev('outside', '2026-11-20T04:00:00Z', '2026-11-20T05:00:00Z'),
      ev('before', '2026-10-20T04:00:00Z', '2026-10-30T05:00:00Z'), // multi-day, clipped to range
    ];
    expect(eventDays(es[1]!)).toEqual(['2026-10-28', '2026-10-28']);
    const g = groupAgenda(es, '2026-10-28', 3);
    expect(g.map((x) => [x.day, x.data.map((e) => e.id)])).toEqual([
      ['2026-10-28', ['allday', 'before', 'morning', 'late']], ['2026-10-29', ['before', 'late']], ['2026-10-30', ['before']],
    ]);
    expect(groupAgenda(es, '2026-10-29', 1).map((x) => x.day)).toEqual(['2026-10-29']);
  });
});

describe('calendar form', () => {
  const f: EventForm = { kind: 'meeting', title: ' Review ', date: '2026-10-28', start: '10:00', end: '11:30', allDay: false, location: '', description: '', attendeeIds: [BOB, BOB] };
  it('builds IST-offset instants and validates', () => {
    const r = buildEventPatch(f);
    expect(r).toMatchObject({ ok: true, patch: { title: 'Review', starts_at: '2026-10-28T10:00:00+05:30', ends_at: '2026-10-28T11:30:00+05:30', attendee_ids: [BOB], location: null } });
    expect(buildEventPatch({ ...f, end: '09:00' })).toEqual({ ok: false, error: 'm.cal.err.order' });
    expect(buildEventPatch({ ...f, title: '' })).toEqual({ ok: false, error: 'm.cal.err.title' });
    expect(buildEventPatch({ ...f, start: '25:00' })).toEqual({ ok: false, error: 'm.cal.err.time' });
    expect(buildEventPatch({ ...f, allDay: true })).toMatchObject({ ok: true, patch: { starts_at: '2026-10-28T00:00:00+05:30', ends_at: '2026-10-29T00:00:00+05:30' } });
  });
  it('round trips from a synced event and gates editing to own meeting/personal', () => {
    const e = toEvent(row('calendar_event', 'x', { owner_id: ME, kind: 'meeting', title: 'T', starts_at: '2026-10-28T04:30:00Z', ends_at: '2026-10-28T05:00:00Z', attendee_ids: `{${BOB}}` }));
    expect(formFromEvent(e)).toMatchObject({ date: '2026-10-28', start: '10:00', end: '10:30', attendeeIds: [BOB] });
    expect(isOwnEditable(e, ME)).toBe(true);
    expect(isOwnEditable(e, BOB)).toBe(false);
    expect(isOwnEditable({ ...e, kind: 'appointment' }, ME)).toBe(false);
  });
});

describe('client communication', () => {
  it('maps consent/cap refusals to reasons', () => {
    expect(commErrorKey('opted_out')).toBe('m.comm.err.opted_out');
    expect(commErrorKey('not_opted_in')).toBe('m.comm.err.not_opted_in');
    expect(commErrorKey(undefined)).toBe('m.comm.err.failed');
    expect(missingVars(['name', 'due'], { name: 'A', due: ' ' })).toEqual(['due']);
  });
});
