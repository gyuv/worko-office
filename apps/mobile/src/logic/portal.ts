import { PORTAL_ACCENTS, PORTAL_OTP, portalAllows, portalGrantsSchema, portalIdentifier, type PortalGrants } from '@worko/domain';
import { portalAccents, type PortalAccent } from '@worko/ui-tokens';
import { parsePaise } from './billing';
import { todayIST } from './registers';

/**
 * Client portal on Android (Phase 9, D126–D134). Pure logic only: OTP sign-in state machine (injected `now`),
 * grant-based tab visibility, read-only cache staleness and invoice display. Portal mode is online REST — no sync engine.
 */

// ---------- OTP sign-in ----------

/** Seconds before "Resend code" is allowed again (client-side courtesy; the server silently caps 5/hour). */
export const RESEND_SECONDS = 30;

/** Window of the per-IP auth throttle (AUTH_LIMIT ttl, 60 s): after a 429 we hold the buttons for this long. */
export const THROTTLE_SECONDS = 60;

export type OtpError = 'identifier' | 'code' | 'invalid' | 'codeSpent' | 'rateLimited' | 'network' | null;
export type OtpState = {
  phase: 'identify' | 'code';
  sentAt: number | null;
  /** Wrong guesses since the last code was sent (the server charges them to the newest live code). */
  failures: number;
  /** Client-side hold after a 429 (rate limit). There is no account lockout (D135). */
  heldUntil: number | null;
  error: OtpError;
};
export type OtpEvent =
  | { type: 'sent' } | { type: 'verifyFailed' } | { type: 'rateLimited' } | { type: 'network' }
  | { type: 'badInput'; field: 'identifier' | 'code' } | { type: 'edit' };

export const initialOtp = (): OtpState => ({ phase: 'identify', sentAt: null, failures: 0, heldUntil: null, error: null });

/**
 * D135: one uniform 401 for every verify failure; a code dies after PORTAL_OTP.maxAttempts wrong guesses, so after that many
 * the UI stops offering "Sign in" and asks for a new code. 429 = request throttle (per IP) → hold for THROTTLE_SECONDS.
 */
export function otpReducer(s: OtpState, e: OtpEvent, now: number): OtpState {
  switch (e.type) {
    case 'sent': return { ...s, phase: 'code', sentAt: now, failures: 0, error: null };
    case 'verifyFailed': {
      const failures = s.failures + 1;
      return { ...s, failures, error: failures >= PORTAL_OTP.maxAttempts ? 'codeSpent' : 'invalid' };
    }
    case 'rateLimited': return { ...s, heldUntil: now + THROTTLE_SECONDS * 1000, error: 'rateLimited' };
    case 'network': return { ...s, error: 'network' };
    case 'badInput': return { ...s, error: e.field };
    case 'edit': return { ...initialOtp(), heldUntil: s.heldUntil };
  }
}

export const isHeld = (s: OtpState, now: number) => s.heldUntil !== null && s.heldUntil > now;
export const heldSecondsLeft = (s: OtpState, now: number) => (isHeld(s, now) ? Math.ceil((s.heldUntil! - now) / 1000) : 0);
/** "Sign in" is offered only while the current code may still be valid. */
export const canVerify = (s: OtpState, now: number) => s.phase === 'code' && !isHeld(s, now) && s.failures < PORTAL_OTP.maxAttempts
  && s.sentAt !== null && now - s.sentAt < PORTAL_OTP.ttlMinutes * 60_000;
export function resendIn(s: OtpState, now: number): number {
  if (s.sentAt === null) return 0;
  return Math.max(0, Math.ceil((s.sentAt + RESEND_SECONDS * 1000 - now) / 1000), heldSecondsLeft(s, now));
}
export const validCode = (code: string) => /^\d{6}$/.test(code.trim());
export const validIdentifier = (raw: string) => portalIdentifier(raw) !== null;
export const validFirm = (raw: string) => /^[a-z0-9][a-z0-9-]{1,62}$/.test(raw.trim().toLowerCase());

/** HTTP status → event. Request: always 202 (no enumeration) unless throttled. Verify: uniform 401. Either: 429 throttle. */
export function otpEventFor(step: 'request' | 'verify', status: number | undefined): OtpEvent {
  if (!status || status >= 500) return { type: 'network' };
  if (status === 429) return { type: 'rateLimited' };
  return step === 'verify' ? { type: 'verifyFailed' } : { type: 'network' };
}

// ---------- Grants → tabs ----------

export type PortalTab = 'home' | 'documents' | 'requests' | 'invoices' | 'messages' | 'more';
export type PortalClient = { id: string; name: string; grants: PortalGrants };

export function parseGrants(raw: unknown): PortalGrants {
  const r = portalGrantsSchema.safeParse(raw ?? {});
  // Unknown shape ⇒ show nothing sensitive (the server still enforces every grant).
  return r.success ? r.data : { ...portalGrantsSchema.parse({}), documents: { enabled: false, categories: [], fys: [] }, invoices: false, payments: false, requests: false, messages: false, esign: false };
}

export function portalTabs(g: PortalGrants): PortalTab[] {
  const tabs: PortalTab[] = ['home'];
  if (portalAllows(g, 'documents')) tabs.push('documents');
  if (portalAllows(g, 'requests')) tabs.push('requests');
  if (portalAllows(g, 'invoices') || portalAllows(g, 'payments')) tabs.push('invoices');
  if (portalAllows(g, 'messages')) tabs.push('messages');
  tabs.push('more');
  return tabs;
}

/** Items under "More": e-sign only with the grant; profile + consent always. */
export function moreItems(g: PortalGrants): Array<'esign' | 'receipts' | 'profile' | 'consent'> {
  const out: Array<'esign' | 'receipts' | 'profile' | 'consent'> = [];
  if (portalAllows(g, 'esign')) out.push('esign');
  if (portalAllows(g, 'invoices') || portalAllows(g, 'payments')) out.push('receipts');
  out.push('profile', 'consent');
  return out;
}

/** Keep the chosen client if still accessible, else the first one (group companies under one login). */
export function pickClient(clients: Array<{ id: string }>, current: string | null): string | null {
  if (current && clients.some((c) => c.id === current)) return current;
  return clients[0]?.id ?? null;
}

// ---------- Branding ----------

export function accentColor(accent: unknown, scheme: 'light' | 'dark'): string {
  const a = (PORTAL_ACCENTS as readonly string[]).includes(String(accent)) ? (accent as PortalAccent) : 'blue';
  return portalAccents[a][scheme];
}

// ---------- Read-only offline cache ----------

/** Last dashboard/documents responses for offline viewing; always shown with a "stale" banner, wiped on logout. */
export const CACHE_VERSION = 1;
export const CACHE_MAX_DOCS = 50;
export const STALE_AFTER_MS = 5 * 60_000;
export type CacheEntry<T> = { v: number; savedAt: number; owner: string; clientId: string; data: T };

export function makeCacheEntry<T>(owner: string, clientId: string, data: T, now: number): CacheEntry<T> {
  const trimmed = Array.isArray(data) ? (data.slice(0, CACHE_MAX_DOCS) as unknown as T) : data;
  return { v: CACHE_VERSION, savedAt: now, owner, clientId, data: trimmed };
}

/** A cache entry is usable only for the same portal user + client and the current format. */
export function readCacheEntry<T>(raw: string | null, owner: string, clientId: string): CacheEntry<T> | null {
  if (!raw) return null;
  try {
    const e = JSON.parse(raw) as CacheEntry<T>;
    if (e?.v !== CACHE_VERSION || e.owner !== owner || e.clientId !== clientId || typeof e.savedAt !== 'number') return null;
    return e;
  } catch { return null; }
}

/** Live data always wins; cached data is shown only when the request failed, and is "stale" when old or offline. */
export function cacheView<T>(live: T | undefined, cached: CacheEntry<T> | null, failed: boolean, now: number): { data: T | undefined; stale: boolean; savedAt: number | null } {
  if (live !== undefined) return { data: live, stale: false, savedAt: null };
  if (cached && failed) return { data: cached.data, stale: true, savedAt: cached.savedAt };
  if (cached) return { data: cached.data, stale: now - cached.savedAt > STALE_AFTER_MS, savedAt: cached.savedAt };
  return { data: undefined, stale: false, savedAt: null };
}

// ---------- Invoices ----------

export type PortalInvoice = { id: string; kind: string; number: string | null; status: string; issueDate: string | null; dueDate: string | null; totalPaise: number; balancePaise: number };

export function toPortalInvoice(r: Record<string, unknown>): PortalInvoice {
  const d = (v: unknown) => (v ? String(v).slice(0, 10) : null);
  return { id: String(r.id), kind: String(r.kind ?? 'invoice'), number: r.number ? String(r.number) : null, status: String(r.status ?? ''), issueDate: d(r.issueDate), dueDate: d(r.dueDate),
    totalPaise: parsePaise(r.totalPaise), balancePaise: parsePaise(r.balancePaise) };
}

export type OutstandingBadge = 'paid' | 'overdue' | 'due' | 'credit';
/** What the client sees on an invoice row: badge + amount still payable. Credit notes are never "payable". */
export function invoiceDisplay(i: PortalInvoice, today = todayIST()): { badge: OutstandingBadge; outstandingPaise: number; daysOverdue: number } {
  if (i.kind !== 'invoice') return { badge: 'credit', outstandingPaise: 0, daysOverdue: 0 };
  const bal = Math.max(0, i.balancePaise);
  if (bal === 0 || i.status === 'paid') return { badge: 'paid', outstandingPaise: 0, daysOverdue: 0 };
  if (i.dueDate && i.dueDate < today) {
    const days = Math.round((Date.parse(today) - Date.parse(i.dueDate)) / 86_400_000);
    return { badge: 'overdue', outstandingPaise: bal, daysOverdue: days };
  }
  return { badge: 'due', outstandingPaise: bal, daysOverdue: 0 };
}

export function totalOutstanding(list: PortalInvoice[], today = todayIST()): { totalPaise: number; overduePaise: number } {
  let totalPaise = 0; let overduePaise = 0;
  for (const i of list) { const d = invoiceDisplay(i, today); totalPaise += d.outstandingPaise; if (d.badge === 'overdue') overduePaise += d.outstandingPaise; }
  return { totalPaise, overduePaise };
}

/** Only https links (or the dev server) are opened in the browser. */
export function safeExternalUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try { const u = new URL(url); return u.protocol === 'https:' || (u.protocol === 'http:' && /^(localhost|10\.0\.2\.2|127\.0\.0\.1)$/.test(u.hostname)) ? u.toString() : null; } catch { return null; }
}

/** Profile change request: only fields that actually changed (trimmed; empty → null). */
export function profileChanges(before: Record<string, string | null | undefined>, after: Record<string, string>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(after)) {
    const nv = v.trim() || null;
    if ((before[k] ?? null) !== nv) out[k] = nv;
  }
  return out;
}
