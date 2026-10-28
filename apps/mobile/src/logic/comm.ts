import { addDaysIso, mentionsOf, withinEditWindow } from '@worko/domain';
import type { MessageKey } from '@worko/i18n';
import type { LocalRow } from '@worko/sync';
import { todayIST } from './registers';

/**
 * Phase 7 on the phone (D106/D107): team chat from the synced store (channels/members read-only, own read cursor + mute
 * writable, messages pushed through the outbox), calendar events (own meetings/personal editable offline).
 * Pure — callers inject "now" and the synced rows. All day boundaries are IST.
 */

export const EDIT_WINDOW_MIN = 15; // chat.editWindowMinutes default (D106); the server re-checks
export const MAX_LENGTH = 4000; // chat.maxLength default

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.startsWith('{') ? v.slice(1, -1).split(',').filter(Boolean) : []);
const ts = (v: unknown) => { const n = Date.parse(String(v ?? '')); return Number.isFinite(n) ? n : 0; };

/** IST calendar day (YYYY-MM-DD) of an instant. */
export const istDay = (iso: string) => todayIST(new Date(iso));
/** IST wall-clock HH:MM of an instant. */
export const istTime = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(11, 16);
/** An IST date + HH:MM as an ISO instant with offset (what the server stores as timestamptz). */
export const istInstant = (date: string, time: string) => `${date}T${time}:00+05:30`;

// ---------- chat ----------

export type ChannelItem = { id: string; kind: string; name: string; clientId: string | null; archived: boolean };
export type MemberItem = { id: string; channelId: string; userId: string; role: string; lastReadMessageId: string | null; lastReadAt: string | null; muted: boolean };
export type MessageItem = {
  id: string; channelId: string; authorId: string; body: string; mentions: string[]; attachments: string[]; editedAt: string | null; createdAt: string; deleted: boolean;
};

export const toChannel = (r: LocalRow): ChannelItem => ({
  id: r.id, kind: String(r.fields.kind ?? 'group'), name: String(r.fields.name ?? ''), clientId: str(r.fields.client_id), archived: !!r.fields.archived,
});
export const toMember = (r: LocalRow): MemberItem => ({
  id: r.id, channelId: String(r.fields.channel_id ?? ''), userId: String(r.fields.user_id ?? ''), role: String(r.fields.role ?? 'member'),
  lastReadMessageId: str(r.fields.last_read_message_id), lastReadAt: str(r.fields.last_read_at), muted: !!r.fields.muted,
});
export const toMessage = (r: LocalRow): MessageItem => ({
  id: r.id, channelId: String(r.fields.channel_id ?? ''), authorId: String(r.fields.author_id ?? ''), body: String(r.fields.body ?? ''),
  mentions: arr(r.fields.mentions), attachments: arr(r.fields.attachment_doc_ids), editedAt: str(r.fields.edited_at),
  createdAt: str(r.fields.created_at) ?? new Date(0).toISOString(), deleted: r.deleted,
});

/** Oldest first; ties broken by id so the order is stable across devices. */
export const sortMessages = (ms: MessageItem[]) => [...ms].sort((a, b) => ts(a.createdAt) - ts(b.createdAt) || a.id.localeCompare(b.id));

/** The instant up to which I've read a channel: the cursor message's time, else last_read_at, else never. */
function readUpTo(me: MemberItem | undefined, byId: Map<string, MessageItem>): number {
  if (!me) return Number.POSITIVE_INFINITY; // not a member: nothing counts
  const m = me.lastReadMessageId ? byId.get(me.lastReadMessageId) : undefined;
  return Math.max(m ? ts(m.createdAt) : 0, me.lastReadAt ? ts(me.lastReadAt) : 0);
}

export type ChannelSummary = ChannelItem & { unread: number; mentioned: boolean; muted: boolean; last: MessageItem | null };

/** Channel list with unread counts from my synced read cursor (others' messages after it; deleted ones excluded). */
export function channelSummaries(channels: ChannelItem[], members: MemberItem[], messages: MessageItem[], userId: string): ChannelSummary[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const mine = new Map(members.filter((m) => m.userId === userId).map((m) => [m.channelId, m]));
  const byChannel = new Map<string, MessageItem[]>();
  for (const m of messages) if (!m.deleted) (byChannel.get(m.channelId) ?? byChannel.set(m.channelId, []).get(m.channelId)!).push(m);
  return channels.filter((c) => mine.has(c.id)).map((c) => {
    const me = mine.get(c.id);
    const upTo = readUpTo(me, byId);
    const list = sortMessages(byChannel.get(c.id) ?? []);
    const fresh = list.filter((m) => m.authorId !== userId && ts(m.createdAt) > upTo);
    return { ...c, unread: fresh.length, mentioned: fresh.some((m) => m.mentions.includes(userId)), muted: !!me?.muted, last: list[list.length - 1] ?? null };
  }).sort((a, b) => Number(a.archived) - Number(b.archived) || ts(b.last?.createdAt) - ts(a.last?.createdAt) || a.name.localeCompare(b.name));
}

/** Total unread across channels, muted ones excluded unless I was mentioned. */
export const totalUnread = (s: ChannelSummary[]) => s.reduce((n, c) => n + (c.muted && !c.mentioned ? 0 : c.unread), 0);

/** Patch for my chat_member row when the newest message is visible; null when the cursor would not move forward. */
export function markReadPatch(me: MemberItem | undefined, messages: MessageItem[], now: Date): { last_read_message_id: string; last_read_at: string } | null {
  if (!me) return null;
  const list = sortMessages(messages.filter((m) => m.channelId === me.channelId && !m.deleted));
  const last = list[list.length - 1];
  if (!last || last.id === me.lastReadMessageId) return null;
  const byId = new Map(list.map((m) => [m.id, m]));
  if (ts(last.createdAt) <= readUpTo(me, byId) && me.lastReadMessageId) return null;
  return { last_read_message_id: last.id, last_read_at: now.toISOString() };
}

// ---- mentions: the body carries `@[name](userId)` tokens (D106); the server derives mentions from them too ----

export const mentionToken = (name: string, id: string) => `@[${name.replace(/[[\]()]/g, '').slice(0, 100)}](${id})`;
/** Mentioned user ids in a body (lower-cased, de-duplicated). */
export const extractMentions = (body: string) => mentionsOf(body);

/** Splits a body into plain text and mention parts for rendering. */
export function bodyParts(body: string): Array<{ text: string; userId?: string }> {
  const out: Array<{ text: string; userId?: string }> = [];
  let i = 0;
  for (const m of body.matchAll(/@\[([^\]]{1,100})\]\(([0-9a-f-]{36})\)/gi)) {
    if (m.index! > i) out.push({ text: body.slice(i, m.index) });
    out.push({ text: '@' + m[1]!, userId: m[2]!.toLowerCase() });
    i = m.index! + m[0].length;
  }
  if (i < body.length) out.push({ text: body.slice(i) });
  return out;
}

/** Names learned from mention tokens (fallback directory when the user list is not available). */
export function namesFromBodies(bodies: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of bodies) for (const p of bodyParts(b)) if (p.userId) out.set(p.userId, p.text.slice(1));
  return out;
}

/** The `@query` being typed at the end of the draft, or null. */
export function activeMentionQuery(draft: string): string | null {
  const m = /(?:^|\s)@([^\s@[\]()]{0,30})$/.exec(draft);
  return m ? m[1]! : null;
}

/** Replaces the trailing `@query` with `@Name ` (the composer shows names; tokens are added on send). */
export function insertMention(draft: string, name: string): string {
  return draft.replace(/@([^\s@[\]()]{0,30})$/, `@${name} `);
}

/** Turns picked `@Name` mentions still present in the draft into `@[Name](id)` tokens (first occurrence each). */
export function encodeMentions(draft: string, picked: Person[]): string {
  let out = draft;
  for (const p of picked) {
    const at = `@${p.name}`;
    const i = out.indexOf(at);
    if (i >= 0) out = out.slice(0, i) + mentionToken(p.name, p.id) + out.slice(i + at.length);
  }
  return out;
}

/** The inverse, for editing: tokens back to `@Name` plus the picked list. */
export function decodeMentions(body: string): { draft: string; picked: Person[] } {
  const picked: Person[] = [];
  const draft = bodyParts(body).map((p) => { if (p.userId) picked.push({ id: p.userId, name: p.text.slice(1) }); return p.text; }).join('');
  return { draft, picked };
}

export type Person = { id: string; name: string };
/** Channel members (not me) matching the typed query, by name prefix then substring. */
export function mentionCandidates(members: Person[], query: string, userId: string, limit = 6): Person[] {
  const q = query.trim().toLowerCase();
  return members.filter((m) => m.id !== userId && (!q || m.name.toLowerCase().includes(q)))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name)).slice(0, limit);
}

export type SendCheck = { ok: true; body: string; mentions: string[] } | { ok: false; error: MessageKey };
/** Mirrors the server's device-push validation: non-empty, max length, mentions ⊆ channel members. */
export function validateMessage(body: string, memberIds: string[], maxLength = MAX_LENGTH, attachments = 0): SendCheck {
  const b = body.trim();
  if (!b && !attachments) return { ok: false, error: 'm.chat.err.empty' };
  if (b.length > maxLength) return { ok: false, error: 'm.chat.err.tooLong' };
  const ids = new Set(memberIds.map((x) => x.toLowerCase()));
  const mentions = extractMentions(b);
  if (mentions.some((u) => !ids.has(u))) return { ok: false, error: 'm.chat.err.mention' };
  return { ok: true, body: b, mentions };
}

/** Own, not deleted, and still inside the edit window (now injected). */
export const canEditMessage = (m: MessageItem, userId: string, now: Date, windowMinutes = EDIT_WINDOW_MIN) =>
  m.authorId === userId && !m.deleted && withinEditWindow(new Date(m.createdAt), now, windowMinutes);

export type DaySection<T> = { day: string; data: T[] };
/** Messages grouped by IST day, oldest day first. */
export function groupByDay(ms: MessageItem[]): Array<DaySection<MessageItem>> {
  const out: Array<DaySection<MessageItem>> = [];
  for (const m of sortMessages(ms)) {
    const d = istDay(m.createdAt);
    const last = out[out.length - 1];
    if (last?.day === d) last.data.push(m); else out.push({ day: d, data: [m] });
  }
  return out;
}

// ---------- calendar ----------

export type EventKind = 'meeting' | 'personal' | 'appointment' | 'external';
export type EventItem = {
  id: string; ownerId: string; kind: EventKind; title: string; description: string; location: string; startsAt: string; endsAt: string;
  allDay: boolean; clientId: string | null; attendeeIds: string[]; busy: boolean;
};
export function toEvent(r: LocalRow): EventItem {
  const f = r.fields;
  const kind = (['meeting', 'personal', 'appointment', 'external'] as const).find((k) => k === f.kind) ?? 'meeting';
  return {
    id: r.id, ownerId: String(f.owner_id ?? ''), kind, title: String(f.title ?? ''), description: String(f.description ?? ''), location: String(f.location ?? ''),
    startsAt: String(f.starts_at ?? ''), endsAt: String(f.ends_at ?? f.starts_at ?? ''), allDay: !!f.all_day, clientId: str(f.client_id),
    attendeeIds: arr(f.attendee_ids), busy: f.busy !== false,
  };
}
/** Devices may edit only their own meetings/personal events (appointment/external are read-only, D107). */
export const isOwnEditable = (e: Pick<EventItem, 'ownerId' | 'kind'>, userId: string) => e.ownerId === userId && (e.kind === 'meeting' || e.kind === 'personal');

/** IST days [first, last] an event covers. An end exactly at IST midnight does not spill into the next day. */
export function eventDays(e: Pick<EventItem, 'startsAt' | 'endsAt'>): [string, string] {
  const s = Date.parse(e.startsAt); const en = Math.max(s, Date.parse(e.endsAt));
  const first = istDay(new Date(s).toISOString());
  const last = en > s ? istDay(new Date(en - 1).toISOString()) : first;
  return [first, last];
}

/** Agenda for `days` IST days from `from`: an event appears on every day it covers; all-day first, then by start. Empty days omitted. */
export function groupAgenda(events: EventItem[], from: string, days: number): Array<DaySection<EventItem>> {
  const to = addDaysIso(from, days - 1);
  const map = new Map<string, EventItem[]>();
  for (const e of events) {
    if (!e.startsAt || !Number.isFinite(Date.parse(e.startsAt))) continue;
    const [a, b] = eventDays(e);
    for (let d = a < from ? from : a; d <= b && d <= to; d = addDaysIso(d, 1)) (map.get(d) ?? map.set(d, []).get(d)!).push(e);
  }
  return [...map.keys()].sort().map((day) => ({
    day, data: map.get(day)!.sort((x, y) => Number(y.allDay) - Number(x.allDay) || Date.parse(x.startsAt) - Date.parse(y.startsAt) || x.title.localeCompare(y.title)),
  }));
}

export type EventForm = { kind: 'meeting' | 'personal'; title: string; date: string; start: string; end: string; allDay: boolean; location: string; description: string; attendeeIds: string[] };
export type EventCheck = { ok: true; patch: Record<string, unknown> } | { ok: false; error: MessageKey };
const DATE = /^\d{4}-\d{2}-\d{2}$/; const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Builds the synced calendar_event patch (IST inputs → offset instants), validated like the server (end ≥ start, ≤ 31 days). */
export function buildEventPatch(f: EventForm): EventCheck {
  if (!f.title.trim()) return { ok: false, error: 'm.cal.err.title' };
  if (!DATE.test(f.date)) return { ok: false, error: 'm.cal.err.date' };
  let startsAt: string; let endsAt: string;
  if (f.allDay) { startsAt = istInstant(f.date, '00:00'); endsAt = istInstant(addDaysIso(f.date, 1), '00:00'); }
  else {
    if (!TIME.test(f.start) || !TIME.test(f.end)) return { ok: false, error: 'm.cal.err.time' };
    startsAt = istInstant(f.date, f.start); endsAt = istInstant(f.date, f.end);
    if (Date.parse(endsAt) <= Date.parse(startsAt)) return { ok: false, error: 'm.cal.err.order' };
  }
  return {
    ok: true,
    patch: {
      kind: f.kind, title: f.title.trim().slice(0, 300), starts_at: startsAt, ends_at: endsAt, all_day: f.allDay,
      location: f.location.trim() || null, description: f.description.trim() || null, attendee_ids: [...new Set(f.attendeeIds)].slice(0, 50), busy: f.kind === 'meeting' || !f.allDay,
    },
  };
}
export function formFromEvent(e: EventItem): EventForm {
  const kind = e.kind === 'personal' ? 'personal' : 'meeting';
  return {
    kind, title: e.title, date: istDay(e.startsAt), start: istTime(e.startsAt), end: istTime(e.endsAt), allDay: e.allDay,
    location: e.location, description: e.description, attendeeIds: e.attendeeIds,
  };
}

// ---------- client communication (REST) ----------

/** 409 codes from POST /comm/messages → user-facing reason. */
export function commErrorKey(code: string | undefined): MessageKey {
  switch (code) {
    case 'opted_out': return 'm.comm.err.opted_out';
    case 'not_opted_in': return 'm.comm.err.not_opted_in';
    case 'over_cap': return 'm.comm.err.over_cap';
    case 'template_required': return 'm.comm.err.template_required';
    case 'template_not_approved': return 'm.comm.err.template_not_approved';
    case 'no_address': return 'm.comm.err.no_address';
    default: return 'm.comm.err.failed';
  }
}

/** Template variables still empty (sending is blocked until all are filled). */
export const missingVars = (vars: string[], values: Record<string, string>) => vars.filter((v) => !values[v]?.trim());
