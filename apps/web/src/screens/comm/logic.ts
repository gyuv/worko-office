import { renderTemplate, templateErrors, TEMPLATE_VARIABLES } from '@worko/domain';

/**
 * Phase 7 web: pure helpers for the communication hub screens (timeline, templates, broadcasts, chat, calendar, booking).
 * All day/time maths is IST (UTC+05:30, no DST); no wall clock — callers pass "now".
 */

const IST = 330 * 60_000;
const DAY = 86_400_000;

/** IST calendar day (yyyy-mm-dd) of an instant. */
export const istDay = (d: Date | string) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);
/** IST wall-clock minutes since midnight. */
export const istMinutes = (d: Date | string) => { const x = new Date(new Date(d).getTime() + IST); return x.getUTCHours() * 60 + x.getUTCMinutes(); };
/** IST HH:mm. */
export const istTime = (d: Date | string) => new Date(new Date(d).getTime() + IST).toISOString().slice(11, 16);
/** ISO instant (with +05:30 offset) for an IST day + HH:mm. */
export const istIso = (day: string, hm: string) => `${day}T${hm}:00+05:30`;
export const addDays = (day: string, k: number) => new Date(Date.parse(`${day}T00:00:00Z`) + k * DAY).toISOString().slice(0, 10);
/** 0 = Sunday … 6 = Saturday, for an IST day string. */
export const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
/** Value for an `<input type="datetime-local">` showing the IST wall clock of an instant. */
export const toLocalInput = (d: Date | string) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 16);
/** `<input type="datetime-local">` value (read as IST) → ISO instant, or null. */
export const fromLocalInput = (v: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? new Date(`${v}:00+05:30`).toISOString() : null);

// ---------- Timeline ----------

export type TimelineItem = {
  kind: 'message' | 'document' | 'invoice' | 'task'; id: string; at: string; channel: string | null; direction: string | null; title: string | null; body: string | null;
  status: string | null; address: string | null; by: string | null; callMinutes: number | null; amountPaise: number | null; broadcastId: string | null; format?: 'text' | 'html';
};
export type TimelinePage = { clientId: string; items: TimelineItem[]; nextBefore: string | null };

/** Merges keyset pages (newest first), dropping duplicates, then groups by IST day. */
export function groupTimeline(pages: TimelinePage[]): Array<{ day: string; items: TimelineItem[] }> {
  const seen = new Set<string>();
  const all: TimelineItem[] = [];
  for (const p of pages) for (const i of p.items) { const k = `${i.kind}:${i.id}`; if (!seen.has(k)) { seen.add(k); all.push(i); } }
  all.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const out: Array<{ day: string; items: TimelineItem[] }> = [];
  for (const i of all) {
    const d = istDay(i.at);
    const last = out[out.length - 1];
    if (last?.day === d) last.items.push(i); else out.push({ day: d, items: [i] });
  }
  return out;
}

/** Timeline entry → icon/label family. */
export const timelineFamily = (i: TimelineItem): string => (i.kind === 'message' ? (i.channel ?? 'note') : i.kind);

// ---------- Consent ----------

export type Consent = { id: string; channel: string; address: string; clientId: string | null; contactId: string | null; status: 'opted_in' | 'opted_out';
  optedInAt: string | null; optedInSource: string | null; optedOutAt: string | null; optedOutSource: string | null; keyword: string | null; note: string | null; updatedAt: string };

/** Same normalisation the server uses for matching: phones on the last 10 digits (India), emails lower-cased. */
export function addressKey(channel: string, raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (channel === 'email') return raw.trim().toLowerCase() || null;
  const d = raw.replace(/\D/g, '');
  if (d.length < 8) return null;
  return d.length >= 10 ? d.slice(-10) : d;
}
export type Contactish = { id: string; name: string; email?: string | null; phone?: string | null; whatsapp?: string | null };
export const contactAddress = (c: Contactish, channel: string) => (channel === 'email' ? c.email : channel === 'whatsapp' ? (c.whatsapp ?? c.phone) : c.phone) ?? null;

/** Consent state for an address on a channel: opted_in / opted_out / none (no record) / no_address. */
export function consentFor(consents: Consent[], channel: string, address: string | null): 'opted_in' | 'opted_out' | 'none' | 'no_address' {
  const k = addressKey(channel, address);
  if (!k) return 'no_address';
  const c = consents.find((x) => x.channel === channel && addressKey(channel, x.address) === k);
  return c?.status ?? 'none';
}

/** Mirrors the server's D99 policy so the composer can warn before sending (the server decides). */
export function consentBlock(state: ReturnType<typeof consentFor>, category: string, policy: { transactionalRequiresOptIn: boolean; optOutBlocksTransactional: boolean }): 'opted_out' | 'not_opted_in' | 'no_address' | null {
  if (state === 'no_address') return 'no_address';
  if (category === 'marketing') return state === 'opted_in' ? null : state === 'opted_out' ? 'opted_out' : 'not_opted_in';
  if (state === 'opted_out' && policy.optOutBlocksTransactional) return 'opted_out';
  if (state === 'none' && policy.transactionalRequiresOptIn) return 'not_opted_in';
  return null;
}

// ---------- Templates ----------

/** Sample values for live previews (never real client data). */
export const SAMPLE_VARS: Record<string, string> = {
  'client.name': 'Mehta Traders', 'contact.name': 'Rakesh Mehta', 'firm.name': 'Your firm', 'user.name': 'You', 'invoice.number': 'INV/2026-27/0042',
  'invoice.amount': '₹11,800.00', 'invoice.due_date': '15 Nov 2026', link: 'https://example.in/l/abc', due_date: '20 Nov 2026', service: 'GSTR-3B',
  period: 'Oct 2026', 'appointment.time': '12 Nov 2026, 11:00 AM', 'appointment.link': 'https://example.in/b/xyz', month: 'October 2026',
};

export type TemplateIssue = { code: 'malformed_placeholder' | 'unknown_variable' | 'forbidden_variable' | 'bad_variable' | 'subject_required' | 'body_required'; name?: string };

/** Validation (same rules as the server) plus a rendered preview with sample or given values. */
export function previewTemplate(i: { channel: string; subject: string | null; body: string; vars?: Record<string, string> }): { issues: TemplateIssue[]; subject: string | null; text: string; missing: string[] } {
  const issues: TemplateIssue[] = [];
  const parse = (e: string): TemplateIssue => { const [code, name] = e.split(':') as [TemplateIssue['code'], string | undefined]; return name ? { code, name } : { code }; };
  if (!i.body.trim()) issues.push({ code: 'body_required' });
  for (const e of templateErrors(i.body)) issues.push(parse(e));
  if (i.subject) for (const e of templateErrors(i.subject)) issues.push(parse(e));
  if (i.channel === 'email' && !i.subject?.trim()) issues.push({ code: 'subject_required' });
  const vars = { ...SAMPLE_VARS, ...(i.vars ?? {}) };
  const b = renderTemplate(i.body, vars, 'text');
  const s = i.subject ? renderTemplate(i.subject, vars, 'text') : null;
  const uniq = issues.filter((x, k) => issues.findIndex((y) => y.code === x.code && y.name === x.name) === k);
  return { issues: uniq, subject: s?.text ?? null, text: b.text, missing: [...new Set([...b.missing, ...(s?.missing ?? [])])] };
}
export const ALLOWED_VARIABLES = TEMPLATE_VARIABLES;

/** Variables the sender must supply: the template's placeholders minus those the server fills (firm, client, contact, user). */
export const AUTO_VARS = ['firm.name', 'client.name', 'contact.name', 'user.name'];
export const userVars = (variables: string[] | null | undefined) => (variables ?? []).filter((v) => !AUTO_VARS.includes(v));

// ---------- Broadcasts ----------

export type BroadcastPreview = {
  audience: number; eligible: number; optedOut: number; notOptedIn: number; noContact: number; duplicates: number; overCap: number;
  unitPaise: number; costPaise: number; capWarning: boolean; needsApproval: boolean;
  sample?: Array<{ clientId: string; clientName: string; address: string | null; status: string; reason: string | null }>;
};

/** Rows for the dry-run summary; `consistent` checks that the buckets add up to the audience. */
export function previewTotals(p: BroadcastPreview) {
  const rows = [
    ['eligible', p.eligible], ['optedOut', p.optedOut], ['notOptedIn', p.notOptedIn], ['noContact', p.noContact], ['overCap', p.overCap], ['duplicates', p.duplicates],
  ] as Array<[string, number]>;
  const skipped = p.optedOut + p.notOptedIn + p.noContact + p.overCap + p.duplicates;
  return { rows, skipped, consistent: skipped + p.eligible === p.audience, costPaise: p.costPaise, canSend: p.eligible > 0 };
}

/** Progress percentage for a broadcast detail. */
export const progressPct = (p: { total: number; done: number }) => (p.total ? Math.round((p.done / p.total) * 100) : 0);

// ---------- Chat ----------

export type ChatMessage = { id: string; channelId: string; authorId: string | null; body: string; mentions: string[]; attachmentDocIds: string[]; editedAt: string | null; createdAt: string | null; deleted?: boolean; pending?: boolean };
export type ChatMember = { id: string; channelId: string; userId: string; role: string | null; lastReadMessageId: string | null; lastReadAt: string | null; muted: boolean };

/**
 * Unread count per channel from the caller's read cursor: messages by others created after the last-read message
 * (or after `lastReadAt` when that message is not on this device). No cursor ⇒ everything by others is unread.
 */
export function unreadCounts(me: string, members: ChatMember[], messages: ChatMessage[]): Map<string, number> {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const cursor = new Map<string, number>();
  for (const m of members) {
    if (m.userId !== me) continue;
    const at = (m.lastReadMessageId && byId.get(m.lastReadMessageId)?.createdAt) || m.lastReadAt;
    cursor.set(m.channelId, at ? Date.parse(at) : -Infinity);
  }
  const out = new Map<string, number>();
  for (const [ch] of cursor) out.set(ch, 0);
  for (const m of messages) {
    if (m.deleted || m.authorId === me || !cursor.has(m.channelId) || !m.createdAt) continue;
    if (Date.parse(m.createdAt) > cursor.get(m.channelId)!) out.set(m.channelId, (out.get(m.channelId) ?? 0) + 1);
  }
  return out;
}

/** Newest-last, server time first; local unsynced rows (no createdAt) at the end. */
export const sortMessages = (ms: ChatMessage[]) => [...ms].sort((a, b) => (a.createdAt ? Date.parse(a.createdAt) : Infinity) - (b.createdAt ? Date.parse(b.createdAt) : Infinity) || (a.id < b.id ? -1 : 1));

/** The `@word` being typed right before the caret, if any. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@[\]()]{0,30})$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2]!.length - 1, query: m[2]! };
}
/** Replaces the `@query` at [start, caret) with the `@[Name](id)` token the server parses. */
export function insertMention(text: string, start: number, caret: number, user: { id: string; name: string }): { text: string; caret: number } {
  const token = `@[${user.name.replace(/[[\]()]/g, '')}](${user.id}) `;
  return { text: text.slice(0, start) + token + text.slice(caret), caret: start + token.length };
}
/** Body → plain text and mention segments for display. */
export function bodySegments(body: string): Array<{ text: string; mention?: string }> {
  const out: Array<{ text: string; mention?: string }> = [];
  const re = /@\[([^\]]{1,100})\]\(([0-9a-f-]{36})\)/gi;
  let last = 0;
  for (const m of body.matchAll(re)) {
    if (m.index! > last) out.push({ text: body.slice(last, m.index) });
    out.push({ text: `@${m[1]}`, mention: m[2]!.toLowerCase() });
    last = m.index! + m[0].length;
  }
  if (last < body.length) out.push({ text: body.slice(last) });
  return out;
}
export const filterMembers = <U extends { id: string; name: string }>(users: U[], q: string, exclude?: string) =>
  users.filter((u) => u.id !== exclude && u.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8);

// ---------- Calendar ----------

export type CalItem = { source: 'event' | 'task' | 'leave' | 'holiday'; id: string; kind: string; title: string; startsAt: string; endsAt: string; allDay: boolean; clientId: string | null; clientName: string | null; editable: boolean; invited?: boolean };

/** Monday of the IST week containing `day`. */
export const weekStart = (day: string) => addDays(day, -((weekday(day) + 6) % 7));
export const weekDays = (day: string) => Array.from({ length: 7 }, (_, k) => addDays(weekStart(day), k));

export type Placed = CalItem & { top: number; height: number; lane: number; lanes: number };
/**
 * Week grid: per day, all-day items (spanning every day they cover) and timed items positioned in minutes from IST
 * midnight, with overlapping items split into side-by-side lanes.
 */
export function layoutWeek(items: CalItem[], days: string[]): Array<{ day: string; allDay: CalItem[]; timed: Placed[] }> {
  return days.map((day) => {
    const allDay: CalItem[] = [];
    const timed: Array<CalItem & { top: number; height: number }> = [];
    for (const i of items) {
      const s = istDay(i.startsAt); const e = istDay(i.endsAt);
      if (i.allDay || s !== e) { if (s <= day && day <= e) allDay.push(i); continue; }
      if (s !== day) continue;
      const top = istMinutes(i.startsAt);
      timed.push({ ...i, top, height: Math.max(15, Math.round((Date.parse(i.endsAt) - Date.parse(i.startsAt)) / 60_000)) });
    }
    timed.sort((a, b) => a.top - b.top || b.height - a.height);
    // Cluster overlapping runs; within a cluster, first free lane.
    const placed: Placed[] = [];
    let cluster: Array<CalItem & { top: number; height: number; lane: number }> = [];
    let clusterEnd = -1;
    const flush = () => { const n = Math.max(1, ...cluster.map((c) => c.lane + 1)); for (const c of cluster) placed.push({ ...c, lanes: n }); cluster = []; };
    for (const it of timed) {
      if (it.top >= clusterEnd) { flush(); clusterEnd = -1; }
      const busy = new Set(cluster.filter((c) => c.top + c.height > it.top).map((c) => c.lane));
      let lane = 0; while (busy.has(lane)) lane++;
      cluster.push({ ...it, lane });
      clusterEnd = Math.max(clusterEnd, it.top + it.height);
    }
    flush();
    return { day, allDay, timed: placed };
  });
}

/** 6×7 month grid (Monday first) for `month` = yyyy-mm. */
export function monthGrid(month: string): string[][] {
  const first = weekStart(`${month}-01`);
  return Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(first, w * 7 + d)));
}
export const itemsOnDay = (items: CalItem[], day: string) => items.filter((i) => istDay(i.startsAt) <= day && day <= istDay(i.endsAt));

// ---------- Booking ----------

/** Slots grouped by IST day, each with its HH:mm label. */
export function groupSlots(slots: string[]): Array<{ day: string; slots: Array<{ iso: string; time: string }> }> {
  const out: Array<{ day: string; slots: Array<{ iso: string; time: string }> }> = [];
  for (const s of [...slots].sort((a, b) => Date.parse(a) - Date.parse(b))) {
    const d = istDay(s);
    const last = out[out.length - 1];
    const x = { iso: new Date(s).toISOString(), time: istTime(s) };
    if (last?.day === d) last.slots.push(x); else out.push({ day: d, slots: [x] });
  }
  return out;
}

export type WorkingHours = Partial<Record<'0' | '1' | '2' | '3' | '4' | '5' | '6', Array<[string, string]>>>;
/** Validates a working-hours map: HH:mm ranges with start < end, non-overlapping per day. */
export function workingHoursErrors(wh: WorkingHours): string[] {
  const errs: string[] = [];
  for (const [d, ranges] of Object.entries(wh)) {
    const sorted = [...(ranges ?? [])].sort((a, b) => a[0].localeCompare(b[0]));
    sorted.forEach(([s, e], k) => {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(e) || s >= e) errs.push(`bad_range:${d}`);
      else if (k > 0 && sorted[k - 1]![1] > s) errs.push(`overlap:${d}`);
    });
  }
  return [...new Set(errs)];
}

/** Public booking route: `#/book/{firm}/{slug}` or `#/book/manage/{token}` (also as a plain path). */
export function publicRoute(hash: string, pathname = ''): { kind: 'book'; firm: string; slug: string } | { kind: 'manage'; token: string } | null {
  const src = /^#\/?book\//.test(hash) ? hash.replace(/^#\/?/, '') : pathname.replace(/^\/+/, '');
  const parts = src.split('?')[0]!.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  if (parts[0] !== 'book') return null;
  if (parts[1] === 'manage' && parts[2]) return { kind: 'manage', token: parts[2] };
  if (parts[1] && parts[2] && parts[1] !== 'manage') return { kind: 'book', firm: parts[1], slug: parts[2] };
  return null;
}
