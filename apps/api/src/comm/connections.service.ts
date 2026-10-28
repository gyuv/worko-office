import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { maskAddress, normalizeEmail } from '@worko/domain';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { publicBase } from '../billing/providers.js';
import { Clock } from '../common/clock.js';
import { KeyService } from '../crypto/key.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { SyncService } from '../sync/sync.service.js';
import { mockOAuthAllowed, OAUTH_PROVIDERS, type OAuthProvider } from './channels.js';
import { matchAddress } from './common.js';

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const STATE_TTL_MS = 15 * 60_000;
const out = (r: Record<string, unknown>) => ({ id: r.id, provider: r.provider, purpose: r.purpose, status: r.status, accountEmail: r.account_email, scopes: r.scopes,
  lastSyncAt: r.last_sync_at, lastError: r.last_error, createdAt: r.created_at });

/**
 * Gmail/Outlook mailbox + calendar connections (D103). Tokens exist in plaintext only in memory: stored as KeyService
 * ciphertext (AAD `oauth_connection:<id>:access|refresh`), never returned, synced, audited or logged.
 */
@Injectable()
export class ConnectionsService {
  constructor(private db: DbService, private audit: AuditService, private keys: KeyService, private sync: SyncService, private realtime: RealtimeService, private clock: Clock,
    @Inject(OAUTH_PROVIDERS) private providers: Record<string, OAuthProvider>) {}

  private provider(name: string) {
    const p = this.providers[name];
    if (!p || (name === 'mock' && !mockOAuthAllowed())) throw new BadRequestException({ message: 'Unknown provider', code: 'bad_provider' });
    return p;
  }
  private redirect() { return `${publicBase()}/comm/oauth/callback`; }
  private staff(a: RequestActor) { if (!a.roles.length && !a.superAdmin) throw new ForbiddenException(); }

  list(a: RequestActor) {
    this.staff(a);
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(`SELECT id, provider, purpose, status, account_email, scopes, last_sync_at, last_error, created_at FROM oauth_connection
      WHERE user_id = $1 AND status <> 'revoked' ORDER BY created_at DESC`, [a.userId])).rows.map(out));
  }
  /** Starts the OAuth dance: a pending row bound to a single-use state (`tenant.connection.nonce`, only its hash stored). */
  async start(a: RequestActor, b: { provider: 'mock' | 'google' | 'microsoft'; purpose: 'mail' | 'calendar' }) {
    this.staff(a);
    const p = this.provider(b.provider);
    const id = uuidv7(); const state = `${a.tenantId}.${id}.${randomBytes(24).toString('base64url')}`;
    await this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query(`INSERT INTO oauth_connection (id, tenant_id, user_id, provider, purpose, state_hash, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, a.tenantId, a.userId, b.provider, b.purpose, sha(state), this.clock.now()]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'oauth.started', entity: 'oauth_connection', entityId: id, diff: { provider: b.provider, purpose: b.purpose } });
    });
    return { id, authUrl: p.authUrl(state, this.redirect(), b.purpose) };
  }
  /** Public redirect target: verifies the state (hash, age, single use), exchanges the code, stores tokens encrypted. */
  async callback(q: { state?: string; code?: string; error?: string }) {
    const [tenantId, id, nonce] = (q.state ?? '').split('.');
    if (!tenantId || !id || !nonce || !isUuid(tenantId) || !isUuid(id)) throw new NotFoundException();
    if (!(await this.db.systemTx((tx) => tx.query('SELECT 1 FROM tenant WHERE id = $1', [tenantId]))).rowCount) throw new NotFoundException();
    const now = this.clock.now();
    const pending = await this.db.tenantTx(tenantId, async (tx) => {
      const c = (await tx.query(`SELECT * FROM oauth_connection WHERE id = $1 AND status = 'pending' FOR UPDATE`, [id])).rows[0];
      const want = Buffer.from(c?.state_hash ?? ''); const got = Buffer.from(sha(q.state!));
      if (!c || want.length !== got.length || !timingSafeEqual(want, got)) return null;
      // Single use: the state is burnt before the (slow, external) exchange.
      await tx.query(`UPDATE oauth_connection SET state_hash = NULL, updated_at = $2 WHERE id = $1`, [id, now]);
      if (now.getTime() - new Date(c.created_at).getTime() > STATE_TTL_MS || q.error || !q.code) {
        await tx.query(`UPDATE oauth_connection SET status = 'error', last_error = $2 WHERE id = $1`, [id, q.error ? 'denied' : 'expired']);
        return 'failed' as const;
      }
      return c;
    });
    if (!pending) throw new NotFoundException();
    if (pending === 'failed') throw new ConflictException({ message: 'Authorisation expired or was denied', code: 'oauth_failed' });
    let tokens;
    try { tokens = await this.provider(pending.provider).exchange(q.code!, this.redirect(), pending.purpose); } catch {
      await this.db.tenantTx(tenantId, (tx) => tx.query(`UPDATE oauth_connection SET status = 'error', last_error = 'exchange_failed' WHERE id = $1`, [id]));
      throw new ConflictException({ message: 'Could not complete the connection', code: 'oauth_failed' });
    }
    await this.db.tenantTx(tenantId, async (tx) => {
      await tx.query(`UPDATE oauth_connection SET status = 'active', account_email = $2, scopes = $3, access_token_enc = $4, refresh_token_enc = $5, expires_at = $6, last_error = NULL, updated_at = $7 WHERE id = $1`,
        [id, normalizeEmail(tokens.accountEmail) ?? tokens.accountEmail, tokens.scopes, await this.keys.encrypt(tx, tenantId, tokens.accessToken, `oauth_connection:${id}:access`),
          tokens.refreshToken ? await this.keys.encrypt(tx, tenantId, tokens.refreshToken, `oauth_connection:${id}:refresh`) : null, tokens.expiresAt, now]);
      await this.audit.record(tx, tenantId, { actorId: pending.user_id, deviceId: 'server', action: 'oauth.connected', entity: 'oauth_connection', entityId: id,
        diff: { provider: pending.provider, purpose: pending.purpose, account: tokens.accountEmail ? maskAddress(tokens.accountEmail) : null, scopes: tokens.scopes } });
    });
    return { status: 'connected', provider: pending.provider, purpose: pending.purpose };
  }
  async revoke(a: RequestActor, id: string) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await tx.query(`UPDATE oauth_connection SET status = 'revoked', access_token_enc = NULL, refresh_token_enc = NULL, state_hash = NULL, updated_at = $3 WHERE id = $1 AND user_id = $2 AND status <> 'revoked'`, [id, a.userId, this.clock.now()]);
      if (!r.rowCount) throw new NotFoundException();
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'oauth.revoked', entity: 'oauth_connection', entityId: id });
    });
  }
  private async accessToken(tx: Tx, tenantId: string, c: Record<string, unknown>) {
    if (!c.access_token_enc) throw new ConflictException({ message: 'Connection has no token', code: 'not_connected' });
    return this.keys.decrypt(tx, tenantId, c.access_token_enc as Buffer, `oauth_connection:${c.id}:access`);
  }

  /** Mail: pull new messages into client timelines (matched by sender) or the triage inbox. Calendar: two-way sync. */
  async syncNow(a: RequestActor, id: string) {
    this.staff(a);
    const now = this.clock.now();
    const { c, token } = await this.db.tenantTx(a.tenantId, async (tx) => {
      const c = (await tx.query(`SELECT * FROM oauth_connection WHERE id = $1 AND user_id = $2 AND status = 'active'`, [id, a.userId])).rows[0];
      if (!c) throw new NotFoundException();
      return { c, token: await this.accessToken(tx, a.tenantId, c) };
    });
    const p = this.provider(c.provider);
    return c.purpose === 'mail' ? this.syncMail(a, c, p, token, now) : this.syncCalendar(a, c, p, token, now);
  }

  private async syncMail(a: RequestActor, c: Record<string, unknown>, p: OAuthProvider, token: string, now: Date) {
    const { messages, cursor } = await p.fetchMail(token, (c.sync_cursor_ext as string) ?? null);
    return this.db.tenantTx(a.tenantId, async (tx) => {
      let matched = 0; let unmatched = 0; let dup = 0;
      const own = String(c.account_email ?? '');
      for (const m of messages) {
        const from = normalizeEmail(m.from.replace(/^.*<([^>]+)>.*$/, '$1'));
        if (!from) continue;
        const out = from === own;
        const counterpart = out ? normalizeEmail(m.to.replace(/^.*<([^>]+)>.*$/, '$1')) : from;
        const match = counterpart ? await matchAddress(tx, 'email', counterpart) : { clientId: null, contactId: null, ambiguous: false };
        const r = await tx.query(`INSERT INTO comm_message (id, tenant_id, client_id, contact_id, direction, channel, address, subject, body, status, provider, provider_ref, triage, occurred_at, created_by, device_id)
          VALUES ($1,$2,$3,$4,$5,'email',$6,$7,$8,$9,$10,$11,$12,$13,$14,'server') ON CONFLICT (tenant_id, provider, provider_ref) WHERE provider_ref IS NOT NULL AND direction = 'in' DO NOTHING RETURNING id`,
          [uuidv7(), a.tenantId, match.clientId, match.contactId, out ? 'out' : 'in', counterpart, m.subject.slice(0, 500), m.text.slice(0, 20_000), out ? 'sent' : 'received',
            `${c.provider}:mail:${c.id}`, m.id, match.clientId || out ? null : match.ambiguous ? 'ambiguous' : 'unmatched', m.at, a.userId]);
        if (!r.rowCount) { dup++; continue; }
        if (match.clientId) matched++; else unmatched++;
      }
      await tx.query('UPDATE oauth_connection SET sync_cursor_ext = $2, last_sync_at = $3, last_error = NULL WHERE id = $1', [c.id, cursor, now]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'oauth.mail_synced', entity: 'oauth_connection', entityId: String(c.id), diff: { fetched: messages.length, matched, unmatched, duplicates: dup } });
      return { fetched: messages.length, matched, unmatched, duplicates: dup };
    });
  }

  /**
   * Two-way calendar sync (D103 conflict policy): external events are mirrored read-only (`kind = external`); Worko
   * meetings are pushed; when both sides changed an event since the last sync, the external copy wins (etag mismatch)
   * and the local event is overwritten from it.
   */
  private async syncCalendar(a: RequestActor, c: Record<string, unknown>, p: OAuthProvider, token: string, now: Date) {
    const { events } = await p.listEvents(token, null);
    let pulled = 0; let pushed = 0; let conflicts = 0; let cursor = 0;
    await this.db.tenantTx(a.tenantId, async (tx) => {
      for (const e of events) {
        const cur = (await tx.query('SELECT * FROM calendar_event WHERE external_connection_id = $1 AND external_id = $2 FOR UPDATE', [c.id, e.id])).rows[0];
        if (cur && cur.external_etag === e.etag && !cur.deleted_at) continue;
        if (!cur) {
          if (e.cancelled) continue;
          const r = await tx.query(`INSERT INTO calendar_event (id, tenant_id, owner_id, kind, title, starts_at, ends_at, all_day, external_connection_id, external_id, external_etag, device_id)
            VALUES ($1,$2,$3,'external',$4,$5,$6,$7,$8,$9,$10,'server') RETURNING sync_cursor`, [uuidv7(), a.tenantId, a.userId, e.title.slice(0, 300), e.startsAt, e.endsAt, e.allDay, c.id, e.id, e.etag]);
          cursor = Math.max(cursor, Number(r.rows[0].sync_cursor)); pulled++;
          continue;
        }
        if (cur.kind !== 'external' && c.last_sync_at && cur.updated_at > (c.last_sync_at as Date)) conflicts++; // both changed → external wins
        const res = e.cancelled
          ? { cursor: Number((await tx.query('UPDATE calendar_event SET deleted_at = now() WHERE id = $1 RETURNING sync_cursor', [cur.id])).rows[0].sync_cursor) }
          : await this.sync.serverPatch(tx, a, 'calendar_event', cur.id, { title: e.title.slice(0, 300), starts_at: e.startsAt, ends_at: e.endsAt, all_day: e.allDay });
        await tx.query('UPDATE calendar_event SET external_etag = $2 WHERE id = $1', [cur.id, e.etag]);
        cursor = Math.max(cursor, res?.cursor ?? 0); pulled++;
      }
      // Push own meetings created or changed in Worko since the last sync.
      const mine = (await tx.query(`SELECT * FROM calendar_event WHERE owner_id = $1 AND kind = 'meeting' AND deleted_at IS NULL AND (external_connection_id IS NULL OR (external_connection_id = $2 AND ($3::timestamptz IS NULL OR updated_at > $3)))
        ORDER BY starts_at LIMIT 500`, [a.userId, c.id, c.last_sync_at ?? null])).rows;
      for (const ev of mine) {
        // Client names never leave Worko in pushed titles (D103).
        const r = await p.upsertEvent(token, { externalId: ev.external_connection_id ? ev.external_id : null, etag: ev.external_etag, title: ev.client_id ? 'Client meeting' : ev.title, startsAt: ev.starts_at, endsAt: ev.ends_at, allDay: ev.all_day });
        if ('conflict' in r) { conflicts++; continue; }
        await tx.query('UPDATE calendar_event SET external_connection_id = $2, external_id = $3, external_etag = $4 WHERE id = $1', [ev.id, c.id, r.id, r.etag]);
        pushed++;
      }
      await tx.query('UPDATE oauth_connection SET last_sync_at = $2, last_error = NULL WHERE id = $1', [c.id, now]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'oauth.calendar_synced', entity: 'oauth_connection', entityId: String(c.id), diff: { pulled, pushed, conflicts } });
    });
    if (cursor) this.realtime.publish({ type: 'changed', tenantId: a.tenantId, cursor, userIds: [a.userId] });
    return { pulled, pushed, conflicts };
  }
}
