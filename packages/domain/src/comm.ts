import { z } from 'zod';

/**
 * Phase 7 (M13 communication hub) pure rules: phone/email normalisation, STOP keywords, template placeholders and
 * rendering, rate/cap maths, booking-slot availability and ICS generation. No I/O, no wall clock — callers pass "now".
 */

export const COMM_CHANNELS = ['email', 'whatsapp', 'sms'] as const;
export type CommChannel = (typeof COMM_CHANNELS)[number];
/** Timeline entry kinds: the three messaging channels plus manually logged notes and calls. */
export const TIMELINE_CHANNELS = [...COMM_CHANNELS, 'note', 'call', 'portal'] as const;
export const TEMPLATE_CATEGORIES = ['transactional', 'utility', 'marketing'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export const TEMPLATE_STATUSES = ['draft', 'submitted', 'approved', 'rejected'] as const;
export const BROADCAST_STATUSES = ['draft', 'pending_approval', 'approved', 'scheduled', 'sending', 'completed', 'cancelled'] as const;
export const RECIPIENT_STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped_optout', 'skipped_nocontact', 'skipped_cap', 'cancelled'] as const;
export const CHAT_CHANNEL_KINDS = ['team', 'branch', 'direct', 'client', 'group'] as const;

// ---------- Firm communication settings (data; defaults are firm-editable policy, not statutory) ----------

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const capPaise = z.number().int().min(0).max(1e12).nullable();
export const commSettingsSchema = z.object({
  consent: z.object({
    /** Transactional/utility messages need an explicit opt-in too (default: no — an existing client relationship suffices). */
    transactionalRequiresOptIn: z.boolean().default(false),
    /** A STOP/opt-out also blocks transactional messages (default: yes — the client asked us to stop). */
    optOutBlocksTransactional: z.boolean().default(true),
  }).default({}),
  /** Client-facing quiet hours (IST); `appliesTo` all categories or only marketing. */
  quietHours: z.object({ start: hhmm, end: hhmm, appliesTo: z.enum(['all', 'marketing']).default('all') }).nullable()
    .default({ start: '21:00', end: '08:00', appliesTo: 'all' }),
  caps: z.object({
    monthlyPaise: z.object({ email: capPaise.default(null), whatsapp: capPaise.default(null), sms: capPaise.default(null) }).default({}),
    perBroadcastPaise: capPaise.default(null),
    /** Past a cap: refuse the send, or send and flag it. */
    mode: z.enum(['block', 'warn']).default('block'),
  }).default({}),
  broadcast: z.object({
    /** Marketing broadcasts with more eligible recipients than this need communication:approve by someone else. */
    approvalThreshold: z.number().int().min(0).max(1_000_000).default(50),
    batchSize: z.number().int().min(1).max(1000).default(50),
    /** Seconds between batches (provider rate limits). */
    batchIntervalSeconds: z.number().int().min(0).max(3600).default(60),
  }).default({}),
  chat: z.object({
    editWindowMinutes: z.number().int().min(0).max(10_080).default(15),
    maxLength: z.number().int().min(100).max(10_000).default(4000),
  }).default({}),
  /** Inbound webhook binding: provider → the firm's account id (WhatsApp phone_number_id). Events for other accounts are rejected (Meta: required). */
  providers: z.object({ inboundAccounts: z.record(z.enum(['mock', 'meta']), z.string().max(64)).default({}) }).default({}),
  appointments: z.object({ reminderMinutesBefore: z.array(z.number().int().min(5).max(10_080)).max(3).default([1440, 60]) }).default({}),
});
export type CommSettings = z.infer<typeof commSettingsSchema>;
export const defaultCommSettings = (): CommSettings => commSettingsSchema.parse({});

// ---------- Addresses ----------

/**
 * Normalise a phone number to E.164. Indian numbers (10 digits starting 6–9, optionally prefixed by 0, 91 or +91)
 * become `+91XXXXXXXXXX`; other numbers must carry an explicit `+` country code (8–15 digits). Null when invalid.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!/^[+\d\s().-]+$/.test(s)) return null;
  const plus = s.startsWith('+') || s.startsWith('00');
  let d = s.replace(/\D/g, '');
  if (s.startsWith('00')) d = d.slice(2);
  if (!plus) {
    if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null;
  }
  if (d.startsWith('91')) return /^91[6-9]\d{9}$/.test(d) ? `+${d}` : null;
  return /^[1-9]\d{7,14}$/.test(d) ? `+${d}` : null;
}
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  return /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/.test(s) && s.length <= 254 ? s : null;
}
export const normalizeAddress = (channel: CommChannel, raw: string | null | undefined) => (channel === 'email' ? normalizeEmail(raw) : normalizePhone(raw));
/** For logs/UI lists: recognisable, not harvestable. */
export const maskAddress = (s: string) => (s.includes('@') ? s.replace(/^(.).*(@.*)$/, '$1•••$2') : s.replace(/.(?=.{4})/g, '•'));

// ---------- STOP / START keywords (inbound WhatsApp/SMS) ----------

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'BAND', 'BANDKARO']);
const START_WORDS = new Set(['START', 'UNSTOP', 'SUBSCRIBE', 'OPTIN']);
/**
 * Whole-message keyword match only ("stop", " STOP. ", "opt-out", "Stop all"); a sentence that merely contains
 * the word ("please don't stop the filing") is not an opt-out. // VERIFY AGAINST OFFICIAL DOCS (TRAI/DLT keyword list).
 */
export function parseKeyword(text: string | null | undefined): 'stop' | 'start' | null {
  if (!text) return null;
  const w = text.normalize('NFKC').toUpperCase().replace(/[^A-Z]/g, '');
  if (!w || text.trim().split(/\s+/).length > 2) return null;
  if (STOP_WORDS.has(w)) return 'stop';
  if (START_WORDS.has(w)) return 'start';
  return null;
}

// ---------- Templates ----------

/** Variables a template may use. Secrets, credentials, OTPs and identifiers (PAN/Aadhaar) are never interpolatable. */
export const TEMPLATE_VARIABLES = [
  'client.name', 'contact.name', 'firm.name', 'user.name', 'invoice.number', 'invoice.amount', 'invoice.due_date', 'link',
  'due_date', 'service', 'period', 'appointment.time', 'appointment.link', 'month',
] as const;
const FORBIDDEN_VAR = /pass|secret|token|otp|pin|pan|aadhaar|cvv|key|credential/i;
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

export function placeholdersOf(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

/** Returns problems with a template body (empty = valid). */
export function templateErrors(body: string, allowed: readonly string[] = TEMPLATE_VARIABLES): string[] {
  const errs: string[] = [];
  const stripped = body.replace(PLACEHOLDER, '');
  if (stripped.includes('{{') || stripped.includes('}}')) errs.push('malformed_placeholder');
  for (const v of placeholdersOf(body)) {
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/.test(v)) errs.push(`bad_variable:${v}`);
    else if (FORBIDDEN_VAR.test(v)) errs.push(`forbidden_variable:${v}`);
    else if (!allowed.includes(v)) errs.push(`unknown_variable:${v}`);
  }
  return errs;
}

const HTML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESC[c]!);
/** Plain-text channels: no control characters, no new placeholders smuggled in through values, bounded length. */
const plainValue = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\{\{|\}\}/g, '').slice(0, 500);

/**
 * Renders `{{var}}` placeholders. Values are escaped for the target (`html` for email bodies, `text` otherwise);
 * unknown/missing variables are reported, never left as raw braces. Values are never re-scanned for placeholders.
 */
export function renderTemplate(body: string, vars: Record<string, string | number | null | undefined>, mode: 'html' | 'text' = 'text'): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = body.replace(PLACEHOLDER, (_m, name: string) => {
    if (FORBIDDEN_VAR.test(name)) { missing.push(name); return ''; }
    const v = vars[name];
    if (v === null || v === undefined || v === '') { missing.push(name); return ''; }
    const s = plainValue(String(v));
    return mode === 'html' ? escapeHtml(s) : s;
  });
  return { text, missing: [...new Set(missing)] };
}

// ---------- Rates and caps ----------

export type CommRate = { channel: CommChannel; category: TemplateCategory | '*'; paise: number; effectiveFrom: string; effectiveTo: string | null };

/** Per-message cost on a date: exact category beats '*', the latest effective row wins. Null when no rate is configured. */
export function rateFor(rates: CommRate[], channel: CommChannel, category: TemplateCategory, onDate: string): number | null {
  const live = rates.filter((r) => r.channel === channel && r.effectiveFrom <= onDate && (!r.effectiveTo || r.effectiveTo >= onDate));
  const pick = (cat: string) => live.filter((r) => r.category === cat).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  return (pick(category) ?? pick('*'))?.paise ?? null;
}

/** SMS segments: GSM-7 160/153, Unicode (e.g. Hindi) 70/67. // VERIFY AGAINST OFFICIAL DOCS for the provider's billing unit. */
export function smsSegments(text: string): number {
  const unicode = /[^\x20-\x7e\n\r]/.test(text);
  const [one, many] = unicode ? [70, 67] : [160, 153];
  return text.length <= one ? 1 : Math.ceil(text.length / many);
}

export type CapCheck = { allowed: boolean; warn: boolean; remainingPaise: number | null };
/** Whether spending `addPaise` more keeps `usedPaise` within `capPaise` (null = no cap). */
export function capCheck(usedPaise: number, addPaise: number, capPaise: number | null, mode: 'block' | 'warn'): CapCheck {
  if (capPaise === null) return { allowed: true, warn: false, remainingPaise: null };
  const over = usedPaise + addPaise > capPaise;
  return { allowed: !over || mode === 'warn', warn: over, remainingPaise: Math.max(0, capPaise - usedPaise) };
}
/** How many messages of `unitPaise` fit in the remaining budget (unit 0 = unlimited). */
export const affordable = (remainingPaise: number | null, unitPaise: number) => (remainingPaise === null || unitPaise <= 0 ? Infinity : Math.floor(remainingPaise / unitPaise));

// ---------- Booking slots (IST) ----------

export const workingHoursSchema = z.record(z.enum(['0', '1', '2', '3', '4', '5', '6']), z.array(z.tuple([hhmm, hhmm])).max(6));
export type WorkingHours = z.infer<typeof workingHoursSchema>;
export type Interval = { start: Date; end: Date };
export type SlotInput = {
  from: string; to: string; workingHours: WorkingHours; slotMinutes: number; bufferMinutes: number;
  /** Busy intervals (events, appointments); each is padded by the buffer on both sides. */
  busy: Interval[];
  /** Whole days off (holidays, leave), yyyy-mm-dd IST. */
  daysOff: string[];
  now: Date; minNoticeMinutes: number;
};
const IST_MS = 330 * 60_000;
/** Instant of an IST wall-clock time. */
export const istInstant = (day: string, hm: string) => new Date(Date.parse(`${day}T${hm}:00Z`) - IST_MS);
const dayAdd = (iso: string, k: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);

/** Start instants of free slots between `from` and `to` (inclusive IST days), in order. */
export function availableSlots(i: SlotInput): Date[] {
  const out: Date[] = [];
  const off = new Set(i.daysOff);
  const step = i.slotMinutes * 60_000; const buf = i.bufferMinutes * 60_000;
  const earliest = i.now.getTime() + i.minNoticeMinutes * 60_000;
  for (let d = i.from; d <= i.to; d = dayAdd(d, 1)) {
    if (off.has(d)) continue;
    const wd = String(new Date(`${d}T00:00:00Z`).getUTCDay()) as keyof WorkingHours;
    for (const [s, e] of i.workingHours[wd] ?? []) {
      const end = istInstant(d, e).getTime();
      for (let t = istInstant(d, s).getTime(); t + step <= end; t += step + buf) {
        if (t < earliest) continue;
        const clash = i.busy.some((b) => t < b.end.getTime() + buf && t + step > b.start.getTime() - buf);
        if (!clash) out.push(new Date(t));
      }
    }
  }
  return out;
}

// ---------- ICS (RFC 5545) ----------

export type IcsEvent = { uid: string; start: Date; end: Date; allDay?: boolean; summary: string; updatedAt?: Date };
/** TEXT escaping: backslash, semicolon, comma, newlines. */
export const icsEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsTime = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsDate = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10).replace(/-/g, '');
/** Folds content lines at 75 octets (continuation lines start with a space), never splitting a UTF-8 sequence. */
const utf8 = new TextEncoder();
export function icsFold(line: string): string {
  const parts: string[] = []; let cur = ''; let bytes = 0;
  for (const ch of line) {
    const n = utf8.encode(ch).length;
    if (bytes + n > (parts.length ? 74 : 75)) { parts.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += n;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}
export function buildIcs(calName: string, events: IcsEvent[], stamp: Date): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Worko//Calendar//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsEscape(calName)}`];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid.replace(/[^\w.@-]/g, '')}`, `DTSTAMP:${icsTime(e.updatedAt ?? stamp)}`);
    if (e.allDay) lines.push(`DTSTART;VALUE=DATE:${icsDate(e.start)}`, `DTEND;VALUE=DATE:${icsDate(new Date(e.end.getTime() + (icsDate(e.end) === icsDate(e.start) ? 86_400_000 : 0)))}`);
    else lines.push(`DTSTART:${icsTime(e.start)}`, `DTEND:${icsTime(e.end)}`);
    lines.push(`SUMMARY:${icsEscape(e.summary)}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

// ---------- Chat ----------

/** Mentions written as `@[Name](uuid)` in the body; deduplicated, at most 50. */
export function mentionsOf(body: string): string[] {
  return [...new Set([...body.matchAll(/@\[[^\]]{1,100}\]\(([0-9a-f-]{36})\)/gi)].map((m) => m[1]!.toLowerCase()))].slice(0, 50);
}
/** Edits and deletes are allowed to the author only, within the window after posting. */
export const withinEditWindow = (createdAt: Date, now: Date, windowMinutes: number) => now.getTime() - createdAt.getTime() <= windowMinutes * 60_000;
