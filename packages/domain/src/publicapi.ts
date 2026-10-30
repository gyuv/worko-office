import { z } from 'zod';
import { CHANGE_EVENTS } from './automation.js';
import { ipInCidr, isValidCidr, normaliseIp } from './hr.js';
import { ACTIONS, MODULES, hiddenFieldsOf, type Actor, type Grant, type Module, type Role } from './permissions.js';

/**
 * M18 public API + outbound webhooks (Phase 12 B): pure rules shared by the API, web and tests —
 * key format, scope intersection, IP allow-lists, cursors, webhook signing/replay window, backoff and SSRF IP classification.
 */

// ---------- API keys ----------
/** `wk_<prefix>_<secret>`: the prefix (10 chars) identifies the key in lists/logs; only SHA-256(secret) is stored (D192). */
export const API_KEY_RE = /^wk_([a-z0-9]{10})_([A-Za-z0-9_-]{32,64})$/;
export function parseApiKey(token: string): { prefix: string; secret: string } | null {
  const m = API_KEY_RE.exec(token.trim());
  return m ? { prefix: m[1]!, secret: m[2]! } : null;
}
export const isApiKeyToken = (t: string | undefined | null) => !!t && t.startsWith('wk_');

export const apiScopeSchema = z.string().refine((s) => { const [m, a] = s.split(':'); return (MODULES as readonly string[]).includes(m ?? '') && (ACTIONS as readonly string[]).includes(a ?? ''); }, 'Unknown scope');
export const API_KEY_LIMITS = { maxKeys: 50, maxScopes: 100, maxCidrs: 20, defaultRatePerMin: 120, maxRatePerMin: 2000 } as const;

export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(apiScopeSchema).min(1).max(API_KEY_LIMITS.maxScopes),
  clientGroupIds: z.array(z.string().uuid()).max(50).nullable().optional(),
  ipAllowlist: z.array(z.string().max(60).refine(isValidCidr, 'Invalid CIDR')).max(API_KEY_LIMITS.maxCidrs).default([]),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  ratePerMin: z.number().int().min(1).max(API_KEY_LIMITS.maxRatePerMin).default(API_KEY_LIMITS.defaultRatePerMin),
}).strict();
export type ApiKeyCreate = z.infer<typeof apiKeyCreateSchema>;

/**
 * The key's effective rights = scopes ∩ the creator's CURRENT grants, evaluated per request (D193).
 * A key restricted to client groups keeps a grant only where that can be expressed without widening it:
 * creator 'all' → 'groups' (the key's groups); creator 'groups' → the intersection of groups; any narrower creator scope
 * (branch/team/own) is dropped for a group-restricted key (never wider than either side).
 */
export function keyGrants(creatorRoles: Role[], scopes: string[], clientGroupIds?: string[] | null): Grant[] {
  const want = new Set(scopes);
  const best = new Map<string, Grant>();
  const rank = { none: 0, own: 1, team: 2, groups: 3, branch: 4, all: 5 } as const;
  for (const r of creatorRoles) for (const g of r.grants) {
    const k = `${g.module}:${g.action}`;
    if (!want.has(k) || g.scope === 'none') continue;
    const cur = best.get(k);
    if (!cur || rank[g.scope] > rank[cur.scope]) best.set(k, g);
    else if (cur.scope === 'groups' && g.scope === 'groups') best.set(k, { ...cur, clientGroupIds: [...new Set([...(cur.clientGroupIds ?? []), ...(g.clientGroupIds ?? [])])] });
  }
  const out: Grant[] = [];
  for (const g of best.values()) {
    if (!clientGroupIds || clientGroupIds.length === 0) { out.push({ ...g }); continue; }
    if (g.scope === 'all') out.push({ module: g.module, action: g.action, scope: 'groups', clientGroupIds: [...clientGroupIds] });
    else if (g.scope === 'groups') {
      const ids = (g.clientGroupIds ?? []).filter((id) => clientGroupIds.includes(id));
      if (ids.length) out.push({ module: g.module, action: g.action, scope: 'groups', clientGroupIds: ids });
    }
  }
  return out;
}
/** The service principal a key acts as: one synthetic role; hidden fields are the creator's. */
export function keyActor(creator: Actor, scopes: string[], clientGroupIds?: string[] | null): Actor {
  return { userId: creator.userId, teamIds: creator.teamIds, branchId: creator.branchId,
    roles: [{ key: 'api_key', name: 'API key', system: false, grants: keyGrants(creator.roles, scopes, clientGroupIds), hiddenFields: hiddenFieldsOf(creator) }] };
}
/** Scopes the creator does not hold at all (creating a key for them is refused). */
export function scopesNotHeld(creatorRoles: Role[], scopes: string[]): string[] {
  const held = new Set(creatorRoles.flatMap((r) => r.grants.filter((g) => g.scope !== 'none').map((g) => `${g.module}:${g.action}`)));
  return scopes.filter((s) => !held.has(s));
}
/** Empty allow-list = any address. */
export const keyIpAllowed = (ip: string | null | undefined, cidrs: string[]) => cidrs.length === 0 || (!!ip && cidrs.some((c) => ipInCidr(normaliseIp(ip), c)));

/** Fixed-window per-key limiter (in-process; see KNOWN_GAPS for multi-node). */
export class WindowLimiter {
  private hits = new Map<string, { start: number; n: number }>();
  constructor(private windowMs = 60_000) {}
  take(key: string, limit: number, now: number): { ok: boolean; retryAfterSec: number } {
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) { this.hits.set(key, { start: now, n: 1 }); return { ok: true, retryAfterSec: 0 }; }
    if (h.n >= limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((h.start + this.windowMs - now) / 1000)) };
    h.n++; return { ok: true, retryAfterSec: 0 };
  }
}

// ---------- Cursors ----------
/** Opaque cursor over the existing offset pagination (D191). */
export const encodeCursor = (offset: number) => `c1.${offset.toString(36)}`;
export function decodeCursor(c: string): number | null {
  const m = /^c1\.([0-9a-z]{1,12})$/.exec(c);
  if (!m) return null;
  const n = parseInt(m[1]!, 36);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// ---------- Webhooks ----------
export const WEBHOOK_EVENTS = CHANGE_EVENTS;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
/** Module whose `view` right the subscription creator needs to receive the event (D196). */
export const WEBHOOK_EVENT_MODULE: Record<WebhookEvent, Module> = {
  'task.created': 'tasks', 'task.status_changed': 'tasks', 'invoice.issued': 'billing', 'receipt.recorded': 'receipts', 'document.uploaded': 'documents',
  'notice.received': 'notices', 'lead.stage_changed': 'leads', 'proposal.accepted': 'leads', 'proposal.converted': 'leads',
};
/** Payload keys copied into the envelope — status/stage only; never amounts, names or contact data. */
export const WEBHOOK_SAFE_KEYS = ['status', 'from', 'to', 'source', 'stage'] as const;
export function webhookEnvelope(ev: { id: string; type: string; occurredAt: string; entityType: string; entityId: string; clientId: string | null; payload?: Record<string, unknown> }) {
  const extra: Record<string, unknown> = {};
  for (const k of WEBHOOK_SAFE_KEYS) { const v = ev.payload?.[k]; if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') extra[k] = v; }
  return { id: ev.id, type: ev.type, occurredAt: ev.occurredAt, data: { entityType: ev.entityType, entityId: ev.entityId, clientId: ev.clientId, ...extra } };
}

export const webhookUrlSchema = z.string().max(2000).url().refine((u) => {
  const x = new URL(u);
  return x.protocol === 'https:' && !x.username && !x.password && !x.hash;
}, 'HTTPS URL without credentials required');
export const webhookCreateSchema = z.object({
  name: z.string().trim().min(1).max(100), url: webhookUrlSchema,
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
}).strict();
export const webhookPatchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(), url: webhookUrlSchema.optional(), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(), active: z.boolean().optional(),
}).strict();

export const WEBHOOK_DEFAULTS = { maxAttempts: 8, disableAfterFailures: 5, toleranceSec: 300, timeoutMs: 10_000 } as const;
/** 30 s, 2 min, 8 min, … capped at 6 h — deterministic so tests can drive it with a clock. */
export const webhookBackoffMs = (attempt: number) => Math.min(30_000 * 4 ** Math.max(0, attempt - 1), 6 * 3600_000);

/** Signed content = `${timestamp}.${body}`; header `Worko-Signature: t=<unix>,v1=<hex hmac-sha256>`. */
export const signedContent = (timestampSec: number, body: string) => `${timestampSec}.${body}`;
export const signatureHeader = (timestampSec: number, hexMac: string) => `t=${timestampSec},v1=${hexMac}`;
/**
 * Receiver-side verification (also used by our tests): parses the header, rejects stale/future timestamps outside the
 * tolerance (replay window), then compares the MAC in constant time. `hmacHex` is injected (node:crypto / WebCrypto).
 */
export function verifyWebhookSignature(o: { header: string | null | undefined; body: string; nowSec: number; toleranceSec?: number; hmacHex: (content: string) => string }):
  { ok: true; timestamp: number } | { ok: false; reason: 'malformed' | 'stale' | 'mismatch' } {
  const parts = Object.fromEntries((o.header ?? '').split(',').map((p) => p.trim().split('=') as [string, string]).filter((p) => p.length === 2));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return { ok: false, reason: 'malformed' };
  if (Math.abs(o.nowSec - t) > (o.toleranceSec ?? WEBHOOK_DEFAULTS.toleranceSec)) return { ok: false, reason: 'stale' };
  const expect = o.hmacHex(signedContent(t, o.body));
  let diff = expect.length ^ v1.length;
  for (let i = 0; i < Math.min(expect.length, v1.length); i++) diff |= expect.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0 ? { ok: true, timestamp: t } : { ok: false, reason: 'mismatch' };
}

// ---------- SSRF: address classification ----------
export type AddressClass = 'public' | 'private' | 'loopback' | 'link_local' | 'metadata' | 'unspecified' | 'multicast' | 'reserved' | 'cgnat' | 'invalid';

/** Parses IPv4 in every form `inet_aton` accepts: dotted, short (127.1), decimal (2130706433), octal (0177.0.0.1), hex (0x7f.1). */
export function parseIpv4Loose(s: string): number | null {
  const parts = s.split('.');
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => p === '')) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p.slice(2), 16);
    else if (/^0[0-7]*$/.test(p)) n = parseInt(p, 8);
    else if (/^[1-9][0-9]*$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  const last = nums.pop()!;
  if (nums.some((n) => n > 255)) return null;
  const rest = 4 - nums.length;
  if (last >= 256 ** rest) return null;
  let v = 0;
  for (const n of nums) v = v * 256 + n;
  return v * 256 ** rest + last;
}
const v4str = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

function parseIpv6(s: string): number[] | null {
  let x = s.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!;
  // Embedded IPv4 tail → two hextets.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (tail) { const v = parseIpv4Loose(tail[1]!); if (v === null || tail[1]!.split('.').length !== 4) return null; x = x.slice(0, -tail[1]!.length) + `${(v >>> 16).toString(16)}:${(v & 0xffff).toString(16)}`; }
  const dbl = x.split('::');
  if (dbl.length > 2) return null;
  const head = dbl[0] ? dbl[0].split(':') : [];
  const rest = dbl.length === 2 ? (dbl[1] ? dbl[1].split(':') : []) : [];
  if ([...head, ...rest].some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  const fill = 8 - head.length - rest.length;
  if (dbl.length === 1 ? fill !== 0 : fill < 1) return null;
  return [...head, ...Array(dbl.length === 2 ? fill : 0).fill('0'), ...rest].map((h) => parseInt(h, 16));
}

function classifyV4(n: number): AddressClass {
  const a = n >>> 24, b = (n >>> 16) & 255;
  if (n === 0xa9fea9fe) return 'metadata'; // 169.254.169.254
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 169 && b === 254) return 'link_local';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  if ((a === 192 && b === 0 && ((n >>> 8) & 255) === 0) || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && ((n >>> 8) & 255) === 2)
    || (a === 198 && b === 51 && ((n >>> 8) & 255) === 100) || (a === 203 && b === 0 && ((n >>> 8) & 255) === 113)) return 'reserved';
  return 'public';
}

/** Classifies a literal address (v4 in any loose form, v6 incl. IPv4-mapped/compatible, NAT64, 6to4). */
export function classifyAddress(addr: string): AddressClass {
  const s = addr.trim();
  if (!s.includes(':')) { const v = parseIpv4Loose(s); return v === null ? 'invalid' : classifyV4(v); }
  const h = parseIpv6(s);
  if (!h) return 'invalid';
  const v4of = (i: number) => h[i]! * 65536 + h[i + 1]!;
  if (h.every((x) => x === 0)) return 'unspecified';
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return 'loopback';
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) return classifyV4(v4of(6)); // ::ffff:a.b.c.d / ::a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b) return classifyV4(v4of(6)); // NAT64
  if (h[0] === 0x2002) return classifyV4(v4of(1)); // 6to4
  if ((h[0]! & 0xffc0) === 0xfe80) return 'link_local';
  if ((h[0]! & 0xfe00) === 0xfc00) return (h[0] === 0xfd00 && h[1] === 0x0ec2 && h.slice(2, 7).every((x) => x === 0) && h[7] === 0x254) ? 'metadata' : 'private'; // fd00:ec2::254 = AWS IMDS v6
  if ((h[0]! & 0xff00) === 0xff00) return 'multicast';
  if (h[0] === 0x2001 && h[1] === 0x0db8) return 'reserved';
  return 'public';
}
export const isBlockedAddress = (addr: string) => classifyAddress(addr) !== 'public';
/** If the host is an IP literal in any notation, its canonical form; else null (a DNS name). */
export function ipLiteralOf(host: string): string | null {
  const h = host.replace(/^\[|\]$/g, '');
  if (h.includes(':')) return parseIpv6(h) ? h.toLowerCase() : null;
  const v = parseIpv4Loose(h);
  return v === null ? null : v4str(v);
}
/** Host names never resolved (cloud metadata aliases, localhost). */
export const BLOCKED_HOSTNAMES = /^(localhost|localhost\.localdomain|metadata|metadata\.google\.internal|instance-data|.*\.local|.*\.internal|.*\.localhost)$/i;

// ---------- Passwords ----------
export const PASSWORD_MIN = 10;
/** Local checks before the breached-password lookup (D198). */
export function passwordIssues(pw: string, ctx: { email?: string | null; name?: string | null; firm?: string | null } = {}): string[] {
  const out: string[] = [];
  if (pw.length < PASSWORD_MIN) out.push('too_short');
  if (/^(.)\1+$/.test(pw)) out.push('repeated');
  const lower = pw.toLowerCase();
  const words = [ctx.email?.split('@')[0], ctx.name, ctx.firm].filter((w): w is string => !!w && w.length >= 5).map((w) => w.toLowerCase());
  if (words.some((w) => lower.includes(w))) out.push('contains_identity');
  if (/^(0123456789|1234567890|abcdefghij|qwertyuiop)/.test(lower)) out.push('sequence');
  return out;
}

