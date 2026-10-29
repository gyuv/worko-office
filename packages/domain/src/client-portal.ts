import { z } from 'zod';
import { normalizeEmail, normalizePhone } from './comm.js';

// ---------- Client portal (M16): grants, OTP rules, white-label ----------

/**
 * Per client × portal user. Notices and compliance are off by default (sensitive / easy to misread);
 * documents may be narrowed to categories and financial years ('*' = all).
 */
export const portalGrantsSchema = z.object({
  documents: z.object({
    enabled: z.boolean().default(true),
    categories: z.array(z.string().trim().min(1).max(100)).max(50).default(['*']),
    fys: z.array(z.union([z.literal('*'), z.string().regex(/^\d{4}-\d{2}$/)])).max(30).default(['*']),
  }).strict().default({}),
  invoices: z.boolean().default(true),
  payments: z.boolean().default(true),
  requests: z.boolean().default(true),
  messages: z.boolean().default(true),
  esign: z.boolean().default(true),
  notices: z.boolean().default(false),
  compliance: z.boolean().default(false),
}).strict();
export type PortalGrants = z.infer<typeof portalGrantsSchema>;
export const defaultPortalGrants = (): PortalGrants => portalGrantsSchema.parse({});
export type PortalArea = Exclude<keyof PortalGrants, 'documents'> | 'documents';

/** Grant evaluation. A document is visible only with the documents grant AND a matching category AND FY (permanent docs have no FY: need '*'). */
export function portalAllows(g: PortalGrants, area: PortalArea, doc?: { category?: string | null; fy?: string | null }): boolean {
  if (area !== 'documents') return g[area] === true;
  if (!g.documents.enabled) return false;
  if (!doc) return true;
  const catOk = g.documents.categories.includes('*') || (!!doc.category && g.documents.categories.some((c) => c.toLowerCase() === doc.category!.toLowerCase()));
  const fyOk = g.documents.fys.includes('*') || (!!doc.fy && g.documents.fys.includes(doc.fy));
  return catOk && fyOk;
}

/** The category client uploads land in (staff re-file them). */
export const PORTAL_INBOX_CATEGORY = 'From client';

/** OTP rules (portal login). Codes are 6 digits, stored as hashes only. */
export const PORTAL_OTP = { ttlMinutes: 10, maxAttempts: 5, maxPerHour: 5, lockAfterFailures: 5, lockMinutes: 15 } as const;

export type OtpState = { lockedUntil: Date | null; failedLogins: number; challenge: { attempts: number; expiresAt: Date; consumedAt: Date | null } | null };
export type OtpOutcome = 'ok' | 'locked' | 'invalid';

/**
 * Decision for a verify attempt. Every non-ok outcome looks identical to the caller (no hint whether the code expired,
 * was wrong, or the person does not exist); 'locked' is reported as 429 only once the account is actually locked.
 */
export function otpVerifyOutcome(s: OtpState, codeMatches: boolean, now: Date): OtpOutcome {
  if (s.lockedUntil && s.lockedUntil > now) return 'locked';
  const c = s.challenge;
  if (!c || c.consumedAt || c.expiresAt <= now || c.attempts >= PORTAL_OTP.maxAttempts) return 'invalid';
  return codeMatches ? 'ok' : 'invalid';
}
/** Failure bookkeeping: lock after N failures in a row. */
export function otpFailure(failedLogins: number, now: Date): { failedLogins: number; lockedUntil: Date | null } {
  const n = failedLogins + 1;
  return { failedLogins: n, lockedUntil: n >= PORTAL_OTP.lockAfterFailures ? new Date(now.getTime() + PORTAL_OTP.lockMinutes * 60_000) : null };
}
/** May a new code be issued? (Silent no when locked or over the hourly cap.) */
export const canIssueOtp = (issuedLastHour: number, lockedUntil: Date | null, now: Date) => !(lockedUntil && lockedUntil > now) && issuedLastHour < PORTAL_OTP.maxPerHour;

/** Login identifier: an email or a mobile number, normalised. */
export function portalIdentifier(raw: string): { kind: 'email' | 'phone'; value: string } | null {
  const s = raw.trim();
  if (s.includes('@')) { const e = normalizeEmail(s); return e ? { kind: 'email', value: e } : null; }
  const p = normalizePhone(s);
  return p ? { kind: 'phone', value: p } : null;
}

/** White-label accents: a fixed subset of the shared palette (keys mirror `portalAccents` in @worko/ui-tokens). */
export const PORTAL_ACCENTS = ['blue', 'teal', 'green', 'indigo', 'maroon', 'slate'] as const;
export const portalSettingsSchema = z.object({
  displayName: z.string().trim().min(1).max(120).nullable().default(null),
  logoDocumentId: z.string().uuid().nullable().default(null),
  accent: z.enum(PORTAL_ACCENTS).default('blue'),
  /** Recorded only (DNS/TLS provisioning is out of scope); portal URLs use the firm slug. */
  customDomain: z.string().trim().toLowerCase().regex(/^(?=.{4,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/).nullable().default(null),
  supportEmail: z.string().email().nullable().default(null),
  supportPhone: z.string().regex(/^\+?\d{10,15}$/).nullable().default(null),
  welcomeText: z.string().max(1000).nullable().default(null),
  /** Default grants for new invitations. */
  defaultGrants: portalGrantsSchema.default({}),
}).strict();
export type PortalSettings = z.infer<typeof portalSettingsSchema>;

/** Profile fields a portal user may ask to change (staff approve). */
export const PROFILE_FIELDS = ['name', 'email', 'phone', 'whatsapp', 'role'] as const;
