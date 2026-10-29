import { defaultPortalGrants, portalIdentifier, type PortalGrants } from '@worko/domain';
import { portalAccents, type PortalAccent } from '@worko/ui-tokens';

/**
 * Client portal — pure helpers (routing, OTP form state, grants, links). The portal is a separate app inside the same SPA:
 * hash routes `#/portal/{firm}/{view}[/{id}][?client={clientId}]`, its own tokens and http client (D126).
 */
export const PORTAL_VIEWS = ['dashboard', 'documents', 'requests', 'invoices', 'receipts', 'messages', 'esign', 'notices', 'profile'] as const;
export type PortalView = (typeof PORTAL_VIEWS)[number];
export type PortalLoc = { firm: string; view: PortalView; id?: string; clientId?: string };

const safe = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
const FIRM = /^[a-z0-9][a-z0-9-]{1,62}$/i;

/** `#/portal/acme/invoices/<id>?client=<uuid>` → location; null when the hash is not a portal route. */
export function parsePortalHash(hash: string): PortalLoc | null {
  const [path = '', qs = ''] = hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(safe);
  if (parts[0] !== 'portal' || !parts[1] || !FIRM.test(parts[1])) return null;
  const view = (PORTAL_VIEWS as readonly string[]).includes(parts[2] ?? '') ? (parts[2] as PortalView) : 'dashboard';
  const clientId = new URLSearchParams(qs).get('client') ?? undefined;
  return { firm: parts[1].toLowerCase(), view, ...(parts[3] ? { id: parts[3] } : {}), ...(clientId ? { clientId } : {}) };
}

export function portalHref(firm: string, view: PortalView = 'dashboard', o: { id?: string; clientId?: string } = {}): string {
  return `#/portal/${encodeURIComponent(firm)}/${view}${o.id ? `/${encodeURIComponent(o.id)}` : ''}${o.clientId ? `?client=${encodeURIComponent(o.clientId)}` : ''}`;
}

/** Which portal sections a client's grants open (dashboard/profile always). */
export function viewAllowed(view: PortalView, g: PortalGrants): boolean {
  switch (view) {
    case 'dashboard': case 'profile': return true;
    case 'documents': return g.documents.enabled;
    case 'receipts': return g.invoices || g.payments;
    default: return g[view] === true;
  }
}

// ---------- OTP sign-in form (D135: no account lockout) ----------
/**
 * Rules mirrored client-side: wrong guesses count against the newest live code (5 tries), codes live 10 minutes, then a new code
 * is needed. The only 429 is the per-IP throttle (identical for every identifier) → countdown. Messages never imply the account exists.
 */
export const RESEND_SECONDS = 30;
export const OTP_TRIES = 5;
export const OTP_TTL_MS = 10 * 60_000;
export const THROTTLE_SECONDS = 60;
export type OtpError = 'invalid_identifier' | 'invalid_code' | 'new_code_needed' | 'throttled' | 'network';
export type OtpState = { step: 'identify' | 'code'; identifier: string; code: string; busy: boolean; error: OtpError | null; resendAt: number | null;
  attempts: number; expiresAt: number | null; retryAt: number | null };
export type OtpAction =
  | { type: 'identifier'; value: string } | { type: 'code'; value: string } | { type: 'submit' }
  | { type: 'sent'; now: number } | { type: 'failed'; phase: 'request' | 'verify'; status: number; now: number; retryAfter?: number | null }
  | { type: 'invalid_identifier' } | { type: 'back' } | { type: 'verified' };

export const otpInitial: OtpState = { step: 'identify', identifier: '', code: '', busy: false, error: null, resendAt: null, attempts: 0, expiresAt: null, retryAt: null };

export function otpErrorFor(phase: 'request' | 'verify', status: number): OtpError {
  if (status === 429) return 'throttled';
  if (status === 401 || status === 400) return phase === 'verify' ? 'invalid_code' : 'invalid_identifier';
  return 'network';
}

export function otpReducer(s: OtpState, a: OtpAction): OtpState {
  switch (a.type) {
    case 'identifier': return { ...s, identifier: a.value, error: null };
    case 'code': return { ...s, code: a.value.replace(/\D/g, '').slice(0, 6), error: s.error === 'invalid_code' ? null : s.error };
    case 'submit': return { ...s, busy: true, error: null };
    case 'invalid_identifier': return { ...s, busy: false, error: 'invalid_identifier' };
    // Always "sent" (202): the same screen whether or not the address is known. A new code is the newest → fresh 5 tries.
    case 'sent': return { ...s, step: 'code', busy: false, error: null, code: '', resendAt: a.now + RESEND_SECONDS * 1000, attempts: 0, expiresAt: a.now + OTP_TTL_MS, retryAt: null };
    case 'failed': {
      if (a.status === 429) return { ...s, busy: false, error: 'throttled', retryAt: a.now + (a.retryAfter && a.retryAfter > 0 ? a.retryAfter : THROTTLE_SECONDS) * 1000 };
      const e = otpErrorFor(a.phase, a.status);
      if (a.phase === 'verify' && e === 'invalid_code') {
        const attempts = s.attempts + 1;
        return { ...s, busy: false, code: '', attempts, error: attempts >= OTP_TRIES ? 'new_code_needed' : 'invalid_code' };
      }
      return { ...s, busy: false, error: e };
    }
    case 'back': return { ...otpInitial, identifier: s.identifier };
    case 'verified': return { ...s, busy: false };
  }
}
export const secondsUntil = (at: number | null, now: number) => (at === null ? 0 : Math.max(0, Math.ceil((at - now) / 1000)));
export const resendSecondsLeft = secondsUntil;
/** Sign in is possible only with a live code (not expired, fewer than 5 tries) and no throttle countdown running. */
export function canVerify(s: OtpState, now: number): boolean {
  return /^\d{6}$/.test(s.code) && !s.busy && s.attempts < OTP_TRIES && (s.expiresAt === null || now < s.expiresAt) && secondsUntil(s.retryAt, now) === 0;
}
export const codeExpired = (s: OtpState, now: number) => s.expiresAt !== null && now >= s.expiresAt;
export const validIdentifier = (raw: string) => portalIdentifier(raw) !== null;
export const codeComplete = (code: string) => /^\d{6}$/.test(code);

// ---------- Branding ----------
export function accentColor(accent: string | null | undefined, dark: boolean): string {
  const a = portalAccents[(accent ?? 'blue') as PortalAccent] ?? portalAccents.blue;
  return dark ? a.dark : a.light;
}

// ---------- Links ----------
/** API signer URL (`…/v1/esign/sign/<token>`) → the web signer page `#/esign/sign/<token>`. */
export function esignHref(signUrl: string): string {
  const m = /\/esign\/sign\/([^/?#]+)/.exec(signUrl);
  return m ? `#/esign/sign/${m[1]}` : signUrl;
}

// ---------- Grants editor (staff) ----------
export type GrantFlag = Exclude<keyof PortalGrants, 'documents'>;
export const GRANT_FLAGS: GrantFlag[] = ['invoices', 'payments', 'requests', 'messages', 'esign', 'notices', 'compliance'];

/** "GST, Income tax" → ['GST','Income tax']; blank or '*' → ['*'] (all). */
export function listFromText(s: string): string[] {
  const xs = [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))];
  return !xs.length || xs.includes('*') ? ['*'] : xs;
}
export const listToText = (xs: string[]) => (xs.includes('*') ? '' : xs.join(', '));
export const invalidFys = (xs: string[]) => xs.filter((x) => x !== '*' && !/^\d{4}-\d{2}$/.test(x));

export type GrantsEdit = { type: 'flag'; flag: GrantFlag; on: boolean } | { type: 'documents'; on: boolean } | { type: 'categories'; text: string } | { type: 'fys'; text: string } | { type: 'reset'; grants?: PortalGrants };
export function grantsReducer(g: PortalGrants, e: GrantsEdit): PortalGrants {
  switch (e.type) {
    case 'flag': return { ...g, [e.flag]: e.on };
    case 'documents': return { ...g, documents: { ...g.documents, enabled: e.on } };
    case 'categories': return { ...g, documents: { ...g.documents, categories: listFromText(e.text) } };
    case 'fys': return { ...g, documents: { ...g.documents, fys: listFromText(e.text) } };
    case 'reset': return e.grants ?? defaultPortalGrants();
  }
}
export const sameGrants = (a: PortalGrants, b: PortalGrants) => JSON.stringify(a) === JSON.stringify(b);

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
