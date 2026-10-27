import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { can, clientCtx, isPortalUrl, type Portal } from '@worko/domain';
import { AuditService } from '../audit/audit.service.js';
import type { RequestActor } from '../auth/context.js';
import { numericCode, sha256 } from '../auth/crypto.js';
import { requireElevated } from '../auth/elevation.js';
import { clientScopeSql, Params } from '../clients/scope.js';
import { ClientsService } from '../clients/clients.service.js';
import { KeyService } from '../crypto/key.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { uuidv7 } from '../db/ids.js';
import { visibilityOf } from '../sync/registry.js';

export type SecretIn = { portal: Portal; label: string; loginUrl?: string | null; username: string; password: string; extra?: Record<string, string> | null };

/** "ABCDE1234F" → "AB••••••4F": enough to pick the right login, useless to an onlooker. */
export const hint = (u: string) => (u.length <= 4 ? '••••' : `${u.slice(0, 2)}${'•'.repeat(Math.min(6, u.length - 4))}${u.slice(-2)}`);

/**
 * Client portal credentials. Plaintext exists only in memory during encrypt/reveal; never in logs, audit diffs,
 * sync, backups or messages. Reveal = permission + client visibility + fresh step-up + audit entry.
 */
@Injectable()
export class VaultService {
  constructor(private db: DbService, private keys: KeyService, private audit: AuditService, private clients: ClientsService) {}

  private aad = (id: string, f: string) => `vault:${id}:${f}`;

  private async loadSecret(tx: Tx, a: RequestActor, id: string, action: 'view' | 'edit' | 'delete' | 'reveal') {
    const s = (await tx.query(`SELECT v.*, c.branch_id, c.partner_id, c.manager_id, c.team_id, c.staff_ids, c.group_ids, c.sensitive, c.allowed_user_ids
      FROM vault_secret v JOIN client c ON c.id = v.client_id AND c.deleted_at IS NULL WHERE v.id = $1 AND v.deleted_at IS NULL`, [id])).rows[0];
    const ctx = s && clientCtx(visibilityOf(s));
    if (!s || !can(a, 'clients', 'view', ctx) || !can(a, 'vault', 'view', ctx)) throw new NotFoundException();
    if (!can(a, 'vault', action, ctx)) throw new NotFoundException();
    return s;
  }

  /** Metadata of every secret on clients the actor can see (optionally by portal / search). */
  list(a: RequestActor, q: { clientId?: string; portal?: Portal; q?: string }) {
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const p = new Params();
      const where = [`v.deleted_at IS NULL`, `c.deleted_at IS NULL`, clientScopeSql(a, 'clients', 'view', p), clientScopeSql(a, 'vault', 'view', p)];
      if (q.clientId) where.push(`v.client_id = ${p.add(q.clientId)}`);
      if (q.portal) where.push(`v.portal = ${p.add(q.portal)}`);
      if (q.q) where.push(`(lower(c.name) LIKE '%' || lower(${p.add(q.q)}) || '%' OR lower(v.label) LIKE '%' || lower(${p.add(q.q)}) || '%')`);
      return (await tx.query(
        `SELECT v.id, v.client_id AS "clientId", c.name AS "clientName", v.portal, v.label, v.login_url AS "loginUrl", v.username_hint AS "usernameHint",
                v.rotated_at AS "rotatedAt", v.last_revealed_at AS "lastRevealedAt", v.created_at AS "createdAt"
         FROM vault_secret v JOIN client c ON c.id = v.client_id WHERE ${where.join(' AND ')} ORDER BY c.name, v.portal LIMIT 500`, p.values)).rows;
    });
  }

  async create(a: RequestActor, clientId: string, s: SecretIn) {
    const id = uuidv7();
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const c = await this.clients.loadFor(tx, a, clientId);
      if (!can(a, 'vault', 'create', clientCtx(visibilityOf(c)))) throw new NotFoundException();
      await tx.query(`INSERT INTO vault_secret (id, tenant_id, client_id, portal, label, login_url, username_hint, username_enc, secret_enc, extra_enc, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
        [id, a.tenantId, clientId, s.portal, s.label, s.loginUrl ?? null, hint(s.username),
          await this.keys.encrypt(tx, a.tenantId, s.username, this.aad(id, 'username')), await this.keys.encrypt(tx, a.tenantId, s.password, this.aad(id, 'secret')),
          s.extra ? await this.keys.encrypt(tx, a.tenantId, JSON.stringify(s.extra), this.aad(id, 'extra')) : null, a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'vault.created', entity: 'vault_secret', entityId: id, diff: { clientId, portal: s.portal, label: s.label } });
    });
    return { id };
  }

  async update(a: RequestActor, id: string, s: Partial<SecretIn>) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      await this.loadSecret(tx, a, id, 'edit');
      const sets: string[] = []; const vals: unknown[] = [id];
      const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
      if (s.label !== undefined) set('label', s.label);
      if (s.loginUrl !== undefined) set('login_url', s.loginUrl);
      if (s.username !== undefined) { set('username_enc', await this.keys.encrypt(tx, a.tenantId, s.username, this.aad(id, 'username'))); set('username_hint', hint(s.username)); }
      if (s.password !== undefined) { set('secret_enc', await this.keys.encrypt(tx, a.tenantId, s.password, this.aad(id, 'secret'))); sets.push('rotated_at = now()'); }
      if (s.extra !== undefined) set('extra_enc', s.extra ? await this.keys.encrypt(tx, a.tenantId, JSON.stringify(s.extra), this.aad(id, 'extra')) : null);
      if (!sets.length) return;
      set('updated_by', a.userId);
      await tx.query(`UPDATE vault_secret SET ${sets.join(', ')} WHERE id = $1`, vals);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'vault.updated', entity: 'vault_secret', entityId: id,
        diff: { changed: Object.keys(s).filter((k) => (s as Record<string, unknown>)[k] !== undefined) } });
    });
  }

  async remove(a: RequestActor, id: string) {
    await this.db.tenantTx(a.tenantId, async (tx) => {
      await this.loadSecret(tx, a, id, 'delete');
      await tx.query('UPDATE vault_secret SET deleted_at = now(), updated_by = $2 WHERE id = $1', [id, a.userId]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'vault.deleted', entity: 'vault_secret', entityId: id });
    });
  }

  /** Decrypt for the user. Autofill additionally requires the page URL to be the portal's official host. */
  async reveal(a: RequestActor, id: string, purpose: 'view' | 'copy' | 'autofill', pageUrl: string | undefined, ip: string | null) {
    requireElevated(a);
    if (a.platform === 'extension' && purpose !== 'autofill') throw new BadRequestException('The extension may only autofill');
    return this.db.tenantTx(a.tenantId, async (tx) => {
      const s = await this.loadSecret(tx, a, id, 'reveal');
      if (purpose === 'autofill' && (!pageUrl || !isPortalUrl(s.portal, pageUrl))) throw new BadRequestException('Autofill only on the official portal');
      await tx.query('UPDATE vault_secret SET last_revealed_at = now() WHERE id = $1', [id]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'vault.revealed', entity: 'vault_secret', entityId: id, ip,
        diff: { purpose, portal: s.portal, clientId: s.client_id, host: pageUrl ? new URL(pageUrl).hostname : null } });
      return {
        username: await this.keys.decrypt(tx, a.tenantId, s.username_enc, this.aad(id, 'username')),
        password: await this.keys.decrypt(tx, a.tenantId, s.secret_enc, this.aad(id, 'secret')),
        extra: s.extra_enc ? JSON.parse(await this.keys.decrypt(tx, a.tenantId, s.extra_enc, this.aad(id, 'extra'))) : null,
      };
    });
  }

  // ---- Browser extension pairing ----
  /** One-time code shown in the web app; the extension trades it (with the firm id) for its own session. */
  async pairCode(a: RequestActor) {
    const code = `${numericCode(4)}-${numericCode(4)}`;
    await this.db.tenantTx(a.tenantId, async (tx) => {
      await tx.query(`UPDATE extension_pair_code SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL`, [a.userId]);
      await tx.query(`INSERT INTO extension_pair_code (id, tenant_id, user_id, code_hash, expires_at) VALUES ($1,$2,$3,$4, now() + interval '5 minutes')`,
        [uuidv7(), a.tenantId, a.userId, sha256(`${a.userId}:${code}`)]);
      await this.audit.record(tx, a.tenantId, { actorId: a.userId, deviceId: a.deviceId, action: 'extension.pair_code_issued', entity: 'app_user', entityId: a.userId });
    });
    return { code, expiresInSeconds: 300 };
  }

}
