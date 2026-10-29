import { HttpException, HttpStatus, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { canIssueOtp, maskAddress, otpFailure, otpVerifyOutcome, PORTAL_OTP, portalIdentifier } from '@worko/domain';
import { timingSafeEqual } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import type { PortalActor } from '../auth/context.js';
import { numericCode, randomToken, sha256 } from '../auth/crypto.js';
import { TokenService } from '../auth/token.service.js';
import { COMM_CHANNELS_TOKEN, type ChannelAdapters } from '../comm/channels.js';
import { Clock } from '../common/clock.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { loadPortalSettings } from './common.js';

export type PortalDevice = { platform: 'web' | 'android'; label?: string };
export type PortalTokens = { accessToken: string; refreshToken: string; expiresIn: number; sessionId: string; portalUserId: string; tenantId: string };
const bad = () => new UnauthorizedException('Invalid or expired code');
const locked = () => new HttpException('Too many attempts. Try again later.', HttpStatus.TOO_MANY_REQUESTS);
const REFRESH_TTL_DAYS = 30;

/**
 * Portal sign-in (D127): one-time codes to an invited contact's email or mobile. Responses never reveal whether a firm,
 * person or access exists; codes are hashed, short-lived, single-use, capped per hour; repeated failures lock the account.
 * Times come from the injectable Clock (tests pin it — no wall clock).
 */
@Injectable()
export class PortalAuthService {
  constructor(private db: DbService, private tokens: TokenService, private audit: AuditService, private clock: Clock,
    @Inject(COMM_CHANNELS_TOKEN) private adapters: ChannelAdapters) {}

  async tenantBySlug(firm: string): Promise<{ id: string; name: string; slug: string } | null> {
    const r = await this.db.systemTx((tx) => tx.query('SELECT id, name, slug FROM tenant WHERE slug = $1', [firm.toLowerCase()]));
    return r.rows[0] ?? null;
  }

  private findUser(tx: Tx, kind: 'email' | 'phone', value: string) {
    return tx.query(`SELECT u.* FROM portal_user u WHERE ${kind === 'email' ? 'u.email' : 'u.phone'} = $1 AND u.status IN ('invited','active')
      AND EXISTS (SELECT 1 FROM portal_access a JOIN client c ON c.id = a.client_id WHERE a.portal_user_id = u.id AND a.revoked_at IS NULL AND c.portal_enabled AND c.deleted_at IS NULL)`, [value]);
  }

  /** Always "sent" to the caller. Only an invited/active user with at least one live client access gets a code. */
  async requestOtp(firm: string, identifier: string): Promise<void> {
    const id = portalIdentifier(identifier);
    const t = id ? await this.tenantBySlug(firm) : null;
    if (!id || !t) return;
    const now = this.clock.now();
    const send = await this.db.tenantTx(t.id, async (tx) => {
      const u = (await this.findUser(tx, id.kind, id.value)).rows[0];
      if (!u) return null;
      const recent = (await tx.query(`SELECT count(*)::int AS n FROM portal_otp WHERE portal_user_id = $1 AND created_at > $2::timestamptz - interval '1 hour'`, [u.id, now])).rows[0].n;
      if (!canIssueOtp(recent, u.locked_until, now)) {
        await this.audit.record(tx, t.id, { actorId: null, deviceId: 'portal', action: 'portal.otp_suppressed', entity: 'portal_user', entityId: u.id, diff: { reason: u.locked_until > now ? 'locked' : 'hourly_cap' } });
        return null;
      }
      // A new code retires the open ones (no extra guesses by asking again).
      await tx.query('UPDATE portal_otp SET consumed_at = $2 WHERE portal_user_id = $1 AND consumed_at IS NULL', [u.id, now]);
      const code = numericCode(6); const otpId = uuidv7();
      const channel = id.kind === 'email' ? 'email' : 'sms';
      await tx.query(`INSERT INTO portal_otp (id, tenant_id, portal_user_id, channel, code_hash, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6, $6::timestamptz + make_interval(mins => $7))`,
        [otpId, t.id, u.id, channel, sha256(`${u.id}:${code}`), now, PORTAL_OTP.ttlMinutes]);
      await this.audit.record(tx, t.id, { actorId: null, deviceId: 'portal', action: 'portal.otp_requested', entity: 'portal_user', entityId: u.id, diff: { channel } });
      const s = await loadPortalSettings(tx);
      return { otpId, code, channel: channel as 'email' | 'sms', brand: s.displayName ?? t.name };
    });
    if (!send) return;
    // Straight to the channel adapter: the code must never be stored in the message log / client timeline.
    try {
      await this.adapters[send.channel].send({ tenantId: t.id, channel: send.channel, to: id.value, subject: `${send.brand}: your sign-in code`,
        text: `${send.code} is your ${send.brand} client portal code. It expires in ${PORTAL_OTP.ttlMinutes} minutes. Never share it.`, idempotencyKey: `portal-otp:${send.otpId}` });
    } catch { /* delivery failures look the same to the caller */ }
    // Local development only (mock channel, explicit opt-in): show the code in the API log so the demo portal can be tried without a mailbox.
    if (this.adapters[send.channel].name === 'mock' && process.env.NODE_ENV === 'development' && process.env.PORTAL_DEV_LOG_OTP === '1') {
      new Logger('PortalOtp').warn(`[dev only] code for ${maskAddress(id.value)}: ${send.code}`);
    }
  }

  async verifyOtp(firm: string, identifier: string, code: string, device: PortalDevice, meta: { ip: string | null; userAgent?: string }): Promise<PortalTokens> {
    const id = portalIdentifier(identifier);
    const t = id ? await this.tenantBySlug(firm) : null;
    if (!id || !t) throw bad();
    const now = this.clock.now();
    const out = await this.db.tenantTx(t.id, async (tx) => {
      const u = (await this.findUser(tx, id.kind, id.value)).rows[0];
      if (!u) return { error: bad() };
      const c = (await tx.query(`SELECT * FROM portal_otp WHERE portal_user_id = $1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [u.id])).rows[0] ?? null;
      const expect = c ? Buffer.from(c.code_hash) : null; const got = Buffer.from(sha256(`${u.id}:${code}`));
      const match = !!expect && expect.length === got.length && timingSafeEqual(expect, got);
      const o = otpVerifyOutcome({ lockedUntil: u.locked_until, failedLogins: u.failed_logins, challenge: c && { attempts: c.attempts, expiresAt: c.expires_at, consumedAt: c.consumed_at } }, match, now);
      if (o === 'locked') return { error: locked() };
      if (o === 'invalid') {
        if (c) await tx.query('UPDATE portal_otp SET attempts = attempts + 1 WHERE id = $1', [c.id]);
        const f = otpFailure(u.failed_logins, now);
        await tx.query('UPDATE portal_user SET failed_logins = $2, locked_until = $3 WHERE id = $1', [u.id, f.failedLogins, f.lockedUntil]);
        await this.audit.record(tx, t.id, { actorId: null, deviceId: 'portal', action: f.lockedUntil ? 'portal.locked' : 'portal.otp_failed', entity: 'portal_user', entityId: u.id, ip: meta.ip });
        return { error: f.lockedUntil ? locked() : bad() };
      }
      await tx.query('UPDATE portal_otp SET consumed_at = $2 WHERE id = $1', [c.id, now]);
      await tx.query(`UPDATE portal_user SET failed_logins = 0, locked_until = NULL, status = 'active', last_login_at = $2, version = version + 1, updated_at = now() WHERE id = $1`, [u.id, now]);
      return { pair: await this.openSession(tx, t.id, u.id, device, meta) };
    });
    if ('error' in out) throw out.error; // after commit: failure counters persist
    return out.pair!;
  }

  private async openSession(tx: Tx, tenantId: string, userId: string, device: PortalDevice, meta: { ip: string | null; userAgent?: string }): Promise<PortalTokens> {
    const sid = uuidv7();
    const refresh = `${tenantId}.${randomToken()}`;
    await tx.query(`INSERT INTO portal_session (id, tenant_id, portal_user_id, platform, label, refresh_token_hash, last_seen_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6, now(), $7, $8)`,
      [sid, tenantId, userId, device.platform, device.label ?? null, sha256(refresh), meta.ip, meta.userAgent?.slice(0, 300) ?? null]);
    await this.insertRefresh(tx, tenantId, sid, refresh);
    await this.audit.record(tx, tenantId, { actorId: null, deviceId: `portal:${sid}`, action: 'portal.login', entity: 'portal_session', entityId: sid, diff: { portalUserId: userId, platform: device.platform }, ip: meta.ip });
    return { accessToken: await this.tokens.signPortal({ sub: userId, tid: tenantId, sid }), refreshToken: refresh, expiresIn: TokenService.ACCESS_TTL_S, sessionId: sid, portalUserId: userId, tenantId };
  }

  private insertRefresh(tx: Tx, tenantId: string, sid: string, token: string) {
    return tx.query(`INSERT INTO portal_refresh_token (hash, tenant_id, session_id, expires_at) VALUES ($1,$2,$3, now() + make_interval(days => $4))`, [sha256(token), tenantId, sid, REFRESH_TTL_DAYS]);
  }

  /** Rotation with reuse detection (a replayed refresh token revokes the session), as for staff. */
  async refresh(refreshToken: string): Promise<PortalTokens> {
    const tenantId = refreshToken.split('.')[0] ?? '';
    if (!/^[0-9a-f-]{36}$/.test(tenantId)) throw new UnauthorizedException();
    const out = await this.db.tenantTx(tenantId, async (tx) => {
      const r = (await tx.query(`SELECT t.session_id, t.rotated_at, t.expires_at, s.portal_user_id, s.revoked_at, u.status FROM portal_refresh_token t
        JOIN portal_session s ON s.id = t.session_id JOIN portal_user u ON u.id = s.portal_user_id WHERE t.hash = $1 FOR UPDATE OF t`, [sha256(refreshToken)])).rows[0];
      if (!r || r.revoked_at || r.expires_at < new Date() || r.status !== 'active') return { error: new UnauthorizedException() };
      if (r.rotated_at) {
        await tx.query('UPDATE portal_session SET revoked_at = now() WHERE id = $1', [r.session_id]);
        await this.audit.record(tx, tenantId, { actorId: null, deviceId: `portal:${r.session_id}`, action: 'portal.refresh_reuse_detected', entity: 'portal_session', entityId: r.session_id });
        return { error: new UnauthorizedException() };
      }
      const next = `${tenantId}.${randomToken()}`;
      await tx.query('UPDATE portal_refresh_token SET rotated_at = now() WHERE hash = $1', [sha256(refreshToken)]);
      await this.insertRefresh(tx, tenantId, r.session_id, next);
      await tx.query('UPDATE portal_session SET refresh_token_hash = $2, last_seen_at = now() WHERE id = $1', [r.session_id, sha256(next)]);
      return { pair: { accessToken: await this.tokens.signPortal({ sub: r.portal_user_id, tid: tenantId, sid: r.session_id }), refreshToken: next,
        expiresIn: TokenService.ACCESS_TTL_S, sessionId: r.session_id as string, portalUserId: r.portal_user_id as string, tenantId } };
    });
    if ('error' in out) throw out.error;
    return out.pair!;
  }

  async logout(p: PortalActor) {
    await this.db.tenantTx(p.tenantId, async (tx) => {
      await tx.query('UPDATE portal_session SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1', [p.sessionId]);
      await this.audit.record(tx, p.tenantId, { actorId: null, deviceId: `portal:${p.sessionId}`, action: 'portal.logout', entity: 'portal_session', entityId: p.sessionId });
    });
  }
}
