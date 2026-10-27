import { HttpException, HttpStatus, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import type { Role } from '@worko/domain';
import type { RequestActor } from './context.js';
import { loadUserRoles } from './roles.repo.js';
import { base32Encode, hashPassword, numericCode, randomToken, sha256, verifyPassword, verifyTotp } from './crypto.js';
import { decryptField, encryptField } from './field-crypto.js';
import { SMS_PROVIDER, type SmsProvider } from './sms.provider.js';
import { TokenService } from './token.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';

export type Device = { platform: 'web' | 'desktop' | 'android'; label?: string; deviceId?: string };
export type Meta = { ip: string | null; userAgent?: string };
export type TokenPair = { accessToken: string; refreshToken: string; expiresIn: number; sessionId: string; userId: string; tenantId: string };

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const OTP_TTL_MIN = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_HOUR = 5;

/** A generic failure so responses don't reveal whether the firm or user exists. */
const badCredentials = () => new UnauthorizedException('Invalid credentials');

@Injectable()
export class AuthService {
  constructor(
    private db: DbService, private tokens: TokenService, private audit: AuditService,
    @Inject(SMS_PROVIDER) private sms: SmsProvider, private realtime: RealtimeService,
  ) {}

  async tenantIdBySlug(slug: string): Promise<string | null> {
    const r = await this.db.systemTx((tx) => tx.query<{ id: string }>('SELECT id FROM tenant WHERE slug = $1', [slug.toLowerCase()]));
    return r.rows[0]?.id ?? null;
  }

  /** Every wrong secret (password, TOTP, OTP) counts toward the same per-user lockout. */
  private async recordFailure(tx: Tx, tenantId: string, userId: string, failed: number, action: string, ip: string | null) {
    await tx.query(`UPDATE app_user SET failed_logins = $2::int, locked_until = CASE WHEN $2::int >= $3::int THEN now() + make_interval(mins => $4) END WHERE id = $1`,
      [userId, failed, MAX_FAILED, LOCK_MINUTES]);
    await this.audit.record(tx, tenantId, { actorId: userId, action: failed >= MAX_FAILED ? 'auth.locked' : action, entity: 'app_user', entityId: userId, ip });
  }

  async login(firm: string, email: string, password: string, totpCode: string | undefined, device: Device, meta: Meta): Promise<TokenPair> {
    const tenantId = await this.tenantIdBySlug(firm);
    if (!tenantId) { await hashPassword(password); throw badCredentials(); } // equalise timing
    const outcome = await this.db.tenantTx(tenantId, async (tx) => {
      const u = (await tx.query(
        `SELECT id, password_hash, status, failed_logins, locked_until, totp_enabled, totp_secret_enc, totp_last_step FROM app_user
         WHERE lower(email) = lower($1) AND deleted_at IS NULL AND kind = 'staff'`, [email])).rows[0];
      if (!u || !u.password_hash) { await hashPassword(password); return { error: badCredentials() }; }
      if (u.locked_until && u.locked_until > new Date()) {
        return { error: new HttpException('Account temporarily locked. Try again later.', HttpStatus.TOO_MANY_REQUESTS) };
      }
      if (u.status !== 'active' || !(await verifyPassword(password, u.password_hash))) {
        await this.recordFailure(tx, tenantId, u.id, u.failed_logins + 1, 'auth.login_failed', meta.ip);
        return { error: badCredentials() };
      }
      if (u.totp_enabled) {
        if (!totpCode) return { error: new UnauthorizedException({ code: 'MFA_REQUIRED', message: 'Enter the code from your authenticator app' }) };
        const step = verifyTotp(decryptField(u.totp_secret_enc, `totp:${u.id}`), totpCode);
        // Reject wrong codes and replays of an already-used time step; both count toward lockout.
        if (step === null || (u.totp_last_step !== null && step <= Number(u.totp_last_step))) {
          await this.recordFailure(tx, tenantId, u.id, u.failed_logins + 1, 'auth.mfa_failed', meta.ip);
          return { error: badCredentials() };
        }
        await tx.query('UPDATE app_user SET totp_last_step = $2 WHERE id = $1', [u.id, step]);
      }
      await tx.query('UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
      return { pair: await this.openSession(tx, tenantId, u.id, device, meta, 'password') };
    });
    if ('error' in outcome) throw outcome.error; // thrown after commit so lockout counters persist
    return outcome.pair!;
  }

  async requestOtp(firm: string, phone: string): Promise<void> {
    const tenantId = await this.tenantIdBySlug(firm);
    if (!tenantId) return; // silent: no enumeration
    await this.db.tenantTx(tenantId, async (tx) => {
      const u = (await tx.query(`SELECT id, phone, locked_until FROM app_user WHERE phone = $1 AND status = 'active' AND deleted_at IS NULL`, [phone])).rows[0];
      if (!u || (u.locked_until && u.locked_until > new Date())) return;
      // Cap codes per hour, and retire open challenges so a new request never grants extra guesses.
      const recent = (await tx.query(`SELECT count(*)::int AS n FROM otp_challenge WHERE user_id = $1 AND expires_at > now() - interval '1 hour' + make_interval(mins => $2)`, [u.id, OTP_TTL_MIN])).rows[0].n;
      if (recent >= OTP_MAX_PER_HOUR) return;
      await tx.query(`UPDATE otp_challenge SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL`, [u.id]);
      const code = numericCode(6);
      await tx.query(`INSERT INTO otp_challenge (id, tenant_id, user_id, code_hash, purpose, expires_at)
        VALUES ($1,$2,$3,$4,'login', now() + make_interval(mins => $5))`, [uuidv7(), tenantId, u.id, sha256(`${u.id}:${code}`), OTP_TTL_MIN]);
      await this.sms.send(u.phone, `${code} is your login code. Valid for ${OTP_TTL_MIN} minutes. Do not share it.`);
    });
  }

  async verifyOtp(firm: string, phone: string, code: string, device: Device, meta: Meta): Promise<TokenPair> {
    const tenantId = await this.tenantIdBySlug(firm);
    if (!tenantId) throw badCredentials();
    const outcome = await this.db.tenantTx(tenantId, async (tx) => {
      const c = (await tx.query(
        `SELECT c.id, c.user_id, c.code_hash, c.attempts, u.totp_enabled, u.failed_logins, u.locked_until FROM otp_challenge c JOIN app_user u ON u.id = c.user_id
         WHERE u.phone = $1 AND c.consumed_at IS NULL AND c.expires_at > now() AND c.purpose = 'login'
         ORDER BY c.expires_at DESC LIMIT 1 FOR UPDATE OF c`, [phone])).rows[0];
      if (!c || c.attempts >= OTP_MAX_ATTEMPTS) return { error: badCredentials() };
      if (c.locked_until && c.locked_until > new Date()) {
        return { error: new HttpException('Account temporarily locked. Try again later.', HttpStatus.TOO_MANY_REQUESTS) };
      }
      if (c.code_hash !== sha256(`${c.user_id}:${code}`)) {
        await tx.query('UPDATE otp_challenge SET attempts = attempts + 1 WHERE id = $1', [c.id]);
        await this.recordFailure(tx, tenantId, c.user_id, c.failed_logins + 1, 'auth.otp_failed', meta.ip);
        return { error: badCredentials() };
      }
      await tx.query('UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE id = $1', [c.user_id]);
      if (c.totp_enabled) return { error: new UnauthorizedException({ code: 'MFA_REQUIRED', message: 'Use password + authenticator login' }) };
      await tx.query('UPDATE otp_challenge SET consumed_at = now() WHERE id = $1', [c.id]);
      return { pair: await this.openSession(tx, tenantId, c.user_id, device, meta, 'otp') };
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.pair!;
  }

  private async openSession(tx: Tx, tenantId: string, userId: string, device: Device, meta: Meta, method: string): Promise<TokenPair> {
    const sid = uuidv7();
    const deviceId = device.deviceId ?? uuidv7();
    const refresh = `${tenantId}.${randomToken()}`;
    await tx.query(
      `INSERT INTO device_session (id, tenant_id, user_id, platform, label, refresh_token_hash, refresh_family, last_seen_at, ip, user_agent, device_id)
       VALUES ($1,$2,$3,$4,$5,$6,$1, now(), $7, $8, $9)`,
      [sid, tenantId, userId, device.platform, device.label ?? null, sha256(refresh), meta.ip, meta.userAgent ?? null, deviceId]);
    await this.insertRefresh(tx, tenantId, sid, refresh);
    await this.audit.record(tx, tenantId, { actorId: userId, deviceId, action: 'auth.login', entity: 'device_session', entityId: sid, diff: { method, platform: device.platform }, ip: meta.ip });
    return this.pair(tenantId, userId, sid, deviceId, refresh);
  }

  private insertRefresh(tx: Tx, tenantId: string, sid: string, token: string) {
    return tx.query(`INSERT INTO refresh_token (hash, tenant_id, session_id, expires_at) VALUES ($1,$2,$3, now() + make_interval(days => $4))`,
      [sha256(token), tenantId, sid, TokenService.REFRESH_TTL_DAYS]);
  }

  private async pair(tenantId: string, userId: string, sid: string, deviceId: string, refresh: string): Promise<TokenPair> {
    return {
      accessToken: await this.tokens.sign({ sub: userId, tid: tenantId, sid, dev: deviceId }),
      refreshToken: refresh, expiresIn: TokenService.ACCESS_TTL_S, sessionId: sid, userId, tenantId,
    };
  }

  /** Rotation with reuse detection: replaying an already-rotated token revokes the session. */
  async refresh(refreshToken: string, meta: Meta): Promise<TokenPair> {
    const tenantId = refreshToken.split('.')[0] ?? '';
    if (!/^[0-9a-f-]{36}$/.test(tenantId)) throw new UnauthorizedException();
    const outcome = await this.db.tenantTx(tenantId, async (tx) => {
      const t = (await tx.query(
        `SELECT t.session_id, t.rotated_at, t.expires_at, s.user_id, s.revoked_at, s.wipe_requested_at, s.device_id, u.status
         FROM refresh_token t JOIN device_session s ON s.id = t.session_id JOIN app_user u ON u.id = s.user_id
         WHERE t.hash = $1 FOR UPDATE OF t`, [sha256(refreshToken)])).rows[0];
      if (t?.wipe_requested_at) return { error: new UnauthorizedException({ code: 'DEVICE_WIPE', message: 'This device must erase local data' }) };
      if (!t || t.revoked_at || t.expires_at < new Date() || t.status !== 'active') return { error: new UnauthorizedException() };
      if (t.rotated_at) {
        await tx.query('UPDATE device_session SET revoked_at = now() WHERE id = $1', [t.session_id]);
        await this.audit.record(tx, tenantId, { actorId: t.user_id, action: 'auth.refresh_reuse_detected', entity: 'device_session', entityId: t.session_id, ip: meta.ip });
        return { error: new UnauthorizedException() };
      }
      const next = `${tenantId}.${randomToken()}`;
      await tx.query('UPDATE refresh_token SET rotated_at = now() WHERE hash = $1', [sha256(refreshToken)]);
      await this.insertRefresh(tx, tenantId, t.session_id, next);
      await tx.query('UPDATE device_session SET refresh_token_hash = $2, last_seen_at = now() WHERE id = $1', [t.session_id, sha256(next)]);
      return { pair: await this.pair(tenantId, t.user_id, t.session_id, t.device_id, next) };
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.pair!;
  }

  logout(a: RequestActor) { return this.revokeSession(a, a.sessionId, 'auth.logout'); }

  listSessions(a: RequestActor, userId = a.userId) {
    return this.db.tenantTx(a.tenantId, async (tx) => (await tx.query(
      `SELECT id, platform, label, ip, user_agent AS "userAgent", last_seen_at AS "lastSeenAt", created_at AS "createdAt",
              revoked_at AS "revokedAt", wipe_requested_at AS "wipeRequestedAt", id = $2 AS current
       FROM device_session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [userId, a.sessionId])).rows);
  }

  /** Users may revoke their own sessions; revoking others' requires users:edit (checked by caller). */
  async revokeSession(a: RequestActor, sessionId: string, action = 'auth.session_revoked', wipe = false) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const r = await tx.query(
        `UPDATE device_session SET revoked_at = COALESCE(revoked_at, now()) ${wipe ? ', wipe_requested_at = now()' : ''} WHERE id = $1 RETURNING user_id`, [sessionId]);
      if (!r.rowCount) throw new NotFoundException();
      // Stop pushes to that device too.
      await tx.query(`UPDATE push_subscription SET disabled_at = now(), last_error = 'session revoked' WHERE session_id = $1 AND disabled_at IS NULL`, [sessionId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: wipe ? 'auth.remote_wipe' : action, entity: 'device_session', entityId: sessionId, diff: { userId: r.rows[0].user_id } });
    });
    // Live sockets of that session are told immediately (and close); offline devices learn on next contact.
    this.realtime.publish({ type: 'session_revoked', tenantId: a.tenantId, sessionId, wipe });
  }

  async sessionOwner(a: RequestActor, sessionId: string): Promise<{ userId: string; branchId: string | null; roles: Role[] } | null> {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const r = (await tx.query('SELECT s.user_id, u.branch_id FROM device_session s JOIN app_user u ON u.id = s.user_id WHERE s.id = $1', [sessionId])).rows[0];
      return r ? { userId: r.user_id, branchId: r.branch_id, roles: await loadUserRoles(tx, r.user_id) } : null;
    });
  }

  async totpSetup(a: RequestActor) {
    const secret = randomBytes(20);
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const u = (await tx.query('SELECT email, totp_enabled FROM app_user WHERE id = $1', [a.userId])).rows[0];
      if (u.totp_enabled) throw new HttpException('Two-factor is already enabled', HttpStatus.CONFLICT);
      await tx.query('UPDATE app_user SET totp_secret_enc = $2 WHERE id = $1', [a.userId, encryptField(secret, `totp:${a.userId}`)]);
      const b32 = base32Encode(secret);
      return { secret: b32, otpauthUrl: `otpauth://totp/Worko:${encodeURIComponent(u.email)}?secret=${b32}&issuer=Worko` };
    });
  }

  async totpEnable(a: RequestActor, code: string) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const u = (await tx.query('SELECT totp_secret_enc FROM app_user WHERE id = $1', [a.userId])).rows[0];
      const step = u?.totp_secret_enc ? verifyTotp(decryptField(u.totp_secret_enc, `totp:${a.userId}`), code) : null;
      if (step === null) throw new UnauthorizedException('Invalid code');
      await tx.query('UPDATE app_user SET totp_enabled = true, totp_last_step = $2 WHERE id = $1', [a.userId, step]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'auth.mfa_enabled', entity: 'app_user', entityId: a.userId });
    });
  }
}
