import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { connect } from 'node:net';
import type { CommChannel } from '@worko/domain';

/**
 * Phase 7 channel layer: one adapter per channel (email / WhatsApp / SMS) selected by env (`mock` default), inbound
 * webhook verification + parsing, and Gmail/Outlook OAuth (mail + calendar). Real adapters are skeletons — every
 * external detail is marked // VERIFY AGAINST OFFICIAL DOCS and listed in KNOWN_GAPS. Nothing here logs addresses,
 * bodies or tokens.
 */

export type OutboundMessage = {
  tenantId: string; channel: CommChannel; to: string; subject?: string | null; text: string; html?: string | null;
  /** WhatsApp approved template (outside the 24-hour session window business-initiated messages must use one). */
  template?: { name: string; language: string; params: string[] } | null;
  /** India SMS: DLT-registered template id (TRAI). */
  dltTemplateId?: string | null;
  /** Same key ⇒ the provider must not send twice (broadcast recipient id, message id). */
  idempotencyKey: string;
};
export type SendResult = { status: 'sent' | 'failed'; ref?: string; error?: string };
/** Thrown for outages that should be retried (the job queue backs off); a `failed` result is final for that attempt. */
export class TransientSendError extends Error {}

export interface ChannelAdapter { readonly channel: CommChannel; readonly name: string; send(m: OutboundMessage): Promise<SendResult> }
export type ChannelAdapters = Record<CommChannel, ChannelAdapter>;
export const COMM_CHANNELS_TOKEN = 'COMM_CHANNELS';

// ---------------- Mock (default; tests read the hub) ----------------

/** Shared in-memory outbox for all mock channels. `failTo` = permanent failure, `throwOnce` = one transient outage. */
export class MockChannelHub {
  readonly outbox: Array<OutboundMessage & { ref: string }> = [];
  readonly failTo = new Set<string>();
  readonly throwOnce = new Set<string>();
  private byKey = new Map<string, string>();
  send(m: OutboundMessage): SendResult {
    const prior = this.byKey.get(m.idempotencyKey);
    if (prior) return { status: 'sent', ref: prior };
    if (this.throwOnce.delete(m.to)) throw new TransientSendError('mock outage');
    if (this.failTo.has(m.to)) return { status: 'failed', error: 'mock failure' };
    const ref = `mock-${m.channel}-${this.outbox.length + 1}`;
    this.outbox.push({ ...m, ref });
    this.byKey.set(m.idempotencyKey, ref);
    return { status: 'sent', ref };
  }
}
class MockAdapter implements ChannelAdapter {
  readonly name = 'mock';
  constructor(readonly channel: CommChannel, private hub: MockChannelHub) {}
  async send(m: OutboundMessage) { return this.hub.send(m); }
}

// ---------------- Email: SMTP (Mailpit locally) ----------------

/**
 * Minimal SMTP submission (EHLO/MAIL/RCPT/DATA) for Mailpit in development. No STARTTLS/AUTH yet — production needs
 * SES or an authenticated relay. // VERIFY AGAINST OFFICIAL DOCS (SES SMTP interface / provider relay settings).
 */
export class SmtpEmailAdapter implements ChannelAdapter {
  readonly channel = 'email' as const; readonly name = 'smtp';
  constructor(private host = process.env.SMTP_HOST ?? 'localhost', private port = Number(process.env.SMTP_PORT ?? 1025), private from = process.env.SMTP_FROM ?? 'no-reply@worko.local') {}
  async send(m: OutboundMessage): Promise<SendResult> {
    const id = `<${createHash('sha256').update(m.idempotencyKey).digest('hex').slice(0, 24)}@worko>`;
    const headers = [`From: ${this.from}`, `To: ${m.to}`, `Subject: ${(m.subject ?? '').replace(/[\r\n]/g, ' ')}`, `Message-ID: ${id}`, 'MIME-Version: 1.0',
      `Content-Type: ${m.html ? 'text/html' : 'text/plain'}; charset=utf-8`, 'Content-Transfer-Encoding: 8bit'];
    const body = (m.html ?? m.text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    try {
      await smtpDialog(this.host, this.port, [`EHLO worko`, `MAIL FROM:<${this.from}>`, `RCPT TO:<${m.to.replace(/[<>\r\n]/g, '')}>`, 'DATA', `${headers.join('\r\n')}\r\n\r\n${body}\r\n.`, 'QUIT']);
      return { status: 'sent', ref: id };
    } catch (e) {
      throw new TransientSendError(`smtp: ${(e as Error).message}`);
    }
  }
}
function smtpDialog(host: string, port: number, cmds: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = connect({ host, port }); let buf = ''; let i = -1;
    s.setTimeout(10_000, () => { s.destroy(); reject(new Error('timeout')); });
    s.on('error', reject);
    s.on('data', (d) => {
      buf += d.toString('utf8');
      if (!/(^|\r\n)\d{3} [^\r\n]*\r\n$/.test(buf)) return; // wait for the last line of a (multi-line) reply
      const code = Number(buf.match(/(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/)![1]); buf = '';
      if (code >= 400) { s.destroy(); reject(new Error(`SMTP ${code}`)); return; }
      i++;
      if (i >= cmds.length) { s.end(); resolve(); return; }
      s.write(`${cmds[i]}\r\n`);
    });
  });
}

// ---------------- WhatsApp Cloud API (Meta) ----------------

/**
 * SKELETON. // VERIFY AGAINST OFFICIAL DOCS (WhatsApp Cloud API): `POST https://graph.facebook.com/{version}/{phone-number-id}/messages`,
 * template payload shape (components/parameters), session (24-hour) text messages, error codes and pricing categories.
 */
export class MetaWhatsAppAdapter implements ChannelAdapter {
  readonly channel = 'whatsapp' as const; readonly name = 'meta';
  async send(m: OutboundMessage): Promise<SendResult> {
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID; const token = process.env.WHATSAPP_TOKEN; const ver = process.env.WHATSAPP_API_VERSION ?? 'v20.0';
    if (!phoneId || !token) return { status: 'failed', error: 'whatsapp_not_configured' };
    const body = m.template
      ? { messaging_product: 'whatsapp', to: m.to.replace(/^\+/, ''), type: 'template', template: { name: m.template.name, language: { code: m.template.language },
        components: [{ type: 'body', parameters: m.template.params.map((text) => ({ type: 'text', text })) }] } }
      : { messaging_product: 'whatsapp', to: m.to.replace(/^\+/, ''), type: 'text', text: { body: m.text } };
    const res = await fetch(`https://graph.facebook.com/${ver}/${encodeURIComponent(phoneId)}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });
    if (res.status >= 500 || res.status === 429) throw new TransientSendError(`whatsapp ${res.status}`);
    if (!res.ok) return { status: 'failed', error: `whatsapp ${res.status}` };
    const j = await res.json() as { messages?: Array<{ id: string }> };
    return { status: 'sent', ref: j.messages?.[0]?.id };
  }
}

// ---------------- SMS (DLT, India) ----------------

/**
 * Generic HTTP SMS gateway SKELETON. India requires DLT registration: principal entity id + a registered template id per
 * message, and the text must match the registered template. // VERIFY AGAINST OFFICIAL DOCS (TRAI TCCCPR, chosen aggregator API).
 */
export class HttpSmsAdapter implements ChannelAdapter {
  readonly channel = 'sms' as const; readonly name = 'http';
  async send(m: OutboundMessage): Promise<SendResult> {
    const url = process.env.SMS_API_URL; const key = process.env.SMS_API_KEY;
    if (!url || !key) return { status: 'failed', error: 'sms_not_configured' };
    if (!m.dltTemplateId) return { status: 'failed', error: 'dlt_template_required' };
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ to: m.to, text: m.text, sender: process.env.SMS_SENDER_ID, dlt_entity_id: process.env.DLT_ENTITY_ID, dlt_template_id: m.dltTemplateId, ref: m.idempotencyKey }) });
    if (res.status >= 500 || res.status === 429) throw new TransientSendError(`sms ${res.status}`);
    if (!res.ok) return { status: 'failed', error: `sms ${res.status}` };
    const j = await res.json() as { id?: string };
    return { status: 'sent', ref: j.id };
  }
}

export const commProvider = (c: CommChannel) => (process.env[`COMM_${c.toUpperCase()}_PROVIDER`] || 'mock');
export const commAllMock = () => (['email', 'whatsapp', 'sms'] as const).every((c) => commProvider(c) === 'mock');
export function channelAdaptersFactory(hub: MockChannelHub): ChannelAdapters {
  const email = commProvider('email') === 'smtp' ? new SmtpEmailAdapter() : new MockAdapter('email', hub);
  const whatsapp = commProvider('whatsapp') === 'meta' ? new MetaWhatsAppAdapter() : new MockAdapter('whatsapp', hub);
  const sms = commProvider('sms') === 'http' ? new HttpSmsAdapter() : new MockAdapter('sms', hub);
  return { email, whatsapp, sms };
}

// ---------------- Inbound webhooks (WhatsApp / SMS) ----------------

export type InboundEvent =
  | { eventId: string; kind: 'message'; channel: 'whatsapp' | 'sms'; from: string; text: string; providerRef: string; at: Date | null; account: string | null }
  | { eventId: string; kind: 'status'; channel: 'whatsapp' | 'sms'; providerRef: string; status: 'delivered' | 'read' | 'failed'; at: Date | null; account: string | null };
type Headers = Record<string, string | string[] | undefined>;
export interface InboundProvider {
  readonly name: string;
  /** Signature over the exact raw body. */
  verify(raw: Buffer, headers: Headers): boolean;
  parse(raw: Buffer): InboundEvent[];
  /** Subscription handshake (Meta: hub.challenge echo when hub.verify_token matches). */
  challenge?(q: Record<string, string | undefined>): string | null;
}
const hdr = (h: Headers, k: string) => { const v = h[k]; return Array.isArray(v) ? v[0] : v; };
function safeEq(a: string | undefined, b: string) {
  if (!a) return false;
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export const DEV_COMM_WEBHOOK_SECRET = 'worko-dev-comm-webhook-secret';
export const commHmac = (secret: string, raw: Buffer) => createHmac('sha256', secret).update(raw).digest('hex');

/** Dev/test inbound: `x-worko-signature` = hex HMAC-SHA256 of the raw body with COMM_WEBHOOK_SECRET. */
export class MockInboundProvider implements InboundProvider {
  readonly name = 'mock';
  // `||`: an empty env var must not become an empty (forgeable) key.
  private secret = () => process.env.COMM_WEBHOOK_SECRET || DEV_COMM_WEBHOOK_SECRET;
  verify(raw: Buffer, h: Headers) { return safeEq(hdr(h, 'x-worko-signature'), commHmac(this.secret(), raw)); }
  parse(raw: Buffer): InboundEvent[] {
    const b = JSON.parse(raw.toString('utf8')) as { events?: Array<Record<string, unknown>> };
    return (b.events ?? []).flatMap((e): InboundEvent[] => {
      const channel = e.channel === 'sms' ? 'sms' : 'whatsapp';
      const at = typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at) : null;
      if (typeof e.id !== 'string') return [];
      const account = typeof e.account === 'string' ? e.account : null;
      if (e.type === 'status' && typeof e.ref === 'string' && ['delivered', 'read', 'failed'].includes(String(e.status))) {
        return [{ eventId: e.id, kind: 'status', channel, providerRef: e.ref, status: e.status as 'delivered', at, account }];
      }
      if (typeof e.from !== 'string' || typeof e.text !== 'string') return [];
      return [{ eventId: e.id, kind: 'message', channel, from: e.from, text: e.text.slice(0, 4096), providerRef: typeof e.ref === 'string' ? e.ref : e.id, at, account }];
    });
  }
}

/**
 * Meta WhatsApp webhook SKELETON. // VERIFY AGAINST OFFICIAL DOCS: `X-Hub-Signature-256: sha256=<hex HMAC of raw body with the
 * app secret>`, `entry[].changes[].value.messages[]` / `.statuses[]` shapes, GET verification (`hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`).
 */
export class MetaInboundProvider implements InboundProvider {
  readonly name = 'meta';
  verify(raw: Buffer, h: Headers) {
    const secret = process.env.WHATSAPP_APP_SECRET || '';
    return !!secret && safeEq(hdr(h, 'x-hub-signature-256'), `sha256=${commHmac(secret, raw)}`);
  }
  challenge(q: Record<string, string | undefined>) {
    const token = process.env.WHATSAPP_VERIFY_TOKEN || '';
    return token && q['hub.mode'] === 'subscribe' && q['hub.verify_token'] && safeEq(q['hub.verify_token'], token) ? (q['hub.challenge'] ?? '').slice(0, 200) : null;
  }
  parse(raw: Buffer): InboundEvent[] {
    type V = { metadata?: { phone_number_id?: string }; messages?: Array<{ id: string; from: string; timestamp?: string; type?: string; text?: { body?: string } }>; statuses?: Array<{ id: string; status: string; timestamp?: string }> };
    const b = JSON.parse(raw.toString('utf8')) as { entry?: Array<{ changes?: Array<{ value?: V }> }> };
    const out: InboundEvent[] = [];
    const ts = (t?: string) => (t && /^\d+$/.test(t) ? new Date(Number(t) * 1000) : null);
    for (const en of b.entry ?? []) for (const ch of en.changes ?? []) {
      const account = ch.value?.metadata?.phone_number_id ?? null;
      for (const m of ch.value?.messages ?? []) out.push({ eventId: `msg:${m.id}`, kind: 'message', channel: 'whatsapp', from: `+${m.from}`, text: (m.text?.body ?? `[${m.type ?? 'media'}]`).slice(0, 4096), providerRef: m.id, at: ts(m.timestamp), account });
      for (const s of ch.value?.statuses ?? []) if (['delivered', 'read', 'failed'].includes(s.status)) out.push({ eventId: `st:${s.id}:${s.status}`, kind: 'status', channel: 'whatsapp', providerRef: s.id, status: s.status as 'delivered', at: ts(s.timestamp), account });
    }
    return out;
  }
}
export const INBOUND_PROVIDERS = 'COMM_INBOUND_PROVIDERS';
export const inboundProvidersFactory = (): Record<string, InboundProvider> => ({ mock: new MockInboundProvider(), meta: new MetaInboundProvider() });
/** The mock webhook route exists only outside production and only while WhatsApp/SMS are on the mock adapters (D100). */
export const mockInboundAllowed = () => process.env.NODE_ENV !== 'production' && commProvider('whatsapp') === 'mock' && commProvider('sms') === 'mock';

/** Boot-time guard: production refuses mock channels and default/empty webhook secrets. */
export function assertCommConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  if (commProvider('whatsapp') === 'meta' && !process.env.WHATSAPP_APP_SECRET) throw new Error('WHATSAPP_APP_SECRET is required in production');
  if (process.env.COMM_WEBHOOK_SECRET === DEV_COMM_WEBHOOK_SECRET) throw new Error('COMM_WEBHOOK_SECRET must not be the dev default in production');
}

// ---------------- Gmail / Outlook OAuth (mail + calendar) ----------------

export type OAuthTokens = { accessToken: string; refreshToken: string | null; expiresAt: Date | null; accountEmail: string; scopes: string[] };
export type ExternalMail = { id: string; from: string; to: string; subject: string; text: string; at: Date };
export type ExternalEvent = { id: string; etag: string; title: string; startsAt: Date; endsAt: Date; allDay: boolean; cancelled?: boolean };
export interface OAuthProvider {
  readonly name: 'mock' | 'google' | 'microsoft';
  authUrl(state: string, redirectUri: string, purpose: 'mail' | 'calendar'): string;
  exchange(code: string, redirectUri: string, purpose: 'mail' | 'calendar'): Promise<OAuthTokens>;
  fetchMail(accessToken: string, cursor: string | null): Promise<{ messages: ExternalMail[]; cursor: string | null }>;
  listEvents(accessToken: string, cursor: string | null): Promise<{ events: ExternalEvent[]; cursor: string | null }>;
  /** Creates/updates an event; `etag` mismatch → `{ conflict: true }` (the external copy wins, D103). */
  upsertEvent(accessToken: string, ev: { externalId: string | null; etag: string | null; title: string; startsAt: Date; endsAt: Date; allDay: boolean }): Promise<{ id: string; etag: string } | { conflict: true }>;
  /** Revokes the grant at the provider. */
  revoke(accessToken: string): Promise<void>;
}
export const OAUTH_PROVIDERS = 'COMM_OAUTH_PROVIDERS';

/** In-memory provider for dev/tests: code `mock:<email>` → tokens; tests queue mail/events per account. */
export class MockOAuthProvider implements OAuthProvider {
  readonly name = 'mock' as const;
  readonly inbox = new Map<string, ExternalMail[]>();
  readonly events = new Map<string, ExternalEvent[]>();
  readonly pushed: Array<{ account: string; title: string; externalId: string }> = [];
  readonly revoked: string[] = [];
  async revoke(t: string) { this.revoked.push(t); this.tokens.delete(t); }
  /** Test hook: every token handed out (to assert none leaks into audit/logs/sync). */
  readonly issued: string[] = [];
  private tokens = new Map<string, string>();
  authUrl(state: string, redirectUri: string, purpose: string) { return `https://oauth.example.invalid/authorize?purpose=${purpose}&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`; }
  async exchange(code: string): Promise<OAuthTokens> {
    const m = /^mock:(.+@.+)$/.exec(code);
    if (!m) throw new Error('invalid_grant');
    const accessToken = `mock-at-${randomBytes(12).toString('hex')}`;
    this.tokens.set(accessToken, m[1]!);
    const refreshToken = `mock-rt-${randomBytes(12).toString('hex')}`;
    this.issued.push(accessToken, refreshToken);
    return { accessToken, refreshToken, expiresAt: null, accountEmail: m[1]!, scopes: ['mail.read', 'calendar'] };
  }
  private account(t: string) { const a = this.tokens.get(t); if (!a) throw new Error('invalid_token'); return a; }
  async fetchMail(t: string, cursor: string | null) {
    const all = this.inbox.get(this.account(t)) ?? [];
    const from = cursor ? Number(cursor) : 0;
    return { messages: all.slice(from), cursor: String(all.length) };
  }
  async listEvents(t: string) { return { events: [...(this.events.get(this.account(t)) ?? [])], cursor: null }; }
  async upsertEvent(t: string, ev: { externalId: string | null; etag: string | null; title: string; startsAt: Date; endsAt: Date; allDay: boolean }) {
    const acc = this.account(t);
    const list = this.events.get(acc) ?? []; this.events.set(acc, list);
    const cur = ev.externalId ? list.find((x) => x.id === ev.externalId) : undefined;
    if (cur && ev.etag && cur.etag !== ev.etag) return { conflict: true as const };
    const id = cur?.id ?? `ext-${list.length + 1}`; const etag = `e${Date.now().toString(36)}${list.length}`;
    const next = { id, etag, title: ev.title, startsAt: ev.startsAt, endsAt: ev.endsAt, allDay: ev.allDay };
    if (cur) Object.assign(cur, next); else list.push(next);
    this.pushed.push({ account: acc, title: ev.title, externalId: id });
    return { id, etag };
  }
}

/**
 * Google (Gmail API + Calendar API) / Microsoft (Graph) OAuth SKELETONS: authorization URL + code exchange only.
 * // VERIFY AGAINST OFFICIAL DOCS: endpoints, scopes (gmail.readonly, calendar.events / Mail.Read, Calendars.ReadWrite, offline_access),
 * refresh-token rotation, incremental sync tokens (historyId / deltaLink) and event etag semantics. Mail fetch/calendar sync are not built.
 */
class HttpOAuthProvider implements OAuthProvider {
  constructor(readonly name: 'google' | 'microsoft', private cfg: { auth: string; token: string; scopes: Record<'mail' | 'calendar', string>; id: string; secret: string }) {}
  authUrl(state: string, redirectUri: string, purpose: 'mail' | 'calendar') {
    const q = new URLSearchParams({ client_id: process.env[this.cfg.id] ?? '', redirect_uri: redirectUri, response_type: 'code', scope: this.cfg.scopes[purpose], state, access_type: 'offline', prompt: 'consent' });
    return `${this.cfg.auth}?${q.toString()}`;
  }
  async exchange(code: string, redirectUri: string): Promise<OAuthTokens> {
    const id = process.env[this.cfg.id]; const secret = process.env[this.cfg.secret];
    if (!id || !secret) throw new Error(`${this.name} OAuth is not configured`);
    const res = await fetch(this.cfg.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirectUri, grant_type: 'authorization_code' }).toString() });
    if (!res.ok) throw new Error(`token exchange ${res.status}`);
    const j = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string };
    let email = '';
    try { email = j.id_token ? String((JSON.parse(Buffer.from(j.id_token.split('.')[1]!, 'base64url').toString('utf8')) as { email?: string }).email ?? '') : ''; } catch { email = ''; }
    return { accessToken: j.access_token, refreshToken: j.refresh_token ?? null, expiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : null, accountEmail: email, scopes: (j.scope ?? '').split(/\s+/).filter(Boolean) };
  }
  /** // VERIFY AGAINST OFFICIAL DOCS: Google `POST https://oauth2.googleapis.com/revoke?token=…`; Microsoft has no token revoke endpoint (revoke sessions via Graph). */
  async revoke(token: string) {
    if (this.name !== 'google') return;
    const res = await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (!res.ok) throw new Error(`revoke ${res.status}`);
  }
  async fetchMail(): Promise<never> { throw new Error(`${this.name} mail fetch not implemented`); }
  async listEvents(): Promise<never> { throw new Error(`${this.name} calendar sync not implemented`); }
  async upsertEvent(): Promise<never> { throw new Error(`${this.name} calendar sync not implemented`); }
}
export const oauthProvidersFactory = (): Record<string, OAuthProvider> => ({
  mock: new MockOAuthProvider(),
  google: new HttpOAuthProvider('google', { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET',
    scopes: { mail: 'openid email https://www.googleapis.com/auth/gmail.readonly', calendar: 'openid email https://www.googleapis.com/auth/calendar.events' } }),
  microsoft: new HttpOAuthProvider('microsoft', { auth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', id: 'MS_CLIENT_ID', secret: 'MS_CLIENT_SECRET',
    scopes: { mail: 'openid email offline_access Mail.Read', calendar: 'openid email offline_access Calendars.ReadWrite' } }),
});
/** Mock OAuth only outside production. */
export const mockOAuthAllowed = () => process.env.NODE_ENV !== 'production';
