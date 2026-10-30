import { HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { PlatformActor } from '../auth/context.js';
import { base32Encode, hashPassword, verifyPassword, verifyTotp } from '../auth/crypto.js';
import { decryptField, encryptField } from '../auth/field-crypto.js';
import { PLATFORM_TTL_S, TokenService } from '../auth/token.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { PlatformAuditService } from './platform-audit.service.js';

const MAX_FAILED = 5;
const LOCK_MINUTES = 30;
const bad = () => new UnauthorizedException('Invalid credentials');
const totpAad = (id: string) => `platform_admin:${id}:totp`;

/**
 * Creates a platform operator. There is NO HTTP route for this (D178): run from the CLI (`pnpm --filter @worko/api platform:admin`)
 * or the dev seed. MFA is mandatory — the TOTP secret is generated here and printed once.
 */
export async function createPlatformAdmin(tx: Tx, i: { email: string; name: string; password: string; secret?: Buffer }) {
  const id = uuidv7();
  const secret = i.secret ?? randomBytes(20);
  await tx.query(`INSERT INTO platform_admin (id, email, name, password_hash, totp_secret_enc) VALUES ($1,$2,$3,$4,$5)`,
    [id, i.email.toLowerCase(), i.name, await hashPassword(i.password), encryptField(secret, totpAad(id))]);
  const b32 = base32Encode(secret);
  return { id, totpSecret: b32, otpauthUrl: `otpauth://totp/Worko%20Platform:${encodeURIComponent(i.email)}?secret=${b32}&issuer=Worko%20Platform` };
}

@Injectable()
export class PlatformAuthService {
  constructor(private db: DbService, private tokens: TokenService, private paudit: PlatformAuditService) {}

  /** Password AND authenticator code, always (no MFA-less path). Wrong secrets count toward a lockout. */
  async login(email: string, password: string, totp: string | undefined, meta: { ip: string | null; userAgent?: string }) {
    const out = await this.db.systemTx(async (tx) => {
      const u = (await tx.query(`SELECT * FROM platform_admin WHERE email = lower($1)`, [email])).rows[0];
      if (!u) { await hashPassword(password); return { error: bad() }; }
      if (u.locked_until && u.locked_until > new Date()) return { error: new HttpException('Account temporarily locked', HttpStatus.TOO_MANY_REQUESTS) };
      const fail = async (action: string) => {
        const n = u.failed_logins + 1;
        await tx.query(`UPDATE platform_admin SET failed_logins = $2::int, locked_until = CASE WHEN $2::int >= $3::int THEN now() + make_interval(mins => $4) END WHERE id = $1`, [u.id, n, MAX_FAILED, LOCK_MINUTES]);
        await this.paudit.recordTx(tx, { adminId: u.id, action, entity: 'platform_admin', entityId: u.id, ip: meta.ip });
        return { error: bad() };
      };
      if (u.status !== 'active' || !(await verifyPassword(password, u.password_hash))) return fail('platform.login_failed');
      if (!totp) return { error: new UnauthorizedException({ code: 'MFA_REQUIRED', message: 'Enter the code from your authenticator app' }) };
      const step = verifyTotp(decryptField(u.totp_secret_enc, totpAad(u.id)), totp);
      if (step === null || (u.totp_last_step !== null && step <= Number(u.totp_last_step))) return fail('platform.mfa_failed');
      await tx.query('UPDATE platform_admin SET failed_logins = 0, locked_until = NULL, totp_last_step = $2 WHERE id = $1', [u.id, step]);
      const sid = uuidv7();
      await tx.query(`INSERT INTO platform_session (id, admin_id, expires_at, ip, user_agent) VALUES ($1,$2, now() + make_interval(secs => $3), $4, $5)`,
        [sid, u.id, PLATFORM_TTL_S, meta.ip, meta.userAgent ?? null]);
      await this.paudit.recordTx(tx, { adminId: u.id, action: 'platform.login', entity: 'platform_session', entityId: sid, ip: meta.ip });
      return { ok: { adminId: u.id as string, sid, name: u.name as string } };
    });
    if ('error' in out) throw out.error;
    const accessToken = await this.tokens.signPlatform({ sub: out.ok!.adminId, sid: out.ok!.sid });
    return { accessToken, expiresIn: PLATFORM_TTL_S, adminId: out.ok!.adminId, name: out.ok!.name };
  }

  /** Guard: platform token → live session of an active admin. */
  async authenticate(token: string, ip: string | null): Promise<PlatformActor> {
    let c;
    try { c = await this.tokens.verifyPlatform(token); } catch { throw new UnauthorizedException(); }
    const r = (await this.db.systemTx((tx) => tx.query(
      `SELECT a.email, a.name FROM platform_session s JOIN platform_admin a ON a.id = s.admin_id
       WHERE s.id = $1 AND s.admin_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now() AND a.status = 'active'`, [c.sid, c.sub]))).rows[0];
    if (!r) throw new UnauthorizedException();
    return { adminId: c.sub, sessionId: c.sid, email: r.email, name: r.name, ip };
  }

  async logout(p: PlatformActor) {
    await this.db.systemTx(async (tx) => {
      await tx.query('UPDATE platform_session SET revoked_at = now() WHERE id = $1', [p.sessionId]);
      await this.paudit.recordTx(tx, { adminId: p.adminId, action: 'platform.logout', entity: 'platform_session', entityId: p.sessionId, ip: p.ip });
    });
  }

  /** Is this platform session still live (impersonation tokens die with the session that started them)? */
  async sessionLive(sid: string, adminId: string): Promise<boolean> {
    return !!(await this.db.systemTx((tx) => tx.query(`SELECT 1 FROM platform_session s JOIN platform_admin a ON a.id = s.admin_id
      WHERE s.id = $1 AND s.admin_id = $2 AND s.revoked_at IS NULL AND a.status = 'active'`, [sid, adminId]))).rowCount;
  }
}
