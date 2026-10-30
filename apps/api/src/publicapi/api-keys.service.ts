import { BadRequestException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import {
  API_KEY_LIMITS, effectiveScope, keyActor, keyIpAllowed, parseApiKey, scopesNotHeld, WindowLimiter, type Action, type ApiKeyCreate, type Module,
} from '@worko/domain';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { loadTeamIds, loadUserRoles } from '../auth/roles.repo.js';
import { DbService, type Tx } from '../db/db.service.js';
import type { ApiKeyPrincipal } from './decorators.js';

const hash = (secret: string) => createHash('sha256').update(secret).digest();
const PREFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function newPrefix() { const b = randomBytes(10); return [...b].map((x) => PREFIX_ALPHABET[x % 36]).join(''); }
function newSecret() { return randomBytes(32).toString('base64url'); }

type KeyRow = {
  id: string; name: string; prefix: string; secret_hash: Buffer; scopes: string[]; client_group_ids: string[] | null; ip_allowlist: string[]; rate_per_min: number;
  expires_at: Date | null; created_by: string; created_at: Date; rotated_at: Date | null; revoked_at: Date | null; last_used_at: Date | null; last_used_ip: string | null;
};
const present = (k: KeyRow, creator?: { name: string; status: string }) => ({
  id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes, clientGroupIds: k.client_group_ids, ipAllowlist: k.ip_allowlist, ratePerMin: k.rate_per_min,
  expiresAt: k.expires_at, createdBy: k.created_by, createdByName: creator?.name ?? null, createdAt: k.created_at, rotatedAt: k.rotated_at, revokedAt: k.revoked_at,
  lastUsedAt: k.last_used_at, lastUsedIp: k.last_used_ip,
  status: k.revoked_at ? 'revoked' : k.expires_at && k.expires_at <= new Date() ? 'expired' : creator && creator.status !== 'active' ? 'creator_inactive' : 'active',
});

/**
 * Firm API keys (M18): created by a staff user, shown once, stored as SHA-256 only. A key is a service principal whose
 * rights = its scopes ∩ the creator's CURRENT rights, re-evaluated on every request (D193).
 */
@Injectable()
export class ApiKeysService {
  private log = new Logger('ApiKeys');
  readonly limiter = new WindowLimiter(60_000);
  constructor(private db: DbService, private audit: AuditService) {}

  // ---------- Management (staff) ----------
  async list(a: RequestActor) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const rows = (await tx.query(`SELECT k.*, u.name AS creator_name, u.status AS creator_status FROM api_key k JOIN app_user u ON u.id = k.created_by
        WHERE k.deleted_at IS NULL ORDER BY k.created_at DESC`)).rows as Array<KeyRow & { creator_name: string; creator_status: string }>;
      return { items: rows.map((r) => present(r, { name: r.creator_name, status: r.creator_status })) };
    });
  }

  async create(a: RequestActor, b: ApiKeyCreate, ip: string | null) {
    const missing = scopesNotHeld(a.roles, b.scopes);
    if (missing.length) throw new BadRequestException({ code: 'scope_not_held', message: 'You can only grant rights you hold', scopes: missing });
    if (b.expiresAt && new Date(b.expiresAt) <= new Date()) throw new BadRequestException({ code: 'expired', message: 'Expiry must be in the future' });
    const id = randomUUID(), prefix = newPrefix(), secret = newSecret();
    await this.db.systemTx((tx) => tx.query('INSERT INTO api_key_lookup (prefix, tenant_id) VALUES ($1,$2)', [prefix, a.tenantId]));
    const row = await this.db.tenantTx(a.tenantId, async (tx) => {
      const n = Number((await tx.query('SELECT count(*) FROM api_key WHERE revoked_at IS NULL AND deleted_at IS NULL')).rows[0].count);
      if (n >= API_KEY_LIMITS.maxKeys) throw new BadRequestException({ code: 'too_many_keys', message: `At most ${API_KEY_LIMITS.maxKeys} active keys` });
      const r = (await tx.query(`INSERT INTO api_key (id, tenant_id, name, prefix, secret_hash, scopes, client_group_ids, ip_allowlist, rate_per_min, expires_at, created_by, updated_by, device_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12) RETURNING *`,
      [id, a.tenantId, b.name, prefix, hash(secret), [...new Set(b.scopes)], b.clientGroupIds?.length ? b.clientGroupIds : null, b.ipAllowlist, b.ratePerMin, b.expiresAt ?? null, a.userId, a.deviceId])).rows[0] as KeyRow;
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'api_key.create', entity: 'api_key', entityId: id,
        diff: { name: b.name, prefix, scopes: b.scopes, clientGroupIds: b.clientGroupIds ?? null, ipAllowlist: b.ipAllowlist, expiresAt: b.expiresAt ?? null }, ip });
      return r;
    });
    return { key: present(row), secret: `wk_${prefix}_${secret}` };
  }

  /** New secret (and prefix) immediately; the old secret stops working at once. */
  async rotate(a: RequestActor, id: string, ip: string | null) {
    const prefix = newPrefix(), secret = newSecret();
    await this.db.systemTx((tx) => tx.query('INSERT INTO api_key_lookup (prefix, tenant_id) VALUES ($1,$2)', [prefix, a.tenantId]));
    const row = await this.db.tenantTx(a.tenantId, async (tx) => {
      const old = await this.mine(tx, id);
      if (old.revoked_at) throw new BadRequestException({ code: 'revoked', message: 'Key is revoked' });
      const r = (await tx.query(`UPDATE api_key SET prefix = $2, secret_hash = $3, rotated_at = now(), updated_by = $4, device_id = $5 WHERE id = $1 RETURNING *`,
        [id, prefix, hash(secret), a.userId, a.deviceId])).rows[0] as KeyRow;
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'api_key.rotate', entity: 'api_key', entityId: id, diff: { from: old.prefix, to: prefix }, ip });
      return { r, oldPrefix: old.prefix };
    });
    await this.db.systemTx((tx) => tx.query('DELETE FROM api_key_lookup WHERE prefix = $1', [row.oldPrefix]));
    return { key: present(row.r), secret: `wk_${prefix}_${secret}` };
  }

  async revoke(a: RequestActor, id: string, ip: string | null) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const k = await this.mine(tx, id);
      if (k.revoked_at) return;
      await tx.query('UPDATE api_key SET revoked_at = now(), revoked_by = $2, updated_by = $2, device_id = $3 WHERE id = $1', [id, a.userId, a.deviceId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'api_key.revoke', entity: 'api_key', entityId: id, diff: { prefix: k.prefix }, ip });
    });
  }

  private async mine(tx: Tx, id: string): Promise<KeyRow> {
    const k = (await tx.query('SELECT * FROM api_key WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0] as KeyRow | undefined;
    if (!k) throw new NotFoundException();
    return k;
  }

  // ---------- Authentication (guard) ----------
  /**
   * Authenticates `wk_…` bearer tokens. Refusals: 401 unknown/revoked/expired/creator inactive; 403 IP not allowed,
   * route not public (default deny) or missing scope; 429 over the key's rate. Every authenticated call is audited.
   */
  async authenticate(req: ApiReq, token: string, route: { publicApi: boolean; perm?: { module: Module; action: Action } }): Promise<RequestActor> {
    const parsed = parseApiKey(token);
    if (!parsed) throw new UnauthorizedException({ code: 'INVALID_API_KEY', message: 'Invalid API key' });
    const tenantId = (await this.db.systemTx((tx) => tx.query('SELECT tenant_id FROM api_key_lookup WHERE prefix = $1', [parsed.prefix]))).rows[0]?.tenant_id as string | undefined;
    if (!tenantId) throw new UnauthorizedException({ code: 'INVALID_API_KEY', message: 'Invalid API key' });
    const ip = req.ip ?? null;
    const out = await this.db.tenantTx(tenantId, async (tx) => {
      const k = (await tx.query(`SELECT k.*, u.status AS creator_status, u.branch_id AS creator_branch FROM api_key k JOIN app_user u ON u.id = k.created_by
        WHERE k.prefix = $1 AND k.deleted_at IS NULL`, [parsed.prefix])).rows[0] as (KeyRow & { creator_status: string; creator_branch: string | null }) | undefined;
      const h = hash(parsed.secret);
      if (!k || !timingSafeEqual(h, k.secret_hash)) return { err: 'INVALID_API_KEY' as const };
      if (k.revoked_at) return { err: 'KEY_REVOKED' as const };
      if (k.expires_at && k.expires_at <= new Date()) return { err: 'KEY_EXPIRED' as const };
      if (k.creator_status !== 'active') return { err: 'KEY_DISABLED' as const }; // creator deactivated → key stops (D193)
      if (!keyIpAllowed(ip, k.ip_allowlist)) return { err: 'IP_NOT_ALLOWED' as const, k };
      await tx.query(`UPDATE api_key SET last_used_at = now(), last_used_ip = $2 WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute' OR last_used_ip IS DISTINCT FROM $2::inet)`, [k.id, ip]);
      const creator = { userId: k.created_by, teamIds: await loadTeamIds(tx, k.created_by), branchId: k.creator_branch, roles: await loadUserRoles(tx, k.created_by) };
      return { k, actor: keyActor(creator, k.scopes, k.client_group_ids) };
    });
    if (!('actor' in out) || !out.actor) {
      const msg: Record<string, string> = { INVALID_API_KEY: 'Invalid API key', KEY_REVOKED: 'API key revoked', KEY_EXPIRED: 'API key expired', KEY_DISABLED: 'API key disabled: its creator is no longer active', IP_NOT_ALLOWED: 'Address not in this key\'s allow-list' };
      if (out.err === 'IP_NOT_ALLOWED') { this.auditCall(req, tenantId, out.k!, 403); throw new ForbiddenException({ code: out.err, message: msg[out.err] }); }
      throw new UnauthorizedException({ code: out.err, message: msg[out.err] });
    }
    const k = out.k;
    const principal: ApiKeyPrincipal = { id: k.id, prefix: k.prefix, tenantId, createdBy: k.created_by };
    req.apiKey = principal;
    this.auditOnFinish(req, tenantId, k);
    const rl = this.limiter.take(k.id, k.rate_per_min, Date.now());
    if (!rl.ok) { req.res?.setHeader('Retry-After', String(rl.retryAfterSec)); throw new HttpException({ code: 'RATE_LIMITED', message: 'Rate limit exceeded for this API key' }, 429); }
    if (!route.publicApi) throw new ForbiddenException({ code: 'API_KEY_ROUTE_DENIED', message: 'This route is not part of the public API' });
    const actor: RequestActor = { ...out.actor, tenantId, sessionId: k.id, deviceId: `apikey:${k.id}`, platform: 'api', elevatedUntil: null };
    if (route.perm) {
      const g = effectiveScope(actor, route.perm.module, route.perm.action);
      if (!g || g.scope === 'none') throw new ForbiddenException({ code: 'SCOPE_MISSING', message: `Missing scope ${route.perm.module}:${route.perm.action}` });
    }
    return actor;
  }

  /** One audit entry per call (key id, method, route pattern, status) — never query strings or bodies. */
  private auditOnFinish(req: ApiReq, tenantId: string, k: KeyRow) {
    req.res?.once('finish', () => this.auditCall(req, tenantId, k, req.res?.statusCode ?? 0));
  }
  private auditCall(req: ApiReq, tenantId: string, k: KeyRow, status: number) {
    const path = (req.route?.path as string | undefined) ?? '(unmatched)';
    void this.db.tenantTx(tenantId, (tx) => this.audit.record(tx, tenantId, { actorId: k.created_by, deviceId: `apikey:${k.id}`, action: 'api.call', entity: 'api_key', entityId: k.id,
      diff: { method: req.method, route: path, status }, ip: req.ip ?? null })).catch((e) => this.log.warn(`audit of API call failed: ${(e as Error).message}`));
  }
}

export type ApiReq = {
  ip?: string; method: string; route?: { path?: string }; headers: Record<string, string | string[] | undefined>; query: Record<string, unknown>;
  res?: { setHeader(k: string, v: string): void; once(ev: 'finish', f: () => void): void; statusCode: number };
  apiKey?: ApiKeyPrincipal; actor?: RequestActor;
};
